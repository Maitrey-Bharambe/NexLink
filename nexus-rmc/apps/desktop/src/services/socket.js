import {
  MessageType, ConnectionStatus, createMessage, encode, decode,
} from '@nexus/protocol';

/**
 * Real-time console channel (/ws/console).
 *
 * - Authenticates with AUTH_REQUEST as the first frame.
 * - Measures application-level RTT with PING/PONG every 5 s.
 * - Reconnects with exponential backoff + jitter (1 s → 30 s cap).
 * - Stops reconnecting on UNAUTHORIZED (4003) and reports it.
 */
const PING_INTERVAL_MS = 5000;
const PONG_TIMEOUT_MS = 4000;

export function createConsoleSocket({ serverUrl, token, onStatus, onMessage, onRtt, onUnauthorized }) {
  let ws = null;
  let attempt = 0;
  let stopped = false;
  let pingTimer = null;
  let reconnectTimer = null;
  let seq = 0;
  const pending = new Map(); // seq -> sentAt

  const wsUrl = serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws/console';

  function connect() {
    if (stopped) return;
    onStatus(attempt === 0 ? ConnectionStatus.CONNECTING : ConnectionStatus.RECONNECTING);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(encode(createMessage(MessageType.AUTH_REQUEST, { token })));
    };

    ws.onmessage = (event) => {
      const res = decode(event.data);
      if (!res.ok) return;
      const msg = res.message;

      if (msg.type === MessageType.AUTH_RESPONSE) {
        if (msg.payload.ok) {
          attempt = 0;
          onStatus(ConnectionStatus.CONNECTED);
          startPing();
        }
        return;
      }
      if (msg.type === MessageType.PONG) {
        const sentAt = pending.get(msg.payload.seq);
        if (sentAt != null) {
          pending.delete(msg.payload.seq);
          onRtt(Math.round(performance.now() - sentAt));
          onStatus(ConnectionStatus.CONNECTED); // recovers from DEGRADED
        }
        return;
      }
      onMessage(msg);
    };

    ws.onclose = (event) => {
      stopPing();
      if (stopped) return;
      if (event.code === 4003 || event.code === 4001) {
        stopped = true;
        onStatus(ConnectionStatus.UNAUTHORIZED);
        onUnauthorized?.();
        return;
      }
      scheduleReconnect();
    };

    ws.onerror = () => { /* onclose follows and handles reconnect */ };
  }

  function scheduleReconnect() {
    attempt += 1;
    const base = Math.min(30_000, 1000 * 2 ** (attempt - 1));
    const delay = base / 2 + Math.random() * (base / 2);
    onStatus(ConnectionStatus.RECONNECTING, { retryInMs: Math.round(delay), attempt });
    reconnectTimer = setTimeout(connect, delay);
  }

  function startPing() {
    stopPing();
    const tick = () => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      seq += 1;
      const s = seq;
      pending.set(s, performance.now());
      ws.send(encode(createMessage(MessageType.PING, { seq: s, t0: Date.now() })));
      setTimeout(() => {
        if (pending.has(s)) {
          pending.delete(s);
          onStatus(ConnectionStatus.DEGRADED);
        }
      }, PONG_TIMEOUT_MS);
    };
    tick();
    pingTimer = setInterval(tick, PING_INTERVAL_MS);
  }

  function stopPing() {
    clearInterval(pingTimer);
    pingTimer = null;
    pending.clear();
  }

  connect();

  return {
    close() {
      stopped = true;
      clearTimeout(reconnectTimer);
      stopPing();
      ws?.close(1000, 'client closing');
    },
  };
}
