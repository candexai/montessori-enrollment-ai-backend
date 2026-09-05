const mongoose = require('mongoose');

const ALERT_TYPES = [
    'SYSTEM_ERROR',
    'DATABASE_ERROR',
    'AUTH_ERROR',
    'SIGNUP_ERROR',
    'OUTLOOK_ERROR',
    'ELEVENLABS_ERROR',
    'CARTESIA_ERROR',
    'OPENAI_ERROR',
    'EMAIL_ERROR',
    'WEBHOOK_ERROR',
    'CRON_ERROR',
    'PAYMENT_ERROR',
    'AGENT_ERROR',
    'INTEGRATION_ERROR',
    'RATE_LIMIT_ERROR',
    'UNKNOWN_ERROR',
];

const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'];
const ALERT_STATUSES = ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'];

const alertSchema = new mongoose.Schema({
    type: { type: String, enum: ALERT_TYPES, required: true },
    severity: { type: String, enum: ALERT_SEVERITIES, required: true },
    status: { type: String, enum: ALERT_STATUSES, default: 'ACTIVE' },
    title: { type: String, required: true },
    message: { type: String, required: true },
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
    schoolName: { type: String, default: null },
    source: { type: String, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    dedupeKey: { type: String, required: true, index: true },
    occurrenceCount: { type: Number, default: 1 },
    firstOccurredAt: { type: Date, required: true },
    lastOccurredAt: { type: Date, required: true },
    resolvedAt: { type: Date, default: null },
    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastEmailedAt: { type: Date, default: null },
    emailTiersSent: { type: [String], default: [] },
}, { timestamps: true });

alertSchema.index({ dedupeKey: 1, status: 1, lastOccurredAt: -1 });
alertSchema.index({ severity: 1, status: 1, lastOccurredAt: -1 });
alertSchema.index({ schoolId: 1, lastOccurredAt: -1 });
alertSchema.index({ type: 1, lastOccurredAt: -1 });

module.exports = mongoose.model('Alert', alertSchema);
module.exports.ALERT_TYPES = ALERT_TYPES;
module.exports.ALERT_SEVERITIES = ALERT_SEVERITIES;
module.exports.ALERT_STATUSES = ALERT_STATUSES;
