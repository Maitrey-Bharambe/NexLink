import { useEffect, useState } from 'react';
import {
  ShieldCheck, ServerCog, KeyRound, Network, Lock, Clock3, ArrowLeft, UserPlus, LogIn, Server, ExternalLink,
} from 'lucide-react';
import { platform } from '../services/platform.js';
import { useAuth } from '../stores/auth.js';
import { Logo, LogoMark, Wordmark, Spinner, ErrorBanner } from '../components/Primitives.jsx';
import { Tabs } from '../components/ui.jsx';

function Field({ label, error, ...props }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-ink">{label}</span>
      <input className="input" {...props} />
      {error && <span className="mt-1 block text-[11.5px] text-danger">{error}</span>}
    </label>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function GoogleButton({ label = 'Continue with Google' }) {
  const providers = useAuth((s) => s.providers);
  const google = useAuth((s) => s.google);
  const loginWithGoogle = useAuth((s) => s.loginWithGoogle);
  const cancelGoogle = useAuth((s) => s.cancelGoogle);
  const [error, setError] = useState(null);

  const go = async () => {
    setError(null);
    try { await loginWithGoogle(); } catch (err) { setError(err.message); }
  };

  if (google) {
    return (
      <div className="rounded-lg border border-accent/35 bg-accent/10 p-3 text-[12.5px]">
        <div className="flex items-center gap-2 font-medium text-ink"><Spinner size={14} /> Waiting for Google…</div>
        <p className="mt-1 text-muted">Finish signing in in the browser window that just opened, then come back here.</p>
        <button className="mt-2 text-[12px] font-medium text-accent-ink hover:underline" onClick={cancelGoogle}>Cancel</button>
      </div>
    );
  }
  return (
    <div>
      <button
        type="button"
        className="btn btn-outline h-10 w-full"
        onClick={go}
        disabled={!providers.google}
        title={providers.google ? undefined : 'Google sign-in has not been set up on this server yet (Settings → Sign-in).'}
      >
        <GoogleIcon /> {label}
      </button>
      {!providers.google && <p className="mt-1.5 text-center text-[11px] text-muted">Google sign-in is not configured on this server yet.</p>}
      {error && <div className="mt-2"><ErrorBanner>{error}</ErrorBanner></div>}
    </div>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.12em] text-muted">
      <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function ServerForm({ compact }) {
  const serverUrl = useAuth((s) => s.serverUrl);
  const changeServer = useAuth((s) => s.changeServer);
  const [value, setValue] = useState(serverUrl);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    try {
      new URL(value); // eslint-disable-line no-new
    } catch {
      return setErr('Enter a full address, e.g. http://192.168.1.10:4000');
    }
    setBusy(true);
    try { await changeServer(value); } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className={compact ? 'flex items-end gap-2' : 'space-y-3'}>
      <div className="flex-1">
        <Field label="Control server address" value={value} onChange={(e) => setValue(e.target.value)} error={err} spellCheck={false} />
      </div>
      <button className={`btn btn-outline ${compact ? '' : 'w-full'}`} disabled={busy}>
        {busy ? <Spinner size={14} /> : <ServerCog size={14} />} Connect
      </button>
    </form>
  );
}

function SignInForm() {
  const login = useAuth((s) => s.login);
  const sessionError = useAuth((s) => s.error);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(sessionError);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try { await login(username, password); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <Field label="Email or username" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className="btn btn-primary h-10 w-full" disabled={busy || !username || !password}>
        {busy ? <Spinner size={14} /> : <LogIn size={15} />} Sign in
      </button>
    </form>
  );
}

function RegisterForm() {
  const register = useAuth((s) => s.register);
  const [form, setForm] = useState({ displayName: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState(null);
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const upd = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setFields({});
    if (form.password !== form.confirm) return setFields({ confirm: 'Passwords do not match.' });
    setBusy(true);
    try {
      await register({ email: form.email, displayName: form.displayName, password: form.password });
    } catch (err) {
      setError(err.message);
      setFields(err.fields || {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3.5">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <Field label="Full name" value={form.displayName} onChange={upd('displayName')} error={fields.displayName} autoComplete="name" />
      <Field label="Email" type="email" value={form.email} onChange={upd('email')} error={fields.email} autoComplete="email" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Password" type="password" value={form.password} onChange={upd('password')} error={fields.password} autoComplete="new-password" />
        <Field label="Confirm" type="password" value={form.confirm} onChange={upd('confirm')} error={fields.confirm} autoComplete="new-password" />
      </div>
      <p className="text-[11.5px] text-muted">At least 10 characters with letters and numbers. An administrator approves new accounts.</p>
      <button className="btn btn-primary h-10 w-full" disabled={busy || !form.email || !form.password || !form.displayName}>
        {busy ? <Spinner size={14} /> : <UserPlus size={15} />} Request access
      </button>
    </form>
  );
}

function LoginPanel() {
  const providers = useAuth((s) => s.providers);
  const [mode, setMode] = useState('signin');
  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-display text-[20px] font-semibold">{mode === 'signin' ? 'Sign in to NexLink' : 'Request an account'}</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">
          {mode === 'signin' ? 'Authorized users only. Every session is audited.' : 'Your account stays locked until an administrator approves it.'}
        </p>
      </div>
      {providers.registration && (
        <Tabs value={mode} onChange={setMode} items={[{ id: 'signin', label: 'Sign in' }, { id: 'register', label: 'Create account' }]} className="w-full [&>button]:flex-1 [&>button]:justify-center" />
      )}
      <GoogleButton label={mode === 'signin' ? 'Continue with Google' : 'Sign up with Google'} />
      <Divider />
      {mode === 'signin' ? <SignInForm /> : <RegisterForm />}
    </div>
  );
}

function SetupForm() {
  const setup = useAuth((s) => s.setup);
  const [form, setForm] = useState({ username: 'admin', email: '', displayName: '', password: '', confirm: '' });
  const [error, setError] = useState(null);
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const upd = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setFields({});
    if (form.password !== form.confirm) return setFields({ confirm: 'Passwords do not match.' });
    setBusy(true);
    try {
      await setup({ username: form.username, email: form.email, displayName: form.displayName || undefined, password: form.password });
    } catch (err) {
      setError(err.message);
      setFields(err.fields || {});
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3.5">
      <div>
        <div className="mb-3 inline-flex items-center gap-1.5 rounded-md border border-accent/35 bg-accent/12 px-2.5 py-1 text-[11px] font-semibold text-accent-ink">
          <ShieldCheck size={13} /> First-run setup
        </div>
        <h2 className="font-display text-[20px] font-semibold">Create the administrator</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">There are no default credentials. This appears only once, while no accounts exist.</p>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <GoogleButton label="Become admin with Google" />
      <Divider />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Username" value={form.username} onChange={upd('username')} error={fields.username} autoComplete="username" />
        <Field label="Display name" value={form.displayName} onChange={upd('displayName')} placeholder="Lab Admin" />
      </div>
      <Field label="Email (optional)" type="email" value={form.email} onChange={upd('email')} error={fields.email} autoComplete="email" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Password" type="password" value={form.password} onChange={upd('password')} autoComplete="new-password" error={fields.password} />
        <Field label="Confirm" type="password" value={form.confirm} onChange={upd('confirm')} autoComplete="new-password" error={fields.confirm} />
      </div>
      <button className="btn btn-primary h-10 w-full" disabled={busy || !form.password}>
        {busy ? <Spinner size={14} /> : <Lock size={14} />} Create administrator
      </button>
    </form>
  );
}

function Pending() {
  const notice = useAuth((s) => s.notice);
  const back = useAuth((s) => s.backToLogin);
  return (
    <div className="space-y-4 text-center">
      <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-lg bg-gold/15 text-warn ring-1 ring-inset ring-gold/40"><Clock3 size={22} /></span>
      <div>
        <h2 className="font-display text-[20px] font-semibold">Waiting for approval</h2>
        <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-muted">
          {notice || 'Your account is waiting for an administrator.'} You will be able to sign in as soon as it is approved.
        </p>
      </div>
      <button className="btn btn-outline" onClick={back}><ArrowLeft size={14} /> Back to sign in</button>
    </div>
  );
}

function HostPanel() {
  const boot = useAuth((s) => s.boot);
  const changeServer = useAuth((s) => s.changeServer);
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { platform.hub?.status().then(setSt).catch(() => {}); }, []);
  if (!platform.hub || (st && !st.available)) return null;

  const host = async () => {
    setBusy(true);
    setError(null);
    try {
      await platform.hub.enable();
      await changeServer('http://localhost:4000');
    } catch (err) {
      setError(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      platform.hub.status().then(setSt).catch(() => {});
    } finally {
      setBusy(false);
      boot();
    }
  };

  return (
    <div className="rounded-lg border border-line bg-raised/60 p-4">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-ink"><Server size={15} className="text-accent-ink" /> Make this PC the NexLink hub</div>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">
        Runs the control server here so other PCs can connect to it. Needs MongoDB Community Server on this PC
        {st && <> — <b className={st.mongo ? 'text-accent-ink' : 'text-warn'}>{st.mongo ? 'MongoDB detected' : 'MongoDB not found'}</b></>}.
      </p>
      {st && !st.mongo && (
        <a className="mt-1 inline-flex items-center gap-1 text-[12px] font-medium text-accent-ink underline" href="https://www.mongodb.com/try/download/community" target="_blank" rel="noreferrer">
          <ExternalLink size={12} /> Download MongoDB Community Server
        </a>
      )}
      {error && <div className="mt-2"><ErrorBanner>{error}</ErrorBanner></div>}
      <button className="btn btn-primary mt-3 w-full" onClick={host} disabled={busy}>
        {busy ? <Spinner size={14} /> : <Server size={14} />} Start the server on this PC
      </button>
    </div>
  );
}

function Offline() {
  const error = useAuth((s) => s.error);
  const boot = useAuth((s) => s.boot);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-[20px] font-semibold">Connect to NexLink</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">No NexLink server answered. Connect to your organisation's server, or host one on this PC.</p>
      </div>
      <ErrorBanner onRetry={boot}>{error}</ErrorBanner>
      <ServerForm />
      <HostPanel />
    </div>
  );
}

export default function Login() {
  const phase = useAuth((s) => s.phase);
  const serverUrl = useAuth((s) => s.serverUrl);

  return (
    <div className="relative grid h-full grid-cols-1 bg-canvas lg:grid-cols-[1.1fr_1fr]">
      <div className="drag absolute inset-x-0 top-0 z-10 h-10" />

      {/* Brand panel: always deep teal */}
      <div className="theme-deep net-grid relative hidden flex-col justify-between overflow-hidden bg-brand p-10 lg:flex">
        <div className="relative inline-flex items-center gap-1.5 self-start rounded-md border border-line bg-brand-2/60 px-2.5 py-1 text-[11px] font-medium tracking-wide text-ink-2">
          <Network size={13} className="text-accent" /> NEXLINK PRIVATE NETWORK · 10.50.0.0/24
        </div>

        <div className="relative max-w-lg">
          <div className="flex items-center gap-4">
            <LogoMark size={64} className="ring-1 ring-line-strong" />
            <div>
              <Wordmark className="text-[40px] leading-none" />
              <div className="mt-2 text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Secure remote access anywhere</div>
            </div>
          </div>
          <h1 className="mt-10 font-display text-[28px] font-semibold leading-tight tracking-tight">
            Secure infrastructure for connecting and managing remote devices.
          </h1>
          <p className="mt-3 text-[13.5px] leading-relaxed text-ink-2">
            An encrypted WireGuard network between authorized machines, with remote desktop,
            file transfer, terminal, live monitoring and AI-assisted diagnostics on top.
          </p>
        </div>

        <div className="relative grid max-w-lg grid-cols-3 gap-3">
          {[[ShieldCheck, 'WireGuard', 'Encrypted tunnels'], [KeyRound, 'Admin & user', 'Separate portals'], [Lock, 'Audited', 'Every action logged']].map(([Icon, a, b]) => (
            <div key={a} className="rounded-lg border border-line bg-brand-2/60 p-3">
              <Icon size={16} className="text-accent" />
              <div className="mt-2 text-[12px] font-semibold">{a}</div>
              <div className="text-[11px] text-muted">{b}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Form panel */}
      <div className="app-backdrop flex flex-col items-center justify-center overflow-y-auto px-10 py-10">
        <div className="card w-full max-w-[420px] p-8 animate-fade-up">
          <div className="mb-6 lg:hidden"><Logo /></div>
          {phase === 'booting' && (
            <div className="flex items-center gap-3 text-[13px] text-muted"><Spinner /> Contacting control server…</div>
          )}
          {phase === 'offline' && <Offline />}
          {phase === 'setup' && <SetupForm />}
          {phase === 'login' && <LoginPanel />}
          {phase === 'pending' && <Pending />}
        </div>
        {phase !== 'offline' && phase !== 'booting' && (
          <div className="mt-6 w-full max-w-[420px] px-2">
            <details className="text-[12px] text-muted">
              <summary className="flex cursor-pointer select-none items-center gap-2">
                <ServerCog size={13} /> Server: <span className="mono text-ink-2">{serverUrl}</span>
              </summary>
              <div className="mt-3"><ServerForm compact /></div>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
