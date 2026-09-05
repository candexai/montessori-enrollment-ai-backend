#!/usr/bin/env node
/**
 * Recalculate isHotLead + leadTemperature (hot/warm/cold) + tags on cached
 * LeadInsight rows and webhooks.
 * Usage: node scripts/backfill-hot-leads.js [--schoolId=<id>] [--dry-run]
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const ElevenLabsWebhook = require('../src/models/ElevenLabsWebhook');
const LeadInsight = require('../src/models/LeadInsight');
const {
    mapComprehensiveResult,
    mapWebhookExtractedFields,
    mapSummaryFallback,
    upsertLeadInsight,
    hashTranscript,
    getTranscriptText,
} = require('../src/services/leadInsightService');

function buildInsightData(webhook) {
    if (webhook.comprehensive_result) {
        return mapComprehensiveResult(webhook.comprehensive_result, webhook);
    }
    if (webhook.ai_processed && Array.isArray(webhook.extractedTags)) {
        return mapWebhookExtractedFields(webhook);
    }
    return mapSummaryFallback(webhook);
}

async function backfillHotLeads() {
    const dryRun = process.argv.includes('--dry-run');
    const schoolIdArg = process.argv.find((arg) => arg.startsWith('--schoolId='));
    const schoolIdFilter = schoolIdArg ? schoolIdArg.split('=')[1] : null;

    await mongoose.connect(process.env.MONGODB_URI);
    console.log(`Connected to MongoDB${dryRun ? ' (dry run)' : ''}`);

    const query = {
        type: 'post_call_transcription',
        ...(schoolIdFilter ? { schoolId: new mongoose.Types.ObjectId(schoolIdFilter) } : {}),
    };

    const webhooks = await ElevenLabsWebhook.find(query)
        .select('_id schoolId conversation_id summary comprehensive_result extractedTags extractedChildName extractedChildAge extractedLanguage extractedMissingDetails tour_booking_extracted ai_processed tour_booking_detected actionTaken actionTakenFeedback actionTakenAt user_id transcript metadata received_at')
        .lean();

    let changed = 0;
    let hotBefore = 0;
    let hotAfter = 0;
    let warmBefore = 0;
    let warmAfter = 0;

    for (const webhook of webhooks) {
        if (!webhook.schoolId) continue;

        const existing = await LeadInsight.findOne({ webhookId: webhook._id }).lean();
        if (existing?.isHotLead) hotBefore += 1;
        if (existing?.leadTemperature === 'warm') warmBefore += 1;

        const insightData = buildInsightData(webhook);
        if (insightData.isHotLead) hotAfter += 1;
        if (insightData.leadTemperature === 'warm') warmAfter += 1;

        const tagsChanged = JSON.stringify(existing?.tags || []) !== JSON.stringify(insightData.tags || []);
        const hotChanged = Boolean(existing?.isHotLead) !== Boolean(insightData.isHotLead);
        const tempChanged = (existing?.leadTemperature || 'cold') !== (insightData.leadTemperature || 'cold');
        if (!tagsChanged && !hotChanged && !tempChanged) continue;

        changed += 1;
        if (dryRun) {
            console.log(`[would fix] ${webhook.conversation_id || webhook._id}: hot ${Boolean(existing?.isHotLead)} -> ${insightData.isHotLead}, temp ${existing?.leadTemperature || 'cold'} -> ${insightData.leadTemperature || 'cold'}, tags=${JSON.stringify(insightData.tags)}`);
            continue;
        }

        await upsertLeadInsight({
            schoolId: webhook.schoolId,
            webhook,
            insightData,
            transcriptHash: hashTranscript(getTranscriptText(webhook)),
        });
    }

    console.log(`Processed ${webhooks.length} webhooks. Changed: ${changed}. Hot leads: ${hotBefore} -> ${hotAfter}. Warm leads: ${warmBefore} -> ${warmAfter}.`);
    await mongoose.disconnect();
}

backfillHotLeads().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
