import { Router } from 'express';
import { z } from 'zod';
import { User, ROLES, STATUSES } from '../models/User.js';
import { Session } from '../models/Session.js';
import { Device } from '../models/Device.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errors.js';
import { audit, clientIp } from '../services/audit.js';
import { bus } from '../services/bus.js';
import { hashPassword, checkPasswordPolicy, revokeSession } from '../services/auth.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

async function revokeAll(userId) {
  const live = await Session.find({ userId, revokedAt: null }, 'jti');
  await Promise.all(live.map((s) => revokeSession(s.jti)));
}

async function findUser(id) {
  const user = await User.findById(id).catch(() => null);
  if (!user) throw new HttpError(404, 'User not found.', 'NOT_FOUND');
  return user;
}

router.get('/', ah(async (_req, res) => {
  const [users, devices] = await Promise.all([
    User.find().sort({ status: 1, createdAt: 1 }),
    Device.find({ assignedUsers: { $exists: true, $ne: [] } }, 'deviceId hostname assignedUsers'),
  ]);
  const byUser = new Map();
  for (const d of devices) {
    for (const uid of d.assignedUsers) {
      const k = uid.toString();
      if (!byUser.has(k)) byUser.set(k, []);
      byUser.get(k).push({ deviceId: d.deviceId, hostname: d.hostname });
    }
  }
  res.json({
    users: users.map((u) => ({ ...u.toSafeJSON(), devices: byUser.get(u._id.toString()) || [] })),
    pending: users.filter((u) => u.status === 'pending').length,
  });
}));

router.post('/', ah(async (req, res) => {
  const body = z.object({
    username: z.string().trim().toLowerCase().min(3).max(32).regex(/^[a-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore.'),
    email: z.string().trim().toLowerCase().email().max(254).optional().or(z.literal('').transform(() => undefined)),
    displayName: z.string().trim().max(64).optional(),
    password: z.string().max(128),
    role: z.enum(ROLES),
  }).parse(req.body);

  const policy = checkPasswordPolicy(body.password);
  if (policy) throw new HttpError(400, policy, 'WEAK_PASSWORD');
  if (await User.exists({ username: body.username })) throw new HttpError(409, 'That username is already taken.', 'DUPLICATE');
  if (body.email && await User.exists({ email: body.email })) throw new HttpError(409, 'That email is already used.', 'DUPLICATE');

  const { password, ...rest } = body;
  const user = await User.create({
    ...rest, passwordHash: await hashPassword(password), status: 'active', approvedBy: req.user._id, approvedAt: new Date(),
  });
  await audit({
    user: req.user, action: 'user.create', ip: clientIp(req), sessionId: req.session.jti,
    details: { username: user.username, role: user.role },
  });
  bus.emit('users.changed');
  res.status(201).json({ user: user.toSafeJSON() });
}));

/** Change role / status (approve, disable, re-enable) / display name. */
router.patch('/:id', ah(async (req, res) => {
  const body = z.object({
    role: z.enum(ROLES).optional(),
    status: z.enum(STATUSES).optional(),
    disabled: z.boolean().optional(), // legacy clients
    displayName: z.string().trim().min(1).max(64).optional(),
  }).parse(req.body);
  if (body.disabled !== undefined && !body.status) body.status = body.disabled ? 'disabled' : 'active';
  delete body.disabled;

  const user = await findUser(req.params.id);
  const self = user._id.equals(req.user._id);
  if (self && ((body.status && body.status !== 'active') || (body.role && body.role !== 'admin'))) {
    throw new HttpError(400, 'You cannot demote or disable your own account.', 'SELF_LOCKOUT');
  }
  if (body.status === 'pending') throw new HttpError(400, 'An account cannot be moved back to pending.', 'BAD_STATUS');

  const approving = user.status === 'pending' && body.status === 'active';
  Object.assign(user, body);
  if (approving) {
    user.approvedBy = req.user._id;
    user.approvedAt = new Date();
  }
  await user.save();
  if (body.status === 'disabled' || body.role) await revokeAll(user._id); // role change takes effect on next sign-in

  await audit({
    user: req.user,
    action: approving ? 'user.approve' : 'user.update',
    ip: clientIp(req),
    sessionId: req.session.jti,
    details: { target: user.username, ...body },
  });
  bus.emit('users.changed');
  res.json({ user: user.toSafeJSON() });
}));

/** Reset a user's password (admin). */
router.post('/:id/password', ah(async (req, res) => {
  const { password } = z.object({ password: z.string().max(128) }).parse(req.body);
  const policy = checkPasswordPolicy(password);
  if (policy) throw new HttpError(400, policy, 'WEAK_PASSWORD');
  const user = await findUser(req.params.id);
  user.passwordHash = await hashPassword(password);
  user.hasPassword = true;
  user.failedLogins = 0;
  user.lockedUntil = undefined;
  await user.save();
  await revokeAll(user._id);
  await audit({ user: req.user, action: 'user.reset_password', ip: clientIp(req), sessionId: req.session.jti, details: { target: user.username } });
  res.json({ ok: true });
}));

/** Remove an account (also how a pending request is rejected). */
router.delete('/:id', ah(async (req, res) => {
  const user = await findUser(req.params.id);
  if (user._id.equals(req.user._id)) throw new HttpError(400, 'You cannot delete your own account.', 'SELF_LOCKOUT');
  if (user.role === 'admin' && (await User.countDocuments({ role: 'admin', status: 'active' })) <= 1 && user.status === 'active') {
    throw new HttpError(400, 'At least one active administrator must remain.', 'LAST_ADMIN');
  }
  await revokeAll(user._id);
  await Device.updateMany({ assignedUsers: user._id }, { $pull: { assignedUsers: user._id } });
  await User.deleteOne({ _id: user._id });
  await audit({
    user: req.user, action: user.status === 'pending' ? 'user.reject' : 'user.delete',
    ip: clientIp(req), sessionId: req.session.jti, details: { target: user.username, email: user.email },
  });
  bus.emit('users.changed');
  bus.emit('devices.changed');
  res.json({ ok: true });
}));

export default router;
