import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Clock3, Play, AlertTriangle, RotateCcw, ShieldAlert, Power } from 'lucide-react';
import { useAuth } from '../stores/auth.js';
import { useNetwork, deviceName } from '../stores/network.js';
import { Spinner, ErrorBanner, Badge } from './Primitives.jsx';
import { DevicePicker, Field, Toggle } from './ui.jsx';

const online = (d) => d.status === 'CONNECTED' || d.status === 'DEGRADED';

/**
 * Shared start/approval/connection flow for remote pages.
 * `session` is the object returned by useRemoteSession().
 */
export default function SessionGate({ kind, session, capability, children, allowFullShell = false, fullShell, setFullShell }) {
  const [params] = useSearchParams();
  const isAdmin = useAuth((s) => s.user?.role === 'admin');
  const devices = useNetwork((s) => s.devices);
  const [deviceId, setDeviceId] = useState(params.get('device') || '');
  const [reason, setReason] = useState('');
  const device = devices.find((d) => d.deviceId === deviceId);
  const filter = (d) => online(d) && (!capability || d.capabilities?.[capability] !== false);

  const phase = session.phase;
  const resumed = useRef(false);
  useEffect(() => {
    const sid = params.get('session');
    if (sid && !resumed.current && phase === 'idle') {
      resumed.current = true;
      session.resume(sid);
    }
  }, [params, phase, session]);
  const active = phase === 'active';
  const label = { desktop: 'remote desktop', files: 'file', terminal: 'terminal' }[kind];

  if (active) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2.5 text-[12.5px]">
          <span className="h-2 w-2 animate-pulse-soft rounded-full bg-accent" />
          <span className="font-semibold text-ink">Connected to {session.info?.hostname}</span>
          {device?.simulated && <Badge tone="blue">SIM</Badge>}
          {session.info?.fullShell && <Badge tone="red">Full shell</Badge>}
          <span className="mono text-muted">{device?.virtualIp}</span>
          <span className="text-muted">· relayed through the hub · audited</span>
          <button className="btn btn-danger ml-auto h-7 text-[12px]" onClick={session.end}><Power size={13} /> Disconnect</button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    );
  }

  const busy = phase === 'requesting' || phase === 'connecting';

  return (
    <div className="card mx-auto max-w-xl p-6 animate-fade-up">
      {phase === 'requested' ? (
        <div className="space-y-3 text-center">
          <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-lg bg-gold/15 text-warn ring-1 ring-inset ring-gold/40"><Clock3 size={22} /></span>
          <h2 className="text-[16px] font-semibold">Waiting for an administrator</h2>
          <p className="text-[12.5px] text-muted">Your {label} session request for <b className="text-ink">{session.session?.hostname}</b> was sent. It starts automatically as soon as an admin approves it.</p>
          <button className="btn btn-outline" onClick={session.end}>Cancel request</button>
        </div>
      ) : phase === 'ended' || phase === 'error' ? (
        <div className="space-y-3 text-center">
          <span className={`mx-auto inline-flex h-12 w-12 items-center justify-center rounded-lg ring-1 ring-inset ${phase === 'error' ? 'bg-danger/10 text-danger ring-danger/25' : 'bg-raised text-muted ring-line'}`}><AlertTriangle size={22} /></span>
          <h2 className="text-[16px] font-semibold">{phase === 'error' ? 'Could not start the session' : 'Session ended'}</h2>
          <p className="text-[12.5px] text-muted">{session.error || session.endReason}</p>
          <button className="btn btn-primary" onClick={session.reset}><RotateCcw size={14} /> New session</button>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <h2 className="text-[16px] font-semibold">Start a {label} session</h2>
            <p className="mt-0.5 text-[12.5px] text-muted">
              {isAdmin ? 'As an administrator your session starts immediately.' : 'Your request goes to an administrator for approval.'} The device shows a visible banner while you are connected.
            </p>
          </div>
          <Field label="Device"><DevicePicker value={deviceId} onChange={setDeviceId} filter={filter} placeholder="Choose an online device" /></Field>
          {device && !online(device) && <ErrorBanner>{deviceName(device)} is offline.</ErrorBanner>}
          <Field label={isAdmin ? 'Reason (optional)' : 'Reason for access'} hint="Recorded in the audit log.">
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Fix printer driver" maxLength={200} />
          </Field>
          {allowFullShell && isAdmin && (
            <div className={`rounded-lg border p-3 ${fullShell ? 'border-danger/40 bg-danger/5' : 'border-line'}`}>
              <Toggle checked={fullShell} onChange={setFullShell} label="Full shell (admin)" hint="Any command, not just the safe allowlist. A red banner is shown on the device and every command is audited." />
              {fullShell && <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-danger"><ShieldAlert size={13} /> You are confirming unrestricted command access to this device.</div>}
            </div>
          )}
          <button
            className="btn btn-primary h-10 w-full"
            disabled={!device || !online(device) || busy || (!isAdmin && !reason.trim())}
            onClick={() => session.start({ deviceId, reason, fullShell: allowFullShell ? fullShell : undefined })}
          >
            {busy ? <Spinner size={14} /> : <Play size={14} />}
            {phase === 'connecting' ? 'Connecting…' : isAdmin ? 'Connect' : 'Request access'}
          </button>
        </div>
      )}
    </div>
  );
}
