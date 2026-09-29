import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Globe, Server, Layers, RefreshCw } from 'lucide-react';
import { api } from '../services/api.js';
import { PageHeader, PanelHeader, Badge, ErrorBanner, Spinner, MetricCard } from '../components/Primitives.jsx';
import { Empty } from '../components/ui.jsx';
import { BarList } from '../components/Chart.jsx';
import { timeAgo } from '../utils/format.js';

export default function NetworkAnalysis() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.get('/api/analysis').then((r) => { setData(r); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const protocols = useMemo(() => {
    if (!data) return { transport: [], services: [] };
    const entries = Object.entries(data.protocols);
    return {
      transport: entries.filter(([k]) => k === 'TCP' || k === 'UDP').map(([label, value]) => ({ label, value })),
      services: entries.filter(([k]) => k !== 'TCP' && k !== 'UDP').map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 12),
    };
  }, [data]);

  if (!data) return <div className="p-6">{error ? <ErrorBanner onRetry={load}>{error}</ErrorBanner> : <Spinner />}</div>;
  const established = data.perDevice.reduce((a, d) => a + d.established, 0);

  return (
    <div className="mx-auto max-w-[1680px] space-y-5 p-6">
      <PageHeader icon={Activity} eyebrow="Monitoring" title="Network Analysis" subtitle="What every device is talking to: connections, services, protocols and open ports. Built from each agent's latest snapshot (every 15 s)." actions={<button className="btn btn-outline" onClick={load}><RefreshCw size={14} /> Refresh</button>} />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <MetricCard icon={Layers} label="Open connections" value={data.connections} hint={`${established} established`} />
        <MetricCard icon={Globe} label="Remote hosts" value={data.remoteHosts.length} hint="Distinct destinations (top 25)" />
        <MetricCard icon={Server} label="Listening ports" value={data.listening.length} hint="Services exposed by devices" tone={data.listening.some((p) => [23, 21, 445, 3389].includes(p.port)) ? 'amber' : 'green'} />
        <MetricCard icon={Activity} label="Protocols seen" value={protocols.services.length} hint={protocols.transport.map((t) => `${t.label} ${t.value}`).join(' · ') || '—'} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="card overflow-hidden">
          <PanelHeader icon={Layers} title="Protocol distribution" subtitle="Connections by service (well-known port mapping)" />
          <div className="p-4">{protocols.services.length ? <BarList items={protocols.services} /> : <p className="text-[12.5px] text-muted">No connections observed yet.</p>}</div>
        </section>
        <section className="card overflow-hidden">
          <PanelHeader icon={Globe} title="Top remote hosts" subtitle="Where traffic is going" />
          <div className="max-h-[360px] overflow-auto">
            <table className="table">
              <thead><tr><th>Remote host</th><th>Connections</th><th>Services</th><th>From</th></tr></thead>
              <tbody>
                {data.remoteHosts.map((h) => (
                  <tr key={h.host}><td className="mono text-accent-ink">{h.host}</td><td className="mono">{h.connections}</td><td>{h.services.slice(0, 3).map((s) => <Badge key={s} className="mr-1">{s}</Badge>)}</td><td className="text-muted">{h.devices.slice(0, 3).join(', ')}</td></tr>
                ))}
              </tbody>
            </table>
            {!data.remoteHosts.length && <Empty icon={Globe} title="No remote hosts yet" />}
          </div>
        </section>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="card overflow-hidden">
          <PanelHeader icon={Server} title="Listening ports" subtitle="Risky services (Telnet, FTP, SMB, RDP) are highlighted" />
          <div className="max-h-[380px] overflow-auto">
            <table className="table">
              <thead><tr><th>Port</th><th>Proto</th><th>Service</th><th>Devices</th></tr></thead>
              <tbody>
                {data.listening.map((p) => (
                  <tr key={`${p.port}/${p.proto}`} className={[23, 21, 445, 3389].includes(p.port) ? 'bg-gold/8' : ''}>
                    <td className="mono font-semibold">{p.port}</td><td className="mono">{p.proto}</td>
                    <td>{p.service ? <Badge tone={[23, 21, 445, 3389].includes(p.port) ? 'amber' : 'blue'}>{p.service}</Badge> : <span className="text-muted">—</span>}</td>
                    <td className="text-muted">{p.devices.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card overflow-hidden">
          <PanelHeader icon={Activity} title="Per device" subtitle="Connection counts from the latest snapshot" />
          <table className="table">
            <thead><tr><th>Device</th><th>Connections</th><th>Established</th><th>Listening</th><th>Snapshot</th></tr></thead>
            <tbody>
              {data.perDevice.map((d) => (
                <tr key={d.deviceId}>
                  <td><Link to={`/devices/${d.deviceId}`} className="font-semibold hover:text-accent-ink">{d.hostname}</Link> {d.simulated && <Badge tone="blue">SIM</Badge>}</td>
                  <td className="mono">{d.connections}</td><td className="mono">{d.established}</td><td className="mono">{d.listening}</td>
                  <td className="text-muted">{d.at ? timeAgo(d.at) : 'waiting'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
