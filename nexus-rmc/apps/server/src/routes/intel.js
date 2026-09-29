import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Device } from '../models/Device.js';
import { Alert, Metric, RemoteSession, Report } from '../models/Telemetry.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errors.js';
import { audit, clientIp } from '../services/audit.js';
import { chat, narrate } from '../services/ai.js';
import { engineStatus } from '../services/anomaly.js';
import { getSetting, setSetting, publicSettings, groqKey, googleCredentials, DEFAULTS } from '../services/settings.js';
import { env } from '../config/env.js';
import { googleConfigured, redirectUri } from '../services/google.js';

const router = Router();
router.use(requireAuth);

// ---------------- AI assistant ----------------

const chatLimiter = rateLimit({
  windowMs: 60_000, limit: env.isTest ? 1000 : 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many questions in a minute. Wait a moment.' } },
});

router.get('/ai/status', ah(async (_req, res) => {
  const ai = await getSetting('ai');
  res.json({ provider: ai.provider, model: ai.model, keySet: Boolean(await groqKey()), engine: engineStatus() });
}));

router.post('/ai/chat', chatLimiter, ah(async (req, res) => {
  const body = z.object({
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).min(1).max(30),
  }).parse(req.body);
  const out = await chat(req.user, body.messages);
  await audit({
    actorType: 'ai', user: req.user, username: req.user.username, action: 'ai.chat', ip: clientIp(req), sessionId: req.session.jti,
    details: { question: body.messages.at(-1).content.slice(0, 200), tools: out.tools, generator: out.generator },
  });
  res.json(out);
}));

// ---------------- Reports ----------------

async function buildReport(kind, from, to) {
  const devices = await Device.find({ 'approval.state': 'approved' });
  const spanSec = (to - from) / 1000;
  const expected = Math.max(1, spanSec / 5); // one sample per 5 s

  const stats = await Metric.aggregate([
    { $match: { t: { $gte: from, $lte: to } } },
    { $group: {
      _id: '$deviceId', n: { $sum: 1 },
      cpuAvg: { $avg: '$cpu' }, cpuMax: { $max: '$cpu' }, ramAvg: { $avg: '$ram' }, ramMax: { $max: '$ram' },
      latAvg: { $avg: '$lat' }, latMax: { $max: '$lat' }, lossAvg: { $avg: '$loss' }, lossMax: { $max: '$loss' },
      rxAvg: { $avg: '$rx' }, txAvg: { $avg: '$tx' },
    } },
  ]);
  const byId = new Map(stats.map((s) => [s._id, s]));
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

  const rows = devices.map((d) => {
    const s = byId.get(d.deviceId) || {};
    const sinceEnroll = Math.max(1, (to - Math.max(from, d.approval?.at || from)) / 1000 / 5);
    return {
      hostname: d.hostname, virtualIp: d.virtualIp, simulated: d.simulated, status: d.status,
      availabilityPct: r1(Math.min(100, ((s.n || 0) / Math.min(expected, sinceEnroll)) * 100)),
      cpuAvg: r1(s.cpuAvg), cpuMax: r1(s.cpuMax), ramAvg: r1(s.ramAvg), ramMax: r1(s.ramMax),
      latencyAvg: r1(s.latAvg), latencyMax: r1(s.latMax), lossAvg: r1(s.lossAvg), lossMax: r1(s.lossMax),
      trafficGb: r1((((s.rxAvg || 0) + (s.txAvg || 0)) * spanSec) / 1e9),
      anomaly: d.anomaly?.severity || 'normal',
    };
  });

  const [alerts, sessions] = await Promise.all([
    Alert.find({ openedAt: { $gte: from, $lte: to } }).lean(),
    RemoteSession.find({ createdAt: { $gte: from, $lte: to } }).lean(),
  ]);
  const byKind = (list, key) => list.reduce((acc, x) => ({ ...acc, [x[key]]: (acc[x[key]] || 0) + 1 }), {});
  const avail = rows.filter((r) => r.availabilityPct != null);

  return {
    from, to, kind,
    summary: {
      devices: devices.length,
      simulated: devices.filter((d) => d.simulated).length,
      avgAvailabilityPct: avail.length ? r1(avail.reduce((a, r) => a + r.availabilityPct, 0) / avail.length) : null,
      alertsOpened: alerts.length,
      criticalAlerts: alerts.filter((a) => a.severity === 'critical').length,
      alertsResolved: alerts.filter((a) => a.status === 'resolved').length,
      sessions: sessions.length,
      anomalies: rows.filter((r) => r.anomaly !== 'normal').length,
    },
    devices: rows,
    alertsByKind: byKind(alerts, 'kind'),
    sessionsByKind: byKind(sessions, 'kind'),
    sessionsByUser: byKind(sessions, 'username'),
    topAlerts: alerts.slice(0, 15).map((a) => ({ hostname: a.hostname, kind: a.kind, severity: a.severity, message: a.message, openedAt: a.openedAt, status: a.status })),
  };
}

router.get('/reports', requireRole('admin'), ah(async (_req, res) => {
  const reports = await Report.find({}, 'title kind from to generator createdBy createdAt').sort({ createdAt: -1 }).limit(50).lean();
  res.json({ reports });
}));

router.post('/reports', requireRole('admin'), ah(async (req, res) => {
  const { kind } = z.object({ kind: z.enum(['daily', 'weekly']).default('daily') }).parse(req.body || {});
  const to = new Date();
  const from = new Date(to - (kind === 'weekly' ? 7 : 1) * 24 * 3600_000);
  const data = await buildReport(kind, from, to);
  const { narrative, generator } = await narrate(data);
  const report = await Report.create({
    title: `${kind === 'weekly' ? 'Weekly' : 'Daily'} network health — ${to.toLocaleDateString()}`,
    kind, from, to, data, narrative, generator, createdBy: req.user.username,
  });
  await audit({ user: req.user, action: 'report.generate', ip: clientIp(req), sessionId: req.session.jti, details: { kind, generator } });
  res.status(201).json({ report });
}));

router.get('/reports/:id', requireRole('admin'), ah(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Report not found.', 'NOT_FOUND');
  const report = await Report.findById(req.params.id).lean();
  if (!report) throw new HttpError(404, 'Report not found.', 'NOT_FOUND');
  res.json({ report });
}));

router.delete('/reports/:id', requireRole('admin'), ah(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Report not found.', 'NOT_FOUND');
  await Report.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

// ---------------- Settings ----------------

router.get('/settings', requireRole('admin'), ah(async (_req, res) => {
  res.json({
    ...(await publicSettings()),
    auth: {
      google: await googleConfigured(),
      googleSource: (await googleCredentials()).source,
      googleClientId: (await googleCredentials()).clientId || null,
      googleRedirectUri: redirectUri(),
      registration: env.allowRegistration,
    },
    publicUrl: env.publicUrl,
  });
}));

router.patch('/settings', requireRole('admin'), ah(async (req, res) => {
  const t = DEFAULTS.thresholds;
  const body = z.object({
    thresholds: z.object({
      cpuPct: z.number().min(10).max(100), ramPct: z.number().min(10).max(100), diskPct: z.number().min(10).max(100),
      latencyMs: z.number().min(5).max(5000), lossPct: z.number().min(0.1).max(100),
      offlineSec: z.number().min(15).max(3600), sustainSec: z.number().min(0).max(3600),
    }).partial().optional(),
    policy: z.object({
      userSessionsNeedApproval: z.boolean(), adminFullShell: z.boolean(), sessionTokenTtlSec: z.number().int().min(15).max(600),
    }).partial().optional(),
    ai: z.object({ model: z.string().trim().min(2).max(80) }).partial().optional(),
    groqKey: z.string().trim().max(200).nullable().optional(),
    google: z.object({
      clientId: z.string().trim().max(200).regex(/^[\w.-]*$/, 'Invalid client ID').nullable(),
      clientSecret: z.string().trim().max(200).nullable().optional(),
    }).optional(),
  }).parse(req.body);

  if (body.thresholds) await setSetting('thresholds', { ...t, ...(await getSetting('thresholds')), ...body.thresholds }, req.user.username);
  if (body.policy) await setSetting('policy', { ...(await getSetting('policy')), ...body.policy }, req.user.username);
  if (body.ai) await setSetting('ai', { ...(await getSetting('ai')), ...body.ai }, req.user.username);
  if (body.groqKey !== undefined) await setSetting('ai.groqKey', body.groqKey || null, req.user.username);
  if (body.google) {
    await setSetting('auth.googleClientId', body.google.clientId || null, req.user.username);
    if (body.google.clientSecret !== undefined) await setSetting('auth.googleClientSecret', body.google.clientSecret || null, req.user.username);
  }

  await audit({
    user: req.user, action: 'settings.update', ip: clientIp(req), sessionId: req.session.jti,
    details: {
      thresholds: body.thresholds, policy: body.policy, ai: body.ai,
      groqKey: body.groqKey === undefined ? undefined : body.groqKey ? 'set' : 'cleared',
      google: body.google ? (body.google.clientId ? 'set' : 'cleared') : undefined,
    },
  });
  res.json({
    ...(await publicSettings()),
    auth: {
      google: await googleConfigured(),
      googleSource: (await googleCredentials()).source,
      googleClientId: (await googleCredentials()).clientId || null,
      googleRedirectUri: redirectUri(),
      registration: env.allowRegistration,
    },
  });
}));

export default router;
