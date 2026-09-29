import mongoose from 'mongoose';

/**
 * Console login sessions. Each JWT carries a `jti` that must match an
 * unrevoked Session, so logout and admin revocation take effect immediately.
 * Later phases add remote-desktop/terminal sessions with `kind`.
 */
const sessionSchema = new mongoose.Schema(
  {
    jti: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['console', 'remote_desktop', 'terminal', 'file'], default: 'console' },
    deviceId: { type: String, index: true },
    ip: String,
    userAgent: String,
    revokedAt: Date,
    lastSeenAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Expired sessions are removed automatically.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model('Session', sessionSchema);
