import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import {
  MessageType, ErrorCode, createMessage, encode, decode, errorMessage,
} from '@nexus/protocol';
import { Device } from '../models/Device.js';
import { EnrollmentToken, Metric } from '../models/Telemetry.js';
import { agents, sha256, safeEqualHex } from '../services/agents.js';
import { audit } from '../services/audit.js';
import { bus } from '../services/bus.js';
import * as wg from '../services/wireguard.js';
import { evaluateSample, deviceOffline, deviceOnline } from '../services/alerts.js';
import { log } from '../utils/logger.js';

const AUTH_DEADLINE_MS = 10_000;
const PING_EVERY_MS = 10_000;
const RATE_PER_SEC = 30;

const registerSchema = z.object({
  enrollmentToken: z.string().min(8).max(128),
  hostname: z.string().trim().min(1).max(64),
  os: z.string().max(64).optional(),
  osVersion: z.string().max(128).optional(),
  arch: z.string().max(32).optional(),
  agentVersion: z.string().max(32).optional(),
  cpuModel: z.string().max(128).optional(),
  cpuCores: z.number().int().min(1).max(1024).optional(),
  ramTotal: z.number().min(0).optional(),
  physicalIp: z.string().max(64).optional(),
  publicKey: z.string().max(64).optional(),
  simulated: z.boolean().optional(),
  capabilities: z.record(z.string(), z.boolean()).optional(),
});

const num = (max) => z.number().finite().min(0).max(max).nullable().optional();
const metricSchema = z.object({
  cpuPct: num(100), ramPct: num(100), diskPct: num(100),
  rxBps: num(1e12), txBps: num(1e12),
  latencyMs: num(1e6), packetLossPct: num(100),
  uptimeSec: num(1e10), processCount: num(1e6), connCount: num(1e7),
});

/**
 * Agent hub: /ws/agent. Agents talk to the server here (over the VPN once the
 * tunnel is up). First frame is either:
 *   DEVICE_REGISTER {enrollmentToken, hostname, os, publicKey, …}  (new device)
 *   AUTH_REQUEST    {deviceId, deviceSecret, …}                    (known device)
 * A device secret is issued at registration and stored hashed; the device
 * stays PENDING (no telemetry accepted) until an admin approves it.
 */
export function attachAgentHub(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const sockets = new Set();

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws/agent') return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const ctx = {
      ws,
      ip: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
      deviceId: null,
      approved: false,
      alive: true,
      tokens: RATE_PER_SEC,
      lastRefill: Date.now(),
      pingSeq: 0,
      pings: new Map(),
    };
    sockets.add(ctx);
    const authTimer = setTimeout(() => { if (!ctx.deviceId) close(ctx, 4001, 'Authentication timeout'); }, AUTH_DEADLINE_MS);

    ws.on('pong', () => { ctx.alive = true; });
    ws.on('message', (raw, isBinary) => handle(ctx, raw, isBinary).catch((err) => {
      log.error('ws.agent.handler_failed', { reason: err.message, deviceId: ctx.deviceId });
      send(ctx, errorMessage(ErrorCode.INTERNAL, 'Internal error'));
    }));
    ws.on('close', () => {
      clearTimeout(authTimer);
      sockets.delete(ctx);
      if (ctx.deviceId && pendingSockets.get(ctx.deviceId) === ctx) pendingSockets.delete(ctx.deviceId);
      if (ctx.deviceId && ctx.approved && agents.get(ctx.deviceId) === ctx) {
        agents.delete(ctx.deviceId, ctx);
        markDisconnected(ctx.deviceId).catch(() => {});
      }
    });
    ws.on('error', (err) => log.warn('ws.agent.socket_error', { reason: err.message }));
  });

  async function handle(ctx, raw, isBinary) {
    if (isBinary) return send(ctx, errorMessage(ErrorCode.BAD_MESSAGE, 'Binary frames belong on the session channel'));
    if (!takeToken(ctx)) return send(ctx, errorMessage(ErrorCode.RATE_LIMITED, 'Slow down'));
    const res = decode(raw);
    if (!res.ok) return send(ctx, errorMessage(res.code, res.reason));
    const msg = res.message;

    if (!ctx.deviceId) {
      if (msg.type === MessageType.DEVICE_REGISTER) return register(ctx, msg.payload);
      if (msg.type === MessageType.AUTH_REQUEST) return authenticate(ctx, msg.payload);
      return close(ctx, 4001, 'Authenticate first');
    }
    if (!ctx.approved) return undefined; // pending devices may only wait

    switch (msg.type) {
      case MessageType.HEARTBEAT:
        await Device.updateOne({ deviceId: ctx.deviceId }, { $set: { lastSeen: new Date() } });
        return undefined;
      case MessageType.METRIC_UPDATE:
        return onMetrics(ctx, msg.payload);
      case MessageType.NETWORK_UPDATE:
        await Device.updateOne({ deviceId: ctx.deviceId }, { $set: { net: trimNet(msg.payload), lastSeen: new Date() } });
        bus.emit('device.detail', ctx.deviceId);
        return undefined;
      case MessageType.PROCESS_UPDATE:
        await Device.updateOne({ deviceId: ctx.deviceId }, {
          $set: { processes: Array.isArray(msg.payload.processes) ? msg.payload.processes.slice(0, 25) : [] },
        });
        bus.emit('device.detail', ctx.deviceId);
        return undefined;
      case MessageType.PONG:
        return onPong(ctx, msg.payload);
      case MessageType.PING:
        return send(ctx, createMessage(MessageType.PONG, { seq: msg.payload.seq ?? null, t0: msg.payload.t0 ?? null }));
      case MessageType.COMMAND_RESPONSE:
        agents.resolveCommand(msg.payload);
        return undefined;
      case MessageType.SESSION_END:
        bus.emit('session.agent_end', { deviceId: ctx.deviceId, sessionId: msg.sessionId || msg.payload.sessionId, reason: msg.payload.reason });
        return undefined;
      default:
        return send(ctx, errorMessage(ErrorCode.UNKNOWN_TYPE, `${msg.type} is not handled on the agent channel`, msg.messageId));
    }
  }

  async function register(ctx, payload) {
    const body = registerSchema.safeParse(payload);
    if (!body.success) return rejectAndClose(ctx, 'Registration details are invalid.');
    const p = body.data;

    const token = await EnrollmentToken.findOne({ tokenHash: sha256(p.enrollmentToken) });
    if (!token || token.revokedAt || token.expiresAt < new Date() || token.uses >= token.maxUses) {
      await audit({ actorType: 'agent', action: 'device.enroll', result: 'denied', ip: ctx.ip, deviceName: p.hostname, details: { reason: 'bad_token' } });
      return rejectAndClose(ctx, 'The enrollment token is invalid, expired or already used. Ask an admin for a new one.');
    }
    if (p.publicKey && !wg.isValidWgKey(p.publicKey)) return rejectAndClose(ctx, 'The WireGuard public key is malformed.');

    const deviceId = crypto.randomUUID();
    const deviceSecret = crypto.randomBytes(32).toString('base64url');
    const device = await Device.create({
      deviceId,
      hostname: p.hostname,
      os: p.os, osVersion: p.osVersion, arch: p.arch, agentVersion: p.agentVersion,
      cpuModel: p.cpuModel, cpuCores: p.cpuCores, ramTotal: p.ramTotal,
      physicalIp: p.physicalIp || ctx.ip,
      publicKey: p.publicKey,
      secretHash: sha256(deviceSecret),
      simulated: Boolean(p.simulated),
      capabilities: p.capabilities || {},
      status: 'PENDING',
      approval: { state: 'pending' },
      enrolledAt: new Date(),
    });
    token.uses += 1;
    token.usedBy.push(deviceId);
    await token.save();

    ctx.deviceId = deviceId;
    ctx.approved = false;
    pendingSockets.set(deviceId, ctx);
    send(ctx, createMessage(MessageType.DEVICE_PENDING, { deviceId, deviceSecret, message: 'Waiting for an administrator to approve this device.' }));
    await audit({
      actorType: 'agent', action: 'device.enroll', ip: ctx.ip, deviceId, deviceName: device.hostname,
      details: { simulated: device.simulated, tokenLabel: token.label },
    });
    bus.emit('enrollment.changed');
    log.info('agent.registered', { deviceId, hostname: device.hostname, ip: ctx.ip });
    return undefined;
  }

  async function authenticate(ctx, payload) {
    const deviceId = String(payload.deviceId || '');
    const device = await Device.findOne({ deviceId }).select('+secretHash');
    if (!device || !safeEqualHex(device.secretHash, sha256(payload.deviceSecret || ''))) {
      send(ctx, createMessage(MessageType.AUTH_RESPONSE, { ok: false, reason: 'Unknown device or wrong secret. Re-enroll this agent.' }));
      return close(ctx, 4003, 'Unauthorized');
    }
    if (device.approval.state === 'rejected') return rejectAndClose(ctx, 'This device was rejected by an administrator.');

    ctx.deviceId = deviceId;
    if (device.approval.state === 'pending') {
      pendingSockets.set(deviceId, ctx);
      send(ctx, createMessage(MessageType.DEVICE_PENDING, { deviceId, message: 'Still waiting for an administrator to approve this device.' }));
      return undefined;
    }
    await goLive(ctx, device, payload);
    return undefined;
  }

  /** Approved device: accept telemetry, report tunnel info, start PING. */
  async function goLive(ctx, device, payload = {}) {
    ctx.approved = true;
    pendingSockets.delete(device.deviceId);
    agents.set(device.deviceId, ctx);

    const tunnelMode = wg.status().mode === 'wireguard' && !device.simulated && payload.tunnel?.mode === 'wireguard'
      ? 'wireguard'
      : device.simulated ? 'simulated' : (payload.tunnel?.mode === 'wireguard' ? 'wireguard' : 'direct');
    device.status = 'CONNECTED';
    device.lastSeen = new Date();
    device.connectedAt = new Date();
    if (payload.physicalIp) device.physicalIp = String(payload.physicalIp).slice(0, 64);
    if (payload.agentVersion) device.agentVersion = String(payload.agentVersion).slice(0, 32);
    if (payload.capabilities && typeof payload.capabilities === 'object') device.capabilities = payload.capabilities;
    device.tunnel = { ...(device.tunnel?.toObject?.() || {}), mode: tunnelMode, up: tunnelMode !== 'direct' };
    await device.save();

    send(ctx, createMessage(MessageType.AUTH_RESPONSE, {
      ok: true,
      deviceId: device.deviceId,
      virtualIp: device.virtualIp,
      hub: { publicKey: wg.hub().publicKey, endpoint: wg.endpoint(), address: '10.50.0.1', allowedIps: '10.50.0.0/24', mode: wg.status().mode },
      intervals: { metricsSec: 5, networkSec: 15, processSec: 15, pingBurstSec: 30 },
    }));
    await deviceOnline(device);
    bus.emit('devices.changed');
    log.info('agent.connected', { deviceId: device.deviceId, hostname: device.hostname, ip: ctx.ip, tunnel: tunnelMode });
  }

  async function onMetrics(ctx, payload) {
    const parsed = metricSchema.safeParse(payload);
    if (!parsed.success) return send(ctx, errorMessage(ErrorCode.BAD_MESSAGE, 'Invalid metrics'));
    const m = parsed.data;
    const device = await Device.findOne({ deviceId: ctx.deviceId });
    if (!device) return undefined;

    const latest = { ...(device.latest?.toObject?.() || {}), ...stripNull(m), at: new Date() };
    device.latest = latest;
    device.lastSeen = new Date();
    const degraded = (m.packetLossPct ?? 0) >= 20 || (m.latencyMs ?? 0) >= 300;
    device.status = degraded ? 'DEGRADED' : 'CONNECTED';
    await device.save();

    await Metric.create({
      deviceId: device.deviceId, t: new Date(), sim: device.simulated,
      cpu: m.cpuPct, ram: m.ramPct, disk: m.diskPct, rx: m.rxBps, tx: m.txBps,
      lat: m.latencyMs, loss: m.packetLossPct, rtt: device.latest.appRttMs, conn: m.connCount,
    });
    await evaluateSample(device, latest);
    bus.emit('devices.changed');
    return undefined;
  }

  async function onPong(ctx, payload) {
    const sentAt = ctx.pings.get(payload.seq);
    if (sentAt == null) return;
    ctx.pings.delete(payload.seq);
    const rtt = Math.round(Number(process.hrtime.bigint() - sentAt) / 1e6);
    await Device.updateOne({ deviceId: ctx.deviceId }, { $set: { 'latest.appRttMs': rtt, lastSeen: new Date() } });
  }

  // Server-originated PING (D3: app-level RTT measured with the server's clock).
  const pinger = setInterval(() => {
    for (const ctx of sockets) {
      if (!ctx.approved) continue;
      ctx.pingSeq += 1;
      ctx.pings.set(ctx.pingSeq, process.hrtime.bigint());
      if (ctx.pings.size > 10) ctx.pings.delete(ctx.pings.keys().next().value);
      send(ctx, createMessage(MessageType.PING, { seq: ctx.pingSeq, t0: Date.now() }));
    }
  }, PING_EVERY_MS);

  const heartbeat = setInterval(() => {
    for (const ctx of sockets) {
      if (!ctx.alive) { ctx.ws.terminate(); continue; }
      ctx.alive = false;
      ctx.ws.ping();
    }
  }, 20_000);

  // Approval / rejection from the REST API reaches a waiting agent here.
  const pendingSockets = new Map();
  const onApproved = async ({ deviceId }) => {
    const ctx = pendingSockets.get(deviceId);
    if (!ctx) return;
    const device = await Device.findOne({ deviceId });
    send(ctx, createMessage(MessageType.DEVICE_APPROVED, {
      deviceId, virtualIp: device.virtualIp,
      hub: { publicKey: wg.hub().publicKey, endpoint: wg.endpoint(), address: '10.50.0.1', allowedIps: '10.50.0.0/24', mode: wg.status().mode },
    }));
    await goLive(ctx, device);
  };
  const onRejected = ({ deviceId }) => {
    const ctx = pendingSockets.get(deviceId) || agents.get(deviceId);
    if (ctx) rejectAndClose(ctx, 'This device was rejected or removed by an administrator.');
  };
  bus.on('device.approved', onApproved);
  bus.on('device.rejected', onRejected);

  return {
    close() {
      clearInterval(pinger);
      clearInterval(heartbeat);
      bus.off('device.approved', onApproved);
      bus.off('device.rejected', onRejected);
      for (const ctx of sockets) ctx.ws.terminate();
      wss.close();
    },
  };
}

async function markDisconnected(deviceId) {
  const device = await Device.findOne({ deviceId });
  if (!device || device.approval.state !== 'approved') return;
  device.status = 'DISCONNECTED';
  device.lastSeen = new Date();
  if (device.tunnel?.mode !== 'wireguard') device.tunnel.up = false;
  await device.save();
  await deviceOffline(device);
  bus.emit('devices.changed');
  log.info('agent.disconnected', { deviceId, hostname: device.hostname });
}

function trimNet(p) {
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  return {
    at: new Date(),
    interfaces: arr(p.interfaces, 16),
    connections: arr(p.connections, 300),
    listening: arr(p.listening, 200),
    protocols: p.protocols && typeof p.protocols === 'object' ? p.protocols : {},
    totals: p.totals && typeof p.totals === 'object' ? p.totals : {},
  };
}

const stripNull = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

function rejectAndClose(ctx, reason) {
  send(ctx, createMessage(MessageType.DEVICE_REJECTED, { reason }));
  close(ctx, 4003, 'Rejected');
}

function takeToken(ctx) {
  const now = Date.now();
  ctx.tokens = Math.min(RATE_PER_SEC, ctx.tokens + ((now - ctx.lastRefill) / 1000) * RATE_PER_SEC);
  ctx.lastRefill = now;
  if (ctx.tokens < 1) return false;
  ctx.tokens -= 1;
  return true;
}

function send(ctx, msg) {
  if (ctx.ws.readyState === ctx.ws.OPEN) ctx.ws.send(encode(msg));
}

function close(ctx, code, reason) {
  try { ctx.ws.close(code, reason); } catch { ctx.ws.terminate(); }
}
