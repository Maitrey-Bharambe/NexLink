import crypto from 'node:crypto';
import { MessageType, createMessage, encode } from '@nexus/protocol';

/**
 * Registry of live agent control sockets (deviceId -> ctx), plus a small
 * request/response helper for COMMAND_REQUEST → COMMAND_RESPONSE.
 */
const live = new Map();
const pendingCommands = new Map(); // commandId -> { resolve, reject, timer }

export const agents = {
  set(deviceId, ctx) {
    const prev = live.get(deviceId);
    if (prev && prev !== ctx) {
      try { prev.ws.close(4009, 'Replaced by a newer connection'); } catch { /* already closed */ }
    }
    live.set(deviceId, ctx);
  },
  delete(deviceId, ctx) {
    if (live.get(deviceId) === ctx) live.delete(deviceId);
  },
  get: (deviceId) => live.get(deviceId),
  isOnline: (deviceId) => live.has(deviceId),
  count: () => live.size,
  all: () => [...live.values()],

  send(deviceId, type, payload) {
    const ctx = live.get(deviceId);
    if (!ctx || ctx.ws.readyState !== ctx.ws.OPEN) return false;
    ctx.ws.send(encode(createMessage(type, payload, { deviceId })));
    return true;
  },

  /** Send a command to an agent and await its COMMAND_RESPONSE. */
  command(deviceId, kind, args = {}, timeoutMs = 30_000) {
    const commandId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      if (!this.send(deviceId, MessageType.COMMAND_REQUEST, { commandId, kind, args })) {
        reject(new Error('The device is offline.'));
        return;
      }
      const timer = setTimeout(() => {
        pendingCommands.delete(commandId);
        reject(new Error('The device did not answer in time.'));
      }, timeoutMs);
      pendingCommands.set(commandId, { resolve, reject, timer });
    });
  },

  resolveCommand(payload) {
    const p = pendingCommands.get(payload?.commandId);
    if (!p) return;
    clearTimeout(p.timer);
    pendingCommands.delete(payload.commandId);
    p.resolve(payload);
  },
};

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
