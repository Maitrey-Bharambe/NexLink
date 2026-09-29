"""NexLink Agent CLI.

    python -m nexlink_agent enroll --server http://192.168.1.10:4000 --token nxl_…
    python -m nexlink_agent run          # after enrollment (default command)
    python -m nexlink_agent status
    python -m nexlink_agent reset        # forget this device's identity
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys

from . import __version__
from .agent import Agent
from .backend_real import RealBackend
from .config import Config


def main(argv=None):
    # Windows consoles often use cp1252; never crash on a character we print.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(prog="nexlink_agent", description=f"NexLink Agent {__version__}")
    sub = ap.add_subparsers(dest="cmd")
    e = sub.add_parser("enroll", help="enroll this PC with a one-time token, then keep running")
    e.add_argument("--server", help="control server URL, e.g. http://192.168.1.10:4000")
    e.add_argument("--token", help="enrollment token from the console (Devices -> Enroll)")
    e.add_argument("--code", help="enrollment code (NXL1.…) instead of --server/--token")
    sub.add_parser("run", help="run the agent (default)")
    sub.add_parser("status", help="show this agent's identity")
    sub.add_parser("reset", help="forget this device's identity")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    cfg = Config()

    if args.cmd == "status":
        print(json.dumps({"server": cfg.get("server"), "deviceId": cfg.get("device_id"), "virtualIp": cfg.get("virtual_ip"),
                          "enrolled": bool(cfg.get("device_secret")), "config": str(cfg.path)}, indent=2))
        return 0
    if args.cmd == "reset":
        cfg.reset()
        print("Identity removed. Enroll again with a new token.")
        return 0

    token = None
    # Double-clicked packaged agent that is not enrolled yet: ask in a window.
    if args.cmd is None and not cfg.get("device_secret"):
        try:
            from .enroll_ui import ask
            answer = ask()
        except Exception as e:  # no display
            print(f"Could not open the enrollment window ({e}). Use: enroll --server URL --token TOKEN", file=sys.stderr)
            return 1
        if not answer:
            return 0
        cfg.set(server=answer[0])
        token = answer[1]
    if args.cmd == "enroll":
        if cfg.get("device_secret"):
            print("This PC is already enrolled. Run `python -m nexlink_agent reset` first to enroll again.", file=sys.stderr)
            return 1
        if args.code:
            from .enroll_ui import decode_code
            decoded = decode_code(args.code)
            if not decoded:
                print("That enrollment code is not valid.", file=sys.stderr)
                return 1
            args.server, args.token = decoded
        if not args.server or not args.token:
            print("Give --code, or both --server and --token.", file=sys.stderr)
            return 1
        cfg.set(server=args.server.rstrip("/"))
        token = args.token
    server = cfg.get("server")
    if not server:
        print("Not enrolled yet. Run: python -m nexlink_agent enroll --server URL --token TOKEN", file=sys.stderr)
        return 1

    backend = RealBackend(server)
    agent = Agent(server, backend, cfg, enrollment_token=token)
    print(f"NexLink Agent {__version__} - {backend.info()['hostname']} -> {server}")
    print("This agent is visible by design: a banner appears on screen during any remote session.")
    try:
        asyncio.run(agent.run_forever())
    except KeyboardInterrupt:
        print("\nAgent stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
