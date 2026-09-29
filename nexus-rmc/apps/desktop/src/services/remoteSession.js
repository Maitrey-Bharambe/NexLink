import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageType, createMessage, encode, decode } from '@nexus/protocol';
import { api } from './api.js';
import { useAuth } from '../stores/auth.js';
import { useNetwork } from '../stores/network.js';

/**
 * Remote session lifecycle for one page (desktop / files / terminal):
 *   idle → requesting → requested (user waits for admin) → connecting → active → ended
 * The session socket authenticates with the user's JWT plus a single-use
 * session token; frames are relayed by the hub to the device's agent.
 */
export function useRemoteSession(kind, { onBinary, onMessage, onReady } = {}) {
  const token = useAuth((s) => s.token);
  const serverUrl = useAuth((s) => s.serverUrl);
  const sessionsVersion = useNetwork((s) => s.versions.sessions);
  const [state, setState] = useState({ phase: 'idle', session: null, error: null, endReason: null, info: null });
  const wsRef = useRef(null);
  const handlers = useRef({ onBinary, onMessage, onReady });
  handlers.current = { onBinary, onMessage, onReady };

  const openSocket = useCallback(async (session) => {
    setState((s) => ({ ...s, phase: 'connecting', session, error: null }));
    let conn;
    try {
      conn = await api.post(`/api/sessions/${session.sessionId}/connect`, {});
    } catch (err) {
      setState((s) => ({ ...s, phase: 'error', error: err.message }));
      return;
    }
    const url = `${serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws/session`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    ws.onopen = () => ws.send(encode(createMessage(MessageType.AUTH_REQUEST, {
      token, sessionId: session.sessionId, sessionToken: conn.sessionToken,
    })));
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        handlers.current.onBinary?.(new Uint8Array(e.data));
        return;
      }
      const res = decode(e.data);
      if (!res.ok) return;
      const msg = res.message;
      if (msg.type === MessageType.SESSION_READY) {
        setState((s) => ({ ...s, phase: 'active', info: msg.payload }));
        handlers.current.onReady?.(msg.payload);
      } else if (msg.type === MessageType.SESSION_END) {
        setState((s) => ({ ...s, phase: 'ended', endReason: msg.payload.reason }));
      } else if (msg.type === MessageType.ERROR) {
        setState((s) => ({ ...s, phase: 'error', error: msg.payload.reason }));
      } else {
        handlers.current.onMessage?.(msg);
      }
    };
    ws.onclose = () => {
      setState((s) => (s.phase === 'active' || s.phase === 'connecting'
        ? { ...s, phase: 'ended', endReason: s.endReason || 'Connection closed' }
        : s));
    };
  }, [serverUrl, token]);

  const start = useCallback(async ({ deviceId, reason, fullShell }) => {
    setState({ phase: 'requesting', session: null, error: null, endReason: null, info: null });
    try {
      const { session } = await api.post('/api/sessions', { deviceId, kind, reason: reason || undefined, fullShell });
      if (session.status === 'requested') setState((s) => ({ ...s, phase: 'requested', session }));
      else await openSocket(session);
    } catch (err) {
      setState((s) => ({ ...s, phase: 'error', error: err.message }));
    }
  }, [kind, openSocket]);

  // While waiting for approval, re-check whenever the server says sessions changed.
  useEffect(() => {
    if (state.phase !== 'requested' || !state.session) return;
    api.get(`/api/sessions?status=approved,denied,expired&limit=20`).then(({ sessions }) => {
      const mine = sessions.find((x) => x.sessionId === state.session.sessionId);
      if (!mine) return;
      if (mine.status === 'approved') openSocket(mine);
      else setState((s) => ({ ...s, phase: 'ended', endReason: mine.endReason || `Request ${mine.status}` }));
    }).catch(() => {});
  }, [sessionsVersion, state.phase, state.session, openSocket]);

  /** Connect to an already-approved session (e.g. opened from My Sessions). */
  const resume = useCallback(async (sessionId) => {
    try {
      const { sessions } = await api.get('/api/sessions?status=approved,requested&limit=100');
      const s = sessions.find((x) => x.sessionId === sessionId);
      if (!s) return false;
      if (s.status === 'requested') setState((st) => ({ ...st, phase: 'requested', session: s }));
      else await openSocket(s);
      return true;
    } catch {
      return false;
    }
  }, [openSocket]);

  const sendJson = useCallback((type, payload) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(encode(createMessage(type, payload, { sessionId: state.session?.sessionId })));
  }, [state.session]);

  const sendBinary = useCallback((buf) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(buf);
  }, []);

  const bufferedAmount = () => wsRef.current?.bufferedAmount || 0;

  const end = useCallback(async () => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(encode(createMessage(MessageType.SESSION_END, {})));
    if (state.session && ['requested', 'connecting'].includes(state.phase)) {
      await api.post(`/api/sessions/${state.session.sessionId}/end`, {}).catch(() => {});
    }
    ws?.close();
    setState((s) => ({ ...s, phase: 'ended', endReason: 'Ended by you' }));
  }, [state.session, state.phase]);

  const reset = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setState({ phase: 'idle', session: null, error: null, endReason: null, info: null });
  }, []);

  useEffect(() => () => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(encode(createMessage(MessageType.SESSION_END, {})));
    ws?.close();
  }, []);

  return { ...state, start, resume, end, reset, sendJson, sendBinary, bufferedAmount };
}
