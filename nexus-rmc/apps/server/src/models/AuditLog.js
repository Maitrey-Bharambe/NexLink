import mongoose from 'mongoose';

/**
 * Append-only audit trail (prompt §39).
 * Fields: timestamp, user, device, action, result, IP, session, approval.
 * No TTL: audit logs are long-term.
 */
const auditSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, default: Date.now, required: true },
    actorType: { type: String, enum: ['user', 'ai', 'system', 'agent'], required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    username: String,
    deviceId: String,
    deviceName: String,
    action: { type: String, required: true },
    result: { type: String, enum: ['success', 'failure', 'denied'], required: true },
    ip: String,
    sessionId: String,
    approval: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed },
  },
  { versionKey: false },
);

auditSchema.index({ timestamp: -1 });
auditSchema.index({ userId: 1, timestamp: -1 });
auditSchema.index({ deviceId: 1, timestamp: -1 });
auditSchema.index({ action: 1, timestamp: -1 });

// Append-only: block updates and deletes through Mongoose.
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  auditSchema.pre(op, function blockMutation(next) {
    next(new Error('Audit log is append-only'));
  });
}

export const AuditLog = mongoose.model('AuditLog', auditSchema);
