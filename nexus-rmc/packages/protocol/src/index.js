/**
 * NexLink (NEXUS RMC) application protocol (v1.0).
 *
 * Every WebSocket text message is one JSON envelope:
 *   { version, messageId, type, deviceId, sessionId, timestamp, payload }
 *
 * Shared by the server and desktop app; the Python agent mirrors these
 * constants in apps/agent/nexlink_agent/protocol.py.
 */

export const PROTOCOL_VERSION = '1.0';

export const MessageType = Object.freeze({
  // Auth & enrollment
  AUTH_REQUEST: 'AUTH_REQUEST',
  AUTH_RESPONSE: 'AUTH_RESPONSE',
  DEVICE_REGISTER: 'DEVICE_REGISTER',
  DEVICE_APPROVED: 'DEVICE_APPROVED',
  // Liveness & telemetry
  HEARTBEAT: 'HEARTBEAT',
  METRIC_UPDATE: 'METRIC_UPDATE',
  NETWORK_UPDATE: 'NETWORK_UPDATE',
  PROCESS_UPDATE: 'PROCESS_UPDATE',
  // Remote sessions
  SESSION_START: 'SESSION_START',
  SESSION_END: 'SESSION_END',
  SCREEN_FRAME: 'SCREEN_FRAME',
  REMOTE_INPUT: 'REMOTE_INPUT',
  FILE_REQUEST: 'FILE_REQUEST',
  FILE_RESPONSE: 'FILE_RESPONSE',
  COMMAND_REQUEST: 'COMMAND_REQUEST',
  COMMAND_RESPONSE: 'COMMAND_RESPONSE',
  // RTT measurement
  PING: 'PING',
  PONG: 'PONG',
  // Server → console push
  STATE_SNAPSHOT: 'STATE_SNAPSHOT',
  EVENT: 'EVENT',
  ERROR: 'ERROR',
  // Enrollment outcomes (server → agent)
  DEVICE_PENDING: 'DEVICE_PENDING',
  DEVICE_REJECTED: 'DEVICE_REJECTED',
  // Remote session control
  SESSION_READY: 'SESSION_READY',
  SESSION_STATS: 'SESSION_STATS',
});

/**
 * Binary frames on session channels: byte 0 is the kind.
 *   1 = screen frame (JPEG bytes follow)
 *   2 = file data: bytes 1..16 = transfer id (ASCII), then the chunk
 */
export const BinaryKind = Object.freeze({ SCREEN: 1, FILE: 2 });

/**
 * Terminal policy (D5). Users get the allowlist; admins may open a full shell
 * after an explicit confirmation. Enforced on the server AND on the agent.
 */
export const TERMINAL_ALLOWLIST = Object.freeze([
  'ipconfig', 'ifconfig', 'ip', 'ping', 'tracert', 'traceroute', 'pathping', 'netstat', 'nslookup', 'dig',
  'arp', 'route', 'tasklist', 'ps', 'systeminfo', 'whoami', 'hostname', 'dir', 'ls', 'pwd', 'uptime',
  'df', 'free', 'getmac', 'ss', 'wg', 'echo', 'date', 'ver', 'uname',
]);

/** Shell metacharacters that could chain or redirect commands; rejected in allowlist mode. */
const SHELL_META = /[;&|`$<>(){}\n\r%^]|\.\./;

/** Returns null if allowed, or a reason string. */
export function checkAllowlistedCommand(line) {
  const text = String(line || '').trim();
  if (!text) return 'Empty command.';
  if (text.length > 256) return 'Command is too long.';
  if (SHELL_META.test(text)) return 'Pipes, redirection, chaining and parent paths are not allowed in restricted mode.';
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/\.exe$/, '');
  if (!TERMINAL_ALLOWLIST.includes(cmd)) return `"${cmd}" is not on the allowed command list.`;
  if (cmd === 'route' && !/^route\s+print(\s|$)/i.test(text)) return 'Only "route print" is allowed.';
  if (cmd === 'wg' && !/^wg\s+show(\s|$)/i.test(text) && text.toLowerCase() !== 'wg') return 'Only "wg show" is allowed.';
  if (cmd === 'ip' && !/^ip\s+(a|addr|address|r|route|link)(\s|$)/i.test(text)) return 'Only "ip addr/route/link" is allowed.';
  return null;
}

/** Well-known ports → protocol names (D6). */
export const WELL_KNOWN_PORTS = Object.freeze({
  20: 'FTP-DATA', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 67: 'DHCP', 68: 'DHCP', 80: 'HTTP',
  110: 'POP3', 123: 'NTP', 135: 'RPC', 137: 'NetBIOS', 138: 'NetBIOS', 139: 'NetBIOS', 143: 'IMAP', 161: 'SNMP',
  389: 'LDAP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 587: 'SMTP', 993: 'IMAPS', 995: 'POP3S', 1433: 'MSSQL',
  1900: 'SSDP', 3306: 'MySQL', 3389: 'RDP', 4000: 'NexLink', 5353: 'mDNS', 5432: 'PostgreSQL', 5900: 'VNC',
  6379: 'Redis', 8000: 'HTTP-alt', 8080: 'HTTP-alt', 8443: 'HTTPS-alt', 27017: 'MongoDB', 51820: 'WireGuard',
});

const TYPES = new Set(Object.values(MessageType));

/** Connection states shown throughout the UI (prompt §36). */
export const ConnectionStatus = Object.freeze({
  CONNECTED: 'CONNECTED',
  CONNECTING: 'CONNECTING',
  RECONNECTING: 'RECONNECTING',
  DEGRADED: 'DEGRADED',
  DISCONNECTED: 'DISCONNECTED',
  UNAUTHORIZED: 'UNAUTHORIZED',
});

export const ErrorCode = Object.freeze({
  BAD_MESSAGE: 'BAD_MESSAGE',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
});

/** Private network plan (docs/DESIGN_DECISIONS.md D1). */
export const NETWORK = Object.freeze({
  name: 'NEXLINK PRIVATE NETWORK',
  cidr: '10.50.0.0/24',
  gateway: '10.50.0.1',
  agentRange: ['10.50.0.2', '10.50.0.199'],
  simulatedRange: ['10.50.0.200', '10.50.0.254'],
  wireguardPort: 51820,
});

export const MAX_MESSAGE_BYTES = 256 * 1024;

const uuid = () =>
  globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

/** Build a protocol envelope. */
export function createMessage(type, payload = {}, { deviceId = null, sessionId = null } = {}) {
  if (!TYPES.has(type)) throw new Error(`Unknown message type: ${type}`);
  return {
    version: PROTOCOL_VERSION,
    messageId: uuid(),
    type,
    deviceId,
    sessionId,
    timestamp: new Date().toISOString(),
    payload,
  };
}

export const encode = (msg) => JSON.stringify(msg);

/**
 * Parse and validate a raw message.
 * Returns { ok: true, message } or { ok: false, code, reason }.
 */
export function decode(raw) {
  const text = typeof raw === 'string' ? raw : raw?.toString?.('utf8');
  if (!text) return fail(ErrorCode.BAD_MESSAGE, 'Empty message');
  if (text.length > MAX_MESSAGE_BYTES) return fail(ErrorCode.BAD_MESSAGE, 'Message too large');

  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return fail(ErrorCode.BAD_MESSAGE, 'Invalid JSON');
  }
  return validate(msg);
}

export function validate(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return fail(ErrorCode.BAD_MESSAGE, 'Envelope must be an object');
  }
  if (msg.version !== PROTOCOL_VERSION) {
    return fail(ErrorCode.UNSUPPORTED_VERSION, `Expected version ${PROTOCOL_VERSION}`);
  }
  if (typeof msg.messageId !== 'string' || msg.messageId.length < 8 || msg.messageId.length > 64) {
    return fail(ErrorCode.BAD_MESSAGE, 'Invalid messageId');
  }
  if (!TYPES.has(msg.type)) return fail(ErrorCode.UNKNOWN_TYPE, `Unknown type: ${msg.type}`);
  if (typeof msg.timestamp !== 'string' || Number.isNaN(Date.parse(msg.timestamp))) {
    return fail(ErrorCode.BAD_MESSAGE, 'Invalid timestamp');
  }
  for (const key of ['deviceId', 'sessionId']) {
    if (msg[key] != null && typeof msg[key] !== 'string') {
      return fail(ErrorCode.BAD_MESSAGE, `Invalid ${key}`);
    }
  }
  if (!msg.payload || typeof msg.payload !== 'object' || Array.isArray(msg.payload)) {
    return fail(ErrorCode.BAD_MESSAGE, 'payload must be an object');
  }
  return { ok: true, message: msg };
}

export function errorMessage(code, reason, replyTo = null) {
  return createMessage(MessageType.ERROR, { code, reason, replyTo });
}

function fail(code, reason) {
  return { ok: false, code, reason };
}

/** IPv4 helpers used for virtual-IP allocation and display. */
export function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function intToIp(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isInCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
}
