"""Agent side of a remote session (desktop / files / terminal).

Opened when the control channel receives SESSION_START. Connects to the hub's
/ws/agent-session, authenticates with the device secret, and serves the
session until either side ends it. Policy from the server (fullShell,
fileRoot) is enforced here too — the agent never trusts the console alone.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time

import websockets

from .protocol import T, BIN_FILE, BIN_SCREEN, message, parse, ws_url

log = logging.getLogger("nexlink.session")
CHUNK = 256 * 1024


class Session:
    def __init__(self, agent, start: dict):
        self.agent = agent
        self.backend = agent.backend
        self.id = start["sessionId"]
        self.kind = start["kind"]
        self.operator = start.get("operator", {})
        self.policy = start.get("policy", {})
        self.ws = None
        self.stopped = asyncio.Event()
        self.banner = None
        self.uploads: dict[str, dict] = {}
        self.term_state: dict = {}
        self.quality = 60
        self.max_width = 1280 if not self.backend.simulated else 1024

    def send_json(self, type_, payload):
        if self.ws is not None:
            return self.ws.send(message(type_, payload, device_id=self.agent.device_id, session_id=self.id))
        return asyncio.sleep(0)

    async def run(self):
        url = ws_url(self.agent.server, "/ws/agent-session")
        try:
            async with websockets.connect(url, max_size=8 * 1024 * 1024, ping_interval=20, open_timeout=10) as ws:
                self.ws = ws
                await ws.send(message(T.AUTH_REQUEST, {"deviceId": self.agent.device_id, "deviceSecret": self.agent.device_secret, "sessionId": self.id}))
                ready = parse(await asyncio.wait_for(ws.recv(), 25))
                if not ready or ready["type"] != T.SESSION_READY:
                    log.warning("session %s not started: %s", self.id, ready and ready.get("payload"))
                    return
                log.info("session %s (%s) started by %s", self.id, self.kind, self.operator.get("username"))
                self._show_banner()
                tasks = [asyncio.create_task(self._receiver())]
                if self.kind == "desktop":
                    tasks.append(asyncio.create_task(self._stream()))
                done, pending = await asyncio.wait(tasks + [asyncio.create_task(self.stopped.wait())], return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
        except (OSError, asyncio.TimeoutError, websockets.WebSocketException) as e:
            log.warning("session %s ended: %s", self.id, e)
        finally:
            self._close()

    def stop(self, reason="Ended"):
        self.stopped.set()

    def _show_banner(self):
        if self.backend.simulated:
            return
        from .banner import SessionBanner
        who = self.operator.get("displayName") or self.operator.get("username") or "operator"
        what = {"desktop": "viewing and controlling this screen", "files": "accessing files", "terminal": "running commands"}[self.kind]
        text = f"NexLink remote session — {who} ({self.operator.get('role', '')}) is {what}"
        loop = asyncio.get_running_loop()

        def disconnect():
            async def _end():
                await self.send_json(T.SESSION_END, {"sessionId": self.id, "reason": "Local user pressed Disconnect"})
                self.stop()
            asyncio.run_coroutine_threadsafe(_end(), loop)

        self.banner = SessionBanner(text, disconnect, danger=bool(self.policy.get("fullShell"))).start()

    def _close(self):
        if self.banner:
            self.banner.close()
        if self.kind == "desktop":
            self.backend.close_screen()
        for up in self.uploads.values():
            try:
                up["fh"].close()
                up["tmp"].unlink(missing_ok=True)
            except Exception:
                pass
        self.agent.sessions.pop(self.id, None)

    # ------------------------------------------------------------ desktop
    async def _stream(self):
        width, height = await asyncio.to_thread(self.backend.open_screen)
        await self.send_json(T.SESSION_STATS, {"screen": {"width": width, "height": height}})
        target_fps = 5 if self.backend.simulated else 8
        while not self.stopped.is_set():
            t0 = time.perf_counter()
            frame = await asyncio.to_thread(self.backend.grab, self.max_width, self.quality)
            await self.ws.send(bytes([BIN_SCREEN]) + frame)
            # Adaptive quality: back off when the socket's send buffer grows.
            buffered = self.ws.transport.get_write_buffer_size() if self.ws.transport else 0
            if buffered > 1_500_000:
                self.quality = max(25, self.quality - 10)
                self.max_width = max(800, self.max_width - 160)
            elif buffered < 200_000 and self.quality < 70:
                self.quality += 5
            elapsed = time.perf_counter() - t0
            await asyncio.sleep(max(0.0, 1 / target_fps - elapsed) + (0.2 if buffered > 3_000_000 else 0))

    # ------------------------------------------------------------ receive loop
    async def _receiver(self):
        async for raw in self.ws:
            if isinstance(raw, bytes):
                await self._on_binary(raw)
                continue
            msg = parse(raw)
            if not msg:
                continue
            t, p = msg["type"], msg["payload"]
            if t == T.SESSION_END:
                self.stop(p.get("reason", "Ended"))
                return
            if t == T.REMOTE_INPUT and self.kind == "desktop" and self.policy.get("allowInput", True):
                if p.get("type") == "quality":
                    self.quality = max(20, min(90, int(p.get("value", 60))))
                    continue
                try:
                    await asyncio.to_thread(self.backend.input, p)
                except Exception as e:  # input must never kill the session
                    log.debug("input failed: %s", e)
            elif t == T.FILE_REQUEST and self.kind == "files":
                asyncio.create_task(self._file_request(p))
            elif t == T.COMMAND_REQUEST and self.kind == "terminal":
                asyncio.create_task(self._command(p))

    # ------------------------------------------------------------ terminal
    async def _command(self, p):
        res = await asyncio.to_thread(self.backend.terminal_exec, str(p.get("command", "")), bool(self.policy.get("fullShell")), self.term_state)
        await self.send_json(T.COMMAND_RESPONSE, {"commandId": p.get("commandId"), **res})

    # ------------------------------------------------------------ files
    async def _file_request(self, p):
        op, rid = p.get("op"), p.get("requestId")
        root = self.policy.get("fileRoot", "shared")
        reply = lambda ok, **kw: self.send_json(T.FILE_RESPONSE, {"requestId": rid, "op": op, "ok": ok, **kw})  # noqa: E731
        try:
            if op == "list":
                data = await asyncio.to_thread(self.backend.list_dir, root, p.get("path", ""))
                await reply(True, data=data)
            elif op == "download":
                await self._download(p, root, reply)
            elif op == "upload_start":
                await self._upload_start(p, root, reply)
            elif op == "upload_end":
                await self._upload_end(p, reply)
            elif op == "delete":
                await asyncio.to_thread(self.backend.delete, root, p.get("path", ""))
                await reply(True)
            elif op == "mkdir":
                await asyncio.to_thread(self.backend.mkdir, root, p.get("path", ""), p.get("name", ""))
                await reply(True)
            elif op == "rename":
                await asyncio.to_thread(self.backend.rename, root, p.get("path", ""), p.get("name", ""))
                await reply(True)
            else:
                await reply(False, error=f"Unknown operation {op}")
        except PermissionError as e:
            await reply(False, error=str(e) or "Permission denied.")
        except FileNotFoundError:
            await reply(False, error="Not found.")
        except Exception as e:
            await reply(False, error=str(e)[:200])

    async def _download(self, p, root, reply):
        tid = str(p.get("transferId", ""))[:16].ljust(16, "0").encode()
        path = p.get("path", "")
        h = hashlib.sha256()
        if self.backend.simulated:
            data = self.backend.sim_file_bytes(path)
            name, size = path.split("/")[-1], len(data)
            await self.send_json(T.FILE_RESPONSE, {"requestId": p.get("requestId"), "op": "download_start", "ok": True, "name": name, "size": size, "transferId": p.get("transferId")})
            for i in range(0, size, CHUNK):
                chunk = data[i:i + CHUNK]
                h.update(chunk)
                await self.ws.send(bytes([BIN_FILE]) + tid + chunk)
        else:
            fpath, size, fh = await asyncio.to_thread(self.backend.open_read, root, path)
            await self.send_json(T.FILE_RESPONSE, {"requestId": p.get("requestId"), "op": "download_start", "ok": True, "name": fpath.name, "size": size, "transferId": p.get("transferId")})
            with fh:
                while True:
                    chunk = await asyncio.to_thread(fh.read, CHUNK)
                    if not chunk:
                        break
                    h.update(chunk)
                    await self.ws.send(bytes([BIN_FILE]) + tid + chunk)
        await reply(True, transferId=p.get("transferId"), size=size, sha256=h.hexdigest())

    async def _upload_start(self, p, root, reply):
        tid = str(p.get("transferId", ""))[:16].ljust(16, "0")
        name = str(p.get("name", ""))
        size = int(p.get("size", 0))
        if size > 2 * 1024 ** 3:
            return await reply(False, error="Files over 2 GB are not supported.")
        if self.backend.simulated:
            self.uploads[tid] = {"sim": True, "buf": bytearray(), "dir": p.get("path", ""), "name": name, "h": hashlib.sha256(), "size": size}
        else:
            final, tmp, fh = await asyncio.to_thread(self.backend.open_write, root, p.get("path", ""), name)
            self.uploads[tid] = {"final": final, "tmp": tmp, "fh": fh, "h": hashlib.sha256(), "size": size, "got": 0}
        await reply(True, transferId=p.get("transferId"))

    async def _on_binary(self, raw: bytes):
        if not raw or raw[0] != BIN_FILE or self.kind != "files":
            return
        tid = raw[1:17].decode(errors="replace")
        up = self.uploads.get(tid)
        if not up:
            return
        chunk = raw[17:]
        up["h"].update(chunk)
        if up.get("sim"):
            up["buf"].extend(chunk)
        else:
            await asyncio.to_thread(up["fh"].write, chunk)
            up["got"] += len(chunk)

    async def _upload_end(self, p, reply):
        tid = str(p.get("transferId", ""))[:16].ljust(16, "0")
        up = self.uploads.pop(tid, None)
        if not up:
            return await reply(False, error="Unknown transfer.")
        digest = up["h"].hexdigest()
        match = digest == p.get("sha256")
        if up.get("sim"):
            if match:
                self.backend.sim_store(up["dir"], up["name"], bytes(up["buf"]))
        else:
            up["fh"].close()
            if match:
                up["tmp"].replace(up["final"])
            else:
                up["tmp"].unlink(missing_ok=True)
        await reply(match, transferId=p.get("transferId"), sha256=digest, verified=match,
                    error=None if match else "Checksum mismatch — the upload was discarded.")
