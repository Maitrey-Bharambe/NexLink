"""PyInstaller entry point for NexLink Agent.exe."""
import sys

from nexlink_agent.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
