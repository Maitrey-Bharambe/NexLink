import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { NETWORK, ipToInt, intToIp } from '@nexus/protocol';
import { env } from '../config/env.js';
import { Device } from '../models/Device.js';
import { log } from '../utils/logger.js';
import { bus } from './bus.js';

/**
 * WireGuard hub (D1). The control server machine is the hub at 10.50.0.1.
 *
 *  - Hub keys are generated here (X25519, same format as `wg genkey`).
 *  - If the `wg` tool is present AND the `wg-nexlink` interface is up, peers are
 *    added/removed live with `wg set`, and handshake/rx/tx are read from
 *    `wg show wg-nexlink dump` every 10 s. Mode = "wireguard".
 *  - Otherwise the network runs in "simulated" mode: addressing, peers and keys
 *    are all real, but no kernel tunnel exists, and the UI says so.
 */

export const IFACE = 'wg-nexlink';
const WG_DIR = path.join(env.dataDir, 'wireguard');
const HUB_FILE = path.join(WG_DIR, 'hub.json');
const WG_CANDIDATES = process.platform === 'win32'
  ? ['C:\\Program Files\\WireGuard\\wg.exe', 'wg']
  : ['/usr/bin/wg', '/usr/local/bin/wg', 'wg'];

const state = {
  mode: 'simulated',
  wgPath: null,
  reason: 'WireGuard is not installed on the hub.',
  lastCheck: null,
};

function run(file, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });
}

/** Generate a WireGuard (Curve25519) keypair as base64, like `wg genkey | wg pubkey`. */
export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return { publicKey: pub.toString('base64'), privateKey: priv.toString('base64') };
}

export function isValidWgKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/.test(key);
}

let hubKeys = null;
export function hub() {
  if (hubKeys) return hubKeys;
  fs.mkdirSync(WG_DIR, { recursive: true });
  if (fs.existsSync(HUB_FILE)) {
    hubKeys = JSON.parse(fs.readFileSync(HUB_FILE, 'utf8'));
  } else {
    hubKeys = { ...generateKeyPair(), createdAt: new Date().toISOString() };
    fs.writeFileSync(HUB_FILE, JSON.stringify(hubKeys, null, 2), { mode: 0o600 });
    log.info('wireguard.hub_keys_created');
  }
  return hubKeys;
}

export function endpoint() {
  if (process.env.WG_ENDPOINT) return process.env.WG_ENDPOINT;
  const host = new URL(env.publicUrl).hostname;
  return `${host}:${NETWORK.wireguardPort}`;
}

export async function detect() {
  state.lastCheck = new Date();
  state.wgPath = null;
  for (const candidate of WG_CANDIDATES) {
    // eslint-disable-next-line no-await-in-loop
    const r = await run(candidate, ['--version']);
    if (r.ok) { state.wgPath = candidate; break; }
  }
  if (!state.wgPath) {
    state.mode = 'simulated';
    state.reason = 'WireGuard is not installed on the hub. Tunnels are simulated.';
    return status();
  }
  const r = await run(state.wgPath, ['show', IFACE, 'public-key']);
  if (r.ok && r.stdout.trim()) {
    state.mode = 'wireguard';
    state.reason = null;
    if (r.stdout.trim() !== hub().publicKey) {
      state.reason = 'The running wg-nexlink interface uses a different key than NexLink generated. Re-install the hub config.';
    }
  } else {
    state.mode = 'simulated';
    state.reason = /access|denied|permission|operation not permitted/i.test(r.stderr)
      ? 'WireGuard is installed, but the server is not running as Administrator, so it cannot manage the interface.'
      : `WireGuard is installed, but the ${IFACE} interface is not up yet. Install the hub config (VPN page).`;
  }
  return status();
}

export function status() {
  return {
    mode: state.mode,
    interface: IFACE,
    wgInstalled: Boolean(state.wgPath),
    reason: state.reason,
    publicKey: hub().publicKey,
    endpoint: endpoint(),
    address: `${NETWORK.gateway}/24`,
    listenPort: NETWORK.wireguardPort,
    lastCheck: state.lastCheck,
  };
}

/** Next free virtual IP from the agent (or simulated) range. */
export async function allocateIp(simulated) {
  const [lo, hi] = simulated ? NETWORK.simulatedRange : NETWORK.agentRange;
  const used = new Set((await Device.find({ virtualIp: { $ne: null } }, 'virtualIp')).map((d) => d.virtualIp));
  for (let n = ipToInt(lo); n <= ipToInt(hi); n += 1) {
    const ip = intToIp(n);
    if (!used.has(ip)) return ip;
  }
  throw new Error('The private network is full.');
}

export async function addPeer(publicKey, virtualIp) {
  if (state.mode !== 'wireguard' || !isValidWgKey(publicKey)) return false;
  const r = await run(state.wgPath, ['set', IFACE, 'peer', publicKey, 'allowed-ips', `${virtualIp}/32`]);
  if (!r.ok) log.warn('wireguard.add_peer_failed', { reason: r.stderr });
  return r.ok;
}

export async function removePeer(publicKey) {
  if (state.mode !== 'wireguard' || !isValidWgKey(publicKey)) return false;
  const r = await run(state.wgPath, ['set', IFACE, 'peer', publicKey, 'remove']);
  return r.ok;
}

/** Hub config for `wireguard.exe /installtunnelservice` (Windows) or `wg-quick up` (Linux). */
export async function hubConfig() {
  const peers = await Device.find({ 'approval.state': 'approved', simulated: false, publicKey: { $ne: null } }, 'hostname publicKey virtualIp');
  const lines = [
    '# NexLink WireGuard hub — generated by the control server',
    '[Interface]',
    `PrivateKey = ${hub().privateKey}`,
    `Address = ${NETWORK.gateway}/24`,
    `ListenPort = ${NETWORK.wireguardPort}`,
    '',
  ];
  for (const p of peers) {
    if (!isValidWgKey(p.publicKey)) continue;
    lines.push(`# ${p.hostname}`, '[Peer]', `PublicKey = ${p.publicKey}`, `AllowedIPs = ${p.virtualIp}/32`, '');
  }
  return lines.join('\n');
}

export async function writeHubConfig() {
  fs.mkdirSync(WG_DIR, { recursive: true });
  const file = path.join(WG_DIR, `${IFACE}.conf`);
  fs.writeFileSync(file, await hubConfig(), { mode: 0o600 });
  return file;
}

/** Read per-peer handshake and byte counters from the live interface. */
async function pollPeers() {
  if (state.mode !== 'wireguard') return;
  const r = await run(state.wgPath, ['show', IFACE, 'dump']);
  if (!r.ok) return;
  const rows = r.stdout.trim().split('\n').slice(1); // first line is the interface
  let changed = false;
  for (const row of rows) {
    const [pub, , endpointAddr, , handshake, rx, tx] = row.split('\t');
    const hs = Number(handshake) ? new Date(Number(handshake) * 1000) : null;
    const up = Boolean(hs && Date.now() - hs.getTime() < 3 * 60_000);
    // eslint-disable-next-line no-await-in-loop
    const res = await Device.updateOne({ publicKey: pub }, {
      $set: {
        'tunnel.mode': 'wireguard', 'tunnel.up': up, 'tunnel.endpoint': endpointAddr === '(none)' ? null : endpointAddr,
        'tunnel.handshakeAt': hs, 'tunnel.rxBytes': Number(rx), 'tunnel.txBytes': Number(tx),
      },
    });
    if (res.modifiedCount) changed = true;
  }
  if (changed) bus.emit('devices.changed');
}

export async function startWireGuard() {
  hub();
  await detect();
  log.info('wireguard.mode', { mode: state.mode, reason: state.reason });
  setInterval(() => { detect().catch(() => {}); }, 60_000).unref();
  setInterval(() => { pollPeers().catch(() => {}); }, 10_000).unref();
}
