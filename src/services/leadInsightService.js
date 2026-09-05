const crypto = require('crypto');
const LeadInsight = require('../models/LeadInsight');
const { extractTourDetails, mergeParentQuestionsFromExtraction, filterSchoolQuestions } = require('../utils/openai');
const { getCallerPhoneFromWebhook, getCallDurationSeconds, getCallerNameFromWebhook, isUsableCallerName, isRealPhoneForLookup, isWidgetCallerId } = require('../utils/webhookHelpers');
const { resolveWebhookSummary, resolveCachedSummary, isNoMeaningfulInteractionSummary, isCurrentFamilyCall, callerIdentifiedAsCurrentFamily, callerIdentifiedAsNewFamily, callerWantsHumanRoutingOnly, callerIdentifiedAsNewFamilyFromTranscript, callerWantsHumanRoutingOnlyFromTranscript, agentConfirmedCurrentFamily, callerIsNonParent, callerIsNonParentFromTranscript } = require('../utils/currentFamilyTransfer');

const PAST_CALL_NAME_TAG = 'Past call name used';

function phoneKeyForLookup(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length >= 10) return digits.slice(-10);
    return digits.length >= 7 ? digits : '';
}

function hasPastCallNameTag(tags = []) {
    return (Array.isArray(tags) ? tags : []).some(
        (tag) => String(tag).trim().toLowerCase() === PAST_CALL_NAME_TAG.toLowerCase()
    );
}

function withPastCallNameTag(tags = []) {
    const next = Array.isArray(tags) ? [...tags] : [];
    if (!hasPastCallNameTag(next)) next.push(PAST_CALL_NAME_TAG);
    return next;
}

/**
 * Find the most recent usable caller name for this phone from earlier school calls.
 */
async function findPriorUsableCallerName(schoolId, phone, { beforeDate = null, excludeWebhookId = null } = {}) {
    const key = phoneKeyForLookup(phone);
    if (!schoolId || !key || !isRealPhoneForLookup(phone)) return null;

    const query = {
        schoolId,
        callerName: { $exists: true, $nin: ['', null] },
    };
    if (excludeWebhookId) query.webhookId = { $ne: excludeWebhookId };
    if (beforeDate) query.callTimestamp = { $lt: new Date(beforeDate) };

    const rows = await LeadInsight.find(query)
        .select('callerName callerPhone callTimestamp webhookId')
        .sort({ callTimestamp: -1 })
        .limit(80)
        .lean();

    for (const row of rows) {
        if (phoneKeyForLookup(row.callerPhone) !== key) continue;
        if (!isUsableCallerName(row.callerName)) continue;
        return String(row.callerName).trim();
    }
    return null;
}

/**
 * If this call has no usable name, reuse the name from a prior call on the same number
 * and mark it with the "Past call name used" tag.
 */
async function applyPriorCallerNameFromHistory(schoolId, {
    callerName,
    callerPhone,
    tags = [],
    callTimestamp = null,
    webhookId = null,
} = {}) {
    if (isUsableCallerName(callerName)) {
        return {
            callerName: String(callerName).trim(),
            tags: Array.isArray(tags) ? tags : [],
            usedPastCallName: false,
        };
    }
    if (!isRealPhoneForLookup(callerPhone)) {
        return {
            callerName: callerName || 'Parent',
            tags: Array.isArray(tags) ? tags : [],
            usedPastCallName: false,
        };
    }

    const priorName = await findPriorUsableCallerName(schoolId, callerPhone, {
        beforeDate: callTimestamp || null,
        excludeWebhookId: webhookId || null,
    });

    if (!priorName) {
        return {
            callerName: callerName || 'Parent',
            tags: Array.isArray(tags) ? tags : [],
            usedPastCallName: false,
        };
    }

    return {
        callerName: priorName,
        tags: withPastCallNameTag(tags),
        usedPastCallName: true,
    };
}

/**
 * Build an in-memory index of usable caller names by phone for chronological lookup.
 * entries: [{ phone, name, timestamp, webhookId? }]
 */
function buildCallerNameHistoryIndex(entries = []) {
    const map = new Map();
    for (const entry of entries) {
        if (!isUsableCallerName(entry?.name) || !isRealPhoneForLookup(entry?.phone)) continue;
        const key = phoneKeyForLookup(entry.phone);
        if (!key) continue;
        const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
        if (!Number.isFinite(ts) || ts <= 0) continue;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({
            ts,
            name: String(entry.name).trim(),
            webhookId: entry.webhookId ? String(entry.webhookId) : '',
        });
    }
    for (const [key, list] of map.entries()) {
        list.sort((a, b) => a.ts - b.ts || String(a.webhookId).localeCompare(String(b.webhookId)));
        map.set(key, list);
    }
    return map;
}

/** Latest usable name for this phone strictly before beforeTs (ms). */
function lookupPriorCallerNameFromIndex(index, phone, beforeTs, excludeWebhookId = null) {
    const key = phoneKeyForLookup(phone);
    if (!key || !index) return null;
    const list = index.get(key) || [];
    const cutoff = Number(beforeTs) || 0;
    let best = null;
    for (const row of list) {
        if (cutoff && row.ts >= cutoff) break;
        if (excludeWebhookId && row.webhookId && row.webhookId === String(excludeWebhookId)) continue;
        best = row.name;
    }
    return best;
}

/**
 * Resolve display name: prefer this call's name; otherwise reuse an earlier call's name
 * and mark usedPastCallName so callers can add PAST_CALL_NAME_TAG.
 */
function resolveCallerNameWithPastFallback(index, {
    callerName = null,
    callerPhone = null,
    callTimestamp = null,
    webhookId = null,
} = {}) {
    if (isUsableCallerName(callerName)) {
        return {
            callerName: String(callerName).trim(),
            usedPastCallName: false,
        };
    }
    if (isWidgetCallerId(callerPhone)) {
        return { callerName: 'Unknown Caller', usedPastCallName: false };
    }
    if (!isRealPhoneForLookup(callerPhone)) {
        return { callerName: callerName || 'Parent', usedPastCallName: false };
    }
    const prior = lookupPriorCallerNameFromIndex(
        index,
        callerPhone,
        callTimestamp ? new Date(callTimestamp).getTime() : Date.now(),
        webhookId
    );
    if (prior) {
        return { callerName: prior, usedPastCallName: true };
    }
    return { callerName: callerName || 'Parent', usedPastCallName: false };
}
/** New-parent enrollment / tour intent — word boundaries so "enrolled" does not match. */
const NEW_PARENT_INTENT_PATTERNS = [
    /\benroll(?:ment|ing)?\b/i,
    /\badmission\b/i,
    /\btour(?:ing|s)?\b/i,
    /\bvisit(?:ing)?\b|\bschedule\b|\bbook(?:ing)?\b|\blook(?:ing)? around\b/i,
    /tuition|price|cost|fee|afford|financial aid/i,
    /callback|call (?:me )?back|speak (?:to|with) (?:someone|staff|a person)/i,
    /urgent|as soon as possible|starting (?:next week|soon)/i,
    /program|curriculum|classroom|hours|pickup|drop.?off|meal|food|ratio|teacher|camera|security|summer camp|after.?school/i,
    /daycare|childcare|child care|preschool|pre.?k\b/i,
    /moving to (?:the )?area|new to (?:the )?area/i,
];

/** Current-family calls only count as hot when they ask about something substantive. */
const CURRENT_FAMILY_INQUIRY_PATTERNS = [
    /tuition|price|cost|fee|billing|payment|invoice|financial aid|sibling discount|military discount/i,
    /hours|schedule|pickup|drop.?off|holiday|closure|\bopen\b|\bclose\b|part.?time|extended (?:hours|care)/i,
    /meal|food|allerg|lunch|snack/i,
    /teacher|ratio|classroom|director|staff|curriculum|montessori|stem/i,
    /camera|security|safety|incident/i,
    /bus|transportation|field trip/i,
    /summer camp|after.?school/i,
    /sick|absence|attendance/i,
    /waitlist|potty training|\bnap\b/i,
];

function hashTranscript(transcriptText) {
    return crypto.createHash('sha256').update(String(transcriptText || '')).digest('hex');
}

function getTranscriptText(webhook) {
    if (!Array.isArray(webhook?.transcript)) return '';
    return webhook.transcript.map(t => `${t.role}: ${t.message || t.text}`).join('\n');
}

function getCallerText(webhook) {
    if (!Array.isArray(webhook?.transcript)) return '';
    return webhook.transcript
        .filter((entry) => {
            const role = String(entry.role || '').toLowerCase();
            return role === 'user' || role === 'parent' || role === 'caller' || role === 'customer' || role === 'human';
        })
        .map((entry) => entry.message || entry.text || '')
        .join(' ');
}

function getAgentText(webhook) {
    if (!Array.isArray(webhook?.transcript)) return '';
    return webhook.transcript
        .filter((entry) => {
            const role = String(entry.role || '').toLowerCase();
            return role === 'agent' || role === 'assistant' || role === 'mia' || role === 'nora';
        })
        .map((entry) => entry.message || entry.text || '')
        .join(' ');
}

/** Nora only offers front-desk transfer after the caller identifies as a current family. */
const AGENT_CURRENT_FAMILY_TRANSFER_PATTERNS = [
    /connect you to the front desk/i,
    /connect you to (?:the )?team/i,
    /connect you (?:right )?now/i,
    /i will connect you/i,
    /transfer you to/i,
    /transfer you (?:to|now)/i,
    /front desk (?:line|lines) (?:is|are) (?:all )?busy/i,
    /not able to transfer you/i,
    /transfer did not go through/i,
    /unable to transfer/i,
];

function safeStr(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return String(value[0] || '');
    return String(value || '');
}

const TOUR_BOOKED_TAG = 'Tour booked';
const TOUR_BOOKED_EMAIL_MISSING_TAG = 'Tour booked - email missing';

const TOUR_DETAILS_BY_PHONE_PATTERN = /(?:we(?:'|')?ll\s+)?make sure you have your tour details by phone|confirm your tour details by phone|tour details by phone/i;

const EMAIL_SKIPPED_AGENT_PATTERNS = [
    TOUR_DETAILS_BY_PHONE_PATTERN,
    /email as not collected/i,
    /skip(?:ped)? email/i,
    /without (?:an? )?email/i,
    /proceed without email/i,
];

const EMAIL_FLOW_PROMPT_PATTERN = /(?:email|e-mail|spell.*email|@gmail|@yahoo|@hotmail|@outlook|\.com)/i;
const EMAIL_CONFIRM_PATTERN = /did i get that correct|is that correct|did i get it right|is that right/i;
const EMAIL_RETRY_PATTERN = /spell your email.*again|email for me again/i;
const EMAIL_SKIP_PATTERN = /no problem|without email|email as not collected|skip email|make sure you have your tour details by phone|tour details by phone/i;
const USER_EMAIL_NO_PATTERN = /^(no|nope|nah|incorrect|wrong|that's wrong|that is wrong|not correct|that's not|that isn't)\.?$/i;
const USER_EMAIL_YES_PATTERN = /^(yes|yeah|yep|yup|correct|that's right|that is right|that's correct)\.?$/i;

function isValidConfirmedEmail(email) {
    const t = String(email || '').trim();
    if (!t) return false;
    if (/^(not provided|n\/a|none|unknown)$/i.test(t)) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(t);
}

function normalizeEmailForCompare(email) {
    return String(email || '').trim().toLowerCase();
}

/** Collect the first valid email from webhook extraction, tour booking, or other sources. */
function getValidEmailFromSources(webhook, comprehensiveResult = null, extraEmails = []) {
    const resolved = comprehensiveResult ?? webhook?.comprehensive_result ?? null;
    const candidates = [
        resolved?.parent_email,
        resolved?.one_pager?.header?.email,
        webhook?.tour_booking_extracted?.email,
        ...(Array.isArray(extraEmails) ? extraEmails : [extraEmails]),
    ];
    for (const email of candidates) {
        if (isValidConfirmedEmail(email)) return String(email).trim();
    }
    return '';
}

function isAgentRole(role) {
    const r = String(role || '').toLowerCase();
    return r === 'agent' || r === 'assistant' || r === 'mia' || r === 'nora' || r.includes('assistant');
}

function isCallerRole(role) {
    const r = String(role || '').toLowerCase();
    return r === 'user' || r === 'parent' || r === 'caller' || r === 'customer' || r === 'human' || r.includes('caller');
}

/** Nora confirmed tour by phone instead of email — mandatory email-missing when tour is booked. */
function agentConfirmedTourDetailsByPhone(webhook, comprehensiveResult = null) {
    const resolved = comprehensiveResult ?? webhook?.comprehensive_result ?? null;
    if (!isTourBooked(webhook, resolved)) return false;

    const summary = String(resolved?.summary || webhook?.summary || '');
    if (TOUR_DETAILS_BY_PHONE_PATTERN.test(summary)) return true;

    const agentText = getAgentText(webhook);
    if (TOUR_DETAILS_BY_PHONE_PATTERN.test(agentText)) return true;

    if (Array.isArray(webhook?.transcript)) {
        for (const raw of webhook.transcript) {
            if (!isAgentRole(raw.role)) continue;
            const text = String(raw.message || raw.text || '').trim();
            if (text && TOUR_DETAILS_BY_PHONE_PATTERN.test(text)) return true;
        }
    }

    return false;
}

function wasEmailSkippedOrRejectedInTranscript(webhook, comprehensiveResult = null, options = {}) {
    const resolved = comprehensiveResult ?? webhook?.comprehensive_result ?? null;

    if (agentConfirmedTourDetailsByPhone(webhook, resolved)) {
        return true;
    }

    const summary = String(resolved?.summary || webhook?.summary || '').trim();

    if (TOUR_DETAILS_BY_PHONE_PATTERN.test(summary)) {
        return true;
    }
    if (
        /email.{0,40}(?:not collected|not captured|not confirmed|skipped|could not confirm|without email)/i.test(summary)
        || /(?:skipped|without).{0,20}email/i.test(summary)
    ) {
        return true;
    }

    const missingDetails = Array.isArray(resolved?.missing_details) ? resolved.missing_details : [];
    if (
        missingDetails.some((item) => /parent email|email address/i.test(String(item)))
        && isTourBooked(webhook, resolved)
    ) {
        return true;
    }

    const onePagerEmail = safeStr(resolved?.one_pager?.header?.email);
    if (/not provided/i.test(onePagerEmail) && isTourBooked(webhook, resolved)) {
        return true;
    }

    const rawEmail = safeStr(resolved?.parent_email) || safeStr(webhook?.tour_booking_extracted?.email);
    if (isTourBooked(webhook, resolved) && rawEmail.trim() && !isValidConfirmedEmail(rawEmail)) {
        return true;
    }

    if (!Array.isArray(webhook?.transcript) || webhook.transcript.length === 0) {
        return false;
    }

    const agentText = getAgentText(webhook);
    if (EMAIL_SKIPPED_AGENT_PATTERNS.some((pattern) => pattern.test(agentText))) {
        return true;
    }

    let inEmailFlow = false;
    let awaitingConfirm = false;
    let rejections = 0;
    let emailConfirmedInCall = false;

    for (const raw of webhook.transcript) {
        const role = String(raw.role || '').toLowerCase();
        const text = String(raw.message || raw.text || '').trim();
        if (!text) continue;

        const isAgent = isAgentRole(role);
        const isUser = isCallerRole(role);

        if (isAgent) {
            if (inEmailFlow && EMAIL_SKIP_PATTERN.test(text) && rejections >= 1) {
                return true;
            }
            if (EMAIL_FLOW_PROMPT_PATTERN.test(text)) {
                inEmailFlow = true;
            }
            if (inEmailFlow && EMAIL_CONFIRM_PATTERN.test(text)) {
                awaitingConfirm = true;
            }
            if (inEmailFlow && EMAIL_RETRY_PATTERN.test(text)) {
                awaitingConfirm = false;
            }
            if (inEmailFlow && (/what is your child'?s name/i.test(text) || /just to confirm/i.test(text)) && rejections >= 1) {
                return true;
            }
        }

        if (isUser && awaitingConfirm) {
            const lower = text.toLowerCase();
            if (USER_EMAIL_NO_PATTERN.test(lower) || /\b(no|nope|wrong|incorrect)\b/i.test(lower)) {
                rejections += 1;
                awaitingConfirm = false;
                if (rejections >= 1) return true;
            } else if (USER_EMAIL_YES_PATTERN.test(lower)) {
                emailConfirmedInCall = true;
                inEmailFlow = false;
                awaitingConfirm = false;
                rejections = 0;
            }
        }
    }

    if (emailConfirmedInCall) return false;
    return rejections >= 1;
}

function resolveParentEmail(webhook, comprehensiveResult = null, options = {}) {
    const extraEmails = options.extraEmails || [];
    const fromSources = getValidEmailFromSources(webhook, comprehensiveResult, extraEmails);
    if (fromSources) return fromSources;
    if (wasEmailSkippedOrRejectedInTranscript(webhook, comprehensiveResult, options)) {
        return '';
    }
    return '';
}

function isTourBooked(webhook, comprehensiveResult = null) {
    if (comprehensiveResult?.tour_booked === true) return true;
    return webhook?.tour_booking_detected === true;
}

function getStoredEmailNorms(webhook, comprehensiveResult = null) {
    const resolved = comprehensiveResult ?? webhook?.comprehensive_result ?? null;
    return [
        resolved?.parent_email,
        webhook?.tour_booking_extracted?.email,
    ]
        .map((email) => normalizeEmailForCompare(email))
        .filter(Boolean);
}

function isTourBookedEmailMissing(webhook, comprehensiveResult = null, options = {}) {
    const resolved = comprehensiveResult ?? webhook?.comprehensive_result ?? null;
    if (!isTourBooked(webhook, resolved)) return false;

    // Hard rule: Nora said tour details will be confirmed by phone → email was not collected.
    if (agentConfirmedTourDetailsByPhone(webhook, resolved)) {
        return true;
    }

    const skipped = wasEmailSkippedOrRejectedInTranscript(webhook, resolved, options);
    const validTourEmail = (options.extraEmails || [])
        .map((email) => String(email || '').trim())
        .find(isValidConfirmedEmail);

    if (skipped) {
        const tourNorm = validTourEmail ? normalizeEmailForCompare(validTourEmail) : '';
        const storedNorms = getStoredEmailNorms(webhook, resolved);
        // Tour record copied the same AI-hallucinated email from this failed call — still missing.
        if (tourNorm && storedNorms.includes(tourNorm)) return true;
        // Tour record has a different valid email than this call's failed extraction.
        if (tourNorm) return false;
        return true;
    }

    if (getValidEmailFromSources(webhook, resolved, options.extraEmails || [])) return false;
    return true;
}

function ensureTourBookedEmailMissingTag(tags, { tourBooked, parentEmail, emailMissing } = {}) {
    const next = dedupeTags(Array.isArray(tags) ? tags : []);
    if (!tourBooked) return next;

    const hasTourBookedOnly = next.some((tag) => {
        const lower = String(tag).toLowerCase();
        return lower === 'tour booked' || (lower.includes('tour booked') && !lower.includes('email'));
    });
    if (!hasTourBookedOnly) {
        next.unshift(TOUR_BOOKED_TAG);
    }

    const missing = emailMissing !== undefined
        ? emailMissing
        : !String(parentEmail || '').trim();
    if (missing) {
        if (!next.some((tag) => tag.toLowerCase().includes('email missing'))) {
            next.push(TOUR_BOOKED_EMAIL_MISSING_TAG);
        }
    } else {
        return dedupeTags(next.filter((tag) => !String(tag).toLowerCase().includes('email missing')));
    }
    return dedupeTags(next);
}

function dedupeTags(tags) {
    const seen = new Set();
    const out = [];
    for (const tag of Array.isArray(tags) ? tags : []) {
        const label = String(tag || '').trim();
        if (!label) continue;
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(label);
    }
    return out;
}

function isTransferBoilerplateSummary(summary) {
    return /current enrolled family member|transferred to the front desk|familia actual/i.test(String(summary || ''));
}

function getCallerSchoolQuestions(callerText) {
    const caller = String(callerText || '').trim();
    if (!caller) return [];
    const chunks = caller
        .split(/\s*\|\s*|\n+/)
        .flatMap((line) => line.split(/(?<=[.!?])\s+/))
        .map((s) => s.trim())
        .filter((s) => s.length > 8);
    return filterSchoolQuestions(chunks);
}

function hasSchoolKbInquiry({
    questionsAsked = [],
    callerText = '',
    comprehensiveResult = null,
} = {}) {
    if (filterSchoolQuestions(questionsAsked).length > 0) return true;
    if (comprehensiveResult && mergeParentQuestionsFromExtraction(comprehensiveResult).length > 0) {
        return true;
    }
    return getCallerSchoolQuestions(callerText).length > 0;
}

/** Enrollment-urgency values (from the extractor) that signal a ready-to-convert lead. */
const STRONG_ENROLLMENT_URGENCY = new Set(['immediate', 'within weeks', 'specific month']);

// Near-term / urgent enrollment target phrasing (a concrete soon-ish intent). Deliberately
// excludes far-future intent like "next year" / "in the fall of next year" so those stay warm.
const NEAR_TERM_TARGET_PATTERN = /\b(asap|as soon as possible|immediate(?:ly)?|right away|this (?:week|month)|next (?:week|month)|within (?:a |the |the next )?(?:week|month|weeks|few weeks|couple (?:of )?weeks)|before (?:the )?school year|by (?:the )?fall|start of (?:the )?semester|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

// Explicit enrollment intent the parent voices (scanned against parent-sourced text only).
const ENROLLMENT_INTENT_PATTERNS = [
    /\benroll(?:ing|ment)?\b/i,
    /\bregist(?:er|ration|ering)\b/i,
    /\bsign(?:ing)?\s+(?:my|our|him|her|them|the kids?)?\s*up\b/i,
    /\badmission\b/i,
    /\bapply(?:ing)?\b|\bapplication\b/i,
    /\bget (?:my|our|the|a|him|her|them) (?:child|kid|son|daughter|children|little one|baby|twins)\b.{0,25}\b(?:in|into|enrolled|started|spot|place|going)\b/i,
    /\b(?:a )?(?:spot|space|opening|slot|place|seat|waitlist)\b.{0,25}\b(?:for|available|open)\b/i,
    /\b(?:do you have|is there|are there)\b.{0,25}\b(?:spot|space|opening|slot|availab|room|capacity|waitlist)\b/i,
    /\blooking (?:for|to|at)\b.{0,30}\b(?:care|daycare|childcare|preschool|enroll|program|school|spot|placement)\b/i,
    /\b(?:need|want|interested in|hoping)\b.{0,30}\b(?:enroll|daycare|childcare|care for|preschool|a spot|placement|start)\b/i,
    /\bstart(?:s|ing)?\b.{0,20}\b(?:school|daycare|program|care|next)\b/i,
    /\bplace for (?:my|our)\b/i,
    /\bmoving to (?:the )?area\b.{0,40}\bneed\b/i,
    /\bfirst time\b.{0,20}\b(?:daycare|preschool|childcare)\b/i,
    /\bswitch(?:ing)? (?:daycares?|schools?|preschools?)\b/i,
    /\bwant(?:s)? (?:him|her|them|my (?:son|daughter|kids?)) to (?:go|attend|start)\b/i,
];

// Tour interest the parent voices (booked, requested, or wants to visit/see the school).
const TOUR_INTENT_PATTERNS = [
    /\btour(?:ing|s)?\b/i,
    /\blook(?:ing)? around\b/i,
    /\b(?:come|schedule|book|set up|arrange|plan)\b.{0,20}\b(?:visit|tour|see|look)\b/i,
    /\bvisit (?:the )?(?:school|center|centre|facility|campus|place|daycare)\b/i,
    /\bsee (?:the )?(?:school|classroom|facility|place|center|centre)\b/i,
    /\bcome (?:in|by|and see|take a look|check)\b/i,
    /\bwalk[\s-]?(?:in|through)\b/i,
    /\bopen house\b/i,
    /\bdrop.?in\b.{0,15}\bvisit\b/i,
    /\bwhen can (?:i|we) come\b/i,
];

/**
 * A prospective family shows strong buying intent when they booked a tour, the extractor flagged
 * an immediate/soon urgency, or they named a concrete near-term enrollment date — even if they
 * didn't ask specific school/KB questions. This is what makes someone like Leslie (wants to
 * enroll two kids by "August 17th") a hot lead, while a "next year" caller stays warm.
 */
function hasStrongEnrollmentIntent({ comprehensiveResult = null, tags = [], tourBooked = false } = {}) {
    if (tourBooked) return true;

    const cr = comprehensiveResult || {};
    const urgency = String(cr.enrollment_urgency || '').toLowerCase().trim();
    if (STRONG_ENROLLMENT_URGENCY.has(urgency)) return true;

    const targetDate = String(cr.enrollment_target_date || '').trim();
    if (targetDate && NEAR_TERM_TARGET_PATTERN.test(targetDate) && !/\bnext year\b/i.test(targetDate)) {
        return true;
    }

    const tagHaystack = (Array.isArray(tags) ? tags : []).join(' ').toLowerCase();
    if (/urgency:\s*(?:immediate|high)/i.test(tagHaystack)) return true;
    // "Tour booked" corroborates a confirmed booking (redundant with the tourBooked check
    // above, kept for cached-tag-only call sites). "Tour requested" is deliberately excluded —
    // the extractor tags it for ANY expressed visit interest, including soft ones ("when can I
    // come by sometime"), so it must not bypass the warm tier on its own.
    if (/\btour booked\b/i.test(tagHaystack)) return true;

    return false;
}

/**
 * Parent-voiced enrollment or tour intent, scanned against parent-sourced text (their own words,
 * the questions they asked, and their topics of interest) — never the agent's summary, to avoid
 * agent boilerplate ("offered a tour") creating false positives.
 */
function hasEnrollmentOrTourIntent({ callerText = '', questionsAsked = [], comprehensiveResult = null } = {}) {
    const topics = Array.isArray(comprehensiveResult?.topics_of_interest)
        ? comprehensiveResult.topics_of_interest.join(' ')
        : '';
    const haystack = `${callerText} ${(questionsAsked || []).join(' ')} ${topics}`.trim();
    if (!haystack) return false;
    if (ENROLLMENT_INTENT_PATTERNS.some((pattern) => pattern.test(haystack))) return true;
    if (TOUR_INTENT_PATTERNS.some((pattern) => pattern.test(haystack))) return true;
    return false;
}

function llmFlaggedHotLead(tags) {
    return (Array.isArray(tags) ? tags : []).some((t) => String(t).trim().toLowerCase() === 'hot lead');
}

/**
 * LEAD TEMPERATURE — hot / warm / cold. For a prospective (new) family:
 *   HOT: a tour booked, strong enrollment urgency/near-term date, or TWO independent buying
 *        signals together (a school/KB question AND enrollment/tour intent) — or one signal
 *        the LLM's own extraction also independently flagged as hot.
 *   WARM: exactly one buying signal alone (a KB question, or soft enrollment/tour intent) with
 *        nothing else corroborating it — genuine interest, but not yet a strong signal.
 *   COLD: no meaningful interaction, unknown segment, or no buying signal at all.
 * A current family is hot only when it raises a substantive service question (see
 * CURRENT_FAMILY_INQUIRY_PATTERNS), warm when it engages but not substantively, and cold
 * otherwise. Non-parent (teacher/vendor/employment) calls are always cold via parentSegment.
 */
function classifyLeadTemperature({
    tags = [],
    summary = '',
    callerText = '',
    parentSegment = 'new_parent',
    questionsAsked = [],
    missingDetails = [],
    comprehensiveResult = null,
    tourBooked = false,
} = {}) {
    const summaryText = String(summary || '').toLowerCase();

    if (/no meaningful interaction|did not engage|call was interrupted|caller did not/i.test(summaryText)) {
        return 'cold';
    }

    if (parentSegment === 'unknown') {
        return 'cold';
    }

    const schoolInquiry = hasSchoolKbInquiry({ questionsAsked, callerText, comprehensiveResult });

    // Current families: hot only with a substantive service question, warm with lighter engagement.
    if (parentSegment === 'current_family') {
        if (!schoolInquiry) return 'cold';
        const inquiryHaystack = `${callerText} ${filterSchoolQuestions(questionsAsked).join(' ')}`.trim();
        return CURRENT_FAMILY_INQUIRY_PATTERNS.some((pattern) => pattern.test(inquiryHaystack)) ? 'hot' : 'warm';
    }

    // Prospective (new) families.
    const strongIntent = hasStrongEnrollmentIntent({ comprehensiveResult, tags, tourBooked });
    const softIntent = hasEnrollmentOrTourIntent({ callerText, questionsAsked, comprehensiveResult });
    const llmFlaggedHot = llmFlaggedHotLead(tags) && comprehensiveResult?.call_state !== 'no_interaction';

    if (tourBooked || strongIntent) return 'hot';
    if (schoolInquiry && softIntent) return 'hot';
    if (schoolInquiry || softIntent) return llmFlaggedHot ? 'hot' : 'warm';
    if (llmFlaggedHot) return 'warm';

    return 'cold';
}

/** Backward-compat wrapper — several call sites/scripts still consume a plain boolean. */
function detectHotLead(args) {
    return classifyLeadTemperature(args) === 'hot';
}

function agentTriggeredCurrentFamilyTransfer(agentText) {
    const agentHaystack = String(agentText || '').toLowerCase();
    if (!agentHaystack) return false;
    return AGENT_CURRENT_FAMILY_TRANSFER_PATTERNS.some((pattern) => pattern.test(agentHaystack));
}

function hasSchoolRelatedIntent({
    summary = '',
    callerText = '',
    questionsAsked = [],
    comprehensiveResult = null,
    tags = [],
} = {}) {
    const topics = Array.isArray(comprehensiveResult?.topics_of_interest)
        ? comprehensiveResult.topics_of_interest.join(' ')
        : '';
    const inquiryHaystack = `${callerText} ${(questionsAsked || []).join(' ')} ${topics}`.toLowerCase();
    const summaryText = String(summary || '').toLowerCase();
    const tagHaystack = (Array.isArray(tags) ? tags : []).join(' ').toLowerCase();

    if (/tour requested|hot lead|urgency:/i.test(tagHaystack)) return true;
    if (NEW_PARENT_INTENT_PATTERNS.some((pattern) => pattern.test(inquiryHaystack))) return true;
    if (NEW_PARENT_INTENT_PATTERNS.some((pattern) => pattern.test(summaryText))) return true;

    const realQuestions = (questionsAsked || []).filter((q) => String(q || '').trim().length > 8);
    if (realQuestions.length > 0) {
        const qHaystack = realQuestions.join(' ').toLowerCase();
        if (NEW_PARENT_INTENT_PATTERNS.some((pattern) => pattern.test(qHaystack))) return true;
    }

    return false;
}

function hasCapturedEnrollmentData({ childName = '', childAge = '', comprehensiveResult = null } = {}) {
    if (String(childName || '').trim() || String(childAge || '').trim()) return true;
    const parentName = comprehensiveResult?.parent_name;
    const parentEmail = comprehensiveResult?.parent_email;
    const parentPhone = comprehensiveResult?.parent_phone;
    if (parentName && String(parentName).trim() && !/^parent$/i.test(String(parentName).trim())) return true;
    if (parentEmail && String(parentEmail).trim()) return true;
    if (parentPhone && String(parentPhone).trim()) return true;
    return false;
}

function hasMeaningfulCallerEngagement(callerText, comprehensiveResult = null) {
    const substantive = String(callerText || '')
        .split(/\s*\|\s*|\n+/)
        .map((line) => line.trim())
        .filter((line) => line && line.length > 2 && !/^\.{2,}$/.test(line)
            && !/^(hi|hello|hey|hola|yes|no|okay|ok|thanks|thank you|buenos d[ií]as)\.?$/i.test(line));

    if (substantive.length >= 2) return true;
    if (callerIdentifiedAsNewFamily(callerText)) return true;
    if (callerIdentifiedAsCurrentFamily(callerText)) return true;
    if (callerWantsHumanRoutingOnly(callerText)) return true;

    const summary = String(comprehensiveResult?.summary || '');
    if (/identified as a (?:new|current)(?: enrolled)? family/i.test(summary)) return true;
    if (comprehensiveResult?.call_state === 'partial') return true;

    return substantive.length >= 1;
}

function isUnknownCall({
    tags = [],
    summary = '',
    callerText = '',
    questionsAsked = [],
    comprehensiveResult = null,
    childName = '',
    childAge = '',
    tourBooked = false,
} = {}) {
    if (tourBooked) return false;
    if (callerIdentifiedAsNewFamily(callerText)) return false;
    if (callerIdentifiedAsCurrentFamily(callerText)) return false;
    if (callerWantsHumanRoutingOnly(callerText)) return false;

    if (comprehensiveResult?.call_state === 'no_interaction' && !hasMeaningfulCallerEngagement(callerText, comprehensiveResult)) {
        return true;
    }

    const summaryText = String(summary || '');
    if (isNoMeaningfulInteractionSummary(summaryText)) return true;
    if (/primarily greetings|misdial|silence|background noise|only greetings/i.test(summaryText.toLowerCase())) {
        return true;
    }

    const params = {
        tags,
        summary: summaryText,
        callerText,
        questionsAsked,
        comprehensiveResult,
        childName,
        childAge,
        tourBooked,
    };

    if (hasSchoolRelatedIntent(params)) return false;
    if (hasCapturedEnrollmentData(params)) return false;

    return true;
}

function detectParentSegment(tags, summary, webhookOrCallerText, options = {}) {
    const webhook = typeof webhookOrCallerText === 'object' && webhookOrCallerText !== null
        ? webhookOrCallerText
        : null;
    const callerText = webhook ? getCallerText(webhook) : String(webhookOrCallerText || '');

    const comprehensiveResult = options.comprehensiveResult
        ?? (typeof webhookOrCallerText === 'object' ? webhookOrCallerText?.comprehensive_result : null)
        ?? null;

    // Non-parent callers (teacher/vendor/employment/wrong number) are never a lead of any
    // kind — keep them out of new_parent/current_family entirely so they can't surface as
    // hot/warm leads just because they happened to mention tuition or hours.
    if (webhook?.transcript && callerIsNonParentFromTranscript(webhook.transcript)) {
        return 'unknown';
    }
    if (callerIsNonParent(callerText)) {
        return 'unknown';
    }

    // Current family: transcript proof, OR the extractor's guarded "Current Family" tag.
    if (webhook?.transcript && isCurrentFamilyCall(webhook.transcript)) {
        return 'current_family';
    }
    if (callerIdentifiedAsCurrentFamily(callerText)) {
        return 'current_family';
    }
    // The comprehensive prompt only allows the "Current Family" tag when the caller explicitly
    // self-identified as current/existing/enrolled, so trust it (except when nothing meaningful
    // was said). This catches phrasings and ASR variance the regex above misses.
    const tagList = Array.isArray(tags) ? tags : [];
    const hasCurrentFamilyTag = tagList.some((t) => String(t).trim().toLowerCase() === 'current family');
    if (hasCurrentFamilyTag && comprehensiveResult?.call_state !== 'no_interaction') {
        return 'current_family';
    }

    // Explicit new-family self-identification (e.g. "New family", "Nueva").
    if (webhook?.transcript && callerIdentifiedAsNewFamilyFromTranscript(webhook.transcript)) {
        return 'new_parent';
    }
    if (callerIdentifiedAsNewFamily(callerText)) {
        return 'new_parent';
    }
    if (/identified as a new family/i.test(String(summary || ''))) {
        return 'new_parent';
    }
    if (/\benroll(?:able|ment|ing)?\b/i.test(callerText) && !callerIdentifiedAsCurrentFamily(callerText)) {
        return 'new_parent';
    }

    const questionsAsked = options.questionsAsked || [];
    const childName = options.childName || '';
    const childAge = options.childAge || '';
    const tourBooked = options.tourBooked
        ?? (webhook ? isTourBooked(webhook, comprehensiveResult) : false);

    // Parents who only ask for a representative/director/front desk (never said "new family").
    // Do NOT assume current_family purely from routing language — new parents ask for "someone"
    // too. Trust it only when Nora's own reply corroborates current-family status; otherwise fall
    // back to any real new-parent evidence, and only land on current_family as a last resort when
    // there is truly nothing else to go on (still surfaced as unknown for staff review, not
    // silently mislabeled).
    const wantsRoutingOnly = (webhook?.transcript && callerWantsHumanRoutingOnlyFromTranscript(webhook.transcript))
        || callerWantsHumanRoutingOnly(callerText);
    if (wantsRoutingOnly) {
        const agentText = webhook ? getAgentText(webhook) : '';
        if (agentConfirmedCurrentFamily(agentText)) {
            return 'current_family';
        }
        const hasNewParentEvidence =
            hasSchoolRelatedIntent({ summary, callerText, questionsAsked, comprehensiveResult, tags })
            || hasCapturedEnrollmentData({ childName, childAge, comprehensiveResult })
            || tourBooked;
        if (hasNewParentEvidence) {
            return 'new_parent';
        }
        return 'unknown';
    }

    if (isUnknownCall({
        tags,
        summary: summary || (webhook ? resolveWebhookSummary(webhook) : ''),
        callerText,
        questionsAsked,
        comprehensiveResult,
        childName,
        childAge,
        tourBooked,
    })) {
        return 'unknown';
    }

    return 'new_parent';
}

function enrichTags(tags, leadTemperature, parentSegment) {
    let next = dedupeTags(Array.isArray(tags) ? tags : []);
    const hasTag = (label) => next.some((tag) => tag.toLowerCase() === label.toLowerCase());

    next = next.filter((tag) => tag.toLowerCase() !== 'hot lead' && tag.toLowerCase() !== 'warm lead');
    if (leadTemperature === 'hot' && !hasTag('Hot Lead')) {
        next.unshift('Hot Lead');
    } else if (leadTemperature === 'warm' && !hasTag('Warm Lead')) {
        next.unshift('Warm Lead');
    }

    if (parentSegment === 'current_family' && !hasTag('Current Family')) {
        next.push('Current Family');
    } else if (parentSegment === 'unknown' && !hasTag('Unknown')) {
        next.push('Unknown');
    } else if (parentSegment === 'new_parent' && !hasTag('New Parent')) {
        next.push('New Parent');
    }

    if (parentSegment === 'unknown') {
        next = next.filter((tag) => tag.toLowerCase() !== 'new parent');
        next = next.filter((tag) => tag.toLowerCase() !== 'current family');
    }

    return dedupeTags(next);
}

function applyTagPostProcessing(comprehensiveData) {
    const data = { ...comprehensiveData };
    data.tags = [...(data.tags || [])];

    if (data.childName && data.childAge) {
        data.tags = data.tags.filter((tag) => !tag.toLowerCase().includes('no child info'));
    }

    if ((!data.childName || !data.childAge) && Array.isArray(data.missingDetails)) {
        const missingChild = data.missingDetails.some((m) => {
            const lower = String(m).toLowerCase();
            return lower.includes('child name') || lower.includes('child age');
        });
        if (missingChild && !data.tags.some((tag) => tag.toLowerCase().includes('no child info'))) {
            data.tags.push('No child info captured');
        }
    }

    if (Array.isArray(data.missingDetails) && data.missingDetails.length > 0) {
        if (!data.tags.some((tag) => tag.toLowerCase().includes('partial call'))) {
            data.tags.push('Partial call');
        }
    }

    data.tags = ensureTourBookedEmailMissingTag(data.tags, {
        tourBooked: data.tourBooked,
        parentEmail: data.parentEmail,
        emailMissing: data.emailMissing,
    });

    data.tags = dedupeTags(data.tags);
    if (data.leadTemperature !== 'hot') {
        data.tags = data.tags.filter((tag) => tag.toLowerCase() !== 'hot lead');
    }
    if (data.leadTemperature !== 'warm') {
        data.tags = data.tags.filter((tag) => tag.toLowerCase() !== 'warm lead');
    }

    return data;
}

function mapInsightFields(webhook, { tags = [], comprehensiveResult = null, summaryText = '' } = {}) {
    const callerText = getCallerText(webhook);
    const resolvedSummary = summaryText || comprehensiveResult?.summary || resolveWebhookSummary(webhook);
    const questionsAsked = mergeParentQuestionsFromExtraction(comprehensiveResult, {
        summaryText: resolvedSummary,
    });
    const missingDetails = Array.isArray(comprehensiveResult?.missing_details)
        ? comprehensiveResult.missing_details
        : (Array.isArray(webhook?.extractedMissingDetails) ? webhook.extractedMissingDetails : []);
    const tourBooked = isTourBooked(webhook, comprehensiveResult);
    const parentEmail = resolveParentEmail(webhook, comprehensiveResult);
    const emailMissing = isTourBookedEmailMissing(webhook, comprehensiveResult);
    const childName = safeStr(comprehensiveResult?.child_name)
        || webhook?.extractedChildName
        || webhook?.tour_booking_extracted?.childName
        || '';
    const childAge = safeStr(comprehensiveResult?.child_age)
        || webhook?.extractedChildAge
        || webhook?.tour_booking_extracted?.childAge
        || '';
    const parentSegment = detectParentSegment(tags, resolvedSummary, webhook, {
        comprehensiveResult,
        questionsAsked,
        childName,
        childAge,
        tourBooked,
    });

    const leadTemperature = classifyLeadTemperature({
        tags,
        summary: resolvedSummary,
        callerText,
        parentSegment,
        questionsAsked,
        missingDetails,
        comprehensiveResult,
        tourBooked,
    });
    const isHotLead = leadTemperature === 'hot';

    return applyTagPostProcessing({
        tags: enrichTags(tags, leadTemperature, parentSegment),
        childName,
        childAge,
        language: comprehensiveResult?.language_spoken || webhook?.extractedLanguage || '',
        missingDetails,
        questionsAsked,
        isHotLead,
        leadTemperature,
        parentSegment,
        tourBooked,
        parentEmail,
        emailMissing,
    });
}

function mapComprehensiveResult(comprehensiveResult, webhook) {
    return mapInsightFields(webhook, {
        tags: comprehensiveResult?.tags || [],
        comprehensiveResult,
        summaryText: comprehensiveResult?.summary || resolveWebhookSummary(webhook),
    });
}

function mapWebhookExtractedFields(webhook) {
    return mapInsightFields(webhook, {
        tags: webhook?.extractedTags || [],
        comprehensiveResult: webhook?.comprehensive_result || null,
        summaryText: resolveWebhookSummary(webhook),
    });
}

function mapSummaryFallback(webhook) {
    return mapInsightFields(webhook, {
        tags: [],
        comprehensiveResult: webhook?.comprehensive_result || null,
        summaryText: resolveWebhookSummary(webhook),
    });
}

function sanitizeCachedInsight(doc, webhook = null) {
    let parentSegment = doc.parentSegment || 'new_parent';
    let tags = doc.tags || [];

    if (webhook) {
        const fresh = webhook.comprehensive_result
            ? mapComprehensiveResult(webhook.comprehensive_result, webhook)
            : mapSummaryFallback(webhook);
        parentSegment = fresh.parentSegment || parentSegment;
        tags = fresh.tags || tags;
    }

    const questionsAsked = doc.questionsAsked || [];
    const missingDetails = doc.missingDetails || [];
    const leadTemperature = classifyLeadTemperature({
        tags,
        summary: doc.summary || '',
        callerText: webhook ? getCallerText(webhook) : '',
        parentSegment,
        questionsAsked,
        missingDetails,
        comprehensiveResult: webhook?.comprehensive_result || null,
        tourBooked: doc.tourBooked ?? (webhook ? isTourBooked(webhook, webhook?.comprehensive_result) : false),
    });
    const isHotLead = leadTemperature === 'hot';
    return {
        tags: enrichTags(tags.filter((t) => t.toLowerCase() !== 'hot lead' && t.toLowerCase() !== 'warm lead'), leadTemperature, parentSegment),
        isHotLead,
        leadTemperature,
        parentSegment,
    };
}

function mapLeadInsightDoc(doc, webhook = null) {
    if (!doc) return null;
    const sanitized = sanitizeCachedInsight(doc, webhook);
    return {
        tags: sanitized.tags,
        childName: doc.childName || '',
        childAge: doc.childAge || '',
        language: doc.language || '',
        missingDetails: doc.missingDetails || [],
        questionsAsked: doc.questionsAsked || [],
        isHotLead: sanitized.isHotLead,
        leadTemperature: sanitized.leadTemperature,
        parentSegment: sanitized.parentSegment,
        aiProcessed: Boolean(doc.aiProcessed),
    };
}

function buildInsightSnapshot(webhook, insightData = {}) {
    const emailMissingForTour = isTourBookedEmailMissing(webhook);
    const parentSegment = insightData.parentSegment || 'new_parent';
    return {
        callerName: getCallerNameFromWebhook(webhook),
        callerPhone: getCallerPhoneFromWebhook(webhook, 'Unknown'),
        summary: resolveWebhookSummary(webhook),
        callTimestamp: webhook.metadata?.start_time_unix_secs
            ? new Date(webhook.metadata.start_time_unix_secs * 1000)
            : (webhook.received_at || new Date()),
        durationSeconds: getCallDurationSeconds(webhook),
        actionNeededEligible: emailMissingForTour
            ? !webhook.actionTaken
            : (!webhook.tour_booking_detected && !webhook.actionTaken),
        actionTakenFeedback: webhook.actionTakenFeedback || '',
        actionTakenAt: webhook.actionTakenAt || null,
    };
}

function buildLeadInsightPersistPayload(schoolId, webhook, insightData, transcriptHash) {
    const snapshot = buildInsightSnapshot(webhook, insightData);
    return {
        schoolId,
        webhookId: webhook._id,
        conversationId: webhook.conversation_id || '',
        aiProcessed: true,
        transcriptHash: transcriptHash || hashTranscript(getTranscriptText(webhook)),
        tags: insightData.tags || [],
        childName: insightData.childName || '',
        childAge: insightData.childAge || '',
        language: insightData.language || '',
        missingDetails: insightData.missingDetails || [],
        questionsAsked: insightData.questionsAsked || [],
        isHotLead: Boolean(insightData.isHotLead),
        leadTemperature: insightData.leadTemperature || 'cold',
        parentSegment: insightData.parentSegment || 'new_parent',
        processedAt: new Date(),
        ...snapshot,
    };
}

async function upsertLeadInsight({ schoolId, webhook, insightData, transcriptHash }) {
    if (!schoolId || !webhook?._id) return null;

    const payload = buildLeadInsightPersistPayload(schoolId, webhook, insightData, transcriptHash);
    const resolved = await applyPriorCallerNameFromHistory(schoolId, {
        callerName: payload.callerName,
        callerPhone: payload.callerPhone,
        tags: payload.tags,
        callTimestamp: payload.callTimestamp,
        webhookId: webhook._id,
    });
    payload.callerName = resolved.callerName;
    payload.tags = resolved.tags;

    return LeadInsight.findOneAndUpdate(
        { schoolId, webhookId: webhook._id },
        { $set: payload },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
}

async function buildInsightDataForWebhook(webhook, { allowOpenAI = false } = {}) {
    const transcriptText = getTranscriptText(webhook);
    const transcriptHash = hashTranscript(transcriptText);

    if (webhook?.comprehensive_result) {
        return { ...mapComprehensiveResult(webhook.comprehensive_result, webhook), transcriptHash };
    }

    if (webhook?.ai_processed && Array.isArray(webhook?.extractedTags)) {
        return { ...mapWebhookExtractedFields(webhook), transcriptHash };
    }

    if (allowOpenAI && transcriptText) {
        try {
            const extracted = await extractTourDetails(transcriptText, {
                childName: webhook?.tour_booking_extracted?.childName || '',
                childAge: webhook?.tour_booking_extracted?.childAge || '',
                purpose: webhook?.summary || '',
            });
            const callerText = getCallerText(webhook);
            const parentSegment = detectParentSegment(extracted.tags, webhook?.summary, webhook);
            const questionsAsked = mergeParentQuestionsFromExtraction(extracted, {
                summaryText: webhook?.summary || '',
            });
            const leadTemperature = classifyLeadTemperature({
                tags: extracted.tags || [],
                summary: webhook?.summary,
                callerText,
                parentSegment,
                questionsAsked,
                missingDetails: extracted.missingDetails || [],
                comprehensiveResult: extracted,
            });
            const isHotLead = leadTemperature === 'hot';
            const data = applyTagPostProcessing({
                ...extracted,
                questionsAsked,
                tags: enrichTags(extracted.tags || [], leadTemperature, parentSegment),
                isHotLead,
                leadTemperature,
                parentSegment,
            });
            return { ...data, transcriptHash };
        } catch (err) {
            console.error('[LeadInsight] OpenAI extraction failed:', err.message);
        }
    }

    return { ...mapSummaryFallback(webhook), transcriptHash };
}

async function resolveInsightsForWebhooks(webhooks, schoolId, options = {}) {
    const { allowOpenAI = false, persist = false } = options;
    if (!Array.isArray(webhooks) || webhooks.length === 0) {
        return new Map();
    }

    const webhookIds = webhooks.map((wh) => wh._id);
    const existingInsights = await LeadInsight.find({
        schoolId,
        webhookId: { $in: webhookIds },
        aiProcessed: true,
    }).lean();

    const insightMap = new Map(existingInsights.map((doc) => [String(doc.webhookId), doc]));
    const resolved = new Map();
    const toPersist = [];

    for (const webhook of webhooks) {
        const key = String(webhook._id);
        const cached = insightMap.get(key);

        if (cached) {
            resolved.set(key, mapLeadInsightDoc(cached, webhook));
            continue;
        }

        if (!persist) {
            // Fast read path for page loads — never block on OpenAI or DB writes.
            resolved.set(key, mapSummaryFallback(webhook));
            continue;
        }

        const transcriptHash = hashTranscript(getTranscriptText(webhook));
        const insightData = await buildInsightDataForWebhook(webhook, { allowOpenAI });
        resolved.set(key, insightData);
        toPersist.push({ webhook, insightData, transcriptHash: insightData.transcriptHash || transcriptHash });
    }

    if (!persist || toPersist.length === 0) {
        return resolved;
    }

    const bulkOps = [];
    for (const { webhook, insightData, transcriptHash } of toPersist) {
        const payload = buildLeadInsightPersistPayload(
            schoolId,
            webhook,
            insightData,
            insightData.transcriptHash || transcriptHash
        );
        const resolvedName = await applyPriorCallerNameFromHistory(schoolId, {
            callerName: payload.callerName,
            callerPhone: payload.callerPhone,
            tags: payload.tags,
            callTimestamp: payload.callTimestamp,
            webhookId: webhook._id,
        });
        payload.callerName = resolvedName.callerName;
        payload.tags = resolvedName.tags;
        if (resolvedName.usedPastCallName && insightData) {
            insightData.callerName = resolvedName.callerName;
            insightData.tags = resolvedName.tags;
            resolved.set(String(webhook._id), {
                ...resolved.get(String(webhook._id)),
                callerName: resolvedName.callerName,
                tags: resolvedName.tags,
            });
        }
        bulkOps.push({
            updateOne: {
                filter: { schoolId, webhookId: webhook._id },
                update: { $set: payload },
                upsert: true,
            },
        });
    }

    await LeadInsight.bulkWrite(bulkOps, { ordered: false })
        .catch((err) => console.error('[LeadInsight] Bulk persist failed:', err.message));

    return resolved;
}

function buildActionNeededCallFromInsight(row, backendUrl, userToken, webhook = null) {
    const conversationId = row.conversationId || '';
    const sanitized = sanitizeCachedInsight(row, webhook);
    const tags = webhook
        ? ensureTourBookedEmailMissingTag(sanitized.tags, {
            tourBooked: isTourBooked(webhook),
            parentEmail: resolveParentEmail(webhook),
            emailMissing: isTourBookedEmailMissing(webhook),
        })
        : sanitized.tags;
    const summary = resolveCachedSummary(row, webhook);
    const fromWebhook = webhook ? getCallerNameFromWebhook(webhook, null) : null;
    const callerName = isUsableCallerName(fromWebhook)
        ? String(fromWebhook).trim()
        : (isUsableCallerName(row.callerName) ? String(row.callerName).trim() : (row.callerName || 'Parent'));
    return {
        id: String(row.webhookId),
        conversationId: conversationId || null,
        callerName,
        callerPhone: row.callerPhone || 'Unknown',
        summary,
        timestamp: row.callTimestamp || row.processedAt || new Date(),
        recordingUrl: conversationId
            ? `${backendUrl}/api/school/calls/${conversationId}/audio?token=${userToken}`
            : null,
        duration: row.durationSeconds || 0,
        questionsAsked: row.questionsAsked || [],
        actionTaken: Boolean(webhook?.actionTaken),
        actionTakenAt: row.actionTakenAt || null,
        actionTakenFeedback: row.actionTakenFeedback || '',
        feedbackHistory: undefined,
        tags,
        childName: row.childName || '',
        childAge: row.childAge || '',
        language: row.language || '',
        missingDetails: row.missingDetails || [],
        isHotLead: sanitized.isHotLead,
        leadTemperature: sanitized.leadTemperature,
        parentSegment: sanitized.parentSegment,
        aiProcessed: Boolean(row.aiProcessed ?? true),
    };
}

async function loadActionNeededCalls(schoolObjectId, backendUrl, userToken, options = {}) {
    const since = options.since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const ElevenLabsWebhook = require('../models/ElevenLabsWebhook');
    const listProjection = [
        'webhookId', 'conversationId', 'callerName', 'callerPhone', 'summary',
        'callTimestamp', 'durationSeconds', 'actionNeededEligible', 'actionTakenFeedback',
        'actionTakenAt', 'questionsAsked', 'tags', 'childName', 'childAge', 'language',
        'missingDetails', 'isHotLead', 'leadTemperature', 'parentSegment', 'aiProcessed', 'processedAt',
    ].join(' ');

    const phoneKey = (phone) => {
        const digits = String(phone || '').replace(/\D/g, '');
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

    // Only true follow-ups — do not dump every "unknown" call into Action Needed.
    const cachedRows = await LeadInsight.find({
        schoolId: schoolObjectId,
        callTimestamp: { $gte: since },
        actionNeededEligible: true,
    })
        .select(listProjection)
        .sort({ callTimestamp: -1 })
        .lean();

    const [phoneHistoryRows, allWebhookMeta] = await Promise.all([
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

    const applyPastCallerName = (call) => {
        if (isUsableCallerName(call.callerName)) {
            return call;
        }
        const resolved = resolveCallerNameWithPastFallback(nameHistoryIndex, {
            callerName: call.callerName,
            callerPhone: call.callerPhone,
            callTimestamp: call.timestamp,
            webhookId: call.id,
        });
        if (!resolved.usedPastCallName) return call;
        return {
            ...call,
            callerName: resolved.callerName,
            tags: withPastCallNameTag(call.tags),
        };
    };

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

    const attachFrequency = (call) => {
        const key = phoneKey(call.callerPhone);
        if (!key) {
            return {
                ...call,
                callOrdinal: 1,
                callCountTotal: 1,
                callOrdinalLabel: '1st call',
            };
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
            ...call,
            callOrdinal: ordinal,
            callCountTotal: total,
            callOrdinalLabel: total > 1
                ? `${toOrdinal(ordinal)} of ${total} calls`
                : `${toOrdinal(ordinal)} call`,
        };
    };

    if (cachedRows.length > 0) {
        const webhookIds = cachedRows.map((row) => row.webhookId).filter(Boolean);
        const webhooks = await ElevenLabsWebhook.find({ _id: { $in: webhookIds } })
            .select('_id conversation_id summary transcript comprehensive_result tour_booking_extracted metadata received_at user_id actionTaken actionTakenFeedback actionTakenAt')
            .lean();
        const webhookMap = new Map(webhooks.map((wh) => [String(wh._id), wh]));

        return cachedRows
            .map((row) =>
                buildActionNeededCallFromInsight(
                    row,
                    backendUrl,
                    userToken,
                    webhookMap.get(String(row.webhookId)) || null
                )
            )
            .map(applyPastCallerName)
            .filter((call) => !call.actionTaken)
            .map(attachFrequency);
    }

    const webhooks = await ElevenLabsWebhook.find({
        type: 'post_call_transcription',
        received_at: { $gte: since },
        actionTaken: { $ne: true },
        schoolId: schoolObjectId,
    })
        .select('_id conversation_id received_at metadata summary tour_booking_detected tour_booking_extracted comprehensive_result user_id actionTakenFeedback actionTakenAt feedbackHistory')
        .sort({ received_at: -1 })
        .lean();

    const eligibleWebhooks = webhooks.filter((wh) => {
        if (!wh.tour_booking_detected) return true;
        return isTourBookedEmailMissing(wh);
    });

    const insightMap = await resolveInsightsForWebhooks(eligibleWebhooks, schoolObjectId, {
        allowOpenAI: false,
        persist: false,
    });

    return eligibleWebhooks
        .map((wh) =>
            buildActionNeededCall(wh, insightMap.get(String(wh._id)), backendUrl, userToken)
        )
        .map(applyPastCallerName)
        .filter((call) => !call.actionTaken)
        .map(attachFrequency);
}

async function markLeadInsightActionTaken(webhookId, feedback = '') {
    await LeadInsight.updateOne(
        { webhookId },
        {
            $set: {
                actionNeededEligible: false,
                actionTakenFeedback: feedback || '',
                actionTakenAt: new Date(),
            },
        }
    );
}

async function removeLeadInsightForWebhook(webhookId) {
    await LeadInsight.deleteOne({ webhookId });
}

function buildActionNeededCall(webhook, insight, backendUrl, userToken) {
    const data = insight || mapSummaryFallback(webhook);

    return {
        id: webhook._id.toString(),
        conversationId: webhook.conversation_id,
        callerName: getCallerNameFromWebhook(webhook),
        callerPhone: getCallerPhoneFromWebhook(webhook, 'Unknown'),
        summary: resolveWebhookSummary(webhook),
        timestamp: webhook.metadata?.start_time_unix_secs
            ? new Date(webhook.metadata.start_time_unix_secs * 1000)
            : webhook.received_at,
        recordingUrl: webhook.conversation_id
            ? `${backendUrl}/api/school/calls/${webhook.conversation_id}/audio?token=${userToken}`
            : null,
        duration: getCallDurationSeconds(webhook),
        questionsAsked: data.questionsAsked || [],
        actionTaken: webhook.actionTaken || false,
        actionTakenAt: webhook.actionTakenAt || null,
        actionTakenFeedback: webhook.actionTakenFeedback || '',
        feedbackHistory: webhook.feedbackHistory || undefined,
        tags: data.tags || [],
        childName: data.childName || '',
        childAge: data.childAge || '',
        language: data.language || '',
        missingDetails: data.missingDetails || [],
        isHotLead: Boolean(data.isHotLead),
        leadTemperature: data.leadTemperature || 'cold',
        parentSegment: data.parentSegment || 'new_parent',
        aiProcessed: Boolean(data.aiProcessed ?? true),
    };
}

module.exports = {
    TOUR_BOOKED_TAG,
    TOUR_BOOKED_EMAIL_MISSING_TAG,
    PAST_CALL_NAME_TAG,
    hashTranscript,
    getTranscriptText,
    detectHotLead,
    classifyLeadTemperature,
    detectParentSegment,
    enrichTags,
    resolveParentEmail,
    isTourBooked,
    isTourBookedEmailMissing,
    wasEmailSkippedOrRejectedInTranscript,
    isValidConfirmedEmail,
    getValidEmailFromSources,
    ensureTourBookedEmailMissingTag,
    isUnknownCall,
    hasSchoolRelatedIntent,
    mapComprehensiveResult,
    mapWebhookExtractedFields,
    mapSummaryFallback,
    upsertLeadInsight,
    buildInsightDataForWebhook,
    resolveInsightsForWebhooks,
    buildActionNeededCall,
    buildActionNeededCallFromInsight,
    loadActionNeededCalls,
    markLeadInsightActionTaken,
    removeLeadInsightForWebhook,
    buildInsightSnapshot,
    buildLeadInsightPersistPayload,
    hasPastCallNameTag,
    withPastCallNameTag,
    findPriorUsableCallerName,
    applyPriorCallerNameFromHistory,
    buildCallerNameHistoryIndex,
    lookupPriorCallerNameFromIndex,
    resolveCallerNameWithPastFallback,
};
