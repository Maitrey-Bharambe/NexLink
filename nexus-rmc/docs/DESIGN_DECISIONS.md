# NexLink (formerly NEXUS RMC) — Design Decisions

The master prompt says *what* to build. This file records the decisions it left
open, so every phase builds toward the same architecture. Each entry: the
problem, the decision, and why.

---

## D1. Topology: hub-and-spoke WireGuard

**Problem.** The prompt says "device-to-device communication" but every diagram is a star.
A full mesh (every peer knows every other peer) is much harder to build, debug and explain.

**Decision.** The admin/server machine is the **WireGuard hub** at `10.50.0.1`.
Every agent has exactly one peer: the hub, with `AllowedIPs = 10.50.0.0/24`.
The hub has IP forwarding enabled, so PC-02 → PC-03 traffic is routed *through* the hub.

**Why.** It is simple, and it demonstrates **routing** as well as tunneling. In the viva you
can trace a packet from PC-02 through the tunnel to the hub's routing table and out to PC-03.

| Node   | Virtual IP        | Role                         |
|--------|-------------------|------------------------------|
| ADMIN  | 10.50.0.1         | Hub, control server, console |
| Agents | 10.50.0.2 – .0.199 | Allocated on approval        |
| SIM    | 10.50.0.200 – .0.254 | Simulated devices (D9)     |

Hub OS: Linux is simplest (`sysctl net.ipv4.ip_forward=1`). A Windows hub also works but
needs `IPEnableRouter=1` in the registry and a reboot. SETUP.md covers both.

## D2. Keys and enrollment

**Problem.** Who generates WireGuard keys, and how does a new device get trusted?

**Decision.**
1. The admin creates a **one-time enrollment token** in the console (single use, 15-minute expiry).
2. The agent generates its **own keypair locally**. The private key never leaves the machine.
3. The agent sends `DEVICE_REGISTER {hostname, os, publicKey, enrollmentToken}` to the server over the LAN.
4. The admin **approves** the device. The server allocates a virtual IP, adds the peer to the hub
   (`wg set wg-nexus peer <pub> allowed-ips 10.50.0.x/32`), and returns
   `DEVICE_APPROVED {virtualIp, hubPublicKey, hubEndpoint, deviceSecret}`.
5. The agent brings up its tunnel. From then on **all control traffic runs over the VPN**
   (`ws://10.50.0.1:4000/ws/agent`), authenticated with its device secret.

Installing a tunnel on Windows (`wireguard.exe /installtunnelservice`) needs administrator
rights, so the agent's **first run must be elevated**. It says so clearly on screen.

## D3. How latency and packet loss are measured

Three independent measurements. Comparing them is itself a good viva point.

| Metric | Method | Layer |
|---|---|---|
| ICMP RTT / loss | Agent runs a burst of 10 `ping`s to `10.50.0.1` every 30 s (parses the OS `ping` output, so no raw sockets or admin rights) | Network (L3), through the tunnel |
| App RTT | Server sends `PING{seq, t0}`, agent echoes `PONG`, server computes `now − t0` with its own clock (no clock-skew problems) | Application (L7) over TCP |
| Tunnel health | `wg show wg-nexus dump` on the hub: latest handshake age, rx/tx bytes per peer | VPN |

Packet loss = lost ICMP replies / sent, and missing `seq` numbers in the PING stream.
Throughput = delta of rx/tx bytes per interval.

## D4. Remote desktop, files and terminal are relayed through the hub

**Problem.** Direct console→agent connections need an inbound port on every managed PC and break
on simulated devices, NAT and firewalls.

**Decision (revised during Phase 4).** The hub relays sessions. Because the hub is also the
WireGuard gateway, agent traffic still crosses the encrypted tunnel when WireGuard is active.
1. Console → server: `POST /api/sessions {deviceId, kind}`. The server checks scope, role and
   policy; users' requests wait for admin approval (D13).
2. `POST /api/sessions/:id/connect` issues a **single-use, 60-second** session token and sends
   `SESSION_START {policy}` to the agent over its control channel.
3. The console connects to `/ws/session` (JWT + session token). The agent connects to
   `/ws/agent-session` (device secret). The hub pairs them and relays frames.
4. Binary frames: `1` = JPEG screen frame (`mss` + Pillow, adaptive quality), `2` = file chunk
   (256 KB, SHA-256 verified at the end). Input goes back as `REMOTE_INPUT`.
5. Policy is enforced on **both** the hub (allowlist check, audit) and the agent (fileRoot,
   fullShell). No agent listens on any port.

## D5. Terminal scope

- **Allowlist mode (default, Operator role):** `ipconfig/ifconfig, ping, tracert/traceroute,
  netstat, nslookup, arp, route print, tasklist/ps, systeminfo, whoami, hostname, dir/ls`.
  The command is parsed and validated on **both** server and agent.
- **Full shell (Admin only):** needs explicit confirmation for each session and shows a red banner on the agent.

Every command, with its exit code and output size, is audited in both modes.

## D6. Traffic and protocol analysis

The agent uses `psutil.net_io_counters(pernic=True)` and `psutil.net_connections()`. Protocol
distribution = TCP/UDP split plus well-known port mapping (443→HTTPS, 53→DNS, 51820→WireGuard…).
There is **no packet capture** by default, so no Npcap/admin requirement. Optional Scapy capture
is a later extension.

## D7. AI wiring

- **ML (Python, `apps/ai-engine`)**: FastAPI on `127.0.0.1:8000`. IsolationForest per device,
  trained on a rolling window of that device's own history (the baseline), and returns
  `{score, severity, contributingFeatures}`. Bound to localhost only.
- **LLM orchestration (Node, in the server)**: the tool functions (`getDevices()`…) are Node
  functions over Mongo, so the LLM only ever sees tool outputs and never a DB connection.
- **Provider**: pluggable. It can use a hosted API with a key, or **Ollama** locally.
- **Offline fallback**: if no LLM is reachable, a deterministic template builds the
  Diagnosis / Evidence / Possible causes / Recommended tests answer from the same tool output.
  The demo therefore works without internet access in the lab.
- Any action the AI suggests is only a button. Clicking it goes through the normal approval
  flow and is audited with `approval: "AI-suggested, admin-approved"`.

## D8. Roles and audit exist from Phase 1

Roles: `admin`, `operator`, `viewer`. Audit logging starts in Phase 1 (setup, logins, failed
logins) and covers every privileged action as soon as it exists. It is not deferred to a
"security phase."

There are **no default credentials.** On first launch, the console shows a one-time
*Create administrator* screen. It works only while the users collection is empty.

## D9. Simulator (demo mode)

A lab may have only 2–3 real machines. `apps/simulator` launches N virtual agents that speak
the **exact same protocol** over the same WebSocket. They are flagged `simulated: true`, use the
`.200+` range, and the UI shows a **SIM** badge on them. Faults (latency spike, packet loss,
CPU burn) can be injected on command, so the anomaly scenario in the demo is reproducible.
This meets the quality bar: labeled, not fake.

## D10. Agent transparency

The agent shows a tray icon at all times. While a remote session is active, it shows an
always-on-top banner: **"NEXUS remote session active — ADMIN (10.50.0.1)"** with a
*Disconnect* button that the local user can press. There is no hidden persistence.

## D11. Process layout & ports

| Process | Port | Binds to |
|---|---|---|
| Control server (HTTP + WS) | 4000 | `0.0.0.0` (LAN for enrollment, VPN for agents) |
| Agent session endpoint | 4100 | agent's VPN IP only |
| AI engine | 8000 | `127.0.0.1` only |
| WireGuard | 51820/udp | hub |
| MongoDB | 27017 | `127.0.0.1` only |

The desktop app talks to the server over HTTP/WS. Phase 8 packaging can spawn the server as a
child process of Electron on the admin machine, so it launches as a single `NEXUS-RMC.exe`.

## D12. Protocol envelope

Every WebSocket message uses the envelope defined in `packages/protocol`:
`{version, messageId, type, deviceId, sessionId, timestamp, payload}`. Messages are validated
on receipt, and anything unknown or malformed is answered with `ERROR` and dropped. Binary
frames (screen and file chunks) use a small header plus the payload.

## D13. Two roles, separate portals, approvals everywhere

- `admin`: full console. `user`: own portal, only devices listed in `Device.assignedUsers`.
- Self-registration (email or Google) creates `status: pending` accounts; an admin approves as
  user or admin. The first account on a fresh install becomes the admin.
- Users' remote sessions need admin approval (setting). Admin full shell needs an explicit toggle
  per session and shows a red banner on the device. AI-suggested actions are buttons that go
  through the same flows.

## D14. Google sign-in for a desktop app (RFC 8252)

The app listens once on `127.0.0.1:<random port>` for Google's redirect (PKCE + `state`), then
posts the code to the hub, which exchanges it with the verifier it kept and verifies the ID token
(signature, audience, expiry, `email_verified`). A *Desktop app* OAuth client therefore works from
every PC on the network, with no redirect URIs to register. Client ID and secret can be set in
Settings (secret stored AES-256-GCM encrypted).

## D15. Packaging

- `NexLink-Setup-x.y.z.exe` (electron-builder NSIS) contains the console **and** the server
  (staged with production dependencies). In **host mode** the app runs the server as a hidden
  child process on Electron's own Node runtime (`ELECTRON_RUN_AS_NODE`), so the hub only needs
  MongoDB installed.
- `NexLinkAgent.exe` (PyInstaller, one file) is bundled with the installer and served by the hub at
  `/downloads/NexLinkAgent.exe`. The console shows a single **enrollment code**
  (`NXL1.` + base64url of `{server, token}`) that the agent's first-run window accepts.
- The hub advertises its LAN address (private ranges preferred, virtual adapters skipped), or
  `PUBLIC_URL` when set.
