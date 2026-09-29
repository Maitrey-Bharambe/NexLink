import { useCallback, useEffect, useState } from 'react';
import {
  UserPlus, Users as UsersIcon, ShieldCheck, User, Check, X, KeyRound, Trash2, Ban, RotateCcw, Monitor,
} from 'lucide-react';
import { api } from '../services/api.js';
import { useAuth } from '../stores/auth.js';
import { useNetwork } from '../stores/network.js';
import { toast } from '../stores/toasts.js';
import { PageHeader, ErrorBanner, Spinner, Badge, Avatar, IconTile } from '../components/Primitives.jsx';
import { Modal, Tabs, Field, Empty, useConfirm } from '../components/ui.jsx';
import { timeAgo } from '../utils/format.js';

const ROLE_HELP = {
  admin: 'Full console: all devices, VPN, users, audit, settings. Sessions start without approval.',
  user: 'Own portal: only assigned devices. Remote sessions need admin approval; terminal is restricted.',
};

function CreateUser({ open, onClose, onCreated }) {
  const [form, setForm] = useState({ username: '', email: '', displayName: '', password: '', role: 'user' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const upd = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  useEffect(() => { if (open) { setForm({ username: '', email: '', displayName: '', password: '', role: 'user' }); setError(null); } }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/users', { ...form, displayName: form.displayName || undefined, email: form.email || undefined });
      onCreated();
      onClose();
    } catch (err) {
      setError(err.fields ? Object.values(err.fields).join(' ') : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a user" subtitle="The account is active immediately." footer={<><button className="btn btn-outline" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit} disabled={busy || !form.username || !form.password}>{busy ? <Spinner size={14} /> : <UserPlus size={14} />} Create</button></>}>
      {error && <div className="mb-3"><ErrorBanner>{error}</ErrorBanner></div>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Username"><input className="input" value={form.username} onChange={upd('username')} /></Field>
        <Field label="Display name"><input className="input" value={form.displayName} onChange={upd('displayName')} /></Field>
        <div className="col-span-2"><Field label="Email (optional)" hint="Lets them sign in with email, or with Google using the same address."><input className="input" type="email" value={form.email} onChange={upd('email')} /></Field></div>
        <Field label="Password" hint="10+ characters, letters and numbers."><input className="input" type="password" value={form.password} onChange={upd('password')} autoComplete="new-password" /></Field>
        <Field label="Role">
          <select className="input" value={form.role} onChange={upd('role')}><option value="user">User</option><option value="admin">Admin</option></select>
        </Field>
      </div>
      <p className="mt-3 text-[11.5px] text-muted">{ROLE_HELP[form.role]}</p>
    </Modal>
  );
}

function ResetPassword({ user, onClose }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState(null);
  const save = async () => {
    try {
      await api.post(`/api/users/${user.id}/password`, { password: pw });
      toast({ tone: 'success', title: 'Password reset', message: `${user.displayName} must sign in again with the new password.` });
      onClose();
    } catch (err) { setError(err.message); }
  };
  return (
    <Modal open={Boolean(user)} onClose={onClose} width={420} title={`Reset password — ${user?.displayName}`} footer={<><button className="btn btn-outline" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save} disabled={!pw}>Reset</button></>}>
      {error && <div className="mb-3"><ErrorBanner>{error}</ErrorBanner></div>}
      <Field label="New password" hint="Their current sessions are signed out."><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
    </Modal>
  );
}

export default function Users() {
  const me = useAuth((s) => s.user);
  const version = useNetwork((s) => s.versions.users);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('active');
  const [create, setCreate] = useState(false);
  const [resetFor, setResetFor] = useState(null);
  const [confirm, dialog] = useConfirm();

  const load = useCallback(() => api.get('/api/users').then((r) => { setData(r); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load, version]);
  useEffect(() => { if (data?.pending && tab === 'active' && !data.users.some((u) => u.status === 'active' && u.id !== me?.id)) setTab('pending'); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = async (u, body, msg) => {
    try {
      await api.patch(`/api/users/${u.id}`, body);
      if (msg) toast({ tone: 'success', title: msg, message: u.displayName });
      load();
    } catch (err) { toast({ tone: 'danger', title: 'Update failed', message: err.message }); }
  };
  const approve = (u, role) => patch(u, { status: 'active', role }, role === 'admin' ? 'Approved as admin' : 'Approved as user');
  const remove = async (u) => {
    const pending = u.status === 'pending';
    if (!(await confirm({ title: pending ? `Reject ${u.displayName}?` : `Delete ${u.displayName}?`, message: pending ? 'The request is removed. They can register again later.' : 'The account is deleted and all its sessions end. Audit history is kept.', confirmLabel: pending ? 'Reject' : 'Delete', danger: true }))) return;
    try { await api.delete(`/api/users/${u.id}`); load(); } catch (err) { toast({ tone: 'danger', title: 'Failed', message: err.message }); }
  };

  const users = data?.users || [];
  const list = users.filter((u) => (tab === 'all' ? true : u.status === tab));
  const admins = users.filter((u) => u.role === 'admin' && u.status === 'active').length;
  const normal = users.filter((u) => u.role === 'user' && u.status === 'active').length;

  return (
    <div className="mx-auto max-w-[1480px] space-y-5 p-6">
      {dialog}
      <CreateUser open={create} onClose={() => setCreate(false)} onCreated={load} />
      <ResetPassword user={resetFor} onClose={() => setResetFor(null)} />
      <PageHeader icon={UsersIcon} eyebrow="Administration" title="Users" subtitle="Two separate roles: administrators run the network; users get their own portal with only the devices you assign." actions={<button className="btn btn-primary" onClick={() => setCreate(true)}><UserPlus size={15} /> Add user</button>} />

      <div className="grid gap-4 md:grid-cols-3">
        <div className="card flex items-center gap-3.5 p-4"><IconTile icon={ShieldCheck} tone="amber" size={40} /><div><div className="text-[13px] font-semibold">{admins} admin{admins === 1 ? '' : 's'}</div><div className="text-[11.5px] text-muted">{ROLE_HELP.admin}</div></div></div>
        <div className="card flex items-center gap-3.5 p-4"><IconTile icon={User} tone="green" size={40} /><div><div className="text-[13px] font-semibold">{normal} user{normal === 1 ? '' : 's'}</div><div className="text-[11.5px] text-muted">{ROLE_HELP.user}</div></div></div>
        <div className={`card flex items-center gap-3.5 p-4 ${data?.pending ? 'border-gold/60' : ''}`}><IconTile icon={UserPlus} tone={data?.pending ? 'amber' : 'neutral'} size={40} /><div><div className="text-[13px] font-semibold">{data?.pending || 0} waiting for approval</div><div className="text-[11.5px] text-muted">Self-registered with email or Google.</div></div></div>
      </div>

      {error && <ErrorBanner onRetry={load}>{error}</ErrorBanner>}

      <section className="card overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <Tabs value={tab} onChange={setTab} items={[
            { id: 'pending', label: 'Pending approval', count: data?.pending || 0 },
            { id: 'active', label: 'Active', count: users.filter((u) => u.status === 'active').length },
            { id: 'disabled', label: 'Disabled', count: users.filter((u) => u.status === 'disabled').length },
            { id: 'all', label: 'All' },
          ]} />
        </div>
        {!data ? <div className="flex justify-center p-10"><Spinner /></div> : list.length === 0 ? (
          <Empty icon={UsersIcon} title={tab === 'pending' ? 'No one is waiting' : 'No users here'}>{tab === 'pending' ? 'People who register with email or Google appear here for approval.' : ''}</Empty>
        ) : tab === 'pending' ? (
          <ul className="divide-y divide-line">
            {list.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                <Avatar name={u.displayName} src={u.avatarUrl} size={38} />
                <div className="min-w-[220px] flex-1">
                  <div className="font-semibold text-ink">{u.displayName}</div>
                  <div className="text-[12px] text-muted">{u.email || u.username} · via {u.providers.join(' + ')} · requested {timeAgo(u.createdAt)}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-outline h-8" onClick={() => remove(u)}><X size={14} /> Reject</button>
                  <button className="btn btn-outline h-8" onClick={() => approve(u, 'admin')}><ShieldCheck size={14} /> Approve as admin</button>
                  <button className="btn btn-accent h-8" onClick={() => approve(u, 'user')}><Check size={14} /> Approve as user</button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>User</th><th>Sign-in</th><th>Role</th><th>Devices</th><th>Last sign-in</th><th>Status</th><th className="text-right">Actions</th></tr></thead>
              <tbody>
                {list.map((u) => {
                  const self = u.id === me?.id;
                  return (
                    <tr key={u.id}>
                      <td>
                        <span className="flex items-center gap-2.5">
                          <Avatar name={u.displayName} src={u.avatarUrl} size={30} />
                          <span>
                            <span className="flex items-center gap-1.5 font-semibold">{u.displayName}{self && <Badge tone="amber">You</Badge>}</span>
                            <span className="block text-[11.5px] text-muted">{u.email || `@${u.username}`}</span>
                          </span>
                        </span>
                      </td>
                      <td>{u.providers.map((p) => <Badge key={p} className="mr-1">{p}</Badge>)}</td>
                      <td>
                        <select className="input h-8 w-[110px] text-[12px]" value={u.role} disabled={self || u.status !== 'active'} onChange={(e) => patch(u, { role: e.target.value }, 'Role changed')}>
                          <option value="user">User</option><option value="admin">Admin</option>
                        </select>
                      </td>
                      <td className="text-[12px]">
                        {u.role === 'admin' ? <span className="text-muted">All devices</span> : u.devices.length ? (
                          <span className="flex flex-wrap gap-1">{u.devices.slice(0, 3).map((d) => <Badge key={d.deviceId} tone="blue"><Monitor size={10} />{d.hostname}</Badge>)}{u.devices.length > 3 && <span className="text-muted">+{u.devices.length - 3}</span>}</span>
                        ) : <span className="text-warn">None — assign from a device page</span>}
                      </td>
                      <td className="text-muted">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never'}</td>
                      <td>{u.status === 'active' ? <Badge tone="green">Active</Badge> : u.status === 'disabled' ? <Badge tone="red">Disabled</Badge> : <Badge tone="amber">Pending</Badge>}</td>
                      <td className="text-right">
                        {!self && (
                          <span className="inline-flex gap-1">
                            <button className="btn btn-ghost h-7 w-7 px-0" title="Reset password" onClick={() => setResetFor(u)}><KeyRound size={13} /></button>
                            {u.status === 'active'
                              ? <button className="btn btn-ghost h-7 w-7 px-0" title="Disable" onClick={() => patch(u, { status: 'disabled' }, 'User disabled')}><Ban size={13} /></button>
                              : <button className="btn btn-ghost h-7 w-7 px-0" title="Enable" onClick={() => patch(u, { status: 'active' }, 'User enabled')}><RotateCcw size={13} /></button>}
                            <button className="btn btn-ghost h-7 w-7 px-0 text-danger hover:bg-danger/10" title="Delete" onClick={() => remove(u)}><Trash2 size={13} /></button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="text-[11.5px] text-muted">To give a user access to a device, open the device and use the <UsersIcon size={11} className="inline" /> button in its header.</p>
    </div>
  );
}
