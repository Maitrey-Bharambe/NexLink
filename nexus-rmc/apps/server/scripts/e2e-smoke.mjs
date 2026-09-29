/**
 * End-to-end smoke test against a RUNNING server + simulator.
 *
 *   1. Start a throwaway server:  PORT=4001 MONGODB_URI=…/nexlink_e2e node src/index.js
 *   2. node scripts/e2e-smoke.mjs http://127.0.0.1:4001
 *
 * It creates the first admin (fresh DB only), issues an enrollment token,
 * starts 3 simulated agents (Python), approves them, and exercises telemetry,
 * diagnostics, fault injection, alerts, a terminal session through the relay,
 * a file listing, the AI assistant, reports, traffic, analysis and roles.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createMessage, encode, MessageType } from '@nexus/protocol';

const BASE = (process.argv[2] || 'http://127.0.0.1:4001').replace(/\/+$/, '');
const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, '../../agent');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token;
let failures = 0;

async function api(method, p, body, tk = token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function check(name, cond, extra = '') {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
}

async function waitFor(fn, label, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    const v = await fn().catch(() => null);
    if (v) return v;
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const status = await api('GET', '/api/auth/status');
  const password = 'E2eAdminPass2026';
  if (status.setupRequired) {
    token = (await api('POST', '/api/auth/setup', { username: 'e2eadmin', displayName: 'E2E Admin', password })).token;
  } else {
    token = (await api('POST', '/api/auth/login', { username: 'e2eadmin', password })).token;
  }
  check('admin signed in', Boolean(token));

  // Registration → pending → approval
  const email = `user${Date.now()}@example.com`;
  const reg = await api('POST', '/api/auth/register', { email, displayName: 'Test User', password: 'UserPass2026x' }, null);
  check('self-registration creates a pending user', reg.status === 'pending');
  const blocked = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: email, password: 'UserPass2026x' }) });
  check('pending user cannot sign in', blocked.status === 403);
  await api('PATCH', `/api/users/${reg.user.id}`, { status: 'active' });
  const userToken = (await api('POST', '/api/auth/login', { username: email, password: 'UserPass2026x' }, null)).token;
  check('approved user signs in with email', Boolean(userToken));

  // Enrollment + simulator
  const enr = await api('POST', '/api/devices/enrollment/tokens', { label: 'e2e', maxUses: 3, ttlMinutes: 30 });
  check('enrollment token issued', enr.token.startsWith('nxl_'));
  const sim = spawn('python', ['-m', 'nexlink_agent.simulator', '--server', BASE, '--token', enr.token, '--count', '3', '--prefix', `E2E-${Date.now() % 10000}-`], { cwd: agentDir, stdio: ['ignore', 'pipe', 'pipe'] });
  sim.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  try {
    const pending = await waitFor(async () => {
      const r = await api('GET', '/api/devices?include=all');
      const p = r.devices.filter((d) => d.approval === 'pending' && d.simulated);
      return p.length >= 3 ? p : null;
    }, '3 pending simulated devices');
    check('3 simulated devices enrolled and pending', pending.length >= 3);

    for (const d of pending.slice(0, 3)) await api('POST', `/api/devices/${d.deviceId}/approve`, {});
    const online = await waitFor(async () => {
      const r = await api('GET', '/api/devices');
      const on = r.devices.filter((d) => pending.some((p) => p.deviceId === d.deviceId) && d.status === 'CONNECTED' && d.latest?.cpuPct != null);
      return on.length >= 3 ? on : null;
    }, 'devices online with metrics');
    check('approved devices come online with telemetry', online.length === 3, online.map((d) => `${d.hostname}@${d.virtualIp}`).join(', '));
    check('simulated range 10.50.0.200+', online.every((d) => d.virtualIp.startsWith('10.50.0.2')));
    const dev = online[0];

    // Assignment and user scoping
    const uDevBefore = await api('GET', '/api/devices', undefined, userToken);
    check('user sees no unassigned devices', uDevBefore.devices.length === 0);
    await api('PATCH', `/api/devices/${dev.deviceId}`, { assignedUsers: [reg.user.id] });
    const uDev = await api('GET', '/api/devices', undefined, userToken);
    check('user sees only the assigned device', uDev.devices.length === 1 && uDev.devices[0].deviceId === dev.deviceId);
    const forbidden = await fetch(`${BASE}/api/users`, { headers: { Authorization: `Bearer ${userToken}` } });
    check('user cannot open admin APIs', forbidden.status === 403);

    // Diagnostics
    const diag = await api('POST', `/api/devices/${dev.deviceId}/diagnostics`, { tests: ['ping', 'traceroute', 'dns', 'port', 'mtu'] });
    check('diagnostics run through the agent', diag.results.ping?.sent === 10 && diag.results.mtu?.pathMtu > 0, `ping avg ${diag.results.ping?.avgMs} ms`);

    // Network detail
    const detail = await waitFor(async () => {
      const r = await api('GET', `/api/devices/${dev.deviceId}`);
      return r.device.net?.connections?.length && r.device.processes?.length ? r.device : null;
    }, 'network + process snapshot', 30_000);
    check('network and process snapshots stored', detail.net.connections.length > 0 && detail.processes.length > 0);

    // Remote terminal session (user → needs approval)
    const req = await api('POST', '/api/sessions', { deviceId: dev.deviceId, kind: 'terminal', reason: 'e2e check' }, userToken);
    check('user session waits for approval', req.session.status === 'requested');
    await api('POST', `/api/sessions/${req.session.sessionId}/approve`, {});
    const conn = await api('POST', `/api/sessions/${req.session.sessionId}/connect`, {}, userToken);
    const results = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/session`);
      const got = {};
      const timer = setTimeout(() => reject(new Error('session timeout')), 30_000);
      ws.on('open', () => ws.send(encode(createMessage(MessageType.AUTH_REQUEST, { token: userToken, sessionId: req.session.sessionId, sessionToken: conn.sessionToken }))));
      ws.on('message', (raw, bin) => {
        if (bin) return;
        const m = JSON.parse(raw.toString());
        if (m.type === 'SESSION_READY') {
          ws.send(encode(createMessage(MessageType.COMMAND_REQUEST, { commandId: 'a', command: 'ipconfig' })));
          ws.send(encode(createMessage(MessageType.COMMAND_REQUEST, { commandId: 'b', command: 'del C:\\important.txt' })));
        }
        if (m.type === 'COMMAND_RESPONSE') {
          got[m.payload.commandId] = m.payload;
          if (got.a && got.b) {
            ws.send(encode(createMessage(MessageType.SESSION_END, {})));
            clearTimeout(timer);
            resolve(got);
          }
        }
        if (m.type === 'ERROR') { clearTimeout(timer); reject(new Error(m.payload.reason)); }
      });
      ws.on('error', reject);
    });
    check('allowlisted command runs on the device', results.a.ok && /10\.50\.0\./.test(results.a.stdout));
    check('non-allowlisted command is blocked', results.b.blocked === true);

    // Admin file session
    const fs = await api('POST', '/api/sessions', { deviceId: dev.deviceId, kind: 'files' });
    check('admin session is approved immediately', fs.session.status === 'approved');
    const fconn = await api('POST', `/api/sessions/${fs.session.sessionId}/connect`, {});
    const listing = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/session`);
      const timer = setTimeout(() => reject(new Error('file session timeout')), 30_000);
      ws.on('open', () => ws.send(encode(createMessage(MessageType.AUTH_REQUEST, { token, sessionId: fs.session.sessionId, sessionToken: fconn.sessionToken }))));
      ws.on('message', (raw, bin) => {
        if (bin) return;
        const m = JSON.parse(raw.toString());
        if (m.type === 'SESSION_READY') ws.send(encode(createMessage(MessageType.FILE_REQUEST, { requestId: 'r1', op: 'list', path: '' })));
        if (m.type === 'FILE_RESPONSE') { clearTimeout(timer); ws.close(); resolve(m.payload); }
      });
      ws.on('error', reject);
    });
    check('file listing through the relay', listing.ok && listing.data.entries.length > 0);

    // Fault injection → alert
    await api('POST', `/api/devices/${online[1].deviceId}/sim-fault`, { fault: 'loss', seconds: 120 });
    const alert = await waitFor(async () => {
      const r = await api('GET', '/api/alerts');
      return r.alerts.find((a) => a.deviceId === online[1].deviceId && a.kind === 'packet_loss');
    }, 'packet-loss alert', 120_000);
    check('injected packet loss raises an alert', Boolean(alert), alert?.message);
    await api('POST', `/api/devices/${online[1].deviceId}/sim-fault`, { fault: 'clear' });

    // Traffic, analysis, VPN
    const traffic = await api('GET', '/api/traffic?minutes=15');
    check('traffic series available', traffic.series.length > 0 && traffic.talkers.length >= 3);
    const analysis = await api('GET', '/api/analysis');
    check('protocol analysis aggregates devices', analysis.connections > 0 && Object.keys(analysis.protocols).length > 0);
    const vpn = await api('GET', '/api/vpn');
    check('VPN status and peers', vpn.peers.length >= 3, `hub mode ${vpn.hub.mode}`);

    // AI + reports
    const ai = await api('POST', '/api/ai/chat', { messages: [{ role: 'user', content: `Why is ${online[1].hostname} slow?` }] });
    check('AI assistant answers', ai.answer.length > 40, `generator ${ai.generator}`);
    const rep = await api('POST', '/api/reports', { kind: 'daily' });
    check('report generated', rep.report.data.summary.devices >= 3, `generator ${rep.report.generator}`);

    // Audit
    const audit = await api('GET', '/api/audit?limit=200');
    const actions = new Set(audit.entries.map((e) => e.action));
    for (const a of ['device.enroll', 'device.approve', 'session.request', 'session.approve', 'terminal.command', 'device.diagnostics', 'ai.chat']) {
      check(`audit has ${a}`, actions.has(a));
    }
  } finally {
    sim.kill();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll end-to-end checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E error:', err.message);
  process.exit(1);
});
