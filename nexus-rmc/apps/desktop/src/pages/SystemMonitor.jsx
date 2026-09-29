import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cpu, ArrowDownUp, Timer } from 'lucide-react';
import { useNetwork, deviceName } from '../stores/network.js';
import { PageHeader, StatusLabel, Badge } from '../components/Primitives.jsx';
import { Tabs, Empty } from '../components/ui.jsx';
import { Gauge } from '../components/Chart.jsx';
import { rate, ms, duration } from '../utils/format.js';

const SORTS = {
  name: (a, b) => deviceName(a).localeCompare(deviceName(b)),
  cpu: (a, b) => (b.latest?.cpuPct || 0) - (a.latest?.cpuPct || 0),
  ram: (a, b) => (b.latest?.ramPct || 0) - (a.latest?.ramPct || 0),
  net: (a, b) => ((b.latest?.rxBps || 0) + (b.latest?.txBps || 0)) - ((a.latest?.rxBps || 0) + (a.latest?.txBps || 0)),
};

export default function SystemMonitor() {
  const devices = useNetwork((s) => s.devices);
  const [sort, setSort] = useState('cpu');
  const list = useMemo(() => [...devices].sort(SORTS[sort]), [devices, sort]);

  return (
    <div className="mx-auto max-w-[1680px] p-6">
      <PageHeader
        icon={Cpu}
        eyebrow="Monitoring"
        title="System Monitor"
        subtitle="Live resource usage reported by each agent every 5 seconds. Open a device for history and processes."
        actions={<Tabs value={sort} onChange={setSort} items={[{ id: 'cpu', label: 'CPU' }, { id: 'ram', label: 'Memory' }, { id: 'net', label: 'Network' }, { id: 'name', label: 'Name' }]} />}
      />
      {list.length === 0 ? <div className="card"><Empty icon={Cpu} title="No devices reporting">Approve a device to start receiving telemetry.</Empty></div> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {list.map((d) => {
            const L = d.latest || {};
            return (
              <Link key={d.deviceId} to={`/devices/${d.deviceId}`} className={`card block p-4 transition-colors hover:border-accent/50 ${d.anomaly ? 'border-gold/60' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 truncate font-semibold text-ink">{deviceName(d)}{d.simulated && <Badge tone="blue">SIM</Badge>}</div>
                    <div className="mono text-[11.5px] text-accent-ink">{d.virtualIp}</div>
                  </div>
                  <StatusLabel status={d.status} />
                </div>
                <div className="mt-3 flex justify-between">
                  <Gauge value={L.cpuPct} label="CPU" size={64} />
                  <Gauge value={L.ramPct} label="Memory" size={64} />
                  <Gauge value={L.diskPct} label="Disk" size={64} warnAt={80} dangerAt={92} />
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-[11px]">
                  <div><div className="flex items-center gap-1 text-muted"><ArrowDownUp size={11} /> Net</div><div className="mono font-semibold text-ink">{rate((L.rxBps || 0) + (L.txBps || 0))}</div></div>
                  <div><div className="flex items-center gap-1 text-muted"><Timer size={11} /> Latency</div><div className="mono font-semibold text-ink">{ms(L.latencyMs)}</div></div>
                  <div><div className="text-muted">Uptime</div><div className="mono font-semibold text-ink">{duration(L.uptimeSec)}</div></div>
                </div>
                {d.anomaly && <div className="mt-2 rounded-md bg-gold/15 px-2 py-1 text-[11px] text-warn">Anomaly: {d.anomaly.features?.join(', ') || d.anomaly.severity}</div>}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
