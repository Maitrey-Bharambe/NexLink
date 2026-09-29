<div align="center">

<img src="docs/brand/nexlink-banner.svg" alt="NexLink — secure remote access and network management" width="100%" />

<br />

**Connect a private group of machines into one encrypted network, monitor them live, and give approved people remote access — with every action audited.**

<br />

![Version](https://img.shields.io/badge/version-1.0.0-09C4B1?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-033A41?style=flat-square&logo=windows&logoColor=white)
![Tests](https://img.shields.io/badge/tests-31%20passing-09C4B1?style=flat-square)
![E2E](https://img.shields.io/badge/e2e-31%20checks-09C4B1?style=flat-square)
![Phases](https://img.shields.io/badge/phases-8%2F8%20complete-DDAA6B?style=flat-square)

![Electron](https://img.shields.io/badge/Electron-33-47848F?style=flat-square&logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)
![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-7+-47A248?style=flat-square&logo=mongodb&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&logo=python&logoColor=white)
![WireGuard](https://img.shields.io/badge/WireGuard-hub%20%26%20spoke-88171A?style=flat-square&logo=wireguard&logoColor=white)
![scikit-learn](https://img.shields.io/badge/scikit--learn-Isolation%20Forest-F7931E?style=flat-square&logo=scikitlearn&logoColor=white)

[Features](#-features) ·
[Architecture](#-architecture) ·
[Quick start](#-quick-start) ·
[Deploy & share](#-deploy--share) ·
[Security](#-security-model) ·
[API](#-api-reference) ·
[Docs](#-documentation)

</div>

---

## 📖 Overview

NexLink is a desktop platform for **remote access and network management** of a group of
Windows PCs, such as a lab, an office or a small team. It has three parts:

| | Component | Runs on | Role |
|:-:|---|---|---|
| 🖥️ | **NexLink app** (Electron + React) | Admins' and users' PCs | Admin console *or* user portal. On one PC it can also **host the server**. |
| 🛰️ | **Control server** (Node + MongoDB) | The hub PC | Accounts, devices, telemetry, sessions, alerts, AI. Also the **WireGuard hub** (`10.50.0.1`). |
| 🧩 | **NexLink Agent** (`NexLinkAgent.exe`, Python) | Every managed PC | Enrolls with a one-time code, reports metrics and serves remote sessions. It is **visible by design**. |

> [!NOTE]
> Nothing in the UI is mocked. Demo devices come from a **simulator** that speaks the exact same
> protocol and is clearly labelled **SIM**, so the whole system can be shown on a single laptop.

---

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 🌐 Network & VPN
- Hub-and-spoke **WireGuard** network (`10.50.0.0/24`)
- Keys generated on each device; **private keys never leave it**
- Live **topology map**, tunnel handshakes and transfer
- ICMP **latency and loss** bursts plus **app-level RTT**
- Honest **simulated mode** when WireGuard isn't installed

### 🖱️ Remote administration
- **Remote desktop**: JPEG stream, mouse and keyboard, adaptive quality
- **File manager**: chunked transfers, **SHA-256 verified**
- **Terminal**: safe allowlist for users, confirmed **full shell** for admins
- On-device **banner with Disconnect** during every session

</td>
<td width="50%" valign="top">

### 📊 Monitoring & analysis
- CPU / RAM / disk / network every **5 s**, processes and connections every **15 s**
- **Traffic** history (15 min – 7 days) and top talkers
- Protocol distribution, remote hosts, **risky open ports**
- **Alerts** with sustained-breach rules, acknowledge / resolve / auto-resolve

### 🤖 Intelligence
- Per-device **Isolation Forest** anomaly detection (with a z-score fallback)
- **AI assistant** (Groq tool calling), scoped to what each user may see
- Offline, rule-based diagnosis when no API key is set
- Daily / weekly **health reports** with an AI summary, printable to PDF

</td>
</tr>
<tr>
<td valign="top">

### 🔐 Access control
- **Admin** and **User** roles with **separate portals**
- Email + password **and Google sign-in** (RFC 8252 loopback)
- Self-registration → **admin approval**
- Users see **only assigned devices**; their sessions need approval

</td>
<td valign="top">

### 📦 Distribution
- One **Windows installer** containing the console *and* the server (host mode)
- **Standalone agent `.exe`**, served by the hub for download
- Single **enrollment code** (server address + token) to paste
- Appearance: **Cream** or **Deep teal** theme

</td>
</tr>
</table>

---

## 🏗️ Architecture

```mermaid
flowchart LR
    subgraph Clients["🖥️ NexLink app (Electron)"]
        A1["Admin console"]
        A2["User portal"]
    end

    subgraph Hub["🛰️ Hub PC"]
        S["Control server<br/>Node · Express · ws"]
        DB[("MongoDB")]
        WG{{"WireGuard hub<br/>10.50.0.1"}}
        AI["AI engine<br/>FastAPI · Isolation Forest"]
    end

    subgraph Devices["🧩 Managed PCs"]
        D1["NexLinkAgent.exe<br/>10.50.0.2"]
        D2["NexLinkAgent.exe<br/>10.50.0.3"]
        D3["Simulator (SIM)<br/>10.50.0.200+"]
    end

    A1 -- "REST + /ws/console" --> S
    A2 -- "REST + /ws/console" --> S
    A1 <-. "/ws/session (relay)" .-> S
    S --- DB
    S --- WG
    S -- "anomaly scoring" --> AI
    S -. "optional" .-> G["☁️ Groq API"]
    D1 -- "/ws/agent" --> S
    D2 -- "/ws/agent" --> S
    D3 -- "/ws/agent" --> S
    WG <== "encrypted tunnels" ==> D1
    WG <== "encrypted tunnels" ==> D2

    classDef hub fill:#033A41,stroke:#09C4B1,color:#F6E7D0
    classDef dev fill:#FCF6EC,stroke:#B39C7D,color:#033A41
    class S,WG,AI,DB hub
    class D1,D2,D3 dev
```

### Communication channels

| Channel | Authentication | Carries |
|---|---|---|
| `REST /api/*` | Bearer JWT, bound to a revocable server-side session | CRUD, approvals, queries |
| `WS /ws/console` | JWT in the **first frame** (never in the URL) | Per-user snapshots, live events, PING/PONG RTT |
| `WS /ws/agent` | Enrollment token → device secret (stored as SHA-256) | Registration, telemetry, commands, PING/PONG |
| `WS /ws/session` ⇄ `/ws/agent-session` | JWT + **single-use 60 s** session token / device secret | Desktop frames, input, files, terminal |

Every text frame uses one envelope:
`{ version, messageId, type, deviceId, sessionId, timestamp, payload }`.
Binary frames carry screen JPEGs (`0x01`) and file chunks (`0x02`).

### Device enrollment

```mermaid
sequenceDiagram
    autonumber
    actor Admin
    participant App as NexLink app
    participant Srv as Control server
    participant Agent as NexLinkAgent.exe

    Admin->>App: Devices → Enroll a device
    App->>Srv: POST /api/devices/enrollment/tokens
    Srv-->>App: one-time token + enrollment code (NXL1.…)
    Admin->>Agent: paste enrollment code
    Note over Agent: generates its own WireGuard keypair
    Agent->>Srv: DEVICE_REGISTER {hostname, os, publicKey, token}
    Srv-->>Agent: DEVICE_PENDING {deviceId, deviceSecret}
    Srv-)App: live event — 1 device waiting
    Admin->>App: Approve
    App->>Srv: POST /api/devices/:id/approve
    Srv->>Srv: allocate 10.50.0.x · add WireGuard peer
    Srv-->>Agent: DEVICE_APPROVED {virtualIp, hub key, endpoint}
    loop every 5–30 s
        Agent->>Srv: METRIC_UPDATE · NETWORK_UPDATE · PROCESS_UPDATE
    end
```

### Remote session with approval

```mermaid
sequenceDiagram
    autonumber
    actor User
    actor Admin
    participant Srv as Control server (relay)
    participant Agent

    User->>Srv: POST /api/sessions {device, kind: terminal, reason}
    Srv-->>User: status = requested
    Srv-)Admin: live event — session request
    Admin->>Srv: POST /api/sessions/:id/approve
    Srv-)User: session.decided → approved
    User->>Srv: POST /api/sessions/:id/connect
    Srv-->>User: single-use session token (60 s)
    Srv->>Agent: SESSION_START {policy: allowlist, shared folder}
    User->>Srv: /ws/session (JWT + session token)
    Agent->>Srv: /ws/agent-session (device secret)
    Srv-->>User: SESSION_READY
    Note over Agent: shows an on-screen banner with Disconnect
    User->>Srv: COMMAND_REQUEST "ipconfig"
    Srv->>Srv: allowlist check + audit
    Srv->>Agent: relay
    Agent-->>User: COMMAND_RESPONSE
```

### Monitoring pipeline

```mermaid
flowchart LR
    M["METRIC_UPDATE<br/>(every 5 s)"] --> L["Device.latest"]
    M --> T[("Metric samples<br/>7-day TTL")]
    L --> R{"Rules engine<br/>sustained breach?"}
    R -- yes --> AL["🔔 Alert + toast"]
    R -- recovered --> AR["auto-resolve"]
    T --> IF["Isolation Forest<br/>(every 60 s, per device)"]
    IF --> AN["anomaly severity"] --> AL
    L --> SN["Console snapshot<br/>≤ 1 / s, scoped per user"]
```

---

## 👥 Roles

| Capability | 🛡️ Admin | 👤 User |
|---|:-:|:-:|
| See devices | All | Only assigned |
| Remote desktop / files / terminal | Immediately | After admin approval |
| Terminal mode | Allowlist or confirmed full shell | Allowlist only |
| File access | Whole disk | Device's *NexLink Shared* folder |
| Approve devices, users and sessions | ✅ | — |
| VPN, alerts, reports, audit log, settings | ✅ | — |
| AI assistant | All data | Own devices only |

---

## 🚀 Quick start

### Prerequisites

| Tool | Version | Used for |
|---|---|---|
| [Node.js](https://nodejs.org) | 20+ | Server, desktop app, tooling |
| [MongoDB Community](https://www.mongodb.com/try/download/community) | 7+ (runs as a service) | Data store |
| [Python](https://python.org) | 3.10+ | Agent, simulator, AI engine |
| [WireGuard](https://www.wireguard.com/install/) | optional | Real encrypted tunnels |

### Run from source

```bash
git clone <your-repo-url> nexlink && cd nexlink
```

```bash
npm install
```

```bash
pip install -r apps/agent/requirements.txt -r apps/ai-engine/requirements.txt
```

```bash
cp apps/server/.env.example apps/server/.env
```

```bash
npm run dev
```

`npm run dev` starts the server on `:4000` plus the desktop app with hot reload. On first launch,
create the administrator account; there are no default passwords.

### See it working in 2 minutes

```bash
npm run demo
```

This starts 5 simulated PCs. In the app, open **Devices → Pending approval** and approve them. On
any device page, **Simulate a fault → Packet loss** raises an alert in about 30 seconds.

### Useful scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server + desktop app with hot reload |
| `npm test` | 31 automated tests (protocol, auth/roles, Phases 2–7 with an in-process fake agent) |
| `npm run demo` | Start simulated devices against the local server |
| `npm run e2e` | 31 end-to-end checks against a running server with real simulated agents |
| `npm run ai-engine` | Isolation Forest service on `127.0.0.1:8000` |
| `npm run build:agent` | Build `apps/agent/dist/NexLinkAgent.exe` (PyInstaller) |
| `npm run dist` | Agent + `NexLink-Setup-1.0.0.exe` in `apps/desktop/release/` |

---

## 📦 Deploy & share

```mermaid
flowchart TB
    I["NexLink-Setup-1.0.0.exe"] --> H["🛰️ Hub PC<br/>install MongoDB → open NexLink →<br/><b>Start the server on this PC</b>"]
    I --> C["🖥️ Admin & user PCs<br/>open NexLink → enter hub address →<br/>register or Google → wait for approval"]
    H -- "serves /downloads/NexLinkAgent.exe" --> A["🧩 Managed PCs<br/>run NexLinkAgent.exe → paste enrollment code"]
    H -. "Settings → Share NexLink<br/>http://192.168.x.x:4000" .-> C
```

1. **Hub:** install MongoDB, then the NexLink installer. Choose **Start the server on this PC**.
   Allow NexLink through the Windows Firewall on private networks (TCP 4000).
2. **People:** install the NexLink app and enter the address from **Settings → Share NexLink**.
   Approve them as *user* or *admin* under **Users**.
3. **Devices:** in **Devices → Enroll a device**, send the download link and the enrollment code.
   Approve the device when it appears.

Optional integrations, all configurable in **Settings**:

| Integration | How |
|---|---|
| 🔑 Google sign-in | Google Cloud → OAuth client of type **Desktop app** → paste the client ID and secret. No redirect URIs needed. |
| 🤖 Groq AI | Paste an API key from [console.groq.com](https://console.groq.com/keys). It is stored encrypted. |
| 🔒 WireGuard | **VPN → Write hub config** → run the shown commands as Administrator → **Re-detect**. |

Full guide: **[docs/INSTALL.md](docs/INSTALL.md)**.

---

## 🔐 Security model

| Area | Measure |
|---|---|
| Passwords | bcrypt (12 rounds); policy of 10+ characters with letters and digits; lockout after 5 failures; rate-limited credential endpoints |
| Sessions | JWT bound to a server-side session, so logout, disable and role changes take effect instantly; stored with OS encryption (`safeStorage`) |
| Accounts | Self-registration and Google sign-ups start **pending**; no default credentials; first-run setup is race-safe |
| Google | PKCE + `state`; the ID token is verified (signature, audience, expiry, `email_verified`) on the server |
| Devices | One-time, expiring, hashed enrollment tokens; per-device secret stored as SHA-256; WireGuard private keys never leave the device; agent secrets DPAPI-encrypted |
| Remote access | Single-use 60 s session tokens; allowlist enforced on **server and agent**; shared-folder jail for users; visible banner with local Disconnect |
| Data scoping | `deviceScope(user)` applied to every device, metric, alert, session, traffic, analysis and AI query |
| Secrets at rest | Groq key and Google client secret encrypted with AES-256-GCM |
| Audit | Append-only collection: logins, approvals, commands, file transfers, AI questions, settings changes |
| Desktop shell | `contextIsolation`, `sandbox`, no `nodeIntegration`, validated IPC with a trusted-sender check, CSP, blocked navigation |

---

## 🔌 API reference

<details>
<summary><b>REST endpoints</b> (click to expand)</summary>

| Method | Path | Access |
|---|---|---|
| `GET` | `/api/health` | public |
| `GET` | `/api/auth/status` | public |
| `POST` | `/api/auth/setup` · `/login` · `/register` | public, rate-limited |
| `POST` | `/api/auth/google/start` · `/google/exchange` | public, rate-limited |
| `GET` `PATCH` | `/api/auth/me` | signed in |
| `POST` | `/api/auth/logout` | signed in |
| `GET` `POST` `PATCH` `DELETE` | `/api/users[/:id]` | admin |
| `GET` | `/api/devices` · `/api/devices/:id` · `/:id/metrics` | scoped |
| `POST` | `/api/devices/:id/approve` · `/reject` · `/sim-fault` | admin |
| `PATCH` `DELETE` | `/api/devices/:id` | admin |
| `POST` | `/api/devices/:id/diagnostics` | scoped |
| `GET` `POST` `DELETE` | `/api/devices/enrollment/tokens[/:id]` | admin |
| `GET` `POST` | `/api/sessions` · `/:id/connect` · `/:id/end` | scoped |
| `POST` | `/api/sessions/:id/approve` · `/deny` | admin |
| `GET` | `/api/alerts` | scoped |
| `POST` | `/api/alerts/:id/ack` · `/resolve` · `/ack-all` | admin |
| `GET` | `/api/network` · `/api/vpn` · `/api/traffic` · `/api/analysis` | scoped |
| `POST` | `/api/vpn/refresh` · `/api/vpn/hub-config` | admin |
| `GET` `POST` | `/api/ai/status` · `/api/ai/chat` | signed in, rate-limited |
| `GET` `POST` `DELETE` | `/api/reports[/:id]` | admin |
| `GET` `PATCH` | `/api/settings` | admin |
| `GET` | `/api/audit` | admin |
| `GET` | `/downloads/NexLinkAgent.exe` | public |

</details>

<details>
<summary><b>Protocol message types</b></summary>

| Group | Types |
|---|---|
| Auth & enrollment | `AUTH_REQUEST` `AUTH_RESPONSE` `DEVICE_REGISTER` `DEVICE_PENDING` `DEVICE_APPROVED` `DEVICE_REJECTED` |
| Telemetry | `HEARTBEAT` `METRIC_UPDATE` `NETWORK_UPDATE` `PROCESS_UPDATE` |
| Measurement | `PING` `PONG` |
| Sessions | `SESSION_START` `SESSION_READY` `SESSION_END` `SESSION_STATS` `REMOTE_INPUT` `FILE_REQUEST` `FILE_RESPONSE` `COMMAND_REQUEST` `COMMAND_RESPONSE` |
| Console push | `STATE_SNAPSHOT` `EVENT` `ERROR` |

</details>

---

## 🗂️ Project structure

```text
nexus-rmc/
├── packages/
│   └── protocol/            # Shared envelope, message types, terminal allowlist, port map (+ tests)
├── apps/
│   ├── server/              # Express + ws + Mongoose control server
│   │   ├── src/
│   │   │   ├── routes/      # auth, users, devices, sessions, alerts, network, intel (AI, reports, settings)
│   │   │   ├── websocket/   # consoleHub, agentHub, sessionHub (relay)
│   │   │   ├── services/    # wireguard, alerts, anomaly, ai, sessions, google, settings, audit
│   │   │   └── models/      # User, Device, Telemetry (metrics, alerts, sessions, tokens, reports)
│   │   ├── scripts/         # demo, e2e-smoke, exe-smoke
│   │   └── test/            # phase1 + phases integration tests
│   ├── desktop/             # Electron main (host mode, Google loopback) + React/Vite/Tailwind UI
│   │   ├── electron/        # main.cjs, preload.cjs, hub.cjs
│   │   └── src/             # pages, components, stores, services, design tokens
│   ├── agent/               # Python agent + simulator → NexLinkAgent.exe
│   └── ai-engine/           # FastAPI + scikit-learn Isolation Forest
├── docs/                    # install, user guide, demo script, architecture, design decisions, brand
└── launch-nexus.ps1         # one-click launcher (dev install)
```

---

## 🧪 Testing

```bash
npm test
```

This runs 4 protocol tests, 14 foundation tests (auth, roles, audit, WebSocket), and 13 tests for Phases 2–7:
- enrollment and approval, telemetry and alerts, device scoping, diagnostics;
- the session approval and relay, including a blocked command and single-use token replay;
- AI and reports, and the anomaly detector.

End to end, run the next two commands in separate terminals. The first starts a throwaway server:

```bash
PORT=4001 MONGODB_URI=mongodb://127.0.0.1:27017/nexlink_e2e node apps/server/src/index.js
```

```bash
node apps/server/scripts/e2e-smoke.mjs http://127.0.0.1:4001
```

The second runs 31 checks with 3 real simulated agents.

---

## 🎨 Design system

| Token | Colour | Use |
|---|---|---|
| Deep Teal | ![](https://img.shields.io/badge/%20-%23033A41-033A41?style=flat-square) | Structure, navigation, primary buttons |
| Aqua Teal | ![](https://img.shields.io/badge/%20-%2309C4B1-09C4B1?style=flat-square) | Interaction, online, connections, charts |
| Warm Cream | ![](https://img.shields.io/badge/%20-%23F6E7D0-F6E7D0?style=flat-square) | Main background |
| Warm Taupe | ![](https://img.shields.io/badge/%20-%23B39C7D-B39C7D?style=flat-square) | Neutral, borders, offline |
| Warm Gold | ![](https://img.shields.io/badge/%20-%23DDAA6B-DDAA6B?style=flat-square) | Warnings, latency, secondary emphasis |

All colours are centralised tokens in `apps/desktop/src/styles/index.css`, with Cream and Deep teal themes.

---

## 📚 Documentation

| Document | Contents |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Hub setup, sharing with users, enrolling devices, Google, Groq, WireGuard, troubleshooting |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Every screen of the admin console and the user portal |
| [docs/DEMO.md](docs/DEMO.md) | A 10-minute presentation script |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, channels, session flow, data scoping |
| [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) | Why things are built the way they are (D1–D15) |

---

## 🗺️ Roadmap

- [x] Foundation, agent, VPN, remote administration, network analysis, AI/ML, hardening, packaging
- [ ] Code-signed installers (removes the Windows SmartScreen prompt)
- [ ] macOS / Linux agent packages
- [ ] TLS on the hub (`https://` / `wss://`) with a bundled certificate helper
- [ ] Multi-monitor selection in remote desktop

---

<div align="center">
<img src="docs/brand/nexlink-mark.svg" width="40" alt="" /><br />
<sub><b>NexLink</b> · Secure infrastructure for connecting and managing remote devices</sub>
</div>
