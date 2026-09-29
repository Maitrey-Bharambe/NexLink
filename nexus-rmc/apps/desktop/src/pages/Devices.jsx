import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Monitor, Search, Plus, KeyRound, Copy, Check, ShieldCheck, X, Download, Terminal as TermIcon, Cpu, MemoryStick, Clock3,
} from 'lucide-react';
import { useNetwork, deviceName } from '../stores/network.js';
import { api } from '../services/api.js';
import { PageHeader, StatusLabel, Badge, IconTile, ErrorBanner, Spinner } from '../components/Primitives.jsx';
import { Modal, Tabs, Field, Empty, useConfirm } from '../components/ui.jsx';
import { toast } from '../stores/toasts.js';
import { ms, rate, timeAgo, dateTime } from '../utils/format.js';

function Meter({ value }) {
  if (value == null) return <span className="mono text-muted">—</span>;
  const tone = value > 85 ? 'bg-danger' : value > 65 ? 'bg-gold' : 'bg-accent';
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-line">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, value)}%` }} />
      </span>
      <span className="mono w-9 text-right tabular-nums">{Math.round(value)}%</span>
    </span>
  );
}

function CopyBox({ label, value }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div>
      <div className="mb-1 text-[11.5px] font-medium text-ink">{label}</div>
      <div className="flex items-stretch gap-2">
        <code className="mono flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-line bg-raised px-3 py-2 text-[11.5px] text-ink">{value}</code>
        <button className="btn btn-outline h-auto px-2.5" onClick={copy} title="Copy">{copied ? <Check size={14} className="text-accent-ink" /> : <Copy size={14} />}</button>
      </div>
    </div>
  );
}

function EnrollDialog({ open, onClose }) {
  const [form, setForm] = useState({ label: '', ttlMinutes: 60, maxUses: 1 });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { if (open) { setResult(null); setError(null); } }, [open]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.post('/api/devices/enrollment/tokens', { label: form.label || undefined, ttlMinutes: Number(form.ttlMinutes), maxUses: Number(form.maxUses) }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      title="Enroll a device"
      subtitle="Create a one-time token. The agent generates its own WireGuard keys; only the public key is sent."
      footer={result ? <button className="btn btn-primary" onClick={onClose}>Done</button> : (
        <>
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={create} disabled={busy}>{busy ? <Spinner size={14} /> : <KeyRound size={14} />} Create token</button>
        </>
      )}
    >
      {error && <div className="mb-3"><ErrorBanner>{error}</ErrorBanner></div>}
      {!result ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-3"><Field label="Label (optional)" hint="Helps you recognise the request, e.g. 'Lab 2 PCs'."><input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field></div>
          <Field label="Valid for">
            <select className="input" value={form.ttlMinutes} onChange={(e) => setForm({ ...form, ttlMinutes: e.target.value })}>
              <option value={15}>15 minutes</option><option value={60}>1 hour</option><option value={1440}>24 hours</option><option value={10080}>7 days</option>
            </select>
          </Field>
          <Field label="Number of devices" hint="Use more than 1 for the simulator.">
            <input className="input" type="number" min={1} max={100} value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} />
          </Field>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-gold/45 bg-gold/12 px-3 py-2 text-[12px] text-warn">
            This token is shown only once. It expires {dateTime(result.expiresAt)} and works for {form.maxUses} device(s).
          </div>
          <div>
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-ink"><Download size={14} /> On the PC you want to manage</div>
            <ol className="mb-3 list-decimal space-y-1 pl-5 text-[12px] text-ink-2">
              <li>
                Download and run <b>NexLink Agent</b>
                {result.agentDownload
                  ? <> from <a className="mono font-medium text-accent-ink underline" href={result.agentDownload} target="_blank" rel="noreferrer">{result.agentDownload}</a> (open this link on that PC).</>
                  : <> (NexLinkAgent.exe — build it with <span className="mono">npm run build:agent</span>).</>}
              </li>
              <li>Paste the enrollment code below into the window that opens, and click <b>Enroll</b>.</li>
              <li>Run it once as Administrator if you want a real WireGuard tunnel.</li>
            </ol>
            <CopyBox label="Enrollment code (server address + token)" value={result.code} />
          </div>
          <details className="text-[12px]">
            <summary className="cursor-pointer text-muted">Advanced: token, Python command, simulator</summary>
            <div className="mt-3 space-y-3">
              <CopyBox label="Server address" value={result.serverUrl} />
              <CopyBox label="Enrollment token" value={result.token} />
              <CopyBox label="Python agent (from the apps/agent folder)" value={result.commands.agent} />
              <CopyBox label="Simulated devices (demo)" value={result.commands.simulator} />
            </div>
          </details>
          <p className="text-[11.5px] text-muted">The device then appears under <b>Pending approval</b>. Approving it assigns a virtual IP from 10.50.0.0/24.</p>
        </div>
      )}
    </Modal>
  );
}

function PendingList({ onChanged }) {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState(null);
  const version = useNetwork((s) => s.versions.enrollment);
  const [confirm, dialog] = useConfirm();

  const load = useCallback(() => {
    api.get('/api/devices?include=all').then((r) => setDevices(r.devices.filter((d) => d.approval === 'pending'))).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load, version]);

  const approve = async (d) => {
    try {
      const r = await api.post(`/api/devices/${d.deviceId}/approve`, {});
      toast({ tone: 'success', title: 'Device approved', message: `${d.hostname} joined the network as ${r.device.virtualIp}.` });
      load();
      onChanged?.();
    } catch (err) { toast({ tone: 'danger', title: 'Could not approve', message: err.message }); }
  };
  const reject = async (d) => {
    if (!(await confirm({ title: `Reject ${d.hostname}?`, message: 'The agent is disconnected and must be enrolled again with a new token.', confirmLabel: 'Reject', danger: true }))) return;
    await api.post(`/api/devices/${d.deviceId}/reject`, {});
    load();
  };

  if (error) return <div className="p-4"><ErrorBanner>{error}</ErrorBanner></div>;
  if (!devices) return <div className="flex justify-center p-8"><Spinner /></div>;
  if (!devices.length) return <Empty icon={ShieldCheck} title="No devices waiting">New enrollment requests appear here for approval.</Empty>;
  return (
    <div className="divide-y divide-line">
      {dialog}
      {devices.map((d) => (
        <div key={d.deviceId} className="flex flex-wrap items-center gap-4 px-4 py-3">
          <IconTile icon={Monitor} tone="amber" size={36} />
          <div className="min-w-[220px] flex-1">
            <div className="flex items-center gap-2 font-semibold text-ink">{d.hostname}{d.simulated && <Badge tone="blue">SIM</Badge>}</div>
            <div className="text-[11.5px] text-muted">{d.os || 'Unknown OS'} · from <span className="mono">{d.physicalIp || '—'}</span> · requested {timeAgo(d.lastSeen)}</div>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-outline h-8" onClick={() => reject(d)}><X size={14} /> Reject</button>
            <button className="btn btn-accent h-8" onClick={() => approve(d)}><Check size={14} /> Approve</button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Devices() {
  const devices = useNetwork((s) => s.devices);
  const pendingCount = useNetwork((s) => s.counts.pendingDevices);
  const navigate = useNavigate();
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [enroll, setEnroll] = useState(false);

  const filters = {
    all: () => true,
    online: (d) => d.status === 'CONNECTED' || d.status === 'DEGRADED',
    offline: (d) => d.status !== 'CONNECTED' && d.status !== 'DEGRADED',
  };
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const f = filters[tab] || filters.all;
    return devices.filter(f).filter((d) => !q || [d.hostname, d.label, d.virtualIp, d.physicalIp, d.os].some((v) => v?.toLowerCase().includes(q)));
  }, [devices, query, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mx-auto max-w-[1680px] p-6">
      <PageHeader
        icon={Monitor}
        eyebrow="Network"
        title="Devices"
        subtitle="Authorized machines in the private network. Click a device for live metrics and actions."
        actions={<button className="btn btn-primary" onClick={() => setEnroll(true)}><Plus size={15} /> Enroll a device</button>}
      />
      <EnrollDialog open={enroll} onClose={() => setEnroll(false)} />

      <div className="card overflow-hidden animate-fade-up">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { id: 'all', label: 'All', count: devices.length },
              { id: 'online', label: 'Online', count: devices.filter(filters.online).length },
              { id: 'offline', label: 'Offline', count: devices.filter(filters.offline).length },
              { id: 'pending', label: 'Pending approval', count: pendingCount },
            ]}
          />
          {tab !== 'pending' && (
            <label className="relative ml-auto w-full max-w-[280px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input className="input h-9 pl-8" placeholder="Filter by name, IP or OS" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
        </div>

        {tab === 'pending' ? <PendingList /> : devices.length === 0 ? (
          <Empty icon={Monitor} title="No devices enrolled yet" action={<button className="btn btn-primary" onClick={() => setEnroll(true)}><Plus size={15} /> Enroll a device</button>}>
            Create an enrollment token, run the NexLink Agent (or the simulator) with it, then approve the request here.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Device</th><th>Virtual IP</th><th>Physical IP</th><th>Status</th><th>Tunnel</th>
                  <th>Latency</th><th><span className="inline-flex items-center gap-1"><Cpu size={11} />CPU</span></th>
                  <th><span className="inline-flex items-center gap-1"><MemoryStick size={11} />RAM</span></th><th>Traffic</th><th>Users</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.deviceId} className="cursor-pointer" onClick={() => navigate(`/devices/${d.deviceId}`)}>
                    <td>
                      <div className="flex items-center gap-3">
                        <IconTile icon={Monitor} size={32} tone={d.status === 'CONNECTED' ? 'green' : d.status === 'DEGRADED' ? 'amber' : 'neutral'} />
                        <div>
                          <Link to={`/devices/${d.deviceId}`} className="flex items-center gap-2 font-semibold hover:text-accent-ink" onClick={(e) => e.stopPropagation()}>
                            {deviceName(d)}{d.simulated && <Badge tone="blue">SIM</Badge>}{d.anomaly && <Badge tone="amber">Anomaly</Badge>}
                          </Link>
                          <div className="text-[11px] text-muted">{d.os || 'Unknown OS'}</div>
                        </div>
                      </div>
                    </td>
                    <td className="mono text-accent-ink">{d.virtualIp || '—'}</td>
                    <td className="mono text-muted">{d.physicalIp || '—'}</td>
                    <td><StatusLabel status={d.status} /><div className="text-[10.5px] text-muted"><Clock3 size={10} className="mr-1 inline" />{timeAgo(d.lastSeen)}</div></td>
                    <td><Badge tone={d.tunnel?.mode === 'wireguard' ? 'green' : d.tunnel?.mode === 'simulated' ? 'blue' : 'neutral'}>{d.tunnel?.mode || '—'}</Badge></td>
                    <td className="mono">{ms(d.latest?.latencyMs)}{d.latest?.packetLossPct ? <span className="ml-1 text-warn">{d.latest.packetLossPct}% loss</span> : null}</td>
                    <td><Meter value={d.latest?.cpuPct} /></td>
                    <td><Meter value={d.latest?.ramPct} /></td>
                    <td className="mono text-[11.5px] text-muted">↓{rate(d.latest?.rxBps)}<br />↑{rate(d.latest?.txBps)}</td>
                    <td className="text-muted">{d.assignedUsers?.length || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="py-10 text-center text-[12.5px] text-muted">No devices match this filter.</p>}
          </div>
        )}
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-muted"><TermIcon size={12} /> Tip: the simulator creates labelled demo devices (SIM) so the full workflow can be shown on one laptop.</p>
    </div>
  );
}
