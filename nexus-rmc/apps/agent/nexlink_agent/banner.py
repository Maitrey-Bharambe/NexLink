"""Always-on-top banner shown on the managed PC during a remote session (D10).
The local user can end the session at any time with "Disconnect".
"""
from __future__ import annotations

import threading


class SessionBanner:
    def __init__(self, text: str, on_disconnect, danger: bool = False):
        self.text = text
        self.on_disconnect = on_disconnect
        self.danger = danger
        self._root = None
        self._thread = threading.Thread(target=self._run, name="nexlink-banner", daemon=True)

    def start(self):
        self._thread.start()
        return self

    def _run(self):
        try:
            import tkinter as tk
        except ImportError:
            return
        try:
            root = tk.Tk()
        except Exception:  # no display (service session)
            return
        self._root = root
        bg = "#B0463D" if self.danger else "#033A41"
        root.overrideredirect(True)
        root.attributes("-topmost", True)
        root.configure(bg=bg)
        frame = tk.Frame(root, bg=bg, padx=14, pady=8)
        frame.pack()
        tk.Label(frame, text="●", fg="#09C4B1" if not self.danger else "#F6E7D0", bg=bg, font=("Segoe UI", 11)).pack(side="left")
        tk.Label(frame, text=self.text, fg="#F6E7D0", bg=bg, font=("Segoe UI", 10, "bold")).pack(side="left", padx=(6, 14))
        tk.Button(frame, text="Disconnect", command=self._disconnect, bg="#F6E7D0", fg="#033A41", relief="flat",
                  font=("Segoe UI", 9, "bold"), padx=10, cursor="hand2").pack(side="left")
        root.update_idletasks()
        w = root.winfo_width()
        x = (root.winfo_screenwidth() - w) // 2
        root.geometry(f"+{x}+0")
        root.mainloop()

    def _disconnect(self):
        try:
            self.on_disconnect()
        finally:
            self.close()

    def close(self):
        root = self._root
        if root is not None:
            try:
                root.after(0, root.destroy)
            except Exception:
                pass
            self._root = None
