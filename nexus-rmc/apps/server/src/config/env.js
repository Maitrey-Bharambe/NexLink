import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
const dataDir = path.resolve(process.env.DATA_DIR || './data');

/**
 * JWT secret: use JWT_SECRET if provided, otherwise generate one once and
 * persist it in DATA_DIR so sessions survive server restarts.
 */
function resolveJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET;
  if (process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be at least 32 characters (or leave it empty to auto-generate).');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'jwt.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** Best guess at this machine's LAN address (skips virtual adapters). */
export function lanIp() {
  const skip = /vethernet|virtualbox|vmware|wsl|loopback|hyper-v|docker|wg|nexlink|tailscale|zerotier|radmin|hamachi|vpn/i;
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.') && !a.address.startsWith('192.168.56.') && !a.address.startsWith('10.50.0.')) {
        candidates.push(a.address);
      }
    }
  }
  candidates.sort((x, y) => rank(x) - rank(y));
  return candidates[0] || 'localhost';
}

export const env = Object.freeze({
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '0.0.0.0',
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/nexus_rmc',
  jwtSecret: isTest ? 'test-secret-'.padEnd(48, 'x') : resolveJwtSecret(),
  jwtTtlHours: Number(process.env.JWT_TTL_HOURS || 12),
  dataDir,
  corsOrigins: (process.env.CORS_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),
  // Address browsers and agents use to reach this server (Google redirect, agent enrollment).
  publicUrl: (process.env.PUBLIC_URL || `http://${isTest ? 'localhost' : lanIp()}:${process.env.PORT || 4000}`).replace(/\/+$/, ''),
  agentDownload: process.env.AGENT_DOWNLOAD || '',
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  allowRegistration: (process.env.ALLOW_REGISTRATION || 'true') !== 'false',
  isTest,
});
