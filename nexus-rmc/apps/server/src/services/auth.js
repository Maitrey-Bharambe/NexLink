import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { Session } from '../models/Session.js';
import { bus } from './bus.js';

const BCRYPT_ROUNDS = env.isTest ? 4 : 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 10;

export class AuthError extends Error {
  constructor(message, status = 401, code = 'UNAUTHORIZED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);
export const passwordMatches = (hash, plain) => bcrypt.compare(String(plain || ''), hash);

/** Password policy: 10+ chars with letters and digits. */
export function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

// Pre-computed hash so unknown usernames take as long as wrong passwords
// (prevents username enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('nexus-dummy-password-0', BCRYPT_ROUNDS);

/** Throw if the account cannot sign in (pending approval or disabled). */
export function assertUsable(user) {
  if (user.status === 'pending') {
    throw new AuthError('Your account is waiting for an administrator to approve it.', 403, 'PENDING_APPROVAL');
  }
  if (user.status === 'disabled') throw new AuthError('Account is disabled.', 403, 'FORBIDDEN');
}

/** Sign in with username or email + password. */
export async function verifyCredentials(login, password) {
  const key = String(login).trim().toLowerCase();
  const user = await User.findOne(key.includes('@') ? { email: key } : { username: key }).select('+passwordHash');
  if (!user || !user.passwordHash) {
    await bcrypt.compare(password, DUMMY_HASH);
    if (user?.googleId) throw new AuthError('This account signs in with Google. Use "Continue with Google".');
    throw new AuthError('Invalid username or password.');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AuthError('Account temporarily locked after repeated failures. Try again later.', 423, 'LOCKED');
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    user.failedLogins += 1;
    if (user.failedLogins >= MAX_FAILED) {
      user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
      user.failedLogins = 0;
    }
    await user.save();
    throw new AuthError('Invalid username or password.');
  }

  user.failedLogins = 0;
  user.lockedUntil = undefined;
  assertUsable(user); // only after the password matched, so status isn't leaked to guessers
  return user;
}

/** Issue a JWT bound to a server-side Session (revocable). */
export async function issueToken(user, { ip, userAgent } = {}) {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + env.jwtTtlHours * 3600_000);
  await Session.create({ jti, userId: user._id, ip, userAgent, expiresAt, lastSeenAt: new Date() });
  const token = jwt.sign({ sub: user._id.toString(), role: user.role, jti }, env.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: `${env.jwtTtlHours}h`,
    issuer: 'nexus-rmc',
  });
  return { token, expiresAt, jti };
}

/** Verify a token and its session. Returns { user, session }. */
export async function authenticateToken(token) {
  let claims;
  try {
    claims = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'], issuer: 'nexus-rmc' });
  } catch {
    throw new AuthError('Session expired or invalid. Please sign in again.');
  }
  const session = await Session.findOne({ jti: claims.jti });
  if (!session || session.revokedAt) throw new AuthError('Session has been ended. Please sign in again.');
  const user = await User.findById(claims.sub);
  if (!user || user.status !== 'active') throw new AuthError('Account is not available.', 403, 'FORBIDDEN');

  // Update lastSeen at most once a minute to avoid a write per request.
  if (!session.lastSeenAt || Date.now() - session.lastSeenAt.getTime() > 60_000) {
    session.lastSeenAt = new Date();
    await session.save();
  }
  return { user, session };
}

export async function revokeSession(jti) {
  await Session.updateOne({ jti }, { $set: { revokedAt: new Date() } });
  bus.emit('session.revoked', jti);
}
