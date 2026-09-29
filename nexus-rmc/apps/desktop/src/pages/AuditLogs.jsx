import { useCallback, useEffect, useState } from 'react';
import { ScrollText, RefreshCw, Radio } from 'lucide-react';
import { api } from '../services/api.js';
import { useNetwork } from '../stores/network.js';
import { PageHeader, EmptyState, ErrorBanner, Spinner, Badge, Avatar } from '../components/Primitives.jsx';

const RESULT_TONE = { success: 'green', failure: 'red', denied: 'amber' };

function Row({ e, fresh }) {
  const t = new Date(e.timestamp);
  return (
    <tr className={fresh ? 'bg-accent/8' : ''}>
      <td className="mono">
        {t.toLocaleTimeString([], { hour12: false })}
        <span className="ml-2 text-muted">{t.toLocaleDateString()}</span>
      </td>
      <td>
        <span className="flex items-center gap-2">
          <Avatar name={e.username || e.actorType || '?'} size={24} />
          <span className="font-semibold">{e.username || e.actorType}</span>
        </span>
      </td>
      <td className="text-muted">{e.deviceName || e.deviceId || '—'}</td>
      <td><span className="mono rounded-md border border-line bg-raised px-1.5 py-0.5 text-[11.5px] text-ink-2">{e.action}</span></td>
      <td><Badge tone={RESULT_TONE[e.result]}>{e.result}</Badge></td>
      <td className="mono text-muted">{e.ip || '—'}</td>
      <td className="mono text-muted" title={e.sessionId}>{e.sessionId ? e.sessionId.slice(0, 8) : '—'}</td>
      <td className="text-muted">{e.approval || '—'}</td>
    </tr>
  );
}

export default function AuditLogs() {
  const [entries, setEntries] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const live = useNetwork((s) => s.auditFeed);
  const [freshIds, setFreshIds] = useState(new Set());

  const [filter, setFilter] = useState('');
  const load = useCallback(async (before) => {
    setLoading(true);
    setError(null);
    try {
      const q = `?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}${filter ? `&action=${filter}` : ''}`;
      const res = await api.get(`/api/audit${q}`);
      setEntries((prev) => (before ? [...prev, ...res.entries] : res.entries));
      setNextBefore(res.nextBefore);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  // Merge live entries pushed over the console socket.
  useEffect(() => {
    const newest = live[0];
    if (!newest || (filter && !newest.action.startsWith(filter))) return;
    setEntries((prev) => (prev.some((e) => e._id === newest._id) ? prev : [newest, ...prev]));
    setFreshIds((s) => new Set(s).add(newest._id));
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mx-auto max-w-[1680px] p-6">
      <PageHeader
        icon={ScrollText}
        eyebrow="Administration"
        title="Security & Audit"
        subtitle="Append-only record of every privileged action. New entries stream in live."
        actions={(
          <>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/35 bg-accent/12 px-2.5 py-1 text-[11px] font-medium text-accent-ink">
              <Radio size={12} /> Live
            </span>
            <button className="btn btn-outline" onClick={() => load()}><RefreshCw size={14} /> Refresh</button>
          </>
        )}
      />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {[['', 'All'], ['auth', 'Sign-ins'], ['user', 'Users'], ['device', 'Devices'], ['session', 'Sessions'], ['terminal', 'Terminal'], ['file', 'Files'], ['alert', 'Alerts'], ['ai', 'AI'], ['settings', 'Settings']].map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)} className={`rounded-md border px-2.5 py-1 text-[12px] ${filter === id ? 'border-accent/50 bg-accent/12 text-accent-ink' : 'border-line bg-surface text-ink-2 hover:border-line-strong'}`}>{label}</button>
        ))}
      </div>
      {error && <div className="mb-3"><ErrorBanner onRetry={() => load()}>{error}</ErrorBanner></div>}
      <div className="card overflow-hidden animate-fade-up">
        <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              {['Time', 'User', 'Device', 'Action', 'Result', 'IP', 'Session', 'Approval'].map((c) => <th key={c}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => <Row key={e._id} e={e} fresh={freshIds.has(e._id)} />)}
          </tbody>
        </table>
        </div>
        {!loading && !error && entries.length === 0 && (
          <EmptyState icon={ScrollText} title="No audit entries yet">Sign-ins and administrative actions will appear here.</EmptyState>
        )}
        {loading && <div className="flex justify-center py-6"><Spinner /></div>}
        {!loading && nextBefore && (
          <div className="border-t border-line p-3 text-center">
            <button className="btn btn-ghost" onClick={() => load(nextBefore)}>Load older entries</button>
          </div>
        )}
      </div>
    </div>
  );
}
