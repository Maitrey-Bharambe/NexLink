import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Time-series chart (no external library).
 *   series: [{ key, label, color, area?, format? }]
 *   points: [{ t, [key]: number }]
 * Colours come from the palette tokens: aqua for primary data, gold for the
 * secondary series, taupe for neutral.
 */
export const SERIES_COLORS = {
  aqua: 'var(--c-accent)',
  gold: 'var(--c-gold)',
  teal: 'var(--c-primary)',
  taupe: 'var(--c-taupe)',
  danger: 'var(--c-danger)',
};

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export default function TimeChart({ points, series, height = 180, yMax, yFormat = (v) => String(Math.round(v)), empty = 'No data yet.' }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pad = { l: 44, r: 12, t: 10, b: 22 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;

  const { max, t0, t1 } = useMemo(() => {
    const vals = points.flatMap((p) => series.map((s) => p[s.key]).filter(Number.isFinite));
    return {
      max: yMax ?? niceMax(Math.max(...vals, 0) * 1.1),
      t0: points[0]?.t ?? 0,
      t1: points.at(-1)?.t ?? 1,
    };
  }, [points, series, yMax]);

  const x = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * w;
  const y = (v) => pad.t + h - (Math.min(v, max) / max) * h;

  if (points.length < 2) {
    return <div ref={ref} className="flex items-center justify-center rounded-lg border border-dashed border-line text-[12px] text-muted" style={{ height }}>{empty}</div>;
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const timeTicks = [0, 0.33, 0.66, 1].map((f) => t0 + f * (t1 - t0));

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = t0 + ((px - pad.l) / w) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < points.length; i += 1) if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
    setHover(best);
  };

  const hp = hover != null ? points[hover] : null;

  return (
    <div ref={ref} className="relative select-none">
      <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Time series chart">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} stroke="var(--c-line)" strokeDasharray={v === 0 ? '' : '3 4'} />
            <text x={pad.l - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--c-muted)">{yFormat(v)}</text>
          </g>
        ))}
        {timeTicks.map((t) => (
          <text key={t} x={x(t)} y={height - 6} textAnchor="middle" fontSize="10" fill="var(--c-muted)">
            {new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
          </text>
        ))}
        {series.map((s) => {
          const pts = points.filter((p) => Number.isFinite(p[s.key]));
          if (pts.length < 2) return null;
          const line = pts.map((p) => `${x(p.t).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(' ');
          return (
            <g key={s.key}>
              {s.area && (
                <polygon
                  points={`${x(pts[0].t)},${pad.t + h} ${line} ${x(pts.at(-1).t)},${pad.t + h}`}
                  fill={s.color} fillOpacity="0.12"
                />
              )}
              <polyline points={line} fill="none" stroke={s.color} strokeWidth="1.8" strokeLinejoin="round" />
            </g>
          );
        })}
        {hp && (
          <g>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={pad.t} y2={pad.t + h} stroke="var(--c-line-strong)" />
            {series.map((s) => Number.isFinite(hp[s.key]) && (
              <circle key={s.key} cx={x(hp.t)} cy={y(hp[s.key])} r="3.2" fill={s.color} stroke="var(--c-surface)" strokeWidth="1.5" />
            ))}
          </g>
        )}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[11px] shadow-[var(--s-pop)]"
          style={{ left: Math.min(Math.max(x(hp.t) + 10, 0), width - 170) }}
        >
          <div className="mb-1 font-medium text-muted">{new Date(hp.t).toLocaleTimeString([], { hour12: false })}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              <span className="text-ink-2">{s.label}</span>
              <span className="mono ml-auto pl-3 font-semibold text-ink">{Number.isFinite(hp[s.key]) ? (s.format || yFormat)(hp[s.key]) : '—'}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-3 pl-11 text-[11px] text-muted">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5"><span className="h-0.5 w-3.5 rounded" style={{ background: s.color }} />{s.label}</span>
        ))}
      </div>
    </div>
  );
}

/** Horizontal bar list, e.g. protocol distribution. items: [{ label, value, hint? }] */
export function BarList({ items, format = (v) => v, color = 'var(--c-accent)', max }) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[12px]">
            <span className="truncate text-ink-2">{i.label}{i.hint && <span className="ml-1.5 text-muted">{i.hint}</span>}</span>
            <span className="mono font-semibold text-ink">{format(i.value)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full" style={{ width: `${(i.value / top) * 100}%`, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Small ring gauge for a percentage. */
export function Gauge({ value, label, size = 74, warnAt = 70, dangerAt = 90 }) {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const color = v == null ? 'var(--c-line-strong)' : v >= dangerAt ? 'var(--c-danger)' : v >= warnAt ? 'var(--c-gold)' : 'var(--c-accent)';
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label={`${label} ${v ?? '—'}%`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--c-line)" strokeWidth="7" />
        {v != null && (
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
            strokeDasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
        <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" fontSize="15" fontWeight="600" fill="var(--c-ink)">
          {v == null ? '—' : Math.round(v)}
          {v != null && <tspan fontSize="9" fill="var(--c-muted)">%</tspan>}
        </text>
      </svg>
      <div className="mt-1 text-[11px] font-medium text-muted">{label}</div>
    </div>
  );
}
