import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Search, ShieldOff, ShieldCheck, LogOut, ChevronDown, ChevronRight, Timer, Moon, Sun, Monitor, Settings } from 'lucide-react';
import { useNetwork } from '../stores/network.js';
import { useAuth } from '../stores/auth.js';
import { useUi } from '../stores/ui.js';
import { findNavItem } from '../utils/nav.js';
import { StatusLabel, Avatar } from './Primitives.jsx';

function Breadcrumb() {
  const { pathname } = useLocation();
  const role = useAuth((s) => s.user?.role);
  const item = findNavItem(pathname, role);
  const cidr = useNetwork((s) => s.network.cidr);
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 text-[12.5px]">
      <span className="hidden text-muted xl:inline">{item?.section || 'Network'}</span>
      <ChevronRight size={13} className="hidden text-muted/60 xl:inline" />
      <span className="truncate font-semibold text-ink">{item?.label || 'Overview'}</span>
      {pathname.startsWith('/devices/') && <span className="truncate text-muted">/ device</span>}
      <span className="mono ml-2 hidden rounded-md border border-line bg-raised px-1.5 py-0.5 text-[11px] text-muted 2xl:inline">{cidr}</span>
    </div>
  );
}

/** One compact status strip: control link · RTT · VPN · devices. */
function StatusStrip() {
  const wsStatus = useNetwork((s) => s.wsStatus);
  const retryInMs = useNetwork((s) => s.retryInMs);
  const rtt = useNetwork((s) => s.rttMs);
  const vpn = useNetwork((s) => s.vpn.state);
  const deviceCount = useNetwork((s) => s.devices.length);
  const live = wsStatus === 'CONNECTED' || wsStatus === 'DEGRADED';
  const rttTone = rtt == null ? 'text-muted' : rtt < 50 ? 'text-accent-ink' : rtt < 150 ? 'text-warn' : 'text-danger';
  const secure = vpn === 'CONNECTED';
  const VpnIcon = secure ? ShieldCheck : ShieldOff;
  const online = useNetwork((s) => s.devices.filter((d) => d.status === 'CONNECTED' || d.status === 'DEGRADED').length);

  const seg = 'flex h-full items-center gap-1.5 px-3 whitespace-nowrap';
  return (
    <div className="flex h-8 shrink-0 items-center divide-x divide-line rounded-lg border border-line bg-raised/70 text-[12px]">
      <div className={seg} title={retryInMs ? `Retrying in ${Math.round(retryInMs / 1000)} s` : 'Control channel to the server'}>
        <StatusLabel status={wsStatus} pulse />
      </div>
      <div className={seg} title="Application-level RTT: console → server PING/PONG over the control channel (every 5 s)">
        <Timer size={13} className="text-muted" />
        <span className={`mono font-semibold tabular-nums ${rttTone}`}>{live ? (rtt == null ? '…' : `${rtt} ms`) : '—'}</span>
      </div>
      <div className={`${seg} ${secure ? 'text-accent-ink' : 'text-warn'}`} title={secure ? 'WireGuard hub active' : 'WireGuard is not active on the hub; tunnels are simulated. See the VPN page.'}>
        <VpnIcon size={13} />
        <span className="hidden lg:inline">VPN</span>
        <span className="font-medium">{secure ? 'WireGuard' : 'Simulated'}</span>
      </div>
      <div className={seg} title="Devices online / total">
        <Monitor size={13} className="text-muted" />
        <span className="font-semibold tabular-nums">{online}/{deviceCount}</span>
        <span className="hidden text-muted lg:inline">online</span>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const theme = useUi((s) => s.theme);
  const toggle = useUi((s) => s.toggleTheme);
  const Icon = theme === 'dark' ? Sun : Moon;
  return (
    <button className="btn btn-ghost h-8 w-8 px-0" onClick={toggle} title={`Switch to ${theme === 'dark' ? 'cream' : 'deep teal'} theme`}>
      <Icon size={16} />
    </button>
  );
}

function UserMenu() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (!user) return null;

  return (
    <div className="relative shrink-0" ref={ref}>
      <button className="btn btn-ghost h-10 gap-2.5 px-1.5" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <Avatar name={user.displayName} src={user.avatarUrl} size={30} />
        <span className="hidden text-left leading-tight lg:block">
          <span className="block max-w-[120px] truncate text-[12.5px] font-semibold text-ink">{user.displayName}</span>
          <span className="block text-[10.5px] capitalize text-muted">{user.role}</span>
        </span>
        <ChevronDown size={14} className="text-muted" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-40 w-60 animate-fade-up rounded-xl border border-line bg-surface p-1.5 shadow-[var(--s-pop)]">
          <div className="flex items-center gap-3 px-2.5 py-2.5">
            <Avatar name={user.displayName} src={user.avatarUrl} size={36} />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{user.displayName}</div>
              <div className="mono truncate text-[11px] text-muted">@{user.username} · {user.role}</div>
            </div>
          </div>
          <div className="my-1 h-px bg-line" />
          <Link to="/settings" role="menuitem" onClick={() => setOpen(false)} className="btn btn-ghost h-8 w-full justify-start">
            <Settings size={14} /> Settings
          </Link>
          <button role="menuitem" className="btn btn-ghost h-8 w-full justify-start text-danger hover:bg-danger/10 hover:text-danger" onClick={logout}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default function TopBar({ onOpenPalette }) {
  return (
    <header className="drag titlebar-pad flex h-14 shrink-0 items-center gap-4 border-b border-line bg-surface pl-5">
      <Breadcrumb />

      <button
        onClick={onOpenPalette}
        className="mx-auto flex h-8 w-full min-w-[160px] max-w-[380px] items-center gap-2 rounded-lg border border-line bg-raised/70 px-3 text-[12.5px] text-muted transition-colors hover:border-line-strong hover:text-ink-2"
      >
        <Search size={14} />
        <span className="flex-1 truncate text-left">Search devices, IPs, pages…</span>
        <kbd className="mono rounded border border-line bg-surface px-1.5 text-[10.5px]">Ctrl K</kbd>
      </button>

      <div className="flex shrink-0 items-center gap-2 pr-2">
        <StatusStrip />
        <ThemeToggle />
        <div className="h-6 w-px bg-line" />
        <UserMenu />
      </div>
    </header>
  );
}
