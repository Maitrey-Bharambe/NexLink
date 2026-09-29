# Architecture

```
┌──────────────── NexLink app (Electron) ────────────────┐        ┌──────── Managed PC ────────┐
│ React console / user portal (sandboxed renderer)        │        │ NexLinkAgent.exe (Python)   │
│ Electron main: settings, OS-encrypted session token,    │        │  metrics · network · procs  │
│   Google loopback (127.0.0.1), host mode (spawns server)│        │  ICMP bursts · diagnostics  │
└────────┬───────────────────────────────┬────────────────┘        │  screen · input · files ·   │
         │ REST /api/*                   │ WS /ws/console           │  terminal · banner          │
         │                               │ WS /ws/session (relay)   └──────┬───────────┬─────────┘
┌────────▼───────────────────────────────▼────────────────┐    WS /ws/agent │  WS /ws/agent-session
│ Control server (Node, Express, ws, Mongoose)             │◀───────────────┘           │
│  auth (password, Google) · users/roles · devices ·       │◀───────────────────────────┘
│  enrollment · telemetry · alerts engine · sessions relay │
│  WireGuard hub manager · anomaly scheduler · AI assistant│──▶ AI engine (FastAPI, Isolation Forest, 127.0.0.1:8000)
│  reports · audit (append-only)                           │──▶ Groq API (optional, tool calling)
└────────┬─────────────────────────────────────────────────┘
         ▼
     MongoDB: users, sessions, devices, metrics (7-day TTL), alerts, remote sessions,
              enrollment tokens (hashed), settings (secrets AES-256-GCM), reports, audit log
```

## Channels

| Channel | Auth | Purpose |
|---|---|---|
| `REST /api/*` | Bearer JWT (bound to a revocable server session) | CRUD, approvals, queries |
| `/ws/console` | JWT in the first frame (never in the URL) | Snapshots (scoped per user), live events, PING/PONG RTT |
| `/ws/agent` | Enrollment token → device secret (sha256 stored) | Register, approval push, telemetry, PING/PONG, commands |
| `/ws/session` + `/ws/agent-session` | JWT + single-use 60 s session token / device secret | Remote desktop, files, terminal relay |

## Remote session flow

```
console ──POST /api/sessions──▶ requested ──admin approves──▶ approved
console ──POST …/connect──▶ single-use token; server ─SESSION_START─▶ agent (policy: fullShell, fileRoot)
console ─/ws/session─▶ hub ◀─/ws/agent-session─ agent   → SESSION_READY to both → active
frames relayed; COMMAND_REQUEST checked against the allowlist (server + agent); file ops audited
either side / admin ends → ended (audited with stats)
```

## Data scoping

`deviceScope(user)` returns `{}` for admins and `{ assignedUsers: user._id }` for users. It is
applied to device lists and details, metrics, diagnostics, sessions, alerts, traffic, analysis,
console snapshots and every AI tool.

## Monitoring pipeline

`METRIC_UPDATE` (5 s) → `Device.latest` + `Metric` sample. Each sample then feeds:

- the rules engine, which requires a sustained breach and auto-resolves;
- the console snapshot, broadcast at most once per second.

Every 60 s, the anomaly scheduler sends each online device's recent history to Isolation Forest
(or the z-score fallback), stores the severity, and raises or resolves an anomaly alert.
