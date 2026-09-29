/**
 * Thin wrapper over the preload bridge (window.nexus).
 * When the UI runs in a plain browser (`npm run dev:web`), it falls back to
 * safe defaults: the server URL is kept in localStorage and the session token
 * in memory only.
 */
const bridge = typeof window !== 'undefined' ? window.nexus : undefined;
const FALLBACK_URL = 'http://localhost:4000';

const safeLocal = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, v) { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } },
};

export const platform = {
  isDesktop: Boolean(bridge?.isDesktop),

  async appInfo() {
    if (bridge) return bridge.appInfo();
    return { version: 'dev', platform: 'browser', secureStorage: false };
  },

  /** Open Google's sign-in page in the system browser (validated in the main process). */
  async openAuthUrl(url) {
    if (bridge?.openAuthUrl) return bridge.openAuthUrl(url);
    window.open(url, '_blank', 'noopener');
    return true;
  },

  /** Desktop only: catch Google's redirect on 127.0.0.1 (null in the browser build). */
  googleLoopback: bridge?.google || null,

  /** Desktop only: host the control server on this PC. */
  hub: bridge?.hub || null,

  setTheme(theme) {
    bridge?.setTheme(theme).catch(() => { /* older shell without a custom title bar */ });
  },

  async getServerUrl() {
    if (bridge) return (await bridge.settings.get()).serverUrl;
    return safeLocal.get('nexus.serverUrl') || FALLBACK_URL;
  },

  async setServerUrl(url) {
    if (bridge) return bridge.settings.setServerUrl(url);
    const origin = new URL(url).origin;
    safeLocal.set('nexus.serverUrl', origin);
    return origin;
  },

  async saveToken(token) {
    return bridge ? bridge.session.save(token) : false;
  },
  async loadToken() {
    return bridge ? bridge.session.load() : null;
  },
  async clearToken() {
    return bridge ? bridge.session.clear() : true;
  },
};
