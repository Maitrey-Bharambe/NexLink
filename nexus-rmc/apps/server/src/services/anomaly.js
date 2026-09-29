import { Device } from '../models/Device.js';
import { Metric } from '../models/Telemetry.js';
import { anomalyAlert } from './alerts.js';
import { bus } from './bus.js';
import { log } from '../utils/logger.js';

/**
 * Anomaly detection (D7). Every minute, each online device's own recent
 * history is its baseline:
 *   1. Preferred: the Python ai-engine (FastAPI + scikit-learn IsolationForest)
 *      at AI_ENGINE_URL trains on the device's history and scores the latest window.
 *   2. Fallback (engine not running): robust z-score (median/MAD) per feature.
 * The model used is stored with every result so the UI can say which one ran.
 */
export const FEATURES = ['cpu', 'ram', 'rx', 'tx', 'lat', 'loss', 'conn'];
const LABELS = { cpu: 'CPU', ram: 'memory', rx: 'download traffic', tx: 'upload traffic', lat: 'latency', loss: 'packet loss', conn: 'connection count' };
const ENGINE = (process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const MIN_SAMPLES = 60;

let engineUp = null;
export const engineStatus = () => ({ url: ENGINE, reachable: engineUp });

const toRow = (m) => FEATURES.map((f) => (Number.isFinite(m[f]) ? m[f] : 0));

async function scoreWithEngine(deviceId, rows) {
  const res = await fetch(`${ENGINE}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, features: FEATURES, history: rows.slice(0, -6), recent: rows.slice(-6) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`engine ${res.status}`);
  const out = await res.json();
  return { score: out.score, severity: out.severity, features: (out.contributing || []).map((f) => LABELS[f] || f), model: out.model || 'isolation-forest' };
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Robust z-score fallback: how far the recent window sits from this device's normal. */
export function scoreFallback(rows) {
  const history = rows.slice(0, -6);
  const recent = rows.slice(-6);
  const zs = FEATURES.map((_, i) => {
    const col = history.map((r) => r[i]);
    const med = median(col);
    const mad = median(col.map((v) => Math.abs(v - med))) || 1e-9;
    const cur = median(recent.map((r) => r[i]));
    const floor = [5, 5, 50_000, 50_000, 10, 1, 10][i]; // ignore tiny absolute changes
    return Math.abs(cur - med) < floor ? 0 : Math.abs(cur - med) / (1.4826 * mad);
  });
  const maxZ = Math.max(...zs);
  const score = Math.min(1, maxZ / 12);
  const severity = maxZ >= 10 ? 'high' : maxZ >= 6 ? 'medium' : maxZ >= 4 ? 'low' : 'normal';
  const features = zs.map((z, i) => [z, FEATURES[i]]).filter(([z]) => z >= 4).sort((a, b) => b[0] - a[0]).map(([, f]) => LABELS[f]);
  return { score, severity, features, model: 'robust-zscore (fallback)' };
}

export async function scoreDevice(device) {
  const samples = await Metric.find({ deviceId: device.deviceId }).sort({ t: -1 }).limit(1440).lean();
  if (samples.length < MIN_SAMPLES) {
    return { score: 0, severity: 'normal', features: [], model: `learning (${samples.length}/${MIN_SAMPLES} samples)` };
  }
  const rows = samples.reverse().map(toRow);
  try {
    const r = await scoreWithEngine(device.deviceId, rows);
    engineUp = true;
    return r;
  } catch {
    engineUp = false;
    return scoreFallback(rows);
  }
}

export function startAnomalyLoop() {
  const tick = async () => {
    const devices = await Device.find({ 'approval.state': 'approved', status: { $in: ['CONNECTED', 'DEGRADED'] } });
    let changed = false;
    for (const d of devices) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await scoreDevice(d);
        const prev = d.anomaly?.severity || 'normal';
        d.anomaly = { ...r, at: new Date() };
        // eslint-disable-next-line no-await-in-loop
        await d.save();
        // eslint-disable-next-line no-await-in-loop
        await anomalyAlert(d, r);
        if (prev !== r.severity) changed = true;
      } catch (err) {
        log.warn('anomaly.score_failed', { deviceId: d.deviceId, reason: err.message });
      }
    }
    if (changed) bus.emit('devices.changed');
  };
  setTimeout(() => tick().catch(() => {}), 20_000).unref();
  setInterval(() => tick().catch(() => {}), 60_000).unref();
}
