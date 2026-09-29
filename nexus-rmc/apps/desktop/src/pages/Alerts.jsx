import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, Check, CheckCheck, CircleCheck, AlertTriangle, XCircle, Sparkles } from 'lucide-react';
import { useNetwork } from '../stores/network.js';
import { useIsAdmin } from '../stores/auth.js';
import { api } from '../services/api.js';
import { PageHeader, Badge, ErrorBanner, Spinner } from '../components/Primitives.jsx';
import { Tabs, Empty } from '../components/ui.jsx';
import { timeAgo, dateTime } from '../utils/format.js';

const SEV = {
  critical: { tone: 'red', icon: XCircle, cls: 'text-danger' },
  warning: { tone: 'amber', icon: AlertTriangle, cls: 'text-warn' },
  info: { tone: 'blue', icon: BellRing, cls: 'text-primary' },
};
const KIND_LABEL = {
  cpu_high: 'High CPU', ram_high: 'High memory', disk_high: 'Disk almost full', latency_high: 'High latency',
  packet_loss: 'Packet loss', offline: 'Device offline', anomaly: 'Anomaly',
};

export default function Alerts() {
  const isAdmin = useIsAdmin();
  const version = useNetwork((s) => s.versions.alerts);
  const [status, setStatus] = useState('active');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.get(`/api/alerts?status=${status}&limit=300`).then((r) => { setData(r); setError(null); }).catch((e) => setError(e.message)), [status]);
  useEffect(() => { load(); }, [load, version]);

  const act = async (a, action) => { await api.post(`/api/alerts/${a._id}/${action}`, {}); load(); };
  const ackAll = async () => { await api.post('/api/alerts/ack-all', {}); load(); };

  return (
    <div className="mx-auto max-w-[1480px] p-6">
      <PageHeader
        icon={BellRing}
        eyebrow="Monitoring"
        title="Alerts"
        subtitle="Raised by threshold rules (sustained breaches) and the anomaly model. Alerts clear automatically when conditions return to normal."
        actions={isAdmin && <button className="btn btn-outline" onClick={ackAll}><CheckCheck size={14} /> Acknowledge all</button>}
      />
      <div className="card overflow-hidden animate-fade-up">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <Tabs value={status} onChange={setStatus} items={[
            { id: 'active', label: 'Active' }, { id: 'open', label: 'Open' }, { id: 'acknowledged', label: 'Acknowledged' }, { id: 'resolved', label: 'Resolved' }, { id: 'all', label: 'All' },
          ]} />
          {data && (
            <div className="ml-auto flex gap-2 text-[12px]">
              <Badge tone="red">{data.counts.critical || 0} critical</Badge>
              <Badge tone="amber">{data.counts.warning || 0} warning</Badge>
            </div>
          )}
        </div>
        {error && <div className="p-4"><ErrorBanner onRetry={load}>{error}</ErrorBanner></div>}
        {!data ? <div className="flex justify-center p-10"><Spinner /></div> : data.alerts.length === 0 ? (
          <Empty icon={CircleCheck} title="No alerts">{status === 'active' ? 'Everything is within thresholds.' : 'Nothing in this view.'}</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {data.alerts.map((a) => {
              const s = SEV[a.severity] || SEV.info;
              const Icon = a.kind === 'anomaly' ? Sparkles : s.icon;
              return (
                <li key={a._id} className={`flex flex-wrap items-start gap-4 px-4 py-3 ${a.status === 'resolved' ? 'opacity-60' : ''}`}>
                  <Icon size={18} className={`mt-0.5 shrink-0 ${s.cls}`} />
                  <div className="min-w-[260px] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-ink">{KIND_LABEL[a.kind] || a.kind}</span>
                      <Badge tone={s.tone}>{a.severity}</Badge>
                      <Badge tone={a.status === 'open' ? 'amber' : a.status === 'acknowledged' ? 'blue' : 'neutral'}>{a.status}</Badge>
                      {a.count > 1 && <span className="text-[11px] text-muted">seen {a.count}×</span>}
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-ink-2">{a.message}</p>
                    <div className="mt-1 text-[11px] text-muted">
                      <Link to={`/devices/${a.deviceId}`} className="font-medium text-accent-ink hover:underline">{a.hostname}</Link>
                      {' · '}opened {timeAgo(a.openedAt)} ({dateTime(a.openedAt)})
                      {a.ackBy && ` · acknowledged by ${a.ackBy}`}
                      {a.resolvedAt && ` · resolved ${timeAgo(a.resolvedAt)}${a.autoResolved ? ' automatically' : a.resolvedBy ? ` by ${a.resolvedBy}` : ''}`}
                    </div>
                  </div>
                  {isAdmin && a.status !== 'resolved' && (
                    <div className="flex gap-2">
                      {a.status === 'open' && <button className="btn btn-outline h-7 text-[12px]" onClick={() => act(a, 'ack')}><Check size={13} /> Acknowledge</button>}
                      <button className="btn btn-outline h-7 text-[12px]" onClick={() => act(a, 'resolve')}><CircleCheck size={13} /> Resolve</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
