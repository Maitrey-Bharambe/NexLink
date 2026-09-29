/**
 * HTTP client for the control server.
 * Every call has a timeout and returns friendly errors (prompt §47).
 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK', fields } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

let baseUrl = 'http://localhost:4000';
let token = null;
let onUnauthorized = null;

export const api = {
  configure({ serverUrl, authToken, unauthorizedHandler } = {}) {
    if (serverUrl !== undefined) baseUrl = serverUrl.replace(/\/+$/, '');
    if (authToken !== undefined) token = authToken;
    if (unauthorizedHandler !== undefined) onUnauthorized = unauthorizedHandler;
  },
  get baseUrl() { return baseUrl; },

  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body, opts),
  patch: (path, body, opts) => request('PATCH', path, body, opts),
  put: (path, body, opts) => request('PUT', path, body, opts),
  delete: (path, opts) => request('DELETE', path, undefined, opts),
};

async function request(method, path, body, { timeoutMs = 8000, auth = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApiError(
      err.name === 'AbortError'
        ? `The server at ${baseUrl} did not respond in time.`
        : `Cannot reach the control server at ${baseUrl}. Check that it is running and the address is correct.`,
      { code: err.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE' },
    );
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    const error = new ApiError(e.message || `Request failed (${res.status}).`, {
      status: res.status, code: e.code || 'HTTP_ERROR', fields: e.fields,
    });
    if (res.status === 401 && auth && token) onUnauthorized?.(error);
    throw error;
  }
  return data;
}
