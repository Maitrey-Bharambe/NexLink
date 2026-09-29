import { useCallback, useEffect, useRef, useState } from 'react';
import { SquareTerminal, CornerDownLeft, Trash2 } from 'lucide-react';
import { MessageType, TERMINAL_ALLOWLIST, checkAllowlistedCommand } from '@nexus/protocol';
import { useRemoteSession } from '../services/remoteSession.js';
import SessionGate from '../components/SessionGate.jsx';
import { PageHeader, Spinner } from '../components/Primitives.jsx';
import { randomId } from '../utils/format.js';

const QUICK = ['ipconfig', 'hostname', 'whoami', 'ping 10.50.0.1', 'tracert -d 10.50.0.1', 'netstat -an', 'systeminfo', 'tasklist'];

function Console({ session, pending, lines, setLines }) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([]);
  const [hIdx, setHIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const full = Boolean(session.info?.fullShell);
  const cwd = [...lines].reverse().find((l) => l.cwd)?.cwd;

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [lines]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const run = (cmd) => {
    const command = cmd.trim();
    if (!command || busy) return;
    const localReason = full ? null : checkAllowlistedCommand(command);
    setLines((l) => [...l, { kind: 'cmd', text: command }]);
    setHistory((h) => [command, ...h.filter((x) => x !== command)].slice(0, 50));
    setHIdx(-1);
    setInput('');
    if (localReason) {
      setLines((l) => [...l, { kind: 'err', text: `Blocked: ${localReason}` }]);
      return;
    }
    const commandId = randomId(12);
    setBusy(true);
    pending.current.set(commandId, (p) => {
      setBusy(false);
      setLines((l) => [
        ...l,
        ...(p.stdout ? [{ kind: 'out', text: p.stdout.replace(/\s+$/, '') }] : []),
        ...(p.stderr ? [{ kind: 'err', text: p.stderr.replace(/\s+$/, '') }] : []),
        { kind: 'meta', text: p.blocked ? 'blocked by policy' : `exit ${p.exitCode}`, cwd: p.cwd },
      ]);
    });
    session.sendJson(MessageType.COMMAND_REQUEST, { commandId, command });
  };

  const onKey = (e) => {
    if (e.key === 'Enter') run(input);
    else if (e.key === 'ArrowUp') { e.preventDefault(); const i = Math.min(hIdx + 1, history.length - 1); setHIdx(i); setInput(history[i] || ''); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); const i = Math.max(hIdx - 1, -1); setHIdx(i); setInput(i === -1 ? '' : history[i]); }
    else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); setLines([]); }
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {!full && <span className="text-muted">Restricted mode — allowed commands:</span>}
        {full && <span className="font-medium text-danger">Full shell — every command is audited.</span>}
        {QUICK.map((q) => <button key={q} className="mono rounded-md border border-line bg-surface px-2 py-0.5 text-[11.5px] hover:border-accent/50" onClick={() => run(q)}>{q}</button>)}
        <button className="btn btn-ghost ml-auto h-7 text-[12px]" onClick={() => setLines([])}><Trash2 size={13} /> Clear</button>
      </div>
      <div className="theme-deep flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-card)] border border-line bg-brand-2" onClick={() => inputRef.current?.focus()}>
        <div className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed">
          <div className="text-muted">NexLink remote terminal — {session.info?.hostname}. {full ? 'Full shell.' : `Allowed: ${TERMINAL_ALLOWLIST.slice(0, 14).join(', ')}…`}</div>
          {lines.map((l, i) => (
            <pre key={i} className={`whitespace-pre-wrap break-words ${l.kind === 'cmd' ? 'mt-2 text-accent' : l.kind === 'err' ? 'text-danger' : l.kind === 'meta' ? 'text-[11px] text-muted' : 'text-ink-2'}`}>
              {l.kind === 'cmd' ? `${cwd ? `${cwd}` : ''}> ${l.text}` : l.text}
            </pre>
          ))}
          {busy && <div className="mt-1 flex items-center gap-2 text-muted"><Spinner size={12} /> running…</div>}
          <div ref={endRef} />
        </div>
        <div className="flex items-center gap-2 border-t border-line px-3 py-2">
          <span className="font-mono text-[12.5px] text-accent">&gt;</span>
          <input
            ref={inputRef}
            className="flex-1 bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:text-muted"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={full ? 'Type any command' : 'e.g. ipconfig /all'}
            spellCheck={false}
            autoComplete="off"
          />
          <button className="btn btn-ghost h-7 px-2" onClick={() => run(input)} disabled={busy}><CornerDownLeft size={14} /></button>
        </div>
      </div>
    </div>
  );
}

export default function Terminal() {
  const pending = useRef(new Map());
  const [lines, setLines] = useState([]);
  const [fullShell, setFullShell] = useState(false);
  const onMessage = useCallback((msg) => {
    if (msg.type !== MessageType.COMMAND_RESPONSE) return;
    const cb = pending.current.get(msg.payload.commandId);
    if (cb) { pending.current.delete(msg.payload.commandId); cb(msg.payload); }
  }, []);
  const session = useRemoteSession('terminal', { onMessage, onReady: () => setLines([]) });

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader icon={SquareTerminal} eyebrow="Remote" title="Terminal" subtitle="Run commands on a device. Users get a safe allowlist of network tools; admins can open a full shell after confirming." />
      <div className="min-h-0 flex-1">
        <SessionGate kind="terminal" session={session} capability="terminal" allowFullShell fullShell={fullShell} setFullShell={setFullShell}>
          <Console session={session} pending={pending} lines={lines} setLines={setLines} />
        </SessionGate>
      </div>
    </div>
  );
}
