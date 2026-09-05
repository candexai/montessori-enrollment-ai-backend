const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const FormData = require('form-data');
const School = require('../models/School');
const CallLog = require('../models/CallLog');
const Integration = require('../models/Integration');
const Followup = require('../models/Followup');
const BillingTransaction = require('../models/BillingTransaction');
const FormQuestion = require('../models/FormQuestion');
const Referral = require('../models/Referral');
const ReferralLink = require('../models/ReferralLink');
const InquirySubmission = require('../models/InquirySubmission');
const TourBooking = require('../models/TourBooking');
const MinuteLedger = require('../models/MinuteLedger');
const ElevenLabsWebhook = require('../models/ElevenLabsWebhook');
const LeadInsight = require('../models/LeadInsight');
const voiceAISchema = require('../models/VoiceAI');
const AiNumberRequest = require('../models/AiNumberRequest');
const { authMiddleware, schoolOnly } = require('../middleware/auth');
const { getGoogleAuthUrl, getOutlookAuthUrl } = require('./integrations');
const {
    getCallDurationSeconds,
    getCallerPhoneFromWebhook,
    getCallerNameFromWebhook,
    isUsableCallerName,
    isWidgetCallerId,
    isRealPhoneForLookup,
} = require('../utils/webhookHelpers');
const { resolveWebhookSummary } = require('../utils/currentFamilyTransfer');
const {
    resolveInsightsForWebhooks,
    buildActionNeededCall,
    loadActionNeededCalls,
    markLeadInsightActionTaken,
    removeLeadInsightForWebhook,
    ensureTourBookedEmailMissingTag,
    resolveParentEmail,
    mapSummaryFallback,
    mapComprehensiveResult,
    isTourBooked,
    isTourBookedEmailMissing,
    isValidConfirmedEmail,
    withPastCallNameTag,
    buildCallerNameHistoryIndex,
    resolveCallerNameWithPastFallback,
} = require('../services/leadInsightService');
const {
    getProvider,
    formatQAPairsForKB,
} = require('../services/voiceProviders');
const { getPlanDef } = require('../config/billingPlans');
const {
    generateWordCloud,
    mergeParentQuestionsFromExtraction,
    mergeQuestionLists,
    filterSchoolQuestions,
    extractTourTalkingPoints,
} = require('../utils/openai');




const router = express.Router();
// Apply auth middleware to all school routes
router.use(authMiddleware, schoolOnly);

/** Exclude large blobs — transcripts alone can be 8MB+ for 265 calls. */
const WEBHOOK_LIST_PROJECTION = '-raw_payload -audio_base64 -transcript';

/** Required for HTML5 audio seeking — browsers request byte ranges when scrubbing. */
function sendAudioBufferWithRange(req, res, audioBuffer, contentType = 'audio/mpeg') {
    const total = audioBuffer.length;
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=3600');

    const range = req.headers.range;
    if (!range) {
        res.set('Content-Length', String(total));
        return res.send(audioBuffer);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
        res.set('Content-Length', String(total));
        return res.send(audioBuffer);
    }

    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : total - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;

    if (start > end || start >= total) {
        res.status(416).set('Content-Range', `bytes */${total}`);
        return res.end();
    }

    const chunk = audioBuffer.subarray(start, end + 1);
    res.status(206);
    res.set('Content-Range', `bytes ${start}-${end}/${total}`);
    res.set('Content-Length', String(chunk.length));
    return res.send(chunk);
}

// Helper function to format Q&A pairs is now imported from services/voiceProviders

// Deletes a knowledge base document via the school's voice provider.
async function deleteKnowledgeBaseDocument(school, documentId) {
    if (!documentId) return;
    try {
        await getProvider(school.voiceProvider || 'elevenlabs').deleteKnowledgeBaseDocument(documentId);
        console.log(`[KB] Successfully deleted document ${documentId}`);
    } catch (err) {
        console.error(`[KB DELETE] Failed to delete document ${documentId}:`, err.message);
        // Don't throw - we'll continue to create new document
    }
}

// PATCH agent with only knowledge_base_ids (used after questionnaire KB DELETE/POST)
async function patchAgentKnowledgeBaseOnly(agentId, documentId) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent PATCH KB] ELEVENLABS_API_URL not configured, skipping');
        return null;
    }
    if (!agentId) {
        console.warn('[Agent PATCH KB] AGENT_ID not configured, skipping');
        return null;
    }
    try {
        const agentsUrl = `${baseUrl}/api/v1/agents/${agentId}`;
        const payload = {
            knowledge_base_ids: documentId && documentId.trim() ? [documentId] : []
        };
        console.log('[Agent PATCH KB] PATCH', agentsUrl, 'payload:', JSON.stringify(payload));
        const response = await axios.patch(agentsUrl, payload, {
            headers: {
                'accept': 'application/json',
                'Content-Type': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });
        console.log('[Agent PATCH KB] Response', response.status, JSON.stringify(response.data));
        return response.data;
    } catch (err) {
        console.error('[Agent PATCH KB] Failed:', err.response?.status, err.response?.data, err.message);
        throw err;
    }
}

// Helper: sync prompt/KB/human-transfer to the school's voice provider (tools are registration-only).
async function updateAgentWithKnowledgeBase(
    school,
    agentId,
    firstMessage,
    systemPrompt,
    knowledgeBaseId,
    humanTransfer = { enabled: false, condition: '', phoneNumber: '' },
) {
    if (!agentId) {
        console.warn('[Agent PATCH] agentId not configured, skipping agent update');
        return null;
    }

    const provider = getProvider(school.voiceProvider || 'elevenlabs');

    try {
        console.log('[Agent PATCH] ========== SYNC START ==========');
        console.log(`[Agent PATCH] Agent ID: ${agentId} (${school.voiceProvider || 'elevenlabs'})`);
        console.log('[Agent PATCH] human_transfer enabled:', Boolean(humanTransfer?.enabled));

        const data = await provider.syncSchoolAgent(agentId, {
            firstMessage,
            systemPrompt,
            knowledgeBaseId,
            humanTransfer,
        });
        console.log('[Agent PATCH] ========== SYNC SUCCESS ==========');
        return data;
    } catch (err) {
        console.error(`[Agent PATCH] FAILED:`, err.response?.status || err.statusCode, err.message);
        throw err;
    }
}

// Helper function to ingest knowledge base is now imported from services/voiceProviders

// GET /api/school/dashboard - School-specific metrics
router.get('/dashboard', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this user' });
        }

        const school = await School.findById(schoolId)
            .select('aiNumber aiNumberAssignedAt adminEmail subscriptionPlanKey subscriptionStatus billingMode paypalSubscriptionId')
            .lean();

        // Get admin email notifications scoped to this school
        let adminEmailNotifications = [];
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        const adminEmailQuery = {
            schoolId: schoolObjectId,
            type: 'Email',
            leadName: 'Admin Notification'
        };

        // Helper to consistently normalize phones for matching
        const normalizePhone = (phone) => {
            if (!phone) return '';
            return phone.replace(/\D/g, '');
        };

        const buildWebhookLookup = (webhooks) => {
            const byConversationId = new Map();
            const byPhone = new Map();
            for (const wh of webhooks) {
                if (wh.conversation_id) byConversationId.set(wh.conversation_id, wh);
                const rawPhone = getCallerPhoneFromWebhook(wh, '');
                if (!isRealPhoneForLookup(rawPhone)) continue;
                const phone = normalizePhone(rawPhone);
                if (!phone) continue;
                if (!byPhone.has(phone)) byPhone.set(phone, []);
                byPhone.get(phone).push(wh);
            }
            return { byConversationId, byPhone };
        };

        const findWebhookForCall = (call, lookup) => {
            if (call.conversationId && lookup.byConversationId.has(call.conversationId)) {
                return lookup.byConversationId.get(call.conversationId);
            }
            if (isWidgetCallerId(call.callerPhone)) return null;
            const phone = normalizePhone(call.callerPhone);
            const candidates = lookup.byPhone.get(phone) || [];
            if (!candidates.length) return null;
            const callTime = new Date(call.timestamp).getTime();
            let best = null;
            let bestDelta = Infinity;
            for (const wh of candidates) {
                const t = wh.metadata?.start_time_unix_secs
                    ? wh.metadata.start_time_unix_secs * 1000
                    : new Date(wh.received_at).getTime();
                const delta = Math.abs(t - callTime);
                if (delta < bestDelta && delta <= 180000) {
                    bestDelta = delta;
                    best = wh;
                }
            }
            return best;
        };

        const resolveDashboardCallSummary = (call, lookup) => {
            const wh = findWebhookForCall(call, lookup);
            if (wh) return resolveWebhookSummary(wh);
            return call.summary || '';
        };

        const schoolAiNumber = normalizePhone(school?.aiNumber || '');
        const userToken = req.headers.authorization?.split(' ')[1] || '';
        // Always the host the browser is already talking to for this request — not
        // process.env.BACKEND_URL, which is reserved for telling external services
        // (Cartesia's tool/webhook callbacks) how to reach this backend publicly. Reusing
        // it here would route the browser's own audio/asset requests through that same
        // public tunnel (e.g. ngrok in dev), which free-tier ngrok blocks with an HTML
        // interstitial instead of serving the actual response.
        const backendUrl = `${req.protocol}://${req.get('host')}`;

        const { resolveDashboardPeriod, isWithinPeriod, buildDashboardChartData } = require('../utils/dashboardPeriod');
        const periodWindow = resolveDashboardPeriod(req.query);
        if (periodWindow.error) {
            return res.status(400).json({ error: periodWindow.error });
        }
        const { period, periodStart, periodEnd, chartBars, bucketType } = periodWindow;
        console.log(`[DASHBOARD DEBUG] Handling period: ${period}, Start: ${periodStart.toISOString()}, End: ${periodEnd.toISOString()}`);

        const [
            adminEmails,
            voiceAiCalls,
            schoolWebhooks,
            callLogEntries,
            actualToursBooked,
            connectedCalendarCount,
            latestPaidPlanTx,
            minuteGrantTotals,
            insightNameRows,
        ] = await Promise.all([
            Followup.find(adminEmailQuery)
                .sort({ createdAt: -1 })
                .limit(20)
                .lean(),
            (async () => {
                let voiceAiCallsInner = [];
                if (schoolAiNumber) {
                    try {
                        const digits = schoolAiNumber;
                        const normalizedNumber = `+${digits}`;
                        const participantId = `sip_${normalizedNumber}`;

                        const bennyDb = mongoose.connection.useDb('benny');
                        const collection = bennyDb.collection('voiceAI');

                        let voiceAiQuery = { participant_id: participantId };
                        if (school?.aiNumberAssignedAt) {
                            const since = new Date(school.aiNumberAssignedAt);
                            voiceAiQuery = {
                                $and: [
                                    { participant_id: participantId },
                                    {
                                        $or: [
                                            { created_at: { $gte: since } },
                                            { timestamp: { $gte: since } },
                                        ],
                                    },
                                ],
                            };
                        }

                        const rawLogs = await collection.find(voiceAiQuery)
                            .sort({ created_at: -1 })
                            .toArray();

                        voiceAiCallsInner = rawLogs.map(log => ({
                            id: log._id.toString(),
                            callerPhone: log.participant_id ? log.participant_id.replace('sip_', '') : 'Unknown',
                            callerName: 'Parent',
                            duration: log.duration_seconds || 0,
                            timestamp: log.created_at || log.timestamp || new Date(),
                            recordingUrl: log.recording_url || null,
                            callType: 'inquiry',
                            summary: '',
                            tourBookingDetected: false,
                            tourBookingDate: null,
                            aiProcessed: false
                        }));
                    } catch (err) {
                        console.error('[Dashboard] VoiceAI fetch error:', err);
                    }
                }
                return voiceAiCallsInner;
            })(),
            // Scope strictly by school — phone-number fallback matched prior tenants when numbers were reassigned.
            ElevenLabsWebhook.find({
                type: 'post_call_transcription',
                schoolId: schoolObjectId,
            })
                // Omit raw_payload (large debug blob) and audio; dashboard only needs metadata + transcript + summary fields
                .select('-raw_payload -audio_base64')
                .sort({ received_at: -1 })
                .limit(500)
                .lean(),
            CallLog.find({ schoolId: schoolObjectId })
                .sort({ createdAt: -1 })
                .limit(500)
                .lean(),
            TourBooking.find({ schoolId })
                .select('phone parentName childName calendarProvider scheduledAt')
                .sort({ createdAt: 1 })
                .lean(),
            Integration.countDocuments({
                schoolId,
                connected: true,
                type: { $in: ['google', 'outlook'] }
            }),
            BillingTransaction.findOne({
                schoolId: schoolObjectId,
                type: { $in: ['subscription_payment', 'subscription_activated'] },
                planKey: { $in: ['starter', 'growth', 'full_enrollment'] },
            })
                .select('planKey createdAt')
                .sort({ createdAt: -1 })
                .lean(),
            MinuteLedger.aggregate([
                { $match: { schoolId: schoolObjectId } },
                {
                    $group: {
                        _id: null,
                        allPositive: {
                            $sum: {
                                $cond: [{ $gt: ['$deltaMinutes', 0] }, '$deltaMinutes', 0],
                            },
                        },
                        topupPositive: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $eq: ['$reason', 'topup'] },
                                            { $gt: ['$deltaMinutes', 0] },
                                        ],
                                    },
                                    '$deltaMinutes',
                                    0,
                                ],
                            },
                        },
                    },
                },
            ]),
            LeadInsight.find({ schoolId: schoolObjectId })
                .select('callerPhone callerName callTimestamp webhookId')
                .lean(),
        ]);
        const hasConnectedCalendar = connectedCalendarCount > 0;

        // Lookup map for parent names based on normalized phone numbers (chronological)
        const nameHistoryIndex = buildCallerNameHistoryIndex([
            ...actualToursBooked.map((tour) => ({
                phone: tour.phone,
                name: tour.parentName,
                timestamp: tour.scheduledAt,
            })),
            ...schoolWebhooks.map((wh) => ({
                phone: getCallerPhoneFromWebhook(wh, ''),
                name: getCallerNameFromWebhook(wh, null),
                timestamp: wh.metadata?.start_time_unix_secs
                    ? wh.metadata.start_time_unix_secs * 1000
                    : wh.received_at,
                webhookId: wh._id,
            })),
            ...callLogEntries.map((cl) => ({
                phone: cl.from_phone_number,
                name: cl.callerName,
                timestamp: cl.createdAt,
                webhookId: cl._id,
            })),
            ...insightNameRows.map((row) => ({
                phone: row.callerPhone,
                name: row.callerName,
                timestamp: row.callTimestamp,
                webhookId: row.webhookId,
            })),
        ]);

        const resolveName = (phone, specificName = null, callTimestamp = null, webhookId = null) => {
            const resolved = resolveCallerNameWithPastFallback(nameHistoryIndex, {
                callerName: specificName,
                callerPhone: phone,
                callTimestamp,
                webhookId,
            });
            return resolved;
        };

        adminEmailNotifications = adminEmails.map(email => ({
            id: email._id.toString(),
            recipient: email.recipient,
            status: email.status,
            subject: email.message?.split('\n')[0] || 'New Call Received',
            sentAt: email.createdAt || email.updatedAt,
            conversationId: email.message?.match(/Conversation ID: ([^\n\s]+)/)?.[1] || null,
            callerNumber: email.message?.match(/(?:Caller Name\/Number|Caller Number): ([^\n]+)/)?.[1] || null,
        }));

        const webhookCalls = schoolWebhooks.map(wh => {
            const callTimestamp = wh.metadata?.start_time_unix_secs
                ? new Date(wh.metadata.start_time_unix_secs * 1000)
                : wh.received_at;

            // Only show "Tour booked" on dashboard when school has a connected calendar.
            const bookingConfirmed = hasConnectedCalendar && Boolean(wh.tour_booking_detected);
            const identity = resolveName(
                getCallerPhoneFromWebhook(wh, ''),
                getCallerNameFromWebhook(wh, null),
                callTimestamp,
                wh._id
            );

            return {
                id: wh._id.toString(),
                conversationId: wh.conversation_id,
                callerPhone: getCallerPhoneFromWebhook(wh, 'Web Widget'),
                callerName: identity.callerName,
                usedPastCallName: identity.usedPastCallName,
                duration: getCallDurationSeconds(wh),
                timestamp: callTimestamp,
                recordingUrl: `${backendUrl}/api/school/calls/${wh.conversation_id}/audio?token=${userToken}`,
                callType: 'inquiry',
                summary: resolveWebhookSummary(wh),
                tourBookingDetected: bookingConfirmed,
                tourBookingDate: bookingConfirmed ? (wh.tour_booking_date || null) : null,
                aiProcessed: wh.ai_processed || false
            };
        });

        const callLogCalls = callLogEntries.map(cl => {
            const identity = resolveName(cl.from_phone_number || '', cl.callerName, cl.createdAt, cl._id);
            return {
            id: cl._id.toString(),
            conversationId: cl.conversation_id,
            callerPhone: cl.from_phone_number || 'Unknown',
            callerName: identity.callerName,
            usedPastCallName: identity.usedPastCallName,
            duration: cl.duration || 0,
            timestamp: cl.createdAt,
            recordingUrl: cl.conversation_id ? `${backendUrl}/api/school/calls/${cl.conversation_id}/audio?token=${userToken}` : null,
            callType: cl.callType || 'inquiry',
            summary: cl.summary || '',
            tourBookingDetected: false, // Tour booking handled via separate collection
            tourBookingDate: null,
            aiProcessed: true
        };
        });

        // ── STEP 3: Merge and Deduplicate ──────────
        const allCallsMap = new Map();

        // Add VoiceAI base (usually more reliable for duration/SIP)
        voiceAiCalls.forEach(c => {
            const key = `${normalizePhone(c.callerPhone)}_${new Date(c.timestamp).getTime()}`;
            allCallsMap.set(key, c);
        });

        // Add CallLogs (The 92 synced calls etc)
        callLogCalls.forEach(clc => {
            const key = clc.conversationId || `${normalizePhone(clc.callerPhone)}_${new Date(clc.timestamp).getTime()}`;
            allCallsMap.set(key, clc);
        });

        // Add/Enrich with Webhooks (they have summaries & tour flags)
        webhookCalls.forEach(whc => {
            const convKey = whc.conversationId || `${normalizePhone(whc.callerPhone)}_${new Date(whc.timestamp).getTime()}`;
            if (allCallsMap.has(convKey)) {
                const existing = allCallsMap.get(convKey);
                allCallsMap.set(convKey, { ...existing, ...whc, id: existing.id });
                return;
            }

            // Merge into VoiceAI / phone-only row for the same call (webhook uses conversationId key).
            const whPhone = normalizePhone(whc.callerPhone);
            const whTime = new Date(whc.timestamp).getTime();
            let voiceKey = null;
            for (const [key, existing] of allCallsMap.entries()) {
                if (existing.conversationId) continue;
                const phone = normalizePhone(existing.callerPhone);
                const callTime = new Date(existing.timestamp).getTime();
                if (phone && phone === whPhone && Math.abs(callTime - whTime) <= 5 * 60 * 1000) {
                    voiceKey = key;
                    break;
                }
            }

            if (voiceKey) {
                const existing = allCallsMap.get(voiceKey);
                allCallsMap.set(voiceKey, { ...existing, ...whc, id: existing.id });
            } else {
                allCallsMap.set(convKey, whc);
            }
        });

        const calls = Array.from(allCallsMap.values())
            .map(c => {
                const identity = resolveName(c.callerPhone, c.callerName, c.timestamp, c.id);
                return {
                    ...c,
                    callerName: identity.callerName,
                    usedPastCallName: Boolean(c.usedPastCallName || identity.usedPastCallName),
                };
            })
            .sort((a, b) =>
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );

        const schoolPlanDef = school?.subscriptionPlanKey
            ? getPlanDef(school.subscriptionPlanKey)
            : null;
        const txPlanDef = latestPaidPlanTx?.planKey
            ? getPlanDef(latestPaidPlanTx.planKey)
            : null;
        const planDef = schoolPlanDef || txPlanDef || null;
        // Treat schools as paid when they have a valid plan and either:
        // - subscription is active, or
        // - billing mode is metered, or
        // - a PayPal subscription id is present (some records lag status sync), or
        // - recent paid billing transactions show a valid paid tier.
        const hasPaidPlan = Boolean(planDef) && (
            school?.subscriptionStatus === 'active'
            || school?.billingMode === 'metered'
            || Boolean(String(school?.paypalSubscriptionId || '').trim())
            || Boolean(latestPaidPlanTx?.planKey)
        );
        const includedMinutesPerMonth = hasPaidPlan
            ? Number(planDef.includedMinutesPerMonth) || 2
            : 2;

        /** Total minute credits (plan allocations + top-ups, etc.) for "used / total" on the dashboard */
        const grantRow = minuteGrantTotals[0];
        const allGrantsSum = grantRow?.allPositive ?? 0;
        const topupOnlySum = grantRow?.topupPositive ?? 0;
        let totalMinutesCapacity = allGrantsSum;
        if (totalMinutesCapacity === 0) {
            totalMinutesCapacity = includedMinutesPerMonth;
        } else if (allGrantsSum === topupOnlySum && topupOnlySum > 0) {
            // Ledger may only show top-ups if monthly plan credits were never posted — include plan allowance.
            totalMinutesCapacity = includedMinutesPerMonth + topupOnlySum;
        }

        // Filter calls to the selected period
        const periodCalls = calls.filter((c) => isWithinPeriod(c.timestamp, periodStart, periodEnd));
        console.log(`[DASHBOARD DEBUG] Total calls: ${calls.length}, Period calls: ${periodCalls.length}`);

        const webhookLookup = buildWebhookLookup(schoolWebhooks);
        // Warm insight resolution for webhooks (segment/tags used by KPIs + recent calls).
        await resolveInsightsForWebhooks(schoolWebhooks, schoolObjectId, {
            allowOpenAI: false,
            persist: false,
        });

        const resolveCallWebhook = (call) => {
            if (call.conversationId) {
                return schoolWebhooks.find((w) => w.conversation_id === call.conversationId) || null;
            }
            return findWebhookForCall(call, webhookLookup);
        };

        const resolveInsightFromWebhook = (wh) => {
            if (!wh) return null;
            if (wh.comprehensive_result) {
                return mapComprehensiveResult(wh.comprehensive_result, wh);
            }
            return mapSummaryFallback(wh);
        };

        const resolveCallParentSegment = (call) => {
            const wh = resolveCallWebhook(call);
            if (wh) {
                return resolveInsightFromWebhook(wh)?.parentSegment || 'unknown';
            }
            if (!call.summary && !call.aiProcessed) return 'unknown';
            return 'new_parent';
        };

        const resolveCallTags = (call) => {
            const wh = resolveCallWebhook(call);
            if (!wh) return [];
            const fresh = resolveInsightFromWebhook(wh);
            const baseTags = fresh?.tags || [];
            return ensureTourBookedEmailMissingTag(baseTags, {
                tourBooked: isTourBooked(wh),
                parentEmail: resolveParentEmail(wh, wh.comprehensive_result),
                emailMissing: isTourBookedEmailMissing(wh),
            });
        };

        const resolveCallTourEmailMissing = (call, tags = []) => {
            if (tags.some((tag) => String(tag).toLowerCase().includes('email missing'))) {
                return true;
            }
            if (!call.tourBookingDetected) return false;
            let wh = resolveCallWebhook(call);
            if (!wh && call.callerPhone) {
                const phone = normalizePhone(call.callerPhone);
                wh = schoolWebhooks.find((w) => {
                    if (!w.tour_booking_detected) return false;
                    return normalizePhone(getCallerPhoneFromWebhook(w, '')) === phone;
                }) || null;
            }
            if (!wh) return false;
            return isTourBookedEmailMissing(wh);
        };

        const hasCallbackRequestTag = (tags = []) =>
            tags.some((tag) => {
                const lower = String(tag).toLowerCase();
                return (
                    lower.includes('parent requested callback')
                    || lower.includes('callback requested')
                    || lower.includes('callback')
                    || lower.includes('call back')
                );
            });

        // Calculate metrics from period calls
        const totalCalls = periodCalls.length;

        // ALL-TIME Minutes — new parents only (enrollment usage, not current family / unknown)
        // IMPORTANT: We must compute this from the same merged/deduped `calls` array used for
        // the other dashboard metrics; summing only `CallLog` can undercount when some calls
        // only exist in VoiceAI (benny) and/or ElevenLabs webhooks.
        const newParentCalls = calls.filter((c) => resolveCallParentSegment(c) === 'new_parent');
        const allTimeDurationSeconds = newParentCalls.reduce((acc, c) => acc + (Number(c.duration) || 0), 0);
        const allTimeMinutes = Math.floor(allTimeDurationSeconds / 60);

        // Average Call Length — new parents only (period-based)
        const periodNewParentCalls = periodCalls.filter((c) => resolveCallParentSegment(c) === 'new_parent');
        const newParentDurationSeconds = periodNewParentCalls.reduce((acc, c) => acc + (Number(c.duration) || 0), 0);
        const avgCallLengthSeconds = periodNewParentCalls.length > 0
            ? Math.round(newParentDurationSeconds / periodNewParentCalls.length)
            : 0;
        const avgCallLengthFormatted = `${Math.floor(avgCallLengthSeconds / 60)}m ${avgCallLengthSeconds % 60}s`;

        // Action Needed: new parents (+ callback requests) that still need follow-up.
        // Exclude unknown / current family. Exclude tour-booked calls unless email is missing
        // (same eligibility as Daily Insights Action Needed / LeadInsight.actionNeededEligible).
        // New Parent filter on Recent Calls can still include tour-booked parents.
        const actionNeeded = periodCalls.filter((c) => {
            const segment = resolveCallParentSegment(c);
            if (segment === 'unknown' || segment === 'current_family') return false;
            const tags = resolveCallTags(c);
            if (!(segment === 'new_parent' || hasCallbackRequestTag(tags))) return false;
            if (c.tourBookingDetected && !resolveCallTourEmailMissing(c, tags)) return false;
            return true;
        }).length;

        const chartData = buildDashboardChartData(calls, {
            periodStart,
            periodEnd,
            bucketType,
            chartBars,
            period,
        });

        // Recent calls: top 20 within selected period
        const recentCalls = periodCalls
            .slice(0, 20)
            .map(c => {
                let tags = resolveCallTags(c);
                if (c.usedPastCallName) tags = withPastCallNameTag(tags);
                return {
                id: c.id,
                conversationId: c.conversationId || null,
                callerName: c.callerName,
                callerPhone: c.callerPhone,
                callType: c.callType,
                duration: Math.round(c.duration),
                timestamp: c.timestamp,
                recordingUrl: c.recordingUrl,
                summary: resolveDashboardCallSummary(c, webhookLookup),
                tourBookingDetected: c.tourBookingDetected || false,
                tourBookingDate: c.tourBookingDate || null,
                tourEmailMissing: resolveCallTourEmailMissing(c, tags),
                tags,
                aiProcessed: c.aiProcessed || false,
                parentSegment: resolveCallParentSegment(c),
            };
            });

        res.json({
            metrics: [
                { label: 'Total Calls', value: totalCalls, icon: 'PhoneCall' },
                { label: 'Action Needed', value: actionNeeded, icon: 'AlertTriangle' },
                {
                    label: 'Tours Booked',
                    value: actualToursBooked.filter((t) => isWithinPeriod(t.scheduledAt, periodStart, periodEnd) && Boolean(t.calendarProvider)).length,
                    icon: 'Calendar'
                },
                { label: 'Minutes Consumed', value: `${allTimeMinutes} / ${totalMinutesCapacity}`, ticker: true, icon: 'Activity' },
                { label: 'Average Call Length', value: avgCallLengthFormatted, icon: 'Clock' },
            ],
            chartData,
            recentCalls,
            adminEmailNotifications,
            period,
        });
    } catch (err) {
        console.error('School dashboard error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/recent-calls — all calls in a date range (no top-N / 500 caps), with parent tags
router.get('/recent-calls', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this user' });
        }

        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        const school = await School.findById(schoolId)
            .select('aiNumber aiNumberAssignedAt')
            .lean();

        const { resolveDashboardPeriod, isWithinPeriod } = require('../utils/dashboardPeriod');
        const periodWindow = resolveDashboardPeriod(req.query);
        if (periodWindow.error) {
            return res.status(400).json({ error: periodWindow.error });
        }
        const { period, periodStart, periodEnd } = periodWindow;

        const normalizePhone = (phone) => {
            if (!phone) return '';
            return phone.replace(/\D/g, '');
        };

        const phoneKey = (phone) => {
            const digits = normalizePhone(phone);
            if (digits.length >= 10) return digits.slice(-10);
            return digits.length >= 7 ? digits : '';
        };

        const toOrdinal = (n) => {
            const num = Number(n) || 0;
            const mod100 = num % 100;
            if (mod100 >= 11 && mod100 <= 13) return `${num}th`;
            switch (num % 10) {
                case 1: return `${num}st`;
                case 2: return `${num}nd`;
                case 3: return `${num}rd`;
                default: return `${num}th`;
            }
        };

        const userToken = req.headers.authorization?.split(' ')[1] || '';
        // Always the host the browser is already talking to for this request — not
        // process.env.BACKEND_URL, which is reserved for telling external services
        // (Cartesia's tool/webhook callbacks) how to reach this backend publicly. Reusing
        // it here would route the browser's own audio/asset requests through that same
        // public tunnel (e.g. ngrok in dev), which free-tier ngrok blocks with an HTML
        // interstitial instead of serving the actual response.
        const backendUrl = `${req.protocol}://${req.get('host')}`;
        const schoolAiNumber = normalizePhone(school?.aiNumber || '');
        const startUnix = Math.floor(periodStart.getTime() / 1000);
        const endUnix = Math.floor(periodEnd.getTime() / 1000);

        const [schoolWebhooks, callLogEntries, connectedCalendarCount, voiceAiCalls, cachedInsights, phoneHistoryRows, allWebhookMeta] = await Promise.all([
            ElevenLabsWebhook.find({
                type: 'post_call_transcription',
                schoolId: schoolObjectId,
                $or: [
                    { received_at: { $gte: periodStart, $lte: periodEnd } },
                    {
                        'metadata.start_time_unix_secs': {
                            $gte: startUnix,
                            $lte: endUnix,
                        },
                    },
                ],
            })
                .select('-raw_payload -audio_base64')
                .sort({ received_at: -1 })
                .lean(),
            CallLog.find({
                schoolId: schoolObjectId,
                createdAt: { $gte: periodStart, $lte: periodEnd },
            })
                .sort({ createdAt: -1 })
                .lean(),
            Integration.countDocuments({
                schoolId,
                connected: true,
                type: { $in: ['google', 'outlook'] },
            }),
            (async () => {
                if (!schoolAiNumber) return [];
                try {
                    const digits = schoolAiNumber;
                    const normalizedNumber = `+${digits}`;
                    const participantId = `sip_${normalizedNumber}`;
                    const bennyDb = mongoose.connection.useDb('benny');
                    const collection = bennyDb.collection('voiceAI');
                    const timeFilter = {
                        $or: [
                            { created_at: { $gte: periodStart, $lte: periodEnd } },
                            { timestamp: { $gte: periodStart, $lte: periodEnd } },
                        ],
                    };
                    let voiceAiQuery = {
                        $and: [{ participant_id: participantId }, timeFilter],
                    };
                    if (school?.aiNumberAssignedAt) {
                        const since = new Date(school.aiNumberAssignedAt);
                        voiceAiQuery = {
                            $and: [
                                { participant_id: participantId },
                                timeFilter,
                                {
                                    $or: [
                                        { created_at: { $gte: since } },
                                        { timestamp: { $gte: since } },
                                    ],
                                },
                            ],
                        };
                    }
                    const rawLogs = await collection.find(voiceAiQuery).sort({ created_at: -1 }).toArray();
                    return rawLogs.map((log) => ({
                        id: log._id.toString(),
                        callerPhone: log.participant_id ? log.participant_id.replace('sip_', '') : 'Unknown',
                        callerName: 'Parent',
                        duration: log.duration_seconds || 0,
                        timestamp: log.created_at || log.timestamp || new Date(),
                        recordingUrl: log.recording_url || null,
                        callType: 'inquiry',
                        summary: '',
                        tourBookingDetected: false,
                        tourBookingDate: null,
                        aiProcessed: false,
                        conversationId: null,
                    }));
                } catch (err) {
                    console.error('[RecentCalls] VoiceAI fetch error:', err);
                    return [];
                }
            })(),
            LeadInsight.find({
                schoolId: schoolObjectId,
                callTimestamp: { $gte: periodStart, $lte: periodEnd },
            })
                .select('webhookId conversationId parentSegment tags summary isHotLead callerName callerPhone durationSeconds tourBooked callTimestamp')
                .lean(),
            LeadInsight.find({ schoolId: schoolObjectId })
                .select('callerPhone callTimestamp webhookId conversationId callerName')
                .lean(),
            ElevenLabsWebhook.find({
                type: 'post_call_transcription',
                schoolId: schoolObjectId,
            })
                .select('_id conversation_id received_at metadata.phone_call metadata.start_time_unix_secs user_id tour_booking_extracted comprehensive_result.parent_name')
                .lean(),
        ]);

        const callsByPhone = new Map();
        const pushHistory = (phone, ts, webhookId, conversationId) => {
            const key = phoneKey(phone);
            if (!key || !ts) return;
            if (!callsByPhone.has(key)) callsByPhone.set(key, []);
            callsByPhone.get(key).push({
                ts,
                webhookId: webhookId ? String(webhookId) : '',
                conversationId: conversationId ? String(conversationId) : '',
            });
        };
        for (const row of phoneHistoryRows) {
            pushHistory(
                row.callerPhone,
                row.callTimestamp ? new Date(row.callTimestamp).getTime() : 0,
                row.webhookId,
                row.conversationId
            );
        }
        for (const wh of allWebhookMeta) {
            const ts = wh.metadata?.start_time_unix_secs
                ? wh.metadata.start_time_unix_secs * 1000
                : (wh.received_at ? new Date(wh.received_at).getTime() : 0);
            pushHistory(getCallerPhoneFromWebhook(wh, ''), ts, wh._id, wh.conversation_id);
        }
        for (const [key, list] of callsByPhone.entries()) {
            const seen = new Set();
            const deduped = [];
            list.sort((a, b) => a.ts - b.ts || String(a.webhookId).localeCompare(String(b.webhookId)));
            for (const row of list) {
                const id = row.webhookId || `${row.conversationId}:${row.ts}`;
                if (seen.has(id)) continue;
                seen.add(id);
                deduped.push(row);
            }
            callsByPhone.set(key, deduped);
        }

        const resolveCallFrequency = (call) => {
            const key = phoneKey(call.callerPhone);
            if (!key) {
                return { callOrdinal: 1, callCountTotal: 1, callOrdinalLabel: '1st call' };
            }
            const history = callsByPhone.get(key) || [];
            const total = history.length || 1;
            const sessionTs = new Date(call.timestamp).getTime();
            let ordinal = 0;
            for (let i = 0; i < history.length; i++) {
                const row = history[i];
                if (
                    (call.id && row.webhookId === String(call.id))
                    || (call.conversationId && row.conversationId && row.conversationId === String(call.conversationId))
                ) {
                    ordinal = i + 1;
                    break;
                }
            }
            if (!ordinal) {
                ordinal = history.filter((row) => row.ts <= sessionTs).length || 1;
            }
            return {
                callOrdinal: ordinal,
                callCountTotal: total,
                callOrdinalLabel: total > 1
                    ? `${toOrdinal(ordinal)} of ${total} calls`
                    : `${toOrdinal(ordinal)} call`,
            };
        };

        const hasConnectedCalendar = connectedCalendarCount > 0;
        const insightByWebhookId = new Map(
            cachedInsights
                .filter((row) => row.webhookId)
                .map((row) => [String(row.webhookId), row])
        );
        const insightByConversationId = new Map(
            cachedInsights
                .filter((row) => row.conversationId)
                .map((row) => [String(row.conversationId), row])
        );

        const nameHistoryIndex = buildCallerNameHistoryIndex([
            ...phoneHistoryRows.map((row) => ({
                phone: row.callerPhone,
                name: row.callerName,
                timestamp: row.callTimestamp,
                webhookId: row.webhookId,
            })),
            ...allWebhookMeta.map((wh) => ({
                phone: getCallerPhoneFromWebhook(wh, ''),
                name: getCallerNameFromWebhook(wh, null),
                timestamp: wh.metadata?.start_time_unix_secs
                    ? wh.metadata.start_time_unix_secs * 1000
                    : wh.received_at,
                webhookId: wh._id,
            })),
            ...callLogEntries.map((cl) => ({
                phone: cl.from_phone_number,
                name: cl.callerName,
                timestamp: cl.createdAt,
                webhookId: cl._id,
            })),
        ]);

        const resolveName = (phone, specificName = null, callTimestamp = null, webhookId = null) =>
            resolveCallerNameWithPastFallback(nameHistoryIndex, {
                callerName: specificName,
                callerPhone: phone,
                callTimestamp,
                webhookId,
            });

        const buildWebhookLookup = (webhooks) => {
            const byConversationId = new Map();
            const byPhone = new Map();
            for (const wh of webhooks) {
                if (wh.conversation_id) byConversationId.set(wh.conversation_id, wh);
                const rawPhone = getCallerPhoneFromWebhook(wh, '');
                if (!isRealPhoneForLookup(rawPhone)) continue;
                const phone = normalizePhone(rawPhone);
                if (!phone) continue;
                if (!byPhone.has(phone)) byPhone.set(phone, []);
                byPhone.get(phone).push(wh);
            }
            return { byConversationId, byPhone };
        };

        const findWebhookForCall = (call, lookup) => {
            if (call.conversationId && lookup.byConversationId.has(call.conversationId)) {
                return lookup.byConversationId.get(call.conversationId);
            }
            if (isWidgetCallerId(call.callerPhone)) return null;
            const phone = normalizePhone(call.callerPhone);
            const candidates = lookup.byPhone.get(phone) || [];
            if (!candidates.length) return null;
            const callTime = new Date(call.timestamp).getTime();
            let best = null;
            let bestDelta = Infinity;
            for (const wh of candidates) {
                const t = wh.metadata?.start_time_unix_secs
                    ? wh.metadata.start_time_unix_secs * 1000
                    : new Date(wh.received_at).getTime();
                const delta = Math.abs(t - callTime);
                if (delta < bestDelta && delta <= 180000) {
                    bestDelta = delta;
                    best = wh;
                }
            }
            return best;
        };

        const webhookCalls = schoolWebhooks.map((wh) => {
            const callTimestamp = wh.metadata?.start_time_unix_secs
                ? new Date(wh.metadata.start_time_unix_secs * 1000)
                : wh.received_at;
            const bookingConfirmed = hasConnectedCalendar && Boolean(wh.tour_booking_detected);
            const identity = resolveName(
                getCallerPhoneFromWebhook(wh, ''),
                getCallerNameFromWebhook(wh, null),
                callTimestamp,
                wh._id
            );
            return {
                id: wh._id.toString(),
                conversationId: wh.conversation_id,
                callerPhone: getCallerPhoneFromWebhook(wh, 'Web Widget'),
                callerName: identity.callerName,
                usedPastCallName: identity.usedPastCallName,
                duration: getCallDurationSeconds(wh),
                timestamp: callTimestamp,
                recordingUrl: wh.conversation_id
                    ? `${backendUrl}/api/school/calls/${wh.conversation_id}/audio?token=${userToken}`
                    : null,
                callType: 'inquiry',
                summary: resolveWebhookSummary(wh),
                tourBookingDetected: bookingConfirmed,
                tourBookingDate: bookingConfirmed ? (wh.tour_booking_date || null) : null,
                aiProcessed: wh.ai_processed || false,
            };
        });

        const callLogCalls = callLogEntries.map((cl) => {
            const identity = resolveName(cl.from_phone_number || '', cl.callerName, cl.createdAt, cl._id);
            return {
            id: cl._id.toString(),
            conversationId: cl.conversation_id,
            callerPhone: cl.from_phone_number || 'Unknown',
            callerName: identity.callerName,
            usedPastCallName: identity.usedPastCallName,
            duration: cl.duration || 0,
            timestamp: cl.createdAt,
            recordingUrl: cl.conversation_id
                ? `${backendUrl}/api/school/calls/${cl.conversation_id}/audio?token=${userToken}`
                : null,
            callType: cl.callType || 'inquiry',
            summary: cl.summary || '',
            tourBookingDetected: false,
            tourBookingDate: null,
            aiProcessed: true,
        };
        });

        const allCallsMap = new Map();
        voiceAiCalls.forEach((c) => {
            const key = `${normalizePhone(c.callerPhone)}_${new Date(c.timestamp).getTime()}`;
            allCallsMap.set(key, c);
        });
        callLogCalls.forEach((clc) => {
            const key = clc.conversationId || `${normalizePhone(clc.callerPhone)}_${new Date(clc.timestamp).getTime()}`;
            allCallsMap.set(key, clc);
        });
        webhookCalls.forEach((whc) => {
            const convKey = whc.conversationId || `${normalizePhone(whc.callerPhone)}_${new Date(whc.timestamp).getTime()}`;
            if (allCallsMap.has(convKey)) {
                const existing = allCallsMap.get(convKey);
                allCallsMap.set(convKey, { ...existing, ...whc, id: existing.id });
                return;
            }
            const whPhone = normalizePhone(whc.callerPhone);
            const whTime = new Date(whc.timestamp).getTime();
            let voiceKey = null;
            for (const [key, existing] of allCallsMap.entries()) {
                if (existing.conversationId) continue;
                const phone = normalizePhone(existing.callerPhone);
                const callTime = new Date(existing.timestamp).getTime();
                if (phone && phone === whPhone && Math.abs(callTime - whTime) <= 5 * 60 * 1000) {
                    voiceKey = key;
                    break;
                }
            }
            if (voiceKey) {
                const existing = allCallsMap.get(voiceKey);
                allCallsMap.set(voiceKey, { ...existing, ...whc, id: existing.id });
            } else {
                allCallsMap.set(convKey, whc);
            }
        });

        const calls = Array.from(allCallsMap.values())
            .map((c) => {
                const identity = resolveName(c.callerPhone, c.callerName, c.timestamp, c.id);
                return {
                    ...c,
                    callerName: identity.callerName,
                    usedPastCallName: Boolean(c.usedPastCallName || identity.usedPastCallName),
                };
            })
            .filter((c) => isWithinPeriod(c.timestamp, periodStart, periodEnd))
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        const webhookLookup = buildWebhookLookup(schoolWebhooks);

        const resolveCallWebhook = (call) => {
            if (call.conversationId) {
                return schoolWebhooks.find((w) => w.conversation_id === call.conversationId) || null;
            }
            return findWebhookForCall(call, webhookLookup);
        };

        const resolveInsightFromWebhook = (wh) => {
            if (!wh) return null;
            if (wh.comprehensive_result) {
                return mapComprehensiveResult(wh.comprehensive_result, wh);
            }
            return mapSummaryFallback(wh);
        };

        const resolveCachedInsight = (call, wh) => {
            if (wh?._id && insightByWebhookId.has(String(wh._id))) {
                return insightByWebhookId.get(String(wh._id));
            }
            if (call.conversationId && insightByConversationId.has(String(call.conversationId))) {
                return insightByConversationId.get(String(call.conversationId));
            }
            return null;
        };

        const resolveCallParentSegment = (call, wh) => {
            const cached = resolveCachedInsight(call, wh);
            if (cached?.parentSegment) return cached.parentSegment;
            if (wh) {
                return resolveInsightFromWebhook(wh)?.parentSegment || 'unknown';
            }
            if (!call.summary && !call.aiProcessed) return 'unknown';
            return 'new_parent';
        };

        const resolveCallTags = (call, wh) => {
            const cached = resolveCachedInsight(call, wh);
            if (cached?.tags?.length) {
                return ensureTourBookedEmailMissingTag(cached.tags, {
                    tourBooked: wh ? isTourBooked(wh) : Boolean(cached.tourBooked),
                    parentEmail: wh ? resolveParentEmail(wh, wh.comprehensive_result) : '',
                    emailMissing: wh ? isTourBookedEmailMissing(wh) : false,
                });
            }
            if (!wh) return [];
            const fresh = resolveInsightFromWebhook(wh);
            const baseTags = fresh?.tags || [];
            return ensureTourBookedEmailMissingTag(baseTags, {
                tourBooked: isTourBooked(wh),
                parentEmail: resolveParentEmail(wh, wh.comprehensive_result),
                emailMissing: isTourBookedEmailMissing(wh),
            });
        };

        const resolveCallTourEmailMissing = (call, wh, tags = []) => {
            if (tags.some((tag) => String(tag).toLowerCase().includes('email missing'))) {
                return true;
            }
            if (!call.tourBookingDetected) return false;
            let resolvedWh = wh;
            if (!resolvedWh && call.callerPhone) {
                const phone = normalizePhone(call.callerPhone);
                resolvedWh = schoolWebhooks.find((w) => {
                    if (!w.tour_booking_detected) return false;
                    return normalizePhone(getCallerPhoneFromWebhook(w, '')) === phone;
                }) || null;
            }
            if (!resolvedWh) return false;
            return isTourBookedEmailMissing(resolvedWh);
        };

        const resolveCallSummary = (call, wh) => {
            const cached = resolveCachedInsight(call, wh);
            if (wh) return resolveWebhookSummary(wh);
            if (cached?.summary) return cached.summary;
            return call.summary || '';
        };

        // No top-N limit — return every call in the selected window with segment tags
        const recentCalls = calls.map((c) => {
            const wh = resolveCallWebhook(c);
            let tags = resolveCallTags(c, wh);
            if (c.usedPastCallName) tags = withPastCallNameTag(tags);
            const frequency = resolveCallFrequency(c);
            return {
                id: c.id,
                conversationId: c.conversationId || null,
                callerName: c.callerName,
                callerPhone: c.callerPhone,
                callType: c.callType,
                duration: Math.round(Number(c.duration) || 0),
                timestamp: c.timestamp,
                recordingUrl: c.recordingUrl,
                summary: resolveCallSummary(c, wh),
                tourBookingDetected: c.tourBookingDetected || false,
                tourBookingDate: c.tourBookingDate || null,
                tourEmailMissing: resolveCallTourEmailMissing(c, wh, tags),
                tags,
                aiProcessed: c.aiProcessed || false,
                parentSegment: resolveCallParentSegment(c, wh),
                callOrdinal: frequency.callOrdinal,
                callCountTotal: frequency.callCountTotal,
                callOrdinalLabel: frequency.callOrdinalLabel,
            };
        });

        res.json({
            recentCalls,
            period,
            periodStart,
            periodEnd,
            total: recentCalls.length,
        });
    } catch (err) {
        console.error('School recent-calls error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/tour-bookings - All tour bookings for the school
router.get('/tour-bookings', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const bookings = await TourBooking.find({ schoolId })
            .sort({ scheduledAt: -1 })
            .lean();
        res.json(bookings.map(b => ({
            id: b._id.toString(),
            parentName: b.parentName || '',
            phone: b.phone || '',
            email: b.email || '',
            childName: b.childName || '',
            childAge: b.childAge || '',
            reason: b.reason || '',
            scheduledAt: b.scheduledAt,
            calendarProvider: b.calendarProvider || null,
            calendarEmail: b.calendarEmail || '',
            reminderSent: b.reminderSent || false,
        })));
    } catch (err) {
        console.error('Tour bookings error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/inquiry-submissions - All inquiry form submissions
router.get('/inquiry-submissions', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const submissions = await InquirySubmission.find({ schoolId })
            .sort({ submittedAt: -1 })
            .lean();
        res.json(submissions.map(s => ({
            id: s._id.toString(),
            parentName: s.parentName || '',
            email: s.email || '',
            phone: s.phone || '',
            answers: s.answers || [],
            submittedAt: s.submittedAt,
        })));
    } catch (err) {
        console.error('Inquiry submissions error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/daily-insights - Needs-attention calls + today's tour details
router.get('/daily-insights', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        const school = await School.findById(schoolId).select('aiNumber wordCloud').lean();
        const normalizePhone = (p) => (p || '').replace(/\D/g, '');
        const schoolAiNumber = normalizePhone(school?.aiNumber || '');
        const userToken = req.headers.authorization?.split(' ')[1] || '';
        // Always the host the browser is already talking to for this request — not
        // process.env.BACKEND_URL, which is reserved for telling external services
        // (Cartesia's tool/webhook callbacks) how to reach this backend publicly. Reusing
        // it here would route the browser's own audio/asset requests through that same
        // public tunnel (e.g. ngrok in dev), which free-tier ngrok blocks with an HTML
        // interstitial instead of serving the actual response.
        const backendUrl = `${req.protocol}://${req.get('host')}`;

        // Today boundaries (UTC)
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const startedAt = Date.now();

        const [actionNeeded, todaysTourDocs, todayCallsMeta] = await Promise.all([
            loadActionNeededCalls(schoolObjectId, backendUrl, userToken, { since: thirtyDaysAgo }),
            TourBooking.find({
                schoolId,
                scheduledAt: { $gte: todayStart, $lte: todayEnd },
            }).sort({ scheduledAt: 1 }).lean(),
            ElevenLabsWebhook.find({
                type: 'post_call_transcription',
                received_at: { $gte: todayStart, $lte: todayEnd },
                schoolId: schoolObjectId,
            }).select('_id metadata received_at').sort({ received_at: -1 }).lean(),
        ]);

        const wordCloud = school?.wordCloud || [];

        const needsAttention = actionNeeded.filter((call) => {
            const ts = new Date(call.timestamp).getTime();
            return ts >= todayStart.getTime() && ts <= todayEnd.getTime();
        });

        // ── 2. Today's Tours: use cached tour + linked webhook data only (no OpenAI on page load) ──
        const enrichedToursMap = new Map();

        // First, add tours with usable cached AI insights to the map.
        todaysTourDocs.forEach(tour => {
            const questionCount = (tour.questionsAsked || []).filter(q => String(q || '').trim()).length;
            const hasHighlights = Boolean((tour.highlights || '').trim());
            // Do not treat "highlights only" as complete: empty questions must be backfilled from transcript.
            const needsQuestionBackfill = Boolean(tour.aiProcessed && hasHighlights && questionCount === 0);
            const hasUsableCachedInsights =
                tour.aiProcessed &&
                !needsQuestionBackfill &&
                (questionCount > 0 || hasHighlights);

            if (hasUsableCachedInsights) {
                enrichedToursMap.set(tour._id.toString(), {
                    ...tour,
                    id: tour._id.toString(),
                    highlights: tour.highlights || '',
                    callSummary: '' // Will be enriched if webhook found
                });
            }
        });

        // Collect all phone numbers for unprocessed tours in a single query
        const unprocessedTours = todaysTourDocs.filter(tour => {
            const questionCount = (tour.questionsAsked || []).filter(q => String(q || '').trim()).length;
            const hasHighlights = Boolean((tour.highlights || '').trim());
            const needsQuestionBackfill = Boolean(tour.aiProcessed && hasHighlights && questionCount === 0);
            const hasUsableCachedInsights =
                tour.aiProcessed &&
                !needsQuestionBackfill &&
                (questionCount > 0 || hasHighlights);
            return !hasUsableCachedInsights;
        });
        const tourPhones = unprocessedTours.map(tour => normalizePhone(tour.phone)).filter(p => p);

        let allRelevantWebhooks = [];
        if (todaysTourDocs.length > 0) {
            const lookbackStart = new Date(todayStart);
            lookbackStart.setDate(lookbackStart.getDate() - 30);
            allRelevantWebhooks = await ElevenLabsWebhook.find({
                type: 'post_call_transcription',
                schoolId: schoolObjectId,
                received_at: { $gte: lookbackStart },
            })
                .select('-raw_payload -audio_base64')
                .sort({ received_at: -1 })
                .limit(500)
                .lean();
        }

        const normalizeName = (name) =>
            String(name || '')
                .toLowerCase()
                .replace(/[^a-z\s]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

        const getWebhookReceivedMs = (wh) => (
            wh.metadata?.start_time_unix_secs
                ? wh.metadata.start_time_unix_secs * 1000
                : new Date(wh.received_at).getTime()
        );

        const scoreWebhookForTour = (wh, tour) => {
            const tourPhone = normalizePhone(tour.phone);
            const fromPhone = normalizePhone(getCallerPhoneFromWebhook(wh, ''));
            const tourName = normalizeName(tour.parentName);
            const extractedName = normalizeName(wh.comprehensive_result?.parent_name || '');
            const summaryText = normalizeName(wh.summary || wh.comprehensive_result?.summary || '');

            const phoneMatch = Boolean(tourPhone && fromPhone && tourPhone === fromPhone);
            const nameMatch = Boolean(
                tourName && (
                    extractedName.includes(tourName) ||
                    tourName.includes(extractedName) ||
                    summaryText.includes(tourName)
                )
            );

            if (!phoneMatch && !nameMatch) return -1;

            let score = 0;
            if (phoneMatch) score += 8;
            if (nameMatch) score += 5;
            if (wh.tour_booking_detected) score += 10;

            const tourEmail = String(tour.email || '').trim().toLowerCase();
            const whEmail = String(
                wh.comprehensive_result?.parent_email || wh.tour_booking_extracted?.email || ''
            ).trim().toLowerCase();
            if (tourEmail && whEmail && tourEmail === whEmail) score += 30;
            else if (tourEmail && isValidConfirmedEmail(tourEmail) && isValidConfirmedEmail(whEmail)) {
                score -= 5;
            }

            const tourCreatedMs = new Date(tour.createdAt || tour.scheduledAt).getTime();
            const whReceivedMs = getWebhookReceivedMs(wh);
            const createdDeltaMin = Math.abs(tourCreatedMs - whReceivedMs) / (1000 * 60);
            if (createdDeltaMin <= 3) score += 35;
            else if (createdDeltaMin <= 15) score += 20;
            else if (createdDeltaMin <= 60) score += 10;
            else if (createdDeltaMin <= 180) score += 4;

            const tourSchedMs = new Date(tour.scheduledAt).getTime();
            const schedDeltaHours = Math.abs(tourSchedMs - whReceivedMs) / (1000 * 60 * 60);
            score += Math.max(0, 12 - schedDeltaHours);

            return score;
        };

        /**
         * Match a tour booking to the call that created it (not just the latest call from the same phone).
         * @param {Set|null} restrictUsedIds - skips webhooks already linked for batch extraction.
         */
        const linkWebhookToTour = (tour, restrictUsedIds) => {
            const ranked = allRelevantWebhooks
                .map((wh) => ({ wh, score: scoreWebhookForTour(wh, tour) }))
                .filter((entry) => entry.score >= 0)
                .sort((a, b) => b.score - a.score);

            if (ranked.length === 0) return null;

            if (restrictUsedIds) {
                const unused = ranked.find((entry) => !restrictUsedIds.has(String(entry.wh._id)));
                return unused ? unused.wh : ranked[0].wh;
            }

            return ranked[0].wh;
        };

        const usedWebhookIds = new Set();

        // Do not run OpenAI during page load — use cached tour fields and linked webhook summaries only.
        unprocessedTours.forEach(tour => {
            const linkedWebhook = linkWebhookToTour(tour, usedWebhookIds);

            if (linkedWebhook) {
                usedWebhookIds.add(String(linkedWebhook._id));
            }

            enrichedToursMap.set(tour._id.toString(), {
                ...tour,
                id: tour._id.toString(),
                linkedWebhook: linkedWebhook || null,
                callSummary: linkedWebhook?.summary || tour.highlights || '',
            });
        });

        const todaysTours = todaysTourDocs.map(tour => {
            const enriched = enrichedToursMap.get(tour._id.toString()) || { ...tour, id: tour._id.toString() };
            const wh = linkWebhookToTour(tour, null);
            const summaryForQuestions = wh?.summary || enriched.highlights || tour.highlights || '';
            const questionsAsked = filterSchoolQuestions(mergeQuestionLists(
                enriched.questionsAsked,
                mergeParentQuestionsFromExtraction(wh?.comprehensive_result, { summaryText: summaryForQuestions })
            ));
            const tourTalkingPoints = extractTourTalkingPoints(wh?.comprehensive_result);
            const linked = enriched.linkedWebhook || wh;
            const tourEmailOptions = { extraEmails: [enriched.email] };
            const tourTags = (() => {
                const fromExtracted = Array.isArray(linked?.extractedTags) ? linked.extractedTags : [];
                const fromComprehensive = Array.isArray(wh?.comprehensive_result?.tags)
                    ? wh.comprehensive_result.tags
                    : [];
                const baseTags = fromExtracted.length ? fromExtracted : fromComprehensive;
                const tourBooked = Boolean(wh?.tour_booking_detected);
                const parentEmail = wh
                    ? resolveParentEmail(wh, wh?.comprehensive_result, tourEmailOptions)
                    : (isValidConfirmedEmail(enriched.email) ? String(enriched.email).trim() : '');
                const emailMissing = wh
                    ? isTourBookedEmailMissing(wh, wh?.comprehensive_result, tourEmailOptions)
                    : !isValidConfirmedEmail(enriched.email);
                if (baseTags.length || tourBooked) {
                    return ensureTourBookedEmailMissingTag(baseTags, {
                        tourBooked,
                        parentEmail,
                        emailMissing,
                    });
                }
                if (emailMissing) {
                    return ensureTourBookedEmailMissingTag([], { tourBooked: true, parentEmail: '', emailMissing: true });
                }
                return [];
            })();
            const resolvedTourEmail = wh
                ? resolveParentEmail(wh, wh?.comprehensive_result, tourEmailOptions)
                : (isValidConfirmedEmail(enriched.email) ? String(enriched.email).trim() : '');
            return {
                id: enriched.id,
                parentName: enriched.parentName || 'Parent',
                phone: enriched.phone || '',
                email: resolvedTourEmail || (isValidConfirmedEmail(enriched.email) ? String(enriched.email).trim() : ''),
                childName: enriched.childName || '',
                childAge: enriched.childAge || '',
                reason: enriched.reason || enriched.purpose || 'Enrollment Inquiry',
                scheduledAt: enriched.scheduledAt,
                calendarProvider: enriched.calendarProvider || null,
                questionsAsked,
                tourTalkingPoints,
                highlights: enriched.highlights || enriched.notes || '',
                callSummary: enriched.callSummary || wh?.summary || '',
                reminderSent: enriched.reminderSent || false,
                tags: tourTags,
                language: linked?.extractedLanguage || '',
            };
        });

        const todayCalls = todayCallsMeta.map(wh => ({
            id: wh._id.toString(),
            timestamp: wh.metadata?.start_time_unix_secs
                ? new Date(wh.metadata.start_time_unix_secs * 1000)
                : wh.received_at,
        }));

        res.json({
            needsAttention,
            actionNeeded,
            todaysTours,
            wordCloud,
            todayCalls,
            hotLeads: actionNeeded.filter((call) => call.isHotLead),
            warmLeads: actionNeeded.filter((call) => call.leadTemperature === 'warm'),
        });
        console.log(
            `[DailyInsights] school=${schoolId} actionNeeded=${actionNeeded.length} tours=${todaysTours.length} todayCalls=${todayCalls.length} ${Date.now() - startedAt}ms`
        );
    } catch (err) {
        console.error('Daily insights error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/action-needed - All action-needed items (not just today)
router.get('/action-needed', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        const school = await School.findById(schoolId).select('aiNumber').lean();
        const normalizePhone = (p) => (p || '').replace(/\D/g, '');
        const schoolAiNumber = normalizePhone(school?.aiNumber || '');
        const userToken = req.headers.authorization?.split(' ')[1] || '';
        // Always the host the browser is already talking to for this request — not
        // process.env.BACKEND_URL, which is reserved for telling external services
        // (Cartesia's tool/webhook callbacks) how to reach this backend publicly. Reusing
        // it here would route the browser's own audio/asset requests through that same
        // public tunnel (e.g. ngrok in dev), which free-tier ngrok blocks with an HTML
        // interstitial instead of serving the actual response.
        const backendUrl = `${req.protocol}://${req.get('host')}`;

        // Get calls from the last 30 days that need action
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const actionNeeded = await loadActionNeededCalls(schoolObjectId, backendUrl, userToken);

        res.json({
            actionNeeded,
            hotLeads: actionNeeded.filter((call) => call.isHotLead),
            warmLeads: actionNeeded.filter((call) => call.leadTemperature === 'warm'),
        });
    } catch (err) {
        console.error('Action needed error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/action-needed/:id/mark-action-taken - Mark an item as action taken
router.post('/action-needed/:id/mark-action-taken', async (req, res) => {
    try {
        const { id } = req.params;
        const { feedback } = req.body; // Optional feedback from the user
        
        const schoolId = req.user.schoolId;
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);

        // Find and update the webhook entry
        const webhook = await ElevenLabsWebhook.findOneAndUpdate(
            {
                _id: id,
                schoolId: schoolObjectId
            },
            {
                actionTakenFeedback: feedback || '',
                $push: {
                    feedbackHistory: {
                        feedback: feedback || '',
                        timestamp: new Date().toISOString(),
                        userId: req.user.id
                    }
                }
            },
            { new: true }
        );

        if (!webhook) {
            return res.status(404).json({ error: 'Action needed item not found' });
        }

        await markLeadInsightActionTaken(webhook._id, feedback || '');

        res.json({ 
            success: true, 
            message: 'Item marked as action taken successfully',
            itemId: id 
        });
    } catch (err) {
        console.error('Mark action taken error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/school/action-needed/:id - Permanently delete a webhook from the database
router.delete('/action-needed/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const schoolId = req.user.schoolId;
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        const webhookObjectId = new mongoose.Types.ObjectId(id);

        console.log(`[DELETE] Attempting to delete webhook: id=${id}, schoolId=${schoolId}`);
        console.log(`[DELETE] webhookObjectId=${webhookObjectId}, schoolObjectId=${schoolObjectId}`);

        // First, check if the webhook exists
        const existingWebhook = await ElevenLabsWebhook.findOne({
            _id: webhookObjectId,
            schoolId: schoolObjectId
        });

        console.log(`[DELETE] Existing webhook found:`, existingWebhook ? 'YES' : 'NO');

        if (!existingWebhook) {
            // Try to find by string ID as fallback
            const webhookByStringId = await ElevenLabsWebhook.findOne({
                _id: id,
                schoolId: schoolObjectId
            });
            console.log(`[DELETE] Webhook found by string ID:`, webhookByStringId ? 'YES' : 'NO');

            if (webhookByStringId) {
                // Delete using string ID
                await ElevenLabsWebhook.deleteOne({ _id: id, schoolId: schoolObjectId });
                console.log(`[DELETE] Deleted webhook using string ID: ${id}`);
                return res.json({ 
                    success: true, 
                    message: 'Item permanently deleted',
                    itemId: id 
                });
            }

            // Try to find without schoolId constraint
            const webhookWithoutSchool = await ElevenLabsWebhook.findOne({ _id: webhookObjectId });
            console.log(`[DELETE] Webhook found without schoolId:`, webhookWithoutSchool ? 'YES' : 'NO', webhookWithoutSchool ? `schoolId=${webhookWithoutSchool.schoolId}` : '');

            if (webhookWithoutSchool) {
                console.log(`[DELETE] Webhook exists but schoolId mismatch. Requested: ${schoolId}, Actual: ${webhookWithoutSchool.schoolId}`);
            }

            console.log(`[DELETE] Webhook not found for id: ${id}, schoolId: ${schoolId}`);
            return res.status(404).json({ error: 'Webhook not found' });
        }

        // Delete the webhook
        const webhook = await ElevenLabsWebhook.findOneAndDelete({
            _id: webhookObjectId,
            schoolId: schoolObjectId
        });

        console.log(`[DELETE] Permanently deleted webhook ${id} from school ${schoolId}`);
        await removeLeadInsightForWebhook(webhookObjectId);
        
        res.json({ 
            success: true, 
            message: 'Item permanently deleted',
            itemId: id 
        });
    } catch (err) {
        console.error('Delete webhook error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/wordcloud/generate - Manually trigger word cloud generation
router.post('/wordcloud/generate', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);
        const school = await School.findById(schoolId).select('aiNumber').lean();
        const normalizePhone = (p) => (p || '').replace(/\D/g, '');
        const schoolAiNumber = normalizePhone(school?.aiNumber || '');

        const wordCloudStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        const wordCloudWebhooks = await ElevenLabsWebhook.find({
            type: 'post_call_transcription',
            received_at: { $gte: wordCloudStart, $lte: todayEnd },
            schoolId: schoolObjectId
        })
            .select('transcript')
            .sort({ received_at: -1 })
            .limit(500)
            .lean();

        const allTranscripts = wordCloudWebhooks
            .map(wh =>
                Array.isArray(wh.transcript)
                    ? wh.transcript.map(t => `${t.role}: ${t.message || t.text}`).join('\n')
                    : ''
            )
            .filter(Boolean);

        const wordCloud = await generateWordCloud(allTranscripts);
        
        // Save to school
        await School.findByIdAndUpdate(schoolId, { wordCloud });

        res.json({ wordCloud });
    } catch (err) {
        console.error('Word cloud generation error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/call-logs - Fetch detailed call logs from voiceAI collection in benny DB
// GET /api/school/call-logs - Fetch detailed call logs from both VoiceAI and ElevenLabs
router.get('/call-logs', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const school = await School.findById(schoolId).select('aiNumber aiNumberAssignedAt elevenlabsAgentId createdAt').lean();

        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const { resolveDashboardPeriod, isWithinPeriod } = require('../utils/dashboardPeriod');
        // Default to all-time so schools see every call, not a truncated window.
        const periodQuery = { ...req.query, period: req.query.period || 'all' };
        if (periodQuery.period === 'all' && !periodQuery.startDate && school.aiNumberAssignedAt) {
            periodQuery.startDate = new Date(school.aiNumberAssignedAt).toISOString().slice(0, 10);
        } else if (periodQuery.period === 'all' && !periodQuery.startDate && school.createdAt) {
            periodQuery.startDate = new Date(school.createdAt).toISOString().slice(0, 10);
        }
        const periodWindow = resolveDashboardPeriod(periodQuery);
        if (periodWindow.error) {
            return res.status(400).json({ error: periodWindow.error });
        }
        const { period, periodStart, periodEnd } = periodWindow;
        const startUnix = Math.floor(periodStart.getTime() / 1000);
        const endUnix = Math.floor(periodEnd.getTime() / 1000);

        const userToken = req.headers.authorization?.split(' ')[1] || '';
        // Always the host the browser is already talking to for this request — not
        // process.env.BACKEND_URL, which is reserved for telling external services
        // (Cartesia's tool/webhook callbacks) how to reach this backend publicly. Reusing
        // it here would route the browser's own audio/asset requests through that same
        // public tunnel (e.g. ngrok in dev), which free-tier ngrok blocks with an HTML
        // interstitial instead of serving the actual response.
        const backendUrl = `${req.protocol}://${req.get('host')}`;

        const normalizePhone = (phone) => {
            if (!phone) return '';
            return phone.replace(/\D/g, '');
        };

        const schoolAiNumber = normalizePhone(school.aiNumber || '');
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);

        const phoneKey = (phone) => {
            const digits = normalizePhone(phone);
            if (digits.length >= 10) return digits.slice(-10);
            return digits.length >= 7 ? digits : '';
        };

        const toOrdinal = (n) => {
            const num = Number(n) || 0;
            const mod100 = num % 100;
            if (mod100 >= 11 && mod100 <= 13) return `${num}th`;
            switch (num % 10) {
                case 1: return `${num}st`;
                case 2: return `${num}nd`;
                case 3: return `${num}rd`;
                default: return `${num}th`;
            }
        };

        // Webhooks + LeadInsight are the source of truth for caller identity and tags.
        // phoneHistory is all-time so "3rd call" is correct even inside a filtered window.
        const [webhooks, cachedInsights, phoneHistoryRows, allWebhookMeta] = await Promise.all([
            ElevenLabsWebhook.find({
                type: 'post_call_transcription',
                schoolId: schoolObjectId,
                $or: [
                    { received_at: { $gte: periodStart, $lte: periodEnd } },
                    {
                        'metadata.start_time_unix_secs': {
                            $gte: startUnix,
                            $lte: endUnix,
                        },
                    },
                ],
            })
                .select('-raw_payload -audio_base64')
                .sort({ received_at: -1 })
                .lean(),
            LeadInsight.find({
                schoolId: schoolObjectId,
                $or: [
                    { callTimestamp: { $gte: periodStart, $lte: periodEnd } },
                    { callTimestamp: null, createdAt: { $gte: periodStart, $lte: periodEnd } },
                ],
            })
                .select('webhookId conversationId parentSegment tags summary callerName callerPhone callTimestamp')
                .lean(),
            LeadInsight.find({ schoolId: schoolObjectId })
                .select('callerPhone callTimestamp webhookId conversationId callerName')
                .lean(),
            ElevenLabsWebhook.find({
                type: 'post_call_transcription',
                schoolId: schoolObjectId,
            })
                .select('_id conversation_id received_at metadata.phone_call metadata.start_time_unix_secs user_id tour_booking_extracted comprehensive_result.parent_name')
                .lean(),
        ]);

        const nameHistoryIndex = buildCallerNameHistoryIndex([
            ...phoneHistoryRows.map((row) => ({
                phone: row.callerPhone,
                name: row.callerName,
                timestamp: row.callTimestamp,
                webhookId: row.webhookId,
            })),
            ...allWebhookMeta.map((wh) => ({
                phone: getCallerPhoneFromWebhook(wh, ''),
                name: getCallerNameFromWebhook(wh, null),
                timestamp: wh.metadata?.start_time_unix_secs
                    ? wh.metadata.start_time_unix_secs * 1000
                    : wh.received_at,
                webhookId: wh._id,
            })),
        ]);

        const callsByPhone = new Map();
        const pushHistory = (phone, ts, webhookId, conversationId) => {
            const key = phoneKey(phone);
            if (!key || !ts) return;
            if (!callsByPhone.has(key)) callsByPhone.set(key, []);
            callsByPhone.get(key).push({
                ts,
                webhookId: webhookId ? String(webhookId) : '',
                conversationId: conversationId ? String(conversationId) : '',
            });
        };

        for (const row of phoneHistoryRows) {
            pushHistory(
                row.callerPhone,
                row.callTimestamp ? new Date(row.callTimestamp).getTime() : 0,
                row.webhookId,
                row.conversationId
            );
        }
        for (const wh of allWebhookMeta) {
            const ts = wh.metadata?.start_time_unix_secs
                ? wh.metadata.start_time_unix_secs * 1000
                : (wh.received_at ? new Date(wh.received_at).getTime() : 0);
            pushHistory(getCallerPhoneFromWebhook(wh, ''), ts, wh._id, wh.conversation_id);
        }
        // Dedupe identical webhook entries, keep chronological order
        for (const [key, list] of callsByPhone.entries()) {
            const seen = new Set();
            const deduped = [];
            list.sort((a, b) => a.ts - b.ts || String(a.webhookId).localeCompare(String(b.webhookId)));
            for (const row of list) {
                const id = row.webhookId || `${row.conversationId}:${row.ts}`;
                if (seen.has(id)) continue;
                seen.add(id);
                deduped.push(row);
            }
            callsByPhone.set(key, deduped);
        }

        const resolveCallFrequency = (session) => {
            const key = phoneKey(session.participantId);
            if (!key) {
                return { callOrdinal: 1, callCountTotal: 1, callOrdinalLabel: '1st call' };
            }
            const history = callsByPhone.get(key) || [];
            const total = history.length || 1;
            const sessionTs = new Date(session.createdAt).getTime();
            let ordinal = 0;
            for (let i = 0; i < history.length; i++) {
                const row = history[i];
                if (
                    (session.id && row.webhookId === String(session.id))
                    || (session.sessionId && row.conversationId && row.conversationId === String(session.sessionId))
                ) {
                    ordinal = i + 1;
                    break;
                }
            }
            if (!ordinal) {
                // Fallback: count how many prior/equal timestamp calls from this number
                ordinal = history.filter((row) => row.ts <= sessionTs).length || 1;
            }
            return {
                callOrdinal: ordinal,
                callCountTotal: total,
                callOrdinalLabel: total > 1
                    ? `${toOrdinal(ordinal)} of ${total} calls`
                    : `${toOrdinal(ordinal)} call`,
            };
        };

        const insightByWebhookId = new Map(
            cachedInsights.filter((row) => row.webhookId).map((row) => [String(row.webhookId), row])
        );
        const insightByConversationId = new Map(
            cachedInsights.filter((row) => row.conversationId).map((row) => [String(row.conversationId), row])
        );

        const resolveInsightForWebhook = (wh) => {
            if (wh?._id && insightByWebhookId.has(String(wh._id))) {
                return insightByWebhookId.get(String(wh._id));
            }
            if (wh?.conversation_id && insightByConversationId.has(String(wh.conversation_id))) {
                return insightByConversationId.get(String(wh.conversation_id));
            }
            return null;
        };

        const resolveFreshInsight = (wh) => {
            if (!wh) return null;
            if (wh.comprehensive_result) {
                return mapComprehensiveResult(wh.comprehensive_result, wh);
            }
            return mapSummaryFallback(wh);
        };

        // Optional VoiceAI recordings keyed by time (SIP participant is the school number, not caller).
        const voiceRecordingByTime = [];
        if (schoolAiNumber) {
            try {
                const participantId = `sip_+${schoolAiNumber}`;
                const bennyDb = mongoose.connection.useDb('benny');
                const collection = bennyDb.collection('voiceAI');
                const timeFilter = {
                    $or: [
                        { created_at: { $gte: periodStart, $lte: periodEnd } },
                        { timestamp: { $gte: periodStart, $lte: periodEnd } },
                    ],
                };
                const rawLogs = await collection.find({
                    $and: [{ participant_id: participantId }, timeFilter],
                }).project({
                    recording_url: 1,
                    duration_seconds: 1,
                    created_at: 1,
                    timestamp: 1,
                    transcript_summary: 1,
                }).toArray();
                for (const log of rawLogs) {
                    const t = log.created_at || log.timestamp;
                    if (!t || !isWithinPeriod(t, periodStart, periodEnd)) continue;
                    if (!log.recording_url) continue;
                    voiceRecordingByTime.push({
                        at: new Date(t).getTime(),
                        recordingUrl: log.recording_url,
                        duration: log.duration_seconds || 0,
                        summary: log.transcript_summary || '',
                    });
                }
            } catch (err) {
                console.error('[CallLogs] VoiceAI error:', err);
            }
        }

        const findNearbyVoiceRecording = (callMs) => {
            let best = null;
            let bestDelta = Infinity;
            for (const row of voiceRecordingByTime) {
                const delta = Math.abs(row.at - callMs);
                if (delta < bestDelta && delta <= 5 * 60 * 1000) {
                    bestDelta = delta;
                    best = row;
                }
            }
            return best;
        };

        const finalSessionsMap = new Map();

        for (const wh of webhooks) {
            const callTimestamp = wh.metadata?.start_time_unix_secs
                ? new Date(wh.metadata.start_time_unix_secs * 1000)
                : wh.received_at;
            if (!isWithinPeriod(callTimestamp, periodStart, periodEnd)) continue;

            const cached = resolveInsightForWebhook(wh);
            const fresh = resolveFreshInsight(wh);
            const parentSegment = cached?.parentSegment || fresh?.parentSegment || 'unknown';
            const baseTags = (cached?.tags?.length ? cached.tags : (fresh?.tags || []));
            const callerNameFromWebhook = getCallerNameFromWebhook(wh, null);
            const cachedOrWebhookName = isUsableCallerName(cached?.callerName)
                ? String(cached.callerName).trim()
                : (isUsableCallerName(callerNameFromWebhook) ? String(callerNameFromWebhook).trim() : null);
            const identity = resolveCallerNameWithPastFallback(nameHistoryIndex, {
                callerName: cachedOrWebhookName,
                callerPhone: getCallerPhoneFromWebhook(wh, ''),
                callTimestamp,
                webhookId: wh._id,
            });
            let tags = ensureTourBookedEmailMissingTag(baseTags, {
                tourBooked: isTourBooked(wh),
                parentEmail: resolveParentEmail(wh, wh.comprehensive_result),
                emailMissing: isTourBookedEmailMissing(wh),
            });
            if (identity.usedPastCallName) {
                tags = withPastCallNameTag(tags);
            }
            const callerName = identity.usedPastCallName || isUsableCallerName(identity.callerName)
                ? identity.callerName
                : null;

            const transcript = Array.isArray(wh.transcript)
                ? wh.transcript.map((t) => ({
                    role: t.role === 'agent' ? 'Assistant' : 'Parent',
                    text: t.message || t.text || '',
                    timestamp: t.time_in_call_secs
                        ? new Date(new Date(wh.received_at).getTime() + t.time_in_call_secs * 1000)
                        : wh.received_at,
                })).filter((t) => t.text)
                : [];

            const callMs = new Date(callTimestamp).getTime();
            const nearbyVoice = findNearbyVoiceRecording(callMs);
            const recordingUrl = wh.conversation_id
                ? `${backendUrl}/api/school/calls/${wh.conversation_id}/audio?token=${userToken}`
                : (nearbyVoice?.recordingUrl || null);

            const key = wh.conversation_id || `${normalizePhone(getCallerPhoneFromWebhook(wh, ''))}_${callMs}`;
            finalSessionsMap.set(key, {
                id: wh._id.toString(),
                sessionId: wh.conversation_id,
                participantId: getCallerPhoneFromWebhook(wh, 'Unknown'),
                callerName,
                transcript,
                summary: resolveWebhookSummary(wh) || cached?.summary || nearbyVoice?.summary || '',
                recordingUrl,
                duration: getCallDurationSeconds(wh) || nearbyVoice?.duration || 0,
                createdAt: callTimestamp,
                parentSegment,
                tags,
            });
        }

        const sortedLogs = Array.from(finalSessionsMap.values())
            .map((session) => {
                if (Array.isArray(session.transcript)) {
                    session.transcript.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                } else {
                    session.transcript = [];
                }
                session.parentSegment = session.parentSegment || 'unknown';
                session.tags = Array.isArray(session.tags) ? session.tags : [];
                // Keep segment label in tags for UI consistency
                const segmentLabel =
                    session.parentSegment === 'current_family' ? 'Current Family'
                        : session.parentSegment === 'unknown' ? 'Unknown'
                            : 'New Parent';
                if (!session.tags.some((t) => String(t).toLowerCase() === segmentLabel.toLowerCase())) {
                    session.tags = [segmentLabel, ...session.tags];
                }
                session.callerName = isUsableCallerName(session.callerName)
                    ? String(session.callerName).trim()
                    : null;
                const frequency = resolveCallFrequency(session);
                session.callOrdinal = frequency.callOrdinal;
                session.callCountTotal = frequency.callCountTotal;
                session.callOrdinalLabel = frequency.callOrdinalLabel;
                return session;
            })
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        console.log(`[CallLogs] school=${schoolId} period=${period} total=${sortedLogs.length} webhooks=${webhooks.length}`);

        // Return a bare array for backward compatibility with older frontends that do
        // `setLogs(res.data)` then `logs.map(...)`. Newer clients also accept this shape.
        res.json(sortedLogs);
    } catch (err) {
        console.error('Call logs error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/calls/:conversationId/audio - Serve the recorded audio for a conversation
router.get('/calls/:conversationId/audio', async (req, res) => {
    try {
        const { conversationId } = req.params;
        const schoolId = req.user.schoolId;
        const schoolObjectId = new mongoose.Types.ObjectId(schoolId);

        // ── Strategy 1: Check Local Cache (Webhook base64) ────────────────
        const audioWebhook = await ElevenLabsWebhook.findOne({
            conversation_id: conversationId,
            type: 'post_call_audio',
            schoolId: schoolObjectId,
        }).select('audio_base64').lean();

        if (audioWebhook && audioWebhook.audio_base64) {
            console.log(`[Audio] Serving from cache: ${conversationId}`);
            const audioBuffer = Buffer.from(audioWebhook.audio_base64, 'base64');
            return sendAudioBufferWithRange(req, res, audioBuffer);
        }

        // ── Strategy 2: Mock/Test Fallback ────────────────
        if (conversationId.startsWith('test_conv_')) {
            console.log(`[Audio] Serving mock silence for test ID: ${conversationId}`);
            // 1 second of silence (tiny valid MP3)
            const silentMp3 = Buffer.from('SUQzBAAAAAABAFRYWFgAAAASAAADbWFqb3JfYnJhbmQAZGFzaABUWFhYAAAAEQAAAD1taW5vcl92ZXJzaW9uADBUWFhYAAAAHAAAAHByZWRvbWluYW50X2JyYW5kAGlzbzZtcDQxAFRTU0UAAAAPAAADTGF2ZjYwLjMuMTAwAAAAAAAAAAAAAAD/80MUAAAAAAAAAAAAAAAAAAAAAABYaW5nAAAADwAAABIAABm6AAAAAAAAAAAAAAAAAAAAAP/zQxQEAAB8AAAAAA', 'base64');
            return sendAudioBufferWithRange(req, res, silentMp3);
        }

        // ── Strategy 3: Fetch Directly from the school's voice provider (Proxy) ────────
        try {
            const school = await School.findById(schoolObjectId).select('voiceProvider').lean();
            const provider = getProvider(school?.voiceProvider || 'elevenlabs');
            console.log(`[Audio Proxy] Requesting: ${conversationId} via ${school?.voiceProvider || 'elevenlabs'}`);
            const audio = await provider.getConversationAudio(conversationId);
            if (audio?.buffer) {
                console.log(`[Audio Proxy] Success for: ${conversationId}`);
                return sendAudioBufferWithRange(req, res, audio.buffer, audio.contentType);
            }
        } catch (proxyErr) {
            console.warn(`[Audio Proxy] Failed for ${conversationId}: ${proxyErr.response?.status || proxyErr.message}`);
            // If it's 404 and we're in dev/test, we could return silence too,
            // but let's only do it for test_conv_ prefix for now.
        }

        return res.status(404).json({ error: 'Audio recording not found' });
    } catch (err) {
        console.error('[Audio Error]:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/integrations - School's integrations
router.get('/integrations', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const integrations = await Integration.find({ schoolId }).lean();

        const types = ['google', 'outlook'];
        const formatted = types.map(type => {
            const existing = integrations.find(i => i.type === type);
            if (existing) {
                return {
                    id: existing._id.toString(),
                    name: existing.name,
                    type: existing.type,
                    connected: existing.connected,
                    connectedAt: existing.connectedAt,
                    email: existing.config?.userEmail || existing.config?.account?.username || null,
                };
            }
            return {
                id: type,
                name: type === 'google' ? 'Google Workspace' : 'Microsoft Outlook',
                type: type,
                connected: false,
                connectedAt: null,
                email: null,
            };
        });

        res.json(formatted);
    } catch (err) {
        console.error('School integrations error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/integrations/:type/connect
router.post('/integrations/:type/connect', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { type } = req.params;

        if (!['outlook', 'google'].includes(type)) {
            return res.status(400).json({ error: 'Invalid integration type' });
        }

        let authUrl = null;
        if (type === 'google') {
            authUrl = getGoogleAuthUrl(schoolId);
        } else if (type === 'outlook') {
            authUrl = await getOutlookAuthUrl(schoolId);
        }

        if (!authUrl) {
            return res.status(400).json({
                error: `${type === 'google' ? 'Google' : 'Outlook'} OAuth is not configured. Add the required credentials to the server .env file.`
            });
        }

        res.json({ message: `${type} connection initiated`, authUrl });
    } catch (err) {
        console.error('Connect integration error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/integrations/:type/disconnect
router.post('/integrations/:type/disconnect', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { type } = req.params;

        await Integration.deleteMany({ schoolId, type });

        res.json({ message: `${type} disconnected successfully` });
    } catch (err) {
        console.error('Disconnect integration error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/detect-timezone?address=...
router.get('/detect-timezone', async (req, res) => {
    try {
        const { address } = req.query;
        if (!address || String(address).trim().length < 5) {
            return res.status(400).json({ error: 'Address is too short to detect timezone.' });
        }
        const { getTimezoneFromAddress } = require('../utils/timezone');
        const timezone = await getTimezoneFromAddress(String(address).trim());
        if (!timezone) {
            return res.status(404).json({ error: 'Could not detect timezone for this address. Please select manually.' });
        }
        res.json({ timezone });
    } catch (err) {
        console.error('[detect-timezone] Error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/settings
router.get('/settings', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        console.log('[GET /settings] schoolId:', schoolId);

        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this account' });
        }

        const school = await School.findById(schoolId).lean();

        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const qaPairs = (school.qaPairs || []).map(p => ({
            question: p.question || '',
            answer: p.answer || ''
        }));

        console.log('[GET /settings] qaPairs count:', qaPairs.length);

        const integrations = await require('../models/Integration').find({ schoolId, connected: true }).lean();
        const googleConnected = integrations.some(i => i.type === 'google');
        const outlookConnected = integrations.some(i => i.type === 'outlook');

        const normalizedLanguage = ['EN', 'ES'].includes(String(school.language || '').toUpperCase())
            ? String(school.language || '').toUpperCase()
            : 'EN';

        res.json({
            id: school._id.toString(),
            name: school.name,
            address: school.address || '',
            timezone: 'America/Chicago', // Forced global CST
            aiNumber: school.aiNumber || '',
            routingNumber: school.routingNumber || '',
            language: normalizedLanguage,
            businessHoursStart: school.businessHoursStart || '09:00',
            businessHoursEnd: school.businessHoursEnd || '17:00',
            smsAutoFollowup: school.smsAutoFollowup || false,
            emailAutoFollowup: school.emailAutoFollowup || false,
            smsTemplate: school.smsTemplate || 'Thank you for your interest in our school! Please complete our inquiry form here: {form_link}',
            emailTemplate: school.emailTemplate || 'Dear {parent_name},\n\nThank you for contacting us regarding enrollment at {school_name}.\n\nPlease find the inquiry form at: {form_link}\n\nWarm regards,\n{school_name}',
            qaPairs,
            knowledgeBaseDocumentId: school.knowledgeBaseDocumentId || '',
            adminEmail: (school.adminEmail || '').trim(),
            preferredCalendar: school.preferredCalendar || 'google',
            preferredEmailProvider: school.preferredEmailProvider || 'google',
            elevenlabsAgentId: school.elevenlabsAgentId || '',
            enableHumanTransfer: Boolean(school.enableHumanTransfer),
            humanTransferCondition: school.humanTransferCondition || '',
            humanTransferPhoneNumber: school.humanTransferPhoneNumber || '',
            tourConfirmationEmailTemplate: school.tourConfirmationEmailTemplate || '',
            tourReminderSmsTemplate: school.tourReminderSmsTemplate || '',
            googleConnected,
            outlookConnected,
        });
    } catch (err) {
        console.error('[GET /settings] Error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/school/settings
router.put('/settings', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        console.log('[PUT /settings] schoolId:', schoolId);
        console.log('[PUT /settings] body keys:', Object.keys(req.body));
        console.log('[PUT /settings] qaPairs received:', Array.isArray(req.body.qaPairs) ? req.body.qaPairs.length + ' pairs' : 'not an array / missing');

        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this account' });
        }

        // Use findById + save() — most reliable for Mongoose subdocument arrays
        const school = await School.findById(schoolId);

        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const {
            name, address, timezone, aiNumber, routingNumber, language,
            businessHoursStart, businessHoursEnd,
            smsAutoFollowup, emailAutoFollowup, smsTemplate, emailTemplate,
            qaPairs, preferredCalendar, preferredEmailProvider, adminEmail, elevenlabsAgentId,
            tourConfirmationEmailTemplate, tourReminderSmsTemplate,
            enableHumanTransfer, humanTransferCondition, humanTransferPhoneNumber
        } = req.body;

        const adminEmailUpdate = adminEmail !== undefined
            ? String(adminEmail || '').trim()
            : null;

        // Capture old values BEFORE overwriting (for change detection)
        const oldAddress = school.address;
        const oldEnableHumanTransfer = Boolean(school.enableHumanTransfer);
        const oldHumanTransferCondition = school.humanTransferCondition || '';
        const oldHumanTransferPhoneNumber = school.humanTransferPhoneNumber || '';

        if (name !== undefined) school.name = name;
        if (address !== undefined) school.address = address;

        // Auto-detect timezone from address when address changes AND timezone not manually set
        if (address !== undefined && address.trim() && address !== oldAddress && timezone === undefined) {
            const { getTimezoneFromAddress } = require('../utils/timezone');
            const detectedTz = await getTimezoneFromAddress(address);
            if (detectedTz) {
                school.timezone = detectedTz;
                console.log(`[Settings] Auto-updated timezone for ${school.name} to ${detectedTz}`);
            }
        }

        // Apply manually supplied timezone (overrides auto-detected)
        if (timezone !== undefined) school.timezone = timezone;
        if (routingNumber !== undefined) school.routingNumber = routingNumber;
        if (language !== undefined) {
            const normalizedLanguage = String(language || '').trim().toUpperCase();
            if (['EN', 'ES'].includes(normalizedLanguage)) {
                school.language = normalizedLanguage;
            }
        }

        if (businessHoursStart !== undefined) school.businessHoursStart = businessHoursStart;
        if (businessHoursEnd !== undefined) school.businessHoursEnd = businessHoursEnd;
        if (smsAutoFollowup !== undefined) school.smsAutoFollowup = smsAutoFollowup;
        if (emailAutoFollowup !== undefined) school.emailAutoFollowup = emailAutoFollowup;
        if (smsTemplate !== undefined) school.smsTemplate = smsTemplate;
        if (emailTemplate !== undefined) school.emailTemplate = emailTemplate;
        if (preferredCalendar !== undefined) school.preferredCalendar = preferredCalendar;
        if (preferredEmailProvider !== undefined) school.preferredEmailProvider = preferredEmailProvider;
        if (adminEmailUpdate !== null) school.adminEmail = adminEmailUpdate;
        if (elevenlabsAgentId !== undefined) school.elevenlabsAgentId = elevenlabsAgentId;
        if (enableHumanTransfer !== undefined) school.enableHumanTransfer = Boolean(enableHumanTransfer);
        if (humanTransferCondition !== undefined) school.humanTransferCondition = String(humanTransferCondition || '').trim();
        if (humanTransferPhoneNumber !== undefined) {
            const normalizedTransferPhone = normalizePhone(String(humanTransferPhoneNumber || ''));
            school.humanTransferPhoneNumber = normalizedTransferPhone || '';
        }
        if (tourConfirmationEmailTemplate !== undefined) school.tourConfirmationEmailTemplate = tourConfirmationEmailTemplate;
        if (tourReminderSmsTemplate !== undefined) school.tourReminderSmsTemplate = tourReminderSmsTemplate;

        // Validate using the latest values (after applying request body fields).
        if (school.enableHumanTransfer && !school.humanTransferPhoneNumber) {
            return res.status(400).json({ error: 'Transfer phone number is required when Human Transfer is enabled.' });
        }

        // If human transfer fields are present in payload, always sync to ElevenLabs to avoid UI/API drift.
        const humanTransferChanged =
            enableHumanTransfer !== undefined
            || humanTransferCondition !== undefined
            || humanTransferPhoneNumber !== undefined
            || school.enableHumanTransfer !== oldEnableHumanTransfer
            || (school.humanTransferCondition || '') !== oldHumanTransferCondition
            || (school.humanTransferPhoneNumber || '') !== oldHumanTransferPhoneNumber;

        // Check if qaPairs changed
        let qaPairsChanged = false;
        if (Array.isArray(qaPairs)) {
            const newQAPairs = qaPairs.map(p => ({
                question: p.question || '',
                answer: p.answer || ''
            }));

            // Compare old and new qaPairs to detect changes
            const oldQAPairs = school.qaPairs || [];
            if (oldQAPairs.length !== newQAPairs.length) {
                qaPairsChanged = true;
            } else {
                // Deep compare each pair
                for (let i = 0; i < newQAPairs.length; i++) {
                    if (oldQAPairs[i]?.question !== newQAPairs[i].question ||
                        oldQAPairs[i]?.answer !== newQAPairs[i].answer) {
                        qaPairsChanged = true;
                        break;
                    }
                }
            }

            // Update qaPairs
            school.qaPairs.splice(0, school.qaPairs.length, ...newQAPairs);
            console.log('[PUT /settings] qaPairs set on document:', school.qaPairs.length);
        }

        // Prefer school-specific agent ID when set; fall back to global AGENT_ID
        const agentId = (school.elevenlabsAgentId && school.elevenlabsAgentId.trim()) || process.env.AGENT_ID || null;
        const voiceProvider = getProvider(school.voiceProvider || 'elevenlabs');

        // Sync with the voice provider's Knowledge Base if qaPairs changed (DELETE old KB, POST new KB)
        if (qaPairsChanged && Array.isArray(qaPairs)) {
            try {
                // Step 1: Delete old KB document only if document_id exists and is not empty
                if (school.knowledgeBaseDocumentId && school.knowledgeBaseDocumentId.trim() !== '') {
                    await deleteKnowledgeBaseDocument(school, school.knowledgeBaseDocumentId);
                    school.knowledgeBaseDocumentId = ''; // Clear the document_id
                }

                // Step 2: Create new KB document only if there are Q&A pairs
                if (qaPairs.length > 0) {
                    const kbText = formatQAPairsForKB(school.qaPairs);
                    if (kbText) { // Only create if we have valid text
                        // Pass school name to generate document name on backend
                        const newDocumentId = await voiceProvider.ingestKnowledgeBaseDocument(kbText, school.name, { agentId });

                        // Step 3: Store the new document_id
                        if (newDocumentId) {
                            school.knowledgeBaseDocumentId = newDocumentId;
                            console.log('[PUT /settings] KB document synced, new document_id:', newDocumentId);
                        }
                    }
                }
            } catch (err) {
                console.error('[PUT /settings] KB sync failed:', err);
                // Continue saving settings even if KB sync fails
            }
        }

        // Consolidated Agent Update: If Q&A, first message, or system prompt changed, push FULL payload
        if (qaPairsChanged || humanTransferChanged) {
            console.log('[PUT /settings] Agent sync inputs:', {
                schoolId: String(school._id),
                agentId: agentId || null,
                voiceProvider: school.voiceProvider || 'elevenlabs',
                humanTransferEnabled: Boolean(school.enableHumanTransfer),
                humanTransferCondition: school.humanTransferCondition || '',
                humanTransferPhoneNumber: school.humanTransferPhoneNumber || ''
            });
            if (agentId) {
                try {
                    await updateAgentWithKnowledgeBase(
                        school,
                        agentId,
                        school.script || '',
                        school.systemPrompt || '',
                        school.knowledgeBaseDocumentId || '',
                        {
                            enabled: Boolean(school.enableHumanTransfer),
                            condition: school.humanTransferCondition || '',
                            phoneNumber: school.humanTransferPhoneNumber || ''
                        },
                    );
                    console.log('[PUT /settings] Agent updated with full payload (KB and/or Persona changes)');
                } catch (err) {
                    const status = err?.response?.status || err?.statusCode;
                    const detail = err?.response?.data?.detail || err?.message || 'Unknown error';
                    if (status === 404) {
                        // Agent no longer exists — clear the stored ID so we don't keep retrying
                        school.elevenlabsAgentId = '';
                        console.warn(`[PUT /settings] Voice agent (${agentId}) not found — clearing stored Agent ID. Please set a valid Agent ID in Settings.`);
                    } else {
                        console.error(`[PUT /settings] Failed to update agent: [${status}] ${detail}`);
                    }
                }
            } else {
                console.warn('[PUT /settings] No agent ID — skipping agent PATCH');
            }
        }

        await school.save();
        console.log('[PUT /settings] Saved successfully. qaPairs in DB:', school.qaPairs.length);

        // Persist adminEmail atomically after save so concurrent settings updates cannot overwrite it.
        if (adminEmailUpdate !== null) {
            await School.findByIdAndUpdate(schoolId, { $set: { adminEmail: adminEmailUpdate } });
            school.adminEmail = adminEmailUpdate;
        }

        res.json({
            message: 'Settings updated successfully',
            qaPairsCount: school.qaPairs.length,
            adminEmail: (school.adminEmail || '').trim(),
            language: school.language || 'EN',
        });
    } catch (err) {
        console.error('[PUT /settings] Error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// POST /api/school/request-ai-number
router.post('/request-ai-number', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { schoolName } = req.body;

        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this account' });
        }

        // Check if there's already a pending request for this school
        const existingRequest = await AiNumberRequest.findOne({ 
            schoolId, 
            status: 'pending' 
        });
        
        if (existingRequest) {
            return res.status(400).json({ 
                error: 'You already have a pending AI number request. Please wait for admin approval.' 
            });
        }

        // Get school details
        const school = await School.findById(schoolId);
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        // Create the AI number request
        const request = await AiNumberRequest.create({
            schoolId: school._id,
            schoolName: school.name || schoolName,
            requestedBy: req.user.id,
            status: 'pending'
        });

        console.log(`[AI Number Request] Created request ${request._id} for school: ${school.name} (${school._id})`);
        
        res.json({ 
            message: 'AI number request submitted successfully. An admin will review your request shortly.',
            requestId: request._id.toString()
        });
    } catch (err) {
        console.error('[AI Number Request] Error:', err);
        res.status(500).json({ error: 'Failed to submit AI number request' });
    }
});

// GET /api/school/inquiry-submissions - Form submissions from public inquiry form
router.get('/inquiry-submissions', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this user' });
        }

        const submissions = await InquirySubmission.find({ schoolId })
            .sort({ submittedAt: -1 })
            .limit(50)
            .lean();

        res.json(submissions.map(s => ({
            id: s._id.toString(),
            parentName: s.parentName,
            email: s.email,
            phone: s.phone,
            answers: s.answers || [],
            submittedAt: s.submittedAt,
        })));
    } catch (err) {
        console.error('Inquiry submissions error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/tour-bookings
router.get('/tour-bookings', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const bookings = await TourBooking.find({ schoolId })
            .sort({ scheduledAt: -1 })
            .limit(50)
            .lean();

        res.json(bookings.map(b => ({
            id: b._id.toString(),
            parentName: b.parentName,
            phone: b.phone,
            email: b.email,
            childAge: b.childAge,
            reason: b.reason,
            scheduledAt: b.scheduledAt,
            calendarProvider: b.calendarProvider || null,
        })));
    } catch (err) {
        console.error('Tour bookings error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/followups
router.get('/followups', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const followups = await Followup.find({ schoolId })
            .sort({ createdAt: -1 })
            .lean();

        const formatted = followups.map(f => ({
            id: f._id.toString(),
            leadName: f.leadName,
            type: f.type,
            status: f.status,
            message: f.message,
            recipient: f.recipient,
            addressed: !!f.addressed,
            addressedNote: f.addressedNote || '',
            addressedAt: f.addressedAt || null,
            timestamp: f.createdAt,
        }));

        res.json(formatted);
    } catch (err) {
        console.error('School followups error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/followups/:id/addressed - mark a follow-up as addressed with a note
router.post('/followups/:id/addressed', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { id } = req.params;
        const { note } = req.body || {};

        if (!id) return res.status(400).json({ error: 'Missing follow-up id' });

        const addressedNote = typeof note === 'string' ? note.trim() : '';

        const updated = await Followup.findOneAndUpdate(
            { _id: id, schoolId },
            {
                $set: {
                    addressed: true,
                    addressedNote,
                    addressedAt: new Date(),
                    addressedBy: req.user?.email ? String(req.user.email) : '',
                }
            },
            { new: true }
        ).lean();

        if (!updated) {
            return res.status(404).json({ error: 'Follow-up not found' });
        }

        res.json({
            success: true,
            followup: {
                id: updated._id.toString(),
                addressed: !!updated.addressed,
                addressedNote: updated.addressedNote || '',
                addressedAt: updated.addressedAt || null,
            }
        });
    } catch (err) {
        console.error('Mark follow-up addressed error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/forms
router.get('/forms', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const questions = await FormQuestion.find({ schoolId })
            .sort({ position: 1 })
            .lean();

        const formatted = questions.map(q => ({
            id: q._id.toString(),
            question: q.question,
            required: q.required,
        }));

        res.json(formatted);
    } catch (err) {
        console.error('School forms error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/forms - Save form questions (bulk replace)
router.post('/forms', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { questions } = req.body;

        if (!Array.isArray(questions)) {
            return res.status(400).json({ error: 'Questions must be an array' });
        }

        // Delete old questions
        await FormQuestion.deleteMany({ schoolId });

        // Insert new ones
        if (questions.length > 0) {
            await FormQuestion.insertMany(
                questions.map((q, index) => ({
                    schoolId,
                    question: q.question,
                    required: q.required || false,
                    position: index,
                }))
            );
        }

        res.json({ message: 'Form questions saved successfully' });
    } catch (err) {
        console.error('Save forms error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/school/referrals
router.get('/referrals', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;

        const referralLink = await ReferralLink.findOne({ schoolId }).lean();

        const referrals = await Referral.find({ referrerSchoolId: schoolId })
            .sort({ date: -1 })
            .lean();

        const formatted = referrals.map(r => ({
            id: r._id.toString(),
            referrerSchool: r.referrerSchoolName,
            newSchool: r.newSchoolName,
            date: r.date,
            status: r.status,
        }));

        res.json({
            referralCode: referralLink ? referralLink.code : null,
            referralLink: referralLink ? `${process.env.FRONTEND_URL || process.env.FORM_BASE_URL || 'http://localhost:5173'}/refer/${referralLink.code}` : null,
            referrals: formatted,
        });
    } catch (err) {
        console.error('School referrals error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/referrals/generate
router.post('/referrals/generate', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const school = await School.findById(schoolId);

        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const code = `ref-${school.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now().toString(36)}`;

        await ReferralLink.findOneAndUpdate(
            { schoolId },
            { code },
            { upsert: true, new: true }
        );

        res.json({
            referralCode: code,
            referralLink: `${process.env.FRONTEND_URL || process.env.FORM_BASE_URL || 'http://localhost:5173'}/refer/${code}`,
        });
    } catch (err) {
        console.error('Generate referral error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/school/test-call - Simulate an incoming inquiry call for testing
router.post('/test-call', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const testLead = {
            parentName: 'Test Parent',
            phone: '+1 (555) 000-0000',
            email: 'test@example.com',
            childAge: '3 years',
            reason: 'Enrollment inquiry for next fall',
        };

        // 1. Create call log
        const callLog = await CallLog.create({
            schoolId,
            callerName: testLead.parentName,
            callerPhone: testLead.phone,
            callType: 'inquiry',
            duration: 125,
            recordingUrl: 'https://example.com/recording.mp3',
        });

        // 2. Trigger automation
        const { triggerAutomation } = require('../services/automation');
        await triggerAutomation(schoolId, testLead);

        res.json({ message: 'Test call simulated successfully', callLogId: callLog._id });
    } catch (err) {
        console.error('Test call error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Normalize phone to E.164 (strip spaces/dashes, ensure + prefix)
function normalizePhone(value) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim().replace(/[\s\-\(\)]/g, '');
    if (!trimmed) return null;
    return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

// POST /api/school/test-followup - Send test SMS and/or email to YOUR number/email (no call)
// Body: { phone?: string, email?: string } - at least one required. Uses your templates + form link.
router.post('/test-followup', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        let { phone, email } = req.body || {};

        if (!phone && !email) {
            return res.status(400).json({
                error: 'Provide at least one of phone or email to receive the test follow-up.',
            });
        }

        phone = phone ? normalizePhone(phone) : undefined;
        email = email ? String(email).trim() || undefined : undefined;

        const testLead = {
            parentName: 'Test Parent',
            phone,
            email,
            childAge: '3 years',
            reason: 'Test follow-up',
        };

        const { triggerAutomation } = require('../services/automation');
        const result = await triggerAutomation(schoolId, testLead);

        const sent = [];
        if (result.smsSent) sent.push('SMS');
        if (result.emailSent) sent.push('Email');

        const errors = [];
        if (phone && !result.smsSent && result.smsError) errors.push(`SMS: ${result.smsError}`);
        if (email && !result.emailSent && result.emailError) errors.push(`Email: ${result.emailError}`);

        if (sent.length > 0) {
            return res.json({
                message: `Test sent (${sent.join(' + ')}). Check your ${sent.includes('SMS') ? 'phone' : ''}${sent.length === 2 ? ' and ' : ''}${sent.includes('Email') ? 'inbox' : ''}.`,
                sent,
                ...(errors.length > 0 && { partialErrors: errors }),
            });
        }

        const errorMessage = errors.length > 0 ? errors.join(' ') : 'Send failed. Enable follow-ups in Settings and save SMTP settings.';
        return res.status(400).json({ error: errorMessage });
    } catch (err) {
        console.error('Test followup error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// GET /api/school/product-tour — first-login product UI tour state
router.get('/product-tour', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this account' });
        }

        const school = await School.findById(schoolId).select('productTour').lean();
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const tour = school.productTour || {};
        res.json({
            status: tour.status || 'completed',
            currentStepId: tour.currentStepId || null,
            completedAt: tour.completedAt || null,
            skippedSteps: Array.isArray(tour.skippedSteps) ? tour.skippedSteps : [],
        });
    } catch (err) {
        console.error('Get product-tour error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /api/school/product-tour — update tour progress
router.patch('/product-tour', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this account' });
        }

        const { status, currentStepId, skippedSteps } = req.body || {};
        const allowedStatuses = ['pending', 'in_progress', 'completed', 'dismissed'];

        const $set = {};
        if (status !== undefined) {
            if (!allowedStatuses.includes(status)) {
                return res.status(400).json({ error: 'Invalid product tour status' });
            }
            $set['productTour.status'] = status;
            if (status === 'completed' || status === 'dismissed') {
                $set['productTour.completedAt'] = new Date();
                $set['productTour.currentStepId'] = null;
            }
        }
        if (currentStepId !== undefined) {
            $set['productTour.currentStepId'] = currentStepId === null || currentStepId === ''
                ? null
                : String(currentStepId);
        }
        if (skippedSteps !== undefined) {
            if (!Array.isArray(skippedSteps)) {
                return res.status(400).json({ error: 'skippedSteps must be an array' });
            }
            $set['productTour.skippedSteps'] = skippedSteps.map(String);
        }

        if (Object.keys($set).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        const school = await School.findByIdAndUpdate(
            schoolId,
            { $set },
            { new: true, select: 'productTour' }
        ).lean();

        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const tour = school.productTour || {};
        res.json({
            status: tour.status || 'completed',
            currentStepId: tour.currentStepId || null,
            completedAt: tour.completedAt || null,
            skippedSteps: Array.isArray(tour.skippedSteps) ? tour.skippedSteps : [],
        });
    } catch (err) {
        console.error('Patch product-tour error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

