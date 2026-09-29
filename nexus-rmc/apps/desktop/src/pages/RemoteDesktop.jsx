import { useCallback, useEffect, useRef, useState } from 'react';
import { ScreenShare, Maximize2, Camera, Gauge as GaugeIcon } from 'lucide-react';
import { MessageType, BinaryKind } from '@nexus/protocol';
import { useRemoteSession } from '../services/remoteSession.js';
import SessionGate from '../components/SessionGate.jsx';
import { PageHeader } from '../components/Primitives.jsx';
import { Tabs } from '../components/ui.jsx';

/**
 * Remote desktop viewer: JPEG frames arrive as binary messages (kind 1) and
 * are drawn on a canvas; mouse and keyboard go back as REMOTE_INPUT with
 * coordinates normalised to 0..1 so the agent maps them to its own screen.
 */
function Viewer({ session, frameRef }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [fps, setFps] = useState(0);
  const [kbps, setKbps] = useState(0);
  const [quality, setQuality] = useState('auto');
  const stats = useRef({ frames: 0, bytes: 0 });
  const lastMove = useRef(0);

  useEffect(() => {
    frameRef.current = async (data) => {
      stats.current.frames += 1;
      stats.current.bytes += data.byteLength;
      const blob = new Blob([data.subarray(1)], { type: 'image/jpeg' });
      try {
        const bmp = await createImageBitmap(blob);
        const c = canvasRef.current;
        if (!c) return;
        if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
        c.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
      } catch { /* corrupt frame */ }
    };
    const t = setInterval(() => {
      setFps(stats.current.frames);
      setKbps(Math.round((stats.current.bytes * 8) / 1000));
      stats.current = { frames: 0, bytes: 0 };
    }, 1000);
    return () => { clearInterval(t); frameRef.current = null; };
  }, [frameRef]);

  const pos = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const send = (payload) => session.sendJson(MessageType.REMOTE_INPUT, payload);

  const onMove = (e) => {
    const now = performance.now();
    if (now - lastMove.current < 40) return; // ~25 moves/s is plenty
    lastMove.current = now;
    send({ type: 'move', ...pos(e) });
  };
  const onKey = (type) => (e) => {
    e.preventDefault();
    send({ type, key: e.key });
  };
  const setQ = (q) => {
    setQuality(q);
    send({ type: 'quality', value: q === 'low' ? 35 : q === 'high' ? 85 : 60 });
  };
  const screenshot = () => {
    const a = document.createElement('a');
    a.href = canvasRef.current.toDataURL('image/png');
    a.download = `${session.info?.hostname || 'remote'}-${Date.now()}.png`;
    a.click();
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        <Tabs value={quality} onChange={setQ} items={[{ id: 'low', label: 'Low' }, { id: 'auto', label: 'Balanced' }, { id: 'high', label: 'High' }]} />
        <span className="mono flex items-center gap-1.5 text-muted"><GaugeIcon size={13} /> {fps} fps · {kbps} kbps</span>
        <span className="text-muted">Click the screen to type into it.</span>
        <div className="ml-auto flex gap-2">
          <button className="btn btn-outline h-8" onClick={screenshot}><Camera size={14} /> Screenshot</button>
          <button className="btn btn-outline h-8" onClick={() => wrapRef.current?.requestFullscreen()}><Maximize2 size={14} /> Full screen</button>
        </div>
      </div>
      <div ref={wrapRef} className="theme-deep flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[var(--radius-card)] border border-line bg-brand-2">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className="max-h-full max-w-full cursor-crosshair outline-none focus:ring-2 focus:ring-accent"
          onMouseMove={onMove}
          onMouseDown={(e) => { canvasRef.current.focus(); send({ type: 'down', button: e.button, ...pos(e) }); }}
          onMouseUp={(e) => send({ type: 'up', button: e.button, ...pos(e) })}
          onWheel={(e) => send({ type: 'wheel', dy: e.deltaY })}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={onKey('keydown')}
          onKeyUp={onKey('keyup')}
        />
      </div>
    </div>
  );
}

export default function RemoteDesktop() {
  const frameRef = useRef(null);
  const onBinary = useCallback((data) => {
    if (data[0] === BinaryKind.SCREEN) frameRef.current?.(data);
  }, []);
  const session = useRemoteSession('desktop', { onBinary });

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader icon={ScreenShare} eyebrow="Remote" title="Remote Desktop" subtitle="View and control a device's screen over the encrypted network. The user on that device sees a banner and can disconnect you." />
      <div className="min-h-0 flex-1">
        <SessionGate kind="desktop" session={session} capability="screen">
          <Viewer session={session} frameRef={frameRef} />
        </SessionGate>
      </div>
    </div>
  );
}
