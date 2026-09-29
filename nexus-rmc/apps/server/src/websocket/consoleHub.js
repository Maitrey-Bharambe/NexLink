import { WebSocketServer } from 'ws';
import {
  MessageType, ErrorCode, NETWORK, createMessage, encode, decode, errorMessage,
} from '@nexus/protocol';
import { authenticateToken } from '../services/auth.js';
import { bus } from '../services/bus.js';
import { dbState } from '../config/db.js';
import { Device, deviceScope } from '../models/Device.js';
import { User } from '../models/User.js';
import { RemoteSession, Alert } from '../models/Telemetry.js';
import * as wg from '../services/wireguard.js';
import { log } from '../utils/logger.js';

const AUTH_DEADLINE_MS = 5000;
const HEARTBEAT_MS = 15_000;
const RATE_PER_SEC = 50;

/**
 * Console hub: real-time channel between the admin desktop app and the server.
 *
 *  1. Client connects to /ws/console.
 *  2. First message must be AUTH_REQUEST { token } within 5 s. The token is
 *     not put in the URL, so it never ends up in proxy or access logs.
 *  3. Server replies AUTH_RESPONSE, then STATE_SNAPSHOT.
 *  4. Client PING { seq, t0 } → server PONG echo (client computes RTT).
 *  5. WS-level ping every 15 s; a client that misses one is terminated.
 */
export function attachConsoleHub(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws/console') return; // agent and session hubs attach separately
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const ctx = {
      ws,
      ip: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
      user: null,
      jti: null,
      alive: true,
      tokens: RATE_PER_SEC,
      lastRefill: Date.now(),
    };
    clients.add(ctx);

    const authTimer = setTimeout(() => {
      if (!ctx.user) close(ctx, 4001, 'Authentication timeout');
    }, AUTH_DEADLINE_MS);

    ws.on('pong', () => { ctx.alive = true; });
    ws.on('message', (raw, isBinary) => handle(ctx, raw, isBinary).catch((err) => {
      log.error('ws.console.handler_failed', { reason: err.message });
      send(ctx, errorMessage(ErrorCode.INTERNAL, 'Internal error'));
    }));
    ws.on('close', () => {
      clearTimeout(authTimer);
      clients.delete(ctx);
      if (ctx.user) log.info('ws.console.disconnected', { user: ctx.user.username, ip: ctx.ip });
    });
    ws.on('error', (err) => log.warn('ws.console.socket_error', { reason: err.message }));
  });

  async function handle(ctx, raw, isBinary) {
    if (isBinary) return send(ctx, errorMessage(ErrorCode.BAD_MESSAGE, 'Binary frames not accepted here'));
    if (!takeToken(ctx)) return send(ctx, errorMessage(ErrorCode.RATE_LIMITED, 'Slow down'));

    const res = decode(raw);
    if (!res.ok) return send(ctx, errorMessage(res.code, res.reason));
    const msg = res.message;

    if (!ctx.user) {
      if (msg.type !== MessageType.AUTH_REQUEST) {
        return close(ctx, 4001, 'Authenticate first');
      }
      try {
        const { user, session } = await authenticateToken(String(msg.payload.token || ''));
        ctx.user = user;
        ctx.jti = session.jti;
        send(ctx, createMessage(MessageType.AUTH_RESPONSE, { ok: true, user: user.toSafeJSON() }));
        send(ctx, await snapshot(user));
        log.info('ws.console.authenticated', { user: user.username, ip: ctx.ip });
      } catch (err) {
        send(ctx, createMessage(MessageType.AUTH_RESPONSE, { ok: false, reason: err.message }));
        close(ctx, 4003, 'Unauthorized');
      }
      return;
    }

    switch (msg.type) {
      case MessageType.PING:
        return send(ctx, createMessage(MessageType.PONG, {
          seq: msg.payload.seq ?? null,
          t0: msg.payload.t0 ?? null,
          serverTime: Date.now(),
        }));
      default:
        return send(ctx, errorMessage(ErrorCode.UNKNOWN_TYPE, `${msg.type} is not handled on the console channel yet`, msg.messageId));
    }
  }

  // Liveness sweep.
  const heartbeat = setInterval(() => {
    for (const ctx of clients) {
      if (!ctx.alive) { ctx.ws.terminate(); continue; }
      ctx.alive = false;
      ctx.ws.ping();
    }
  }, HEARTBEAT_MS);

  // Live audit feed to admins.
  const onAudit = (entry) => {
    const msg = createMessage(MessageType.EVENT, { kind: 'audit', entry: entry.toObject() });
    for (const ctx of clients) if (ctx.user?.role === 'admin') send(ctx, msg);
  };
  const toAdmins = (payload) => {
    const msg = createMessage(MessageType.EVENT, payload);
    for (const ctx of clients) if (ctx.user?.role === 'admin') send(ctx, msg);
  };
  const toAll = (payload) => {
    const msg = createMessage(MessageType.EVENT, payload);
    for (const ctx of clients) if (ctx.user) send(ctx, msg);
  };
  // Logout / disable closes that session's sockets immediately.
  const onRevoked = (jti) => {
    for (const ctx of clients) if (ctx.jti === jti) close(ctx, 4003, 'Session ended');
  };
  // Snapshots are per user (scope differs), so coalesce bursts to one per second.
  let snapTimer = null;
  const onDevices = () => {
    if (snapTimer) return;
    snapTimer = setTimeout(async () => {
      snapTimer = null;
      for (const ctx of clients) {
        if (!ctx.user) continue;
        // eslint-disable-next-line no-await-in-loop
        try { send(ctx, await snapshot(ctx.user)); } catch { /* next tick */ }
      }
    }, 1000);
  };
  const onAlert = (alert) => { toAll({ kind: 'alert', alert }); onDevices(); };
  const onAlertsChanged = () => { toAll({ kind: 'alerts' }); onDevices(); };
  const onSessions = () => { toAll({ kind: 'sessions' }); onDevices(); };
  const onDecided = ({ userId, session }) => {
    const msg = createMessage(MessageType.EVENT, { kind: 'session.decided', session });
    for (const ctx of clients) if (ctx.user?._id.toString() === userId) send(ctx, msg);
  };
  const onUsers = () => { toAdmins({ kind: 'users' }); onDevices(); };
  const onEnrollment = () => { toAdmins({ kind: 'enrollment' }); onDevices(); };
  const onDetail = (deviceId) => toAll({ kind: 'device', deviceId });
  const subs = {
    audit: onAudit, 'session.revoked': onRevoked, 'devices.changed': onDevices, alert: onAlert,
    'alerts.changed': onAlertsChanged, 'sessions.changed': onSessions, 'session.decided': onDecided,
    'users.changed': onUsers, 'enrollment.changed': onEnrollment, 'device.detail': onDetail,
  };
  for (const [evt, fn] of Object.entries(subs)) bus.on(evt, fn);

  return {
    clientCount: () => clients.size,
    close() {
      clearInterval(heartbeat);
      clearTimeout(snapTimer);
      for (const [evt, fn] of Object.entries(subs)) bus.off(evt, fn);
      for (const ctx of clients) ctx.ws.terminate();
      wss.close();
    },
  };
}

async function snapshot(user) {
  const isAdmin = user.role === 'admin';
  const scope = { ...deviceScope(user), 'approval.state': 'approved' };
  const devices = await Device.find(scope).sort({ virtualIp: 1 });
  const ids = devices.map((d) => d.deviceId);
  const hub = wg.status();
  const [alertCounts, pendingDevices, pendingUsers, sessionRequests, activeSessions, mySessions] = await Promise.all([
    Alert.aggregate([{ $match: { status: { $ne: 'resolved' }, deviceId: { $in: ids } } }, { $group: { _id: '$severity', n: { $sum: 1 } } }]),
    isAdmin ? Device.countDocuments({ 'approval.state': 'pending' }) : 0,
    isAdmin ? User.countDocuments({ status: 'pending' }) : 0,
    isAdmin ? RemoteSession.countDocuments({ status: 'requested' }) : 0,
    RemoteSession.countDocuments({ status: 'active', ...(isAdmin ? {} : { userId: user._id }) }),
    isAdmin ? 0 : RemoteSession.countDocuments({ userId: user._id, status: { $in: ['requested', 'approved'] } }),
  ]);
  return createMessage(MessageType.STATE_SNAPSHOT, {
    network: NETWORK,
    server: { db: dbState(), time: Date.now() },
    vpn: { state: hub.mode === 'wireguard' ? 'CONNECTED' : 'SIMULATED', mode: hub.mode, reason: hub.reason, endpoint: hub.endpoint },
    devices: devices.map((d) => d.toSummary()),
    counts: {
      alerts: Object.fromEntries(alertCounts.map((c) => [c._id, c.n])),
      pendingDevices, pendingUsers, sessionRequests, activeSessions, mySessions,
    },
  });
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
