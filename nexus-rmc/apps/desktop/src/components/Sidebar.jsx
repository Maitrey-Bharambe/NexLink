import { NavLink } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen, ShieldCheck, ShieldOff } from 'lucide-react';
import { navFor } from '../utils/nav.js';
import { useAuth } from '../stores/auth.js';
import { useUi } from '../stores/ui.js';
import { useNetwork } from '../stores/network.js';
import { Logo, LogoMark, StatusDot, statusLabel } from './Primitives.jsx';

function useBadge(key) {
  return useNetwork((s) => {
    if (!key) return 0;
    if (key === 'alerts') return Object.values(s.counts.alerts || {}).reduce((a, b) => a + b, 0);
    return s.counts[key] || 0;
  });
}

function NavItem({ to, label, icon: Icon, badge, collapsed }) {
  const count = useBadge(badge);
  return (
    <NavLink
      to={to}
      end={to === '/'}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `group relative flex h-9 items-center gap-3 rounded-lg text-[13px] transition-colors ${collapsed ? 'justify-center px-0' : 'px-3'} ${
          isActive ? 'bg-accent/15 font-semibold text-ink' : 'text-ink-2 hover:bg-raised hover:text-ink'
        }`}
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute -left-3 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-accent" />}
          <Icon size={17} strokeWidth={isActive ? 2.1 : 1.8} className={`shrink-0 ${isActive ? 'text-accent' : ''}`} />
          {!collapsed && <span className="flex-1 truncate">{label}</span>}
          {count > 0 && (
            <span className={`min-w-[18px] rounded-full bg-gold px-1.5 text-center text-[10px] font-bold leading-[18px] text-brand ${collapsed ? 'absolute right-1 top-0.5 min-w-[16px] px-1 leading-4' : ''}`}>
              {count > 99 ? '99+' : count}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

function StatusCard() {
  const wsStatus = useNetwork((s) => s.wsStatus);
  const vpn = useNetwork((s) => s.vpn);
  const devices = useNetwork((s) => s.devices);
  const online = devices.filter((d) => d.status === 'CONNECTED' || d.status === 'DEGRADED').length;
  const real = vpn.mode === 'wireguard';
  const Shield = real ? ShieldCheck : ShieldOff;
  return (
    <div className="space-y-2 rounded-lg border border-line bg-brand-2/60 p-3 text-[11px]">
      <div className="flex items-center gap-1.5 text-muted">
        <StatusDot status={wsStatus} pulse />
        <span>Control server {statusLabel(wsStatus).toLowerCase()}</span>
      </div>
      <div className="flex items-center gap-1.5 text-muted">
        <Shield size={12} className={real ? 'text-accent' : 'text-gold'} />
        <span>VPN {real ? 'WireGuard active' : 'simulated tunnels'}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted">Devices online</span>
        <span className="mono font-semibold text-ink">{online}/{devices.length}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-accent" style={{ width: `${devices.length ? (online / devices.length) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

export default function Sidebar() {
  const role = useAuth((s) => s.user?.role);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggle = useUi((s) => s.toggleSidebar);
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <aside className={`theme-deep flex shrink-0 flex-col border-r border-line bg-brand transition-[width] duration-200 ${collapsed ? 'w-[68px]' : 'w-[244px]'}`}>
      <div className={`drag flex h-14 shrink-0 items-center border-b border-line ${collapsed ? 'justify-center' : 'px-4'}`}>
        {collapsed ? <LogoMark /> : <Logo />}
      </div>

      {!collapsed && (
        <div className="px-4 pt-3">
          <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] ${role === 'admin' ? 'bg-gold/20 text-gold' : 'bg-accent/15 text-accent'}`}>
            {role === 'admin' ? 'Admin console' : 'User portal'}
          </span>
        </div>
      )}

      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3" aria-label="Main">
        {navFor(role).map((group) => (
          <div key={group.section} className="mb-4">
            {collapsed
              ? <div className="mx-auto mb-2 h-px w-6 bg-line" />
              : <div className="label-caps px-3 pb-1.5">{group.section}</div>}
            <div className="space-y-0.5">
              {group.items.map((item) => <NavItem key={item.to} {...item} collapsed={collapsed} />)}
            </div>
          </div>
        ))}
      </nav>

      <div className="space-y-2 border-t border-line p-3">
        {!collapsed && <StatusCard />}
        <button
          onClick={toggle}
          className={`btn btn-ghost h-8 w-full text-[12px] text-muted ${collapsed ? 'px-0' : 'justify-start px-3'}`}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ToggleIcon size={16} />
          {!collapsed && 'Collapse'}
        </button>
      </div>
    </aside>
  );
}
