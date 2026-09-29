import { Router } from 'express';
import { z } from 'zod';
import { NETWORK, WELL_KNOWN_PORTS } from '@nexus/protocol';
import { Device, deviceScope } from '../models/Device.js';
import { Metric } from '../models/Telemetry.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ah } from '../middleware/errors.js';
import { audit, clientIp } from '../services/audit.js';
import * as wg from '../services/wireguard.js';

const router = Router();
router.use(requireAuth);

// ---------------- VPN (Phase 3) ----------------

router.get('/vpn', ah(async (req, res) => {
  const devices = await Device.find({ ...deviceScope(req.user), 'approval.state': 'approved' }).sort({ virtualIp: 1 });
  const status = wg.status();
  res.json({
    hub: req.user.role === 'admin' ? status : { mode: status.mode, address: status.address, endpoint: status.endpoint },
    network: NETWORK,
    peers: devices.map((d) => ({
      deviceId: d.deviceId, hostname: d.hostname, virtualIp: d.virtualIp, physicalIp: d.physicalIp, simulated: d.simulated,
      status: d.status, publicKey: d.publicKey ? `${d.publicKey.slice(0, 10)}…` : null,
      tunnel: d.tunnel, latencyMs: d.latest?.latencyMs ?? null, packetLossPct: d.latest?.packetLossPct ?? null,
      appRttMs: d.latest?.appRttMs ?? null, lastSeen: d.lastSeen,
    })),
  });
}));

router.post('/vpn/refresh', requireRole('admin'), ah(async (_req, res) => {
  res.json({ hub: await wg.detect() });
}));

/** Write the hub's WireGuard config to DATA_DIR and return the install command. */
router.post('/vpn/hub-config', requireRole('admin'), ah(async (req, res) => {
  const file = await wg.writeHubConfig();
  await audit({ user: req.user, action: 'vpn.hub_config_write', ip: clientIp(req), sessionId: req.session.jti, details: { file } });
  res.json({
    file,
    commands: process.platform === 'win32'
      ? [`"C:\\Program Files\\WireGuard\\wireguard.exe" /installtunnelservice "${file}"`, 'reg add HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters /v IPEnableRouter /t REG_DWORD /d 1 /f   (then reboot, so the hub routes between peers)']
      : [`sudo cp "${file}" /etc/wireguard/${wg.IFACE}.conf`, `sudo wg-quick up ${wg.IFACE}`, 'sudo sysctl -w net.ipv4.ip_forward=1'],
  });
}));

// ---------------- Traffic (Phase 5) ----------------

router.get('/traffic', ah(async (req, res) => {
  const q = z.object({ minutes: z.coerce.number().int().min(5).max(7 * 24 * 60).default(60) }).parse(req.query);
  const devices = await Device.find({ ...deviceScope(req.user), 'approval.state': 'approved' }, 'deviceId hostname simulated latest virtualIp');
  const ids = devices.map((d) => d.deviceId);
  const since = new Date(Date.now() - q.minutes * 60_000);
  const bucketMs = Math.max(10_000, Math.floor((q.minutes * 60_000) / 90));

  const [series, perDevice] = await Promise.all([
    // Network-wide: average per device per bucket, then summed across devices.
    Metric.aggregate([
      { $match: { deviceId: { $in: ids }, t: { $gte: since } } },
      { $group: {
        _id: { b: { $subtract: [{ $toLong: '$t' }, { $mod: [{ $toLong: '$t' }, bucketMs] }] }, d: '$deviceId' },
        rx: { $avg: '$rx' }, tx: { $avg: '$tx' },
      } },
      { $group: { _id: '$_id.b', rx: { $sum: '$rx' }, tx: { $sum: '$tx' } } },
      { $sort: { _id: 1 } },
    ]),
    Metric.aggregate([
      { $match: { deviceId: { $in: ids }, t: { $gte: since } } },
      { $group: { _id: '$deviceId', rxAvg: { $avg: '$rx' }, txAvg: { $avg: '$tx' }, rxMax: { $max: '$rx' }, txMax: { $max: '$tx' }, n: { $sum: 1 } } },
    ]),
  ]);

  const byId = new Map(devices.map((d) => [d.deviceId, d]));
  const secs = q.minutes * 60;
  const talkers = perDevice.map((p) => {
    const d = byId.get(p._id);
    return {
      deviceId: p._id, hostname: d?.hostname, virtualIp: d?.virtualIp, simulated: d?.simulated,
      rxAvg: p.rxAvg || 0, txAvg: p.txAvg || 0, rxMax: p.rxMax || 0, txMax: p.txMax || 0,
      // Approximate volume = average rate × window length.
      rxBytes: Math.round((p.rxAvg || 0) * secs), txBytes: Math.round((p.txAvg || 0) * secs),
      rxNow: d?.latest?.rxBps ?? null, txNow: d?.latest?.txBps ?? null,
    };
  }).sort((a, b) => (b.rxAvg + b.txAvg) - (a.rxAvg + a.txAvg));

  res.json({
    minutes: q.minutes,
    bucketMs,
    series: series.map((s) => ({ t: s._id, rx: s.rx || 0, tx: s.tx || 0 })),
    talkers,
    now: {
      rx: devices.reduce((a, d) => a + (d.latest?.rxBps || 0), 0),
      tx: devices.reduce((a, d) => a + (d.latest?.txBps || 0), 0),
    },
  });
}));

// ---------------- Network analysis (Phase 5) ----------------

/** Network-wide protocol and port picture, built from each agent's latest snapshot. */
router.get('/analysis', ah(async (req, res) => {
  const devices = await Device.find({ ...deviceScope(req.user), 'approval.state': 'approved' }, 'deviceId hostname simulated net virtualIp status');
  const protocols = {};
  const remoteHosts = new Map();
  const ports = new Map();
  let connections = 0;
  const perDevice = [];

  for (const d of devices) {
    const net = d.net || {};
    const conns = net.connections || [];
    connections += conns.length;
    for (const [k, v] of Object.entries(net.protocols || {})) protocols[k] = (protocols[k] || 0) + (Number(v) || 0);
    for (const c of conns) {
      if (!c.raddr) continue;
      const host = String(c.raddr).replace(/:\d+$/, '');
      const e = remoteHosts.get(host) || { host, connections: 0, devices: new Set(), services: new Set() };
      e.connections += 1;
      e.devices.add(d.hostname);
      if (c.service) e.services.add(c.service);
      remoteHosts.set(host, e);
    }
    for (const l of net.listening || []) {
      const key = `${l.port}/${l.proto}`;
      const e = ports.get(key) || { port: l.port, proto: l.proto, service: l.service || WELL_KNOWN_PORTS[l.port] || null, devices: new Set() };
      e.devices.add(d.hostname);
      ports.set(key, e);
    }
    perDevice.push({
      deviceId: d.deviceId, hostname: d.hostname, simulated: d.simulated, status: d.status,
      connections: conns.length, listening: (net.listening || []).length,
      established: conns.filter((c) => c.status === 'ESTABLISHED').length,
      at: net.at || null,
    });
  }

  res.json({
    connections,
    protocols,
    perDevice,
    remoteHosts: [...remoteHosts.values()].sort((a, b) => b.connections - a.connections).slice(0, 25)
      .map((h) => ({ ...h, devices: [...h.devices], services: [...h.services] })),
    listening: [...ports.values()].sort((a, b) => a.port - b.port).slice(0, 100)
      .map((p) => ({ ...p, devices: [...p.devices] })),
  });
}));

export default router;
