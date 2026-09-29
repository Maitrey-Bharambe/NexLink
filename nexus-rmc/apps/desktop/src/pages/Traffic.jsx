import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownUp, ArrowDown, ArrowUp, Trophy } from 'lucide-react';
import { api } from '../services/api.js';
import { PageHeader, PanelHeader, Badge, ErrorBanner, Spinner, MetricCard } from '../components/Primitives.jsx';
import { Tabs } from '../components/ui.jsx';
import TimeChart, { SERIES_COLORS } from '../components/Chart.jsx';
import { rate, bytes } from '../utils/format.js';

const RANGES = [{ id: 15, label: '15 min' }, { id: 60, label: '1 h' }, { id: 360, label: '6 h' }, { id: 1440, label: '24 h' }, { id: 10080, label: '7 d' }];

export default function Traffic() {
  const [minutes, setMinutes] = useState(60);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.get(`/api/traffic?minutes=${minutes}`).then((r) => { setData(r); setError(null); }).catch((e) => setError(e.message)), [minutes]);
  useEffect(() => {
    load();
    const t = setInterval(load, minutes <= 60 ? 10_000 : 60_000);
    return () => clearInterval(t);
  }, [load, minutes]);

  if (!data) return <div className="p-6">{error ? <ErrorBanner onRetry={load}>{error}</ErrorBanner> : <Spinner />}</div>;
  const peak = data.series.reduce((m, p) => Math.max(m, p.rx + p.tx), 0);
  const totalRx = data.talkers.reduce((a, t) => a + t.rxBytes, 0);
  const totalTx = data.talkers.reduce((a, t) => a + t.txBytes, 0);

  return (
    <div className="mx-auto max-w-[1680px] space-y-5 p-6">
      <PageHeader icon={ArrowDownUp} eyebrow="Monitoring" title="Traffic" subtitle="Throughput across the private network, from per-device interface counters." actions={<Tabs value={minutes} onChange={setMinutes} items={RANGES} />} />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <MetricCard icon={ArrowDown} label="Download now" value={rate(data.now.rx).split(' ')[0]} unit={rate(data.now.rx).split(' ')[1]} hint="All devices combined" />
        <MetricCard icon={ArrowUp} label="Upload now" value={rate(data.now.tx).split(' ')[0]} unit={rate(data.now.tx).split(' ')[1]} hint="All devices combined" />
        <MetricCard icon={ArrowDownUp} label="Peak in window" value={rate(peak).split(' ')[0]} unit={rate(peak).split(' ')[1]} hint={`Last ${RANGES.find((r) => r.id === minutes)?.label}`} />
        <MetricCard icon={Trophy} label="Volume in window" value={bytes(totalRx + totalTx).split(' ')[0]} unit={bytes(totalRx + totalTx).split(' ')[1]} hint={`↓ ${bytes(totalRx)} · ↑ ${bytes(totalTx)} (estimated)`} />
      </div>

      <section className="card p-4">
        <div className="label-caps mb-3">Network throughput</div>
        <TimeChart points={data.series} height={260} yFormat={(v) => rate(v)} series={[
          { key: 'rx', label: 'Download', color: SERIES_COLORS.aqua, area: true },
          { key: 'tx', label: 'Upload', color: SERIES_COLORS.gold, area: true },
        ]} empty="No traffic samples in this window yet." />
      </section>

      <section className="card overflow-hidden">
        <PanelHeader icon={Trophy} title="Top talkers" subtitle="Devices ranked by average throughput" />
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>#</th><th>Device</th><th>Virtual IP</th><th>Avg down</th><th>Avg up</th><th>Peak down</th><th>Peak up</th><th>Volume</th><th>Share</th></tr></thead>
            <tbody>
              {data.talkers.map((t, i) => {
                const share = totalRx + totalTx ? ((t.rxBytes + t.txBytes) / (totalRx + totalTx)) * 100 : 0;
                return (
                  <tr key={t.deviceId}>
                    <td className="mono text-muted">{i + 1}</td>
                    <td><Link to={`/devices/${t.deviceId}`} className="font-semibold hover:text-accent-ink">{t.hostname}</Link> {t.simulated && <Badge tone="blue">SIM</Badge>}</td>
                    <td className="mono text-accent-ink">{t.virtualIp}</td>
                    <td className="mono">{rate(t.rxAvg)}</td><td className="mono">{rate(t.txAvg)}</td>
                    <td className="mono text-muted">{rate(t.rxMax)}</td><td className="mono text-muted">{rate(t.txMax)}</td>
                    <td className="mono">{bytes(t.rxBytes + t.txBytes)}</td>
                    <td><div className="flex items-center gap-2"><div className="h-1.5 w-20 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-accent" style={{ width: `${share}%` }} /></div><span className="mono text-[11px]">{share.toFixed(0)}%</span></div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!data.talkers.length && <p className="p-8 text-center text-[12.5px] text-muted">No traffic data in this window.</p>}
        </div>
      </section>
    </div>
  );
}
