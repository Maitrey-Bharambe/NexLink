import { Device, deviceScope } from '../models/Device.js';
import { Alert, Metric, RemoteSession } from '../models/Telemetry.js';
import { AuditLog } from '../models/AuditLog.js';
import { getSetting, groqKey } from './settings.js';
import * as wg from './wireguard.js';
import { log } from '../utils/logger.js';

/**
 * NexLink assistant (D7).
 *  - With a Groq API key: an OpenAI-compatible chat model with tool calling.
 *    The model never touches the database; it only sees tool outputs, and
 *    tools are scoped to what the signed-in user may see.
 *  - Without a key (or if Groq is unreachable): a deterministic diagnosis
 *    built from the same tool outputs (Diagnosis / Evidence / Causes / Tests).
 *  - Actions are only *suggested*. They reach the UI as buttons that go
 *    through the normal permission + approval flow.
 */
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const mbps = (bps) => (bps == null ? null : round((bps * 8) / 1e6, 2));

const escapeRegex = (s) => s.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');

async function findDevice(user, ref) {
  if (!ref) return null;
  const q = String(ref).trim().slice(0, 64);
  const hostname = new RegExp('^' + escapeRegex(q) + '$', 'i');
  return Device.findOne({ ...deviceScope(user), $or: [{ deviceId: q }, { hostname }, { virtualIp: q }] });
}

async function metricStats(deviceId, minutes) {
  const since = new Date(Date.now() - minutes * 60_000);
  const rows = await Metric.find({ deviceId, t: { $gte: since } }).lean();
  if (!rows.length) return { samples: 0 };
  const stat = (k) => {
    const v = rows.map((r) => r[k]).filter(Number.isFinite);
    if (!v.length) return null;
    return { avg: round(v.reduce((a, b) => a + b, 0) / v.length, 1), max: round(Math.max(...v), 1), min: round(Math.min(...v), 1) };
  };
  return {
    samples: rows.length, minutes,
    cpuPct: stat('cpu'), ramPct: stat('ram'), diskPct: stat('disk'),
    latencyMs: stat('lat'), packetLossPct: stat('loss'), appRttMs: stat('rtt'),
    rxMbps: stat('rx') && { avg: mbps(stat('rx').avg), max: mbps(stat('rx').max) },
    txMbps: stat('tx') && { avg: mbps(stat('tx').avg), max: mbps(stat('tx').max) },
  };
}

function deviceBrief(d) {
  return {
    hostname: d.hostname, deviceId: d.deviceId, virtualIp: d.virtualIp, os: d.os, status: d.status,
    simulated: d.simulated, tunnel: d.tunnel?.mode, lastSeen: d.lastSeen,
    cpuPct: round(d.latest?.cpuPct), ramPct: round(d.latest?.ramPct), diskPct: round(d.latest?.diskPct),
    latencyMs: round(d.latest?.latencyMs, 1), packetLossPct: round(d.latest?.packetLossPct, 1), appRttMs: d.latest?.appRttMs,
    rxMbps: mbps(d.latest?.rxBps), txMbps: mbps(d.latest?.txBps),
    anomaly: d.anomaly?.severity && d.anomaly.severity !== 'normal' ? { severity: d.anomaly.severity, features: d.anomaly.features } : null,
  };
}

/** Tool implementations. Each returns plain JSON. */
function toolset(user) {
  return {
    network_overview: async () => {
      const devices = await Device.find({ ...deviceScope(user), 'approval.state': 'approved' });
      const alerts = await Alert.countDocuments({ status: { $ne: 'resolved' }, deviceId: { $in: devices.map((d) => d.deviceId) } });
      return {
        vpn: { mode: wg.status().mode, reason: wg.status().reason },
        devices: devices.length,
        online: devices.filter((d) => ['CONNECTED', 'DEGRADED'].includes(d.status)).length,
        degraded: devices.filter((d) => d.status === 'DEGRADED').map((d) => d.hostname),
        offline: devices.filter((d) => d.status === 'DISCONNECTED').map((d) => d.hostname),
        anomalies: devices.filter((d) => d.anomaly?.severity && d.anomaly.severity !== 'normal').map((d) => ({ hostname: d.hostname, severity: d.anomaly.severity })),
        openAlerts: alerts,
      };
    },
    list_devices: async () => (await Device.find({ ...deviceScope(user), 'approval.state': 'approved' }).sort({ hostname: 1 })).map(deviceBrief),
    get_device: async ({ device }) => {
      const d = await findDevice(user, device);
      if (!d) return { error: `No device called "${device}" that you can access.` };
      const net = d.net || {};
      return {
        ...deviceBrief(d),
        cpuModel: d.cpuModel, cpuCores: d.cpuCores, ramTotalGb: d.ramTotal ? round(d.ramTotal / 1e9, 1) : null,
        topProcesses: (d.processes || []).slice(0, 6).map((p) => ({ name: p.name, cpuPct: p.cpu, memMb: p.memMb })),
        connections: (net.connections || []).length,
        listeningPorts: (net.listening || []).slice(0, 20).map((l) => `${l.port}/${l.proto} ${l.service || ''}`.trim()),
        protocols: net.protocols || {},
        last30min: await metricStats(d.deviceId, 30),
      };
    },
    get_metrics_history: async ({ device, minutes = 60 }) => {
      const d = await findDevice(user, device);
      if (!d) return { error: `No device called "${device}" that you can access.` };
      return { hostname: d.hostname, ...(await metricStats(d.deviceId, Math.min(Math.max(Number(minutes) || 60, 5), 1440))) };
    },
    list_alerts: async ({ status = 'open' } = {}) => {
      const ids = (await Device.find(deviceScope(user), 'deviceId')).map((d) => d.deviceId);
      const q = { deviceId: { $in: ids } };
      if (status !== 'all') q.status = status === 'open' ? { $ne: 'resolved' } : status;
      return (await Alert.find(q).sort({ openedAt: -1 }).limit(20).lean())
        .map((a) => ({ hostname: a.hostname, kind: a.kind, severity: a.severity, message: a.message, status: a.status, openedAt: a.openedAt }));
    },
    recent_activity: async () => {
      if (user.role !== 'admin') return { error: 'Only administrators can read the audit trail.' };
      const entries = await AuditLog.find().sort({ timestamp: -1 }).limit(15).lean();
      const sessions = await RemoteSession.find().sort({ createdAt: -1 }).limit(10).lean();
      return {
        audit: entries.map((e) => ({ at: e.timestamp, who: e.username || e.actorType, action: e.action, result: e.result, device: e.deviceName })),
        sessions: sessions.map((s) => ({ kind: s.kind, device: s.hostname, user: s.username, status: s.status })),
      };
    },
    suggest_action: async ({ action, device, reason }) => {
      const d = await findDevice(user, device);
      if (!d) return { error: `No device called "${device}".` };
      return { proposed: true, action, deviceId: d.deviceId, hostname: d.hostname, reason, note: 'Shown to the user as a button; it runs only after the normal approval flow.' };
    },
  };
}

const TOOL_SCHEMAS = [
  { name: 'network_overview', description: 'Summary of the private network: VPN mode, device counts, degraded/offline devices, anomalies, open alerts.', parameters: { type: 'object', properties: {} } },
  { name: 'list_devices', description: 'All devices the user can access with their latest metrics.', parameters: { type: 'object', properties: {} } },
  { name: 'get_device', description: 'Full detail for one device: latest metrics, top processes, ports, protocols, and 30-minute stats.', parameters: { type: 'object', properties: { device: { type: 'string', description: 'Hostname, virtual IP or device id' } }, required: ['device'] } },
  { name: 'get_metrics_history', description: 'Min/avg/max of CPU, RAM, disk, latency, packet loss and traffic over the last N minutes.', parameters: { type: 'object', properties: { device: { type: 'string' }, minutes: { type: 'number' } }, required: ['device'] } },
  { name: 'list_alerts', description: 'Recent alerts. status: open | acknowledged | resolved | all.', parameters: { type: 'object', properties: { status: { type: 'string' } } } },
  { name: 'recent_activity', description: 'Recent audit entries and remote sessions (admins only).', parameters: { type: 'object', properties: {} } },
  { name: 'suggest_action', description: 'Propose an action for the user to approve. action is one of: run_diagnostics, open_terminal, open_remote_desktop, acknowledge_alerts.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['run_diagnostics', 'open_terminal', 'open_remote_desktop', 'acknowledge_alerts'] }, device: { type: 'string' }, reason: { type: 'string' } }, required: ['action', 'device', 'reason'] } },
];

const SYSTEM_PROMPT = `You are the NexLink network assistant inside an admin console for a private WireGuard network (hub 10.50.0.1, subnet 10.50.0.0/24).
Answer using ONLY data returned by the tools; call tools before answering questions about devices, alerts or the network. Never invent numbers.
If a device is SIMULATED, say so. Be concise and technical. For a diagnosis use the headings: Diagnosis, Evidence, Possible causes, Recommended tests.
Latency and packet loss come from ICMP bursts to the hub through the tunnel; appRttMs is the application-level round trip over the control channel.
You cannot perform actions yourself. When an action would help, call suggest_action so the user gets a button that requires their approval.`;

async function callGroq(key, model, messages) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages, temperature: 0.2, max_tokens: 900,
      tools: TOOL_SCHEMAS.map((f) => ({ type: 'function', function: f })), tool_choice: 'auto',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()).choices?.[0]?.message;
}

export async function chat(user, history) {
  const tools = toolset(user);
  const key = await groqKey();
  const ai = await getSetting('ai');
  const used = [];
  const actions = [];

  if (key) {
    try {
      const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history.slice(-12)];
      for (let round = 0; round < 5; round += 1) {
        // eslint-disable-next-line no-await-in-loop
        const reply = await callGroq(key, ai.model, messages);
        if (!reply) break;
        if (!reply.tool_calls?.length) {
          return { answer: reply.content || '(no answer)', actions, tools: used, generator: `groq:${ai.model}` };
        }
        messages.push(reply);
        for (const call of reply.tool_calls) {
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* keep empty */ }
          const fn = tools[call.function.name];
          // eslint-disable-next-line no-await-in-loop
          const out = fn ? await fn(args) : { error: 'Unknown tool' };
          used.push(call.function.name);
          if (call.function.name === 'suggest_action' && out.proposed) actions.push(out);
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out).slice(0, 12_000) });
        }
      }
    } catch (err) {
      log.warn('ai.groq_failed', { reason: err.message });
      const offline = await offlineAnswer(user, history, tools);
      return { ...offline, note: `Groq was unreachable (${err.message.slice(0, 120)}). Showing the offline diagnosis instead.` };
    }
  }
  return offlineAnswer(user, history, tools);
}

/** Deterministic diagnosis from tool outputs — works with no network or key. */
async function offlineAnswer(user, history, tools) {
  const question = String(history.filter((m) => m.role === 'user').at(-1)?.content || '');
  const devices = await tools.list_devices();
  const mentioned = devices.find((d) => question.toLowerCase().includes(String(d.hostname).toLowerCase()))
    || devices.find((d) => d.virtualIp && question.includes(d.virtualIp));
  const actions = [];

  if (!mentioned) {
    const o = await tools.network_overview();
    const alerts = await tools.list_alerts({ status: 'open' });
    const lines = [
      '**Network overview** (offline assistant — add a Groq API key in Settings for conversational answers)',
      '',
      `- VPN hub: **${o.vpn.mode}**${o.vpn.reason ? ` — ${o.vpn.reason}` : ''}`,
      `- Devices: **${o.online}/${o.devices} online**${o.degraded.length ? `; degraded: ${o.degraded.join(', ')}` : ''}${o.offline.length ? `; offline: ${o.offline.join(', ')}` : ''}`,
      `- Open alerts: **${o.openAlerts}**`,
      ...(o.anomalies.length ? [`- Anomalies: ${o.anomalies.map((a) => `${a.hostname} (${a.severity})`).join(', ')}`] : []),
      ...(alerts.length ? ['', '**Latest alerts**', ...alerts.slice(0, 5).map((a) => `- [${a.severity}] ${a.message}`)] : []),
      '',
      'Ask about a specific device by name (for example "why is lab-pc-2 slow?") for a full diagnosis.',
    ];
    return { answer: lines.join('\n'), actions, tools: ['network_overview', 'list_alerts'], generator: 'offline' };
  }

  const d = await tools.get_device({ device: mentioned.hostname });
  const h = d.last30min || {};
  const findings = [];
  const causes = [];
  const tests = [];
  if (d.status === 'DISCONNECTED') {
    findings.push(`${d.hostname} is **offline** (last seen ${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'never'}).`);
    causes.push('The machine is off, asleep, or the agent was stopped.', 'The tunnel or LAN path to the hub is down.');
    tests.push('Check the machine is powered on and the NexLink Agent is running.', 'Ping its physical IP from the hub.');
  }
  if ((d.cpuPct ?? 0) >= 85) {
    findings.push(`CPU is at **${d.cpuPct}%** (30-min avg ${h.cpuPct?.avg ?? '—'}%).`);
    causes.push(`A busy process: ${d.topProcesses?.slice(0, 3).map((p) => `${p.name} (${p.cpuPct}%)`).join(', ') || 'see System Monitor'}.`);
    tests.push('Open System Monitor and sort processes by CPU.');
  }
  if ((d.ramPct ?? 0) >= 85) {
    findings.push(`Memory is at **${d.ramPct}%**.`);
    causes.push('Too many applications open, or a memory leak.');
  }
  if ((d.latencyMs ?? 0) >= 100 || (h.latencyMs?.max ?? 0) >= 150) {
    findings.push(`Latency to the hub is **${d.latencyMs} ms** (30-min max ${h.latencyMs?.max ?? '—'} ms); app-level RTT ${d.appRttMs ?? '—'} ms.`);
    causes.push('Congested Wi-Fi or uplink.', 'Large transfers on the same link.');
    tests.push(`Run Diagnostics → ping and traceroute from ${d.hostname} to 10.50.0.1.`);
  }
  if ((d.packetLossPct ?? 0) > 0 || (h.packetLossPct?.max ?? 0) >= 5) {
    findings.push(`Packet loss is **${d.packetLossPct ?? 0}%** now (30-min max ${h.packetLossPct?.max ?? 0}%).`);
    causes.push('Weak wireless signal or a faulty cable/port.', 'MTU problems through the tunnel.');
    tests.push('Run a longer ping burst and an MTU check from Diagnostics.');
  }
  if ((d.rxMbps ?? 0) + (d.txMbps ?? 0) > 50) {
    findings.push(`Traffic is high: ↓ ${d.rxMbps} Mbps / ↑ ${d.txMbps} Mbps.`);
    tests.push('Open Network Analysis to see which remote hosts it is talking to.');
  }
  if (d.anomaly) findings.push(`The anomaly model flags **${d.anomaly.severity}** behaviour in: ${d.anomaly.features.join(', ') || 'combined metrics'}.`);
  if (!findings.length) findings.push(`${d.hostname} looks healthy: CPU ${d.cpuPct ?? '—'}%, RAM ${d.ramPct ?? '—'}%, latency ${d.latencyMs ?? '—'} ms, loss ${d.packetLossPct ?? 0}%.`);
  if (tests.length) actions.push({ proposed: true, action: 'run_diagnostics', deviceId: d.deviceId, hostname: d.hostname, reason: 'Confirm the path to the hub' });

  const lines = [
    `**Diagnosis — ${d.hostname}**${d.simulated ? ' (simulated device)' : ''}`,
    '', '**Evidence**', ...findings.map((f) => `- ${f}`),
    ...(causes.length ? ['', '**Possible causes**', ...causes.map((c) => `- ${c}`)] : []),
    ...(tests.length ? ['', '**Recommended tests**', ...tests.map((t) => `- ${t}`)] : []),
    '', '_Offline assistant. Add a Groq API key in Settings for conversational answers._',
  ];
  return { answer: lines.join('\n'), actions, tools: ['list_devices', 'get_device'], generator: 'offline' };
}

/** Short narrative for reports (Groq if available, template otherwise). */
export async function narrate(data) {
  const key = await groqKey();
  const ai = await getSetting('ai');
  if (key) {
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ai.model, temperature: 0.2, max_tokens: 500,
          messages: [
            { role: 'system', content: 'Write a concise executive summary (4-6 sentences, plain text) of this network health report for an IT administrator. Use only the numbers given. Mention simulated devices as simulated.' },
            { role: 'user', content: JSON.stringify(data).slice(0, 14_000) },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const text = (await res.json()).choices?.[0]?.message?.content;
        if (text) return { narrative: text.trim(), generator: `groq:${ai.model}` };
      }
    } catch (err) {
      log.warn('ai.narrate_failed', { reason: err.message });
    }
  }
  const s = data.summary;
  const worst = [...(data.devices || [])].sort((a, b) => (a.availabilityPct ?? 100) - (b.availabilityPct ?? 100))[0];
  const narrative = [
    `Between ${new Date(data.from).toLocaleString()} and ${new Date(data.to).toLocaleString()}, the network had ${s.devices} approved device(s), ${s.simulated} of them simulated.`,
    `Average availability was ${s.avgAvailabilityPct ?? '—'}%${worst ? `, lowest on ${worst.hostname} (${worst.availabilityPct}%)` : ''}.`,
    `${s.alertsOpened} alert(s) were raised (${s.criticalAlerts} critical) and ${s.alertsResolved} resolved.`,
    `${s.sessions} remote session(s) were run and ${s.anomalies} device(s) showed anomalous behaviour.`,
  ].join(' ');
  return { narrative, generator: 'template' };
}
