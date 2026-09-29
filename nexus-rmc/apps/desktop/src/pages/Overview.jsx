import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ShieldOff, ShieldCheck, Radio, Monitor, Wifi, Network as NetworkIcon, ArrowDownUp, BellRing, Timer,
  ScrollText, CheckCircle2, AlertTriangle, UserPlus, ScreenShare, ChevronRight,
} from 'lucide-react';
import { useNetwork, deviceName } from '../stores/network.js';
import { useAuth } from '../stores/auth.js';
import { api } from '../services/api.js';
import NetworkTopology from '../components/NetworkTopology.jsx';
import {
  MetricCard, StatusLabel, Badge, Sparkline, PanelHeader,
} from '../components/Primitives.jsx';
import { rate, ms, pct, timeAgo } from '../utils/format.js';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="text-right">
      <div className="mono text-[22px] font-semibold tabular-nums leading-none text-ink">{now.toLocaleTimeString([], { hour12: false })}</div>
      <div className="mt-1 text-[11.5px] text-muted">{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
    </div>
  );
}

function Hero({ attention }) {
  const user = useAuth((s) => s.user);
  const network = useNetwork((s) => s.network);
  const wsStatus = useNetwork((s) => s.wsStatus);
  const ok = wsStatus === 'CONNECTED' && attention === 0;
  return (
    <section className="card p-6 animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="label-caps flex items-center gap-2 text-accent-ink"><NetworkIcon size={13} /> {network.name}</div>
          <h1 className="mt-2 font-display text-[26px] font-semibold tracking-tight text-ink">
            {greeting()}, <span className="text-accent-ink">{user?.displayName || 'Admin'}</span>
          </h1>
          <p className="mt-1 max-w-xl text-[13px] text-muted">
            {wsStatus !== 'CONNECTED'
              ? 'The console is not connected to the control server. Live data resumes when the link is back.'
              : attention ? `${attention} item${attention === 1 ? '' : 's'} need your attention.` : 'All systems operational. Live state is streaming from the control server.'}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-[12px] font-medium ${ok ? 'border-accent/35 bg-accent/12 text-accent-ink' : 'border-gold/45 bg-gold/15 text-warn'}`}>
              {ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              {ok ? 'Operational' : 'Attention needed'}
            </span>
            <span className="mono inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1 text-[11.5px] text-muted">
              Hub {network.gateway} · {network.cidr} · UDP {network.wireguardPort}
            </span>
          </div>
        </div>
        <Clock />
      </div>
    </section>
  );
}

function RttPanel() {
  const history = useNetwork((s) => s.rttHistory);
  const rtt = useNetwork((s) => s.rttMs);
  const wsStatus = useNetwork((s) => s.wsStatus);
  const stats = useMemo(() => {
    if (!history.length) return null;
    const v = history.map((h) => h.ms);
    return { min: Math.min(...v), max: Math.max(...v), avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length) };
  }, [history]);
  return (
    <section className="card overflow-hidden">
      <PanelHeader icon={Radio} title="Control channel" subtitle="Console ↔ server PING/PONG every 5 s" right={<StatusLabel status={wsStatus} pulse />} />
      <div className="p-4">
        <div className="flex items-baseline gap-1.5">
          <span className="font-display text-[28px] font-semibold tabular-nums leading-none">{rtt ?? '—'}</span>
          <span className="text-[12px] text-muted">ms round-trip</span>
        </div>
        <div className="mt-3 h-[56px]">
          {history.length >= 2 ? <Sparkline points={history.map((h) => h.ms)} width={300} height={56} />
            : <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-line text-[11.5px] text-muted">Collecting samples…</div>}
        </div>
        <div className="mt-3 grid grid-cols-3 divide-x divide-line rounded-lg border border-line bg-raised/60 text-center">
          {[['Min', stats?.min], ['Avg', stats?.avg], ['Max', stats?.max]].map(([k, v]) => (
            <div key={k} className="py-2">
              <div className="label-caps">{k}</div>
              <div className="mono mt-0.5 font-semibold">{v != null ? `${v} ms` : '—'}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AttentionPanel({ counts }) {
  const rows = [
    { n: counts.pendingDevices, label: 'devices waiting for approval', to: '/devices' },
    { n: counts.pendingUsers, label: 'accounts waiting for approval', to: '/users' },
    { n: counts.sessionRequests, label: 'remote session requests', to: '/sessions' },
    { n: (counts.alerts.critical || 0) + (counts.alerts.warning || 0), label: 'open alerts', to: '/alerts' },
  ].filter((r) => r.n > 0);
  return (
    <section className="card overflow-hidden">
      <PanelHeader icon={AlertTriangle} title="Needs attention" subtitle="Approvals and open alerts" />
      {rows.length === 0 ? (
        <div className="flex items-center gap-2 p-4 text-[12.5px] text-muted"><CheckCircle2 size={15} className="text-accent-ink" /> Nothing waiting. You're all caught up.</div>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.to}>
              <Link to={r.to} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px] hover:bg-raised">
                <span className="flex h-7 min-w-7 items-center justify-center rounded-md bg-gold/20 px-1.5 text-[12px] font-bold text-warn">{r.n}</span>
                <span className="flex-1 text-ink-2">{r.label}</span>
                <ChevronRight size={14} className="text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityPanel() {
  const live = useNetwork((s) => s.auditFeed);
  const [initial, setInitial] = useState([]);
  useEffect(() => { api.get('/api/audit?limit=8').then((r) => setInitial(r.entries)).catch(() => {}); }, []);
  const entries = useMemo(() => {
    const seen = new Set();
    return [...live, ...initial].filter((e) => (seen.has(e._id) ? false : seen.add(e._id))).slice(0, 7);
  }, [live, initial]);
  return (
    <section className="card overflow-hidden">
      <PanelHeader icon={ScrollText} title="Recent activity" subtitle="Audit trail, streamed live" right={<Link to="/audit" className="text-[12px] font-medium text-accent-ink hover:underline">View all</Link>} />
      {entries.length === 0 ? <p className="p-4 text-[12px] text-muted">No activity yet.</p> : (
        <ol className="relative px-4 py-3">
          <span className="absolute bottom-5 left-[27px] top-5 w-px bg-line" />
          {entries.map((e) => (
            <li key={e._id} className="relative flex gap-3 py-1.5">
              <span className={`relative z-[1] mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full ring-4 ring-surface ${e.result === 'success' ? 'bg-accent' : e.result === 'denied' ? 'bg-gold' : 'bg-danger'}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] text-ink">
                  <span className="font-semibold">{e.username || e.deviceName || e.actorType}</span>{' '}
                  <span className="mono text-[11.5px] text-ink-2">{e.action}</span>
                  {e.result !== 'success' && <span className="ml-1 text-warn">({e.result})</span>}
                </div>
                <div className="text-[10.5px] text-muted">{timeAgo(e.timestamp)}{e.deviceName ? ` · ${e.deviceName}` : ''}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function DeviceTable({ devices }) {
  const top = [...devices].sort((a, b) => (b.latest?.cpuPct || 0) - (a.latest?.cpuPct || 0)).slice(0, 8);
  return (
    <section className="card overflow-hidden">
      <PanelHeader icon={Monitor} title="Devices at a glance" subtitle="Sorted by CPU load" right={<Link to="/devices" className="text-[12px] font-medium text-accent-ink hover:underline">All devices</Link>} />
      {top.length === 0 ? <p className="p-4 text-[12.5px] text-muted">No approved devices yet. Enroll one from the Devices page.</p> : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Device</th><th>Virtual IP</th><th>Status</th><th>CPU</th><th>RAM</th><th>Latency</th><th>Traffic</th></tr></thead>
            <tbody>
              {top.map((d) => (
                <tr key={d.deviceId}>
                  <td><Link to={`/devices/${d.deviceId}`} className="flex items-center gap-2 font-semibold hover:text-accent-ink">{deviceName(d)}{d.simulated && <Badge tone="blue">SIM</Badge>}{d.anomaly && <Badge tone="amber">Anomaly</Badge>}</Link></td>
                  <td className="mono text-accent-ink">{d.virtualIp}</td>
                  <td><StatusLabel status={d.status} /></td>
                  <td className="mono">{pct(d.latest?.cpuPct)}</td>
                  <td className="mono">{pct(d.latest?.ramPct)}</td>
                  <td className="mono">{ms(d.latest?.latencyMs)}</td>
                  <td className="mono text-muted">↓{rate(d.latest?.rxBps)} ↑{rate(d.latest?.txBps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function Overview() {
  const devices = useNetwork((s) => s.devices);
  const network = useNetwork((s) => s.network);
  const vpn = useNetwork((s) => s.vpn);
  const wsStatus = useNetwork((s) => s.wsStatus);
  const counts = useNetwork((s) => s.counts);
  const [throughput, setThroughput] = useState([]);

  const stats = useMemo(() => {
    const online = devices.filter((d) => d.status === 'CONNECTED' || d.status === 'DEGRADED');
    const lat = online.map((d) => d.latest?.latencyMs).filter(Number.isFinite);
    return {
      total: devices.length,
      online: online.length,
      rx: online.reduce((a, d) => a + (d.latest?.rxBps || 0), 0),
      tx: online.reduce((a, d) => a + (d.latest?.txBps || 0), 0),
      avgLat: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
      anomalies: devices.filter((d) => d.anomaly).length,
    };
  }, [devices]);

  useEffect(() => {
    setThroughput((t) => [...t.slice(-39), stats.rx + stats.tx]);
  }, [stats.rx, stats.tx]);

  const alertTotal = Object.values(counts.alerts).reduce((a, b) => a + b, 0);
  const attention = counts.pendingDevices + counts.pendingUsers + counts.sessionRequests + (counts.alerts.critical || 0);
  const real = vpn.mode === 'wireguard';
  const [tpValue, tpUnit] = rate(stats.rx + stats.tx).split(' ');

  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-5 p-6">
      <Hero attention={attention} />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
        <MetricCard icon={Wifi} label="Devices online" value={stats.online} unit={`/ ${stats.total}`} hint={`${stats.total - stats.online} offline`}>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${stats.total ? (stats.online / stats.total) * 100 : 0}%` }} />
          </div>
        </MetricCard>
        <MetricCard icon={ArrowDownUp} label="Throughput" value={tpValue} unit={tpUnit} hint={`↓ ${rate(stats.rx)} · ↑ ${rate(stats.tx)}`}>
          <div className="mt-2 h-7">{throughput.length >= 2 && <Sparkline points={throughput} width={160} height={28} />}</div>
        </MetricCard>
        <MetricCard icon={Timer} label="Avg latency to hub" value={stats.avgLat != null ? Math.round(stats.avgLat) : '—'} unit={stats.avgLat != null ? 'ms' : ''} tone={stats.avgLat > 150 ? 'amber' : 'green'} hint="ICMP bursts through the tunnel" />
        <MetricCard icon={BellRing} label="Open alerts" value={alertTotal} tone={counts.alerts.critical ? 'red' : alertTotal ? 'amber' : 'green'} hint={`${counts.alerts.critical || 0} critical · ${stats.anomalies} anomalous device(s)`} />
        <MetricCard icon={ScreenShare} label="Active sessions" value={counts.activeSessions} hint={`${counts.sessionRequests} waiting for approval`} />
      </div>

      <div className="grid min-h-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="card flex min-h-[460px] flex-1 flex-col overflow-hidden">
            <PanelHeader
              icon={NetworkIcon}
              title="Live network topology"
              subtitle={`${network.name} · ${network.cidr} · ${real ? 'WireGuard' : 'simulated tunnels'}`}
              right={(
                <div className="hidden items-center gap-3 text-[11px] text-muted md:flex">
                  <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-accent" />Active</span>
                  <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-gold" />Degraded</span>
                  <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-taupe" />Offline</span>
                </div>
              )}
            />
            <div className="min-h-0 flex-1">
              <NetworkTopology
                devices={devices}
                network={network}
                serverStatus={wsStatus}
                emptyHint={(
                  <>
                    <b className="text-ink">No devices yet.</b> Go to <Link to="/devices" className="font-semibold text-accent underline">Devices → Enroll a device</Link> to
                    connect a PC with the NexLink Agent, or start the simulator for a demo network.
                  </>
                )}
              />
            </div>
          </section>
          <DeviceTable devices={devices} />
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <AttentionPanel counts={counts} />
          <section className="card overflow-hidden">
            <PanelHeader icon={real ? ShieldCheck : ShieldOff} title="WireGuard VPN" subtitle={real ? 'Hub interface active' : 'Simulated tunnels'} right={<Badge tone={real ? 'green' : 'amber'}>{real ? 'Active' : 'Simulated'}</Badge>} />
            <div className="grid grid-cols-2 gap-px bg-line text-[12px]">
              {[['Gateway', network.gateway], ['Port', `${network.wireguardPort}/udp`], ['Subnet', network.cidr], ['Peers up', `${stats.online}`]].map(([k, v]) => (
                <div key={k} className="bg-surface px-4 py-2.5">
                  <div className="label-caps">{k}</div>
                  <div className="mono mt-0.5 truncate text-ink">{v}</div>
                </div>
              ))}
            </div>
            <Link to="/vpn" className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[12px] font-medium text-accent-ink hover:bg-raised">Manage VPN <ChevronRight size={14} /></Link>
          </section>
          <RttPanel />
          <ActivityPanel />
        </div>
      </div>
    </div>
  );
}
