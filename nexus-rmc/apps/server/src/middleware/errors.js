import { ZodError } from 'zod';
import { log } from '../utils/logger.js';

export class HttpError extends Error {
  constructor(status, message, code = 'ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function notFound(req, _res, next) {
  next(new HttpError(404, `No route for ${req.method} ${req.path}`, 'NOT_FOUND'));
}

/**
 * Uniform error body: { error: { code, message, fields? } }.
 * Stack traces are logged, never sent to the client (prompt §47).
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION',
        message: 'Some fields are invalid.',
        fields: Object.fromEntries(err.issues.map((i) => [i.path.join('.'), i.message])),
      },
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON.' } });
  }
  const status = err.status || 500;
  if (status >= 500) log.error('http.unhandled', { path: req.path, reason: err.message, stack: err.stack });
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL',
      message: status >= 500 ? 'Something went wrong on the server.' : err.message,
    },
  });
}

/** Wrap async route handlers so rejections reach the error handler. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
