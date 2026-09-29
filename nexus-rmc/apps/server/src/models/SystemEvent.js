import mongoose from 'mongoose';

/**
 * Server-level events (startup, setup, DB reconnects…). `key` is optional and
 * unique, which lets one-time events such as initial setup act as a lock.
 */
const systemEventSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, default: Date.now },
    type: { type: String, required: true },
    key: { type: String, unique: true, sparse: true },
    severity: { type: String, enum: ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], default: 'INFO' },
    message: String,
    details: mongoose.Schema.Types.Mixed,
    // Set from `key` below. Partial indexes can't filter on `$exists: false`
    // (rejected by MongoDB 8), so the TTL index filters on this flag instead.
    retain: { type: Boolean, default: false },
  },
  { versionKey: false },
);

systemEventSchema.pre('validate', function markKeyedEventsRetained(next) {
  this.retain = Boolean(this.key);
  next();
});

systemEventSchema.index({ timestamp: -1 });
// Keep routine system events for 90 days (one-time keyed events are kept).
systemEventSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 90 * 24 * 3600, partialFilterExpression: { retain: false } },
);

export const SystemEvent = mongoose.model('SystemEvent', systemEventSchema);
