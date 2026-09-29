"""Agent identity and settings, stored per machine.

Secrets (device secret, WireGuard private key) are encrypted with Windows
DPAPI when available, so another user account on the same PC cannot read them.
"""
from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path

SECRET_FIELDS = ("device_secret", "wg_private_key")


def config_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    d = base / "NexLink" / "Agent"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _protect(value: str) -> str:
    try:
        import win32crypt  # type: ignore
        blob = win32crypt.CryptProtectData(value.encode(), "NexLink", None, None, None, 0)
        return "dpapi:" + base64.b64encode(blob).decode()
    except Exception:  # not Windows / pywin32 missing
        return "plain:" + value


def _unprotect(value: str | None) -> str | None:
    if not value:
        return value
    if value.startswith("dpapi:"):
        import win32crypt  # type: ignore
        return win32crypt.CryptUnprotectData(base64.b64decode(value[6:]), None, None, None, 0)[1].decode()
    if value.startswith("plain:"):
        return value[6:]
    return value


class Config:
    def __init__(self, path: Path | None = None):
        self.path = path or (config_dir() / "agent.json")
        self.data: dict = {}
        if self.path.exists():
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
            except ValueError:
                self.data = {}

    def get(self, key, default=None):
        value = self.data.get(key, default)
        return _unprotect(value) if key in SECRET_FIELDS else value

    def set(self, **values):
        for k, v in values.items():
            if v is None:
                self.data.pop(k, None)
            else:
                self.data[k] = _protect(v) if k in SECRET_FIELDS else v
        self.save()

    def save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def reset(self):
        self.data = {}
        if self.path.exists():
            self.path.unlink()
