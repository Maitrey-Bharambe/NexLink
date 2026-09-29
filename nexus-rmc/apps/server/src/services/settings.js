import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { Setting } from '../models/Telemetry.js';

/**
 * Console-editable server settings with safe defaults.
 * Secrets (the Groq API key) are encrypted at rest with AES-256-GCM using a
 * key derived from the server's JWT secret, and are never sent back to clients.
 */
export const DEFAULTS = Object.freeze({
  thresholds: { cpuPct: 90, ramPct: 90, diskPct: 92, latencyMs: 150, lossPct: 5, offlineSec: 45, sustainSec: 30 },
  policy: {
    userSessionsNeedApproval: true, // Phase 7: a user's remote session waits for an admin
    adminFullShell: true,           // admins may open a full shell after confirming
    sessionTokenTtlSec: 60,
  },
  ai: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
});

const SECRET_KEYS = new Set(['ai.groqKey', 'auth.googleClientSecret']);
const cache = new Map();

const cipherKey = () => crypto.createHash('sha256').update(`${env.jwtSecret}:settings`).digest();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cipherKey(), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { enc: true, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(box) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', cipherKey(), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export async function getSetting(key) {
  if (cache.has(key)) return cache.get(key);
  const doc = await Setting.findOne({ key }).lean();
  let value = doc?.value;
  if (value && SECRET_KEYS.has(key)) value = decrypt(value);
  if (value === undefined || value === null) {
    const [group, sub] = key.split('.');
    value = sub ? DEFAULTS[group]?.[sub] ?? null : DEFAULTS[group] ?? null;
  } else if (DEFAULTS[key] && typeof value === 'object') {
    value = { ...DEFAULTS[key], ...value };
  }
  cache.set(key, value);
  return value;
}

export async function setSetting(key, value, updatedBy) {
  const stored = SECRET_KEYS.has(key) && value ? encrypt(value) : value;
  await Setting.updateOne({ key }, { $set: { value: stored, updatedBy } }, { upsert: true });
  cache.delete(key);
}

/** The Groq key: env var wins (for .env setups), otherwise the console-saved key. */
export async function groqKey() {
  return process.env.GROQ_API_KEY || (await getSetting('ai.groqKey')) || null;
}

/** Google OAuth client: .env wins, otherwise the values saved in Settings. */
export async function googleCredentials() {
  const clientId = env.google.clientId || (await getSetting('auth.googleClientId')) || '';
  const clientSecret = env.google.clientSecret || (await getSetting('auth.googleClientSecret')) || '';
  return { clientId, clientSecret, source: env.google.clientId ? 'env' : clientId ? 'console' : null };
}

/** Everything the Settings page may see (secrets reduced to "is it set"). */
export async function publicSettings() {
  const [thresholds, policy, ai, key] = await Promise.all([
    getSetting('thresholds'), getSetting('policy'), getSetting('ai'), groqKey(),
  ]);
  return {
    thresholds,
    policy,
    ai: { ...ai, keySet: Boolean(key), keySource: process.env.GROQ_API_KEY ? 'env' : key ? 'console' : null },
  };
}
