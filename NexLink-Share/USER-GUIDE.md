# NexLink user guide

## Two portals

| | Admin console | User portal |
|---|---|---|
| Sees | Every device, user, session, alert and the audit log | Only devices assigned to them |
| Remote sessions | Start immediately | Wait for an admin's approval (by default) |
| Terminal | Safe allowlist, or a **full shell** after confirming | Safe allowlist only |
| Files | Whole disk | The device's *NexLink Shared* folder |
| Manages | Users, devices, VPN, alerts, reports, settings | Their own profile |

## Admin console

- **Overview**:
  - greeting, health status and live KPIs (devices online, throughput, latency, alerts, sessions);
  - live network topology;
  - a **Needs attention** list (pending devices, pending users, session requests, alerts);
  - control-channel RTT and the recent audit activity.
- **Network Map**: full-screen topology. Click a node for its details. Filter to *Problems*.
- **Devices**:
  - **Enroll a device** creates a one-time token and an enrollment code;
  - **Pending approval** lists requests to approve or reject;
  - click a device for its page: gauges, 15 min – 24 h history charts, processes, connections, listening ports and interfaces.
  - From a device page you can open remote desktop, files, terminal or diagnostics, **assign users** (👥), rename or remove it, and (simulated devices only) **Simulate a fault**.
- **Connections**: every tunnel (mode, handshake, latency, loss, transfer) and every live session. **Terminate** ends one.
- **VPN**: hub status, peers, and the steps and **Write hub config** button for real WireGuard.
- **Remote Desktop / File Manager / Terminal**: pick a device, then Connect. The device shows a banner.
- **Sessions**: **Requests** from users (Approve / Deny), active sessions (End), and the full history.
- **System Monitor**: live gauges for every device, sortable by CPU, memory or network.
- **Network Analysis**: protocol distribution, top remote hosts, listening ports (risky services highlighted) and per-device counts.
- **Traffic**: throughput charts for 15 min – 7 days, plus top talkers.
- **Alerts**: high CPU/RAM/disk, high latency, packet loss, offline and anomaly alerts. Acknowledge or resolve them. They also clear themselves when the condition ends.
- **AI Assistant**: ask in plain language ("Why is LAB-PC-02 slow?"). Answers come only from NexLink data. Suggested actions appear as buttons, and nothing runs by itself.
- **Diagnostics**: run ping, traceroute, DNS, TCP port and path-MTU tests *from* a device. ICMP latency is compared with the app-level RTT.
- **Reports**: daily or weekly health reports with an AI-written summary. **Print / Save as PDF**.
- **Users**:
  - approve pending accounts as user or admin;
  - change roles, disable or re-enable, reset passwords, delete.
- **Audit Logs**: append-only record of every privileged action, filterable, live.
- **Settings**:
  - Share NexLink (the address for others);
  - Google sign-in, the Groq key and model, access policies and alert thresholds;
  - your profile and theme (Cream / Deep teal).

## User portal

- **My Devices**: cards for your devices, with quick buttons for Desktop, Files, Terminal and Diagnose.
- **Request access**:
  - give a reason, then click Request;
  - the page connects automatically once an admin approves;
  - **My Sessions** shows every request, and approved ones can be opened from there.
- **Alerts** on your devices, **Diagnostics**, **AI Assistant** (scoped to your devices) and **Settings** (profile, password, theme).

## Keyboard

- **Ctrl K**: search pages and devices by name or IP.
- In the terminal: **↑ / ↓** for history, **Ctrl L** to clear.
- In remote desktop: click the screen first, then type.
