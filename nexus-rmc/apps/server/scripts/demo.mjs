/**
 * Demo network: starts simulated devices against the local server.
 *
 *   npm run demo            (from the repo root)   → 5 devices
 *   node scripts/demo.mjs 8                        → 8 devices
 *
 * First run: creates a one-time enrollment token directly in the database
 * (this script runs on the server machine, so it is trusted) and starts the
 * Python simulator with it. The devices then appear under Devices → Pending
 * approval, so the approval step can be shown live. Later runs reuse the
 * simulators' saved identities, so no new token is needed.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { EnrollmentToken } from '../src/models/Telemetry.js';

const count = Math.max(1, Math.min(Number(process.argv[2]) || 5, 20));
const server = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`;
const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, '../../agent');
const simFile = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'NexLink', 'Agent', 'simulators.json');

let enrolled = 0;
try {
  const sims = JSON.parse(fs.readFileSync(simFile, 'utf8'));
  enrolled = Object.entries(sims).filter(([k, s]) => k.startsWith(`${server}|`) && s.device_secret).length;
} catch { /* first run */ }

const args = ['-m', 'nexlink_agent.simulator', '--server', server, '--count', String(count)];
if (enrolled < count) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/nexus_rmc');
  const token = `nxl_${crypto.randomBytes(18).toString('base64url')}`;
  await EnrollmentToken.create({
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    hint: token.slice(-4),
    label: 'Demo simulator',
    createdByName: 'demo script',
    expiresAt: new Date(Date.now() + 60 * 60_000),
    maxUses: count - enrolled,
  });
  await mongoose.disconnect();
  args.push('--token', token);
  console.log(`Created a demo enrollment token for ${count - enrolled} new simulated device(s).`);
  console.log('Open NexLink → Devices → Pending approval and approve them.\n');
}

const py = process.platform === 'win32' ? 'python' : 'python3';
const child = spawn(py, args, { cwd: agentDir, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
