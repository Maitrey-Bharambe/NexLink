# Installing and sharing NexLink

A NexLink network has **one hub** and any number of **consoles** and **agents**:

```
   Admin / user PCs                     Hub PC                          Managed PCs
 ┌──────────────────┐   HTTP/WS :4000  ┌──────────────────────────┐    ┌───────────────────┐
 │ NexLink app      │ ───────────────▶ │ NexLink app (host mode)  │ ◀──│ NexLinkAgent.exe  │
 │ (console/portal) │                  │  • control server :4000  │    │ metrics, tunnel,  │
 └──────────────────┘                  │  • MongoDB :27017        │    │ remote access     │
                                       │  • WireGuard hub 10.50.0.1│    └───────────────────┘
                                       └──────────────────────────┘
```

## 1. Set up the hub (once)

1. Install **MongoDB Community Server** (default options, "Install as a Service"):
   https://www.mongodb.com/try/download/community
2. Run **`NexLink-Setup-1.0.0.exe`** and open NexLink.
3. On the first screen choose **Start the server on this PC**.
4. Create the **administrator** account (or use Google, see §4). There are no default passwords.
5. Allow other PCs to reach the hub: Windows Security → Firewall → *Allow an app* → allow
   **NexLink** on **Private** networks (or allow inbound TCP **4000**).
6. Open **Settings → Share NexLink**. It shows the **server address** to give people, for example
   `http://192.168.0.105:4000`.

The hub keeps its data in `%APPDATA%\NEXUS RMC\server-data` (keys, JWT secret) and in MongoDB
(`nexus_rmc`). NexLink restarts the server automatically whenever the app is opened.

## 2. Give access to people (admins and users)

1. They install `NexLink-Setup-1.0.0.exe`.
2. On first launch they enter the **server address** and click **Connect**.
3. They either
   - **Create account** with name, email and password, or
   - **Continue with Google**.

   The account then waits under **Users → Pending approval**.
4. You approve each person **as user** or **as admin**.
   - **Users** get a separate portal. They see only the devices you assign to them: open the
     device, then the 👥 button.
   - Their remote sessions wait for your approval (Sessions page). You can change this in
     Settings → Sign-in & access policy.

You can also create accounts directly: Users → Add user.

## 3. Add PCs to manage

1. In NexLink: **Devices → Enroll a device → Create token**.
2. On the PC to manage, open the download link shown there
   (`http://<hub>:4000/downloads/NexLinkAgent.exe`) and run **NexLinkAgent.exe**.
3. Paste the **enrollment code** into the window and click **Enroll**.
4. Back in NexLink, approve the device under **Devices → Pending approval**. It gets a virtual IP
   (`10.50.0.x`).

The agent is visible by design: its console window stays open, and a banner appears at the top of
the screen during any remote session, with a **Disconnect** button for the local user.
To run it again later, start `NexLinkAgent.exe` (no code needed).
To remove the device's identity, run `NexLinkAgent.exe reset`.

## 4. Google sign-in (optional)

1. https://console.cloud.google.com → create a project.
2. **APIs & Services → OAuth consent screen**:
   - User type *External*.
   - Add your app name and email.
   - While in "Testing", add the Google accounts that may sign in as test users.
3. **Credentials → Create credentials → OAuth client ID → Application type: Desktop app.**
4. In NexLink: **Settings → Sign-in & access policy**. Paste the **Client ID** and **Client secret**, then click Save.

That's all. No redirect URI is needed: each NexLink app receives Google's answer on
`127.0.0.1` (RFC 8252), and the hub verifies the ID token. New Google accounts become pending
users, except the very first account on a fresh hub, which becomes the admin.

## 5. AI assistant with Groq (optional)

1. Create a key at https://console.groq.com/keys.
2. In NexLink: **Settings → AI assistant (Groq)**. Paste the key (it is stored encrypted) and click Save.

The default model is `llama-3.3-70b-versatile`. Without a key the assistant still works in offline mode.

For better anomaly detection, run the AI engine on the hub:

```bash
pip install -r apps/ai-engine/requirements.txt
```

```bash
python -m uvicorn engine:app --host 127.0.0.1 --port 8000
```

Run the second command from the `apps/ai-engine` folder; the dev launcher starts it automatically.
Without the engine, the server uses a robust z-score detector and labels it as such.

## 6. Real WireGuard tunnels (optional)

Everything works in **simulated tunnel** mode. For real encrypted tunnels:

1. Install WireGuard on the hub and on each managed PC: https://www.wireguard.com/install/
2. In NexLink: **VPN → Write hub config**. Then run the shown commands **as Administrator**:
   - one installs the tunnel service;
   - one enables IP routing (reboot afterwards).
3. Click **Re-detect**. The hub switches to **WireGuard active**.
4. Run `NexLinkAgent.exe` once **as Administrator** on each managed PC. It installs its own
   tunnel using its locally generated private key.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Control server unreachable" | Check the address, and that the hub PC is on with NexLink open. Also check the firewall on port 4000. |
| Host mode says MongoDB not found | Install MongoDB Community Server and make sure the *MongoDB* service is running (`services.msc`). |
| Pending user can't sign in | Approve them under Users → Pending approval. |
| Google button disabled | Add the Client ID and secret in Settings (§4). |
| Device stuck in Pending | Approve it under Devices → Pending approval. |
| Remote desktop is black on a managed PC | The agent must run in the logged-in user's desktop session, not as a service. |
| Logs | `%APPDATA%\NEXUS RMC\logs\server.log` (hub). The dev launcher writes to `%LOCALAPPDATA%\NEXUS-RMC\logs`. |
