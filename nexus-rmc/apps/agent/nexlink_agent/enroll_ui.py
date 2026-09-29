"""First-run window for the packaged agent: paste the enrollment code from the
NexLink console (or a server address + token) and the agent enrolls itself.

Enrollment code format:  NXL1.<base64url(JSON {"s": serverUrl, "t": token})>
"""
from __future__ import annotations

import base64
import json


def decode_code(code: str) -> tuple[str, str] | None:
    code = (code or "").strip()
    if not code.startswith("NXL1."):
        return None
    try:
        raw = code[5:] + "=" * (-len(code[5:]) % 4)
        data = json.loads(base64.urlsafe_b64decode(raw))
        return str(data["s"]).rstrip("/"), str(data["t"])
    except (ValueError, KeyError):
        return None


def ask() -> tuple[str, str] | None:
    """Shows the dialog. Returns (server, token) or None if cancelled."""
    import tkinter as tk
    from tkinter import ttk

    result: dict = {}
    root = tk.Tk()
    root.title("NexLink Agent — enroll this PC")
    root.configure(bg="#F6E7D0")
    root.resizable(False, False)
    style = ttk.Style(root)
    style.configure("TLabel", background="#F6E7D0", foreground="#033A41", font=("Segoe UI", 10))
    style.configure("Head.TLabel", font=("Segoe UI", 14, "bold"))
    style.configure("Muted.TLabel", foreground="#5F6865", font=("Segoe UI", 9))

    frm = tk.Frame(root, bg="#F6E7D0", padx=24, pady=20)
    frm.pack()
    ttk.Label(frm, text="Connect this PC to NexLink", style="Head.TLabel").grid(row=0, column=0, sticky="w")
    ttk.Label(frm, text="In the NexLink console: Devices → Enroll a device → copy the enrollment code.", style="Muted.TLabel").grid(row=1, column=0, sticky="w", pady=(2, 14))
    ttk.Label(frm, text="Enrollment code").grid(row=2, column=0, sticky="w")
    code = tk.Text(frm, width=56, height=3, font=("Consolas", 9), relief="solid", bd=1, wrap="char")
    code.grid(row=3, column=0, sticky="we", pady=(4, 10))
    ttk.Label(frm, text="…or enter the server address and token separately", style="Muted.TLabel").grid(row=4, column=0, sticky="w")
    server = ttk.Entry(frm, width=58)
    server.insert(0, "http://")
    server.grid(row=5, column=0, sticky="we", pady=(4, 4))
    token = ttk.Entry(frm, width=58)
    token.grid(row=6, column=0, sticky="we")
    err = ttk.Label(frm, text="", foreground="#B0463D")
    err.grid(row=7, column=0, sticky="w", pady=(8, 0))
    ttk.Label(frm, text="This agent is visible by design: a banner shows during any remote session,\nand you can disconnect at any time.", style="Muted.TLabel").grid(row=8, column=0, sticky="w", pady=(6, 10))

    def submit():
        decoded = decode_code(code.get("1.0", "end"))
        if decoded:
            result["v"] = decoded
        else:
            s, t = server.get().strip().rstrip("/"), token.get().strip()
            if not (s.startswith("http://") or s.startswith("https://")) or len(s) < 10 or not t:
                err.configure(text="Paste the enrollment code, or a server address and token.")
                return
            result["v"] = (s, t)
        root.destroy()

    btns = tk.Frame(frm, bg="#F6E7D0")
    btns.grid(row=9, column=0, sticky="e")
    tk.Button(btns, text="Cancel", command=root.destroy, relief="flat", bg="#F8EDDC", fg="#033A41", padx=14, pady=4).pack(side="left", padx=(0, 8))
    tk.Button(btns, text="Enroll", command=submit, relief="flat", bg="#033A41", fg="#F6E7D0", activebackground="#0A4D55", padx=18, pady=4).pack(side="left")
    root.bind("<Return>", lambda _e: submit())
    root.eval("tk::PlaceWindow . center")
    root.mainloop()
    return result.get("v")
