import { WebSocketServer } from 'ws';
import {
  MessageType, ErrorCode, createMessage, encode, decode, errorMessage, checkAllowlistedCommand,
} from '@nexus/protocol';
import { RemoteSession } from '../models/Telemetry.js';
import { Device } from '../models/Device.js';
import { authenticateToken } from '../services/auth.js';
import { sha256, safeEqualHex } from '../services/agents.js';
import { endSession } from '../services/sessions.js';
import { audit } from '../services/audit.js';
import { bus } from '../services/bus.js';
import { log } from '../utils/logger.js';

const AUTH_DEADLINE_MS = 8000;
const PAIR_DEADLINE_MS = 20_000;
const AUDITED_FILE_OPS = new Set(['upload_start', 'download', 'delete', 'mkdir', 'rename']);

/**
 * Session relay:
 *   console  ⇄ /ws/session        (user JWT + single-use session token)
 *   agent    ⇄ /ws/agent-session  (device secret + sessionId)
 * The hub pairs both ends and relays frames. Binary frames (screen JPEGs,
 * file chunks) pass through untouched; JSON frames are checked against the
 * session's kind and policy, and privileged actions are audited.
 */
export function attachSessionHub(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const pairs = new Map(); // sessionId -> pair

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws/session' && pathname !== '/ws/agent-session') return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, pathname === '/ws/agent-session' ? 'agent' : 'console'));
  });

  wss.on('connection', (ws, req, side) => {
    const ctx = { ws, side, ip: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''), pair: null };
    const authTimer = setTimeout(() => { if (!ctx.pair) close(ws, 4001, 'Authentication timeout'); }, AUTH_DEADLINE_MS);

    ws.on('message', (raw, isBinary) => {
      if (!ctx.pair) {
        if (isBinary) return close(ws, 4001, 'Authenticate first');
        return (side === 'agent' ? authAgent(ctx, raw) : authConsole(ctx, raw)).catch((err) => {
          log.warn('ws.session.auth_failed', { side, reason: err.message });
          send(ws, errorMessage(ErrorCode.UNAUTHORIZED, err.message));
          close(ws, 4003, 'Unauthorized');
        });
      }
      return relay(ctx, raw, isBinary).catch((err) => log.error('ws.session.relay_failed', { reason: err.message }));
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      const pair = ctx.pair;
      if (!pair || pair[side] !== ctx) return;
      pair[side] = null;
      finish(pair, side === 'agent' ? 'Device ended the session' : 'Console disconnected');
    });
    ws.on('error', () => {});
  });

  function pairFor(session) {
    let pair = pairs.get(session.sessionId);
    if (!pair) {
      pair = {
        sessionId: session.sessionId, kind: session.kind, deviceId: session.deviceId, hostname: session.hostname,
        fullShell: session.fullShell, role: session.role, userId: session.userId?.toString(), username: session.username,
        console: null, agent: null, active: false, ended: false,
        stats: { frames: 0, bytesDown: 0, bytesUp: 0, inputs: 0, commands: 0, fileOps: 0 },
        timer: setTimeout(() => {
          if (!pair.active) finish(pair, 'The device did not join the session in time.');
        }, PAIR_DEADLINE_MS),
      };
      pairs.set(session.sessionId, pair);
    }
    return pair;
  }

  async function authConsole(ctx, raw) {
    const res = decode(raw);
    if (!res.ok || res.message.type !== MessageType.AUTH_REQUEST) throw new Error('Authenticate first');
    const { token, sessionId, sessionToken } = res.message.payload;
    const { user } = await authenticateToken(String(token || ''));
    const s = await RemoteSession.findOne({ sessionId: String(sessionId || '') }).select('+tokenHash');
    if (!s || !s.userId?.equals(user._id)) throw new Error('Session not found.');
    if (!['approved', 'active'].includes(s.status)) throw new Error(`This session is ${s.status}.`);
    if (!s.tokenHash || !safeEqualHex(s.tokenHash, sha256(sessionToken || '')) || s.tokenExpiresAt < new Date()) {
      throw new Error('The session link expired. Connect again.');
    }
    s.tokenHash = undefined; // single use
    await s.save();

    const pair = pairFor(s);
    if (pair.console) close(pair.console.ws, 4009, 'Replaced by a newer connection');
    pair.console = ctx;
    ctx.pair = pair;
    ctx.user = user;
    maybeStart(pair);
  }

  async function authAgent(ctx, raw) {
    const res = decode(raw);
    if (!res.ok || res.message.type !== MessageType.AUTH_REQUEST) throw new Error('Authenticate first');
    const { deviceId, deviceSecret, sessionId } = res.message.payload;
    const device = await Device.findOne({ deviceId: String(deviceId || '') }).select('+secretHash');
    if (!device || !safeEqualHex(device.secretHash, sha256(deviceSecret || ''))) throw new Error('Unknown device.');
    const s = await RemoteSession.findOne({ sessionId: String(sessionId || ''), deviceId: device.deviceId });
    if (!s || !['approved', 'active'].includes(s.status)) throw new Error('No such session for this device.');

    const pair = pairFor(s);
    if (pair.agent) close(pair.agent.ws, 4009, 'Replaced by a newer connection');
    pair.agent = ctx;
    ctx.pair = pair;
    maybeStart(pair);
  }

  async function maybeStart(pair) {
    if (!pair.console || !pair.agent || pair.active) return;
    pair.active = true;
    clearTimeout(pair.timer);
    const ready = createMessage(MessageType.SESSION_READY, {
      sessionId: pair.sessionId, kind: pair.kind, hostname: pair.hostname, fullShell: pair.fullShell, role: pair.role,
    }, { sessionId: pair.sessionId });
    send(pair.console.ws, ready);
    send(pair.agent.ws, ready);
    await RemoteSession.updateOne({ sessionId: pair.sessionId }, { $set: { status: 'active', startedAt: new Date() } });
    await audit({
      user: pair.console.user, action: 'session.start', deviceId: pair.deviceId, deviceName: pair.hostname,
      ip: pair.console.ip, details: { remoteSession: pair.sessionId, kind: pair.kind, fullShell: pair.fullShell },
    });
    bus.emit('sessions.changed');
  }

  async function relay(ctx, raw, isBinary) {
    const pair = ctx.pair;
    if (!pair.active) return;
    const other = ctx.side === 'agent' ? pair.console : pair.agent;
    if (!other) return;

    if (isBinary) {
      if (ctx.side === 'agent') {
        pair.stats.bytesDown += raw.length;
        if (raw[0] === 1) pair.stats.frames += 1;
      } else {
        if (pair.kind !== 'files') return; // only uploads flow console → agent as binary
        pair.stats.bytesUp += raw.length;
      }
      if (other.ws.bufferedAmount < 16 * 1024 * 1024) other.ws.send(raw, { binary: true });
      return;
    }

    const res = decode(raw);
    if (!res.ok) return send(ctx.ws, errorMessage(res.code, res.reason));
    const msg = res.message;

    if (msg.type === MessageType.SESSION_END) {
      return finish(pair, ctx.side === 'agent' ? (msg.payload.reason || 'Device ended the session') : 'Ended by operator');
    }

    if (ctx.side === 'console') {
      if (msg.type === MessageType.REMOTE_INPUT) {
        if (pair.kind !== 'desktop') return undefined;
        pair.stats.inputs += 1;
      } else if (msg.type === MessageType.FILE_REQUEST) {
        if (pair.kind !== 'files') return undefined;
        pair.stats.fileOps += 1;
        if (AUDITED_FILE_OPS.has(msg.payload.op)) {
          await audit({
            user: ctx.user, action: `file.${msg.payload.op === 'upload_start' ? 'upload' : msg.payload.op}`, deviceId: pair.deviceId, deviceName: pair.hostname,
            ip: ctx.ip, details: { remoteSession: pair.sessionId, path: String(msg.payload.path || '').slice(0, 300), name: msg.payload.name },
          });
        }
      } else if (msg.type === MessageType.COMMAND_REQUEST) {
        if (pair.kind !== 'terminal') return undefined;
        const line = String(msg.payload.command || '');
        const reason = pair.fullShell ? null : checkAllowlistedCommand(line);
        pair.stats.commands += 1;
        await audit({
          user: ctx.user, action: 'terminal.command', result: reason ? 'denied' : 'success',
          deviceId: pair.deviceId, deviceName: pair.hostname, ip: ctx.ip,
          details: { remoteSession: pair.sessionId, command: line.slice(0, 300), mode: pair.fullShell ? 'full' : 'allowlist', reason },
        });
        if (reason) {
          return send(ctx.ws, createMessage(MessageType.COMMAND_RESPONSE, {
            commandId: msg.payload.commandId, ok: false, exitCode: -1, stdout: '', stderr: reason, blocked: true,
          }, { sessionId: pair.sessionId }));
        }
      } else if (![MessageType.PING, MessageType.SESSION_STATS].includes(msg.type)) {
        return undefined;
      }
    }
    return other.ws.send(encode(msg));
  }

  async function finish(pair, reason) {
    if (pair.ended) return;
    pair.ended = true;
    clearTimeout(pair.timer);
    pairs.delete(pair.sessionId);
    const end = createMessage(MessageType.SESSION_END, { sessionId: pair.sessionId, reason }, { sessionId: pair.sessionId });
    for (const side of ['console', 'agent']) {
      if (pair[side]) {
        send(pair[side].ws, end);
        close(pair[side].ws, 1000, 'Session ended');
      }
    }
    await RemoteSession.updateOne({ sessionId: pair.sessionId }, { $set: { stats: pair.stats } });
    await endSession(pair.sessionId, reason, pair.console?.user);
  }

  const onKill = ({ sessionId, reason }) => {
    const pair = pairs.get(sessionId);
    if (pair) finish(pair, reason);
  };
  const onAgentEnd = ({ sessionId, reason }) => {
    const pair = pairs.get(sessionId);
    if (pair) finish(pair, reason || 'Device ended the session');
  };
  bus.on('session.kill', onKill);
  bus.on('session.agent_end', onAgentEnd);

  return {
    activeCount: () => [...pairs.values()].filter((p) => p.active).length,
    close() {
      bus.off('session.kill', onKill);
      bus.off('session.agent_end', onAgentEnd);
      for (const pair of pairs.values()) {
        clearTimeout(pair.timer);
        pair.console?.ws.terminate();
        pair.agent?.ws.terminate();
      }
      wss.close();
    },
  };
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(encode(msg));
}

function close(ws, code, reason) {
  try { ws.close(code, reason); } catch { ws.terminate(); }
}
