/**
 * Phase 1 integration tests: first-run setup, login, sessions, roles,
 * audit trail and the console WebSocket handshake.
 * Uses an in-memory MongoDB, so no local database is needed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import WebSocket from 'ws';
import { createMessage, encode, MessageType } from '@nexus/protocol';
import { connectDb } from '../src/config/db.js';
import { createApp } from '../src/app.js';
import { attachConsoleHub } from '../src/websocket/consoleHub.js';
import { setLogLevel } from '../src/utils/logger.js';

setLogLevel('CRITICAL');

let mongo; let app; let server; let hub; let port;
let adminToken;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri(), { maxAttempts: 1 });
  app = createApp();
  server = http.createServer(app);
  hub = attachConsoleHub(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  hub.close();
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongo.stop();
});

test('health is public and reports the database', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.db, 'CONNECTED');
  assert.equal(res.body.protocol, '1.0');
});

test('fresh install requires setup and rejects weak passwords', async () => {
  const status = await request(app).get('/api/auth/status').expect(200);
  assert.equal(status.body.setupRequired, true);
  await request(app).post('/api/auth/setup').send({ username: 'admin', password: 'short' }).expect(400);
});

test('setup creates the first admin exactly once', async () => {
  const res = await request(app).post('/api/auth/setup')
    .send({ username: 'Admin', displayName: 'Lab Admin', password: 'NexusLab2026' }).expect(201);
  assert.equal(res.body.user.role, 'admin');
  assert.equal(res.body.user.username, 'admin');
  assert.ok(res.body.token);
  assert.equal(res.body.user.passwordHash, undefined);

  await request(app).post('/api/auth/setup').send({ username: 'evil', password: 'NexusLab2026' }).expect(409);
  const status = await request(app).get('/api/auth/status');
  assert.equal(status.body.setupRequired, false);
});

test('login succeeds with correct credentials and fails otherwise', async () => {
  await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrongpass99' }).expect(401);
  await request(app).post('/api/auth/login').send({ username: 'ghost', password: 'wrongpass99' }).expect(401);
  const res = await request(app).post('/api/auth/login').send({ username: 'ADMIN', password: 'NexusLab2026' }).expect(200);
  adminToken = res.body.token;
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`).expect(200);
  assert.equal(me.body.user.username, 'admin');
});

test('protected routes reject missing or garbage tokens', async () => {
  await request(app).get('/api/network').expect(401);
  await request(app).get('/api/network').set('Authorization', 'Bearer abc.def.ghi').expect(401);
});

test('network summary is real (no devices yet)', async () => {
  const res = await request(app).get('/api/network').set('Authorization', `Bearer ${adminToken}`).expect(200);
  assert.equal(res.body.network.cidr, '10.50.0.0/24');
  assert.equal(res.body.network.gateway, '10.50.0.1');
  assert.deepEqual(res.body.counts, { devices: 0, online: 0, offline: 0 });
});

test('roles: a normal user cannot read audit or manage users', async () => {
  await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'viewer1', password: 'ViewOnly2026', role: 'user' }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ username: 'viewer1', password: 'ViewOnly2026' }).expect(200);
  const vt = login.body.token;
  await request(app).get('/api/audit').set('Authorization', `Bearer ${vt}`).expect(403);
  await request(app).get('/api/users').set('Authorization', `Bearer ${vt}`).expect(403);
  await request(app).get('/api/network').set('Authorization', `Bearer ${vt}`).expect(200);
});

test('admin cannot demote themselves', async () => {
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  await request(app).patch(`/api/users/${me.body.user.id}`).set('Authorization', `Bearer ${adminToken}`)
    .send({ role: 'user' }).expect(400);
});

test('audit trail records setup, logins and failures', async () => {
  const res = await request(app).get('/api/audit?limit=100').set('Authorization', `Bearer ${adminToken}`).expect(200);
  const actions = res.body.entries.map((e) => `${e.action}:${e.result}`);
  assert.ok(actions.includes('system.setup:success'));
  assert.ok(actions.includes('auth.login:success'));
  assert.ok(actions.includes('auth.login:failure'));
  assert.ok(actions.includes('user.create:success'));
  // Secrets never land in audit details.
  assert.ok(!JSON.stringify(res.body).includes('NexusLab2026'));
});

test('audit log is append-only', async () => {
  const { AuditLog } = await import('../src/models/AuditLog.js');
  await assert.rejects(AuditLog.deleteMany({}), /append-only/);
});

test('validation errors are structured, not stack traces', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: '' }).expect(400);
  assert.equal(res.body.error.code, 'VALIDATION');
  assert.equal(res.body.error.stack, undefined);
});

/** Opens a socket and buffers every message so none are missed. */
function openSocket() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/console`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else inbox.push(msg);
  });
  const next = (pred = () => true) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve) => waiters.push({ pred, resolve }));
  };
  const opened = new Promise((r) => ws.once('open', r));
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));
  return { ws, next, opened, closed };
}

test('console WebSocket: auth, snapshot, PING/PONG RTT, live audit', async () => {
  const s = openSocket();
  await s.opened;
  s.ws.send(encode(createMessage(MessageType.AUTH_REQUEST, { token: adminToken })));

  const auth = await s.next((m) => m.type === 'AUTH_RESPONSE');
  assert.equal(auth.payload.ok, true);
  const snap = await s.next((m) => m.type === 'STATE_SNAPSHOT');
  assert.equal(snap.payload.network.gateway, '10.50.0.1');

  const t0 = Date.now();
  s.ws.send(encode(createMessage(MessageType.PING, { seq: 1, t0 })));
  const pong = await s.next((m) => m.type === 'PONG');
  assert.equal(pong.payload.seq, 1);
  assert.equal(pong.payload.t0, t0);

  // A login elsewhere shows up live on the admin's socket.
  await request(app).post('/api/auth/login').send({ username: 'viewer1', password: 'ViewOnly2026' });
  const evt = await s.next((m) => m.type === 'EVENT' && m.payload.entry.action === 'auth.login');
  assert.equal(evt.payload.kind, 'audit');

  s.ws.send('not json');
  const err = await s.next((m) => m.type === 'ERROR');
  assert.equal(err.payload.code, 'BAD_MESSAGE');
  s.ws.close();
});

test('console WebSocket rejects bad tokens and closes on logout', async () => {
  const bad = openSocket();
  await bad.opened;
  bad.ws.send(encode(createMessage(MessageType.AUTH_REQUEST, { token: 'nope' })));
  assert.equal(await bad.closed, 4003);

  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'NexusLab2026' });
  const token = login.body.token;
  const s = openSocket();
  await s.opened;
  s.ws.send(encode(createMessage(MessageType.AUTH_REQUEST, { token })));
  await s.next((m) => m.type === 'STATE_SNAPSHOT');

  await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`).expect(200);
  assert.equal(await s.closed, 4003);
  await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
});

test('account locks after repeated failures', async () => {
  for (let i = 0; i < 5; i += 1) {
    await request(app).post('/api/auth/login').send({ username: 'viewer1', password: 'badpassword1' });
  }
  const res = await request(app).post('/api/auth/login').send({ username: 'viewer1', password: 'ViewOnly2026' });
  assert.equal(res.status, 423);
});
