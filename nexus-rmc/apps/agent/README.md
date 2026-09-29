# NexLink Agent

Runs **visibly** on each managed PC:
- a console window stays open while it runs;
- a banner with a **Disconnect** button shows during any remote session.

## Use (packaged)

1. Run `NexLinkAgent.exe` (download it from `http://<hub>:4000/downloads/NexLinkAgent.exe`).
2. Paste the enrollment code from **Devices → Enroll a device**.
3. Approve the device in NexLink.

Other commands:
- `NexLinkAgent.exe status`
- `NexLinkAgent.exe reset`
- `NexLinkAgent.exe enroll --code NXL1.…`

## Use (Python)

```bash
pip install -r requirements.txt
```

```bash
python -m nexlink_agent enroll --server http://192.168.0.105:4000 --token nxl_…
```

After that, `python -m nexlink_agent run` starts it again.

## Simulator (demo)

```bash
python -m nexlink_agent.simulator --server http://localhost:4000 --token nxl_… --count 5
```

From the repo root, `npm run demo` does the same without needing a token. Simulated devices use
the same protocol, are labelled **SIM**, and get addresses from `10.50.0.200` upward.
Faults (latency, loss, CPU, traffic, memory) can be injected from each device's page.

## Build the exe

`python build_agent.py` produces `dist/NexLinkAgent.exe`.

## Modules

| File | Role |
|---|---|
| `agent.py` | Control loop: enroll/authenticate, telemetry timers, PING/PONG, commands, reconnect with backoff |
| `backend_real.py` | psutil metrics, connections/ports/protocols, ICMP bursts, diagnostics, mss screen, pynput input, files, terminal |
| `backend_sim.py` | Simulated equivalent with fault injection |
| `session.py` | Remote session side: screen stream, input, file transfer (SHA-256), terminal |
| `wireguard.py` | Local key generation, tunnel install when WireGuard + admin rights are present |
| `config.py` | Identity storage (DPAPI-encrypted secrets) |
| `enroll_ui.py` | First-run enrollment window |
| `banner.py` | Always-on-top session banner |
