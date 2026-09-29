"""Builds dist/NexLinkAgent.exe (one file, visible console window by design)."""
import os
import PyInstaller.__main__

here = os.path.dirname(os.path.abspath(__file__))
icon = os.path.join(here, "..", "desktop", "build", "nexlink.ico")
PyInstaller.__main__.run([
    os.path.join(here, "agent_entry.py"),
    "--name", "NexLinkAgent",
    "--onefile",
    "--console",
    "--noconfirm",
    "--clean",
    "--icon", icon,
    "--distpath", os.path.join(here, "dist"),
    "--workpath", os.path.join(here, "build"),
    "--specpath", os.path.join(here, "build"),
    "--hidden-import", "pynput.keyboard._win32",
    "--hidden-import", "pynput.mouse._win32",
    "--hidden-import", "win32crypt",
    "--collect-submodules", "websockets",
    "--exclude-module", "matplotlib",
    "--exclude-module", "scipy",
    "--exclude-module", "pandas",
    "--exclude-module", "sklearn",
    "--exclude-module", "IPython",
    "--exclude-module", "numpy",
])
