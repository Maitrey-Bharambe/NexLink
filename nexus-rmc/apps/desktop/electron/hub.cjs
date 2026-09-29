/**
 * Host mode: this PC runs the NexLink control server (the hub).
 *
 * The server is plain Node, so it runs on Electron's own Node runtime
 * (ELECTRON_RUN_AS_NODE) as a hidden child process — no separate Node
 * install is needed. MongoDB must be installed on this PC.
 *
 *   packaged:  <resources>/server/src/index.js   (staged by scripts/stage.mjs)
 *   dev:       apps/server/src/index.js
 */
const { app } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

let child = null;
let lastExit = null;

function serverDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.join(__dirname, '..', '..', 'server');
}

function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function status() {
  return {
    available: fs.existsSync(path.join(serverDir(), 'src', 'index.js')),
    running: Boolean(child) || await portOpen(4000),
    managed: Boolean(child),
    mongo: await portOpen(27017),
    lastExit,
    logFile: logFile(),
  };
}

const logFile = () => path.join(app.getPath('userData'), 'logs', 'server.log');

async function start({ mongoUri } = {}) {
  if (child) return status();
  if (await portOpen(4000)) return status(); // a server is already running here
  if (!(await portOpen(27017))) throw new Error('MongoDB is not running on this PC (port 27017). Install MongoDB Community Server, then try again.');
  const dir = serverDir();
  if (!fs.existsSync(path.join(dir, 'src', 'index.js'))) throw new Error('The server files are missing from this installation.');

  fs.mkdirSync(path.dirname(logFile()), { recursive: true });
  const out = fs.openSync(logFile(), 'a');
  child = spawn(process.execPath, [path.join(dir, 'src', 'index.js')], {
    cwd: dir,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: '4000',
      HOST: '0.0.0.0',
      MONGODB_URI: mongoUri || 'mongodb://127.0.0.1:27017/nexus_rmc',
      DATA_DIR: path.join(app.getPath('userData'), 'server-data'),
      NEXLINK_RESOURCES: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..'),
      AGENT_DOWNLOAD: app.isPackaged
        ? path.join(process.resourcesPath, 'agent', 'NexLinkAgent.exe')
        : path.join(__dirname, '..', '..', 'agent', 'dist', 'NexLinkAgent.exe'),
      CORS_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
    },
  });
  child.on('exit', (code) => { lastExit = { code, at: new Date().toISOString() }; child = null; });

  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await portOpen(4000)) return status();
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
    if (!child) break;
  }
  throw new Error(`The NexLink server did not start. See ${logFile()}`);
}

function stop() {
  if (child) {
    child.kill();
    child = null;
  }
}

module.exports = { start, stop, status };
