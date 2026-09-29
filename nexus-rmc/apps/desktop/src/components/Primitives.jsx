import { memo, useId } from 'react';

/**
 * NexLink mark: an "N" drawn as a network — four nodes, with the aqua
 * diagonal as the secure link between them. Deep-teal tile, cream nodes,
 * one gold node as the optional accent.
 */
export function LogoMark({ size = 32, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={`shrink-0 ${className}`}>
      <rect width="64" height="64" rx="14" fill="#033A41" />
      <path d="M19 45V19M45 45V19" stroke="#F6E7D0" strokeWidth="5" strokeLinecap="round" />
      <path d="M19 19L45 45" stroke="#09C4B1" strokeWidth="5" strokeLinecap="round" />
      <circle cx="19" cy="45" r="5.5" fill="#F6E7D0" />
      <circle cx="19" cy="19" r="5.5" fill="#09C4B1" />
      <circle cx="45" cy="45" r="5.5" fill="#09C4B1" />
      <circle cx="45" cy="19" r="5.5" fill="#DDAA6B" />
    </svg>
  );
}

export function Wordmark({ className = '' }) {
  return (
    <span className={`font-display font-bold tracking-tight ${className}`}>
      <span className="text-ink">Nex</span><span className="text-accent-ink">Link</span>
    </span>
  );
}

export function Logo({ compact = false }) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <LogoMark size={32} className="ring-1 ring-line" />
      {!compact && (
        <div className="min-w-0 leading-none">
          <Wordmark className="text-[18px]" />
          <div className="mt-1 truncate text-[8.5px] font-medium uppercase tracking-[0.18em] text-muted">Secure Remote Access</div>
        </div>
      )}
    </div>
  );
}

const STATUS_STYLES = {
  // Brand-aligned statuses: online aqua, connecting light aqua, warning gold,
  // offline taupe; red only for genuine errors.
  CONNECTED: { dot: 'bg-accent', text: 'text-accent-ink', label: 'Connected' },
  CONNECTING: { dot: 'bg-accent/50', text: 'text-accent-ink', label: 'Connecting' },
  RECONNECTING: { dot: 'bg-gold', text: 'text-warn', label: 'Reconnecting' },
  DEGRADED: { dot: 'bg-gold', text: 'text-warn', label: 'Degraded' },
  DISCONNECTED: { dot: 'bg-taupe', text: 'text-muted', label: 'Offline' },
  UNAUTHORIZED: { dot: 'bg-danger', text: 'text-danger', label: 'Unauthorized' },
  PENDING: { dot: 'bg-taupe', text: 'text-muted', label: 'Pending' },
  NOT_CONFIGURED: { dot: 'bg-taupe/60', text: 'text-muted', label: 'Not configured' },
};

export const statusLabel = (status) => (STATUS_STYLES[status] || STATUS_STYLES.PENDING).label;

export const StatusDot = memo(function StatusDot({ status, pulse = false, className = '' }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.PENDING;
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${s.dot} ${pulse && status === 'CONNECTED' ? 'animate-pulse-soft' : ''} ${className}`}
      aria-hidden="true"
    />
  );
});

export function StatusLabel({ status, pulse }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.PENDING;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium ${s.text}`}>
      <StatusDot status={status} pulse={pulse} />
      {s.label}
    </span>
  );
}

const TONES = {
  neutral: 'bg-raised text-muted border-line',
  green: 'bg-accent/12 text-accent-ink border-accent/30',
  amber: 'bg-gold/15 text-warn border-gold/40',
  red: 'bg-danger/10 text-danger border-danger/25',
  blue: 'bg-primary/8 text-primary border-primary/20',
  violet: 'bg-gold/15 text-warn border-gold/40',
};

export function Badge({ tone = 'neutral', children, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${TONES[tone] || TONES.neutral} ${className}`}>
      {children}
    </span>
  );
}

const ICON_TONES = {
  green: 'bg-accent/12 text-accent-ink ring-accent/25',
  blue: 'bg-primary/8 text-primary ring-primary/15',
  amber: 'bg-gold/15 text-warn ring-gold/35',
  red: 'bg-danger/10 text-danger ring-danger/20',
  violet: 'bg-gold/15 text-warn ring-gold/35',
  neutral: 'bg-raised text-muted ring-line',
};

export function IconTile({ icon: Icon, tone = 'green', size = 36, className = '' }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${ICON_TONES[tone]} ${className}`}
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.47)} strokeWidth={1.9} />
    </span>
  );
}

/** Tiny line/area chart. `points` is an array of numbers. */
export function Sparkline({ points, width = 120, height = 36, color = 'var(--c-accent)', area = true, className = '' }) {
  const id = useId();
  if (!points || points.length < 2) return null;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const xy = points.map((v, i) => [(i / (points.length - 1)) * width, height - 2 - ((v - min) / span) * (height - 6)]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={`overflow-visible ${className}`} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-a`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && <polygon points={`0,${height} ${line} ${width},${height}`} fill={`url(#${id}-a)`} />}
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r="2.6" fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** KPI tile. `pending` marks a metric whose data source arrives in a later phase. */
export const MetricCard = memo(function MetricCard({ label, value, unit, hint, pending, tone = 'green', icon, children }) {
  const valueTone = { green: 'text-ink', red: 'text-danger', amber: 'text-warn' }[tone] || 'text-ink';
  return (
    <div className="card group relative min-w-0 overflow-hidden p-4 transition-colors hover:border-line-strong">
      <div className="flex items-start justify-between gap-2">
        <div className="label-caps truncate pt-0.5">{label}</div>
        {icon && <IconTile icon={icon} tone={pending ? 'neutral' : tone} size={30} />}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className={`font-display text-[26px] font-semibold tabular-nums leading-none ${pending ? 'text-muted/40' : valueTone}`}>
          {pending ? '—' : value}
        </span>
        {!pending && unit && <span className="text-[12px] text-muted">{unit}</span>}
      </div>
      {children}
      <div className="mt-2 truncate text-[11px] text-muted">{hint}</div>
    </div>
  );
});

export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {Icon && (
        <IconTile icon={Icon} size={48} className="mb-4" />
      )}
      <div className="font-display text-[15px] font-semibold text-ink">{title}</div>
      <div className="mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-muted">{children}</div>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, icon, eyebrow }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4 animate-fade-up">
      <div className="flex min-w-0 items-center gap-3.5">
        {icon && <IconTile icon={icon} size={42} />}
        <div className="min-w-0">
          {eyebrow && <div className="label-caps mb-1 text-primary">{eyebrow}</div>}
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-0.5 text-[12.5px] text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PanelHeader({ title, subtitle, icon, right }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <IconTile icon={icon} size={28} />}
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink">{title}</div>
          {subtitle && <div className="truncate text-[11px] text-muted">{subtitle}</div>}
        </div>
      </div>
      {right}
    </div>
  );
}

export function Spinner({ size = 16 }) {
  return (
    <svg className="animate-spin text-primary" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Loading">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function ErrorBanner({ children, onRetry }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[12.5px] text-danger">
      <span>{children}</span>
      {onRetry && <button className="btn btn-outline h-7 px-2.5 text-[12px]" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Avatar({ name = '?', src, size = 32, className = '' }) {
  const initials = String(name).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  if (src) {
    return <img src={src} alt="" referrerPolicy="no-referrer" className={`shrink-0 rounded-full object-cover ring-2 ring-surface ${className}`} style={{ width: size, height: size }} />;
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-primary-strong font-semibold text-on-primary ring-2 ring-surface ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initials}
    </span>
  );
}
