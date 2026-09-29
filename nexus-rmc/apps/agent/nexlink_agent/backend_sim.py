"""Simulated device backend (D9). Speaks the exact same protocol as a real
agent; every value is generated and the device is flagged `simulated`, so the
console labels it SIM. Faults can be injected from the console for demos:
latency spike, packet loss, CPU burn, traffic burst, memory leak.
"""
from __future__ import annotations

import hashlib
import io
import math
import random
import time
from datetime import datetime

from .protocol import WELL_KNOWN_PORTS, check_allowlisted

PROFILES = [
    ("Windows 11 Pro", "Intel Core i5-1235U", 8, 16e9),
    ("Windows 10 Pro", "Intel Core i7-8700", 12, 16e9),
    ("Ubuntu 22.04 LTS", "AMD Ryzen 5 5600G", 12, 32e9),
    ("Windows 11 Home", "AMD Ryzen 7 5800H", 16, 16e9),
    ("Debian 12", "Intel Xeon E-2224", 4, 8e9),
]

FAULTS = ("latency", "loss", "cpu", "traffic", "memory")


class SimBackend:
    simulated = True

    def __init__(self, index: int, hostname: str, seed: int | None = None):
        self.index = index
        self.hostname = hostname
        self.rng = random.Random(seed if seed is not None else index * 7919)
        self.profile = PROFILES[index % len(PROFILES)]
        self.t0 = time.time() - self.rng.randint(3600, 9 * 86400)
        self.base = {
            "cpu": self.rng.uniform(8, 25), "ram": self.rng.uniform(35, 60), "disk": self.rng.uniform(30, 75),
            "rx": self.rng.uniform(20e3, 400e3), "tx": self.rng.uniform(5e3, 120e3), "lat": self.rng.uniform(2, 18),
        }
        self.faults: dict[str, float] = {}  # fault -> expires at
        self.latency_ms = None
        self.loss_pct = 0.0
        self.virtual_ip = None
        self.files = {
            "": ["Documents", "Reports", "Downloads", "readme.txt"],
            "Documents": ["network-plan.docx", "inventory.xlsx"],
            "Reports": ["weekly-2026-09.pdf"],
            "Downloads": [],
        }
        self.sizes = {"readme.txt": 812, "network-plan.docx": 48210, "inventory.xlsx": 23110, "weekly-2026-09.pdf": 381220}

    # ------------------------------------------------------------ faults
    def inject(self, fault: str, seconds: int = 120) -> dict:
        if fault == "clear":
            self.faults.clear()
            return {"active": []}
        if fault not in FAULTS:
            raise ValueError(f"Unknown fault {fault}")
        self.faults[fault] = time.time() + max(10, min(int(seconds), 1800))
        return {"active": self.active_faults()}

    def active_faults(self):
        now = time.time()
        self.faults = {k: v for k, v in self.faults.items() if v > now}
        return sorted(self.faults)

    def _on(self, fault):
        return fault in self.active_faults()

    # ------------------------------------------------------------ identity
    def physical_ip(self):
        return f"192.168.56.{100 + self.index}"

    def capabilities(self):
        return {"metrics": True, "network": True, "terminal": True, "files": True, "diagnostics": True, "screen": True, "input": True, "simulated": True}

    def info(self):
        os_name, cpu, cores, ram = self.profile
        return {"hostname": self.hostname, "os": os_name, "osVersion": f"{os_name} (simulated)", "arch": "AMD64",
                "cpuModel": cpu, "cpuCores": cores, "ramTotal": ram, "physicalIp": self.physical_ip(),
                "capabilities": self.capabilities()}

    # ------------------------------------------------------------ telemetry
    def _wave(self, period, amp):
        return amp * math.sin(time.time() / period + self.index)

    def metrics(self):
        r = self.rng
        cpu = self.base["cpu"] + self._wave(90, 6) + r.gauss(0, 3)
        ram = self.base["ram"] + self._wave(600, 4) + r.gauss(0, 0.8)
        rx = self.base["rx"] * (1 + 0.4 * math.sin(time.time() / 45 + self.index)) * r.uniform(0.7, 1.3)
        tx = self.base["tx"] * (1 + 0.4 * math.sin(time.time() / 50 + self.index)) * r.uniform(0.7, 1.3)
        if self._on("cpu"):
            cpu = r.uniform(92, 99)
        if self._on("memory"):
            ram = min(98, ram + 35 + r.uniform(0, 5))
        if self._on("traffic"):
            rx *= r.uniform(40, 80)
            tx *= r.uniform(20, 40)
        return {
            "cpuPct": round(max(0.5, min(100, cpu)), 1), "ramPct": round(max(5, min(100, ram)), 1),
            "diskPct": round(self.base["disk"], 1), "rxBps": round(rx), "txBps": round(tx),
            "uptimeSec": int(time.time() - self.t0), "processCount": 140 + self.index * 7 + r.randint(-4, 4),
            "connCount": 30 + r.randint(0, 25) + (200 if self._on("traffic") else 0),
            "latencyMs": self.latency_ms, "packetLossPct": self.loss_pct,
        }

    def processes(self):
        r = self.rng
        names = ["chrome.exe", "Code.exe", "explorer.exe", "svchost.exe", "Teams.exe", "python.exe", "OneDrive.exe", "SearchHost.exe"]
        procs = [{"pid": 1000 + i * 37, "name": n, "cpu": round(abs(r.gauss(2, 2)), 1), "memMb": round(r.uniform(40, 700), 1), "user": "student"} for i, n in enumerate(names)]
        if self._on("cpu"):
            procs.insert(0, {"pid": 6666, "name": "stress-test.exe", "cpu": round(r.uniform(85, 95), 1), "memMb": 120.0, "user": "student"})
        if self._on("memory"):
            procs.insert(0, {"pid": 7777, "name": "leaky-app.exe", "cpu": 3.2, "memMb": round(r.uniform(5000, 9000), 1), "user": "student"})
        return sorted(procs, key=lambda p: p["cpu"], reverse=True)

    def network(self):
        r = self.rng
        remote = [("142.250.183.14", 443), ("20.190.160.10", 443), ("104.18.32.7", 443), ("8.8.8.8", 53), ("10.50.0.1", 4000), ("52.96.40.2", 993)]
        if self._on("traffic"):
            remote += [("185.199.108.133", 443)] * 12 + [("91.189.91.38", 80)] * 6
        conns, protocols = [], {}
        for i, (ip, port) in enumerate(remote):
            service = WELL_KNOWN_PORTS.get(port, f"port {port}")
            proto = "UDP" if port == 53 else "TCP"
            conns.append({"proto": proto, "laddr": f"{self.physical_ip()}:{50000 + i}", "raddr": f"{ip}:{port}",
                          "status": "ESTABLISHED" if proto == "TCP" else "NONE", "process": r.choice(["chrome.exe", "svchost.exe", "Teams.exe"]), "service": service})
            protocols[service] = protocols.get(service, 0) + 1
            protocols[proto] = protocols.get(proto, 0) + 1
        listening = [{"port": p, "proto": "TCP", "addr": "0.0.0.0", "process": n, "service": WELL_KNOWN_PORTS.get(p)} for p, n in [(135, "svchost.exe"), (445, "System"), (3389, "svchost.exe")]]
        return {"interfaces": [{"name": "Ethernet (sim)", "up": True, "speedMbps": 1000, "ipv4": [self.physical_ip()]},
                               {"name": "wg-nexlink (sim)", "up": True, "speedMbps": None, "ipv4": [self.virtual_ip] if self.virtual_ip else [], "wireguard": True}],
                "connections": conns, "listening": listening, "protocols": protocols, "totals": {}}

    # ------------------------------------------------------------ ICMP
    def ping_burst(self, host, count=10):
        r = self.rng
        base = self.base["lat"] + self._wave(120, 2)
        if self._on("latency"):
            base += r.uniform(180, 320)
        loss_p = r.uniform(0.15, 0.35) if self._on("loss") else 0.0
        times = [round(max(0.4, base + r.gauss(0, base * 0.15)), 1) for _ in range(count) if r.random() >= loss_p]
        loss = round(100 * (count - len(times)) / count, 1)
        return {"host": host, "sent": count, "received": len(times), "lossPct": loss,
                "avgMs": round(sum(times) / len(times), 1) if times else None,
                "minMs": min(times) if times else None, "maxMs": max(times) if times else None, "raw": "(simulated)"}

    def update_latency(self, host):
        res = self.ping_burst(host)
        self.latency_ms, self.loss_pct = res["avgMs"], res["lossPct"]
        return res

    def diagnostics(self, args, hub_host):
        target = args.get("target") or hub_host
        out = {}
        for test in args.get("tests", []):
            if test == "ping":
                out["ping"] = self.ping_burst(target)
            elif test == "traceroute":
                hops = [{"hop": 1, "ip": "10.50.0.1", "ms": round(self.base["lat"], 1)}]
                if target != hub_host:
                    hops += [{"hop": 2, "ip": "192.168.1.1", "ms": round(self.base["lat"] + 2, 1)},
                             {"hop": 3, "ip": "100.64.0.1", "ms": round(self.base["lat"] + 9, 1)}]
                out["traceroute"] = {"target": target, "hops": hops, "raw": "(simulated)"}
            elif test == "dns":
                out["dns"] = {"name": target, "addresses": ["10.50.0.1"] if target.startswith("10.") else ["93.184.216.34"], "ms": round(self.rng.uniform(4, 30), 1)}
            elif test == "port":
                out["port"] = {"host": target, "port": int(args.get("port") or 4000), "open": True, "ms": round(self.base["lat"] + 1, 1)}
            elif test == "mtu":
                probes = [{"payload": s, "ok": s <= 1392} for s in (1472, 1420, 1380, 1280, 1200)]
                out["mtu"] = {"target": target, "probes": probes, "maxPayload": 1380, "pathMtu": 1408}
        return out

    # ------------------------------------------------------------ screen (rendered)
    def open_screen(self):
        return 1280, 800

    def grab(self, max_width, quality):
        from PIL import Image, ImageDraw
        w, h = 1280, 800
        img = Image.new("RGB", (w, h), (3, 58, 65))
        d = ImageDraw.Draw(img)
        for x in range(0, w, 32):
            for y in range(0, h, 32):
                d.point((x, y), fill=(20, 80, 88))
        d.rectangle((0, h - 44, w, h), fill=(2, 47, 53))
        d.text((16, h - 30), f"{self.hostname}  ·  SIMULATED DEVICE  ·  {self.virtual_ip or ''}", fill=(246, 231, 208))
        d.text((w - 110, h - 30), datetime.now().strftime("%H:%M:%S"), fill=(9, 196, 177))
        # A "window"
        d.rounded_rectangle((180, 120, 1100, 620), radius=10, fill=(252, 246, 236), outline=(179, 156, 125))
        d.rectangle((180, 120, 1100, 160), fill=(3, 58, 65))
        d.text((196, 134), "Task Manager — simulated", fill=(246, 231, 208))
        m = self.metrics()
        for i, (label, val) in enumerate([("CPU", m["cpuPct"]), ("Memory", m["ramPct"]), ("Disk", m["diskPct"])]):
            y = 200 + i * 70
            d.text((220, y), f"{label}  {val:.0f}%", fill=(3, 58, 65))
            d.rectangle((220, y + 22, 1060, y + 40), fill=(230, 214, 188))
            fill = (221, 170, 107) if val > 85 else (9, 196, 177)
            d.rectangle((220, y + 22, 220 + int(840 * val / 100), y + 40), fill=fill)
        d.text((220, 430), f"Download {m['rxBps'] / 1e3:.0f} KB/s   Upload {m['txBps'] / 1e3:.0f} KB/s", fill=(95, 104, 101))
        d.text((220, 460), f"Active faults: {', '.join(self.active_faults()) or 'none'}", fill=(147, 101, 44))
        if hasattr(self, "_cursor"):
            cx, cy = self._cursor
            d.polygon([(cx, cy), (cx + 12, cy + 30), (cx + 18, cy + 18), (cx + 30, cy + 12)], fill=(255, 255, 255), outline=(0, 0, 0))
        if img.width > max_width:
            img = img.resize((max_width, int(img.height * max_width / img.width)))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality)
        return buf.getvalue()

    def close_screen(self):
        pass

    def input(self, evt):
        if evt.get("type") in ("move", "down", "up", "click", "dblclick"):
            self._cursor = (int(float(evt.get("x", 0)) * 1280), int(float(evt.get("y", 0)) * 800))

    # ------------------------------------------------------------ files (in memory)
    def list_dir(self, policy, rel):
        rel = (rel or "").strip("/")
        if rel not in self.files:
            raise FileNotFoundError("No such folder.")
        entries = []
        for name in self.files[rel]:
            path = f"{rel}/{name}".strip("/")
            is_dir = path in self.files
            entries.append({"name": name, "dir": is_dir, "size": None if is_dir else self.sizes.get(name, 1024), "mtime": int(self.t0 * 1000)})
        entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
        parent = None if rel == "" else ("/".join(rel.split("/")[:-1]))
        return {"path": rel, "parent": parent, "entries": entries, "root": f"{self.hostname} (simulated)"}

    def sim_file_bytes(self, rel):
        name = rel.split("/")[-1]
        size = self.sizes.get(name, 1024)
        seed = hashlib.sha256(rel.encode()).digest()
        return (f"Simulated file {rel} from {self.hostname}\n".encode() + seed * (size // 32 + 1))[:size]

    def sim_store(self, rel_dir, name, data: bytes):
        rel_dir = (rel_dir or "").strip("/")
        if rel_dir not in self.files:
            raise FileNotFoundError("No such folder.")
        if name not in self.files[rel_dir]:
            self.files[rel_dir].append(name)
        self.sizes[name] = len(data)

    def delete(self, policy, rel):
        rel = rel.strip("/")
        parent, name = ("/".join(rel.split("/")[:-1]), rel.split("/")[-1])
        if name in self.files.get(parent, []):
            self.files[parent].remove(name)
            self.files.pop(rel, None)

    def mkdir(self, policy, rel_dir, name):
        rel_dir = (rel_dir or "").strip("/")
        self.files.setdefault(rel_dir, []).append(name)
        self.files[f"{rel_dir}/{name}".strip("/")] = []

    def rename(self, policy, rel, new_name):
        rel = rel.strip("/")
        parent, name = ("/".join(rel.split("/")[:-1]), rel.split("/")[-1])
        lst = self.files.get(parent, [])
        if name in lst:
            lst[lst.index(name)] = new_name
            if rel in self.files:
                self.files[f"{parent}/{new_name}".strip("/")] = self.files.pop(rel)

    # ------------------------------------------------------------ terminal (canned)
    def terminal_exec(self, command, full_shell, state):
        if not full_shell:
            reason = check_allowlisted(command)
            if reason:
                return {"ok": False, "exitCode": -1, "stdout": "", "stderr": reason, "blocked": True}
        cmd = command.strip().split()[0].lower() if command.strip() else ""
        vip = self.virtual_ip or "10.50.0.x"
        outputs = {
            "hostname": self.hostname,
            "whoami": f"{self.hostname.lower()}\\student",
            "ipconfig": f"Windows IP Configuration (simulated)\n\nEthernet adapter Ethernet:\n   IPv4 Address. . . . . . . . . . . : {self.physical_ip()}\n   Subnet Mask . . . . . . . . . . . : 255.255.255.0\n   Default Gateway . . . . . . . . . : 192.168.56.1\n\nUnknown adapter wg-nexlink:\n   IPv4 Address. . . . . . . . . . . : {vip}\n   Subnet Mask . . . . . . . . . . . : 255.255.255.255\n",
            "ping": "\n".join([f"Reply from 10.50.0.1: bytes=32 time={self.ping_burst('10.50.0.1', 1)['avgMs'] or 'timeout'}ms TTL=128" for _ in range(4)]),
            "systeminfo": f"Host Name: {self.hostname}\nOS Name: {self.profile[0]}\nProcessor: {self.profile[1]}\nTotal Physical Memory: {self.profile[3] / 1e9:.0f} GB\n(simulated)",
            "tasklist": "\n".join(f"{p['name']:<28}{p['pid']:>8}  {p['memMb']:>8.1f} MB" for p in self.processes()),
            "netstat": "\n".join(f"  {c['proto']}    {c['laddr']:<24}{c['raddr']:<24}{c['status']}" for c in self.network()["connections"]),
            "echo": command.strip()[5:],
            "date": datetime.now().strftime("%a %d/%m/%Y"),
            "ver": f"{self.profile[0]} (simulated)",
        }
        out = outputs.get(cmd, f"(simulated) '{command.strip()}' completed with no output.")
        return {"ok": True, "exitCode": 0, "stdout": out + "\n", "stderr": "", "cwd": "C:\\Users\\student"}
