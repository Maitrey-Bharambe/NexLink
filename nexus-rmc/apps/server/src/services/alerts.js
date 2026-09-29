import { Alert } from '../models/Telemetry.js';
import { Device } from '../models/Device.js';
import { getSetting } from './settings.js';
import { bus } from './bus.js';

/**
 * Rules engine (Phase 5). Each rule is evaluated on every metric sample; a
 * breach must persist for `sustainSec` before an alert opens, and the alert
 * auto-resolves once the value is back to normal. At most one open alert
 * exists per device+rule (deduplicated by key).
 */
const RULES = [
  { kind: 'cpu_high', field: 'cpuPct', th: 'cpuPct', label: 'CPU usage', unit: '%', severity: 'warning' },
  { kind: 'ram_high', field: 'ramPct', th: 'ramPct', label: 'Memory usage', unit: '%', severity: 'warning' },
  { kind: 'disk_high', field: 'diskPct', th: 'diskPct', label: 'Disk usage', unit: '%', severity: 'warning', instant: true },
  { kind: 'latency_high', field: 'latencyMs', th: 'latencyMs', label: 'Latency to hub', unit: ' ms', severity: 'warning' },
  { kind: 'packet_loss', field: 'packetLossPct', th: 'lossPct', label: 'Packet loss', unit: '%', severity: 'critical' },
];

const breachSince = new Map(); // `${deviceId}:${kind}` -> first breach time

async function open({ deviceId, hostname, kind, severity, message, value, threshold }) {
  const key = `${deviceId}:${kind}`;
  const existing = await Alert.findOne({ key, status: { $ne: 'resolved' } });
  if (existing) {
    existing.lastSeenAt = new Date();
    existing.count += 1;
    existing.value = value;
    await existing.save();
    return existing;
  }
  const alert = await Alert.create({ key, deviceId, hostname, kind, severity, message, value, threshold });
  bus.emit('alert', alert.toObject());
  return alert;
}

async function autoResolve(deviceId, kind) {
  const res = await Alert.updateMany(
    { key: `${deviceId}:${kind}`, status: { $ne: 'resolved' } },
    { $set: { status: 'resolved', resolvedAt: new Date(), autoResolved: true, resolvedBy: 'system' } },
  );
  if (res.modifiedCount) bus.emit('alerts.changed');
}

export async function evaluateSample(device, latest) {
  const t = await getSetting('thresholds');
  const now = Date.now();
  for (const rule of RULES) {
    const value = latest[rule.field];
    if (value == null) continue;
    const key = `${device.deviceId}:${rule.kind}`;
    const threshold = t[rule.th];
    if (value > threshold) {
      if (!breachSince.has(key)) breachSince.set(key, now);
      if (rule.instant || now - breachSince.get(key) >= t.sustainSec * 1000) {
        // eslint-disable-next-line no-await-in-loop
        await open({
          deviceId: device.deviceId, hostname: device.hostname, kind: rule.kind, severity: rule.severity,
          message: `${rule.label} on ${device.hostname} is ${Math.round(value)}${rule.unit} (limit ${threshold}${rule.unit}).`,
          value, threshold,
        });
      }
    } else if (breachSince.has(key)) {
      breachSince.delete(key);
      // eslint-disable-next-line no-await-in-loop
      await autoResolve(device.deviceId, rule.kind);
    }
  }
}

export async function deviceOffline(device) {
  await open({
    deviceId: device.deviceId, hostname: device.hostname, kind: 'offline', severity: 'critical',
    message: `${device.hostname} lost its connection to the hub.`,
  });
}

export const deviceOnline = (device) => autoResolve(device.deviceId, 'offline');

export async function anomalyAlert(device, anomaly) {
  if (anomaly.severity === 'high' || anomaly.severity === 'medium') {
    await open({
      deviceId: device.deviceId, hostname: device.hostname, kind: 'anomaly',
      severity: anomaly.severity === 'high' ? 'critical' : 'warning',
      message: `Unusual behaviour on ${device.hostname}: ${anomaly.features.slice(0, 3).join(', ') || 'combined metrics'} (score ${anomaly.score.toFixed(2)}).`,
      value: anomaly.score,
    });
  } else {
    await autoResolve(device.deviceId, 'anomaly');
  }
}

/** Devices that stopped reporting without closing their socket cleanly. */
export function startOfflineSweep() {
  setInterval(async () => {
    const t = await getSetting('thresholds');
    const cutoff = new Date(Date.now() - t.offlineSec * 1000);
    const stale = await Device.find({ status: { $in: ['CONNECTED', 'DEGRADED'] }, lastSeen: { $lt: cutoff } });
    for (const d of stale) {
      d.status = 'DISCONNECTED';
      // eslint-disable-next-line no-await-in-loop
      await d.save();
      // eslint-disable-next-line no-await-in-loop
      await deviceOffline(d);
    }
    if (stale.length) bus.emit('devices.changed');
  }, 15_000).unref();
}
