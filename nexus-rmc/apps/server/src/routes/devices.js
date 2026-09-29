import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Device, deviceScope } from '../models/Device.js';
import { EnrollmentToken, Metric, Alert } from '../models/Telemetry.js';
import { User } from '../models/User.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errors.js';
import { audit, clientIp } from '../services/audit.js';
import { bus } from '../services/bus.js';
import { agents, sha256 } from '../services/agents.js';
import * as wg from '../services/wireguard.js';
import { env } from '../config/env.js';
import { agentFile } from '../services/downloads.js';

const router = Router();
router.use(requireAuth);

const meta = (req) => ({ user: req.user, ip: clientIp(req), sessionId: req.session.jti });

async function loadDevice(req, { adminOnly = false } = {}) {
  const scope = adminOnly ? {} : deviceScope(req.user);
  const device = await Device.findOne({ deviceId: req.params.id, ...scope });
  if (!device) throw new HttpError(404, 'Device not found.', 'NOT_FOUND');
  return device;
}

// ---------------- Enrollment tokens (admin) ----------------

router.get('/enrollment/tokens', requireRole('admin'), ah(async (_req, res) => {
  const tokens = await EnrollmentToken.find({ revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
  res.json({
    tokens: tokens.map((t) => ({
      id: t._id, hint: t.hint, label: t.label, createdBy: t.createdByName, expiresAt: t.expiresAt,
      maxUses: t.maxUses, uses: t.uses, exhausted: t.uses >= t.maxUses,
    })),
    serverUrl: env.publicUrl,
  });
}));

router.post('/enrollment/tokens', requireRole('admin'), ah(async (req, res) => {
  const body = z.object({
    label: z.string().trim().max(64).optional(),
    ttlMinutes: z.number().int().min(5).max(7 * 24 * 60).default(15),
    maxUses: z.number().int().min(1).max(100).default(1),
  }).parse(req.body || {});
  const token = `nxl_${crypto.randomBytes(18).toString('base64url')}`;
  const doc = await EnrollmentToken.create({
    tokenHash: sha256(token), hint: token.slice(-4), label: body.label,
    createdBy: req.user._id, createdByName: req.user.username,
    expiresAt: new Date(Date.now() + body.ttlMinutes * 60_000), maxUses: body.maxUses,
  });
  await audit({ ...meta(req), action: 'enrollment.token_create', details: { label: body.label, ttlMinutes: body.ttlMinutes, maxUses: body.maxUses } });
  // One string that carries both the server address and the token.
  const code = `NXL1.${Buffer.from(JSON.stringify({ s: env.publicUrl, t: token })).toString('base64url')}`;
  res.status(201).json({
    token, // shown once
    code,
    id: doc._id,
    expiresAt: doc.expiresAt,
    serverUrl: env.publicUrl,
    agentDownload: agentFile() ? `${env.publicUrl}/downloads/NexLinkAgent.exe` : null,
    commands: {
      agent: `python -m nexlink_agent enroll --server ${env.publicUrl} --token ${token}`,
      simulator: `python -m nexlink_agent.simulator --server ${env.publicUrl} --token ${token} --count ${Math.min(body.maxUses, 5)}`,
    },
  });
}));

router.delete('/enrollment/tokens/:tokenId', requireRole('admin'), ah(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.tokenId)) throw new HttpError(404, 'Token not found.', 'NOT_FOUND');
  await EnrollmentToken.updateOne({ _id: req.params.tokenId }, { $set: { revokedAt: new Date() } });
  await audit({ ...meta(req), action: 'enrollment.token_revoke', details: { id: req.params.tokenId } });
  res.json({ ok: true });
}));

// ---------------- Devices ----------------

router.get('/', ah(async (req, res) => {
  const q = { ...deviceScope(req.user) };
  if (req.user.role !== 'admin' || req.query.include !== 'all') q['approval.state'] = 'approved';
  const devices = await Device.find(q).sort({ 'approval.state': 1, virtualIp: 1, hostname: 1 });
  res.json({ devices: devices.map((d) => d.toSummary()) });
}));

router.get('/:id', ah(async (req, res) => {
  const device = await loadDevice(req);
  const detail = device.toDetail();
  if (req.user.role === 'admin' && device.assignedUsers?.length) {
    const users = await User.find({ _id: { $in: device.assignedUsers } }, 'username displayName email');
    detail.assignedUserDetails = users.map((u) => ({ id: u._id.toString(), username: u.username, displayName: u.displayName || u.username, email: u.email }));
  }
  detail.online = agents.isOnline(device.deviceId);
  res.json({ device: detail });
}));

/** Time series, down-sampled into `buckets` points for charts. */
router.get('/:id/metrics', ah(async (req, res) => {
  const device = await loadDevice(req);
  const q = z.object({
    minutes: z.coerce.number().int().min(1).max(7 * 24 * 60).default(30),
    buckets: z.coerce.number().int().min(10).max(500).default(120),
  }).parse(req.query);
  const since = new Date(Date.now() - q.minutes * 60_000);
  const bucketMs = Math.max(5000, Math.floor((q.minutes * 60_000) / q.buckets));
  const rows = await Metric.aggregate([
    { $match: { deviceId: device.deviceId, t: { $gte: since } } },
    { $group: {
      _id: { $toLong: { $subtract: [{ $toLong: '$t' }, { $mod: [{ $toLong: '$t' }, bucketMs] }] } },
      cpu: { $avg: '$cpu' }, ram: { $avg: '$ram' }, disk: { $avg: '$disk' },
      rx: { $avg: '$rx' }, tx: { $avg: '$tx' }, lat: { $avg: '$lat' }, loss: { $max: '$loss' }, rtt: { $avg: '$rtt' }, conn: { $avg: '$conn' },
    } },
    { $sort: { _id: 1 } },
  ]);
  res.json({ bucketMs, points: rows.map((r) => ({ t: r._id, ...r, _id: undefined })) });
}));

router.post('/:id/approve', requireRole('admin'), ah(async (req, res) => {
  const body = z.object({ label: z.string().trim().max(64).optional() }).parse(req.body || {});
  const device = await loadDevice(req, { adminOnly: true });
  if (device.approval.state === 'approved') throw new HttpError(409, 'Device is already approved.', 'BAD_STATE');
  device.virtualIp = device.virtualIp || await wg.allocateIp(device.simulated);
  device.approval = { state: 'approved', by: req.user._id, byName: req.user.username, at: new Date() };
  if (body.label) device.label = body.label;
  device.tunnel = { mode: device.simulated ? 'simulated' : wg.status().mode === 'wireguard' ? 'wireguard' : 'direct', up: false };
  await device.save();
  const peerAdded = device.simulated ? false : await wg.addPeer(device.publicKey, device.virtualIp);
  await audit({
    ...meta(req), action: 'device.approve', deviceId: device.deviceId, deviceName: device.hostname, approval: 'admin-approved',
    details: { virtualIp: device.virtualIp, simulated: device.simulated, wireguardPeer: peerAdded },
  });
  bus.emit('device.approved', { deviceId: device.deviceId });
  bus.emit('enrollment.changed');
  bus.emit('devices.changed');
  res.json({ device: device.toSummary(), peerAdded });
}));

router.post('/:id/reject', requireRole('admin'), ah(async (req, res) => {
  const device = await loadDevice(req, { adminOnly: true });
  device.approval = { state: 'rejected', by: req.user._id, byName: req.user.username, at: new Date() };
  device.status = 'UNAUTHORIZED';
  await device.save();
  await audit({ ...meta(req), action: 'device.reject', deviceId: device.deviceId, deviceName: device.hostname });
  bus.emit('device.rejected', { deviceId: device.deviceId });
  bus.emit('enrollment.changed');
  res.json({ ok: true });
}));

/** Rename or assign users (admin). */
router.patch('/:id', requireRole('admin'), ah(async (req, res) => {
  const body = z.object({
    label: z.string().trim().max(64).nullable().optional(),
    assignedUsers: z.array(z.string()).max(200).optional(),
  }).parse(req.body);
  const device = await loadDevice(req, { adminOnly: true });
  if (body.label !== undefined) device.label = body.label || undefined;
  if (body.assignedUsers) {
    const ids = body.assignedUsers.filter((id) => mongoose.isValidObjectId(id));
    const users = await User.find({ _id: { $in: ids }, role: 'user' }, '_id username');
    device.assignedUsers = users.map((u) => u._id);
    await audit({
      ...meta(req), action: 'device.assign', deviceId: device.deviceId, deviceName: device.hostname,
      details: { users: users.map((u) => u.username) },
    });
  }
  await device.save();
  bus.emit('devices.changed');
  bus.emit('users.changed');
  res.json({ device: device.toSummary() });
}));

router.delete('/:id', requireRole('admin'), ah(async (req, res) => {
  const device = await loadDevice(req, { adminOnly: true });
  if (!device.simulated) await wg.removePeer(device.publicKey);
  bus.emit('device.rejected', { deviceId: device.deviceId });
  await Promise.all([
    Device.deleteOne({ _id: device._id }),
    Metric.deleteMany({ deviceId: device.deviceId }),
    Alert.updateMany({ deviceId: device.deviceId, status: { $ne: 'resolved' } }, { $set: { status: 'resolved', resolvedAt: new Date(), resolvedBy: 'device removed' } }),
  ]);
  await audit({ ...meta(req), action: 'device.remove', deviceId: device.deviceId, deviceName: device.hostname });
  bus.emit('devices.changed');
  bus.emit('enrollment.changed');
  res.json({ ok: true });
}));

/** Demo support: inject a fault into a SIMULATED device (never a real one). */
router.post('/:id/sim-fault', requireRole('admin'), ah(async (req, res) => {
  const body = z.object({
    fault: z.enum(['latency', 'loss', 'cpu', 'traffic', 'memory', 'clear']),
    seconds: z.number().int().min(10).max(1800).default(120),
  }).parse(req.body);
  const device = await loadDevice(req, { adminOnly: true });
  if (!device.simulated) throw new HttpError(400, 'Faults can only be injected into simulated devices.', 'NOT_SIMULATED');
  const out = await agents.command(device.deviceId, 'sim.fault', body, 10_000);
  await audit({ ...meta(req), action: 'device.sim_fault', deviceId: device.deviceId, deviceName: device.hostname, details: body });
  res.json({ ok: out.ok, active: out.data?.active || [] });
}));

/**
 * Diagnostics (Phase 3): run network tests from the device's agent.
 * Read-only tests, so users may run them on their assigned devices.
 */
router.post('/:id/diagnostics', ah(async (req, res) => {
  const body = z.object({
    tests: z.array(z.enum(['ping', 'traceroute', 'dns', 'port', 'mtu'])).min(1).max(5),
    target: z.string().trim().max(253).regex(/^[a-zA-Z0-9.:-]+$/, 'Target must be a hostname or IP.').optional(),
    port: z.number().int().min(1).max(65535).optional(),
  }).parse(req.body);
  const device = await loadDevice(req);
  if (!agents.isOnline(device.deviceId)) throw new HttpError(409, 'The device is offline.', 'OFFLINE');
  const started = Date.now();
  const out = await agents.command(device.deviceId, 'diagnostics', body, 90_000);
  await audit({
    ...meta(req), action: 'device.diagnostics', deviceId: device.deviceId, deviceName: device.hostname,
    details: { tests: body.tests, target: body.target },
  });
  res.json({
    hostname: device.hostname, simulated: device.simulated, durationMs: Date.now() - started,
    appRttMs: device.latest?.appRttMs ?? null, results: out.data || {}, ok: out.ok, error: out.stderr || null,
  });
}));

export default router;
