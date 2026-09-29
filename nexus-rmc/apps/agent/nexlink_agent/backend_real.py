"""Real machine backend: telemetry, network tests, screen, input, files, terminal."""
from __future__ import annotations

import hashlib
import io
import os
import platform
import re
import shutil
import socket
import string
import subprocess
import sys
import time
from pathlib import Path

import psutil

from .protocol import WELL_KNOWN_PORTS, check_allowlisted

IS_WIN = sys.platform == "win32"
CONSOLE_ENCODING = "oem" if IS_WIN else "utf-8"
NO_WINDOW = 0x08000000 if IS_WIN else 0


def _run(args, timeout=30, shell=False, cwd=None):
    """Run a command, return (exit_code, stdout, stderr). Never raises on timeout."""
    try:
        p = subprocess.run(
            args, capture_output=True, timeout=timeout, shell=shell, cwd=cwd,
            creationflags=NO_WINDOW, stdin=subprocess.DEVNULL,
        )
        dec = lambda b: b.decode(CONSOLE_ENCODING, errors="replace")  # noqa: E731
        return p.returncode, dec(p.stdout), dec(p.stderr)
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode(CONSOLE_ENCODING, errors="replace")
        return -1, out, f"Timed out after {timeout} s"
    except FileNotFoundError as e:
        return -1, "", str(e)


class RealBackend:
    simulated = False

    def __init__(self, server_url: str):
        self.server_url = server_url
        self._last_net = None
        self._last_net_t = None
        self.latency_ms = None
        self.loss_pct = None
        self.shared_root = Path.home() / "NexLink Shared"
        psutil.cpu_percent(None)  # prime the counter

    # ------------------------------------------------------------ identity
    def physical_ip(self) -> str | None:
        from urllib.parse import urlparse
        host = urlparse(self.server_url).hostname or "8.8.8.8"
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((host if host not in ("localhost",) else "127.0.0.1", 80))
            return s.getsockname()[0]
        except OSError:
            return None
        finally:
            s.close()

    def capabilities(self) -> dict:
        caps = {"metrics": True, "network": True, "terminal": True, "files": True, "diagnostics": True}
        try:
            import mss  # noqa: F401
            caps["screen"] = True
        except ImportError:
            caps["screen"] = False
        try:
            import pynput  # noqa: F401
            caps["input"] = True
        except ImportError:
            caps["input"] = False
        return caps

    def info(self) -> dict:
        uname = platform.uname()
        cpu = platform.processor() or uname.machine
        if IS_WIN:
            try:
                import winreg
                k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
                cpu = winreg.QueryValueEx(k, "ProcessorNameString")[0].strip()
            except OSError:
                pass
        return {
            "hostname": socket.gethostname()[:64],
            "os": f"{uname.system} {uname.release}",
            "osVersion": uname.version[:120],
            "arch": uname.machine,
            "cpuModel": cpu[:120],
            "cpuCores": psutil.cpu_count(logical=True) or 1,
            "ramTotal": psutil.virtual_memory().total,
            "physicalIp": self.physical_ip(),
            "capabilities": self.capabilities(),
        }

    # ------------------------------------------------------------ telemetry
    def metrics(self) -> dict:
        now = time.time()
        io_now = psutil.net_io_counters()
        rx = tx = None
        if self._last_net and self._last_net_t:
            dt = max(0.001, now - self._last_net_t)
            rx = max(0, (io_now.bytes_recv - self._last_net.bytes_recv) / dt)
            tx = max(0, (io_now.bytes_sent - self._last_net.bytes_sent) / dt)
        self._last_net, self._last_net_t = io_now, now
        root = os.environ.get("SystemDrive", "C:") + "\\" if IS_WIN else "/"
        try:
            conn_count = len(psutil.net_connections(kind="inet"))
        except (psutil.AccessDenied, OSError):
            conn_count = None
        return {
            "cpuPct": psutil.cpu_percent(None),
            "ramPct": psutil.virtual_memory().percent,
            "diskPct": psutil.disk_usage(root).percent,
            "rxBps": rx, "txBps": tx,
            "uptimeSec": int(now - psutil.boot_time()),
            "processCount": len(psutil.pids()),
            "connCount": conn_count,
            "latencyMs": self.latency_ms,
            "packetLossPct": self.loss_pct,
        }

    def processes(self) -> list[dict]:
        procs = []
        for p in psutil.process_iter(["pid", "name", "cpu_percent", "memory_info", "username"]):
            try:
                mem = p.info["memory_info"].rss if p.info["memory_info"] else 0
                procs.append({"pid": p.info["pid"], "name": (p.info["name"] or "?")[:60], "cpu": round(p.info["cpu_percent"] or 0, 1),
                              "memMb": round(mem / 1e6, 1), "user": (p.info["username"] or "").split("\\")[-1][:32]})
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        cores = psutil.cpu_count() or 1
        for p in procs:
            p["cpu"] = round(p["cpu"] / cores, 1)
        procs.sort(key=lambda p: (p["cpu"], p["memMb"]), reverse=True)
        return procs[:20]

    def network(self) -> dict:
        interfaces = []
        stats = psutil.net_if_stats()
        counters = psutil.net_io_counters(pernic=True)
        for name, addrs in psutil.net_if_addrs().items():
            st = stats.get(name)
            ipv4 = [a.address for a in addrs if a.family == socket.AF_INET]
            if not ipv4 and not (st and st.isup):
                continue
            c = counters.get(name)
            interfaces.append({"name": name[:48], "up": bool(st and st.isup), "speedMbps": st.speed if st else None,
                               "ipv4": ipv4[:4], "rxBytes": c.bytes_recv if c else None, "txBytes": c.bytes_sent if c else None,
                               "wireguard": "nexlink" in name.lower() or name.lower().startswith("wg")})
        connections, listening, protocols = [], [], {}
        pid_names = {}
        try:
            conns = psutil.net_connections(kind="inet")
        except (psutil.AccessDenied, OSError):
            conns = []
        for c in conns:
            proto = "TCP" if c.type == socket.SOCK_STREAM else "UDP"
            if c.pid and c.pid not in pid_names:
                try:
                    pid_names[c.pid] = psutil.Process(c.pid).name()[:40]
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pid_names[c.pid] = None
            lport = c.laddr.port if c.laddr else None
            if (proto == "TCP" and c.status == psutil.CONN_LISTEN) or (proto == "UDP" and not c.raddr):
                if lport is not None:
                    listening.append({"port": lport, "proto": proto, "addr": c.laddr.ip, "process": pid_names.get(c.pid),
                                      "service": WELL_KNOWN_PORTS.get(lport)})
                continue
            if not c.raddr:
                continue
            rport = c.raddr.port
            service = WELL_KNOWN_PORTS.get(rport) or WELL_KNOWN_PORTS.get(lport) or ("ephemeral" if rport >= 49152 else f"port {rport}")
            protocols[service] = protocols.get(service, 0) + 1
            protocols[proto] = protocols.get(proto, 0) + 1
            connections.append({"proto": proto, "laddr": f"{c.laddr.ip}:{lport}", "raddr": f"{c.raddr.ip}:{rport}",
                                "status": c.status, "process": pid_names.get(c.pid), "service": service})
        uniq = {(l["port"], l["proto"]): l for l in listening}
        tot = psutil.net_io_counters()
        return {"interfaces": interfaces[:16], "connections": connections[:300], "listening": sorted(uniq.values(), key=lambda x: x["port"])[:200],
                "protocols": protocols, "totals": {"rxBytes": tot.bytes_recv, "txBytes": tot.bytes_sent, "errIn": tot.errin, "errOut": tot.errout, "dropIn": tot.dropin, "dropOut": tot.dropout}}

    # ------------------------------------------------------------ ICMP (D3)
    @staticmethod
    def _parse_ping(out: str, count: int):
        times = [float(x) for x in re.findall(r"(?:time|zeit|temps)[=<]\s*([\d.]+)\s*ms", out, re.I)]
        received = len(times)
        loss = round(100 * (count - received) / count, 1)
        avg = round(sum(times) / received, 1) if received else None
        return avg, loss, times

    def ping_burst(self, host: str, count: int = 10):
        args = ["ping", "-n", str(count), "-w", "1000", host] if IS_WIN else ["ping", "-c", str(count), "-W", "1", "-i", "0.2", host]
        code, out, err = _run(args, timeout=count * 2 + 5)
        avg, loss, times = self._parse_ping(out, count)
        return {"host": host, "sent": count, "received": len(times), "lossPct": loss, "avgMs": avg,
                "minMs": min(times) if times else None, "maxMs": max(times) if times else None, "raw": out[-2000:]}

    def update_latency(self, host: str):
        r = self.ping_burst(host)
        self.latency_ms, self.loss_pct = r["avgMs"], r["lossPct"]
        return r

    # ------------------------------------------------------------ diagnostics
    def diagnostics(self, args: dict, hub_host: str) -> dict:
        target = args.get("target") or hub_host
        out = {}
        for test in args.get("tests", []):
            if test == "ping":
                out["ping"] = self.ping_burst(target, 10)
            elif test == "traceroute":
                cmd = ["tracert", "-d", "-h", "15", "-w", "800", target] if IS_WIN else ["traceroute", "-n", "-m", "15", "-w", "1", target]
                code, text, err = _run(cmd, timeout=80)
                hops = []
                for line in text.splitlines():
                    m = re.match(r"\s*(\d+)\s+(.*)", line)
                    if m and re.search(r"\d+\.\d+\.\d+\.\d+|\*", m.group(2)):
                        ip = re.findall(r"\d+\.\d+\.\d+\.\d+", m.group(2))
                        ms = [float(x) for x in re.findall(r"<?([\d.]+)\s*ms", m.group(2))]
                        hops.append({"hop": int(m.group(1)), "ip": ip[-1] if ip else None, "ms": round(sum(ms) / len(ms), 1) if ms else None})
                out["traceroute"] = {"target": target, "hops": hops, "raw": (text or err)[-3000:]}
            elif test == "dns":
                t0 = time.perf_counter()
                try:
                    addrs = sorted({a[4][0] for a in socket.getaddrinfo(target, None)})
                    out["dns"] = {"name": target, "addresses": addrs[:8], "ms": round((time.perf_counter() - t0) * 1000, 1)}
                except socket.gaierror as e:
                    out["dns"] = {"name": target, "error": str(e), "ms": round((time.perf_counter() - t0) * 1000, 1)}
            elif test == "port":
                port = int(args.get("port") or 4000)
                t0 = time.perf_counter()
                try:
                    with socket.create_connection((target, port), timeout=3):
                        out["port"] = {"host": target, "port": port, "open": True, "ms": round((time.perf_counter() - t0) * 1000, 1)}
                except OSError as e:
                    out["port"] = {"host": target, "port": port, "open": False, "error": str(e)[:120]}
            elif test == "mtu":
                results = []
                for size in (1472, 1420, 1380, 1280, 1200):
                    cmd = ["ping", "-n", "1", "-w", "1000", "-f", "-l", str(size), target] if IS_WIN else ["ping", "-c", "1", "-W", "1", "-M", "do", "-s", str(size), target]
                    code, text, _ = _run(cmd, timeout=5)
                    ok = code == 0 and not re.search(r"fragment|too long|message too long", text, re.I)
                    results.append({"payload": size, "ok": ok})
                best = next((r["payload"] for r in results if r["ok"]), None)
                out["mtu"] = {"target": target, "probes": results, "maxPayload": best, "pathMtu": best + 28 if best else None}
        return out

    # ------------------------------------------------------------ screen + input
    def open_screen(self):
        import mss
        self._sct = mss.mss()
        self._monitor = self._sct.monitors[1]
        return self._monitor["width"], self._monitor["height"]

    def grab(self, max_width: int, quality: int) -> bytes:
        from PIL import Image
        shot = self._sct.grab(self._monitor)
        img = Image.frombytes("RGB", shot.size, shot.rgb)
        if img.width > max_width:
            img = img.resize((max_width, int(img.height * max_width / img.width)), Image.BILINEAR)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality, optimize=False)
        return buf.getvalue()

    def close_screen(self):
        try:
            self._sct.close()
        except Exception:
            pass

    _KEYS = None

    def _key(self, name: str):
        from pynput.keyboard import Key
        if RealBackend._KEYS is None:
            RealBackend._KEYS = {
                "Enter": Key.enter, "Backspace": Key.backspace, "Tab": Key.tab, "Escape": Key.esc, " ": Key.space,
                "ArrowUp": Key.up, "ArrowDown": Key.down, "ArrowLeft": Key.left, "ArrowRight": Key.right,
                "Delete": Key.delete, "Home": Key.home, "End": Key.end, "PageUp": Key.page_up, "PageDown": Key.page_down,
                "Shift": Key.shift, "Control": Key.ctrl, "Alt": Key.alt, "Meta": Key.cmd, "CapsLock": Key.caps_lock,
                **{f"F{i}": getattr(Key, f"f{i}") for i in range(1, 13)},
            }
        if name in RealBackend._KEYS:
            return RealBackend._KEYS[name]
        return name if len(name) == 1 else None

    def input(self, evt: dict):
        from pynput.mouse import Button, Controller as Mouse
        from pynput.keyboard import Controller as Keyboard
        if not hasattr(self, "_mouse"):
            self._mouse, self._kb = Mouse(), Keyboard()
        mon = getattr(self, "_monitor", None) or {"left": 0, "top": 0, "width": 1920, "height": 1080}
        kind = evt.get("type")
        if kind in ("move", "down", "up", "click", "dblclick"):
            x = mon["left"] + max(0.0, min(1.0, float(evt.get("x", 0)))) * mon["width"]
            y = mon["top"] + max(0.0, min(1.0, float(evt.get("y", 0)))) * mon["height"]
            self._mouse.position = (int(x), int(y))
            btn = {0: Button.left, 1: Button.middle, 2: Button.right}.get(int(evt.get("button", 0)), Button.left)
            if kind == "down":
                self._mouse.press(btn)
            elif kind == "up":
                self._mouse.release(btn)
            elif kind == "click":
                self._mouse.click(btn, 1)
            elif kind == "dblclick":
                self._mouse.click(btn, 2)
        elif kind == "wheel":
            self._mouse.scroll(0, -1 if float(evt.get("dy", 0)) > 0 else 1)
        elif kind in ("keydown", "keyup"):
            k = self._key(str(evt.get("key", "")))
            if k is not None:
                (self._kb.press if kind == "keydown" else self._kb.release)(k)

    # ------------------------------------------------------------ files
    def file_root(self, policy: str) -> Path | None:
        if policy == "shared":
            self.shared_root.mkdir(parents=True, exist_ok=True)
            return self.shared_root
        return None  # unrestricted (admin)

    def resolve(self, policy: str, rel: str) -> Path:
        root = self.file_root(policy)
        rel = (rel or "").replace("\\", "/")
        if root is None:
            if not rel:
                raise ValueError("drives")
            p = Path(rel).expanduser()
            return p.resolve()
        p = (root / rel.lstrip("/")).resolve()
        if os.path.commonpath([str(p), str(root.resolve())]) != str(root.resolve()):
            raise PermissionError("That path is outside the shared folder.")
        return p

    def display_path(self, policy: str, p: Path) -> str:
        root = self.file_root(policy)
        if root is None:
            return str(p)
        rel = os.path.relpath(p, root.resolve()).replace("\\", "/")
        return "" if rel == "." else rel

    def list_dir(self, policy: str, rel: str) -> dict:
        if self.file_root(policy) is None and not rel:
            if IS_WIN:
                drives = [f"{d}:\\" for d in string.ascii_uppercase if os.path.exists(f"{d}:\\")]
                return {"path": "", "parent": None, "entries": [{"name": d, "dir": True, "size": None, "mtime": None} for d in drives],
                        "root": "This PC"}
            rel = "/"
        p = self.resolve(policy, rel)
        entries = []
        with os.scandir(p) as it:
            for e in it:
                try:
                    st = e.stat(follow_symlinks=False)
                    entries.append({"name": e.name, "dir": e.is_dir(follow_symlinks=False), "size": None if e.is_dir() else st.st_size, "mtime": int(st.st_mtime * 1000)})
                except OSError:
                    continue
        entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
        root = self.file_root(policy)
        if root is None:
            parent = str(p.parent) if p.parent != p else ""
        else:
            parent = None if p == root.resolve() else self.display_path(policy, p.parent)
        return {"path": self.display_path(policy, p), "parent": parent, "entries": entries[:2000],
                "root": "NexLink Shared" if root is not None else None}

    def open_read(self, policy, rel):
        p = self.resolve(policy, rel)
        if p.is_dir():
            raise IsADirectoryError("Choose a file, not a folder.")
        return p, p.stat().st_size, open(p, "rb")

    def open_write(self, policy, rel_dir, name):
        if not name or "/" in name or "\\" in name or name in (".", ".."):
            raise ValueError("Invalid file name.")
        d = self.resolve(policy, rel_dir) if (rel_dir or self.file_root(policy) is not None) else None
        if d is None:
            raise ValueError("Choose a folder first.")
        final = d / name
        tmp = d / f".{name}.nexlink-part"
        return final, tmp, open(tmp, "wb")

    def delete(self, policy, rel):
        p = self.resolve(policy, rel)
        if self.file_root(policy) is not None and p == self.file_root(policy).resolve():
            raise PermissionError("Cannot delete the shared folder itself.")
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()

    def mkdir(self, policy, rel_dir, name):
        if not name or "/" in name or "\\" in name:
            raise ValueError("Invalid folder name.")
        (self.resolve(policy, rel_dir) / name).mkdir()

    def rename(self, policy, rel, new_name):
        if not new_name or "/" in new_name or "\\" in new_name:
            raise ValueError("Invalid name.")
        p = self.resolve(policy, rel)
        p.rename(p.with_name(new_name))

    # ------------------------------------------------------------ terminal (D5)
    def terminal_exec(self, command: str, full_shell: bool, state: dict) -> dict:
        if not full_shell:
            reason = check_allowlisted(command)
            if reason:
                return {"ok": False, "exitCode": -1, "stdout": "", "stderr": reason, "blocked": True, "cwd": state.get("cwd")}
        cwd = state.get("cwd") or str(Path.home())
        cmd = command.strip()
        # `cd` changes the session's working directory (full shell only).
        m = re.match(r"^cd(?:\s+(.*))?$", cmd, re.I)
        if full_shell and m:
            target = (m.group(1) or str(Path.home())).strip().strip('"')
            new = (Path(cwd) / target).resolve() if not re.match(r"^[a-zA-Z]:", target) else Path(target).resolve()
            if new.is_dir():
                state["cwd"] = str(new)
                return {"ok": True, "exitCode": 0, "stdout": "", "stderr": "", "cwd": state["cwd"]}
            return {"ok": False, "exitCode": 1, "stdout": "", "stderr": f"No such directory: {target}", "cwd": cwd}
        code, out, err = _run(cmd, timeout=45, shell=True, cwd=cwd)
        return {"ok": code == 0, "exitCode": code, "stdout": out[-65536:], "stderr": err[-8192:], "cwd": cwd}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
