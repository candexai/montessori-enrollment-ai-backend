const mongoose = require('mongoose');

const leadInsightSchema = new mongoose.Schema({
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
    webhookId: { type: mongoose.Schema.Types.ObjectId, ref: 'ElevenLabsWebhook', required: true },
    conversationId: { type: String, default: '', index: true },
    aiProcessed: { type: Boolean, default: true },
    transcriptHash: { type: String, default: '' },
    tags: { type: [String], default: [] },
    childName: { type: String, default: '' },
    childAge: { type: String, default: '' },
    language: { type: String, default: '' },
    missingDetails: { type: [String], default: [] },
    questionsAsked: { type: [String], default: [] },
    isHotLead: { type: Boolean, default: false, index: true },
    leadTemperature: {
        type: String,
        enum: ['hot', 'warm', 'cold'],
        default: 'cold',
        index: true,
    },
    parentSegment: {
        type: String,
        enum: ['new_parent', 'current_family', 'unknown'],
        default: 'new_parent',
        index: true,
    },
    processedAt: { type: Date, default: Date.now },
    // Denormalized list fields — avoids loading full webhook transcripts on page load.
    callerName: { type: String, default: '' },
    callerPhone: { type: String, default: '' },
    summary: { type: String, default: '' },
    callTimestamp: { type: Date, default: null, index: true },
    durationSeconds: { type: Number, default: 0 },
    actionNeededEligible: { type: Boolean, default: true, index: true },
    actionTakenFeedback: { type: String, default: '' },
    actionTakenAt: { type: Date, default: null },
}, { timestamps: true });

leadInsightSchema.index({ schoolId: 1, webhookId: 1 }, { unique: true });
leadInsightSchema.index({ schoolId: 1, isHotLead: 1, processedAt: -1 });
leadInsightSchema.index({ schoolId: 1, leadTemperature: 1, processedAt: -1 });
leadInsightSchema.index({ schoolId: 1, actionNeededEligible: 1, callTimestamp: -1 });

module.exports = mongoose.model('LeadInsight', leadInsightSchema);
