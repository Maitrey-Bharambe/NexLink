import { AuditLog } from '../models/AuditLog.js';
import { log, redact } from '../utils/logger.js';

import { bus } from './bus.js';

/**
 * Record an audit entry. Never throws: a logging failure must not break the
 * action, but it is logged at CRITICAL so it is not silently lost.
 */
export async function audit({
  actorType = 'user', user = null, username, deviceId, deviceName,
  action, result = 'success', ip, sessionId, approval = null, details,
}) {
  try {
    const entry = await AuditLog.create({
      actorType,
      userId: user?._id ?? user?.id,
      username: username ?? user?.username,
      deviceId, deviceName, action, result, ip, sessionId, approval,
      details: details ? redact(details) : undefined,
    });
    bus.emit('audit', entry);
    return entry;
  } catch (err) {
    log.critical('audit.write_failed', { action, reason: err.message });
    return null;
  }
}

export const clientIp = (req) =>
  (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
