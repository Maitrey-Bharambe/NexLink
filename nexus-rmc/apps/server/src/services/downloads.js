import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';

/** Where the packaged agent installer lives (first match wins). */
export function agentFile() {
  const candidates = [
    env.agentDownload,
    process.env.NEXLINK_RESOURCES && path.join(process.env.NEXLINK_RESOURCES, 'agent', 'NexLinkAgent.exe'),
    path.resolve(process.cwd(), '../agent/dist/NexLinkAgent.exe'),
  ].filter(Boolean);
  return candidates.find((f) => fs.existsSync(f)) || null;
}
