import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Sparkles, Send, Stethoscope, SquareTerminal, ScreenShare, CheckCheck, Wrench, KeyRound } from 'lucide-react';
import { api } from '../services/api.js';
import { useIsAdmin } from '../stores/auth.js';
import { useNetwork } from '../stores/network.js';
import { PageHeader, Badge, Spinner, IconTile } from '../components/Primitives.jsx';
import { Markdown } from '../components/ui.jsx';

const ACTIONS = {
  run_diagnostics: { label: 'Run diagnostics', icon: Stethoscope, to: (a) => `/diagnostics?device=${a.deviceId}&auto=1` },
  open_terminal: { label: 'Open terminal', icon: SquareTerminal, to: (a) => `/terminal?device=${a.deviceId}` },
  open_remote_desktop: { label: 'Open remote desktop', icon: ScreenShare, to: (a) => `/remote-desktop?device=${a.deviceId}` },
  acknowledge_alerts: { label: 'Review alerts', icon: CheckCheck, to: () => '/alerts' },
};

export default function Assistant() {
  const isAdmin = useIsAdmin();
  const devices = useNetwork((s) => s.devices);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const endRef = useRef(null);
  const asked = useRef(false);

  useEffect(() => { api.get('/api/ai/status').then(setStatus).catch(() => {}); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, busy]);

  const ask = async (text) => {
    const q = text.trim();
    if (!q || busy) return;
    const next = [...messages, { role: 'user', content: q }];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      const r = await api.post('/api/ai/chat', { messages: next.map(({ role, content }) => ({ role, content })) }, { timeoutMs: 60_000 });
      setMessages((m) => [...m, { role: 'assistant', content: r.answer, actions: r.actions, tools: r.tools, generator: r.generator, note: r.note }]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', content: `**Error:** ${err.message}`, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const q = params.get('q');
    if (q && !asked.current) { asked.current = true; ask(q); }
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const example = devices[0]?.hostname || 'LAB-PC-01';
  const suggestions = [
    'Give me an overview of the network health',
    `Why is ${example} slow?`,
    'Which devices have open alerts?',
    ...(isAdmin ? ['What happened recently on the network?'] : []),
  ];

  return (
    <div className="mx-auto flex h-full max-w-[1100px] flex-col p-6">
      <PageHeader
        icon={Sparkles}
        eyebrow="Intelligence"
        title="AI Assistant"
        subtitle="Asks the network, not the internet: answers come from live telemetry, alerts and the anomaly model. It suggests actions; you approve them."
        actions={status && (
          <Badge tone={status.keySet ? 'green' : 'amber'}>{status.keySet ? `Groq · ${status.model}` : 'Offline mode'}</Badge>
        )}
      />
      {status && !status.keySet && isAdmin && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-gold/45 bg-gold/12 px-4 py-2.5 text-[12.5px] text-ink-2">
          <KeyRound size={15} className="text-warn" />
          Running offline (rule-based diagnosis). Add a Groq API key in <button className="font-semibold text-accent-ink hover:underline" onClick={() => navigate('/settings')}>Settings → AI</button> for conversational answers.
        </div>
      )}

      <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {messages.length === 0 && (
            <div className="flex flex-col items-center py-10 text-center">
              <IconTile icon={Sparkles} size={48} />
              <h2 className="mt-3 text-[15px] font-semibold">What would you like to know?</h2>
              <p className="mt-1 max-w-md text-[12.5px] text-muted">The assistant can read devices, metrics history, alerts{isAdmin ? ' and the audit trail' : ''} — only for devices you can access.</p>
              <div className="mt-5 flex max-w-2xl flex-wrap justify-center gap-2">
                {suggestions.map((s) => <button key={s} className="rounded-md border border-line bg-raised px-3 py-1.5 text-[12.5px] text-ink-2 hover:border-accent/50 hover:text-ink" onClick={() => ask(s)}>{s}</button>)}
              </div>
            </div>
          )}
          {messages.map((m, i) => (m.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[75%] rounded-xl rounded-br-sm bg-primary-strong px-4 py-2.5 text-[13px] text-on-primary">{m.content}</div>
            </div>
          ) : (
            <div key={i} className="flex gap-3">
              <IconTile icon={Sparkles} size={30} tone={m.error ? 'red' : 'green'} />
              <div className="min-w-0 max-w-[85%] flex-1">
                <div className="rounded-xl rounded-tl-sm border border-line bg-raised/60 px-4 py-3"><Markdown text={m.content} /></div>
                {m.note && <div className="mt-1.5 text-[11.5px] text-warn">{m.note}</div>}
                {m.actions?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {m.actions.map((a, j) => {
                      const def = ACTIONS[a.action];
                      if (!def) return null;
                      return (
                        <button key={j} className="btn btn-outline h-8 text-[12px]" onClick={() => navigate(def.to(a))} title={a.reason}>
                          <def.icon size={13} /> {def.label} · {a.hostname}
                        </button>
                      );
                    })}
                    <span className="self-center text-[11px] text-muted">Suggested — nothing runs until you open it.</span>
                  </div>
                )}
                {m.generator && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-muted">
                    <Wrench size={11} /> {m.generator}{m.tools?.length ? ` · used ${[...new Set(m.tools)].join(', ')}` : ''}
                  </div>
                )}
              </div>
            </div>
          )))}
          {busy && <div className="flex items-center gap-2 pl-11 text-[12.5px] text-muted"><Spinner size={14} /> Looking at the network…</div>}
          <div ref={endRef} />
        </div>
        <form className="flex items-center gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
          <input className="input flex-1" value={input} onChange={(e) => setInput(e.target.value)} placeholder={`Ask about a device, e.g. "Why is ${example} slow?"`} maxLength={1000} />
          <button className="btn btn-primary h-10" disabled={busy || !input.trim()}><Send size={15} /> Ask</button>
        </form>
      </div>
    </div>
  );
}
