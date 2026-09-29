NexLink 1.0.0 - what to give to whom
====================================

NexLink-Setup-1.0.0.exe
  - Hub PC (one per network): install MongoDB Community Server first, then this.
    Open NexLink and choose "Start the server on this PC".
  - Everyone else (admins and users): install this and connect to the hub's
    address (shown in NexLink > Settings > Share NexLink).

NexLinkAgent.exe
  - Every PC you want to manage. Run it and paste the enrollment code from
    NexLink > Devices > Enroll a device. (The hub also serves this file at
    http://<hub>:4000/downloads/NexLinkAgent.exe)

Full instructions: HOW-TO-INSTALL.md   Features: USER-GUIDE.md
