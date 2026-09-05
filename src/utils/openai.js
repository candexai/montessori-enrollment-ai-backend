const axios = require('axios');
const { getComprehensivePrompt } = require('./comprehensivePrompt');

const wordCloudCache = new Map();

/**
 * Helper to call OpenAI Chat Completion API
 */
async function getChatCompletion(messages, options = {}) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.warn('[OpenAI] OPENAI_API_KEY not configured');
        return null;
    }

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: options.model || 'gpt-4o-mini',
            messages,
            response_format: options.response_format || { type: 'text' },
            temperature: options.temperature ?? 0.7,
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content;
    } catch (err) {
        console.error('[OpenAI] Completion error:', err.response?.data || err.message);
        return null;
    }
}

/**
 * Extract common questions and topics for a word cloud from transcripts
 */
async function generateWordCloud(transcripts) {
    if (!transcripts || transcripts.length === 0) return [];

    const combinedText = transcripts.join('\n---\n');
    
    // Simple in-memory cache based on transcript content and length
    const cacheKey = 'v2-' + combinedText.length + '-' + combinedText.slice(0, 40) + combinedText.slice(-40);
    const cached = wordCloudCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < 10 * 60 * 1000)) { 
        console.log('[OpenAI] Returning cached word cloud');
        return cached.data;
    }

    const prompt = `
You will be given multiple call transcripts between a parent and a school's AI assistant.

Purpose:
- Surface **specific, high-signal parent questions** and concerns from the transcripts.
- Discover unique topics that actual parents are asking about (e.g. "Security Cameras", "Vegetarian Options", "Summer Camp Dates").

Critical requirements:
- **NO GENERIC FILLER**: Do NOT output topics that apply to every call like "Tour Scheduling" or "Phone Number".
- **ORGANIC DISCOVERY**: Focus on what makes these specific transcripts unique. Use the "Allowed topic areas" below only as a guide for category types, but prioritize the actual words used by parents.
- **VERBATIM QUOTES**: For the "examples" field, provide **actual anonymized snippets** of what the parent said. Do not paraphrase into generic "Assistant-style" questions.
- EXCLUDE: Greetings, names, metadata (caller, agent), and generic enrollment verbs.

Return JSON with this exact shape:
{
  "topics": [
    { "word": "Teacher Ratios", "count": 3, "examples": ["What is the ratio for the toddler room?", "I'm concerned about how many kids per teacher."] },
    { "word": "Daily Schedule", "count": 2, "examples": ["Do they have a nap time?", "What time is lunch served?"] }
  ]
}

Where:
- "word": the specific topic (1-3 words). Title Case.
- "count": number of DISTINCT transcripts where this specific concern appears.
- "examples": 1-2 actual short quotes from the parent (anonymized, no names).
- Limit to 15-20 highest-signal topics.
- Include topics with count >= 2 to ensure they are "Common" as requested by user.

Transcripts:
${combinedText}
`;

    const result = await getChatCompletion([
        { role: 'system', content: 'You extract important parent questions from childcare inquiry transcripts for analytics. Focus on high-signal topics only.' },
        { role: 'user', content: prompt }
    ], { response_format: { type: 'json_object' }, temperature: 0.1 });

    if (!result) return [];
    
    try {
        const parsed = JSON.parse(result);
        const rawItems = parsed.topics || parsed.wordCloud || parsed.data || Object.values(parsed)[0] || [];
        
        if (!Array.isArray(rawItems)) return [];

        const banned = new Set([
            'hello', 'hi', 'thanks', 'thank you', 'yes', 'no', 'okay', 'ok',
            'tour', 'tours', 'call', 'calls', 'schedule', 'scheduled',
            'school', 'parent', 'child', 'children', 'caller', 'agent', 'system',
            'benny', 'sid', 'amandeep', 'nora', 'april',
            'hoping', 'enroll', 'enrollment', 'months', 'month', 'two', 'three', 'four', 'five',
            'asked', 'requested', 'confirmed', 'indicated', 'naming', 'named', 'collected',
            'information', 'user', 'timeline', 'arrangements', 'proceeded', 'acknowledged'
        ]);

        const cleaned = rawItems
            .map(item => {
                const wordRaw = String(item.word || item.text || item.topic || '').trim();
                const word = wordRaw
                    .replace(/\s+/g, ' ')
                    .replace(/[^\w\s\-&]/g, '')
                    .trim();
                const count = Number(item.count || item.value || item.importance || 1);
                const examples = Array.isArray(item.examples)
                    ? item.examples.map(x => String(x || '').trim()).filter(Boolean).slice(0, 2)
                    : [];
                return { word, count: Number.isFinite(count) ? count : 1, examples };
            })
            .filter(item => item.word)
            .filter(item => item.word.length >= 3 && item.word.length <= 40)
            .filter(item => !/\d/.test(item.word)) // drop anything with digits
            .filter(item => !item.word.includes('@')) // drop emails
            .filter(item => !banned.has(item.word.toLowerCase()))
            .sort((a, b) => b.count - a.count)
            .slice(0, 25);

        // Update cache
        wordCloudCache.set(cacheKey, { data: cleaned, timestamp: Date.now() });

        return cleaned;
    } catch (err) {
        console.error('[OpenAI] Failed to parse word cloud JSON:', err);
        return [];
    }
}

/**
 * Merge parent "asked about" items from comprehensive JSON. The model may put
 * questions in one_pager.what_they_asked_about, top-level questions_asked, or
 * only topics_of_interest. We must not use `||` between arrays: [] is truthy
 * in JavaScript and would drop the other field.
 */
function normalizeStringList(val) {
    if (val == null) return [];
    if (typeof val === 'string') {
        const t = val.trim();
        return t ? [t] : [];
    }
    if (!Array.isArray(val)) return [];
    return val
        .map((v) => (v == null ? '' : String(v).trim()))
        .filter(Boolean);
}

function dedupeCaseInsensitive(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

/** School/KB topics parents may ask about — not tour scheduling or booking logistics. */
const SCHOOL_KB_PATTERNS = [
    /\b(?:tuition|price|cost|fee|afford\w*|billing|payment)\b|financial aid/i,
    /\b(?:hours|schedule|scheduling|pickup|drop[\s-]?off|holiday|closure)\b|\bopen\b(?!\s*house)|\bclos\w*/i,
    /\b(?:meal|food|lunch|snack|allerg\w*|nutrition|diet)\b/i,
    /\b(?:ratio|teacher|staff|classroom|credential)\b|certif/i,
    /\b(?:curriculum|program|montessori|reggio|learning|development)\b|play[\s-]?based/i,
    /\b(?:camera|security|safety|lock|visitor)\b/i,
    /\b(?:nap|sleep|rest time)\b/i,
    /\bbus(?:es)?\b|\btransport\w*/i,
    /after[\s-]?school|summer camp|extended care/i,
    /\b(?:waitlist|availability|spots?|opening|capacity)\b/i,
    /\b(?:infant|toddler|preschool|kindergarten)\b|pre[\s-]?k|age group/i,
    /\b(?:potty|toilet|diaper)\b/i,
    /\bvaccin\w*|\bimmuniz\w*|\bhealth\b|\bsick\b|\billness\b/i,
    /\b(?:discipline|behavior)\b/i,
    /\b(?:outdoor|playground|gym)\b/i,
];

const BOOKING_ONLY_PATTERNS = [
    /book(?:ed|ing)?\s+(?:a\s+)?tour/i,
    /wanted\s+to\s+book/i,
    /express(?:ed)?\s+interest/i,
    /tour\s+was\s+(?:successfully\s+)?schedul/i,
    /successfully\s+scheduled\s+for/i,
    /scheduled\s+(?:the\s+)?tour/i,
    /all\s+required\s+information\s+was\s+collected/i,
    /enroll(?:ment)?\s+as\s+soon\s+as/i,
    /immediate\s+need\s+for\s+enroll/i,
    /tour\s+for\s+their\s+child/i,
    /tour\s+schedul/i,
    /schedul.*\btour\b/i,
    /enrollment\s+timing/i,
    /enrollment\s+urgency/i,
    /enrollment\s+target/i,
    /when\s+(?:are\s+you\s+)?hoping\s+to\s+enroll/i,
    /caller.{0,60}(?:book|schedul|enroll)/i,
];

function matchesSchoolKbPattern(text) {
    return SCHOOL_KB_PATTERNS.some((pattern) => pattern.test(String(text || '')));
}

function isTourBookingOrEnrollmentLogistics(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    if (BOOKING_ONLY_PATTERNS.some((pattern) => pattern.test(t))) return true;
    if (/\btour\b/i.test(t)) return true;
    if (/\bschedul(?:ed|ing)\b/i.test(t) && !/\b(?:hours|pickup|drop[\s-]?off)\b/i.test(t)) return true;
    return false;
}

function isSchoolKbTopic(text) {
    if (isTourBookingOrEnrollmentLogistics(text)) return false;
    return matchesSchoolKbPattern(text);
}

function isPureBookingBoilerplate(text) {
    return isTourBookingOrEnrollmentLogistics(text);
}

/** Keep only real school/KB questions — exclude tour booking recap sentences. */
function filterSchoolQuestions(items) {
    return dedupeCaseInsensitive(
        normalizeStringList(items).filter((item) => isSchoolKbTopic(item) && !isPureBookingBoilerplate(item))
    );
}

function filterSchoolTalkingPoints(items) {
    return dedupeCaseInsensitive(
        normalizeStringList(items).filter(
            (item) => !isPureBookingBoilerplate(item) && isSchoolKbTopic(item)
        )
    );
}

function buildStaffTalkingPointsFromQuestions(questions) {
    const points = [];
    for (const q of questions.slice(0, 4)) {
        const lower = q.toLowerCase();
        if (/tuition|price|cost|fee|afford|financial/i.test(lower)) {
            points.push('Be prepared to walk through tuition, payment schedules, and any available discounts or assistance.');
        } else if (/hours|schedule|pickup|drop[\s-]?off|open|close/i.test(lower)) {
            points.push('Review daily hours, drop-off and pickup procedures, and holiday closures.');
        } else if (/meal|food|lunch|snack|allerg/i.test(lower)) {
            points.push('Show the meal program, snack policy, and how allergies are handled.');
        } else if (/ratio|teacher|staff|classroom/i.test(lower)) {
            points.push('Highlight teacher credentials, class sizes, and classroom structure.');
        } else if (/curriculum|program|montessori|reggio|learning/i.test(lower)) {
            points.push('Walk through the curriculum, daily activities, and developmental approach.');
        } else if (/camera|security|safety/i.test(lower)) {
            points.push('Cover building security, cameras, and safety protocols.');
        } else if (/nap|sleep/i.test(lower)) {
            points.push('Explain nap routines and how rest time is managed by age group.');
        } else if (/bus|transport/i.test(lower)) {
            points.push('Clarify transportation options if applicable.');
        } else if (/after[\s-]?school|summer camp/i.test(lower)) {
            points.push('Discuss extended care or summer program availability.');
        } else if (/waitlist|availability|spots|opening/i.test(lower)) {
            points.push('Confirm current classroom availability and waitlist timelines.');
        } else {
            points.push(`Address their question about: ${q.replace(/\?+$/, '').trim()}.`);
        }
    }
    return dedupeCaseInsensitive(points).slice(0, 4);
}

/**
 * @param {object} extracted - Parsed JSON from getComprehensivePrompt
 * @returns {string[]}
 */
function extractTourTalkingPoints(extracted) {
    const schoolQuestions = mergeParentQuestionsFromExtraction(extracted);
    if (schoolQuestions.length === 0) return [];
    const root = extracted && typeof extracted === 'object' ? extracted : {};
    const fromOnePager = filterSchoolTalkingPoints(root.one_pager?.tour_talking_points);
    if (fromOnePager.length > 0) return fromOnePager.slice(0, 4);
    return buildStaffTalkingPointsFromQuestions(schoolQuestions);
}

/**
 * @param {object} extracted - Parsed JSON from getComprehensivePrompt
 * @param {{ summaryText?: string }} [extra] - unused; kept for callers
 * @returns {string[]}
 */
function mergeParentQuestionsFromExtraction(extracted, extra = {}) {
    const root = extracted && typeof extracted === 'object' ? extracted : {};
    const fromOnePager = normalizeStringList(root.one_pager?.what_they_asked_about);
    const fromTop = normalizeStringList(root.questions_asked);
    const primary = filterSchoolQuestions([...fromOnePager, ...fromTop]);
    if (primary.length > 0) return primary;
    const topics = filterSchoolQuestions(normalizeStringList(root.topics_of_interest));
    if (topics.length > 0) return topics;
    return [];
}

/** Merge multiple question/topic lists (booking cache + webhook extraction). */
function mergeQuestionLists(...lists) {
    const flat = [];
    for (const list of lists) {
        flat.push(...normalizeStringList(list));
    }
    return dedupeCaseInsensitive(flat);
}

/**
 * Extract structured details from a call transcript using comprehensive prompt
 */
async function extractTourDetails(transcriptText, existingDetails = {}) {
    // Check if transcript is too short to extract meaningful insights
    const wordCount = (transcriptText || '').split(/\s+/).filter(word => word.length > 0).length;
    const transcriptLength = (transcriptText || '').length;
    
    // If transcript is very short, return minimal information
    if (transcriptLength < 50 || wordCount < 10) {
        return {
            childName: existingDetails.childName || '',
            childAge: existingDetails.childAge || '',
            purpose: existingDetails.purpose || 'Brief inquiry - insufficient details captured',
            questionsAsked: [],
            notes: 'Call was too short to extract meaningful insights. Primarily consisted of greetings and basic inquiries.',
            tourTalkingPoints: [],
            tags: ['Partial call'],
            language: '',
            missingDetails: ['Insufficient call duration']
        };
    }

    const result = await getChatCompletion([
        { role: 'system', content: 'You extract comprehensive information from childcare inquiry call transcripts. Return only valid JSON.' },
        { role: 'user', content: getComprehensivePrompt(transcriptText) }
    ], { response_format: { type: 'json_object' }, temperature: 0.1 });

    if (!result) return existingDetails;

    try {
        const extracted = JSON.parse(result);
        
        // Map comprehensive result to legacy format for backward compatibility
        return {
            childName: extracted.child_name ? (Array.isArray(extracted.child_name) ? extracted.child_name[0] : extracted.child_name) : existingDetails.childName || '',
            childAge: extracted.child_age ? (Array.isArray(extracted.child_age) ? extracted.child_age[0] : extracted.child_age) : existingDetails.childAge || '',
            purpose: extracted.summary || existingDetails.purpose || 'Brief inquiry',
            questionsAsked: mergeParentQuestionsFromExtraction(extracted),
            notes: (() => {
                const talking = extractTourTalkingPoints(extracted);
                if (talking.length) return talking.join('\n');
                const topics = filterSchoolQuestions(extracted.topics_of_interest);
                return topics.length ? topics.join(', ') : '';
            })(),
            tourTalkingPoints: extractTourTalkingPoints(extracted),
            tags: extracted.tags || [],
            language: extracted.language_spoken || '',
            missingDetails: extracted.missing_details || []
        };
    } catch (err) {
        console.error('[OpenAI] Failed to parse comprehensive tour details JSON:', err);
        return existingDetails;
    }
}

/**
 * Batch extract structured details for multiple tour bookings using comprehensive prompt
 */
async function batchExtractTourDetails(tourBatch) {
    if (!tourBatch || tourBatch.length === 0) return []

    // Filter out very short transcripts and handle them separately
    const validTours = [];
    const shortTourResults = {};
    
    tourBatch.forEach(tour => {
        const wordCount = (tour.transcript || '').split(/\s+/).filter(word => word.length > 0).length;
        const transcriptLength = (tour.transcript || '').length;
        
        if (transcriptLength < 50 || wordCount < 10) {
            // Handle very short transcripts
            shortTourResults[tour.id] = {
                childName: tour.existingDetails?.childName || '',
                childAge: tour.existingDetails?.childAge || '',
                purpose: tour.existingDetails?.purpose || 'Brief inquiry - insufficient details captured',
                questionsAsked: [],
                notes: 'Call was too short to extract meaningful insights. Primarily consisted of greetings and basic inquiries.',
                tourTalkingPoints: [],
                tags: ['Partial call'],
                language: '',
                missingDetails: ['Insufficient call duration']
            };
        } else {
            validTours.push(tour);
        }
    });

    // Process each valid tour individually with comprehensive prompt
    const batchPromises = validTours.map(async (tour) => {
        try {
            const result = await getChatCompletion([
                { role: 'system', content: 'You extract comprehensive information from childcare inquiry call transcripts. Return only valid JSON.' },
                { role: 'user', content: getComprehensivePrompt(tour.transcript) }
            ], { response_format: { type: 'json_object' }, temperature: 0.1 });

            if (!result) {
                return {
                    tourId: tour.id,
                    result: {
                        childName: tour.existingDetails?.childName || '',
                        childAge: tour.existingDetails?.childAge || '',
                        purpose: tour.existingDetails?.purpose || 'Brief inquiry - processing failed',
                        questionsAsked: [],
                        notes: 'Failed to process transcript with AI',
                        tourTalkingPoints: [],
                        tags: [],
                        language: '',
                        missingDetails: []
                    }
                };
            }

            const extracted = JSON.parse(result);
            
            // Map comprehensive result to legacy format
            return {
                tourId: tour.id,
                result: {
                    childName: extracted.child_name ? (Array.isArray(extracted.child_name) ? extracted.child_name[0] : extracted.child_name) : tour.existingDetails?.childName || '',
                    childAge: extracted.child_age ? (Array.isArray(extracted.child_age) ? extracted.child_age[0] : extracted.child_age) : tour.existingDetails?.childAge || '',
                    purpose: extracted.summary || tour.existingDetails?.purpose || 'Brief inquiry',
                    questionsAsked: mergeParentQuestionsFromExtraction(extracted),
                    notes: (() => {
                        const talking = extractTourTalkingPoints(extracted);
                        if (talking.length) return talking.join('\n');
                        const topics = filterSchoolQuestions(extracted.topics_of_interest);
                        return topics.length ? topics.join(', ') : '';
                    })(),
                    tourTalkingPoints: extractTourTalkingPoints(extracted),
                    tags: extracted.tags || [],
                    language: extracted.language_spoken || '',
                    missingDetails: extracted.missing_details || []
                }
            };
        } catch (err) {
            console.error(`[OpenAI] Failed to process tour ${tour.id}:`, err);
            return {
                tourId: tour.id,
                result: {
                    childName: tour.existingDetails?.childName || '',
                    childAge: tour.existingDetails?.childAge || '',
                    purpose: tour.existingDetails?.purpose || 'Brief inquiry - processing error',
                    questionsAsked: [],
                    notes: 'Error occurred during processing',
                    tourTalkingPoints: [],
                    tags: [],
                    language: '',
                    missingDetails: []
                }
            };
        }
    });

    const batchResults = await Promise.all(batchPromises);
    
    // Convert array of results to object format
    const resultsObject = {};
    batchResults.forEach(({ tourId, result }) => {
        resultsObject[tourId] = result;
    });

    // Combine results from short transcripts and valid ones
    return { ...shortTourResults, ...resultsObject };
}

module.exports = {
    getChatCompletion,
    generateWordCloud,
    extractTourDetails,
    batchExtractTourDetails,
    mergeParentQuestionsFromExtraction,
    mergeQuestionLists,
    filterSchoolQuestions,
    extractTourTalkingPoints,
};
