import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Stethoscope, Play, Route, Globe, Plug, Ruler, Activity } from 'lucide-react';
import { api } from '../services/api.js';
import { useNetwork, deviceName } from '../stores/network.js';
import { PageHeader, PanelHeader, Badge, ErrorBanner, Spinner } from '../components/Primitives.jsx';
import { DevicePicker, Field, Empty } from '../components/ui.jsx';
import { ms } from '../utils/format.js';

const TESTS = [
  { id: 'ping', label: 'Ping burst (10)', icon: Activity },
  { id: 'traceroute', label: 'Traceroute', icon: Route },
  { id: 'dns', label: 'DNS lookup', icon: Globe },
  { id: 'port', label: 'TCP port check', icon: Plug },
  { id: 'mtu', label: 'Path MTU', icon: Ruler },
];

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-lg border border-line bg-raised/50 px-3 py-2">
      <div className="label-caps">{label}</div>
      <div className={`mono mt-0.5 text-[15px] font-semibold ${tone || 'text-ink'}`}>{value}</div>
    </div>
  );
}

export default function Diagnostics() {
  const [params] = useSearchParams();
  const devices = useNetwork((s) => s.devices);
  const [deviceId, setDeviceId] = useState(params.get('device') || '');
  const [tests, setTests] = useState(new Set(['ping', 'traceroute', 'port']));
  const [target, setTarget] = useState('');
  const [port, setPort] = useState(4000);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const auto = useRef(params.get('auto') === '1');
  const device = devices.find((d) => d.deviceId === deviceId);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.post(`/api/devices/${deviceId}/diagnostics`, {
        tests: [...tests], target: target.trim() || undefined, port: tests.has('port') ? Number(port) : undefined,
      }, { timeoutMs: 120_000 }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (auto.current && device) { auto.current = false; run(); }
  }, [device]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => setTests((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const r = result?.results || {};

  return (
    <div className="mx-auto max-w-[1480px] space-y-5 p-6">
      <PageHeader icon={Stethoscope} eyebrow="Intelligence" title="Diagnostics" subtitle="Run network tests FROM a device's agent — through its tunnel to the hub, or to any target. Compare ICMP latency with the application-level round trip." />
      <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <section className="card space-y-4 p-5 self-start">
          <Field label="Run from device"><DevicePicker value={deviceId} onChange={setDeviceId} filter={(d) => d.status === 'CONNECTED' || d.status === 'DEGRADED'} /></Field>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-ink">Tests</div>
            <div className="space-y-1.5">
              {TESTS.map((t) => (
                <label key={t.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[12.5px] hover:bg-raised">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--c-accent)]" checked={tests.has(t.id)} onChange={() => toggle(t.id)} />
                  <t.icon size={14} className="text-muted" /> {t.label}
                </label>
              ))}
            </div>
          </div>
          <Field label="Target" hint="Leave empty to test the path to the hub (10.50.0.1 through the tunnel, or the server's LAN address).">
            <input className="input" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="hub (default) or e.g. 8.8.8.8" />
          </Field>
          {tests.has('port') && <Field label="Port"><input className="input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} /></Field>}
          <button className="btn btn-primary h-10 w-full" disabled={!device || busy || !tests.size} onClick={run}>
            {busy ? <Spinner size={14} /> : <Play size={14} />} {busy ? 'Running… (up to a minute)' : 'Run diagnostics'}
          </button>
        </section>

        <div className="min-w-0 space-y-5">
          {error && <ErrorBanner>{error}</ErrorBanner>}
          {!result && !busy && <div className="card"><Empty icon={Stethoscope} title="No results yet">Choose a device and run the tests. Results come from the device itself{device?.simulated ? ' (simulated)' : ''}.</Empty></div>}
          {busy && <div className="card flex items-center justify-center gap-3 p-12 text-[13px] text-muted"><Spinner /> Running tests on {deviceName(device)}…</div>}
          {result && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
                Results from <b className="text-ink">{result.hostname}</b>{result.simulated && <Badge tone="blue">Simulated</Badge>} in {(result.durationMs / 1000).toFixed(1)} s
              </div>
              {r.ping && (
                <section className="card overflow-hidden">
                  <PanelHeader icon={Activity} title={`Ping → ${r.ping.host}`} subtitle="10 ICMP echo requests" />
                  <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-5">
                    <Stat label="Average" value={ms(r.ping.avgMs)} tone="text-accent-ink" />
                    <Stat label="Min / Max" value={`${ms(r.ping.minMs)} / ${ms(r.ping.maxMs)}`} />
                    <Stat label="Received" value={`${r.ping.received}/${r.ping.sent}`} />
                    <Stat label="Loss" value={`${r.ping.lossPct}%`} tone={r.ping.lossPct ? 'text-warn' : 'text-accent-ink'} />
                    <Stat label="App RTT (L7)" value={ms(result.appRttMs)} />
                  </div>
                  <p className="px-4 pb-4 text-[11.5px] text-muted">ICMP measures the network layer through the tunnel; app RTT is the WebSocket round trip measured by the server. A large gap points to application or CPU load rather than the network.</p>
                </section>
              )}
              {r.traceroute && (
                <section className="card overflow-hidden">
                  <PanelHeader icon={Route} title={`Traceroute → ${r.traceroute.target}`} subtitle={`${r.traceroute.hops.length} hop(s)`} />
                  <table className="table"><thead><tr><th>Hop</th><th>Address</th><th>Latency</th></tr></thead>
                    <tbody>{r.traceroute.hops.map((h) => (
                      <tr key={h.hop}><td className="mono">{h.hop}</td><td className="mono text-accent-ink">{h.ip || '* (no reply)'}</td><td className="mono">{ms(h.ms)}</td></tr>
                    ))}</tbody></table>
                </section>
              )}
              <div className="grid gap-5 md:grid-cols-3">
                {r.dns && (
                  <section className="card p-4">
                    <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold"><Globe size={14} /> DNS</div>
                    {r.dns.error ? <p className="text-[12px] text-danger">{r.dns.error}</p> : <p className="mono text-[12px] text-accent-ink">{r.dns.addresses.join(', ')}</p>}
                    <p className="mt-1 text-[11.5px] text-muted">{r.dns.name} · {ms(r.dns.ms)}</p>
                  </section>
                )}
                {r.port && (
                  <section className="card p-4">
                    <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold"><Plug size={14} /> TCP {r.port.port}</div>
                    <Badge tone={r.port.open ? 'green' : 'red'}>{r.port.open ? 'Open' : 'Closed / filtered'}</Badge>
                    <p className="mt-1.5 text-[11.5px] text-muted">{r.port.host} {r.port.ms ? `· connect ${ms(r.port.ms)}` : r.port.error}</p>
                  </section>
                )}
                {r.mtu && (
                  <section className="card p-4">
                    <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold"><Ruler size={14} /> Path MTU</div>
                    <div className="mono text-[18px] font-semibold text-ink">{r.mtu.pathMtu || '—'}</div>
                    <p className="mt-1 text-[11.5px] text-muted">Largest unfragmented payload {r.mtu.maxPayload ?? '—'} B. WireGuard typically needs ≤ 1420.</p>
                  </section>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
