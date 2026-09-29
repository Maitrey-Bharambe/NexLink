# 10-minute demo script

Everything below works on **one laptop** using simulated devices (clearly labelled **SIM**).
Add one real PC with `NexLinkAgent.exe` to show a real screen and a real terminal.

## Before the demo

1. Open **NexLink** from the desktop shortcut and sign in as the admin.
2. Double-click **NexLink Demo Devices** on the desktop, or run `npm run demo`. Five simulated PCs start.
   - The first time, they appear under **Devices → Pending approval**. Leave them there so you can approve them live.
   - Later runs reuse their identities.
3. Optional: create a user account (Users → Add user, role *User*) and assign it one device. You can then show the user portal.

## Script

| # | Show | Say |
|---|---|---|
| 1 | Sign-in screen | "No default passwords. Email + password or Google. New accounts wait for an admin. Every action is audited." |
| 2 | **Devices → Pending approval** → Approve | "Each agent generates its own WireGuard keys and sends only the public key with a one-time token. Approval assigns a virtual IP in 10.50.0.0/24." |
| 3 | **Overview** | "Live topology from the server, no mock data. Hub-and-spoke: the admin PC is the WireGuard hub at 10.50.0.1." |
| 4 | Click a device | "CPU, memory, disk, traffic every 5 s; ICMP latency and loss through the tunnel every 30 s; processes and connections every 15 s." |
| 5 | **Simulate a fault → Packet loss** | Within ~30 s: the topology edge turns gold and an **Alert** toast appears. "Rules need a sustained breach, then alert; they auto-resolve." |
| 6 | **AI Assistant**: "Why is LAB-PC-02 slow?" | "The model only sees tool outputs from our database, scoped to the user. It suggests actions as buttons; nothing runs without approval." |
| 7 | Wait for the anomaly model (~1–2 min after a CPU burn or traffic burst) | "Per-device Isolation Forest trained on that device's own history. There is a z-score fallback if the Python engine is off." |
| 8 | **Remote Desktop** → Connect | "Frames go through the hub relay; the hub is also the VPN gateway. The device shows a banner with Disconnect." |
| 9 | **Terminal** → `ipconfig`, then `del x` | "Users get an allowlist enforced on the server *and* the agent; chaining and redirection are blocked. Admin full shell needs explicit confirmation." |
| 10 | Sign in as the user (second window, or sign out and in) | "Separate portal: only assigned devices. Requesting a terminal needs a reason…" |
| 11 | Back as admin → **Sessions → Approve** | "…the user's page connects automatically once approved." |
| 12 | **Diagnostics** → ping, traceroute, MTU | "Tests run *from* the device. Compare ICMP (L3) with the app RTT (L7)." |
| 13 | **Reports → Daily report** | "Availability, alerts, sessions, anomalies, with a summary written by the AI when a Groq key is set. Print to PDF." |
| 14 | **Audit Logs** | "Append-only: every login, approval, command, file transfer and AI question." |

## Useful facts

- **Protocol:** one JSON envelope `{version, messageId, type, deviceId, sessionId, timestamp, payload}`.
  - Binary frames carry screen JPEGs and file chunks.
- **Measurements:**
  - app RTT = server PING/PONG on the server's own clock, so no clock-skew problems;
  - ICMP = 10-ping bursts;
  - loss = lost replies / sent.
- **Files:** 256 KB chunks with SHA-256 verified end to end.
- **Security:**
  - bcrypt passwords;
  - JWTs bound to revocable server sessions;
  - lockout after 5 failures;
  - single-use 60 s session tokens;
  - device secrets and Groq/Google secrets stored hashed or encrypted;
  - Electron sandbox + context isolation + CSP.
- **Tests:** `npm test` runs 31 automated tests; `npm run e2e` runs 31 end-to-end checks with real simulated agents.
