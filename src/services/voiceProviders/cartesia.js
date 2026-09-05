const axios = require('axios');
const FormData = require('form-data');
const AlertService = require('../alertService');
const {
    APPOINTMENT_AGENT_PROMPT,
    buildHumanTransferToolCondition,
    NORA_SYSTEM_PROMPT_TEMPLATE,
    DEFAULT_FIRST_MESSAGE_TEMPLATE,
    formatQAPairsForKB,
} = require('./shared/promptTemplates');

/**
 * Cartesia voice-agent platform, reached through the same kind of Python comm-service
 * wrapper ElevenLabs is (see CandexAI_product_backend's cartesiaApi.util.ts / commApiHealth.ts
 * for the reference implementation this file mirrors). Endpoint shapes below (single-PATCH
 * agent updates, folder-scoped knowledge base, two-step SIP import, call_completed webhooks)
 * come from that reference — Cartesia's actual REST surface differs meaningfully from
 * ElevenLabs', so functions here are not 1:1 translations of elevenlabs.js internals.
 */

function getCartesiaBaseUrl() {
    const url = process.env.CARTESIA_API_URL;
    return url ? url.replace(/\/$/, '') : null;
}

function cartesiaHeaders(extra = {}) {
    return {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(process.env.CARTESIA_API_KEY && { Authorization: `Bearer ${process.env.CARTESIA_API_KEY}` }),
        ...extra,
    };
}

function getCartesiaDefaultModel() {
    return process.env.CARTESIA_DEFAULT_MODEL?.trim() || 'openai/gpt-4.1-mini';
}

function getCartesiaDefaultVoiceId() {
    return process.env.CARTESIA_DEFAULT_VOICE_ID?.trim() || '95d51f79-c397-46f9-b49a-23763d3eaa2d';
}

function getPostCallWebhookUrl() {
    const base = (process.env.BACKEND_URL || 'https://montessori-enrollment-ai-backend-1.onrender.com').replace(/\/$/, '');
    return `${base}/api/v1/webhook/cartesia`;
}

function reportCartesiaAlert(err, context = {}) {
    const status = err?.response?.status;
    const detail = err?.response?.data?.detail || err?.response?.data?.message || err?.message || 'Unknown error';
    let severity = 'WARNING';
    if (status === 401 || status === 403) severity = 'CRITICAL';
    else if (status === 429) severity = 'CRITICAL';
    else if (status >= 500) severity = 'CRITICAL';

    AlertService.create({
        type: 'CARTESIA_ERROR',
        severity,
        schoolId: context.schoolId,
        schoolName: context.schoolName,
        title: context.title || 'Cartesia API failure',
        message: typeof detail === 'object' ? JSON.stringify(detail) : String(detail),
        source: context.source || 'cartesia',
        metadata: { status, stack: err?.stack, ...context.metadata },
    });
}

/** Cartesia agent names: lowercase letters, numbers, hyphens, underscores, periods only, max 64 chars. */
function sanitizeCartesiaAgentName(name) {
    const sanitized = String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-_.]+|[-_.]+$/g, '');
    const base = sanitized || 'agent';
    return base.length <= 64 ? base : base.slice(0, 64).replace(/[-_.]+$/, '') || 'agent';
}

function extractId(data, fallbackKeys = ['id', 'agent_id', 'phone_number_id', 'tool_id', 'folder_id', 'document_id']) {
    if (typeof data === 'string' && data.trim()) return data.trim();
    if (data && typeof data === 'object') {
        for (const key of fallbackKeys) {
            const val = data[key];
            if (typeof val === 'string' && val.trim()) return val.trim();
        }
    }
    return null;
}

function isAlreadyImportedError(err) {
    const status = err?.response?.status;
    if (status === 409) return true;
    const text = JSON.stringify(err?.response?.data || err?.message || '').toLowerCase();
    return text.includes('already_imported') || text.includes('already imported');
}

/** tools_config entries for the agent-level PATCH/POST body. Rebuilt fresh each call — not merged remotely. */
function buildToolsConfig({ enableKnowledgeBase = false, humanTransfer = null } = {}) {
    const config = [];
    if (enableKnowledgeBase) {
        config.push({ type: 'system', name: 'knowledge_base', description: 'Answer questions from the school knowledge base.' });
    }
    if (humanTransfer?.enabled && humanTransfer?.phoneNumber) {
        config.push({
            type: 'system',
            name: 'transfer_call',
            description: `Transfer the caller to the front desk. ${buildHumanTransferToolCondition(humanTransfer.condition)}`,
            phone_number: humanTransfer.phoneNumber,
        });
    }
    return config;
}

function buildAgentRequestBody({ firstMessage, systemPrompt, knowledgeBaseId, toolIds, humanTransfer, name }) {
    const body = {
        first_message: firstMessage,
        system_prompt: systemPrompt,
        language: 'en',
        model: getCartesiaDefaultModel(),
        voice_id: getCartesiaDefaultVoiceId(),
        tools_config: buildToolsConfig({ enableKnowledgeBase: Boolean(knowledgeBaseId), humanTransfer }),
    };
    if (name) body.name = sanitizeCartesiaAgentName(name);
    if (Array.isArray(toolIds) && toolIds.length > 0) body.tool_ids = [...new Set(toolIds)];
    const webhookUrl = getPostCallWebhookUrl();
    if (webhookUrl) body.webhook_url = webhookUrl;
    return body;
}

async function createSchoolAgent(schoolName, knowledgeBaseId = null, toolIds = [], opts = {}) {
    const baseUrl = getCartesiaBaseUrl();
    if (!baseUrl) {
        console.warn('[Cartesia Agent Create] CARTESIA_API_URL not configured, skipping agent creation');
        return null;
    }

    try {
        const personaPrompt = NORA_SYSTEM_PROMPT_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName);
        const fullPrompt = `${personaPrompt}\n\n${APPOINTMENT_AGENT_PROMPT}`;
        const namePrefix = opts.schoolId ? `${schoolName}-${String(opts.schoolId).slice(-6)}` : schoolName;

        const body = buildAgentRequestBody({
            schoolName,
            firstMessage: DEFAULT_FIRST_MESSAGE_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName),
            systemPrompt: fullPrompt,
            knowledgeBaseId: opts.enableKnowledgeBase ? 'pending' : knowledgeBaseId,
            toolIds,
            name: namePrefix,
        });

        console.log('[Cartesia Agent Create] POST /agents', schoolName);
        const response = await axios.post(`${baseUrl}/agents`, body, { headers: cartesiaHeaders(), timeout: 60000 });
        const agentId = extractId(response.data, ['agent_id', 'id']);
        console.log('[Cartesia Agent Create] agent_id:', agentId);
        return agentId;
    } catch (err) {
        console.error('[Cartesia Agent Create] Failed for', schoolName, err.response?.status, JSON.stringify(err.response?.data || {}));
        reportCartesiaAlert(err, {
            schoolName,
            title: `Cartesia agent creation failed: ${schoolName}`,
            source: 'cartesia.createSchoolAgent',
        });
        return null;
    }
}

/** Single PATCH /agents/{id} carries prompt, greeting, voice, tools — no sub-resources like ElevenLabs. */
async function patchAgent(agentId, body) {
    const baseUrl = getCartesiaBaseUrl();
    if (!baseUrl || !agentId) return null;
    const url = `${baseUrl}/agents/${encodeURIComponent(agentId)}`;
    const response = await axios.patch(url, body, { headers: cartesiaHeaders(), timeout: 30000 });
    return response.data;
}

/**
 * Every PATCH /agents/{id} body is authoritative for the fields it includes — Cartesia does
 * not sparse-merge missing fields against the prior state (mirrors the reference implementation,
 * which always resends tool_ids alongside every other field rather than omitting it). Callers
 * here don't track tool_ids locally, so read them back from Cartesia first and resend unchanged,
 * otherwise a settings save could silently drop the booked-slots/datetime tools from the agent.
 */
async function fetchAgentToolIds(agentId) {
    const baseUrl = getCartesiaBaseUrl();
    if (!baseUrl || !agentId) return [];
    try {
        const response = await axios.get(`${baseUrl}/agents/${encodeURIComponent(agentId)}`, { headers: cartesiaHeaders(), timeout: 15000 });
        const ids = response.data?.tool_ids;
        return Array.isArray(ids) ? ids.filter(Boolean) : [];
    } catch (err) {
        console.warn('[Cartesia Agent] failed to fetch existing tool_ids, PATCH may drop them:', err.response?.status, err.message);
        return [];
    }
}

async function patchAgentPromptContent(agentId, { firstMessage = '', systemPrompt = '', knowledgeBaseId = '' } = {}) {
    if (!agentId) {
        console.warn('[Cartesia Agent Patch] missing agentId');
        return null;
    }
    const baseSystem = String(systemPrompt || '').trim();
    const fullPrompt = `${baseSystem}\n\n${APPOINTMENT_AGENT_PROMPT}`;
    try {
        const toolIds = await fetchAgentToolIds(agentId);
        const body = buildAgentRequestBody({ firstMessage, systemPrompt: fullPrompt, knowledgeBaseId, toolIds });
        const data = await patchAgent(agentId, body);
        return { patchResponse: data, agentId };
    } catch (err) {
        console.error('[Cartesia Agent Patch] failed:', err.response?.status, JSON.stringify(err.response?.data || {}));
        reportCartesiaAlert(err, { title: 'Cartesia agent patch failed', source: 'cartesia.patchAgentPromptContent', metadata: { agentId } });
        return null;
    }
}

/** School settings sync: same single-PATCH body; tool_ids read back first so this never drops them (see fetchAgentToolIds). */
async function syncSchoolAgent(agentId, {
    firstMessage = '',
    systemPrompt = '',
    knowledgeBaseId = '',
    humanTransfer = { enabled: false, condition: '', phoneNumber: '' },
} = {}) {
    if (!agentId) return null;
    const fullPrompt = `${systemPrompt || ''}\n\n${APPOINTMENT_AGENT_PROMPT}`;
    try {
        const toolIds = await fetchAgentToolIds(agentId);
        const body = buildAgentRequestBody({ firstMessage, systemPrompt: fullPrompt, knowledgeBaseId, humanTransfer, toolIds });
        return await patchAgent(agentId, body);
    } catch (err) {
        console.error('[Cartesia Agent Sync] failed:', err.response?.status, JSON.stringify(err.response?.data || {}));
        reportCartesiaAlert(err, { title: 'Cartesia agent sync failed', source: 'cartesia.syncSchoolAgent', metadata: { agentId } });
        const wrapped = new Error(`Cartesia agent sync failed: ${err.message}`);
        wrapped.statusCode = 502;
        throw wrapped;
    }
}

/** No dedicated built_in_tools sub-resource — human transfer rides the same agent PATCH as syncSchoolAgent. */
async function patchAgentHumanTransfer(agentId, humanTransfer) {
    return syncSchoolAgent(agentId, {
        firstMessage: undefined,
        systemPrompt: undefined,
        knowledgeBaseId: undefined,
        humanTransfer,
    }).catch(() => null);
}

/** No Cartesia equivalent found for ElevenLabs' turn-timeout/eagerness config. No-op. */
async function patchAgentTurnConfig() {
    return null;
}

function toolsUrl(baseUrl, toolId = '') {
    return toolId ? `${baseUrl}/tools/${encodeURIComponent(toolId)}` : `${baseUrl}/tools`;
}

async function registerHttpTool(spec) {
    const baseUrl = getCartesiaBaseUrl();
    if (!baseUrl) return null;
    try {
        const response = await axios.post(toolsUrl(baseUrl), { spec }, { headers: cartesiaHeaders(), timeout: 30000 });
        return extractId(response.data, ['tool_id', 'id']);
    } catch (err) {
        console.error('[Cartesia Tool Register] failed:', spec.name, err.response?.status, JSON.stringify(err.response?.data || {}));
        return null;
    }
}

/** Registers the booked-slots lookup tool against this backend's existing public endpoint. */
async function registerTool(schoolId, _agentId) {
    const backendUrl = (process.env.BACKEND_URL || '').replace(/\/$/, '');
    if (!backendUrl) {
        console.warn('[Cartesia Tool Register] BACKEND_URL not configured, skipping get_booked_slots tool');
        return null;
    }
    return registerHttpTool({
        name: 'get_booked_slots',
        description: "Get a school's available and booked tour slots for a specific date.",
        method: 'GET',
        url: `${backendUrl}/api/voice/booked-slots?schoolId=${encodeURIComponent(schoolId)}`,
        query_params_schema: {
            type: 'object',
            properties: { date: { type: 'string', description: 'Date in YYYY-MM-DD format' } },
            required: ['date'],
        },
    });
}

/** Registers the current-datetime anchor tool the Nora prompt calls on the first turn. */
async function registerDatetimeTool() {
    const backendUrl = (process.env.BACKEND_URL || '').replace(/\/$/, '');
    if (!backendUrl) return null;
    return registerHttpTool({
        name: 'get_current_datetime_cst',
        description: "Get the current date, time, and day of week in the school's timezone.",
        method: 'GET',
        url: `${backendUrl}/api/voice/current-datetime`,
    });
}

async function deleteTool(toolId) {
    const baseUrl = getCartesiaBaseUrl();
    if (!baseUrl || !toolId) return false;
    try {
        await axios.delete(toolsUrl(baseUrl, toolId), { headers: cartesiaHeaders(), timeout: 30000, validateStatus: (s) => s < 500 || s === 404 });
        return true;
    } catch (err) {
        console.error('[Cartesia Tool Delete] failed:', toolId, err.response?.status);
        return false;
    }
}

function getBookedSlotsToolIds(toolIds = []) {
    return (Array.isArray(toolIds) ? toolIds : []).map((id) => String(id).trim()).filter(Boolean);
}

/** tool_ids live directly on the agent PATCH body — no separate /prompt sub-resource. */
async function linkAgentToolIds(agentId, toolIds) {
    if (!agentId) return null;
    try {
        return await patchAgent(agentId, { tool_ids: [...new Set((toolIds || []).filter(Boolean))] });
    } catch (err) {
        console.error('[Cartesia Link Tools] failed:', agentId, err.response?.status, JSON.stringify(err.response?.data || {}));
        return null;
    }
}

// ── Knowledge base (folder-scoped: one folder per agent, docs copied in) ──────────

async function getOrCreateAgentKbFolder(agentId) {
    const baseUrl = getCartesiaBaseUrl();
    const folderName = `agent-kb-${String(agentId).slice(0, 48)}`;
    try {
        const response = await axios.post(`${baseUrl}/knowledge-base/folders`, { name: folderName }, { headers: cartesiaHeaders(), timeout: 30000 });
        return extractId(response.data, ['id', 'folder_id']);
    } catch (err) {
        // Duplicate-name: look the folder up instead of failing.
        const text = JSON.stringify(err?.response?.data || '').toLowerCase();
        if (err?.response?.status !== 409 && !text.includes('already exists')) {
            console.error('[Cartesia KB Folder] create failed:', err.response?.status, JSON.stringify(err.response?.data || {}));
            return null;
        }
        try {
            const listRes = await axios.get(`${baseUrl}/knowledge-base/folders`, { headers: cartesiaHeaders(), timeout: 30000 });
            const rows = Array.isArray(listRes.data?.folders) ? listRes.data.folders
                : Array.isArray(listRes.data?.data) ? listRes.data.data
                    : Array.isArray(listRes.data) ? listRes.data : [];
            const match = rows.find((f) => f.name === folderName);
            return match ? extractId(match, ['id', 'folder_id']) : null;
        } catch (listErr) {
            console.error('[Cartesia KB Folder] lookup failed:', listErr.message);
            return null;
        }
    }
}

async function attachAgentToKbFolder(folderId, agentId) {
    const baseUrl = getCartesiaBaseUrl();
    if (!baseUrl || !folderId || !agentId) return false;
    try {
        await axios.patch(`${baseUrl}/knowledge-base/folders/${encodeURIComponent(folderId)}/agents`, { agent_ids: [agentId] }, {
            headers: cartesiaHeaders(),
            timeout: 30000,
        });
        return true;
    } catch (err) {
        console.error('[Cartesia KB Folder] attach agent failed:', err.response?.status, JSON.stringify(err.response?.data || {}));
        return false;
    }
}

/**
 * Ensures this agent's KB folder exists AND is attached, even with zero documents yet.
 * Cartesia's knowledge_base agent tool needs the folder to exist before it's usable, and
 * the folder only shows up in the Cartesia dashboard once created — so this runs right
 * after agent creation, not lazily deferred until the school first has Q&A text to ingest.
 */
async function ensureAgentKbFolder(agentId) {
    const folderId = await getOrCreateAgentKbFolder(agentId);
    if (!folderId) return null;
    await attachAgentToKbFolder(folderId, agentId);
    return folderId;
}

async function ingestKnowledgeBaseDocument(text, schoolName, { agentId, folderId: knownFolderId } = {}) {
    const baseUrl = getCartesiaBaseUrl();
    if (!baseUrl) {
        console.warn('[Cartesia KB] CARTESIA_API_URL not configured, skipping KB ingestion');
        return null;
    }
    if (!agentId) {
        console.warn('[Cartesia KB] ingestKnowledgeBaseDocument requires an agentId (Cartesia KB is folder/agent scoped)');
        return null;
    }

    // Callers that already resolved the folder (e.g. provisionAgent, which ensures it up
    // front so it's visible even before any KB text exists) can pass it in to skip a
    // redundant create-or-lookup round trip.
    const folderId = knownFolderId || await ensureAgentKbFolder(agentId);
    if (!folderId) return null;

    try {
        const formData = new FormData();
        formData.append('source_type', 'text');
        formData.append('text', text);
        formData.append('name', `${schoolName} - Knowledge Base`);
        formData.append('folder_id', folderId);

        const response = await axios.post(`${baseUrl}/knowledge-base/ingest`, formData, {
            headers: cartesiaHeaders(formData.getHeaders()),
            timeout: 60000,
        });
        const documentId = response.data?.document_id || response.data?.id;
        if (!documentId) return null;

        return documentId;
    } catch (err) {
        console.error('[Cartesia KB] ingest failed:', err.response?.status, JSON.stringify(err.response?.data || {}));
        throw err;
    }
}

async function deleteKnowledgeBaseDocument(documentId) {
    if (!documentId) return;
    const baseUrl = getCartesiaBaseUrl();
    if (!baseUrl) return;
    try {
        await axios.delete(`${baseUrl}/knowledge-base/${encodeURIComponent(documentId)}`, {
            headers: cartesiaHeaders(),
            timeout: 30000,
            validateStatus: (s) => s < 500 || s === 404,
        });
    } catch (err) {
        console.error('[Cartesia KB] delete failed:', documentId, err.response?.status);
    }
}

// ── Phone numbers / SIP ───────────────────────────────────────────────────────────

async function importSipTrunk(payload) {
    const baseUrl = getCartesiaBaseUrl();
    if (!baseUrl) {
        console.warn('[Cartesia SIP] CARTESIA_API_URL not configured');
        return null;
    }

    try {
        const providerBody = {
            type: 'sip_trunk',
            label: payload.label || 'Imported SIP Number',
            inbound: { media_encryption: 'allowed' },
        };
        const providerRes = await axios.post(`${baseUrl}/phone-numbers/providers`, providerBody, { headers: cartesiaHeaders(), timeout: 30000 });
        const providerId = extractId(providerRes.data, ['id']);
        if (!providerId) {
            throw new Error('Cartesia did not return a provider id for the SIP trunk');
        }

        const numberBody = { label: payload.label || 'Imported Number', number: payload.phone_number, provider: { id: providerId } };
        const numberRes = await axios.post(`${baseUrl}/phone-numbers`, numberBody, { headers: cartesiaHeaders(), timeout: 30000 });
        return { phone_number_id: extractId(numberRes.data, ['id', 'phone_number_id']) };
    } catch (err) {
        if (isAlreadyImportedError(err)) {
            console.warn('[Cartesia SIP] Phone number already imported');
            return { alreadyExists: true };
        }
        console.error('[Cartesia SIP] import failed:', err.response?.status, JSON.stringify(err.response?.data || {}));
        throw new Error(err.response?.data?.detail || err.message);
    }
}

async function updatePhoneNumber(phoneNumberId, payload) {
    const baseUrl = getCartesiaBaseUrl();
    if (!baseUrl) return null;
    try {
        const response = await axios.patch(`${baseUrl}/phone-numbers/${encodeURIComponent(phoneNumberId)}`, payload, {
            headers: cartesiaHeaders(),
            timeout: 30000,
        });
        return response.data;
    } catch (err) {
        console.error('[Cartesia Phone Update] failed:', err.response?.status, JSON.stringify(err.response?.data || {}));
        throw new Error(err.response?.data?.detail || err.message);
    }
}

async function deletePhoneNumber(phoneNumberId) {
    const baseUrl = getCartesiaBaseUrl();
    if (!baseUrl) return null;
    try {
        await updatePhoneNumber(phoneNumberId, { agent_id: null }).catch(() => null);
        const response = await axios.delete(`${baseUrl}/phone-numbers/${encodeURIComponent(phoneNumberId)}`, {
            headers: cartesiaHeaders(),
            timeout: 30000,
            validateStatus: (s) => s < 500 || s === 404,
        });
        return response.data;
    } catch (err) {
        console.error('[Cartesia Phone Delete] failed:', err.response?.status, JSON.stringify(err.response?.data || {}));
        throw new Error(err.response?.data?.detail || err.message);
    }
}

// ── Conversation audio / health ────────────────────────────────────────────────────

async function getConversationAudio(conversationId) {
    const baseUrl = getCartesiaBaseUrl();
    if (!baseUrl) return null;
    const response = await axios.get(`${baseUrl}/conversations/${encodeURIComponent(conversationId)}/audio`, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: cartesiaHeaders({ Accept: 'audio/*' }),
    });
    return { buffer: Buffer.from(response.data), contentType: response.headers?.['content-type'] || 'audio/wav' };
}

async function checkHealth() {
    const baseUrl = getCartesiaBaseUrl();
    if (!baseUrl || !process.env.CARTESIA_API_KEY) {
        return { ok: false, detail: 'CARTESIA_API_URL or CARTESIA_API_KEY missing' };
    }
    try {
        const start = Date.now();
        // No dedicated health endpoint exists upstream — GET /agents is the lightest reachable probe.
        await axios.get(`${baseUrl}/agents`, { headers: cartesiaHeaders(), timeout: 8000 });
        return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
        return { ok: false, detail: err.response?.status ? `HTTP ${err.response.status}` : err.message };
    }
}

// ── Inbound webhook normalization ──────────────────────────────────────────────────

/**
 * Cartesia posts { type: 'call_started'|'call_turn'|'call_completed'|'post_call_analysis'|'call_failed',
 * call_id (ac_*), agent_id, call: { transcript, telephony_params: {direction, from, to}, metadata,
 * end_reason, start_time, end_time, status } }. Normalize into the same { type, data } envelope
 * webhook.js already knows how to process for ElevenLabs (type 'post_call_transcription' / data.*),
 * so downstream school-matching, billing, and alerting code needs no provider-specific branches.
 */
function normalizeCartesiaWebhookPayload(body = {}) {
    const call = body.call || {};
    const callId = body.call_id || body.data?.call_id || body.data?.conversation_id || call.id || '';
    const agentId = body.agent_id || body.data?.agent_id || call.agent_id || '';

    if (body.type === 'call_failed') {
        const reason = call.end_reason || body.end_reason || body.reason || body.failure_reason || 'call_failed';
        return {
            type: 'post_call_transcription',
            data: {
                conversation_id: callId,
                agent_id: agentId,
                agent_name: call.agent_name || '',
                status: 'failed',
                metadata: { provider: 'cartesia', termination_reason: reason, error: reason, raw_cartesia_event: body },
                transcript: [],
            },
        };
    }

    if (body.type !== 'call_completed') {
        // call_started / call_turn / post_call_analysis — no direct ElevenLabs analog; ack and skip.
        return { type: body.type || 'unknown', data: { conversation_id: callId, agent_id: agentId, metadata: { provider: 'cartesia' } } };
    }

    const telephony = call.telephony_params || {};
    const direction = telephony.direction || 'inbound';
    const agentNumber = direction === 'outbound' ? telephony.from : telephony.to;
    const externalNumber = direction === 'outbound' ? telephony.to : telephony.from;

    const startMs = call.start_time ? Date.parse(call.start_time) : NaN;
    const endMs = call.end_time ? Date.parse(call.end_time) : NaN;
    const durationSecs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
        ? Math.round((endMs - startMs) / 1000)
        : undefined;

    const transcript = Array.isArray(call.transcript)
        ? call.transcript.map((entry, index) => ({
            role: entry.role || entry.speaker || 'unknown',
            message: entry.text || entry.message || entry.content || '',
            time_in_call_secs: entry.start_timestamp,
            index,
        }))
        : [];

    return {
        type: 'post_call_transcription',
        data: {
            conversation_id: callId,
            agent_id: agentId,
            agent_name: call.agent_name || '',
            user_id: '',
            status: call.status || body.status || 'done',
            metadata: {
                provider: 'cartesia',
                call_duration_secs: durationSecs,
                termination_reason: call.end_reason || body.end_reason || null,
                phone_call: {
                    direction,
                    agent_number: agentNumber || '',
                    to_number: agentNumber || '',
                    external_number: externalNumber || '',
                    from_number: externalNumber || '',
                },
                raw_cartesia_event: body,
            },
            transcript,
        },
    };
}

module.exports = {
    createSchoolAgent,
    patchAgentPromptContent,
    syncSchoolAgent,
    patchAgentHumanTransfer,
    patchAgentTurnConfig,
    registerTool,
    registerDatetimeTool,
    deleteTool,
    getBookedSlotsToolIds,
    linkAgentToolIds,
    ingestKnowledgeBaseDocument,
    deleteKnowledgeBaseDocument,
    importSipTrunk,
    updatePhoneNumber,
    deletePhoneNumber,
    getConversationAudio,
    checkHealth,
    normalizeCartesiaWebhookPayload,
    provisionAgent,
};

async function provisionAgent(school) {
    const schoolName = school.name;
    const hasKb = Array.isArray(school.qaPairs) && school.qaPairs.length > 0;

    // Never enable the knowledge_base tool in the same POST /agents call that creates the
    // agent — Cartesia requires the per-agent KB folder to exist first. Enabled below, in the
    // combined PATCH, once the folder (and any KB text) are in place.
    const agentId = await createSchoolAgent(schoolName, null, [], {
        schoolId: school._id?.toString(),
        enableKnowledgeBase: false,
    });
    if (!agentId) {
        return { agentId: null };
    }

    // Always ensure + attach the per-agent KB folder right away, even with zero documents,
    // so it's visible in Cartesia immediately and ready for KB text added later via Settings.
    const kbFolderId = await ensureAgentKbFolder(agentId).catch((err) => {
        console.error('[Cartesia Provision] KB folder setup failed:', err.message);
        return null;
    });

    let knowledgeBaseDocumentId = school.knowledgeBaseDocumentId || null;
    if (hasKb) {
        const kbText = formatQAPairsForKB(school.qaPairs);
        if (kbText) {
            try {
                knowledgeBaseDocumentId = await ingestKnowledgeBaseDocument(kbText, schoolName, { agentId, folderId: kbFolderId });
            } catch (err) {
                console.error('[Cartesia Provision] KB ingest failed, continuing without KB:', err.message);
            }
        }
    }

    const toolIds = [];
    const bookedSlotsToolId = await registerTool(school._id.toString(), agentId);
    if (bookedSlotsToolId) toolIds.push(bookedSlotsToolId);
    const datetimeToolId = await registerDatetimeTool();
    if (datetimeToolId) toolIds.push(datetimeToolId);

    // One combined PATCH for tool_ids + tools_config, so neither field's partial update
    // risks clobbering the other (Cartesia PATCH bodies are treated as authoritative per
    // field sent, so unrelated fields are sent together rather than in separate calls).
    let toolsLinked = true;
    try {
        await patchAgent(agentId, {
            tool_ids: [...new Set(toolIds.filter(Boolean))],
            tools_config: buildToolsConfig({ enableKnowledgeBase: Boolean(knowledgeBaseDocumentId) }),
        });
    } catch (err) {
        console.error('[Cartesia Provision] Failed to link tools:', err.response?.status, JSON.stringify(err.response?.data || {}));
        toolsLinked = false;
    }

    return { agentId, knowledgeBaseDocumentId, toolIds, toolsLinked };
}
