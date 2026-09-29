import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, ShieldOff, RefreshCw, FileCog, Copy, Check, CheckCircle2, Circle } from 'lucide-react';
import { api } from '../services/api.js';
import { useNetwork } from '../stores/network.js';
import { PageHeader, Badge, PanelHeader, ErrorBanner, Spinner, StatusLabel } from '../components/Primitives.jsx';
import { Modal } from '../components/ui.jsx';
import { ms, timeAgo, dateTime } from '../utils/format.js';

function Copyable({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="flex items-stretch gap-2">
      <code className="mono flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-line bg-raised px-3 py-2 text-[11.5px]">{text}</code>
      <button className="btn btn-outline h-auto px-2.5" onClick={async () => { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); }}>
        {ok ? <Check size={14} className="text-accent-ink" /> : <Copy size={14} />}
      </button>
    </div>
  );
}

export default function Vpn() {
  const snapshotAt = useNetwork((s) => s.snapshotAt);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState(null);

  const load = useCallback(() => api.get('/api/vpn').then((r) => { setData(r); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load, snapshotAt]);

  const refresh = async () => {
    setBusy(true);
    try { await api.post('/api/vpn/refresh', {}); await load(); } finally { setBusy(false); }
  };
  const writeConfig = async () => {
    setBusy(true);
    try { setConfig(await api.post('/api/vpn/hub-config', {})); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (!data) return <div className="p-6">{error ? <ErrorBanner onRetry={load}>{error}</ErrorBanner> : <Spinner />}</div>;
  const hub = data.hub;
  const real = hub.mode === 'wireguard';
  const steps = [
    { done: hub.wgInstalled, text: 'Install WireGuard for Windows on the hub (this PC) from wireguard.com/install.' },
    { done: real, text: 'Write the hub config below and install it as a tunnel service (run the command as Administrator).' },
    { done: real, text: 'Enable IP routing on the hub (registry command below, then reboot) so peers can reach each other through it.' },
    { done: false, text: 'On each device: install WireGuard, then run the NexLink Agent once as Administrator — it installs its own tunnel.' },
  ];

  return (
    <div className="mx-auto max-w-[1680px] space-y-5 p-6">
      <PageHeader
        icon={ShieldCheck}
        eyebrow="Network"
        title="VPN"
        subtitle="WireGuard hub-and-spoke network. The hub (10.50.0.1) routes traffic between peers."
        actions={(
          <>
            <button className="btn btn-outline" onClick={refresh} disabled={busy}>{busy ? <Spinner size={14} /> : <RefreshCw size={14} />} Re-detect</button>
            <button className="btn btn-primary" onClick={writeConfig} disabled={busy}><FileCog size={14} /> Write hub config</button>
          </>
        )}
      />
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Modal open={Boolean(config)} onClose={() => setConfig(null)} width={680} title="Hub configuration written" subtitle="Keep this file private — it contains the hub's private key." footer={<button className="btn btn-primary" onClick={() => setConfig(null)}>Done</button>}>
        {config && (
          <div className="space-y-3 text-[12.5px]">
            <div><div className="mb-1 font-medium">File</div><Copyable text={config.file} /></div>
            <div className="font-medium">Run as Administrator on the hub:</div>
            {config.commands.map((c) => <Copyable key={c} text={c} />)}
            <p className="text-muted">Then click <b>Re-detect</b>. When the interface is up, new devices get real tunnels automatically.</p>
          </div>
        )}
      </Modal>

      <div className="grid gap-5 xl:grid-cols-[420px_minmax(0,1fr)]">
        <div className="space-y-5">
          <section className={`card overflow-hidden ${real ? '' : 'border-gold/50'}`}>
            <PanelHeader icon={real ? ShieldCheck : ShieldOff} title="Hub status" subtitle={hub.interface} right={<Badge tone={real ? 'green' : 'amber'}>{real ? 'WireGuard active' : 'Simulated'}</Badge>} />
            {!real && <div className="border-b border-line bg-gold/10 px-4 py-2.5 text-[12px] text-warn">{hub.reason}</div>}
            <dl className="divide-y divide-line text-[12px]">
              {[['Address', hub.address], ['Endpoint', hub.endpoint], ['Listen port', `${hub.listenPort}/udp`], ['WireGuard installed', hub.wgInstalled ? 'Yes' : 'No'],
                ['Hub public key', hub.publicKey], ['Last check', dateTime(hub.lastCheck)]].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 px-4 py-2.5"><dt className="text-muted">{k}</dt><dd className="mono truncate text-right text-ink" title={String(v)}>{v}</dd></div>
              ))}
            </dl>
          </section>
          <section className="card overflow-hidden">
            <PanelHeader icon={FileCog} title="Enable real tunnels" subtitle="Everything else works in simulated mode" />
            <ol className="space-y-3 p-4">
              {steps.map((s, i) => (
                <li key={i} className="flex gap-3 text-[12.5px]">
                  {s.done ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-accent-ink" /> : <Circle size={16} className="mt-0.5 shrink-0 text-line-strong" />}
                  <span className={s.done ? 'text-muted line-through' : 'text-ink-2'}>{s.text}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <section className="card overflow-hidden">
          <PanelHeader icon={ShieldCheck} title="Peers" subtitle={`${data.peers.length} approved device(s) in ${data.network.cidr}`} />
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Device</th><th>Virtual IP</th><th>Public key</th><th>Tunnel</th><th>Status</th><th>Latency</th><th>Loss</th><th>Last seen</th></tr></thead>
              <tbody>
                {data.peers.map((p) => (
                  <tr key={p.deviceId}>
                    <td className="font-semibold">{p.hostname} {p.simulated && <Badge tone="blue">SIM</Badge>}</td>
                    <td className="mono text-accent-ink">{p.virtualIp}</td>
                    <td className="mono text-[11px] text-muted">{p.publicKey || '—'}</td>
                    <td><Badge tone={p.tunnel?.mode === 'wireguard' ? 'green' : p.tunnel?.mode === 'simulated' ? 'blue' : 'neutral'}>{p.tunnel?.mode}</Badge></td>
                    <td><StatusLabel status={p.status} /></td>
                    <td className="mono">{ms(p.latencyMs)}</td>
                    <td className="mono">{p.packetLossPct != null ? `${p.packetLossPct}%` : '—'}</td>
                    <td className="text-muted">{timeAgo(p.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.peers.length && <p className="p-8 text-center text-[12.5px] text-muted">No peers yet. Approve a device to add it to the network.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
