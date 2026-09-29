"""NexLink protocol v1.0 — Python mirror of packages/protocol/src/index.js.

Every text frame is a JSON envelope:
    {version, messageId, type, deviceId, sessionId, timestamp, payload}
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone

PROTOCOL_VERSION = "1.0"


class T:
    AUTH_REQUEST = "AUTH_REQUEST"
    AUTH_RESPONSE = "AUTH_RESPONSE"
    DEVICE_REGISTER = "DEVICE_REGISTER"
    DEVICE_APPROVED = "DEVICE_APPROVED"
    DEVICE_PENDING = "DEVICE_PENDING"
    DEVICE_REJECTED = "DEVICE_REJECTED"
    HEARTBEAT = "HEARTBEAT"
    METRIC_UPDATE = "METRIC_UPDATE"
    NETWORK_UPDATE = "NETWORK_UPDATE"
    PROCESS_UPDATE = "PROCESS_UPDATE"
    SESSION_START = "SESSION_START"
    SESSION_READY = "SESSION_READY"
    SESSION_END = "SESSION_END"
    SESSION_STATS = "SESSION_STATS"
    SCREEN_FRAME = "SCREEN_FRAME"
    REMOTE_INPUT = "REMOTE_INPUT"
    FILE_REQUEST = "FILE_REQUEST"
    FILE_RESPONSE = "FILE_RESPONSE"
    COMMAND_REQUEST = "COMMAND_REQUEST"
    COMMAND_RESPONSE = "COMMAND_RESPONSE"
    PING = "PING"
    PONG = "PONG"
    STATE_SNAPSHOT = "STATE_SNAPSHOT"
    EVENT = "EVENT"
    ERROR = "ERROR"


# Binary frames on session channels: byte 0 is the kind.
BIN_SCREEN = 1
BIN_FILE = 2

TERMINAL_ALLOWLIST = {
    "ipconfig", "ifconfig", "ip", "ping", "tracert", "traceroute", "pathping", "netstat", "nslookup", "dig",
    "arp", "route", "tasklist", "ps", "systeminfo", "whoami", "hostname", "dir", "ls", "pwd", "uptime",
    "df", "free", "getmac", "ss", "wg", "echo", "date", "ver", "uname",
}
_SHELL_META = re.compile(r"[;&|`$<>(){}\n\r%^]|\.\.")

WELL_KNOWN_PORTS = {
    20: "FTP-DATA", 21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS", 67: "DHCP", 68: "DHCP", 80: "HTTP",
    110: "POP3", 123: "NTP", 135: "RPC", 137: "NetBIOS", 138: "NetBIOS", 139: "NetBIOS", 143: "IMAP", 161: "SNMP",
    389: "LDAP", 443: "HTTPS", 445: "SMB", 465: "SMTPS", 587: "SMTP", 993: "IMAPS", 995: "POP3S", 1433: "MSSQL",
    1900: "SSDP", 3306: "MySQL", 3389: "RDP", 4000: "NexLink", 5353: "mDNS", 5432: "PostgreSQL", 5900: "VNC",
    6379: "Redis", 8000: "HTTP-alt", 8080: "HTTP-alt", 8443: "HTTPS-alt", 27017: "MongoDB", 51820: "WireGuard",
}


def check_allowlisted(line: str) -> str | None:
    """Same rules as the server (defence in depth). Returns None if allowed, else a reason."""
    text = (line or "").strip()
    if not text:
        return "Empty command."
    if len(text) > 256:
        return "Command is too long."
    if _SHELL_META.search(text):
        return "Pipes, redirection, chaining and parent paths are not allowed in restricted mode."
    cmd = text.split()[0].lower()
    if cmd.endswith(".exe"):
        cmd = cmd[:-4]
    if cmd not in TERMINAL_ALLOWLIST:
        return f'"{cmd}" is not on the allowed command list.'
    if cmd == "route" and not re.match(r"^route\s+print(\s|$)", text, re.I):
        return 'Only "route print" is allowed.'
    if cmd == "wg" and text.lower() != "wg" and not re.match(r"^wg\s+show(\s|$)", text, re.I):
        return 'Only "wg show" is allowed.'
    if cmd == "ip" and not re.match(r"^ip\s+(a|addr|address|r|route|link)(\s|$)", text, re.I):
        return 'Only "ip addr/route/link" is allowed.'
    return None


def message(type_: str, payload: dict | None = None, device_id: str | None = None, session_id: str | None = None) -> str:
    return json.dumps({
        "version": PROTOCOL_VERSION,
        "messageId": str(uuid.uuid4()),
        "type": type_,
        "deviceId": device_id,
        "sessionId": session_id,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "payload": payload or {},
    })


def parse(raw) -> dict | None:
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(msg, dict) or msg.get("version") != PROTOCOL_VERSION or not isinstance(msg.get("payload"), dict):
        return None
    return msg


def ws_url(server: str, path: str) -> str:
    base = server.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):] + path
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):] + path
    return base + path
