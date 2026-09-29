import { create } from 'zustand';
import { api, ApiError } from '../services/api.js';
import { platform } from '../services/platform.js';

/**
 * Auth lifecycle:
 *   booting → offline            (server unreachable)
 *           → setup              (no accounts yet: create the first admin)
 *           → authenticated      (stored token still valid)
 *           → login              (sign in / register / Google)
 *   pending                      (account created, waiting for admin approval)
 */
const GOOGLE_POLL_MS = 1500;
const GOOGLE_TIMEOUT_MS = 5 * 60_000;

export const useAuth = create((set, get) => ({
  phase: 'booting',
  user: null,
  token: null,
  serverUrl: '',
  providers: { password: true, google: false, registration: true },
  error: null,
  notice: null,
  google: null, // { status: 'waiting' } while the browser flow runs

  async boot() {
    set({ phase: 'booting', error: null });
    const serverUrl = await platform.getServerUrl();
    api.configure({ serverUrl, unauthorizedHandler: () => get().expire() });
    set({ serverUrl });

    try {
      // A server hosted by this app may still be starting: give it a few seconds.
      let status;
      for (let attempt = 0; ; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          status = await api.get('/api/auth/status', { auth: false, timeoutMs: 5000 });
          break;
        } catch (err) {
          if (attempt >= 4 || !(err instanceof ApiError) || err.code !== 'UNREACHABLE') throw err;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      set({ providers: status.providers || get().providers });
      if (status.setupRequired) return set({ phase: 'setup' });

      const saved = await platform.loadToken();
      if (saved) {
        api.configure({ authToken: saved });
        try {
          const { user } = await api.get('/api/auth/me');
          return set({ phase: 'authenticated', user, token: saved });
        } catch {
          await platform.clearToken();
          api.configure({ authToken: null });
        }
      }
      set({ phase: 'login' });
    } catch (err) {
      set({ phase: 'offline', error: err instanceof ApiError ? err.message : 'Unexpected error.' });
    }
  },

  async changeServer(url) {
    const serverUrl = await platform.setServerUrl(url);
    set({ serverUrl });
    await get().boot();
  },

  async login(username, password) {
    try {
      const res = await api.post('/api/auth/login', { username, password }, { auth: false });
      await get().acceptSession(res);
    } catch (err) {
      if (err.code === 'PENDING_APPROVAL') return set({ phase: 'pending', notice: err.message });
      throw err;
    }
  },

  async register({ email, displayName, password }) {
    await api.post('/api/auth/register', { email, displayName, password }, { auth: false });
    set({ phase: 'pending', notice: 'Your account was created. An administrator must approve it before you can sign in.' });
  },

  async setup({ username, email, displayName, password }) {
    const res = await api.post('/api/auth/setup', { username, email: email || undefined, displayName, password }, { auth: false });
    await get().acceptSession(res);
  },

  /** Google sign-in. Desktop: loopback redirect on this PC. Browser build: server callback + polling. */
  async loginWithGoogle() {
    set({ google: { status: 'starting' }, error: null });
    const loop = platform.googleLoopback;
    if (loop) {
      try {
        const port = await loop.listen();
        const start = await api.post('/api/auth/google/start', { loopbackPort: port }, { auth: false });
        await platform.openAuthUrl(start.authUrl);
        set({ google: { status: 'waiting' } });
        const cb = await loop.wait();
        if (!get().google) return undefined; // cancelled
        if (cb.error || !cb.code) {
          set({ google: null });
          throw new ApiError(cb.error === 'access_denied' ? 'Google sign-in was cancelled.' : cb.error === 'timeout' ? 'Google sign-in timed out.' : 'Google sign-in failed.', { code: 'GOOGLE' });
        }
        const res = await api.post('/api/auth/google/exchange', { code: cb.code, state: cb.state }, { auth: false, timeoutMs: 20_000 });
        set({ google: null });
        if (res.status === 'ok') return get().acceptSession(res);
        if (res.status === 'pending') return set({ phase: 'pending', notice: res.message });
        throw new ApiError(res.message || 'Access denied.', { code: 'GOOGLE' });
      } catch (err) {
        set({ google: null });
        throw err;
      }
    }
    let pollId;
    try {
      const start = await api.post('/api/auth/google/start', {}, { auth: false });
      pollId = start.pollId;
      await platform.openAuthUrl(start.authUrl);
    } catch (err) {
      set({ google: null });
      throw err;
    }
    set({ google: { status: 'waiting' } });

    const deadline = Date.now() + GOOGLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, GOOGLE_POLL_MS));
      if (!get().google) return undefined; // cancelled
      let res;
      try {
        // eslint-disable-next-line no-await-in-loop
        res = await api.get(`/api/auth/google/poll/${encodeURIComponent(pollId)}`, { auth: false });
      } catch {
        continue;
      }
      if (res.status === 'waiting') continue;
      set({ google: null });
      if (res.status === 'ok') return get().acceptSession(res);
      if (res.status === 'pending') return set({ phase: 'pending', notice: res.message || 'Your account is waiting for approval.' });
      if (res.status === 'expired') throw new ApiError('The Google sign-in expired. Try again.', { code: 'EXPIRED' });
      throw new ApiError(res.message || 'Google sign-in failed.', { code: 'GOOGLE' });
    }
    set({ google: null });
    throw new ApiError('Google sign-in timed out. Try again.', { code: 'TIMEOUT' });
  },

  cancelGoogle() {
    platform.googleLoopback?.cancel();
    set({ google: null });
  },

  backToLogin() {
    set({ phase: 'login', notice: null, error: null });
  },

  async acceptSession({ token, user }) {
    api.configure({ authToken: token });
    await platform.saveToken(token);
    set({ phase: 'authenticated', user, token, error: null, notice: null });
  },

  setUser(user) {
    set({ user });
  },

  async logout() {
    set({ phase: 'signing_out' }); // so the socket's 4003 close isn't reported as an expiry
    try { await api.post('/api/auth/logout'); } catch { /* session may already be gone */ }
    await get().clearLocal();
    set({ phase: 'login', error: null });
  },

  /** Called when the server rejects our token (expired, revoked, disabled). */
  async expire() {
    if (get().phase !== 'authenticated') return;
    await get().clearLocal();
    set({ phase: 'login', error: 'Your session ended. Please sign in again.' });
  },

  async clearLocal() {
    api.configure({ authToken: null });
    await platform.clearToken();
    set({ user: null, token: null });
  },
}));

export const useIsAdmin = () => useAuth((s) => s.user?.role === 'admin');
