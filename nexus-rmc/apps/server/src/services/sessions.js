import crypto from 'node:crypto';
import { MessageType } from '@nexus/protocol';
import { RemoteSession } from '../models/Telemetry.js';
import { Device, deviceScope } from '../models/Device.js';
import { HttpError } from '../middleware/errors.js';
import { agents, sha256 } from './agents.js';
import { audit } from './audit.js';
import { bus } from './bus.js';
import { getSetting } from './settings.js';

/**
 * Remote session lifecycle (Phase 4 + Phase 7 approvals):
 *
 *   requested ──admin approves──▶ approved ──console connects──▶ active ──▶ ended
 *        └──admin denies──▶ denied            (admins' own sessions skip "requested")
 *
 * Connecting issues a single-use, 60-second session token and tells the agent
 * (SESSION_START) to open its side of the relay. The hub (sessionHub.js)
 * pairs the two sockets and relays frames, enforcing policy and auditing.
 */

const KIND_CAPABILITY = { desktop: 'screen', files: 'files', terminal: 'terminal' };
const REQUEST_TTL_MS = 15 * 60_000;

export function sessionView(s) {
  return {
    sessionId: s.sessionId, kind: s.kind, deviceId: s.deviceId, hostname: s.hostname,
    userId: s.userId?.toString(), username: s.username, role: s.role, fullShell: s.fullShell,
    reason: s.reason, status: s.status, decidedBy: s.decidedBy, decidedAt: s.decidedAt,
    startedAt: s.startedAt, endedAt: s.endedAt, endReason: s.endReason, createdAt: s.createdAt, stats: s.stats,
  };
}

async function loadAccessibleDevice(user, deviceId) {
  const device = await Device.findOne({ deviceId, ...deviceScope(user) });
  if (!device) throw new HttpError(404, 'Device not found or not assigned to you.', 'NOT_FOUND');
  if (device.approval.state !== 'approved') throw new HttpError(409, 'This device has not been approved yet.', 'NOT_APPROVED');
  return device;
}

export async function requestSession(user, { deviceId, kind, reason, fullShell = false }, meta) {
  const device = await loadAccessibleDevice(user, deviceId);
  const cap = KIND_CAPABILITY[kind];
  if (device.capabilities && device.capabilities[cap] === false) {
    throw new HttpError(409, `This device's agent does not support ${kind} sessions.`, 'UNSUPPORTED');
  }
  if (fullShell && user.role !== 'admin') throw new HttpError(403, 'Only administrators can open a full shell.', 'FORBIDDEN');
  const policy = await getSetting('policy');
  if (fullShell && !policy.adminFullShell) throw new HttpError(403, 'Full shell is turned off in Settings.', 'FORBIDDEN');

  const needsApproval = user.role !== 'admin' && policy.userSessionsNeedApproval;
  const session = await RemoteSession.create({
    sessionId: crypto.randomUUID(),
    kind, deviceId, hostname: device.hostname,
    userId: user._id, username: user.username, role: user.role,
    fullShell: Boolean(fullShell && kind === 'terminal'),
    reason,
    status: needsApproval ? 'requested' : 'approved',
    decidedBy: needsApproval ? undefined : 'policy',
    decidedAt: needsApproval ? undefined : new Date(),
  });
  await audit({
    user, action: needsApproval ? 'session.request' : 'session.create', deviceId, deviceName: device.hostname,
    ip: meta.ip, sessionId: meta.jti,
    approval: needsApproval ? 'pending' : user.role === 'admin' ? 'admin' : 'policy',
    details: { kind, remoteSession: session.sessionId, fullShell: session.fullShell, reason },
  });
  bus.emit('sessions.changed');
  return session;
}

export async function decide(admin, sessionId, approve, note, meta) {
  const s = await RemoteSession.findOne({ sessionId });
  if (!s) throw new HttpError(404, 'Session not found.', 'NOT_FOUND');
  if (s.status !== 'requested') throw new HttpError(409, `This request is already ${s.status}.`, 'BAD_STATE');
  s.status = approve ? 'approved' : 'denied';
  s.decidedBy = admin.username;
  s.decidedAt = new Date();
  if (!approve) s.endReason = note || 'Denied by administrator';
  await s.save();
  await audit({
    user: admin, action: approve ? 'session.approve' : 'session.deny', deviceId: s.deviceId, deviceName: s.hostname,
    ip: meta.ip, sessionId: meta.jti, approval: approve ? 'admin-approved' : 'admin-denied',
    details: { remoteSession: s.sessionId, requester: s.username, kind: s.kind, note },
  });
  bus.emit('sessions.changed');
  bus.emit('session.decided', { userId: s.userId?.toString(), session: sessionView(s) });
  return s;
}

/** Issue a single-use connect token and ask the agent to open its side. */
export async function connect(user, sessionId) {
  const s = await RemoteSession.findOne({ sessionId });
  if (!s || !s.userId?.equals(user._id)) throw new HttpError(404, 'Session not found.', 'NOT_FOUND');
  if (!['approved', 'active'].includes(s.status)) throw new HttpError(409, `This session is ${s.status}.`, 'BAD_STATE');
  if (!agents.isOnline(s.deviceId)) throw new HttpError(409, 'The device is offline.', 'OFFLINE');

  const policy = await getSetting('policy');
  const token = crypto.randomBytes(32).toString('base64url');
  s.tokenHash = sha256(token);
  s.tokenExpiresAt = new Date(Date.now() + policy.sessionTokenTtlSec * 1000);
  await s.save();

  agents.send(s.deviceId, MessageType.SESSION_START, {
    sessionId: s.sessionId,
    kind: s.kind,
    operator: { username: user.username, displayName: user.displayName || user.username, role: user.role },
    policy: {
      fullShell: s.fullShell,
      fileRoot: user.role === 'admin' ? 'any' : 'shared',
      allowInput: true,
    },
  });
  return { sessionToken: token, session: sessionView(s) };
}

export async function endSession(sessionId, reason, by) {
  const s = await RemoteSession.findOne({ sessionId });
  if (!s || ['ended', 'denied', 'expired', 'failed'].includes(s.status)) return s;
  const wasActive = s.status === 'active';
  s.status = wasActive || s.status === 'approved' ? 'ended' : 'expired';
  s.endedAt = new Date();
  s.endReason = reason;
  await s.save();
  agents.send(s.deviceId, MessageType.SESSION_END, { sessionId, reason });
  bus.emit('session.kill', { sessionId, reason });
  if (wasActive) {
    await audit({
      actorType: by?.username ? 'user' : 'system', user: by?._id ? by : null, username: by?.username,
      action: 'session.end', deviceId: s.deviceId, deviceName: s.hostname,
      details: { remoteSession: sessionId, reason, stats: s.stats, durationSec: s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0 },
    });
  }
  bus.emit('sessions.changed');
  return s;
}

/** Expire stale requests and approvals nobody used. */
export function startSessionSweep() {
  setInterval(async () => {
    const cutoff = new Date(Date.now() - REQUEST_TTL_MS);
    const res = await RemoteSession.updateMany(
      { status: { $in: ['requested', 'approved'] }, updatedAt: { $lt: cutoff } },
      { $set: { status: 'expired', endedAt: new Date(), endReason: 'Not used in time' } },
    );
    if (res.modifiedCount) bus.emit('sessions.changed');
  }, 60_000).unref();
}
