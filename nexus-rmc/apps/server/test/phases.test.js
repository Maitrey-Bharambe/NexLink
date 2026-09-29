/**
 * Phases 2–7 integration tests with an in-process fake agent (no Python):
 * enrollment + approval, telemetry + alerts, device scoping for users,
 * remote-session approval and relay (terminal allowlist), diagnostics
 * commands, registration/pending accounts, AI fallback and reports.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import WebSocket from 'ws';
import { createMessage, encode, MessageType, checkAllowlistedCommand } from '@nexus/protocol';
import { connectDb } from '../src/config/db.js';
import { createApp } from '../src/app.js';
import { attachConsoleHub } from '../src/websocket/consoleHub.js';
import { attachAgentHub } from '../src/websocket/agentHub.js';
import { attachSessionHub } from '../src/websocket/sessionHub.js';
import { setSetting } from '../src/services/settings.js';
import { scoreFallback } from '../src/services/anomaly.js';
import { generateKeyPair, isValidWgKey } from '../src/services/wireguard.js';
import { setLogLevel } from '../src/utils/logger.js';

setLogLevel('CRITICAL');

let mongo; let app; let server; let hubs; let port;
let admin; let userToken; let userId;
const wsUrl = (p) => `ws://127.0.0.1:${port}${p}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Opens a socket and buffers every message so none are missed. */
function socket(path) {
  const ws = new WebSocket(wsUrl(path));
  const inbox = [];
  const waiters = [];
  ws.on('message', (d, bin) => {
    if (bin) return;
    const msg = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else inbox.push(msg);
  });
  const next = (pred = () => true, ms = 5000) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); reject(new Error('timeout')); } }, ms);
    });
  };
  const send = (type, payload) => ws.send(encode(createMessage(type, payload)));
  return { ws, next, send, opened: new Promise((r) => ws.once('open', r)), closed: new Promise((r) => ws.once('close', (c) => r(c))) };
}

/** Minimal agent: registers, answers PING, reports metrics, runs terminal commands. */
async function fakeAgent(enrollmentToken, hostname) {
  const a = socket('/ws/agent');
  await a.opened;
  const { publicKey } = generateKeyPair();
  a.send(MessageType.DEVICE_REGISTER, { enrollmentToken, hostname, os: 'TestOS', publicKey, simulated: true, capabilities: { terminal: true, files: true, screen: true } });
  const pending = await a.next((m) => m.type === 'DEVICE_PENDING');
  a.deviceId = pending.payload.deviceId;
  a.secret = pending.payload.deviceSecret;
  a.ws.on('message', (d, bin) => {
    if (bin) return;
    const m = JSON.parse(d.toString());
    if (m.type === 'PING') a.send(MessageType.PONG, { seq: m.payload.seq, t0: m.payload.t0 });
    if (m.type === 'COMMAND_REQUEST' && m.payload.kind === 'diagnostics') {
      a.send(MessageType.COMMAND_RESPONSE, { commandId: m.payload.commandId, ok: true, data: { ping: { sent: 10, received: 10, avgMs: 3.2, lossPct: 0 } } });
    }
    if (m.type === 'SESSION_START') a.onSession?.(m.payload);
  });
  return a;
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri(), { maxAttempts: 1 });
  app = createApp();
  server = http.createServer(app);
  hubs = [attachConsoleHub(server), attachAgentHub(server), attachSessionHub(server)];
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const res = await request(app).post('/api/auth/setup').send({ username: 'admin', password: 'NexusLab2026' }).expect(201);
  admin = res.body.token;
});

after(async () => {
  for (const h of hubs) h.close();
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongo.stop();
});

test('WireGuard keys are valid Curve25519 base64 keys', () => {
  const { publicKey, privateKey } = generateKeyPair();
  assert.ok(isValidWgKey(publicKey));
  assert.ok(isValidWgKey(privateKey));
  assert.notEqual(publicKey, privateKey);
});

test('terminal allowlist blocks chaining and unknown commands', () => {
  assert.equal(checkAllowlistedCommand('ipconfig /all'), null);
  assert.equal(checkAllowlistedCommand('route print'), null);
  assert.match(checkAllowlistedCommand('ping x && del y'), /not allowed/);
  assert.match(checkAllowlistedCommand('format c:'), /not on the allowed/);
  assert.match(checkAllowlistedCommand('route add 0.0.0.0'), /route print/);
});

test('self-registration creates a pending user who cannot sign in until approved', async () => {
  const reg = await request(app).post('/api/auth/register').send({ email: 'Priya@Example.com', displayName: 'Priya', password: 'UserPass2026x' }).expect(201);
  assert.equal(reg.body.status, 'pending');
  const denied = await request(app).post('/api/auth/login').send({ username: 'priya@example.com', password: 'UserPass2026x' }).expect(403);
  assert.equal(denied.body.error.code, 'PENDING_APPROVAL');
  userId = reg.body.user.id;
  await request(app).patch(`/api/users/${userId}`).set(auth(admin)).send({ status: 'active' }).expect(200);
  const ok = await request(app).post('/api/auth/login').send({ username: 'priya@example.com', password: 'UserPass2026x' }).expect(200);
  userToken = ok.body.token;
  assert.equal(ok.body.user.role, 'user');
});

test('Google sign-in reports "not configured" without credentials', async () => {
  const s = await request(app).get('/api/auth/status').expect(200);
  assert.equal(s.body.providers.google, false);
  await request(app).post('/api/auth/google/start').expect(503);
});

let agent;
test('enrollment: token → pending device → admin approval → virtual IP', async () => {
  const tok = await request(app).post('/api/devices/enrollment/tokens').set(auth(admin)).send({ maxUses: 1 }).expect(201);
  await request(app).post('/api/devices/enrollment/tokens').set(auth(userToken)).send({}).expect(403);

  agent = await fakeAgent(tok.body.token, 'TEST-PC-01');
  const list = await request(app).get('/api/devices?include=all').set(auth(admin)).expect(200);
  assert.equal(list.body.devices.find((d) => d.deviceId === agent.deviceId).approval, 'pending');

  // Token is single-use.
  const b = socket('/ws/agent');
  await b.opened;
  b.send(MessageType.DEVICE_REGISTER, { enrollmentToken: tok.body.token, hostname: 'SECOND' });
  assert.equal((await b.next((m) => m.type === 'DEVICE_REJECTED')).type, 'DEVICE_REJECTED');

  await request(app).post(`/api/devices/${agent.deviceId}/approve`).set(auth(admin)).send({}).expect(200);
  const approved = await agent.next((m) => m.type === 'DEVICE_APPROVED');
  assert.match(approved.payload.virtualIp, /^10\.50\.0\.2\d\d$/); // simulated range
  await agent.next((m) => m.type === 'AUTH_RESPONSE' && m.payload.ok);
});

test('telemetry updates the device and sustained breaches raise alerts', async () => {
  await setSetting('thresholds', { cpuPct: 90, ramPct: 90, diskPct: 92, latencyMs: 150, lossPct: 5, offlineSec: 45, sustainSec: 0 }, 'test');
  agent.send(MessageType.METRIC_UPDATE, { cpuPct: 97, ramPct: 40, diskPct: 50, rxBps: 1000, txBps: 500, latencyMs: 4, packetLossPct: 0 });
  await sleep(300);
  agent.send(MessageType.METRIC_UPDATE, { cpuPct: 98, ramPct: 40, diskPct: 50, rxBps: 1000, txBps: 500, latencyMs: 4, packetLossPct: 0 });
  await sleep(400);
  const d = await request(app).get(`/api/devices/${agent.deviceId}`).set(auth(admin)).expect(200);
  assert.equal(d.body.device.latest.cpuPct, 98);
  const alerts = await request(app).get('/api/alerts').set(auth(admin)).expect(200);
  assert.ok(alerts.body.alerts.some((a) => a.kind === 'cpu_high' && a.deviceId === agent.deviceId));

  agent.send(MessageType.METRIC_UPDATE, { cpuPct: 10 });
  await sleep(400);
  const after2 = await request(app).get('/api/alerts?status=resolved').set(auth(admin)).expect(200);
  assert.ok(after2.body.alerts.some((a) => a.kind === 'cpu_high' && a.autoResolved));
});

test('users only see devices assigned to them', async () => {
  let r = await request(app).get('/api/devices').set(auth(userToken)).expect(200);
  assert.equal(r.body.devices.length, 0);
  await request(app).get(`/api/devices/${agent.deviceId}`).set(auth(userToken)).expect(404);
  await request(app).patch(`/api/devices/${agent.deviceId}`).set(auth(admin)).send({ assignedUsers: [userId] }).expect(200);
  r = await request(app).get('/api/devices').set(auth(userToken)).expect(200);
  assert.equal(r.body.devices.length, 1);
  await request(app).post(`/api/devices/${agent.deviceId}/approve`).set(auth(userToken)).expect(403);
});

test('diagnostics run through the agent command channel', async () => {
  const r = await request(app).post(`/api/devices/${agent.deviceId}/diagnostics`).set(auth(userToken)).send({ tests: ['ping'] }).expect(200);
  assert.equal(r.body.results.ping.received, 10);
});

test('remote session: user request → admin approval → relay enforces the allowlist', async () => {
  const req = await request(app).post('/api/sessions').set(auth(userToken)).send({ deviceId: agent.deviceId, kind: 'terminal', reason: 'test' }).expect(201);
  assert.equal(req.body.session.status, 'requested');
  await request(app).post(`/api/sessions/${req.body.session.sessionId}/connect`).set(auth(userToken)).expect(409);
  await request(app).post('/api/sessions').set(auth(userToken)).send({ deviceId: agent.deviceId, kind: 'terminal', fullShell: true }).expect(403);
  await request(app).post(`/api/sessions/${req.body.session.sessionId}/approve`).set(auth(admin)).expect(200);

  // Agent side opens the relay when told to.
  const agentSide = new Promise((resolve) => {
    agent.onSession = async (start) => {
      const s = socket('/ws/agent-session');
      await s.opened;
      s.send(MessageType.AUTH_REQUEST, { deviceId: agent.deviceId, deviceSecret: agent.secret, sessionId: start.sessionId });
      await s.next((m) => m.type === 'SESSION_READY');
      // Answer relayed commands in the background (only allowed ones arrive here).
      s.ws.on('message', (d, bin) => {
        if (bin) return;
        const m = JSON.parse(d.toString());
        if (m.type === 'COMMAND_REQUEST') {
          s.send(MessageType.COMMAND_RESPONSE, { commandId: m.payload.commandId, ok: true, exitCode: 0, stdout: `ran ${m.payload.command}` });
        }
      });
      resolve(start);
    };
  });
  const conn = await request(app).post(`/api/sessions/${req.body.session.sessionId}/connect`).set(auth(userToken)).expect(200);
  const c = socket('/ws/session');
  await c.opened;
  c.send(MessageType.AUTH_REQUEST, { token: userToken, sessionId: req.body.session.sessionId, sessionToken: conn.body.sessionToken });
  await c.next((m) => m.type === 'SESSION_READY');
  const start = await agentSide;
  assert.equal(start.policy.fullShell, false);
  assert.equal(start.policy.fileRoot, 'shared');

  c.send(MessageType.COMMAND_REQUEST, { commandId: 'bad', command: 'shutdown /s' });
  const blocked = await c.next((m) => m.type === 'COMMAND_RESPONSE' && m.payload.commandId === 'bad');
  assert.equal(blocked.payload.blocked, true);
  c.send(MessageType.COMMAND_REQUEST, { commandId: 'ok', command: 'hostname' });
  const ran = await c.next((m) => m.type === 'COMMAND_RESPONSE' && m.payload.commandId === 'ok');
  assert.equal(ran.payload.stdout, 'ran hostname');

  // The session token is single use.
  const replay = socket('/ws/session');
  await replay.opened;
  replay.send(MessageType.AUTH_REQUEST, { token: userToken, sessionId: req.body.session.sessionId, sessionToken: conn.body.sessionToken });
  assert.equal(await replay.closed, 4003);

  c.send(MessageType.SESSION_END, {});
  await c.closed;
  await sleep(200);
  const hist = await request(app).get('/api/sessions').set(auth(userToken)).expect(200);
  assert.equal(hist.body.sessions[0].status, 'ended');
});

test('audit records enrollment, approval, session decisions and commands', async () => {
  const r = await request(app).get('/api/audit?limit=200').set(auth(admin)).expect(200);
  const actions = new Set(r.body.entries.map((e) => e.action));
  for (const a of ['device.enroll', 'device.approve', 'device.assign', 'session.request', 'session.approve', 'session.start', 'terminal.command', 'session.end', 'user.approve', 'auth.register']) {
    assert.ok(actions.has(a), `missing ${a}`);
  }
  const denied = r.body.entries.find((e) => e.action === 'terminal.command' && e.result === 'denied');
  assert.match(denied.details.command, /shutdown/);
});

test('AI assistant answers offline from real tool data and reports are generated', async () => {
  const ai = await request(app).post('/api/ai/chat').set(auth(admin)).send({ messages: [{ role: 'user', content: 'Why is TEST-PC-01 slow?' }] }).expect(200);
  assert.equal(ai.body.generator, 'offline');
  assert.match(ai.body.answer, /TEST-PC-01/);
  const rep = await request(app).post('/api/reports').set(auth(admin)).send({ kind: 'daily' }).expect(201);
  assert.equal(rep.body.report.data.summary.devices, 1);
  await request(app).post('/api/reports').set(auth(userToken)).send({}).expect(403);
});

test('anomaly fallback flags a sharp deviation from the device baseline', () => {
  const normal = Array.from({ length: 200 }, () => [20 + Math.random() * 4, 50, 2e5, 5e4, 10 + Math.random(), 0, 40]);
  assert.equal(scoreFallback([...normal, ...normal.slice(0, 6)]).severity, 'normal');
  const spike = Array.from({ length: 6 }, () => [97, 52, 2e5, 5e4, 260, 25, 45]);
  const r = scoreFallback([...normal, ...spike]);
  assert.equal(r.severity, 'high');
  assert.ok(r.features.includes('latency'));
});

test('rejecting a device disconnects its agent', async () => {
  await request(app).post(`/api/devices/${agent.deviceId}/reject`).set(auth(admin)).expect(200);
  const msg = await agent.next((m) => m.type === 'DEVICE_REJECTED');
  assert.ok(msg);
});
