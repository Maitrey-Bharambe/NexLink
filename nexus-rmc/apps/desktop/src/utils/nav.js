import {
  LayoutDashboard, Network, Monitor, Cable, ShieldCheck,
  ScreenShare, FolderTree, SquareTerminal, Radio,
  Cpu, Activity, ArrowDownUp, BellRing,
  Sparkles, Stethoscope, FileText,
  ScrollText, Users, Settings, Home,
} from 'lucide-react';

/**
 * Two separate portals (Admin / User). `badge` names a live counter from the
 * console snapshot shown next to the item.
 */
export const ADMIN_NAV = [
  {
    section: 'Network',
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboard },
      { to: '/network-map', label: 'Network Map', icon: Network },
      { to: '/devices', label: 'Devices', icon: Monitor, badge: 'pendingDevices' },
      { to: '/connections', label: 'Connections', icon: Cable },
      { to: '/vpn', label: 'VPN', icon: ShieldCheck },
    ],
  },
  {
    section: 'Remote',
    items: [
      { to: '/remote-desktop', label: 'Remote Desktop', icon: ScreenShare },
      { to: '/files', label: 'File Manager', icon: FolderTree },
      { to: '/terminal', label: 'Terminal', icon: SquareTerminal },
      { to: '/sessions', label: 'Sessions', icon: Radio, badge: 'sessionRequests' },
    ],
  },
  {
    section: 'Monitoring',
    items: [
      { to: '/system', label: 'System Monitor', icon: Cpu },
      { to: '/analysis', label: 'Network Analysis', icon: Activity },
      { to: '/traffic', label: 'Traffic', icon: ArrowDownUp },
      { to: '/alerts', label: 'Alerts', icon: BellRing, badge: 'alerts' },
    ],
  },
  {
    section: 'Intelligence',
    items: [
      { to: '/ai', label: 'AI Assistant', icon: Sparkles },
      { to: '/diagnostics', label: 'Diagnostics', icon: Stethoscope },
      { to: '/reports', label: 'Reports', icon: FileText },
    ],
  },
  {
    section: 'Administration',
    items: [
      { to: '/users', label: 'Users', icon: Users, badge: 'pendingUsers' },
      { to: '/audit', label: 'Audit Logs', icon: ScrollText },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export const USER_NAV = [
  {
    section: 'My workspace',
    items: [
      { to: '/', label: 'My Devices', icon: Home },
      { to: '/sessions', label: 'My Sessions', icon: Radio, badge: 'mySessions' },
      { to: '/alerts', label: 'Alerts', icon: BellRing, badge: 'alerts' },
    ],
  },
  {
    section: 'Remote',
    items: [
      { to: '/remote-desktop', label: 'Remote Desktop', icon: ScreenShare },
      { to: '/files', label: 'File Manager', icon: FolderTree },
      { to: '/terminal', label: 'Terminal', icon: SquareTerminal },
    ],
  },
  {
    section: 'Tools',
    items: [
      { to: '/diagnostics', label: 'Diagnostics', icon: Stethoscope },
      { to: '/ai', label: 'AI Assistant', icon: Sparkles },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export const navFor = (role) => (role === 'admin' ? ADMIN_NAV : USER_NAV);

export const allNavItems = (role = 'admin') => navFor(role).flatMap((s) => s.items.map((i) => ({ ...i, section: s.section })));

export function findNavItem(pathname, role) {
  const items = allNavItems(role);
  return items.find((i) => i.to === pathname)
    || items.filter((i) => i.to !== '/' && pathname.startsWith(`${i.to}/`)).sort((a, b) => b.to.length - a.to.length)[0];
}
