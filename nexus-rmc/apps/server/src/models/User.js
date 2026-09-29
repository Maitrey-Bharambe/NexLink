import mongoose from 'mongoose';

/**
 * Two roles, kept deliberately separate:
 *   admin — full console: all devices, VPN, users, audit, settings.
 *   user  — own portal: only devices an admin assigned to them.
 */
export const ROLES = ['admin', 'user'];

/**
 * Account lifecycle:
 *   pending  — self-registered (email or Google), waiting for an admin
 *   active   — can sign in
 *   disabled — blocked; all sessions revoked
 */
export const STATUSES = ['pending', 'active', 'disabled'];

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String, required: true, unique: true, lowercase: true, trim: true,
      minlength: 3, maxlength: 40, match: /^[a-z0-9._-]+$/,
    },
    email: { type: String, lowercase: true, trim: true, maxlength: 254, index: { unique: true, sparse: true } },
    displayName: { type: String, trim: true, maxlength: 64 },
    passwordHash: { type: String, select: false }, // absent for Google-only accounts
    hasPassword: { type: Boolean, default: true },
    googleId: { type: String, index: { unique: true, sparse: true } },
    avatarUrl: String,
    role: { type: String, enum: ROLES, default: 'user', index: true },
    status: { type: String, enum: STATUSES, default: 'active', index: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    lastLoginAt: Date,
    lastLoginIp: String,
    failedLogins: { type: Number, default: 0 },
    lockedUntil: Date,
  },
  { timestamps: true },
);

userSchema.virtual('disabled').get(function disabled() {
  return this.status === 'disabled';
});

userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    username: this.username,
    email: this.email || null,
    displayName: this.displayName || this.username,
    avatarUrl: this.avatarUrl || null,
    role: this.role,
    status: this.status,
    disabled: this.status === 'disabled',
    providers: [this.hasPassword !== false && 'password', this.googleId && 'google'].filter(Boolean),
    lastLoginAt: this.lastLoginAt,
    approvedAt: this.approvedAt,
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);

/**
 * One-time upgrades for installs created before the Admin/User split:
 * operator/viewer become user, and the old `disabled` flag becomes `status`.
 */
export async function migrateUsers() {
  const col = User.collection;
  await col.updateMany({ role: { $in: ['operator', 'viewer'] } }, { $set: { role: 'user' } });
  await col.updateMany({ status: { $exists: false }, disabled: true }, { $set: { status: 'disabled' }, $unset: { disabled: '' } });
  await col.updateMany({ status: { $exists: false } }, { $set: { status: 'active' }, $unset: { disabled: '' } });
}

/** Derive a unique username from an email or name (used for self-registration). */
export async function uniqueUsername(seed) {
  const base = String(seed || 'user').toLowerCase().split('@')[0].replace(/[^a-z0-9._-]/g, '').slice(0, 30) || 'user';
  const padded = base.length >= 3 ? base : `${base}user`;
  for (let i = 0; i < 50; i += 1) {
    const candidate = i === 0 ? padded : `${padded}${i + 1}`;
    if (!(await User.exists({ username: candidate }))) return candidate;
  }
  return `${padded}-${Date.now().toString(36)}`;
}
