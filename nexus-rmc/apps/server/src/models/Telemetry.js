import mongoose from 'mongoose';

/**
 * Time-series samples from agents (one per METRIC_UPDATE, ~every 5 s).
 * Kept for 7 days; used for charts, traffic history, anomaly training and reports.
 * Short field names keep the collection small.
 */
const metricSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true },
    t: { type: Date, required: true },
    cpu: Number,
    ram: Number,
    disk: Number,
    rx: Number,   // bytes/s
    tx: Number,   // bytes/s
    lat: Number,  // ICMP ms
    loss: Number, // ICMP %
    rtt: Number,  // app-level ms
    conn: Number, // open connections
    sim: Boolean,
  },
  { versionKey: false },
);
metricSchema.index({ deviceId: 1, t: -1 });
metricSchema.index({ t: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
export const Metric = mongoose.model('Metric', metricSchema);

/** One-time enrollment tokens (D2): single use, 15-minute default expiry, stored hashed. */
const enrollmentSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    hint: String, // last 4 chars, for display only
    label: { type: String, trim: true, maxlength: 64 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: String,
    expiresAt: { type: Date, required: true },
    maxUses: { type: Number, default: 1 },
    uses: { type: Number, default: 0 },
    usedBy: [String],
    revokedAt: Date,
  },
  { timestamps: true },
);
enrollmentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });
export const EnrollmentToken = mongoose.model('EnrollmentToken', enrollmentSchema);

/** Alerts raised by the rules engine and the anomaly detector (Phase 5/6). */
const alertSchema = new mongoose.Schema(
  {
    key: { type: String, required: true }, // deviceId:kind — at most one open alert per key
    deviceId: { type: String, index: true },
    hostname: String,
    kind: { type: String, required: true },
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'warning' },
    message: String,
    value: Number,
    threshold: Number,
    status: { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open', index: true },
    openedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    count: { type: Number, default: 1 },
    ackBy: String,
    ackAt: Date,
    resolvedAt: Date,
    resolvedBy: String,
    autoResolved: Boolean,
  },
  { versionKey: false },
);
alertSchema.index({ key: 1, status: 1 });
alertSchema.index({ openedAt: -1 });
export const Alert = mongoose.model('Alert', alertSchema);

/** Remote desktop / file / terminal sessions (Phase 4) with approval state (Phase 7). */
const remoteSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['desktop', 'files', 'terminal'], required: true },
    deviceId: { type: String, required: true, index: true },
    hostname: String,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    username: String,
    role: String,
    fullShell: { type: Boolean, default: false },
    reason: { type: String, maxlength: 200 },
    status: {
      type: String,
      enum: ['requested', 'approved', 'active', 'ended', 'denied', 'expired', 'failed'],
      default: 'requested',
      index: true,
    },
    decidedBy: String,
    decidedAt: Date,
    startedAt: Date,
    endedAt: Date,
    endReason: String,
    tokenHash: { type: String, select: false },
    tokenExpiresAt: Date,
    stats: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);
export const RemoteSession = mongoose.model('RemoteSession', remoteSessionSchema);

/** Server-side settings editable from the console (AI key, thresholds, policies). */
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: mongoose.Schema.Types.Mixed,
    updatedBy: String,
  },
  { timestamps: true },
);
export const Setting = mongoose.model('Setting', settingSchema);

/** Generated health reports (Phase 6). */
const reportSchema = new mongoose.Schema(
  {
    title: String,
    kind: { type: String, enum: ['daily', 'weekly', 'custom'], default: 'daily' },
    from: Date,
    to: Date,
    data: mongoose.Schema.Types.Mixed,
    narrative: String,
    generator: String, // 'groq:<model>' or 'template'
    createdBy: String,
  },
  { timestamps: true },
);
export const Report = mongoose.model('Report', reportSchema);
