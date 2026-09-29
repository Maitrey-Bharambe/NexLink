import { Router } from 'express';
import { z } from 'zod';
import { RemoteSession } from '../models/Telemetry.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errors.js';
import { clientIp } from '../services/audit.js';
import {
  requestSession, decide, connect, endSession, sessionView,
} from '../services/sessions.js';

const router = Router();
router.use(requireAuth);

const meta = (req) => ({ ip: clientIp(req), jti: req.session.jti });

/** Admins see every session; users see their own. */
router.get('/', ah(async (req, res) => {
  const q = z.object({
    status: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).parse(req.query);
  const filter = req.user.role === 'admin' ? {} : { userId: req.user._id };
  if (q.status) filter.status = { $in: q.status.split(',') };
  const sessions = await RemoteSession.find(filter).sort({ createdAt: -1 }).limit(q.limit);
  res.json({ sessions: sessions.map(sessionView) });
}));

router.post('/', ah(async (req, res) => {
  const body = z.object({
    deviceId: z.string().min(1).max(64),
    kind: z.enum(['desktop', 'files', 'terminal']),
    reason: z.string().trim().max(200).optional(),
    fullShell: z.boolean().optional(),
  }).parse(req.body);
  const s = await requestSession(req.user, body, meta(req));
  res.status(201).json({ session: sessionView(s) });
}));

router.post('/:id/approve', requireRole('admin'), ah(async (req, res) => {
  const s = await decide(req.user, req.params.id, true, req.body?.note, meta(req));
  res.json({ session: sessionView(s) });
}));

router.post('/:id/deny', requireRole('admin'), ah(async (req, res) => {
  const note = z.object({ note: z.string().trim().max(200).optional() }).parse(req.body || {}).note;
  const s = await decide(req.user, req.params.id, false, note, meta(req));
  res.json({ session: sessionView(s) });
}));

router.post('/:id/connect', ah(async (req, res) => {
  res.json(await connect(req.user, req.params.id));
}));

router.post('/:id/end', ah(async (req, res) => {
  const s = await RemoteSession.findOne({ sessionId: req.params.id });
  if (!s) throw new HttpError(404, 'Session not found.', 'NOT_FOUND');
  if (req.user.role !== 'admin' && !s.userId?.equals(req.user._id)) throw new HttpError(404, 'Session not found.', 'NOT_FOUND');
  const ended = await endSession(s.sessionId, req.user.role === 'admin' && !s.userId?.equals(req.user._id) ? `Terminated by ${req.user.username}` : 'Ended by operator', req.user);
  res.json({ session: sessionView(ended) });
}));

export default router;
