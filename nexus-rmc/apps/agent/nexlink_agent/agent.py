"""NexLink agent control loop.

    connect /ws/agent ─▶ DEVICE_REGISTER (first run, with enrollment token)
                     └▶ AUTH_REQUEST    (known device, with device secret)
    ◀─ DEVICE_PENDING  (wait for an admin)   ◀─ DEVICE_APPROVED / AUTH_RESPONSE ok
    then: METRIC_UPDATE every 5 s, NETWORK_UPDATE + PROCESS_UPDATE every 15 s,
          ICMP burst to the hub every 30 s, PONG to server PINGs,
          COMMAND_REQUEST (diagnostics, simulator faults), SESSION_START.
Reconnects forever with exponential backoff + jitter.
"""
from __future__ import annotations

import asyncio
import logging
import random
from urllib.parse import urlparse

import websockets

from . import __version__
from .protocol import T, message, parse, ws_url
from .session import Session

log = logging.getLogger("nexlink.agent")


class Rejected(Exception):
    pass


class Agent:
    def __init__(self, server: str, backend, store, *, enrollment_token: str | None = None, label: str = ""):
        self.server = server.rstrip("/")
        self.backend = backend
        self.store = store
        self.enrollment_token = enrollment_token
        self.label = label or getattr(backend, "hostname", "agent")
        self.device_id = store.get("device_id")
        self.device_secret = store.get("device_secret")
        self.virtual_ip = store.get("virtual_ip")
        self.hub = store.get("hub") or {}
        self.tunnel_mode = "simulated" if backend.simulated else "direct"
        self.state = "starting"
        self.ws = None
        self.sessions: dict[str, Session] = {}
        self._live_tasks: list[asyncio.Task] = []
        self._stop = asyncio.Event()
        if backend.simulated and self.virtual_ip:
            backend.virtual_ip = self.virtual_ip

    # ------------------------------------------------------------ helpers
    def _log(self, level, msg, *args):
        log.log(level, f"[{self.label}] " + msg, *args)

    async def send(self, type_, payload):
        if self.ws is not None:
            await self.ws.send(message(type_, payload, device_id=self.device_id))

    def hub_host(self) -> str:
        if self.backend.simulated or self.tunnel_mode == "wireguard":
            return "10.50.0.1"
        return urlparse(self.server).hostname or "127.0.0.1"

    def stop(self):
        self._stop.set()

    # ------------------------------------------------------------ main loop
    async def run_forever(self):
        attempt = 0
        while not self._stop.is_set():
            try:
                await self._connect_once()
                attempt = 0
            except Rejected as e:
                self._log(logging.ERROR, "stopped: %s", e)
                self.state = "rejected"
                return
            except (OSError, asyncio.TimeoutError, websockets.WebSocketException) as e:
                self._log(logging.WARNING, "connection problem: %s", e)
            finally:
                await self._stop_live()
            if self._stop.is_set():
                break
            attempt += 1
            base = min(30, 2 ** min(attempt, 5))
            delay = base / 2 + random.random() * base / 2
            self.state = "reconnecting"
            self._log(logging.INFO, "reconnecting in %.1f s", delay)
            try:
                await asyncio.wait_for(self._stop.wait(), delay)
            except asyncio.TimeoutError:
                pass

    async def _connect_once(self):
        url = ws_url(self.server, "/ws/agent")
        async with websockets.connect(url, max_size=1024 * 1024, ping_interval=20, open_timeout=10) as ws:
            self.ws = ws
            info = await asyncio.to_thread(self.backend.info)
            if self.device_id and self.device_secret:
                await self.send(T.AUTH_REQUEST, {
                    "deviceId": self.device_id, "deviceSecret": self.device_secret, "agentVersion": __version__,
                    "physicalIp": info.get("physicalIp"), "capabilities": info.get("capabilities"),
                    "tunnel": {"mode": self.tunnel_mode},
                })
            elif self.enrollment_token:
                public_key = self.store.get("wg_public_key")
                if not public_key and not self.backend.simulated:
                    from .wireguard import generate_keypair
                    priv, public_key = generate_keypair()
                    self.store.set(wg_private_key=priv, wg_public_key=public_key)
                elif not public_key:
                    from .wireguard import generate_keypair
                    _, public_key = generate_keypair()
                await self.send(T.DEVICE_REGISTER, {**info, "enrollmentToken": self.enrollment_token, "agentVersion": __version__,
                                                   "publicKey": public_key, "simulated": self.backend.simulated})
            else:
                raise Rejected("This agent is not enrolled. Run: python -m nexlink_agent enroll --server URL --token TOKEN")

            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                msg = parse(raw)
                if msg:
                    await self._handle(msg)
        self.ws = None

    async def _handle(self, msg):
        t, p = msg["type"], msg["payload"]
        if t == T.DEVICE_PENDING:
            self.device_id = p.get("deviceId") or self.device_id
            if p.get("deviceSecret"):
                self.device_secret = p["deviceSecret"]
                self.store.set(device_id=self.device_id, device_secret=self.device_secret, server=self.server)
                self.enrollment_token = None  # single use; identity is the secret from now on
            self.state = "pending"
            self._log(logging.INFO, "enrolled as %s — waiting for an administrator to approve this device", self.device_id)
        elif t == T.DEVICE_APPROVED:
            self._log(logging.INFO, "approved! virtual IP %s", p.get("virtualIp"))
            await self._go_live(p)
        elif t == T.AUTH_RESPONSE:
            if not p.get("ok"):
                self.store.set(device_id=None, device_secret=None)
                raise Rejected(p.get("reason") or "Authentication failed")
            await self._go_live(p)
        elif t == T.DEVICE_REJECTED:
            self.store.set(device_id=None, device_secret=None, virtual_ip=None)
            raise Rejected(p.get("reason") or "Rejected by the administrator")
        elif t == T.PING:
            await self.send(T.PONG, {"seq": p.get("seq"), "t0": p.get("t0")})
        elif t == T.COMMAND_REQUEST:
            asyncio.create_task(self._command(p))
        elif t == T.SESSION_START:
            s = Session(self, p)
            self.sessions[s.id] = s
            asyncio.create_task(s.run())
        elif t == T.SESSION_END:
            s = self.sessions.get(p.get("sessionId"))
            if s:
                s.stop(p.get("reason", "Ended"))
        elif t == T.ERROR:
            self._log(logging.WARNING, "server error: %s", p)

    async def _go_live(self, p):
        self.virtual_ip = p.get("virtualIp") or self.virtual_ip
        self.hub = p.get("hub") or self.hub
        self.store.set(virtual_ip=self.virtual_ip, hub=self.hub)
        if self.backend.simulated:
            self.backend.virtual_ip = self.virtual_ip
            self.tunnel_mode = "simulated"
        else:
            from .wireguard import ensure_tunnel
            priv = self.store.get("wg_private_key")
            if priv and self.virtual_ip:
                mode, note = await asyncio.to_thread(ensure_tunnel, priv, self.virtual_ip, self.hub)
                if mode != self.tunnel_mode:
                    self._log(logging.INFO, "tunnel: %s (%s)", mode, note)
                self.tunnel_mode = mode
        self.state = "online"
        await self._start_live(p.get("intervals") or {})

    # ------------------------------------------------------------ live telemetry
    async def _start_live(self, iv):
        await self._stop_live()

        async def every(seconds, fn, jitter=True):
            if jitter:
                await asyncio.sleep(random.random() * min(seconds, 3))
            while True:
                try:
                    await fn()
                except (websockets.WebSocketException, OSError):
                    return
                except Exception as e:  # a failing probe must not kill the agent
                    self._log(logging.DEBUG, "task error: %s", e)
                await asyncio.sleep(seconds)

        async def metrics():
            await self.send(T.METRIC_UPDATE, await asyncio.to_thread(self.backend.metrics))

        async def network():
            await self.send(T.NETWORK_UPDATE, await asyncio.to_thread(self.backend.network))

        async def processes():
            await self.send(T.PROCESS_UPDATE, {"processes": await asyncio.to_thread(self.backend.processes)})

        async def icmp():
            await asyncio.to_thread(self.backend.update_latency, self.hub_host())

        self._live_tasks = [
            asyncio.create_task(every(iv.get("metricsSec", 5), metrics)),
            asyncio.create_task(every(iv.get("networkSec", 15), network)),
            asyncio.create_task(every(iv.get("processSec", 15), processes)),
            asyncio.create_task(every(iv.get("pingBurstSec", 30), icmp, jitter=False)),
        ]

    async def _stop_live(self):
        for t in self._live_tasks:
            t.cancel()
        self._live_tasks = []
        for s in list(self.sessions.values()):
            s.stop("Agent disconnected")

    # ------------------------------------------------------------ commands
    async def _command(self, p):
        cid, kind, args = p.get("commandId"), p.get("kind"), p.get("args") or {}
        try:
            if kind == "diagnostics":
                data = await asyncio.to_thread(self.backend.diagnostics, args, self.hub_host())
                await self.send(T.COMMAND_RESPONSE, {"commandId": cid, "ok": True, "data": data})
            elif kind == "sim.fault" and self.backend.simulated:
                data = self.backend.inject(str(args.get("fault")), int(args.get("seconds", 120)))
                await self.send(T.COMMAND_RESPONSE, {"commandId": cid, "ok": True, "data": data})
            else:
                await self.send(T.COMMAND_RESPONSE, {"commandId": cid, "ok": False, "stderr": f"Unsupported command {kind}"})
        except Exception as e:
            await self.send(T.COMMAND_RESPONSE, {"commandId": cid, "ok": False, "stderr": str(e)[:300]})
