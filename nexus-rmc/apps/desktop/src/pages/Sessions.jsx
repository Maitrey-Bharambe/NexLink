import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio, Check, X, Power, ScreenShare, FolderTree, SquareTerminal, Play } from 'lucide-react';
import { useNetwork } from '../stores/network.js';
import { useIsAdmin } from '../stores/auth.js';
import { api } from '../services/api.js';
import { toast } from '../stores/toasts.js';
import { PageHeader, Badge, ErrorBanner, Spinner } from '../components/Primitives.jsx';
import { Tabs, Empty, useConfirm } from '../components/ui.jsx';
import { dateTime, duration, timeAgo } from '../utils/format.js';

const KIND_ICON = { desktop: ScreenShare, files: FolderTree, terminal: SquareTerminal };
const KIND_PATH = { desktop: '/remote-desktop', files: '/files', terminal: '/terminal' };
const TONE = { requested: 'amber', approved: 'blue', active: 'green', ended: 'neutral', denied: 'red', expired: 'neutral', failed: 'red' };

export default function Sessions() {
  const isAdmin = useIsAdmin();
  const version = useNetwork((s) => s.versions.sessions);
  const navigate = useNavigate();
  const [tab, setTab] = useState(isAdmin ? 'requested' : 'all');
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);
  const [confirm, dialog] = useConfirm();

  const load = useCallback(() => {
    api.get('/api/sessions?limit=200').then((r) => { setSessions(r.sessions); setError(null); }).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load, version]);

  const act = async (s, action) => {
    try {
      if (action === 'end') {
        if (!(await confirm({ title: 'End this session?', message: `${s.username}'s ${s.kind} session on ${s.hostname} will be closed.`, confirmLabel: 'End session', danger: true }))) return;
      }
      await api.post(`/api/sessions/${s.sessionId}/${action}`, {});
      if (action === 'approve') toast({ tone: 'success', title: 'Approved', message: `${s.username} can now connect to ${s.hostname}.` });
      load();
    } catch (err) {
      toast({ tone: 'danger', title: 'Action failed', message: err.message });
    }
  };

  const list = (sessions || []).filter((s) => (
    tab === 'all' ? true : tab === 'history' ? ['ended', 'denied', 'expired', 'failed'].includes(s.status) : tab === 'active' ? ['active', 'approved'].includes(s.status) : s.status === tab
  ));
  const count = (st) => (sessions || []).filter((s) => st.includes(s.status)).length;

  return (
    <div className="mx-auto max-w-[1480px] p-6">
      {dialog}
      <PageHeader
        icon={Radio}
        eyebrow="Remote"
        title={isAdmin ? 'Sessions' : 'My Sessions'}
        subtitle={isAdmin ? 'Approve remote-access requests from users and oversee live sessions. Every decision is audited.' : 'Your remote-access requests and their status.'}
      />
      <div className="card overflow-hidden animate-fade-up">
        <div className="border-b border-line px-4 py-3">
          <Tabs value={tab} onChange={setTab} items={[
            ...(isAdmin ? [{ id: 'requested', label: 'Requests', count: count(['requested']) }] : []),
            { id: 'active', label: 'Active', count: count(['active', 'approved']) },
            { id: 'history', label: 'History' },
            { id: 'all', label: 'All' },
          ]} />
        </div>
        {error && <div className="p-4"><ErrorBanner onRetry={load}>{error}</ErrorBanner></div>}
        {!sessions ? <div className="flex justify-center p-10"><Spinner /></div> : list.length === 0 ? (
          <Empty icon={Radio} title={tab === 'requested' ? 'No pending requests' : 'Nothing here yet'}>
            {tab === 'requested' ? 'When a user asks for remote desktop, file or terminal access, the request appears here.' : 'Sessions you start from Remote Desktop, Files or Terminal are listed here.'}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Session</th>{isAdmin && <th>User</th>}<th>Device</th><th>Reason</th><th>Status</th><th>When</th><th>Duration</th><th className="text-right">Actions</th></tr></thead>
              <tbody>
                {list.map((s) => {
                  const Icon = KIND_ICON[s.kind];
                  return (
                    <tr key={s.sessionId}>
                      <td><span className="flex items-center gap-2 font-medium capitalize"><Icon size={14} className="text-muted" />{s.kind}{s.fullShell && <Badge tone="red">Full shell</Badge>}</span></td>
                      {isAdmin && <td>{s.username} <span className="text-[11px] text-muted">({s.role})</span></td>}
                      <td className="font-medium">{s.hostname}</td>
                      <td className="max-w-[220px] truncate text-muted" title={s.reason}>{s.reason || '—'}</td>
                      <td><Badge tone={TONE[s.status]}>{s.status}</Badge>{s.decidedBy && s.decidedBy !== 'policy' && <div className="text-[10.5px] text-muted">by {s.decidedBy}</div>}</td>
                      <td className="text-muted" title={dateTime(s.createdAt)}>{timeAgo(s.createdAt)}</td>
                      <td className="mono text-muted">{s.startedAt ? duration(((s.endedAt ? new Date(s.endedAt) : new Date()) - new Date(s.startedAt)) / 1000) : '—'}</td>
                      <td className="text-right">
                        <span className="inline-flex gap-1.5">
                          {isAdmin && s.status === 'requested' && (
                            <>
                              <button className="btn btn-outline h-7 text-[12px]" onClick={() => act(s, 'deny')}><X size={13} /> Deny</button>
                              <button className="btn btn-accent h-7 text-[12px]" onClick={() => act(s, 'approve')}><Check size={13} /> Approve</button>
                            </>
                          )}
                          {!isAdmin && s.status === 'approved' && (
                            <button className="btn btn-primary h-7 text-[12px]" onClick={() => navigate(`${KIND_PATH[s.kind]}?device=${s.deviceId}&session=${s.sessionId}`)}><Play size={13} /> Open</button>
                          )}
                          {['active', 'approved', 'requested'].includes(s.status) && (isAdmin || s.status !== 'active') && (
                            <button className="btn btn-danger h-7 text-[12px]" onClick={() => act(s, 'end')}><Power size={13} /> {s.status === 'requested' ? 'Cancel' : 'End'}</button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
