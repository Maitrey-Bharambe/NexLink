import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FolderTree, Folder, File, ArrowUp, RefreshCw, Upload, Download, FolderPlus, Pencil, Trash2, HardDrive, ChevronRight, ShieldCheck,
} from 'lucide-react';
import { MessageType, BinaryKind } from '@nexus/protocol';
import { useRemoteSession } from '../services/remoteSession.js';
import SessionGate from '../components/SessionGate.jsx';
import { PageHeader, Spinner, ErrorBanner } from '../components/Primitives.jsx';
import { Modal, Field, useConfirm } from '../components/ui.jsx';
import { toast } from '../stores/toasts.js';
import { bytes, dateTime, randomId } from '../utils/format.js';

const CHUNK = 256 * 1024;
const MAX_UPLOAD = 500 * 1024 * 1024;

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

function Browser({ session, bus }) {
  const [listing, setListing] = useState(null);
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [transfer, setTransfer] = useState(null); // { name, done, total, dir }
  const [prompt, setPrompt] = useState(null); // { kind: 'mkdir'|'rename', value, entry? }
  const fileInput = useRef(null);
  const [confirm, dialog] = useConfirm();

  const request = useCallback((payload, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const requestId = randomId(12);
    const timer = setTimeout(() => { bus.current.pending.delete(requestId); reject(new Error('The device did not answer in time.')); }, timeoutMs);
    bus.current.pending.set(requestId, (p) => { clearTimeout(timer); resolve(p); });
    session.sendJson(MessageType.FILE_REQUEST, { ...payload, requestId });
  }), [session, bus]);

  const open = useCallback(async (p) => {
    setLoading(true);
    setError(null);
    try {
      const res = await request({ op: 'list', path: p });
      if (!res.ok) throw new Error(res.error);
      setListing(res.data);
      setPath(res.data.path);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => { open(''); }, [open]);

  const join = (name) => {
    if (!path) return name; // drives or shared root
    const sep = path.includes('\\') || /^[A-Za-z]:/.test(path) ? '\\' : '/';
    return path.endsWith(sep) ? `${path}${name}` : `${path}${sep}${name}`;
  };

  const download = async (entry) => {
    const transferId = randomId(16);
    const chunks = [];
    bus.current.downloads.set(transferId, chunks);
    setTransfer({ name: entry.name, done: 0, total: entry.size || 0, dir: 'down' });
    bus.current.onProgress = (n) => setTransfer((t) => (t ? { ...t, done: t.done + n } : t));
    try {
      const res = await request({ op: 'download', path: join(entry.name), transferId }, 10 * 60_000);
      if (!res.ok) throw new Error(res.error);
      const blob = new Blob(chunks);
      const digest = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
      if (digest !== res.sha256) throw new Error('Checksum mismatch — the download was discarded.');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = entry.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      toast({ tone: 'success', title: 'Downloaded', message: `${entry.name} (${bytes(res.size)}) — SHA-256 verified.` });
    } catch (err) {
      toast({ tone: 'danger', title: 'Download failed', message: err.message });
    } finally {
      bus.current.downloads.delete(transferId);
      setTransfer(null);
    }
  };

  const upload = async (file) => {
    if (!file) return;
    if (file.size > MAX_UPLOAD) return toast({ tone: 'warn', title: 'File too large', message: 'Uploads are limited to 500 MB.' });
    const transferId = randomId(16);
    const tid = new TextEncoder().encode(transferId);
    setTransfer({ name: file.name, done: 0, total: file.size, dir: 'up' });
    try {
      const start = await request({ op: 'upload_start', path, name: file.name, size: file.size, transferId });
      if (!start.ok) throw new Error(start.error);
      const whole = await file.arrayBuffer();
      for (let off = 0; off < file.size; off += CHUNK) {
        while (session.bufferedAmount() > 4 * CHUNK) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 30));
        }
        const chunk = new Uint8Array(whole, off, Math.min(CHUNK, file.size - off));
        const frame = new Uint8Array(1 + 16 + chunk.length);
        frame[0] = BinaryKind.FILE;
        frame.set(tid, 1);
        frame.set(chunk, 17);
        session.sendBinary(frame);
        setTransfer((t) => ({ ...t, done: Math.min(file.size, off + chunk.length) }));
      }
      const sha256 = hex(await crypto.subtle.digest('SHA-256', whole));
      const res = await request({ op: 'upload_end', transferId, sha256 }, 120_000);
      if (!res.ok) throw new Error(res.error);
      toast({ tone: 'success', title: 'Uploaded', message: `${file.name} — SHA-256 verified on the device.` });
      open(path);
    } catch (err) {
      toast({ tone: 'danger', title: 'Upload failed', message: err.message });
    } finally {
      setTransfer(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const remove = async (entry) => {
    if (!(await confirm({ title: `Delete ${entry.name}?`, message: entry.dir ? 'The folder and everything in it will be deleted on the remote device.' : 'The file will be deleted on the remote device.', confirmLabel: 'Delete', danger: true }))) return;
    const res = await request({ op: 'delete', path: join(entry.name) });
    if (!res.ok) toast({ tone: 'danger', title: 'Could not delete', message: res.error });
    open(path);
  };

  const submitPrompt = async () => {
    const { kind, value, entry } = prompt;
    setPrompt(null);
    const res = kind === 'mkdir'
      ? await request({ op: 'mkdir', path, name: value })
      : await request({ op: 'rename', path: join(entry.name), name: value });
    if (!res.ok) toast({ tone: 'danger', title: 'Failed', message: res.error });
    open(path);
  };

  const crumbs = (() => {
    if (!listing) return [];
    if (listing.root) {
      const parts = path ? path.split('/') : [];
      return [{ label: listing.root, path: '' }, ...parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join('/') }))];
    }
    return [{ label: 'This PC', path: '' }, ...(path ? [{ label: path, path }] : [])];
  })();

  return (
    <div className="card flex h-full min-h-[480px] flex-col overflow-hidden">
      {dialog}
      <Modal open={Boolean(prompt)} onClose={() => setPrompt(null)} width={420} title={prompt?.kind === 'mkdir' ? 'New folder' : `Rename ${prompt?.entry?.name}`}
        footer={<><button className="btn btn-outline" onClick={() => setPrompt(null)}>Cancel</button><button className="btn btn-primary" onClick={submitPrompt} disabled={!prompt?.value}>Save</button></>}>
        <Field label="Name"><input className="input" value={prompt?.value || ''} onChange={(e) => setPrompt({ ...prompt, value: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && submitPrompt()} /></Field>
      </Modal>

      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <button className="btn btn-ghost h-8 w-8 px-0" disabled={listing?.parent == null} onClick={() => open(listing.parent)} title="Up"><ArrowUp size={15} /></button>
        <button className="btn btn-ghost h-8 w-8 px-0" onClick={() => open(path)} title="Refresh"><RefreshCw size={14} /></button>
        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-[12.5px]">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-1 whitespace-nowrap">
              {i > 0 && <ChevronRight size={13} className="text-muted" />}
              <button className="rounded px-1.5 py-0.5 hover:bg-raised" onClick={() => open(c.path)}>{c.label}</button>
            </span>
          ))}
        </nav>
        <button className="btn btn-outline h-8" disabled={!path && !listing?.root} onClick={() => setPrompt({ kind: 'mkdir', value: '' })}><FolderPlus size={14} /> New folder</button>
        <button className="btn btn-primary h-8" disabled={Boolean(transfer) || (!path && !listing?.root)} onClick={() => fileInput.current?.click()}><Upload size={14} /> Upload</button>
        <input ref={fileInput} type="file" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
      </div>

      {listing?.root && (
        <div className="flex items-center gap-2 border-b border-line bg-accent/8 px-4 py-1.5 text-[11.5px] text-accent-ink">
          <ShieldCheck size={13} /> Restricted to the device's shared folder ({listing.root}). Administrators can browse the whole disk.
        </div>
      )}
      {transfer && (
        <div className="border-b border-line px-4 py-2 text-[12px]">
          <div className="mb-1 flex justify-between"><span>{transfer.dir === 'up' ? 'Uploading' : 'Downloading'} <b>{transfer.name}</b></span><span className="mono">{bytes(transfer.done)} / {bytes(transfer.total)}</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${transfer.total ? (transfer.done / transfer.total) * 100 : 50}%` }} /></div>
        </div>
      )}
      {error && <div className="p-3"><ErrorBanner onRetry={() => open(path)}>{error}</ErrorBanner></div>}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !listing ? <div className="flex justify-center p-10"><Spinner /></div> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Size</th><th>Modified</th><th className="text-right">Actions</th></tr></thead>
            <tbody>
              {(listing?.entries || []).map((e) => (
                <tr key={e.name} className={e.dir ? 'cursor-pointer' : ''} onDoubleClick={() => e.dir && open(join(e.name))}>
                  <td>
                    <button className="flex items-center gap-2.5 text-left font-medium hover:text-accent-ink" onClick={() => e.dir && open(join(e.name))}>
                      {!path && !listing.root ? <HardDrive size={15} className="text-muted" /> : e.dir ? <Folder size={15} className="text-gold" /> : <File size={15} className="text-muted" />}
                      {e.name}
                    </button>
                  </td>
                  <td className="mono text-muted">{e.dir ? '—' : bytes(e.size)}</td>
                  <td className="text-muted">{e.mtime ? dateTime(e.mtime) : '—'}</td>
                  <td className="text-right">
                    {(path || listing.root) && (
                      <span className="inline-flex gap-1">
                        {!e.dir && <button className="btn btn-ghost h-7 w-7 px-0" title="Download" disabled={Boolean(transfer)} onClick={() => download(e)}><Download size={14} /></button>}
                        <button className="btn btn-ghost h-7 w-7 px-0" title="Rename" onClick={() => setPrompt({ kind: 'rename', value: e.name, entry: e })}><Pencil size={13} /></button>
                        <button className="btn btn-ghost h-7 w-7 px-0 text-danger hover:bg-danger/10" title="Delete" onClick={() => remove(e)}><Trash2 size={13} /></button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {listing && !listing.entries.length && <p className="p-10 text-center text-[12.5px] text-muted">This folder is empty.</p>}
      </div>
    </div>
  );
}

export default function FileManager() {
  const bus = useRef({ pending: new Map(), downloads: new Map(), onProgress: null });
  const onMessage = useCallback((msg) => {
    if (msg.type !== MessageType.FILE_RESPONSE) return;
    const p = msg.payload;
    if (p.op === 'download_start') return;
    const resolve = bus.current.pending.get(p.requestId);
    if (resolve) { bus.current.pending.delete(p.requestId); resolve(p); }
  }, []);
  const onBinary = useCallback((data) => {
    if (data[0] !== BinaryKind.FILE) return;
    const tid = new TextDecoder().decode(data.subarray(1, 17));
    const chunks = bus.current.downloads.get(tid);
    if (!chunks) return;
    const chunk = data.slice(17);
    chunks.push(chunk);
    bus.current.onProgress?.(chunk.length);
  }, []);
  const session = useRemoteSession('files', { onMessage, onBinary });

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader icon={FolderTree} eyebrow="Remote" title="File Manager" subtitle="Browse, upload and download files on a device. Transfers are chunked and verified with SHA-256." />
      <div className="min-h-0 flex-1">
        <SessionGate kind="files" session={session} capability="files">
          <Browser session={session} bus={bus} />
        </SessionGate>
      </div>
    </div>
  );
}
