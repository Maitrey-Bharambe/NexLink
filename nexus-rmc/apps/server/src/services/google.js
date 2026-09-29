import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';
import { log } from '../utils/logger.js';
import { googleCredentials } from './settings.js';

/**
 * Google sign-in for a desktop app, without embedding a browser:
 *
 *  1. Console → POST /api/auth/google/start. The server creates a PKCE
 *     verifier, a `state`, and a random `pollId`, and returns Google's URL.
 *  2. The console opens that URL in the system browser.
 *  3. Google redirects to GET /api/auth/google/callback on this server,
 *     which exchanges the code (with the PKCE verifier) and verifies the
 *     ID token's signature, audience, issuer and expiry.
 *  4. The console polls GET /api/auth/google/poll/:pollId and receives the
 *     outcome exactly once (a NexLink session, "pending", or an error).
 *
 * Nothing Google-issued is stored: only the stable `sub` (googleId), the
 * verified email, name and avatar URL.
 */

const FLOW_TTL_MS = 10 * 60_000;
const flows = new Map(); // state -> { verifier, pollId, createdAt }
const polls = new Map(); // pollId -> { status, result?, createdAt }

export async function googleConfigured() {
  const c = await googleCredentials();
  return Boolean(c.clientId && c.clientSecret);
}
export const redirectUri = () => `${env.publicUrl}/api/auth/google/callback`;

async function client(redirect) {
  const c = await googleCredentials();
  return new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: redirect });
}

/** Loopback redirect on the user's own PC (RFC 8252) — works from any machine on the network. */
export const loopbackUri = (port) => `http://127.0.0.1:${port}/callback`;

const b64url = (buf) => buf.toString('base64url');

function sweep() {
  const now = Date.now();
  for (const [k, v] of flows) if (now - v.createdAt > FLOW_TTL_MS) flows.delete(k);
  for (const [k, v] of polls) if (now - v.createdAt > FLOW_TTL_MS) polls.delete(k);
}
setInterval(sweep, 60_000).unref();

export async function startFlow({ loopbackPort } = {}) {
  const { clientId } = await googleCredentials();
  const redirect = loopbackPort ? loopbackUri(loopbackPort) : redirectUri();
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const pollId = b64url(crypto.randomBytes(32));
  flows.set(state, { verifier, pollId, redirect, createdAt: Date.now() });
  polls.set(pollId, { status: 'waiting', createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return { authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, pollId, state };
}

/** Exchange the code and verify the ID token. Returns the verified profile + pollId. */
export async function completeFlow({ code, state }) {
  const flow = flows.get(String(state || ''));
  if (!flow) throw new Error('This sign-in link has expired. Start again from NexLink.');
  flows.delete(state);

  const { clientId } = await googleCredentials();
  const oauth = await client(flow.redirect);
  const { tokens } = await oauth.getToken({ code: String(code), codeVerifier: flow.verifier, redirect_uri: flow.redirect });
  const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
  const p = ticket.getPayload();
  if (!p?.sub || !p.email) throw new Error('Google did not return an email address.');
  if (!p.email_verified) throw new Error('Your Google email address is not verified.');
  return {
    pollId: flow.pollId,
    profile: { googleId: p.sub, email: p.email.toLowerCase(), name: p.name || p.email, avatarUrl: p.picture || null },
  };
}

export function resolvePoll(pollId, status, result = {}) {
  if (!polls.has(pollId)) return;
  polls.set(pollId, { status, result, createdAt: polls.get(pollId).createdAt });
}

/** Returns the outcome once; the entry is deleted after a final status is read. */
export function readPoll(pollId) {
  const entry = polls.get(String(pollId || ''));
  if (!entry) return { status: 'expired' };
  if (entry.status !== 'waiting') polls.delete(pollId);
  return { status: entry.status, ...entry.result };
}

export function failPollForState(state, message) {
  const flow = flows.get(String(state || ''));
  if (flow) {
    flows.delete(state);
    resolvePoll(flow.pollId, 'error', { message });
  }
  log.warn('google.flow_failed', { reason: message });
}

/** Small branded page shown in the browser after the redirect. */
export function resultPage(title, message, ok) {
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><title>NexLink</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F6E7D0;font-family:Inter,Segoe UI,system-ui,sans-serif;color:#033A41}
.card{background:#FCF6EC;border:1px solid #E6D6BC;border-radius:12px;padding:32px 36px;max-width:420px;text-align:center}
.mark{width:48px;height:48px;margin:0 auto 16px}
h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#5F6865;line-height:1.5;font-size:14px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:${ok ? '#09C4B1' : '#DDAA6B'};margin-right:8px}
</style></head><body><div class="card">
<svg class="mark" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#033A41"/><path d="M19 45V19M45 45V19" stroke="#F6E7D0" stroke-width="5" stroke-linecap="round"/><path d="M19 19L45 45" stroke="#09C4B1" stroke-width="5" stroke-linecap="round"/><circle cx="19" cy="45" r="5.5" fill="#F6E7D0"/><circle cx="19" cy="19" r="5.5" fill="#09C4B1"/><circle cx="45" cy="45" r="5.5" fill="#09C4B1"/><circle cx="45" cy="19" r="5.5" fill="#DDAA6B"/></svg>
<h1><span class="dot"></span>${esc(title)}</h1><p>${esc(message)}</p></div></body></html>`;
}
