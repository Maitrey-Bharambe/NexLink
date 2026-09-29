import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, CheckCircle2, AlertTriangle, XCircle, Info, Monitor, ChevronDown } from 'lucide-react';
import { useToasts } from '../stores/toasts.js';
import { useNetwork, deviceName } from '../stores/network.js';
import { StatusDot, Badge } from './Primitives.jsx';

/** Accessible modal dialog. */
export function Modal({ open, onClose, title, subtitle, children, footer, width = 520 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    requestAnimationFrame(() => ref.current?.querySelector('input,select,textarea,button')?.focus());
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-2/45 p-6" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="card max-h-[90vh] w-full overflow-hidden shadow-[var(--s-pop)] animate-fade-up"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[12px] text-muted">{subtitle}</p>}
          </div>
          <button className="btn btn-ghost h-7 w-7 px-0" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line bg-raised/50 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Segmented tabs. items: [{ id, label, count? }] */
export function Tabs({ items, value, onChange, className = '' }) {
  return (
    <div className={`inline-flex rounded-lg border border-line bg-raised/70 p-0.5 ${className}`} role="tablist">
      {items.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition-colors ${
            value === t.id ? 'bg-surface text-ink shadow-[var(--s-card)]' : 'text-muted hover:text-ink'
          }`}
        >
          {t.icon && <t.icon size={13} />}
          {t.label}
          {t.count != null && (
            <span className={`rounded px-1 text-[10.5px] tabular-nums ${value === t.id ? 'bg-accent/15 text-accent-ink' : 'bg-line/70'}`}>{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="block">
      {label && <span className="mb-1.5 block text-[12px] font-medium text-ink">{label}</span>}
      {children}
      {error ? <span className="mt-1 block text-[11.5px] text-danger">{error}</span>
        : hint ? <span className="mt-1 block text-[11.5px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={`flex items-start justify-between gap-4 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <span>
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[11.5px] text-muted">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-line-strong'}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </label>
  );
}

const TOAST_ICON = { success: CheckCircle2, warn: AlertTriangle, danger: XCircle, info: Info };
const TOAST_TONE = { success: 'text-accent-ink', warn: 'text-warn', danger: 'text-danger', info: 'text-primary' };

export function Toaster() {
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);
  const navigate = useNavigate();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[360px] flex-col gap-2">
      {items.map((t) => {
        const Icon = TOAST_ICON[t.tone] || Info;
        return (
          <div key={t.id} className="card pointer-events-auto flex gap-3 p-3.5 shadow-[var(--s-pop)] animate-fade-up" role="status">
            <Icon size={17} className={`mt-0.5 shrink-0 ${TOAST_TONE[t.tone] || ''}`} />
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => { if (t.to) navigate(t.to); dismiss(t.id); }}
            >
              <div className="text-[12.5px] font-semibold text-ink">{t.title}</div>
              {t.message && <div className="mt-0.5 text-[12px] leading-snug text-ink-2">{t.message}</div>}
            </button>
            <button className="h-5 w-5 shrink-0 text-muted hover:text-ink" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}

/** Pick one of the devices the user may access (from the live snapshot). */
export function DevicePicker({ value, onChange, filter, placeholder = 'Choose a device', className = '' }) {
  const devices = useNetwork((s) => s.devices);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const list = useMemo(() => (filter ? devices.filter(filter) : devices), [devices, filter]);
  const current = devices.find((d) => d.deviceId === value);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button type="button" className="input flex items-center gap-2.5 text-left" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox">
        {current ? (
          <>
            <StatusDot status={current.status} />
            <span className="truncate font-medium">{deviceName(current)}</span>
            <span className="mono truncate text-[11.5px] text-muted">{current.virtualIp}</span>
            {current.simulated && <Badge tone="blue">SIM</Badge>}
          </>
        ) : <span className="text-muted">{placeholder}</span>}
        <ChevronDown size={14} className="ml-auto shrink-0 text-muted" />
      </button>
      {open && (
        <div className="card absolute left-0 right-0 top-11 z-30 max-h-72 overflow-y-auto p-1 shadow-[var(--s-pop)]" role="listbox">
          {list.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-muted">No devices available.</div>}
          {list.map((d) => (
            <button
              key={d.deviceId}
              role="option"
              aria-selected={d.deviceId === value}
              onClick={() => { onChange(d.deviceId); setOpen(false); }}
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12.5px] hover:bg-raised ${d.deviceId === value ? 'bg-accent/10' : ''}`}
            >
              <Monitor size={14} className="text-muted" />
              <span className="font-medium">{deviceName(d)}</span>
              <span className="mono text-[11px] text-muted">{d.virtualIp}</span>
              {d.simulated && <Badge tone="blue">SIM</Badge>}
              <span className="ml-auto"><StatusDot status={d.status} /></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Minimal, safe markdown for assistant answers: headings, bold, italics, code, bullets. */
export function Markdown({ text }) {
  const inline = (s, key) => {
    const parts = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g;
    let last = 0;
    let m;
    let i = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push(s.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith('**')) parts.push(<strong key={`${key}-${i}`} className="font-semibold text-ink">{tok.slice(2, -2)}</strong>);
      else if (tok.startsWith('`')) parts.push(<code key={`${key}-${i}`} className="mono rounded bg-raised px-1 py-0.5 text-[12px]">{tok.slice(1, -1)}</code>);
      else parts.push(<em key={`${key}-${i}`} className="text-muted">{tok.slice(1, -1)}</em>);
      last = m.index + tok.length;
      i += 1;
    }
    if (last < s.length) parts.push(s.slice(last));
    return parts;
  };
  const lines = String(text || '').split('\n');
  const out = [];
  let list = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`ul-${out.length}`} className="my-1.5 list-disc space-y-1 pl-5">{list}</ul>);
    list = [];
  };
  lines.forEach((line, idx) => {
    const bullet = line.match(/^\s*[-*•]\s+(.*)/) || line.match(/^\s*\d+\.\s+(.*)/);
    if (bullet) { list.push(<li key={idx}>{inline(bullet[1], idx)}</li>); return; }
    flush();
    const h = line.match(/^#{1,4}\s+(.*)/);
    if (h) out.push(<div key={idx} className="mt-2 font-semibold text-ink">{inline(h[1], idx)}</div>);
    else if (line.trim()) out.push(<p key={idx} className="my-1">{inline(line, idx)}</p>);
  });
  flush();
  return <div className="text-[13px] leading-relaxed text-ink-2">{out}</div>;
}

export function Empty({ icon: Icon = Monitor, title, children, action }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <span className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-lg bg-accent/12 text-accent-ink ring-1 ring-inset ring-accent/25"><Icon size={20} /></span>
      <div className="text-[14px] font-semibold text-ink">{title}</div>
      {children && <div className="mt-1 max-w-md text-[12.5px] leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Confirm dialog hook: const [confirm, dialog] = useConfirm(); await confirm({...}) */
export function useConfirm() {
  const [state, setState] = useState(null);
  const confirm = (opts) => new Promise((resolve) => setState({ ...opts, resolve }));
  const close = (v) => { state?.resolve(v); setState(null); };
  const dialog = (
    <Modal
      open={Boolean(state)}
      onClose={() => close(false)}
      title={state?.title}
      width={440}
      footer={(
        <>
          <button className="btn btn-outline" onClick={() => close(false)}>Cancel</button>
          <button className={`btn ${state?.danger ? 'bg-danger text-cream hover:bg-danger/90' : 'btn-primary'}`} onClick={() => close(true)}>
            {state?.confirmLabel || 'Confirm'}
          </button>
        </>
      )}
    >
      <p className="text-[13px] leading-relaxed text-ink-2">{state?.message}</p>
    </Modal>
  );
  return [confirm, dialog];
}
