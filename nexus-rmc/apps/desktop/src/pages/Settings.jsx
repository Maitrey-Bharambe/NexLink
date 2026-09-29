import { useEffect, useState } from 'react';
import { NETWORK, PROTOCOL_VERSION } from '@nexus/protocol';
import {
  Server, Network, AppWindow, Palette, Moon, Sun, Settings as SettingsIcon, User, Sparkles, Gauge, ShieldCheck, KeyRound, Save, ExternalLink,
} from 'lucide-react';
import { useAuth } from '../stores/auth.js';
import { useUi } from '../stores/ui.js';
import { platform } from '../services/platform.js';
import { api } from '../services/api.js';
import { toast } from '../stores/toasts.js';
import { PageHeader, Badge, PanelHeader, Spinner, ErrorBanner, Avatar } from '../components/Primitives.jsx';
import { Field, Toggle } from '../components/ui.jsx';

function Row({ k, children }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 last:border-0">
      <span className="text-muted">{k}</span>
      <span className="mono truncate text-right text-ink">{children}</span>
    </div>
  );
}

function Profile() {
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);
  const [name, setName] = useState(user.displayName);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const hasPassword = user.providers?.includes('password');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { displayName: name };
      if (pw.next) Object.assign(body, { currentPassword: pw.current || undefined, newPassword: pw.next });
      const r = await api.patch('/api/auth/me', body);
      setUser(r.user);
      setPw({ current: '', next: '' });
      toast({ tone: 'success', title: 'Profile saved' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card overflow-hidden">
      <PanelHeader icon={User} title="Your profile" subtitle={`${user.role === 'admin' ? 'Administrator' : 'User'} · signs in with ${user.providers?.join(' + ') || 'password'}`} />
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-3">
          <Avatar name={user.displayName} src={user.avatarUrl} size={44} />
          <div className="text-[12.5px]"><div className="font-semibold text-ink">{user.email || user.username}</div><div className="text-muted">@{user.username}</div></div>
        </div>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <Field label="Display name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          {hasPassword && <Field label="Current password"><input className="input" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></Field>}
          <Field label={hasPassword ? 'New password' : 'Set a password'} hint={hasPassword ? '' : 'Optional: also sign in without Google.'}><input className="input" type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></Field>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner size={14} /> : <Save size={14} />} Save profile</button>
      </div>
    </section>
  );
}

function AdminSettings() {
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState({ clientId: '', clientSecret: '' });

  useEffect(() => {
    api.get('/api/settings').then((r) => { setS(r); setGoogle({ clientId: r.auth.googleClientId || '', clientSecret: '' }); }).catch((e) => setError(e.message));
  }, []);

  const save = async (body, msg) => {
    setBusy(true);
    try {
      const r = await api.patch('/api/settings', body);
      setS((prev) => ({ ...prev, ...r }));
      toast({ tone: 'success', title: msg || 'Settings saved' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Could not save', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!s) return <div className="flex justify-center p-6"><Spinner /></div>;
  const t = s.thresholds;
  const setT = (k) => (e) => setS({ ...s, thresholds: { ...t, [k]: Number(e.target.value) } });

  return (
    <>
      <section className="card overflow-hidden border-accent/40">
        <PanelHeader icon={Network} title="Share NexLink" subtitle="What other people and PCs need to connect to this server" />
        <div className="space-y-2 p-4 text-[12.5px]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Server address (enter it in the NexLink app)</span>
            <button className="mono rounded-md border border-line bg-raised px-2 py-1 text-ink hover:border-accent/50" onClick={() => { navigator.clipboard.writeText(s.publicUrl); toast({ tone: 'success', title: 'Copied', message: s.publicUrl }); }}>{s.publicUrl}</button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Agent for managed PCs</span>
            <span className="mono text-ink">{s.publicUrl}/downloads/NexLinkAgent.exe</span>
          </div>
          <p className="text-[11.5px] text-muted">
            Users install the NexLink app and connect to this address (then register or use Google; you approve them).
            Managed PCs download the agent and paste an enrollment code from Devices → Enroll a device.
            Other PCs must be able to reach this PC on TCP port 4000 (allow it in Windows Firewall for private networks).
          </p>
        </div>
      </section>

      <section className="card overflow-hidden">
        <PanelHeader icon={Sparkles} title="AI assistant (Groq)" subtitle="Without a key the assistant runs an offline, rule-based diagnosis" right={<Badge tone={s.ai.keySet ? 'green' : 'amber'}>{s.ai.keySet ? `Key set (${s.ai.keySource})` : 'No key'}</Badge>} />
        <div className="space-y-3 p-4">
          <Field label="Groq API key" hint={s.ai.keySource === 'env' ? 'Set through GROQ_API_KEY in the server .env (takes priority).' : 'Stored encrypted on the server (AES-256-GCM). Never shown again.'}>
            <div className="flex gap-2">
              <input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={s.ai.keySet ? '•••••••• (saved)' : 'gsk_…'} autoComplete="off" />
              <button className="btn btn-primary h-10" disabled={busy || !key} onClick={() => { save({ groqKey: key }, 'Groq key saved'); setKey(''); }}><KeyRound size={14} /> Save</button>
              {s.ai.keySet && s.ai.keySource === 'console' && <button className="btn btn-outline h-10" onClick={() => save({ groqKey: null }, 'Groq key removed')}>Remove</button>}
            </div>
          </Field>
          <Field label="Model" hint="Any Groq chat model with tool calling, e.g. llama-3.3-70b-versatile.">
            <div className="flex gap-2">
              <input className="input" value={s.ai.model} onChange={(e) => setS({ ...s, ai: { ...s.ai, model: e.target.value } })} />
              <button className="btn btn-outline h-10" onClick={() => save({ ai: { model: s.ai.model } }, 'Model saved')}>Save</button>
            </div>
          </Field>
        </div>
      </section>

      <section className="card overflow-hidden">
        <PanelHeader icon={ShieldCheck} title="Sign-in & access policy" />
        <div className="space-y-4 p-4">
          <div className="rounded-lg border border-line bg-raised/50 p-3 text-[12.5px]">
            <div className="flex items-center justify-between">
              <span className="font-medium text-ink">Google sign-in</span>
              <Badge tone={s.auth.google ? 'green' : 'amber'}>{s.auth.google ? 'Configured' : 'Not configured'}</Badge>
            </div>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-[12px] text-ink-2">
              <li>Google Cloud Console → APIs &amp; Services → <b>OAuth consent screen</b>: set it up (External, add your users as test users while in testing).</li>
              <li>Credentials → <b>Create OAuth client ID</b> → type <b>Desktop app</b>. No redirect URI is needed: NexLink receives the sign-in on each PC at 127.0.0.1.</li>
              <li>Paste the client ID and secret below. Every NexLink app connected to this server can then use Google.</li>
            </ol>
            {s.auth.googleSource === 'env' ? (
              <p className="mt-2 text-[11.5px] text-muted">Configured in the server's .env file.</p>
            ) : (
              <div className="mt-3 grid gap-2">
                <input className="input" placeholder="Client ID (…apps.googleusercontent.com)" value={google.clientId} onChange={(e) => setGoogle({ ...google, clientId: e.target.value })} />
                <div className="flex gap-2">
                  <input className="input" type="password" placeholder={s.auth.google ? '•••••••• (secret saved)' : 'Client secret'} value={google.clientSecret} onChange={(e) => setGoogle({ ...google, clientSecret: e.target.value })} autoComplete="off" />
                  <button
                    className="btn btn-primary h-10"
                    disabled={busy || !google.clientId}
                    onClick={() => save({ google: { clientId: google.clientId, ...(google.clientSecret ? { clientSecret: google.clientSecret } : {}) } }, 'Google sign-in saved').then(() => setGoogle((g) => ({ ...g, clientSecret: '' })))}
                  >
                    <Save size={14} /> Save
                  </button>
                  {s.auth.google && <button className="btn btn-outline h-10" onClick={() => { save({ google: { clientId: null, clientSecret: null } }, 'Google sign-in removed'); setGoogle({ clientId: '', clientSecret: '' }); }}>Remove</button>}
                </div>
              </div>
            )}
            <div className="mt-2 text-[11.5px] text-muted">New Google and email sign-ups become <b>users</b> and wait for your approval.</div>
          </div>
          <Toggle checked={s.policy.userSessionsNeedApproval} onChange={(v) => save({ policy: { userSessionsNeedApproval: v } })} label="Users' remote sessions need admin approval" hint="Recommended. Admin sessions always start immediately." />
          <Toggle checked={s.policy.adminFullShell} onChange={(v) => save({ policy: { adminFullShell: v } })} label="Allow admins to open a full shell" hint="When off, even admins are limited to the safe command allowlist." />
        </div>
      </section>

      <section className="card overflow-hidden">
        <PanelHeader icon={Gauge} title="Alert thresholds" subtitle="A breach must last the sustain time before an alert opens" />
        <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          {[['cpuPct', 'CPU %'], ['ramPct', 'Memory %'], ['diskPct', 'Disk %'], ['latencyMs', 'Latency ms'], ['lossPct', 'Packet loss %'], ['sustainSec', 'Sustain (s)'], ['offlineSec', 'Offline after (s)']].map(([k, label]) => (
            <Field key={k} label={label}><input className="input" type="number" value={t[k]} onChange={setT(k)} /></Field>
          ))}
          <div className="flex items-end"><button className="btn btn-primary h-10 w-full" disabled={busy} onClick={() => save({ thresholds: t }, 'Thresholds saved')}><Save size={14} /> Save</button></div>
        </div>
      </section>
    </>
  );
}

export default function Settings() {
  const serverUrl = useAuth((s) => s.serverUrl);
  const isAdmin = useAuth((s) => s.user?.role === 'admin');
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const [info, setInfo] = useState(null);
  const [health, setHealth] = useState(null);

  useEffect(() => {
    platform.appInfo().then(setInfo);
    api.get('/api/health', { auth: false }).then(setHealth).catch(() => setHealth({ status: 'unreachable' }));
  }, []);

  return (
    <div className="mx-auto max-w-[1280px] p-6">
      <PageHeader icon={SettingsIcon} eyebrow={isAdmin ? 'Administration' : 'Tools'} title="Settings" subtitle={isAdmin ? 'Your profile, server policies, AI, alerting and appearance.' : 'Your profile and appearance.'} />
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Profile />
          {isAdmin && <AdminSettings />}
        </div>
        <div className="space-y-5">
          <section className="card overflow-hidden text-[12.5px]">
            <PanelHeader icon={Palette} title="Appearance" subtitle="Stored on this computer" />
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="text-muted">Theme</span>
              <div className="flex rounded-lg border border-line bg-raised/70 p-0.5">
                {[['light', Sun, 'Cream'], ['dark', Moon, 'Deep teal']].map(([id, Icon, label]) => (
                  <button key={id} onClick={() => theme !== id && toggleTheme()} className={`flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium ${theme === id ? 'bg-surface text-ink shadow-[var(--s-card)]' : 'text-muted hover:text-ink'}`}>
                    <Icon size={13} /> {label}
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section className="card overflow-hidden text-[12.5px]">
            <PanelHeader icon={Server} title="Control server" subtitle="Where this console connects" />
            <Row k="Address">{serverUrl}</Row>
            <Row k="Health">{health ? <Badge tone={health.status === 'ok' ? 'green' : 'red'}>{health.status}</Badge> : '…'}</Row>
            <Row k="Database">{health?.db ?? '—'}</Row>
            <Row k="Protocol">{health?.protocol ?? '—'} (console {PROTOCOL_VERSION})</Row>
            <p className="px-4 py-3 text-[11.5px] text-muted">To change the server, sign out and use the server field on the sign-in screen.</p>
          </section>
          <section className="card overflow-hidden text-[12.5px]">
            <PanelHeader icon={Network} title="Private network plan" subtitle="WireGuard addressing" />
            <Row k="CIDR">{NETWORK.cidr}</Row>
            <Row k="Hub">{NETWORK.gateway}</Row>
            <Row k="Agents">{NETWORK.agentRange.join(' – ')}</Row>
            <Row k="Simulated">{NETWORK.simulatedRange.join(' – ')}</Row>
            <Row k="WireGuard port">{NETWORK.wireguardPort}/udp</Row>
          </section>
          <section className="card overflow-hidden text-[12.5px]">
            <PanelHeader icon={AppWindow} title="Application" subtitle="This console" />
            <Row k="Version">{info?.version ?? '…'}</Row>
            <Row k="Runtime">{platform.isDesktop ? `Electron (${info?.platform ?? ''})` : 'Browser (dev)'}</Row>
            <Row k="Session storage">{info?.secureStorage ? 'OS-encrypted (safeStorage)' : 'Memory only'}</Row>
            <a className="flex items-center gap-1.5 px-4 py-3 text-[12px] font-medium text-accent-ink hover:underline" href="https://www.wireguard.com/install/" target="_blank" rel="noreferrer"><ExternalLink size={13} /> WireGuard downloads</a>
          </section>
        </div>
      </div>
    </div>
  );
}
