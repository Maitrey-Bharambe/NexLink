/**
 * NexLink — Electron main process.
 *
 * Security posture (prompt §34):
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true
 *  - the renderer gets only the small API in preload.cjs
 *  - every IPC payload is validated here
 *  - navigation and new windows are blocked; https links open externally
 */
const { app, BrowserWindow, ipcMain, safeStorage, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const hub = require('./hub.cjs');

const isDev = process.env.NEXUS_DEV === '1';
const APP_ICON = path.join(__dirname, '..', 'build', 'icon.ico');

// The app was renamed NEXUS RMC -> NexLink. Keep the original data folder so
// saved settings and the encrypted session survive the rename.
app.setName('NexLink');
app.setPath('userData', path.join(app.getPath('appData'), 'NEXUS RMC'));
if (process.platform === 'win32') app.setAppUserModelId('edu.nexus.rmc');
const DEV_URL = 'http://127.0.0.1:5173';

// ---------- persisted settings (userData/settings.json) ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const tokenFile = () => path.join(app.getPath('userData'), 'session.bin');
const DEFAULT_SETTINGS = { serverUrl: 'http://localhost:4000', rememberSession: true };

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(next) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}

// ---------- IPC validation helpers ----------
function assertServerUrl(value) {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Invalid server URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Server URL must use http or https');
  if (url.username || url.password) throw new Error('Server URL must not contain credentials');
  return url.origin;
}

function assertToken(value) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 4096 || !/^[\w.-]+$/.test(value)) {
    throw new Error('Invalid token');
  }
  return value;
}

/** Only accept IPC from our own window's top frame. */
function trustedSender(event) {
  const url = event.senderFrame?.url || '';
  return isDev ? url.startsWith(DEV_URL) : url.startsWith('file://');
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender');
    return fn(...args);
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    secureStorage: safeStorage.isEncryptionAvailable(),
  }));

  handle('settings:get', () => readSettings());

  // Host mode: run the control server on this PC.
  handle('hub:status', () => hub.status());
  handle('hub:enable', async () => {
    const st = await hub.start({ mongoUri: readSettings().mongoUri });
    writeSettings({ ...readSettings(), hostServer: true, serverUrl: 'http://localhost:4000' });
    return st;
  });
  handle('hub:disable', () => {
    hub.stop();
    writeSettings({ ...readSettings(), hostServer: false });
    return true;
  });

  // Google sign-in (RFC 8252): listen once on 127.0.0.1 for Google's redirect.
  let google = null;
  handle('google:listen', () => new Promise((resolve, reject) => {
    if (google) { google.server.close(); google.done({ error: 'cancelled' }); google = null; }
    let done;
    const result = new Promise((r) => { done = r; });
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const out = { code: u.searchParams.get('code'), state: u.searchParams.get('state'), error: u.searchParams.get('error') };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(`<!doctype html><meta charset="utf-8"><title>NexLink</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#F6E7D0;font-family:Segoe UI,sans-serif;color:#033A41"><div style="background:#FCF6EC;border:1px solid #E6D6BC;border-radius:12px;padding:28px 34px;text-align:center"><h2 style="margin:0 0 6px">${out.error ? 'Sign-in cancelled' : 'Signed in to Google'}</h2><p style="margin:0;color:#5F6865">You can close this tab and return to NexLink.</p></div></body>`);
      server.close();
      google = null;
      const [win] = BrowserWindow.getAllWindows();
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
      done(out);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      google = { server, result, done };
      setTimeout(() => { if (google?.server === server) { server.close(); google = null; done({ error: 'timeout' }); } }, 5 * 60_000);
      resolve(server.address().port);
    });
  }));
  handle('google:wait', () => (google ? google.result : { error: 'not_listening' }));
  handle('google:cancel', () => { if (google) { google.server.close(); google.done({ error: 'cancelled' }); google = null; } return true; });

  // Google sign-in opens in the user's own browser; only Google's OAuth page is allowed.
  handle('shell:openAuthUrl', (value) => {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') throw new Error('Blocked URL');
    return shell.openExternal(url.toString()).then(() => true);
  });

  // Recolour the native window buttons to match the console theme.
  handle('window:setTheme', (value) => {
    if (!Object.hasOwn(TITLEBAR, value)) throw new Error('Invalid theme');
    for (const win of BrowserWindow.getAllWindows()) win.setTitleBarOverlay(TITLEBAR[value]);
    return true;
  });

  handle('settings:setServerUrl', (value) => {
    const serverUrl = assertServerUrl(value);
    writeSettings({ ...readSettings(), serverUrl });
    return serverUrl;
  });

  // Session token is encrypted with the OS keychain (DPAPI on Windows).
  // If OS encryption is unavailable the token is kept in memory only.
  handle('session:save', (value) => {
    const token = assertToken(value);
    if (!safeStorage.isEncryptionAvailable()) return false;
    fs.writeFileSync(tokenFile(), safeStorage.encryptString(token));
    return true;
  });

  handle('session:load', () => {
    try {
      if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(tokenFile())) return null;
      return safeStorage.decryptString(fs.readFileSync(tokenFile()));
    } catch {
      return null;
    }
  });

  handle('session:clear', () => {
    try { fs.rmSync(tokenFile(), { force: true }); } catch { /* already gone */ }
    return true;
  });
}

// ---------- window ----------
// The top bar is drawn by the renderer; Windows keeps its native buttons on top of it.
const TITLEBAR = {
  dark: { color: '#06434b', symbolColor: '#f6e7d0', height: 56 },
  light: { color: '#fcf6ec', symbolColor: '#033a41', height: 56 },
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    title: 'NexLink',
    icon: APP_ICON,
    backgroundColor: '#f6e7d0',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLEBAR.light,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // Show the window even if the renderer is slow or fails to signal ready,
  // so the app can never end up running invisibly.
  const reveal = () => { if (!win.isDestroyed() && !win.isVisible()) { win.maximize(); win.show(); } };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 4000);
  // If the renderer crashes, reload it instead of leaving a blank/hidden window.
  win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.reload(); });

  // No in-app navigation away from the console, no pop-up windows.
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith('file://');
    if (!allowed) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  return win;
}

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });

  app.on('before-quit', () => hub.stop());

  app.whenReady().then(() => {
    if (readSettings().hostServer) hub.start({ mongoUri: readSettings().mongoUri }).catch(() => { /* shown in the app */ });
    if (!isDev) Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
