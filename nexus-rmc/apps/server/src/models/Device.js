import mongoose from 'mongoose';

/**
 * A managed machine. Created when an agent enrolls with a one-time token,
 * then approved (or rejected) by an admin. Live fields are refreshed by the
 * agent's control channel; bulky detail (connections, processes) is kept as
 * the latest snapshot only — history lives in the Metric collection.
 */
const deviceSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, unique: true },
    hostname: { type: String, required: true, index: true },
    label: { type: String, trim: true, maxlength: 64 },
    os: String,
    osVersion: String,
    arch: String,
    agentVersion: String,
    cpuModel: String,
    cpuCores: Number,
    ramTotal: Number,
    virtualIp: { type: String, index: { unique: true, sparse: true } },
    physicalIp: String,
    publicKey: String, // WireGuard public key only; the private key never leaves the agent
    secretHash: { type: String, select: false }, // sha256 of the device secret issued on approval

    approval: {
      state: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      byName: String,
      at: Date,
    },
    status: {
      type: String,
      enum: ['PENDING', 'CONNECTED', 'CONNECTING', 'RECONNECTING', 'DEGRADED', 'DISCONNECTED', 'UNAUTHORIZED'],
      default: 'PENDING',
      index: true,
    },
    simulated: { type: Boolean, default: false },
    assignedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],
    capabilities: { type: mongoose.Schema.Types.Mixed, default: {} },
    enrolledAt: Date,
    connectedAt: Date,
    lastSeen: { type: Date, index: true },

    tunnel: {
      mode: { type: String, enum: ['wireguard', 'simulated', 'direct'], default: 'direct' },
      up: { type: Boolean, default: false },
      endpoint: String,
      handshakeAt: Date,
      rxBytes: Number,
      txBytes: Number,
    },
    latest: {
      at: Date,
      cpuPct: Number,
      ramPct: Number,
      diskPct: Number,
      rxBps: Number,
      txBps: Number,
      latencyMs: Number,     // ICMP average (D3)
      packetLossPct: Number, // ICMP loss (D3)
      appRttMs: Number,      // server PING/PONG over the control channel
      uptimeSec: Number,
      processCount: Number,
      connCount: Number,
    },
    net: { type: mongoose.Schema.Types.Mixed, default: null },       // interfaces, connections, listening, protocols
    processes: { type: mongoose.Schema.Types.Mixed, default: null }, // top processes
    anomaly: {
      score: Number,
      severity: { type: String, enum: ['normal', 'low', 'medium', 'high'], default: 'normal' },
      features: [String],
      model: String,
      at: Date,
    },
  },
  { timestamps: true },
);

deviceSchema.methods.toSummary = function toSummary() {
  return {
    deviceId: this.deviceId,
    hostname: this.hostname,
    label: this.label || null,
    os: this.os,
    osVersion: this.osVersion,
    virtualIp: this.virtualIp,
    physicalIp: this.physicalIp,
    status: this.status,
    approval: this.approval?.state || 'pending',
    simulated: this.simulated,
    assignedUsers: (this.assignedUsers || []).map(String),
    lastSeen: this.lastSeen,
    tunnel: this.tunnel ? { mode: this.tunnel.mode, up: this.tunnel.up, handshakeAt: this.tunnel.handshakeAt } : null,
    latest: this.latest || {},
    anomaly: this.anomaly?.severity && this.anomaly.severity !== 'normal'
      ? { score: this.anomaly.score, severity: this.anomaly.severity, features: this.anomaly.features }
      : null,
    capabilities: this.capabilities || {},
  };
};

deviceSchema.methods.toDetail = function toDetail() {
  return {
    ...this.toSummary(),
    arch: this.arch,
    agentVersion: this.agentVersion,
    cpuModel: this.cpuModel,
    cpuCores: this.cpuCores,
    ramTotal: this.ramTotal,
    publicKey: this.publicKey,
    enrolledAt: this.enrolledAt,
    connectedAt: this.connectedAt,
    approvedBy: this.approval?.byName || null,
    approvedAt: this.approval?.at || null,
    tunnel: this.tunnel,
    net: this.net,
    processes: this.processes,
    anomaly: this.anomaly || null,
  };
};

export const Device = mongoose.model('Device', deviceSchema);

/** Devices a user may see: admins see all; users only what is assigned to them. */
export function deviceScope(user) {
  return user.role === 'admin' ? {} : { assignedUsers: user._id };
}
