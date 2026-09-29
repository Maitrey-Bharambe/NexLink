import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Monitor, ScreenShare, FolderTree, SquareTerminal, Stethoscope, Users as UsersIcon, Pencil, Trash2, Zap, ArrowLeft,
  Cpu, Network, ShieldCheck, Sparkles, Info,
} from 'lucide-react';
import { useNetwork } from '../stores/network.js';
import { useIsAdmin } from '../stores/auth.js';
import { api } from '../services/api.js';
import { toast } from '../stores/toasts.js';
import { StatusLabel, Badge, ErrorBanner, Spinner, PanelHeader, IconTile } from '../components/Primitives.jsx';
import { Modal, Tabs, Field, useConfirm } from '../components/ui.jsx';
import TimeChart, { Gauge, SERIES_COLORS } from '../components/Chart.jsx';
import { bytes, rate, ms, duration, timeAgo, dateTime, pct } from '../utils/format.js';

const RANGES = [{ id: 15, label: '15 min' }, { id: 60, label: '1 h' }, { id: 360, label: '6 h' }, { id: 1440, label: '24 h' }];

function AssignDialog({ device, open, onClose, onSaved }) {
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  useEffect(() => {
    if (!open) return;
    api.get('/api/users').then((r) => setUsers(r.users.filter((u) => u.role === 'user' && u.status === 'active')));
    setSelected(new Set(device.assignedUsers || []));
  }, [open, device]);
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const save = async () => {
    await api.patch(`/api/devices/${device.deviceId}`, { assignedUsers: [...selected] });
    toast({ tone: 'success', title: 'Access updated', message: `${selected.size} user(s) can now reach ${device.hostname}.` });
    onSaved();
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title={`Who can access ${device.hostname}?`} subtitle="Users only see and connect to devices assigned to them." footer={<><button className="btn btn-outline" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></>}>
      {users.length === 0 ? <p className="text-[12.5px] text-muted">No active users yet. Approve or create users on the Users page.</p> : (
        <ul className="space-y-1">
          {users.map((u) => (
            <li key={u.id}>
              <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-raised">
                <input type="checkbox" className="h-4 w-4 accent-[var(--c-accent)]" checked={selected.has(u.id)} onChange={() => toggle(u.id)} />
                <span className="font-medium text-ink">{u.displayName}</span>
                <span className="text-[11.5px] text-muted">{u.email || u.username}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function FaultPanel({ device }) {
  const [busy, setBusy] = useState(null);
  const inject = async (fault) => {
    setBusy(fault);
    try {
      const r = await api.post(`/api/devices/${device.deviceId}/sim-fault`, { fault, seconds: 180 });
      toast({ tone: 'info', title: fault === 'clear' ? 'Faults cleared' : 'Fault injected', message: r.active.length ? `Active for 3 min: ${r.active.join(', ')}` : 'Device back to normal.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Could not inject fault', message: err.message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card overflow-hidden">
      <PanelHeader icon={Zap} title="Simulate a fault" subtitle="Demo only — simulated devices" />
      <div className="flex flex-wrap gap-2 p-4">
        {[['latency', 'Latency spike'], ['loss', 'Packet loss'], ['cpu', 'CPU burn'], ['traffic', 'Traffic burst'], ['memory', 'Memory leak']].map(([f, label]) => (
          <button key={f} className="btn btn-outline h-8 text-[12px]" disabled={busy} onClick={() => inject(f)}>{busy === f ? <Spinner size={12} /> : null}{label}</button>
        ))}
        <button className="btn btn-ghost h-8 text-[12px]" disabled={busy} onClick={() => inject('clear')}>Clear all</button>
      </div>
    </section>
  );
}

export default function DeviceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const live = useNetwork((s) => s.devices.find((d) => d.deviceId === id));
  const detailVersion = useNetwork((s) => s.versions.device[id] || 0);
  const [device, setDevice] = useState(null);
  const [error, setError] = useState(null);
  const [range, setRange] = useState(15);
  const [series, setSeries] = useState([]);
  const [tab, setTab] = useState('processes');
  const [assign, setAssign] = useState(false);
  const [rename, setRename] = useState(null);
  const [confirm, dialog] = useConfirm();

  const load = useCallback(() => {
    api.get(`/api/devices/${id}`).then((r) => { setDevice(r.device); setError(null); }).catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load, detailVersion]);

  useEffect(() => {
    let alive = true;
    const fetchSeries = () => api.get(`/api/devices/${id}/metrics?minutes=${range}&buckets=120`).then((r) => alive && setSeries(r.points)).catch(() => {});
    fetchSeries();
    const t = setInterval(fetchSeries, range <= 60 ? 10_000 : 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [id, range]);

  const d = useMemo(() => (device ? { ...device, ...(live || {}), net: device.net, processes: device.processes } : null), [device, live]);

  if (error) return <div className="p-6"><ErrorBanner onRetry={load}>{error}</ErrorBanner></div>;
  if (!d) return <div className="flex justify-center p-12"><Spinner /></div>;

  const L = d.latest || {};
  const online = d.status === 'CONNECTED' || d.status === 'DEGRADED';
  const go = (path) => navigate(`${path}?device=${d.deviceId}`);

  const remove = async () => {
    if (!(await confirm({ title: `Remove ${d.hostname}?`, message: 'The device is disconnected, its WireGuard peer is removed and its history is deleted. The agent must be enrolled again.', confirmLabel: 'Remove device', danger: true }))) return;
    await api.delete(`/api/devices/${d.deviceId}`);
    toast({ tone: 'success', title: 'Device removed', message: d.hostname });
    navigate('/devices');
  };
  const saveName = async () => {
    await api.patch(`/api/devices/${d.deviceId}`, { label: rename || null });
    setRename(null);
    load();
  };

  return (
    <div className="mx-auto max-w-[1680px] space-y-5 p-6">
      {dialog}
      {isAdmin && <AssignDialog device={d} open={assign} onClose={() => setAssign(false)} onSaved={load} />}
      <Modal open={rename !== null} onClose={() => setRename(null)} title="Rename device" width={420} footer={<><button className="btn btn-outline" onClick={() => setRename(null)}>Cancel</button><button className="btn btn-primary" onClick={saveName}>Save</button></>}>
        <Field label="Display name" hint={`The hostname (${d.hostname}) is kept for reference.`}><input className="input" value={rename || ''} onChange={(e) => setRename(e.target.value)} /></Field>
      </Modal>

      <button className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink" onClick={() => navigate(-1)}><ArrowLeft size={13} /> Back</button>

      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex items-center gap-4">
            <IconTile icon={Monitor} size={52} tone={online ? 'green' : 'neutral'} />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display text-[22px] font-semibold text-ink">{d.label || d.hostname}</h1>
                {d.simulated && <Badge tone="blue">Simulated</Badge>}
                {d.anomaly && <Badge tone="amber">Anomaly · {d.anomaly.severity}</Badge>}
                <StatusLabel status={d.status} pulse />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
                <span>Virtual IP <b className="mono text-accent-ink">{d.virtualIp || '—'}</b></span>
                <span>Physical <span className="mono text-ink-2">{d.physicalIp || '—'}</span></span>
                <span>Tunnel <b className="text-ink-2">{d.tunnel?.mode || '—'}</b></span>
                <span>{d.os}</span>
                <span>Last seen {timeAgo(d.lastSeen)}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={!online || d.capabilities?.screen === false} onClick={() => go('/remote-desktop')}><ScreenShare size={14} /> Remote desktop</button>
            <button className="btn btn-outline" disabled={!online} onClick={() => go('/files')}><FolderTree size={14} /> Files</button>
            <button className="btn btn-outline" disabled={!online} onClick={() => go('/terminal')}><SquareTerminal size={14} /> Terminal</button>
            <button className="btn btn-outline" disabled={!online} onClick={() => go('/diagnostics')}><Stethoscope size={14} /> Diagnose</button>
            {isAdmin && (
              <>
                <button className="btn btn-ghost" onClick={() => setAssign(true)} title="Assign users"><UsersIcon size={14} /> {d.assignedUsers?.length || 0}</button>
                <button className="btn btn-ghost" onClick={() => setRename(d.label || '')} title="Rename"><Pencil size={14} /></button>
                <button className="btn btn-ghost text-danger hover:bg-danger/10" onClick={remove} title="Remove device"><Trash2 size={14} /></button>
              </>
            )}
          </div>
        </div>
      </section>

      {d.anomaly && (
        <div className="flex items-start gap-3 rounded-lg border border-gold/45 bg-gold/12 px-4 py-3 text-[12.5px]">
          <Sparkles size={16} className="mt-0.5 text-warn" />
          <div className="text-ink-2">
            <b className="text-ink">Unusual behaviour detected</b> ({d.anomaly.severity}, score {Number(d.anomaly.score).toFixed(2)}) in: {d.anomaly.features?.join(', ') || 'combined metrics'}.{' '}
            <Link to={`/ai?q=${encodeURIComponent(`Why is ${d.hostname} behaving unusually?`)}`} className="font-medium text-accent-ink hover:underline">Ask the assistant</Link>
          </div>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-5">
          <section className="card p-5">
            <div className="flex justify-around">
              <Gauge value={L.cpuPct} label="CPU" />
              <Gauge value={L.ramPct} label="Memory" />
              <Gauge value={L.diskPct} label="Disk" warnAt={80} dangerAt={92} />
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-[12px]">
              {[
                ['Latency (ICMP)', ms(L.latencyMs)], ['Packet loss', L.packetLossPct != null ? `${L.packetLossPct}%` : '—'],
                ['App RTT', ms(L.appRttMs)], ['Uptime', duration(L.uptimeSec)],
                ['Download', rate(L.rxBps)], ['Upload', rate(L.txBps)],
                ['Processes', L.processCount ?? '—'], ['Connections', L.connCount ?? '—'],
              ].map(([k, v]) => (
                <div key={k}><dt className="label-caps">{k}</dt><dd className="mono mt-0.5 font-semibold text-ink">{v}</dd></div>
              ))}
            </dl>
          </section>
          <section className="card overflow-hidden">
            <PanelHeader icon={Info} title="System" />
            <dl className="divide-y divide-line text-[12px]">
              {[
                ['Hostname', d.hostname], ['CPU', d.cpuModel || '—'], ['Cores', d.cpuCores || '—'], ['Memory', d.ramTotal ? bytes(d.ramTotal, 0) : '—'],
                ['Architecture', d.arch || '—'], ['Agent', d.agentVersion || '—'], ['Enrolled', dateTime(d.enrolledAt)],
                ['Approved by', d.approvedBy || '—'], ['WireGuard key', d.publicKey ? `${d.publicKey.slice(0, 16)}…` : '—'],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 px-4 py-2"><dt className="text-muted">{k}</dt><dd className="mono truncate text-right text-ink">{v}</dd></div>
              ))}
            </dl>
          </section>
          {isAdmin && d.simulated && online && <FaultPanel device={d} />}
        </div>

        <div className="min-w-0 space-y-5">
          <section className="card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
              <div className="flex items-center gap-2.5"><IconTile icon={Cpu} size={28} /><span className="text-[13px] font-semibold">Performance history</span></div>
              <Tabs value={range} onChange={setRange} items={RANGES} />
            </div>
            <div className="grid gap-6 p-4 2xl:grid-cols-2">
              <div>
                <div className="label-caps mb-2">CPU & memory</div>
                <TimeChart points={series} yMax={100} yFormat={(v) => `${Math.round(v)}%`} series={[
                  { key: 'cpu', label: 'CPU', color: SERIES_COLORS.aqua, area: true },
                  { key: 'ram', label: 'Memory', color: SERIES_COLORS.gold },
                ]} />
              </div>
              <div>
                <div className="label-caps mb-2">Network throughput</div>
                <TimeChart points={series} yFormat={(v) => rate(v)} series={[
                  { key: 'rx', label: 'Download', color: SERIES_COLORS.aqua, area: true },
                  { key: 'tx', label: 'Upload', color: SERIES_COLORS.gold },
                ]} />
              </div>
              <div className="2xl:col-span-2">
                <div className="label-caps mb-2">Latency to hub</div>
                <TimeChart points={series} height={150} yFormat={(v) => `${Math.round(v)} ms`} series={[
                  { key: 'lat', label: 'ICMP latency', color: SERIES_COLORS.aqua, area: true },
                  { key: 'rtt', label: 'App RTT', color: SERIES_COLORS.taupe },
                  { key: 'loss', label: 'Packet loss (%)', color: SERIES_COLORS.gold, format: (v) => `${v.toFixed(1)}%` },
                ]} />
              </div>
            </div>
          </section>

          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
              <div className="flex items-center gap-2.5"><IconTile icon={Network} size={28} /><span className="text-[13px] font-semibold">Live detail</span><span className="text-[11px] text-muted">refreshed every 15 s</span></div>
              <Tabs value={tab} onChange={setTab} items={[
                { id: 'processes', label: 'Processes', count: d.processes?.length },
                { id: 'connections', label: 'Connections', count: d.net?.connections?.length },
                { id: 'listening', label: 'Listening', count: d.net?.listening?.length },
                { id: 'interfaces', label: 'Interfaces', count: d.net?.interfaces?.length },
              ]} />
            </div>
            <div className="max-h-[420px] overflow-auto">
              {tab === 'processes' && (
                <table className="table"><thead><tr><th>Process</th><th>PID</th><th>CPU</th><th>Memory</th><th>User</th></tr></thead>
                  <tbody>{(d.processes || []).map((p) => (
                    <tr key={`${p.pid}-${p.name}`}><td className="font-medium">{p.name}</td><td className="mono text-muted">{p.pid}</td><td className="mono">{pct(p.cpu)}</td><td className="mono">{p.memMb} MB</td><td className="text-muted">{p.user || '—'}</td></tr>
                  ))}</tbody></table>
              )}
              {tab === 'connections' && (
                <table className="table"><thead><tr><th>Proto</th><th>Local</th><th>Remote</th><th>State</th><th>Service</th><th>Process</th></tr></thead>
                  <tbody>{(d.net?.connections || []).map((c, i) => (
                    <tr key={i}><td className="mono">{c.proto}</td><td className="mono text-muted">{c.laddr}</td><td className="mono text-accent-ink">{c.raddr}</td><td className="text-[11.5px]">{c.status}</td><td><Badge>{c.service}</Badge></td><td className="text-muted">{c.process || '—'}</td></tr>
                  ))}</tbody></table>
              )}
              {tab === 'listening' && (
                <table className="table"><thead><tr><th>Port</th><th>Proto</th><th>Address</th><th>Service</th><th>Process</th></tr></thead>
                  <tbody>{(d.net?.listening || []).map((l) => (
                    <tr key={`${l.port}/${l.proto}`}><td className="mono font-semibold">{l.port}</td><td className="mono">{l.proto}</td><td className="mono text-muted">{l.addr}</td><td>{l.service ? <Badge tone="blue">{l.service}</Badge> : '—'}</td><td className="text-muted">{l.process || '—'}</td></tr>
                  ))}</tbody></table>
              )}
              {tab === 'interfaces' && (
                <table className="table"><thead><tr><th>Interface</th><th>State</th><th>IPv4</th><th>Speed</th><th>Received</th><th>Sent</th></tr></thead>
                  <tbody>{(d.net?.interfaces || []).map((n) => (
                    <tr key={n.name}><td className="font-medium">{n.name}{n.wireguard && <ShieldCheck size={12} className="ml-1.5 inline text-accent-ink" />}</td><td>{n.up ? <Badge tone="green">Up</Badge> : <Badge>Down</Badge>}</td><td className="mono">{(n.ipv4 || []).join(', ') || '—'}</td><td className="mono text-muted">{n.speedMbps ? `${n.speedMbps} Mbps` : '—'}</td><td className="mono">{bytes(n.rxBytes)}</td><td className="mono">{bytes(n.txBytes)}</td></tr>
                  ))}</tbody></table>
              )}
              {!d.net && tab !== 'processes' && <p className="p-6 text-center text-[12.5px] text-muted">Waiting for the first network snapshot from the agent…</p>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
