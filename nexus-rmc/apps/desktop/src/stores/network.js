import { create } from 'zustand';
import { ConnectionStatus, MessageType, NETWORK } from '@nexus/protocol';
import { toast } from './toasts.js';

const RTT_HISTORY = 60;
const AUDIT_FEED = 50;
const EMPTY_COUNTS = { alerts: {}, pendingDevices: 0, pendingUsers: 0, sessionRequests: 0, activeSessions: 0, mySessions: 0 };

/**
 * Live network state, fed by the console socket. Components subscribe to
 * narrow slices so one update does not re-render the whole app.
 * `versions` bump when the server signals a change, so pages can refetch.
 */
export const useNetwork = create((set, get) => ({
  wsStatus: ConnectionStatus.DISCONNECTED,
  retryInMs: null,
  rttMs: null,
  rttHistory: [],
  network: NETWORK,
  vpn: { state: 'SIMULATED', mode: 'simulated' },
  devices: [],
  counts: EMPTY_COUNTS,
  snapshotAt: null,
  auditFeed: [],
  versions: { sessions: 0, users: 0, enrollment: 0, alerts: 0, device: {} },

  setStatus: (wsStatus, meta = {}) =>
    set((s) => (s.wsStatus === wsStatus && !meta.retryInMs ? s : { wsStatus, retryInMs: meta.retryInMs ?? null })),

  pushRtt: (ms) =>
    set((s) => ({ rttMs: ms, rttHistory: [...s.rttHistory.slice(-(RTT_HISTORY - 1)), { t: Date.now(), ms }] })),

  bump(key, id) {
    set((s) => {
      if (key === 'device') return { versions: { ...s.versions, device: { ...s.versions.device, [id]: (s.versions.device[id] || 0) + 1 } } };
      return { versions: { ...s.versions, [key]: s.versions[key] + 1 } };
    });
  },

  handleMessage: (msg) => {
    if (msg.type === MessageType.STATE_SNAPSHOT) {
      set({
        network: msg.payload.network || NETWORK,
        vpn: msg.payload.vpn || { state: 'SIMULATED' },
        devices: msg.payload.devices || [],
        counts: { ...EMPTY_COUNTS, ...(msg.payload.counts || {}) },
        snapshotAt: Date.now(),
      });
      return;
    }
    if (msg.type !== MessageType.EVENT) return;
    const p = msg.payload;
    const { bump } = get();
    switch (p.kind) {
      case 'audit':
        set((s) => ({ auditFeed: [p.entry, ...s.auditFeed].slice(0, AUDIT_FEED) }));
        break;
      case 'alert':
        bump('alerts');
        toast({
          tone: p.alert.severity === 'critical' ? 'danger' : 'warn',
          title: p.alert.severity === 'critical' ? 'Critical alert' : 'Alert',
          message: p.alert.message,
          to: '/alerts',
        });
        break;
      case 'alerts': bump('alerts'); break;
      case 'sessions': bump('sessions'); break;
      case 'users': bump('users'); break;
      case 'enrollment': bump('enrollment'); break;
      case 'device': bump('device', p.deviceId); break;
      case 'session.decided':
        bump('sessions');
        toast({
          tone: p.session.status === 'approved' ? 'success' : 'warn',
          title: p.session.status === 'approved' ? 'Session approved' : 'Session denied',
          message: `Your ${p.session.kind} session on ${p.session.hostname} was ${p.session.status} by ${p.session.decidedBy}.`,
          to: '/sessions',
        });
        break;
      default:
    }
  },

  reset: () => set({
    wsStatus: ConnectionStatus.DISCONNECTED, rttMs: null, rttHistory: [], devices: [], auditFeed: [], snapshotAt: null, counts: EMPTY_COUNTS,
  }),
}));

export const deviceName = (d) => d?.label || d?.hostname || '—';
