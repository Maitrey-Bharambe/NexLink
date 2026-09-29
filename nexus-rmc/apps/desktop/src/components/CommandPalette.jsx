import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerDownLeft, Monitor, Search } from 'lucide-react';
import { allNavItems } from '../utils/nav.js';
import { useAuth } from '../stores/auth.js';
import { useNetwork } from '../stores/network.js';

/** Ctrl+K command palette (prompt §42): pages + devices by name or virtual IP. */
export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const role = useAuth((s) => s.user?.role);
  const devices = useNetwork((s) => s.devices);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pages = allNavItems(role)
      .map((i) => ({ key: i.to, kind: 'Page', label: i.label, sub: i.section, icon: i.icon, to: i.to }));
    const devs = devices.map((d) => ({
      key: d.deviceId, kind: 'Device', label: d.label || d.hostname, sub: d.virtualIp || 'no virtual IP', icon: Monitor, to: `/devices/${d.deviceId}`,
    }));
    const all = [...devs, ...pages];
    if (!q) return all.slice(0, 12);
    return all.filter((r) => `${r.label} ${r.sub}`.toLowerCase().includes(q)).slice(0, 12);
  }, [query, role, devices]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  const go = (r) => {
    if (!r) return;
    navigate(r.to);
    onClose();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
    else if (e.key === 'Escape') { onClose(); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-brand-2/45 pt-[14vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Command palette"
        className="w-[600px] overflow-hidden rounded-xl border border-line-strong bg-surface shadow-[var(--s-pop)] animate-fade-up"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search size={16} className="text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a page, device name or 10.50.0.x…"
            className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted/70"
          />
          <kbd className="mono rounded border border-line px-1.5 text-[10.5px] text-muted">Esc</kbd>
        </div>
        <ul className="max-h-[360px] overflow-y-auto p-1.5" role="listbox">
          {results.length === 0 && <li className="px-3 py-6 text-center text-[12.5px] text-muted">No matches</li>}
          {results.map((r, i) => {
            const Icon = r.icon;
            return (
              <li
                key={`${r.kind}-${r.key}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(r)}
                className={`flex h-10 cursor-pointer items-center gap-3 rounded-lg px-3 ${i === active ? 'bg-accent/12' : ''}`}
              >
                <Icon size={15} className={i === active ? 'text-accent-ink' : 'text-muted'} />
                <span className="text-[13px] font-medium">{r.label}</span>
                <span className="mono truncate text-[11px] text-muted">{r.sub}</span>
                <span className="ml-auto flex items-center gap-2 text-[10.5px] text-muted">
                  <span className="uppercase tracking-wide">{r.kind}</span>
                  {i === active && <CornerDownLeft size={12} />}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
