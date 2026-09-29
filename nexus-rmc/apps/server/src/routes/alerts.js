import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Alert } from '../models/Telemetry.js';
import { Device, deviceScope } from '../models/Device.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errors.js';
import { audit, clientIp } from '../services/audit.js';
import { bus } from '../services/bus.js';

const router = Router();
router.use(requireAuth);

router.get('/', ah(async (req, res) => {
  const q = z.object({
    status: z.enum(['open', 'acknowledged', 'resolved', 'active', 'all']).default('active'),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }).parse(req.query);
  const filter = {};
  if (req.user.role !== 'admin') {
    filter.deviceId = { $in: (await Device.find(deviceScope(req.user), 'deviceId')).map((d) => d.deviceId) };
  }
  if (q.status === 'active') filter.status = { $ne: 'resolved' };
  else if (q.status !== 'all') filter.status = q.status;
  const [alerts, counts] = await Promise.all([
    Alert.find(filter).sort({ status: 1, openedAt: -1 }).limit(q.limit).lean(),
    Alert.aggregate([{ $match: { ...filter, status: { $ne: 'resolved' } } }, { $group: { _id: '$severity', n: { $sum: 1 } } }]),
  ]);
  res.json({ alerts, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
}));

async function transition(req, res, to) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Alert not found.', 'NOT_FOUND');
  const alert = await Alert.findById(req.params.id);
  if (!alert) throw new HttpError(404, 'Alert not found.', 'NOT_FOUND');
  if (to === 'acknowledged') {
    alert.status = 'acknowledged';
    alert.ackBy = req.user.username;
    alert.ackAt = new Date();
  } else {
    alert.status = 'resolved';
    alert.resolvedBy = req.user.username;
    alert.resolvedAt = new Date();
  }
  await alert.save();
  await audit({
    user: req.user, action: `alert.${to === 'acknowledged' ? 'ack' : 'resolve'}`, ip: clientIp(req), sessionId: req.session.jti,
    deviceId: alert.deviceId, deviceName: alert.hostname, details: { kind: alert.kind },
  });
  bus.emit('alerts.changed');
  res.json({ alert });
}

router.post('/:id/ack', requireRole('admin'), ah((req, res) => transition(req, res, 'acknowledged')));
router.post('/:id/resolve', requireRole('admin'), ah((req, res) => transition(req, res, 'resolved')));

router.post('/ack-all', requireRole('admin'), ah(async (req, res) => {
  const r = await Alert.updateMany({ status: 'open' }, { $set: { status: 'acknowledged', ackBy: req.user.username, ackAt: new Date() } });
  await audit({ user: req.user, action: 'alert.ack_all', ip: clientIp(req), sessionId: req.session.jti, details: { count: r.modifiedCount } });
  bus.emit('alerts.changed');
  res.json({ updated: r.modifiedCount });
}));

export default router;
