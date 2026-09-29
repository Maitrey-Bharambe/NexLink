import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import systemRoutes from './routes/system.js';
import deviceRoutes from './routes/devices.js';
import networkRoutes from './routes/network.js';
import sessionRoutes from './routes/sessions.js';
import alertRoutes from './routes/alerts.js';
import intelRoutes from './routes/intel.js';
import { agentFile } from './services/downloads.js';
import { notFound, errorHandler } from './middleware/errors.js';


export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use(helmet());
  app.use(cors({
    // 'null' is the Origin sent by a packaged Electron app loading file://.
    // Auth uses Bearer tokens (no cookies), so CORS is not a CSRF boundary here.
    origin: (origin, cb) => cb(null, !origin || origin === 'null' || env.corsOrigins.includes(origin)),
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }));

  // Public: the agent installer, so managed PCs can download it from the hub.
  app.get('/downloads/NexLinkAgent.exe', (_req, res) => {
    const file = agentFile();
    if (!file) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'The agent installer has not been built on this server.' } });
    return res.download(file, 'NexLinkAgent.exe');
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/devices', deviceRoutes);
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/alerts', alertRoutes);
  app.use('/api', systemRoutes);
  app.use('/api', networkRoutes);
  app.use('/api', intelRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
