"""NexLink device simulator (D9).

Starts N simulated agents in one process. They use the exact same protocol
and enrollment flow as real agents (one enrollment token with enough uses),
are flagged `simulated`, get addresses from 10.50.0.200+, and keep their
identity between runs. Faults are injected from the console (device page →
Simulate fault) for a reproducible anomaly demo.

    python -m nexlink_agent.simulator --server http://localhost:4000 --token nxl_… --count 5
    python -m nexlink_agent.simulator            # restart previously enrolled simulators
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys

from .agent import Agent
from .backend_sim import SimBackend
from .config import config_dir

NAMES = ["LAB-PC-01", "LAB-PC-02", "LAB-PC-03", "DEV-LAPTOP-01", "OFFICE-PC-01", "LAB-PC-04", "LAB-PC-05", "RECEPTION-PC", "LIBRARY-PC-01", "SERVER-NAS"]


class SimStore:
    """Per-simulator identity inside one JSON file."""

    def __init__(self, path, key):
        self.path, self.key = path, key

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def get(self, k, default=None):
        return self._load().get(self.key, {}).get(k, default)

    def set(self, **values):
        data = self._load()
        entry = data.setdefault(self.key, {})
        for k, v in values.items():
            if v is None:
                entry.pop(k, None)
            else:
                entry[k] = v
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, self.path)


async def run(server, token, count, prefix):
    path = config_dir() / "simulators.json"
    agents = []
    for i in range(count):
        name = f"{prefix}{i + 1:02d}" if prefix else NAMES[i % len(NAMES)] + ("" if i < len(NAMES) else f"-{i}")
        store = SimStore(path, f"{server}|{name}")  # identities are per server
        enrolled = bool(store.get("device_secret"))
        if not enrolled and not token:
            logging.warning("[%s] not enrolled on %s and no --token given; skipping", name, server)
            continue
        store.set(server=server)
        agents.append(Agent(server, SimBackend(i, name), store, enrollment_token=None if enrolled else token, label=name))
    if not agents:
        print("Nothing to run. Create an enrollment token in the console (Devices → Enroll a device) with enough uses.")
        return
    print(f"Running {len(agents)} simulated device(s) against {server}. Press Ctrl+C to stop.")
    await asyncio.gather(*(a.run_forever() for a in agents))


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(prog="nexlink_agent.simulator")
    ap.add_argument("--server", default="http://localhost:4000")
    ap.add_argument("--token", help="enrollment token (needs one use per new simulator)")
    ap.add_argument("--count", type=int, default=5)
    ap.add_argument("--prefix", default="", help="name prefix instead of the built-in names, e.g. SIM-")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    try:
        asyncio.run(run(args.server.rstrip("/"), args.token, max(1, min(args.count, 50)), args.prefix))
    except KeyboardInterrupt:
        print("\nSimulator stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
