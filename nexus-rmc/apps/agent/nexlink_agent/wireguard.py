"""WireGuard on the agent (D2): the keypair is generated HERE and the private
key never leaves this machine. If WireGuard is installed and the agent runs
elevated, the tunnel is installed as a Windows service; otherwise the agent
keeps working over the LAN ("direct" mode) and says so.
"""
from __future__ import annotations

import base64
import ctypes
import os
import shutil
import subprocess
import sys
from pathlib import Path

from .config import config_dir

IFACE = "wg-nexlink"
IS_WIN = sys.platform == "win32"
WIREGUARD_EXE = r"C:\Program Files\WireGuard\wireguard.exe"


def generate_keypair() -> tuple[str, str]:
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    from cryptography.hazmat.primitives import serialization
    priv = X25519PrivateKey.generate()
    priv_raw = priv.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())
    pub_raw = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(priv_raw).decode(), base64.b64encode(pub_raw).decode()


def is_admin() -> bool:
    if IS_WIN:
        try:
            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        except Exception:
            return False
    return os.geteuid() == 0


def installed() -> bool:
    return os.path.exists(WIREGUARD_EXE) if IS_WIN else bool(shutil.which("wg-quick"))


def tunnel_up() -> bool:
    wg = shutil.which("wg") or (r"C:\Program Files\WireGuard\wg.exe" if IS_WIN else None)
    if not wg or not os.path.exists(wg) and not shutil.which("wg"):
        return False
    try:
        p = subprocess.run([wg, "show", IFACE], capture_output=True, timeout=5,
                           creationflags=0x08000000 if IS_WIN else 0)
        return p.returncode == 0 and b"peer" in p.stdout
    except (OSError, subprocess.TimeoutExpired):
        return False


def write_config(private_key: str, virtual_ip: str, hub: dict) -> Path:
    conf = config_dir() / f"{IFACE}.conf"
    conf.write_text("\n".join([
        "# NexLink agent tunnel — generated locally; the private key never leaves this PC",
        "[Interface]",
        f"PrivateKey = {private_key}",
        f"Address = {virtual_ip}/32",
        "",
        "[Peer]",
        f"PublicKey = {hub['publicKey']}",
        f"Endpoint = {hub['endpoint']}",
        f"AllowedIPs = {hub.get('allowedIps', '10.50.0.0/24')}",
        "PersistentKeepalive = 25",
        "",
    ]), encoding="utf-8")
    try:
        os.chmod(conf, 0o600)
    except OSError:
        pass
    return conf


def ensure_tunnel(private_key: str, virtual_ip: str, hub: dict) -> tuple[str, str]:
    """Returns (mode, note). mode is 'wireguard' or 'direct'."""
    if hub.get("mode") != "wireguard":
        return "direct", "The hub is running in simulated mode (WireGuard not active on the server)."
    if not installed():
        return "direct", "WireGuard is not installed on this PC; using the LAN connection."
    if tunnel_up():
        return "wireguard", "Tunnel is up."
    if not is_admin():
        return "direct", "Run the agent as Administrator once to install the WireGuard tunnel."
    conf = write_config(private_key, virtual_ip, hub)
    if IS_WIN:
        subprocess.run([WIREGUARD_EXE, "/uninstalltunnelservice", IFACE], capture_output=True, timeout=20)
        p = subprocess.run([WIREGUARD_EXE, "/installtunnelservice", str(conf)], capture_output=True, timeout=30)
    else:
        target = Path("/etc/wireguard") / f"{IFACE}.conf"
        shutil.copy(conf, target)
        p = subprocess.run(["wg-quick", "up", IFACE], capture_output=True, timeout=30)
    if p.returncode != 0:
        return "direct", f"Could not install the tunnel: {p.stderr.decode(errors='replace')[:200]}"
    return "wireguard", "Tunnel installed."
