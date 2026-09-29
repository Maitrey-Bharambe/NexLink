import http from 'node:http';
import { env } from './config/env.js';
import { connectDb } from './config/db.js';
import { createApp } from './app.js';
import { attachConsoleHub } from './websocket/consoleHub.js';
import { attachAgentHub } from './websocket/agentHub.js';
import { attachSessionHub } from './websocket/sessionHub.js';
import { SystemEvent } from './models/SystemEvent.js';
import { migrateUsers } from './models/User.js';
import { Device } from './models/Device.js';
import { RemoteSession } from './models/Telemetry.js';
import { startWireGuard } from './services/wireguard.js';
import { startOfflineSweep } from './services/alerts.js';
import { startAnomalyLoop } from './services/anomaly.js';
import { startSessionSweep } from './services/sessions.js';
import { log, setLogLevel } from './utils/logger.js';

setLogLevel(env.logLevel);

async function main() {
  log.info('server.starting', { port: env.port, host: env.host });
  await connectDb(env.mongoUri);
  await migrateUsers();
  // Nothing is connected at boot: reset live state left over from a previous run.
  await Device.updateMany({ 'approval.state': 'approved', status: { $in: ['CONNECTED', 'DEGRADED', 'CONNECTING', 'RECONNECTING'] } }, { $set: { status: 'DISCONNECTED' } });
  await RemoteSession.updateMany({ status: 'active' }, { $set: { status: 'ended', endedAt: new Date(), endReason: 'Server restarted' } });
  await SystemEvent.create({ type: 'server.started', message: 'Control server started' });
  await startWireGuard();

  const app = createApp();
  const server = http.createServer(app);
  const consoleHub = attachConsoleHub(server);
  const agentHub = attachAgentHub(server);
  const sessionHub = attachSessionHub(server);
  startOfflineSweep();
  startAnomalyLoop();
  startSessionSweep();

  server.listen(env.port, env.host, () => {
    log.info('server.listening', { url: `http://${env.host}:${env.port}`, ws: ['/ws/console', '/ws/agent', '/ws/session'], publicUrl: env.publicUrl });
  });

  const shutdown = (signal) => {
    log.info('server.stopping', { signal });
    consoleHub.close();
    agentHub.close();
    sessionHub.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.critical('server.fatal', { reason: err.message });
  process.exit(1);
});
