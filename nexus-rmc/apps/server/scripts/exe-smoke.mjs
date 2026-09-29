/**
 * Smoke test for the packaged agent (apps/agent/dist/NexLinkAgent.exe)
 * against a THROWAWAY server on a fresh database:
 *   PORT=4001 MONGODB_URI=…/nexlink_exe_test node src/index.js
 *   node scripts/exe-smoke.mjs http://127.0.0.1:4001
 * Enrolls the exe with an enrollment code, approves it, checks telemetry,
 * runs a terminal command and receives one remote-desktop frame, then
 * stops the agent and forgets its identity.
 */
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createMessage, encode, MessageType } from '@nexus/protocol';

const B = (process.argv[2] || 'http://127.0.0.1:4001').replace(/\/+$/, '');
const exe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../agent/dist/NexLinkAgent.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (m, p, b, t) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${m} ${p}: ${JSON.stringify(d)}`);
  return d;
};

const status = await j('GET', '/api/auth/status');
const token = status.setupRequired
  ? (await j('POST', '/api/auth/setup', { username: 'exetest', password: 'ExeTestPass2026' })).token
  : (await j('POST', '/api/auth/login', { username: 'exetest', password: 'ExeTestPass2026' })).token;
const enr = await j('POST', '/api/devices/enrollment/tokens', { label: 'exe test' }, token);
console.log('agent download offered:', enr.agentDownload);

execFileSync(exe, ['reset']);
const agent = spawn(exe, ['enroll', '--code', enr.code], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
agent.stdout.on('data', (d) => { log += d; });
agent.stderr.on('data', (d) => { log += d; });

let ok = true;
try {
  let dev;
  for (let i = 0; i < 30 && !dev; i += 1) {
    await sleep(1000);
    dev = (await j('GET', '/api/devices?include=all', null, token)).devices.find((d) => d.approval === 'pending');
  }
  if (!dev) throw new Error(`agent never enrolled:\n${log}`);
  console.log('enrolled:', dev.hostname, dev.os, 'caps', JSON.stringify(dev.capabilities));
  await j('POST', `/api/devices/${dev.deviceId}/approve`, {}, token);
  await sleep(12000);
  const det = (await j('GET', `/api/devices/${dev.deviceId}`, null, token)).device;
  console.log('telemetry:', det.status, 'cpu', det.latest.cpuPct, 'ram', det.latest.ramPct, 'procs', det.processes?.length, 'conns', det.net?.connections?.length);
  if (det.status !== 'CONNECTED' || det.latest.cpuPct == null) ok = false;

  const session = async (kind, onReady, until) => {
    const { session: s } = await j('POST', '/api/sessions', { deviceId: dev.deviceId, kind }, token);
    const c = await j('POST', `/api/sessions/${s.sessionId}/connect`, {}, token);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${B.replace('http', 'ws')}/ws/session`);
      const t = setTimeout(() => reject(new Error(`${kind} session timeout\n${log}`)), 30000);
      ws.on('open', () => ws.send(encode(createMessage(MessageType.AUTH_REQUEST, { token, sessionId: s.sessionId, sessionToken: c.sessionToken }))));
      ws.on('message', (raw, bin) => {
        const m = bin ? { binary: raw } : JSON.parse(raw.toString());
        if (m.type === 'SESSION_READY') onReady(ws);
        const done = until(m);
        if (done) { clearTimeout(t); ws.send(encode(createMessage(MessageType.SESSION_END, {}))); ws.close(); resolve(done); }
      });
    });
  };
  const out = await session('terminal', (ws) => ws.send(encode(createMessage(MessageType.COMMAND_REQUEST, { commandId: 'a', command: 'hostname' }))), (m) => m.type === 'COMMAND_RESPONSE' && m.payload);
  console.log('terminal hostname ->', JSON.stringify(out.stdout.trim()));
  const frame = await session('desktop', () => {}, (m) => m.binary && m.binary[0] === 1 && m.binary);
  console.log('desktop frame bytes:', frame.length, 'jpeg:', frame.subarray(1, 4).toString('hex') === 'ffd8ff');
  if (!out.ok || frame.length < 1000) ok = false;
} catch (err) {
  ok = false;
  console.error(err.message);
} finally {
  agent.kill();
  await sleep(500);
  execFileSync(exe, ['reset']);
}
console.log(ok ? 'EXE SMOKE TEST PASSED' : 'EXE SMOKE TEST FAILED');
process.exit(ok ? 0 : 1);
