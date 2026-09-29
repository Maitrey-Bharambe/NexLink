import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Monitor, ScreenShare, FolderTree, SquareTerminal, Stethoscope, Radio, BellRing, ChevronRight,
} from 'lucide-react';
import { useNetwork, deviceName } from '../stores/network.js';
import { useAuth } from '../stores/auth.js';
import { api } from '../services/api.js';
import { StatusLabel, Badge, IconTile, PanelHeader } from '../components/Primitives.jsx';
import { Empty } from '../components/ui.jsx';
import { Gauge } from '../components/Chart.jsx';
import { ms, timeAgo, dateTime } from '../utils/format.js';

const STATUS_TONE = { requested: 'amber', approved: 'green', active: 'green', ended: 'neutral', denied: 'red', expired: 'neutral', failed: 'red' };

function DeviceCard({ d }) {
  const navigate = useNavigate();
  const online = d.status === 'CONNECTED' || d.status === 'DEGRADED';
  const go = (p) => navigate(`${p}?device=${d.deviceId}`);
  return (
    <div className="card flex flex-col p-5">
      <div className="flex items-start gap-3">
        <IconTile icon={Monitor} size={42} tone={online ? 'green' : 'neutral'} />
        <div className="min-w-0 flex-1">
          <Link to={`/devices/${d.deviceId}`} className="flex items-center gap-2 font-semibold text-ink hover:text-accent-ink">
            <span className="truncate">{deviceName(d)}</span>{d.simulated && <Badge tone="blue">SIM</Badge>}
          </Link>
          <div className="mono text-[12px] text-accent-ink">{d.virtualIp}</div>
          <div className="mt-1"><StatusLabel status={d.status} /></div>
        </div>
      </div>
      <div className="mt-4 flex justify-around">
        <Gauge value={d.latest?.cpuPct} label="CPU" size={62} />
        <Gauge value={d.latest?.ramPct} label="Memory" size={62} />
        <div className="flex flex-col items-center justify-center">
          <div className="mono text-[18px] font-semibold text-ink">{ms(d.latest?.latencyMs)}</div>
          <div className="mt-1 text-[11px] font-medium text-muted">Latency</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button className="btn btn-primary h-8 text-[12px]" disabled={!online} onClick={() => go('/remote-desktop')}><ScreenShare size={13} /> Desktop</button>
        <button className="btn btn-outline h-8 text-[12px]" disabled={!online} onClick={() => go('/files')}><FolderTree size={13} /> Files</button>
        <button className="btn btn-outline h-8 text-[12px]" disabled={!online} onClick={() => go('/terminal')}><SquareTerminal size={13} /> Terminal</button>
        <button className="btn btn-outline h-8 text-[12px]" disabled={!online} onClick={() => go('/diagnostics')}><Stethoscope size={13} /> Diagnose</button>
      </div>
      <div className="mt-3 text-[11px] text-muted">Last seen {timeAgo(d.lastSeen)} · {d.os}</div>
    </div>
  );
}

export default function UserHome() {
  const user = useAuth((s) => s.user);
  const devices = useNetwork((s) => s.devices);
  const counts = useNetwork((s) => s.counts);
  const sessionsVersion = useNetwork((s) => s.versions.sessions);
  const [sessions, setSessions] = useState([]);

  useEffect(() => { api.get('/api/sessions?limit=6').then((r) => setSessions(r.sessions)).catch(() => {}); }, [sessionsVersion]);

  const online = devices.filter((d) => d.status === 'CONNECTED' || d.status === 'DEGRADED').length;
  const alerts = Object.values(counts.alerts || {}).reduce((a, b) => a + b, 0);

  return (
    <div className="mx-auto max-w-[1480px] space-y-5 p-6">
      <section className="card p-6">
        <div className="label-caps text-accent-ink">User portal</div>
        <h1 className="mt-2 font-display text-[24px] font-semibold text-ink">Welcome, <span className="text-accent-ink">{user?.displayName}</span></h1>
        <p className="mt-1 text-[13px] text-muted">
          You have access to {devices.length} device{devices.length === 1 ? '' : 's'} ({online} online). Remote sessions are logged and{' '}
          may need an administrator's approval before they start.
        </p>
        <div className="mt-4 flex flex-wrap gap-2 text-[12px]">
          <Link to="/sessions" className="inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1 hover:border-line-strong"><Radio size={13} /> {counts.mySessions} session request(s) open</Link>
          <Link to="/alerts" className="inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1 hover:border-line-strong"><BellRing size={13} /> {alerts} open alert(s) on my devices</Link>
        </div>
      </section>

      {devices.length === 0 ? (
        <div className="card">
          <Empty icon={Monitor} title="No devices assigned to you yet">
            An administrator decides which devices you can reach. Ask them to assign one to your account; it will appear here automatically.
          </Empty>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {devices.map((d) => <DeviceCard key={d.deviceId} d={d} />)}
        </div>
      )}

      <section className="card overflow-hidden">
        <PanelHeader icon={Radio} title="My recent sessions" right={<Link to="/sessions" className="flex items-center gap-1 text-[12px] font-medium text-accent-ink hover:underline">All sessions <ChevronRight size={13} /></Link>} />
        {sessions.length === 0 ? <p className="p-4 text-[12.5px] text-muted">No sessions yet.</p> : (
          <table className="table">
            <thead><tr><th>Kind</th><th>Device</th><th>Status</th><th>Requested</th><th>Decided by</th></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId}>
                  <td className="capitalize">{s.kind}</td><td className="font-medium">{s.hostname}</td>
                  <td><Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge></td>
                  <td className="text-muted">{dateTime(s.createdAt)}</td><td className="text-muted">{s.decidedBy || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
