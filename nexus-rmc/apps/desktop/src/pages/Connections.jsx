import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cable, ShieldCheck, Radio, RefreshCw } from 'lucide-react';
import { useNetwork } from '../stores/network.js';
import { api } from '../services/api.js';
import { PageHeader, StatusLabel, Badge, PanelHeader, ErrorBanner } from '../components/Primitives.jsx';
import { Empty, useConfirm } from '../components/ui.jsx';
import { bytes, ms, timeAgo, duration } from '../utils/format.js';

export default function Connections() {
  const devicesVersion = useNetwork((s) => s.snapshotAt);
  const sessionsVersion = useNetwork((s) => s.versions.sessions);
  const [vpn, setVpn] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState(null);
  const [confirm, dialog] = useConfirm();

  const load = useCallback(() => {
    Promise.all([api.get('/api/vpn'), api.get('/api/sessions?status=active,approved,requested&limit=100')])
      .then(([v, s]) => { setVpn(v); setSessions(s.sessions); setError(null); })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load, sessionsVersion]);
  useEffect(() => {
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load, devicesVersion]);

  const terminate = async (s) => {
    if (!(await confirm({ title: 'Terminate session?', message: `End ${s.username}'s ${s.kind} session on ${s.hostname} now. The user is notified.`, confirmLabel: 'Terminate', danger: true }))) return;
    await api.post(`/api/sessions/${s.sessionId}/end`, {});
    load();
  };

  return (
    <div className="mx-auto max-w-[1680px] space-y-5 p-6">
      {dialog}
      <PageHeader icon={Cable} eyebrow="Network" title="Connections" subtitle="Every tunnel to the hub and every live remote session." actions={<button className="btn btn-outline" onClick={load}><RefreshCw size={14} /> Refresh</button>} />
      {error && <ErrorBanner onRetry={load}>{error}</ErrorBanner>}

      <section className="card overflow-hidden">
        <PanelHeader icon={ShieldCheck} title="Tunnels" subtitle={`Hub ${vpn?.network.gateway || '10.50.0.1'} · mode ${vpn?.hub.mode || '…'}`} />
        {!vpn?.peers.length ? <Empty icon={ShieldCheck} title="No peers yet">Approved devices appear here with their tunnel state.</Empty> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Device</th><th>Virtual IP</th><th>Endpoint</th><th>Mode</th><th>Status</th><th>Handshake</th><th>Latency</th><th>Loss</th><th>App RTT</th><th>Transfer</th></tr></thead>
              <tbody>
                {vpn.peers.map((p) => (
                  <tr key={p.deviceId}>
                    <td><Link to={`/devices/${p.deviceId}`} className="font-semibold hover:text-accent-ink">{p.hostname}</Link> {p.simulated && <Badge tone="blue">SIM</Badge>}</td>
                    <td className="mono text-accent-ink">{p.virtualIp}</td>
                    <td className="mono text-muted">{p.tunnel?.endpoint || p.physicalIp || '—'}</td>
                    <td><Badge tone={p.tunnel?.mode === 'wireguard' ? 'green' : p.tunnel?.mode === 'simulated' ? 'blue' : 'neutral'}>{p.tunnel?.mode || '—'}</Badge></td>
                    <td><StatusLabel status={p.status} /></td>
                    <td className="text-muted">{p.tunnel?.handshakeAt ? timeAgo(p.tunnel.handshakeAt) : p.tunnel?.mode === 'wireguard' ? 'none yet' : 'n/a'}</td>
                    <td className="mono">{ms(p.latencyMs)}</td>
                    <td className={`mono ${p.packetLossPct ? 'text-warn' : ''}`}>{p.packetLossPct != null ? `${p.packetLossPct}%` : '—'}</td>
                    <td className="mono">{ms(p.appRttMs)}</td>
                    <td className="mono text-muted">{p.tunnel?.rxBytes != null ? `↓${bytes(p.tunnel.rxBytes)} ↑${bytes(p.tunnel.txBytes)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card overflow-hidden">
        <PanelHeader icon={Radio} title="Remote sessions" subtitle="Active, approved and requested" right={<Link to="/sessions" className="text-[12px] font-medium text-accent-ink hover:underline">Session history</Link>} />
        {!sessions.length ? <Empty icon={Radio} title="No live sessions">Remote desktop, file and terminal sessions appear here while they run.</Empty> : (
          <table className="table">
            <thead><tr><th>User</th><th>Kind</th><th>Device</th><th>Status</th><th>Duration</th><th /></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId}>
                  <td className="font-medium">{s.username} <span className="text-[11px] text-muted">({s.role})</span></td>
                  <td className="capitalize">{s.kind}{s.fullShell && <Badge tone="red" className="ml-1.5">Full shell</Badge>}</td>
                  <td>{s.hostname}</td>
                  <td><Badge tone={s.status === 'active' ? 'green' : s.status === 'requested' ? 'amber' : 'blue'}>{s.status}</Badge></td>
                  <td className="mono text-muted">{s.startedAt ? duration((Date.now() - new Date(s.startedAt)) / 1000) : '—'}</td>
                  <td className="text-right"><button className="btn btn-danger h-7 text-[12px]" onClick={() => terminate(s)}>Terminate</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
