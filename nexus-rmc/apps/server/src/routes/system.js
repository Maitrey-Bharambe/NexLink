import { Router } from 'express';
import { z } from 'zod';
import { NETWORK, PROTOCOL_VERSION } from '@nexus/protocol';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ah } from '../middleware/errors.js';
import { dbState } from '../config/db.js';
import { AuditLog } from '../models/AuditLog.js';
import { Device, deviceScope } from '../models/Device.js';
import * as wg from '../services/wireguard.js';

const router = Router();
const startedAt = Date.now();

/** Unauthenticated liveness probe (used by the console before login). */
router.get('/health', (_req, res) => {
  res.json({
    status: dbState() === 'CONNECTED' ? 'ok' : 'degraded',
    db: dbState(),
    protocol: PROTOCOL_VERSION,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  });
});

/** Private-network summary, scoped to what the user may see. */
router.get('/network', requireAuth, ah(async (req, res) => {
  const devices = await Device.find({ ...deviceScope(req.user), 'approval.state': 'approved' }).sort({ virtualIp: 1 });
  const online = devices.filter((d) => ['CONNECTED', 'DEGRADED'].includes(d.status)).length;
  const hub = wg.status();
  res.json({
    network: NETWORK,
    counts: { devices: devices.length, online, offline: devices.length - online },
    devices: devices.map((d) => d.toSummary()),
    vpn: { state: hub.mode === 'wireguard' ? 'CONNECTED' : 'SIMULATED', mode: hub.mode, note: hub.reason },
  });
}));

router.get('/audit', requireAuth, requireRole('admin'), ah(async (req, res) => {
  const q = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.date().optional(),
    action: z.string().max(64).optional(),
  }).parse(req.query);

  const filter = {};
  if (q.before) filter.timestamp = { $lt: q.before };
  if (q.action) filter.action = { $regex: `^${q.action.replace(/[^a-z._]/gi, '')}` };
  const entries = await AuditLog.find(filter).sort({ timestamp: -1 }).limit(q.limit).lean();
  res.json({ entries, nextBefore: entries.length === q.limit ? entries.at(-1).timestamp : null });
}));

export default router;
