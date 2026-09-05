const AGENT_TRANSFER_PATTERNS = [
    /connect you to the front desk/i,
    /connect you to (?:the )?team/i,
    /connect you (?:right )?now/i,
    /i will connect you/i,
    /transfer you to/i,
    /transfer you (?:to|now)/i,
    /please stay on the line/i,
    /front desk (?:line|lines) (?:is|are) (?:all )?busy/i,
    /not able to transfer you/i,
    /transfer did not go through/i,
    /unable to transfer/i,
];

const MAX_CALLER_UTTERANCE_CHARS = 160;
const MAX_AGENT_UTTERANCE_CHARS = 280;
const MAX_QUESTION_CHARS = 180;

const PROMPT_LEAK_PATTERN = /you are nora|virtual scheduling assistant|knowledge base|collect information|move to tour|general behavior|technical fallback|\{\{school/i;

/**
 * Short caller phrases that identify an existing enrolled family.
 * Kept to reliable self-identification only — generic "front desk / representative"
 * routing is handled via the extractor's guarded "Current Family" tag, because new
 * families also sometimes ask for a human and must not be mislabeled as current.
 */
const CALLER_CURRENT_FAMILY_PATTERNS = [
    /^currents?\.?\s*$/i,
    /^current family\.?\s*$/i,
    /\b(i(?:'m| am)|we(?:'re| are))(?: a)? current family\b/i,
    /\bcurrent family\b/i,
    /\bcurrent(?:ly)? enrolled\b/i,
    /\benrolled family\b/i,
    /\b(i(?:'m| am)|we(?:'re| are))(?: an?)? enrolled\b/i,
    /^currently enrolled\.?\s*$/i,
    /\balready enrolled\b/i,
    /\bexisting (?:family|parent)\b/i,
    /\balready go(?:es)? (?:there|here)\b/i,
    /\bcurrent (?:parent|student)\b/i,
    /\breturning family\b/i,
    /\bexisting (?:student|customer|client)\b/i,
    /\bmy (?:child|kid|son|daughter|kids|children)(?:'s)? (?:is|are)? ?already (?:enrolled|attend(?:ing|s)?|a student)\b/i,
    /\b(?:i(?:'m| am)|we(?:'re| are)) (?:already )?(?:a )?(?:current|existing) (?:client|customer|family)\b/i,
    // Spanish: existing / already-enrolled family
    /\bfamilia actual\b/i,
    /\bfamilia existente\b/i,
    /\bfamilia inscrita\b/i,
    /\bestudiante actual\b/i,
    /\bmatriculad[oa]s?\b/i,
    /\b(?:ya\s+)?(?:est[aá]\s+)?inscrit[oa]s?\b/i,
    /^front desk\??\s*$/i,
    /\btransfer to\b/i,
];

/** Caller explicitly said they are a new / prospective family. */
const CALLER_NEW_FAMILY_PATTERNS = [
    /^new family\.?\s*$/i,
    /^nueva\.?\s*$/i,
    /^familia nueva\.?\s*$/i,
    /\b(?:i(?:'m| am)|we(?:'re| are))(?: a)? new family\b/i,
    /\bnew family\b/i,
    /\b(?:i(?:'m| am)|we(?:'re| are))(?: a)? new parent\b/i,
    /\bnew parent\b/i,
    /\bfamilia nueva\b/i,
    /\b(?:i(?:'m| am)|we(?:'re| are)) calling as a new family\b/i,
    /\bprospective (?:family|parent)\b/i,
];

/**
 * Caller wants a human at the school without identifying as a new family.
 * In practice these are almost always current enrolled parents who skip the AI.
 */
const CALLER_HUMAN_ROUTING_PATTERNS = [
    /\brepresentatives?\b/i,
    /\bfront desk\b/i,
    /\b(?:speak|talk)\s+(?:to|with)\s+(?:the\s+|a\s+)?(?:director|representative|front desk|someone|a\s+real\s+person)\b/i,
    /\bconnect(?:ed)?\s+(?:me\s+)?(?:to\s+)?(?:someone|a\s+(?:real\s+)?person)\b/i,
    /\bsomeone\s+(?:real|at the front desk)\b/i,
    /\bneed\s+someone\s+(?:at\s+)?(?:the\s+)?front desk\b/i,
];

/** Non-parent callers — never classify as current family via routing heuristic. */
const NON_PARENT_CALLER_PATTERNS = [
    /\b(?:i(?:'m| am)|we(?:'re| are))\s+(?:a\s+)?teacher\b/i,
    /\bcalling as a teacher\b/i,
    /\bvendor\b/i,
    /\bbusiness owner\b/i,
    /\bemployment\b/i,
    /\bemployee\b/i,
    /\b(?:sand arts|wrong school|it'?s wrong)\b/i,
    /\bneither\b.*\bemployee\b/i,
    /\bemployee\b.*\bneither\b/i,
];

const ROUTING_ONLY_PATTERNS = [
    ...CALLER_CURRENT_FAMILY_PATTERNS,
    /^(hi|hello|hey|hola|yes|yeah|yep|ok|okay|no|thanks|thank you)\.?\s*$/i,
];

/** Nora confirming current family or offering front-desk transfer (short agent lines only). */
const AGENT_CURRENT_FAMILY_PATTERNS = [
    /\bunderstand you(?:'re| are) a current family\b/i,
    /\byou are a current (?:enrolled )?family\b/i,
    /\bconnect you to the front desk\b/i,
    /\bgoing to connect you\b/i,
];

function isOpeningFamilyQuestion(text) {
    const value = String(text || '');
    return /\b(?:are you|let me know if you(?:'re| are)|if you(?:'re| are))(?: a)? current(?: enrolled)? family\b/i.test(value)
        || /\bcurrent enrolled family,?\s+or\b/i.test(value);
}

function normalizeRole(role) {
    return String(role || '').toLowerCase();
}

function entryText(entry) {
    return String(entry?.text || entry?.content || entry?.message || '').trim();
}

function isPromptLeak(text) {
    const value = String(text || '').trim();
    if (!value) return true;
    if (value.length > 500) return true;
    return PROMPT_LEAK_PATTERN.test(value);
}

function isCallerRole(role) {
    const normalized = normalizeRole(role);
    return normalized === 'user' || normalized === 'parent' || normalized === 'caller'
        || normalized === 'customer' || normalized === 'human';
}

function isAgentRole(role) {
    const normalized = normalizeRole(role);
    return normalized === 'agent' || normalized === 'assistant' || normalized === 'mia' || normalized === 'nora';
}

function getCallerUtterances(transcriptArray) {
    if (!Array.isArray(transcriptArray)) return [];
    return transcriptArray
        .filter((entry) => isCallerRole(entry.role || entry.speaker))
        .map(entryText)
        .filter((text) => text && !isPromptLeak(text) && text.length <= MAX_CALLER_UTTERANCE_CHARS);
}

function getAgentUtterances(transcriptArray) {
    if (!Array.isArray(transcriptArray)) return [];
    return transcriptArray
        .filter((entry) => isAgentRole(entry.role || entry.speaker))
        .map(entryText)
        .filter((text) => text && !isPromptLeak(text) && text.length <= MAX_AGENT_UTTERANCE_CHARS);
}

function getCallerTextFromTranscript(transcriptArray) {
    return getCallerUtterances(transcriptArray).join(' ');
}

function getAgentTextFromTranscript(transcriptArray) {
    return getAgentUtterances(transcriptArray).join(' ');
}

function callerIdentifiedAsCurrentFamily(callerText) {
    const utterances = String(callerText || '').trim()
        ? String(callerText).split(/\s*\|\s*|\n+/).map((line) => line.trim()).filter(Boolean)
        : [];

    for (const line of utterances) {
        if (line.length > MAX_CALLER_UTTERANCE_CHARS || isPromptLeak(line)) continue;
        if (CALLER_CURRENT_FAMILY_PATTERNS.some((pattern) => pattern.test(line))) {
            return true;
        }
    }
    return false;
}

function callerIdentifiedAsNewFamily(callerText) {
    const utterances = String(callerText || '').trim()
        ? String(callerText).split(/\s*\|\s*|\n+/).map((line) => line.trim()).filter(Boolean)
        : [];

    for (const line of utterances) {
        if (line.length > MAX_CALLER_UTTERANCE_CHARS || isPromptLeak(line)) continue;
        if (CALLER_NEW_FAMILY_PATTERNS.some((pattern) => pattern.test(line))) {
            return true;
        }
    }
    const haystack = String(callerText || '');
    return CALLER_NEW_FAMILY_PATTERNS.some((pattern) => pattern.test(haystack));
}

function callerWantsHumanRoutingOnly(callerText) {
    const haystack = String(callerText || '').trim();
    if (!haystack) return false;
    if (callerIdentifiedAsNewFamily(haystack)) return false;
    if (/\benroll(?:able|ment|ing)?\b/i.test(haystack)) return false;
    if (callerIdentifiedAsCurrentFamily(haystack)) return true;
    if (NON_PARENT_CALLER_PATTERNS.some((pattern) => pattern.test(haystack))) return false;
    return CALLER_HUMAN_ROUTING_PATTERNS.some((pattern) => pattern.test(haystack));
}

/** Caller explicitly self-identified as a non-parent (teacher/vendor/employee/wrong number). */
function callerIsNonParent(callerText) {
    const haystack = String(callerText || '').trim();
    if (!haystack) return false;
    return NON_PARENT_CALLER_PATTERNS.some((pattern) => pattern.test(haystack));
}

function callerIsNonParentFromTranscript(transcriptArray) {
    return callerIsNonParent(getCallerUtterances(transcriptArray).join('\n'));
}

function callerIdentifiedAsNewFamilyFromTranscript(transcriptArray) {
    return callerIdentifiedAsNewFamily(getCallerUtterances(transcriptArray).join('\n'));
}

function callerWantsHumanRoutingOnlyFromTranscript(transcriptArray) {
    return callerWantsHumanRoutingOnly(getCallerUtterances(transcriptArray).join('\n'));
}

function callerIdentifiedAsCurrentFamilyFromTranscript(transcriptArray) {
    return callerIdentifiedAsCurrentFamily(getCallerUtterances(transcriptArray).join('\n'));
}

function agentOfferedTransfer(agentText) {
    const utterances = String(agentText || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
    for (const line of utterances) {
        if (line.length > MAX_AGENT_UTTERANCE_CHARS || isPromptLeak(line)) continue;
        if (AGENT_TRANSFER_PATTERNS.some((pattern) => pattern.test(line))) return true;
    }
    return false;
}

function agentOfferedTransferFromTranscript(transcriptArray) {
    return agentOfferedTransfer(getAgentUtterances(transcriptArray).join('\n'));
}

function transferToolUsed(transcriptArray) {
    if (!Array.isArray(transcriptArray)) return false;
    return transcriptArray.some((entry) => {
        const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
        return toolCalls.some((tc) => {
            const name = String(tc?.tool_name || tc?.name || '').toLowerCase();
            return name.includes('transfer');
        });
    });
}

function extractCallerQuestions(transcriptArray) {
    const questions = [];
    for (const line of getCallerUtterances(transcriptArray)) {
        const trimmed = line.replace(/\s+/g, ' ').trim();
        if (trimmed.length < 12 || trimmed.length > MAX_QUESTION_CHARS) continue;
        if (ROUTING_ONLY_PATTERNS.some((pattern) => pattern.test(trimmed))) continue;
        questions.push(trimmed);
    }
    return [...new Set(questions)];
}

function agentConfirmedCurrentFamily(agentText) {
    const utterances = String(agentText || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
    for (const line of utterances) {
        if (line.length > MAX_AGENT_UTTERANCE_CHARS || isPromptLeak(line) || isOpeningFamilyQuestion(line)) {
            continue;
        }
        // Nora asking a question is not confirming current-family status.
        if (/\?/.test(line) && /\bcurrent(?: enrolled)? family\b/i.test(line)) {
            continue;
        }
        if (AGENT_CURRENT_FAMILY_PATTERNS.some((pattern) => pattern.test(line))) return true;
    }
    return false;
}

function agentConfirmedCurrentFamilyFromTranscript(transcriptArray) {
    return agentConfirmedCurrentFamily(getAgentUtterances(transcriptArray).join('\n'));
}

function isCurrentFamilyCall(transcriptArray) {
    return callerIdentifiedAsCurrentFamilyFromTranscript(transcriptArray);
}

function isCurrentFamilyTransferCall(transcriptArray) {
    if (!isCurrentFamilyCall(transcriptArray)) return false;
    return agentOfferedTransferFromTranscript(transcriptArray)
        || transferToolUsed(transcriptArray)
        || agentConfirmedCurrentFamilyFromTranscript(transcriptArray);
}

function buildCurrentFamilySummary({ questionsAsked, transferred }) {
    const parts = ['The caller identified as a current enrolled family member.'];
    if (transferred) {
        parts.push('The call was transferred to the front desk.');
    } else {
        parts.push('Nora offered to connect the caller to the front desk.');
    }
    if (questionsAsked.length > 0) {
        parts.push(`The caller also asked: ${questionsAsked.join('; ')}.`);
    }
    return parts.join(' ');
}

function buildCurrentFamilyTransferResult(transcriptArray) {
    const callerText = getCallerTextFromTranscript(transcriptArray);
    const transferred = agentOfferedTransferFromTranscript(transcriptArray)
        || transferToolUsed(transcriptArray)
        || agentConfirmedCurrentFamilyFromTranscript(transcriptArray);
    const questionsAsked = extractCallerQuestions(transcriptArray);
    const summary = buildCurrentFamilySummary({ questionsAsked, transferred });
    const language = /\bfamilia actual\b/i.test(callerText) ? 'Spanish' : 'English';

    return {
        call_state: 'partial',
        parent_name: null,
        parent_phone: null,
        parent_email: null,
        child_name: null,
        child_age: null,
        tour_booked: false,
        tour_date: null,
        tour_time: null,
        tour_datetime_iso: null,
        questions_asked: questionsAsked,
        topics_of_interest: [],
        enrollment_urgency: 'unknown',
        enrollment_target_date: null,
        language_spoken: language,
        tags: ['Current Family', 'Partial call'],
        missing_details: ['parent name', 'parent phone', 'parent email', 'child name', 'child age'],
        summary,
        email: {
            subject: 'Current Family — Call Transferred to Front Desk',
            body: `${summary}\n\n- Nora, Virtual Assistant`,
        },
        one_pager: {
            header: {
                parent_name: 'Not provided',
                phone: 'Not provided',
                email: 'Not provided',
                children: [],
            },
            tour_info: {
                scheduled: false,
                date_display: 'Not scheduled',
                attention_flag: 'Current enrolled family — transferred to front desk',
            },
            what_they_asked_about: questionsAsked.slice(0, 8),
            tour_talking_points: [],
        },
    };
}

function isNoMeaningfulInteractionSummary(summary) {
    return /no meaningful interaction|caller did not engage|call was interrupted/i.test(String(summary || ''));
}

function resolveCachedSummary(row, webhook = null) {
    if (webhook) {
        return resolveWebhookSummary(webhook);
    }
    const stored = String(row?.summary || '').trim();
    if (row?.parentSegment === 'current_family') {
        if (!stored || isNoMeaningfulInteractionSummary(stored)) {
            return 'The caller identified as a current enrolled family member. The call was transferred to the front desk.';
        }
    }
    return stored;
}

function isCorruptedCurrentFamilySummary(summary) {
    return /you are nora|virtual scheduling assistant|knowledge base/i.test(String(summary || ''));
}

function isHallucinatedCurrentFamilySummary(summary) {
    return /identified as a current enrolled family member/i.test(String(summary || ''))
        || /transferred to the front desk/i.test(String(summary || ''));
}

function hasCurrentFamilyTag(webhook) {
    const cr = webhook?.comprehensive_result || null;
    if (!cr || cr.call_state === 'no_interaction') return false;
    const crTags = Array.isArray(cr.tags) ? cr.tags : [];
    return crTags.some((t) => String(t).trim().toLowerCase() === 'current family');
}

function resolveWebhookSummary(webhook) {
    const stored = String(webhook?.summary || '').trim();
    const transcript = Array.isArray(webhook?.transcript) ? webhook.transcript : [];
    const currentFamilyTagged = hasCurrentFamilyTag(webhook);
    const callState = webhook?.comprehensive_result?.call_state || null;
    if (!transcript.length) {
        if (stored && !isNoMeaningfulInteractionSummary(stored) && !isCorruptedCurrentFamilySummary(stored)) {
            return stored;
        }
        return stored;
    }

    if (isCurrentFamilyCall(transcript)) {
        return buildCurrentFamilyTransferResult(transcript).summary;
    }

    if (callerWantsHumanRoutingOnlyFromTranscript(transcript)) {
        return buildCurrentFamilyTransferResult(transcript).summary;
    }

    // The extractor flagged this as a current family (guarded tag). Keep a proper
    // current-family summary instead of rewriting it to "No meaningful interaction".
    if (currentFamilyTagged) {
        if (stored && !isCorruptedCurrentFamilySummary(stored)) return stored;
        const fromCr = String(webhook?.comprehensive_result?.summary || '').trim();
        if (fromCr && !isCorruptedCurrentFamilySummary(fromCr)) return fromCr;
        return 'The caller identified as a current enrolled family member. The call was transferred to the front desk.';
    }

    // A "current family / transferred to front desk" summary is only a hallucination when the
    // call had NO real interaction. When the caller actually engaged (call_state partial/complete
    // — e.g. gave name, phone, child details), that phrasing is legitimate, so keep the real
    // summary and never overwrite it with "No meaningful interaction".
    const fromComprehensive = String(webhook?.comprehensive_result?.summary || '').trim();
    if (callState === 'no_interaction') {
        if (stored && isHallucinatedCurrentFamilySummary(stored)) {
            return 'No meaningful interaction. The call was interrupted or the caller did not engage.';
        }
        if (fromComprehensive && isHallucinatedCurrentFamilySummary(fromComprehensive)) {
            return 'No meaningful interaction. The call was interrupted or the caller did not engage.';
        }
    }

    if (stored && !isNoMeaningfulInteractionSummary(stored) && !isCorruptedCurrentFamilySummary(stored)) {
        return stored;
    }

    if (fromComprehensive && !isNoMeaningfulInteractionSummary(fromComprehensive)) {
        return fromComprehensive;
    }

    return stored;
}

module.exports = {
    getCallerTextFromTranscript,
    getAgentTextFromTranscript,
    callerIdentifiedAsCurrentFamily,
    callerIdentifiedAsNewFamily,
    callerWantsHumanRoutingOnly,
    callerIdentifiedAsNewFamilyFromTranscript,
    callerWantsHumanRoutingOnlyFromTranscript,
    callerIsNonParent,
    callerIsNonParentFromTranscript,
    isCurrentFamilyTransferCall,
    isCurrentFamilyCall,
    agentConfirmedCurrentFamily,
    buildCurrentFamilyTransferResult,
    isNoMeaningfulInteractionSummary,
    resolveWebhookSummary,
    resolveCachedSummary,
};
