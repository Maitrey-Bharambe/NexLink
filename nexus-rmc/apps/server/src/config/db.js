import mongoose from 'mongoose';
import { log } from '../utils/logger.js';

mongoose.set('strictQuery', true);

let state = 'DISCONNECTED';
export const dbState = () => state;

/** Connect with retry + exponential backoff (prompt §36, §47). */
export async function connectDb(uri, { maxAttempts = Infinity } = {}) {
  mongoose.connection.on('connected', () => { state = 'CONNECTED'; log.info('db.connected'); });
  mongoose.connection.on('disconnected', () => { state = 'DISCONNECTED'; log.warn('db.disconnected'); });
  mongoose.connection.on('reconnected', () => { state = 'CONNECTED'; log.info('db.reconnected'); });

  let attempt = 0;
  for (;;) {
    attempt += 1;
    state = attempt === 1 ? 'CONNECTING' : 'RECONNECTING';
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
      await mongoose.connection.syncIndexes();
      return mongoose.connection;
    } catch (err) {
      const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      log.error('db.connect_failed', { attempt, retryInMs: delay, reason: err.message });
      if (attempt >= maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
