import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMessage, encode, decode, MessageType, ErrorCode,
  ipToInt, intToIp, isInCidr, NETWORK,
} from './index.js';

test('round-trips a valid envelope', () => {
  const msg = createMessage(MessageType.HEARTBEAT, { uptime: 12 }, { deviceId: 'dev-1' });
  const res = decode(encode(msg));
  assert.equal(res.ok, true);
  assert.equal(res.message.type, 'HEARTBEAT');
  assert.equal(res.message.deviceId, 'dev-1');
});

test('rejects invalid JSON, unknown type, wrong version, bad payload', () => {
  assert.equal(decode('{nope').code, ErrorCode.BAD_MESSAGE);
  const base = createMessage(MessageType.PING, {});
  assert.equal(decode(encode({ ...base, type: 'HACK' })).code, ErrorCode.UNKNOWN_TYPE);
  assert.equal(decode(encode({ ...base, version: '9.9' })).code, ErrorCode.UNSUPPORTED_VERSION);
  assert.equal(decode(encode({ ...base, payload: [] })).code, ErrorCode.BAD_MESSAGE);
  assert.equal(decode(encode({ ...base, deviceId: 42 })).code, ErrorCode.BAD_MESSAGE);
});

test('createMessage refuses unknown types', () => {
  assert.throws(() => createMessage('NOT_A_TYPE'));
});

test('IPv4 helpers', () => {
  assert.equal(intToIp(ipToInt('10.50.0.1') + 1), '10.50.0.2');
  assert.equal(isInCidr('10.50.0.77', NETWORK.cidr), true);
  assert.equal(isInCidr('10.51.0.1', NETWORK.cidr), false);
  assert.throws(() => ipToInt('10.50.0.300'));
});
