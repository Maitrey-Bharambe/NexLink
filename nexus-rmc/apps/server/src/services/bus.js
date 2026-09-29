import { EventEmitter } from 'node:events';

/**
 * In-process event bus decoupling HTTP routes from WebSocket hubs.
 * Events: 'audit' (entry), 'session.revoked' (jti), 'devices.changed' ().
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);
