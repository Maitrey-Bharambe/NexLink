import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Network, Monitor, X, ChevronRight } from 'lucide-react';
import { useNetwork, deviceName } from '../stores/network.js';
import NetworkTopology from '../components/NetworkTopology.jsx';
import { PageHeader, StatusLabel, Badge } from '../components/Primitives.jsx';
import { Tabs } from '../components/ui.jsx';
import { ms, rate, pct, timeAgo } from '../utils/format.js';

export default function NetworkMap() {
  const devices = useNetwork((s) => s.devices);
  const network = useNetwork((s) => s.network);
  const wsStatus = useNetwork((s) => s.wsStatus);
  const vpn = useNetwork((s) => s.vpn);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('all');

  const shown = useMemo(() => devices.filter((d) => (
    filter === 'all' ? true
      : filter === 'problems' ? d.status !== 'CONNECTED' || d.anomaly || (d.latest?.packetLossPct || 0) > 0
        : filter === 'real' ? !d.simulated : d.simulated
  )), [devices, filter]);
  const sel = devices.find((d) => d.deviceId === selected);

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader
        icon={Network}
        eyebrow="Network"
        title="Network Map"
        subtitle={`Hub-and-spoke WireGuard topology · ${network.cidr} · ${vpn.mode === 'wireguard' ? 'real tunnels' : 'simulated tunnels'}. Click a node for details.`}
        actions={<Tabs value={filter} onChange={setFilter} items={[
          { id: 'all', label: 'All', count: devices.length },
          { id: 'problems', label: 'Problems', count: devices.filter((d) => d.status !== 'CONNECTED' || d.anomaly || (d.latest?.packetLossPct || 0) > 0).length },
          { id: 'real', label: 'Real' },
          { id: 'sim', label: 'Simulated' },
        ]} />}
      />
      <div className="relative min-h-[520px] flex-1 overflow-hidden rounded-[var(--radius-card)] border border-line">
        <NetworkTopology devices={shown} network={network} serverStatus={wsStatus} onSelect={setSelected} selectedId={selected} />
        <div className="theme-deep pointer-events-none absolute left-4 top-4 flex gap-3 rounded-md border border-line bg-brand-2/85 px-3 py-2 text-[11px] text-ink-2">
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-accent" />Active tunnel</span>
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-gold" />Degraded</span>
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-taupe" />Offline</span>
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-danger" />Anomaly</span>
        </div>
        {sel && (
          <aside className="card absolute right-4 top-4 w-[300px] p-4 shadow-[var(--s-pop)] animate-fade-up">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2 font-semibold text-ink"><Monitor size={15} />{deviceName(sel)}{sel.simulated && <Badge tone="blue">SIM</Badge>}</div>
                <div className="mono mt-0.5 text-[12px] text-accent-ink">{sel.virtualIp}</div>
              </div>
              <button className="text-muted hover:text-ink" onClick={() => setSelected(null)} aria-label="Close"><X size={15} /></button>
            </div>
            <div className="mt-2"><StatusLabel status={sel.status} /></div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
              {[['Latency', ms(sel.latest?.latencyMs)], ['Loss', sel.latest?.packetLossPct != null ? `${sel.latest.packetLossPct}%` : '—'],
                ['CPU', pct(sel.latest?.cpuPct)], ['Memory', pct(sel.latest?.ramPct)],
                ['Down', rate(sel.latest?.rxBps)], ['Up', rate(sel.latest?.txBps)],
                ['Tunnel', sel.tunnel?.mode || '—'], ['Seen', timeAgo(sel.lastSeen)]].map(([k, v]) => (
                <div key={k}><dt className="label-caps">{k}</dt><dd className="mono font-semibold text-ink">{v}</dd></div>
              ))}
            </dl>
            <Link to={`/devices/${sel.deviceId}`} className="btn btn-primary mt-4 h-8 w-full text-[12px]">Open device <ChevronRight size={13} /></Link>
          </aside>
        )}
      </div>
    </div>
  );
}
