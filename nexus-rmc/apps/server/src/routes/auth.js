import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User, uniqueUsername } from '../models/User.js';
import { SystemEvent } from '../models/SystemEvent.js';
import { requireAuth } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errors.js';
import { audit, clientIp } from '../services/audit.js';
import { env } from '../config/env.js';
import { bus } from '../services/bus.js';
import {
  verifyCredentials, issueToken, revokeSession, hashPassword, checkPasswordPolicy, AuthError, assertUsable, passwordMatches,
} from '../services/auth.js';
import {
  googleConfigured, startFlow, completeFlow, resolvePoll, readPoll, failPollForState, resultPage, redirectUri,
} from '../services/google.js';

const router = Router();

// Brute-force protection on credential endpoints (in addition to account lockout).
const credentialLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.isTest ? 1000 : 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Wait a few minutes and try again.' } },
});

const usernameSchema = z.string().trim().toLowerCase().min(3).max(32)
  .regex(/^[a-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore.');
const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);

/** Claims the one-time setup lock. Returns false if setup already happened. */
async function claimSetup() {
  if ((await User.estimatedDocumentCount()) > 0) return false;
  try {
    await SystemEvent.create({ type: 'setup.completed', key: 'setup.completed', message: 'Initial administrator created' });
    return true;
  } catch {
    return false;
  }
}

async function signIn(user, req) {
  const ip = clientIp(req);
  user.lastLoginAt = new Date();
  user.lastLoginIp = ip;
  await user.save();
  const { token, expiresAt, jti } = await issueToken(user, { ip, userAgent: req.get('user-agent') });
  return { token, expiresAt, jti, user: user.toSafeJSON() };
}

/** Public: what the sign-in screen should offer. */
router.get('/status', ah(async (_req, res) => {
  const users = await User.estimatedDocumentCount();
  res.json({
    setupRequired: users === 0,
    providers: { password: true, google: await googleConfigured(), registration: env.allowRegistration },
  });
}));

/**
 * First-run: create the initial administrator. Only works while no users
 * exist; a unique SystemEvent key makes it race-safe. No default credentials.
 */
router.post('/setup', credentialLimiter, ah(async (req, res) => {
  const body = z.object({
    username: usernameSchema,
    email: emailSchema.optional(),
    displayName: z.string().trim().max(64).optional(),
    password: z.string().max(128),
  }).parse(req.body);

  const policy = checkPasswordPolicy(body.password);
  if (policy) throw new HttpError(400, policy, 'WEAK_PASSWORD');
  if (!(await claimSetup())) throw new HttpError(409, 'Setup has already been completed.', 'SETUP_DONE');

  const user = await User.create({
    username: body.username,
    email: body.email,
    displayName: body.displayName,
    passwordHash: await hashPassword(body.password),
    role: 'admin',
    status: 'active',
  });
  await audit({ user, action: 'system.setup', ip: clientIp(req), details: { role: 'admin' } });
  const session = await signIn(user, req);
  res.status(201).json(session);
}));

router.post('/login', credentialLimiter, ah(async (req, res) => {
  const body = z.object({ username: z.string().trim().min(1).max(254), password: z.string().min(1).max(128) })
    .parse(req.body);
  const ip = clientIp(req);

  let user;
  try {
    user = await verifyCredentials(body.username, body.password);
  } catch (err) {
    if (err instanceof AuthError) {
      await audit({
        actorType: 'user', username: body.username.toLowerCase(), action: 'auth.login',
        result: err.code === 'PENDING_APPROVAL' ? 'denied' : 'failure', ip, details: { reason: err.code },
      });
    }
    throw err;
  }

  const session = await signIn(user, req);
  await audit({ user, action: 'auth.login', ip, sessionId: session.jti, details: { method: 'password' } });
  res.json(session);
}));

/** Self-registration with email + password. The account waits for an admin. */
router.post('/register', credentialLimiter, ah(async (req, res) => {
  if (!env.allowRegistration) throw new HttpError(403, 'Self-registration is turned off. Ask an administrator for an account.', 'REGISTRATION_OFF');
  const body = z.object({
    email: emailSchema,
    displayName: z.string().trim().min(1, 'Enter your name.').max(64),
    password: z.string().max(128),
  }).parse(req.body);

  const policy = checkPasswordPolicy(body.password);
  if (policy) throw new HttpError(400, policy, 'WEAK_PASSWORD');
  if (await User.exists({ email: body.email })) {
    throw new HttpError(409, 'An account with this email already exists. Sign in instead.', 'DUPLICATE');
  }

  const user = await User.create({
    username: await uniqueUsername(body.email),
    email: body.email,
    displayName: body.displayName,
    passwordHash: await hashPassword(body.password),
    role: 'user',
    status: 'pending',
  });
  await audit({ user, action: 'auth.register', ip: clientIp(req), details: { method: 'password', status: 'pending' } });
  bus.emit('users.changed');
  res.status(201).json({ status: 'pending', user: user.toSafeJSON() });
}));

// ---------------- Google ----------------

router.post('/google/start', credentialLimiter, ah(async (req, res) => {
  if (!(await googleConfigured())) {
    throw new HttpError(503, 'Google sign-in is not set up on this server yet. An administrator can add it in Settings → Sign-in.', 'GOOGLE_NOT_CONFIGURED');
  }
  const { loopbackPort } = z.object({ loopbackPort: z.number().int().min(1024).max(65535).optional() }).parse(req.body || {});
  res.json({ ...(await startFlow({ loopbackPort })), redirectUri: loopbackPort ? undefined : redirectUri() });
}));

/**
 * Shared outcome of a verified Google identity: find/link/create the account,
 * then sign in, or report pending/denied. Returns { status, …session }.
 */
async function googleOutcome(profile, req) {
  const ip = clientIp(req);
  let user = await User.findOne({ googleId: profile.googleId }) || await User.findOne({ email: profile.email });

  if (!user) {
    // The very first account on a fresh install becomes the administrator.
    const first = await claimSetup();
    user = await User.create({
      username: await uniqueUsername(profile.email),
      email: profile.email,
      displayName: profile.name,
      googleId: profile.googleId,
      avatarUrl: profile.avatarUrl,
      hasPassword: false,
      role: first ? 'admin' : 'user',
      status: first ? 'active' : 'pending',
    });
    await audit({ user, action: first ? 'system.setup' : 'auth.register', ip, details: { method: 'google', status: user.status, role: user.role } });
    bus.emit('users.changed');
  } else if (!user.googleId) {
    // Link Google to an existing account with the same verified email.
    user.googleId = profile.googleId;
    if (!user.avatarUrl) user.avatarUrl = profile.avatarUrl;
    await user.save();
    await audit({ user, action: 'auth.link_google', ip });
  }

  try {
    assertUsable(user);
  } catch (err) {
    await audit({ user, action: 'auth.login', result: 'denied', ip, details: { method: 'google', reason: err.code } });
    return { status: err.code === 'PENDING_APPROVAL' ? 'pending' : 'denied', message: err.message, name: user.displayName };
  }
  const session = await signIn(user, req);
  await audit({ user, action: 'auth.login', ip, sessionId: session.jti, details: { method: 'google' } });
  return { status: 'ok', token: session.token, expiresAt: session.expiresAt, user: session.user };
}

/** Desktop flow: the app caught Google's redirect on 127.0.0.1 and hands us the code. */
router.post('/google/exchange', credentialLimiter, ah(async (req, res) => {
  const { code, state } = z.object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(128) }).parse(req.body);
  let flow;
  try {
    flow = await completeFlow({ code, state });
  } catch (err) {
    throw new HttpError(400, err.message || 'Google sign-in failed.', 'GOOGLE');
  }
  res.json(await googleOutcome(flow.profile, req));
}));

/** Browser flow (dev / same machine): Google redirects here, the app polls. */
router.get('/google/callback', ah(async (req, res) => {
  const { code, state, error } = req.query;
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  if (error || !code) {
    failPollForState(state, error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed.');
    return res.status(400).send(resultPage('Sign-in cancelled', 'You can close this tab and try again from NexLink.', false));
  }
  let flow;
  try {
    flow = await completeFlow({ code, state });
  } catch (err) {
    failPollForState(state, err.message);
    return res.status(400).send(resultPage('Sign-in failed', err.message, false));
  }
  const out = await googleOutcome(flow.profile, req);
  const { status, ...rest } = out;
  resolvePoll(flow.pollId, status, rest);
  if (status === 'ok') return res.send(resultPage(`Signed in as ${out.user.displayName}`, 'You can close this tab and return to NexLink.', true));
  if (status === 'pending') return res.send(resultPage('Request received', 'Your account is waiting for an administrator to approve it. You can close this tab.', true));
  return res.send(resultPage('Access denied', out.message, false));
}));

router.get('/google/poll/:pollId', (req, res) => {
  res.json(readPoll(req.params.pollId));
});

// ---------------- Session ----------------

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user.toSafeJSON(), session: { id: req.session.jti, expiresAt: req.session.expiresAt } });
});

router.patch('/me', requireAuth, ah(async (req, res) => {
  const body = z.object({
    displayName: z.string().trim().min(1).max(64).optional(),
    currentPassword: z.string().max(128).optional(),
    newPassword: z.string().max(128).optional(),
  }).parse(req.body);
  const user = await User.findById(req.user._id).select('+passwordHash');
  if (body.displayName) user.displayName = body.displayName;
  if (body.newPassword) {
    const policy = checkPasswordPolicy(body.newPassword);
    if (policy) throw new HttpError(400, policy, 'WEAK_PASSWORD');
    if (user.passwordHash && !(await passwordMatches(user.passwordHash, body.currentPassword))) {
      throw new HttpError(400, 'Current password is incorrect.', 'BAD_PASSWORD');
    }
    user.passwordHash = await hashPassword(body.newPassword);
    user.hasPassword = true;
  }
  await user.save();
  await audit({ user, action: 'user.update_self', ip: clientIp(req), sessionId: req.session.jti, details: { password: Boolean(body.newPassword) } });
  res.json({ user: user.toSafeJSON() });
}));

router.post('/logout', requireAuth, ah(async (req, res) => {
  await revokeSession(req.session.jti);
  await audit({ user: req.user, action: 'auth.logout', ip: clientIp(req), sessionId: req.session.jti });
  res.json({ ok: true });
}));

export default router;
