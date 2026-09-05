const axios = require('axios');
const FormData = require('form-data');
const AlertService = require('../alertService');
const {
    APPOINTMENT_AGENT_PROMPT,
    HUMAN_TRANSFER_TOOL_CONDITION,
    buildHumanTransferToolCondition,
    NORA_SYSTEM_PROMPT_TEMPLATE,
    DEFAULT_FIRST_MESSAGE_TEMPLATE,
    buildDefaultSchoolAgentPrompts,
    formatQAPairsForKB,
} = require('./shared/promptTemplates');

function reportElevenLabsAlert(err, context = {}) {
    const status = err?.response?.status;
    const detail = err?.response?.data?.detail || err?.response?.data?.message || err?.message || 'Unknown error';
    let severity = 'WARNING';
    let type = 'ELEVENLABS_ERROR';

    if (status === 401 || status === 403) {
        severity = 'CRITICAL';
    } else if (status === 429) {
        severity = 'CRITICAL';
        type = 'RATE_LIMIT_ERROR';
    } else if (err?.code === 'ECONNABORTED' || /timeout/i.test(String(detail))) {
        severity = 'WARNING';
    } else if (status >= 500) {
        severity = 'CRITICAL';
    }

    AlertService.create({
        type,
        severity,
        schoolId: context.schoolId,
        schoolName: context.schoolName,
        title: context.title || 'ElevenLabs API failure',
        message: typeof detail === 'object' ? JSON.stringify(detail) : String(detail),
        source: context.source || 'elevenlabs',
        metadata: {
            status,
            stack: err?.stack,
            ...context.metadata,
        },
    });
}

const GLOBAL_TIME_TOOL_ID = "tool_1801kmyr9pdpemts5qr0f1xys3yy";

function getPostCallWebhookUrl() {
    const base = (process.env.BACKEND_URL || 'https://montessori-enrollment-ai-backend-1.onrender.com').replace(/\/$/, '');
    return `${base}/api/v1/webhook/elevenlabs`;
}

async function createSchoolAgent(schoolName, knowledgeBaseId = null, toolIds = []) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent Create] ELEVENLABS_API_URL not configured, skipping agent creation');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/agents`;
        const personaPrompt = NORA_SYSTEM_PROMPT_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName);
        const fullPrompt = `${personaPrompt}\n\n${APPOINTMENT_AGENT_PROMPT}`;

        const payload = {
            name: schoolName,
            first_message: DEFAULT_FIRST_MESSAGE_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName),
            language: "en",
            model: "gpt-5.1",
            speed: 0.95,
            system_prompt: fullPrompt,
            knowledge_base_ids: knowledgeBaseId ? [knowledgeBaseId] : [],
            voice_id: "jqcCZkN6Knx8BJ5TBdYR",// Default voice
            post_call_webhook_url: getPostCallWebhookUrl(),
        };

        // Only set tool_ids at create when explicitly provided. Registration uses
        // register-tool (attaches tools) then linkAgentToolIds to avoid tools + tool_ids conflict.
        if (Array.isArray(toolIds) && toolIds.length > 0) {
            payload.tool_ids = [...new Set([...toolIds, GLOBAL_TIME_TOOL_ID])];
        }

        console.log(`[Agent Create] POST ${url}`);
        console.log(`[Agent Create] Payload:`, JSON.stringify(payload, null, 2));

        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                // Assuming we might need an API key for the wrapper in the future if set
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent Create] Status: ${response.status}`);
        console.log(`[Agent Create] Data:`, JSON.stringify(response.data, null, 2));

        const newAgentId = response.data?.agent_id || null;
        if (newAgentId) {
            // Best-effort: apply patient turn-taking so Nora waits during email/number spelling.
            await patchAgentTurnConfig(newAgentId).catch((err) => {
                console.warn('[Agent Create] turn config apply warning:', err.message);
            });
        }
        return newAgentId;
    } catch (err) {
        console.error(`[Agent Create] Failed to create agent for ${schoolName}`);
        console.error(`[Agent Create] Error Status:`, err.response?.status);
        console.error(`[Agent Create] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        console.error(`[Agent Create] Error Message:`, err.message);
        AlertService.create({
            type: 'AGENT_ERROR',
            severity: 'CRITICAL',
            schoolName,
            title: `Agent creation failed: ${schoolName}`,
            message: err.message || 'createSchoolAgent failed',
            source: 'elevenlabs.createSchoolAgent',
            metadata: { stack: err.stack, status: err.response?.status },
        });
        return null;
    }
}

async function importSipTrunk(payload) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent SIP] ELEVENLABS_API_URL not configured');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/phone-numbers/sip-trunk`;
        console.log(`[Agent SIP] POST ${url}`);

        // Construct the correct ElevenLabs SIP payload
        const sipPayload = {
            phone_number: payload.phone_number,
            label: payload.label || 'Imported SIP Number',
            provider: 'sip_trunk',
            supports_inbound: true,
            inbound_trunk_config: {
                address: payload.sip_address || 'sip.rtc.elevenlabs.io:5060'
            }
        };

        console.log(`[Agent SIP] Payload:`, JSON.stringify(sipPayload, null, 2));

        const response = await axios.post(url, sipPayload, {
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent SIP] Status: ${response.status}`);
        return { phone_number_id: response.data?.phone_number_id || null };
    } catch (err) {
        if (err.response?.status === 409) {
            console.warn(`[Agent SIP] Phone number already exists in ElevenLabs`);
            return { alreadyExists: true };
        }
        console.error(`[Agent SIP] Failed to import SIP trunk`);
        console.error(`[Agent SIP] Error Status:`, err.response?.status);
        console.error(`[Agent SIP] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        throw new Error(err.response?.data?.detail?.[0]?.msg || err.message);
    }
}

async function updatePhoneNumber(phoneNumberId, payload) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent Phone Update] ELEVENLABS_API_URL not configured');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/phone-numbers/${phoneNumberId}`;
        console.log(`[Agent Phone Update] PATCH ${url}`);
        console.log(`[Agent Phone Update] Payload:`, JSON.stringify(payload, null, 2));

        const response = await axios.patch(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent Phone Update] Status: ${response.status}`);
        console.log(`[Agent Phone Update] Response Data:`, JSON.stringify(response.data, null, 2));
        return response.data;
    } catch (err) {
        console.error(`[Agent Phone Update] Failed to update phone number`);
        console.error(`[Agent Phone Update] Error Status:`, err.response?.status);
        console.error(`[Agent Phone Update] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        throw new Error(err.response?.data?.detail?.[0]?.msg || err.message);
    }
}

async function deletePhoneNumber(phoneNumberId) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent SIP Delete] ELEVENLABS_API_URL not configured');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/phone-numbers/${phoneNumberId}`;
        console.log(`[Agent SIP Delete] DELETE ${url}`);

        const response = await axios.delete(url, {
            headers: {
                'accept': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent SIP Delete] Status: ${response.status}`);
        return response.data; // { success: true, message: "..." }
    } catch (err) {
        console.error(`[Agent SIP Delete] Failed to delete phone number`);
        console.error(`[Agent SIP Delete] Error Status:`, err.response?.status);
        console.error(`[Agent SIP Delete] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        throw new Error(err.response?.data?.detail?.[0]?.msg || err.message);
    }
}

async function registerTool(schoolId, agentId) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent Tool Register] ELEVENLABS_API_URL not configured');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/register-tool`;
        const payload = { school_id: schoolId, agent_id: agentId };
        console.log(`[Agent Tool Register] POST ${url}`);
        console.log(`[Agent Tool Register] Payload:`, JSON.stringify(payload, null, 2));

        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent Tool Register] Status: ${response.status}`);
        console.log(`[Agent Tool Register] Response:`, JSON.stringify(response.data, null, 2));
        return response.data?.tool_id || null; // Return ONLY the ID string
    } catch (err) {
        console.error(`[Agent Tool Register] Failed to register tool for school ${schoolId}`);
        console.error(`[Agent Tool Register] Error Status:`, err.response?.status);
        console.error(`[Agent Tool Register] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        return null;
    }
}

async function deleteTool(toolId) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !toolId) {
        console.warn('[Agent Tool Delete] ELEVENLABS_API_URL or toolId not configured');
        return false;
    }

    try {
        const url = `${baseUrl}/api/v1/tools/${encodeURIComponent(toolId)}`;
        console.log(`[Agent Tool Delete] DELETE ${url}`);
        const response = await axios.delete(url, { headers: elevenLabsHeaders() });
        console.log(`[Agent Tool Delete] Status: ${response.status}`);
        return true;
    } catch (err) {
        if (err.response?.status === 404) {
            console.warn(`[Agent Tool Delete] Tool ${toolId} not found (already deleted)`);
            return true;
        }
        console.error(`[Agent Tool Delete] Failed to delete tool ${toolId}`);
        console.error(`[Agent Tool Delete] Error Status:`, err.response?.status);
        console.error(`[Agent Tool Delete] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        return false;
    }
}

function getBookedSlotsToolIds(toolIds = []) {
    return (Array.isArray(toolIds) ? toolIds : [])
        .map((id) => String(id).trim())
        .filter(Boolean)
        .filter((id) => id !== GLOBAL_TIME_TOOL_ID);
}

// Helper function to ingest a knowledge base document to ElevenLabs
async function ingestKnowledgeBaseDocument(text, schoolName) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[KB] ELEVENLABS_API_URL not configured, skipping KB ingestion');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/knowledge-base/ingest`;

        // Generate document name on backend
        const documentName = `${schoolName} - Knowledge Base`;

        // Create FormData
        const formData = new FormData();
        formData.append('source_type', 'text');
        formData.append('text', text);
        formData.append('name', documentName);

        console.log(`[KB POST] Request URL: ${url}`);
        const response = await axios.post(url, formData, {
            headers: {
                ...formData.getHeaders(),
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[KB POST] Response Status: ${response.status}`);
        const documentId = response.data?.document_id || response.data?.id;
        console.log(`[KB] Successfully ingested document: ${documentId}`);
        return documentId;
    } catch (err) {
        console.error(`[KB POST] Failed to ingest document`);
        console.error(`[KB POST] Error Status:`, err.response?.status);
        console.error(`[KB POST] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        throw err;
    }
}

async function deleteKnowledgeBaseDocument(documentId) {
    if (!documentId) return;
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[KB] ELEVENLABS_API_URL not configured, skipping KB delete');
        return;
    }

    try {
        const url = `${baseUrl}/api/v1/knowledge-base/${documentId}`;
        console.log(`[KB DELETE] Request URL: ${url}`);
        const response = await axios.delete(url, { headers: elevenLabsHeaders() });
        console.log(`[KB DELETE] Response Status: ${response.status}`);
    } catch (err) {
        console.error(`[KB DELETE] Failed to delete document ${documentId}`);
        console.error(`[KB DELETE] Error Status:`, err.response?.status);
        console.error(`[KB DELETE] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        // Don't throw - caller continues to create the replacement document
    }
}

function normalizeToolIds(toolIds) {
    const ids = Array.isArray(toolIds)
        ? toolIds.filter(Boolean).map((id) => String(id).trim()).filter(Boolean)
        : [];
    return [...new Set([...ids, GLOBAL_TIME_TOOL_ID])];
}

function isToolsToolIdsConflict(err) {
    const detail = JSON.stringify(err?.response?.data || {});
    return err?.response?.status === 400 && /both tools and tool IDs/i.test(detail);
}

function elevenLabsHeaders() {
    return {
        'Content-Type': 'application/json',
        ...(process.env.ELEVENLABS_API_KEY && { Authorization: `Bearer ${process.env.ELEVENLABS_API_KEY}` }),
    };
}

function resolveAgentBranchId(snapshot) {
    if (!snapshot) return null;
    return snapshot.branch_id || snapshot.main_branch_id || null;
}

function agentsUrlFor(baseUrl, agentId, branchId = null) {
    let url = `${baseUrl}/api/v1/agents/${agentId}`;
    if (branchId) {
        url += `?branch_id=${encodeURIComponent(branchId)}`;
    }
    return url;
}

function promptUrlFor(baseUrl, agentId, branchId = null) {
    return `${agentsUrlFor(baseUrl, agentId, branchId)}/prompt`;
}

/** Read agent fields from nested conversation_config (ElevenLabs native) or flat wrapper shape. */
function extractConversationAgent(snapshot) {
    if (!snapshot) return {};
    const nested = snapshot.conversation_config?.agent;
    if (nested && typeof nested === 'object') {
        return nested;
    }
    return {
        first_message: snapshot.first_message,
        language: snapshot.language,
        prompt: {
            prompt: snapshot.system_prompt,
            tool_ids: snapshot.tool_ids,
        },
    };
}

function getAgentFirstMessage(snapshot) {
    const agent = extractConversationAgent(snapshot);
    return agent.first_message ?? snapshot?.first_message ?? '';
}

function getAgentPromptText(snapshot) {
    const agent = extractConversationAgent(snapshot);
    return agent.prompt?.prompt ?? snapshot?.system_prompt ?? '';
}

function normalizePromptForCompare(text) {
    return String(text || '').replace(/\r\n/g, '\n').trim();
}

/** PATCH /agents/:id/prompt — tool_ids only (registration repair path). */
function buildPromptSubresourcePayload({ fullPrompt, knowledgeBaseId }) {
    const kbId = knowledgeBaseId && String(knowledgeBaseId).trim();
    return {
        system_prompt: fullPrompt,
        knowledge_base_ids: kbId ? [kbId] : [],
        language: 'en',
    };
}

/** PATCH /agents/:id — conversation_config.agent.prompt (ElevenLabs UI source of truth). */
function buildSystemPromptAgentsPayload(fullPrompt, knowledgeBaseId, existingAgent = {}) {
    const existingPrompt = existingAgent?.prompt || {};
    const prompt = {
        llm: existingPrompt.llm || 'gemini-2.5-flash',
        prompt: fullPrompt,
    };
    if (Array.isArray(existingPrompt.tool_ids) && existingPrompt.tool_ids.length > 0) {
        prompt.tool_ids = existingPrompt.tool_ids;
    }

    const kbId = knowledgeBaseId && String(knowledgeBaseId).trim();
    if (kbId) {
        const existingKb = Array.isArray(existingPrompt.knowledge_base)
            ? existingPrompt.knowledge_base.find((doc) => doc?.id === kbId)
            : null;
        // ElevenLabs requires type, id, and name on each knowledge_base entry.
        prompt.knowledge_base = [{
            type: existingKb?.type || 'file',
            id: kbId,
            name: existingKb?.name || 'School knowledge base',
            usage_mode: existingKb?.usage_mode || 'auto',
        }];
    }

    return {
        conversation_config: {
            agent: { prompt },
        },
    };
}

function buildFirstMessageAgentsPayload(firstMessage) {
    return {
        conversation_config: {
            agent: {
                first_message: firstMessage || '',
            },
        },
    };
}

function logElevenLabsExchange(label, { method, url, payload, response, error }) {
    const preview = (text, max = 400) => {
        const s = String(text || '');
        return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
    };
    console.log(`[ElevenLabs] ========== ${label} ==========`);
    console.log(`[ElevenLabs] ${method} ${url}`);
    if (payload) {
        const nestedPrompt = payload?.conversation_config?.agent?.prompt?.prompt;
        console.log('[ElevenLabs] Request payload:', JSON.stringify({
            ...payload,
            system_prompt: payload.system_prompt
                ? preview(payload.system_prompt, 500)
                : payload.system_prompt,
            conversation_config: payload.conversation_config
                ? {
                    ...payload.conversation_config,
                    agent: payload.conversation_config.agent
                        ? {
                            ...payload.conversation_config.agent,
                            prompt: payload.conversation_config.agent.prompt
                                ? {
                                    ...payload.conversation_config.agent.prompt,
                                    prompt: nestedPrompt
                                        ? preview(nestedPrompt, 500)
                                        : payload.conversation_config.agent.prompt.prompt,
                                }
                                : undefined,
                        }
                        : undefined,
                }
                : payload.conversation_config,
        }, null, 2));
    }
    if (response) {
        console.log(`[ElevenLabs] Response status: ${response.status}`);
        const data = response.data;
        console.log('[ElevenLabs] Response data:', JSON.stringify(data, null, 2));
    }
    if (error) {
        console.log(`[ElevenLabs] Error status: ${error?.response?.status}`);
        console.log('[ElevenLabs] Error data:', JSON.stringify(error?.response?.data || {}, null, 2));
        console.log('[ElevenLabs] Error message:', error.message);
    }
    console.log(`[ElevenLabs] ========== end ${label} ==========`);
}

async function fetchAgentSnapshot(agentId, label = 'GET agent', branchId = null) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) return null;
    const url = agentsUrlFor(baseUrl, agentId, branchId);
    try {
        const response = await axios.get(url, { headers: elevenLabsHeaders() });
        logElevenLabsExchange(label, { method: 'GET', url, response });
        return response.data;
    } catch (err) {
        logElevenLabsExchange(`${label} (failed)`, { method: 'GET', url, error: err });
        return null;
    }
}

/**
 * Set agent tools by ID only. register-tool attaches full tool objects first;
 * we normalize to tool_ids via /agents (preferred) then /prompt.
 */
async function linkAgentToolIds(agentId, toolIds, { branchId = null } = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        console.warn('[Agent Link Tools] ELEVENLABS_API_URL or agentId not configured');
        return null;
    }

    const finalToolIds = normalizeToolIds(toolIds);
    const agentsUrl = agentsUrlFor(baseUrl, agentId, branchId);
    const promptUrl = `${agentsUrl}/prompt`;
    const agentsPayload = {
        conversation_config: {
            agent: {
                prompt: {
                    tool_ids: finalToolIds,
                    // Clear inline tools left by register-tool so /prompt updates do not 400.
                    tools: [],
                    built_in_tools: {
                        transfer_to_number: null,
                    },
                },
            },
        },
    };
    const promptPayload = { tool_ids: finalToolIds };

    console.log('[Agent Link Tools] agent:', agentId, 'tool_ids:', finalToolIds);

    // Prefer /agents — avoids conflicting with inline tools left by register-tool.
    try {
        const response = await axios.patch(agentsUrl, agentsPayload, { headers: elevenLabsHeaders() });
        console.log('[Agent Link Tools] /agents status:', response.status);
        return response.data;
    } catch (agentsErr) {
        if (!isToolsToolIdsConflict(agentsErr)) {
            console.warn('[Agent Link Tools] /agents failed:', agentsErr.response?.status, agentsErr.response?.data || agentsErr.message);
        }
    }

    try {
        const response = await axios.patch(promptUrl, promptPayload, { headers: elevenLabsHeaders() });
        console.log('[Agent Link Tools] /prompt status:', response.status);
        return response.data;
    } catch (promptErr) {
        console.error('[Agent Link Tools] Failed for agent', agentId);
        console.error('[Agent Link Tools] Error Status:', promptErr.response?.status);
        console.error('[Agent Link Tools] Error Data:', JSON.stringify(promptErr.response?.data || {}, null, 2));
        if (isToolsToolIdsConflict(promptErr)) {
            console.warn(
                '[Agent Link Tools] register-tool already attached tools on this agent; '
                + 'tool_ids could not be set. Voice agent may still work — fix agent in ElevenLabs or recreate the school.'
            );
        }
        return null;
    }
}

/**
 * PATCH /agents/:id — system prompt only (conversation_config.agent.prompt.prompt).
 */
async function patchAgentSystemPrompt(agentId, fullPrompt, knowledgeBaseId = '', {
    branchId = null,
    label = 'PATCH /agents system_prompt',
    existingAgent = null,
} = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        console.warn('[Agent Patch System Prompt] ELEVENLABS_API_URL or agentId not configured');
        return null;
    }

    let agentConfig = existingAgent;
    if (!agentConfig) {
        const snapshot = await fetchAgentSnapshot(agentId, 'load agent for system_prompt', branchId);
        agentConfig = extractConversationAgent(snapshot);
    }

    const url = agentsUrlFor(baseUrl, agentId, branchId);
    const payload = buildSystemPromptAgentsPayload(fullPrompt, knowledgeBaseId, agentConfig);
    try {
        const response = await axios.patch(url, payload, { headers: elevenLabsHeaders() });
        logElevenLabsExchange(label, { method: 'PATCH', url, payload, response });
        return response.data;
    } catch (err) {
        const detail = JSON.stringify(err?.response?.data || {});
        if (err?.response?.status === 400 && /field required/i.test(detail)) {
            console.warn('[Agent Patch System Prompt] nested PATCH failed — retry via /prompt');
            const fallback = buildPromptSubresourcePayload({ fullPrompt, knowledgeBaseId });
            return patchAgentPrompt(agentId, fallback, { branchId, label: `${label} (/prompt fallback)` });
        }
        logElevenLabsExchange(`${label} (failed)`, { method: 'PATCH', url, payload, error: err });
        throw err;
    }
}

/**
 * PATCH /agents/:id — first_message only (lives on conversation_config.agent, not /prompt).
 */
async function patchAgentFirstMessage(agentId, firstMessage, { branchId = null, label = 'PATCH /agents first_message' } = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        console.warn('[Agent Patch First Message] ELEVENLABS_API_URL or agentId not configured');
        return null;
    }

    const url = agentsUrlFor(baseUrl, agentId, branchId);
    const payload = buildFirstMessageAgentsPayload(firstMessage);
    try {
        const response = await axios.patch(url, payload, { headers: elevenLabsHeaders() });
        logElevenLabsExchange(label, { method: 'PATCH', url, payload, response });
        return response.data;
    } catch (err) {
        logElevenLabsExchange(`${label} (failed)`, { method: 'PATCH', url, payload, error: err });
        throw err;
    }
}

/**
 * PATCH /agents/:id/prompt — system prompt + KB. Never send tool_ids or first_message here.
 */
async function patchAgentPrompt(agentId, payload, { branchId = null, label = 'PATCH /prompt' } = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        console.warn('[Agent Patch Prompt] ELEVENLABS_API_URL or agentId not configured');
        return null;
    }

    const url = promptUrlFor(baseUrl, agentId, branchId);
    try {
        const response = await axios.patch(url, payload, { headers: elevenLabsHeaders() });
        logElevenLabsExchange(label, { method: 'PATCH', url, payload, response });
        return response.data;
    } catch (err) {
        logElevenLabsExchange(`${label} (failed)`, { method: 'PATCH', url, payload, error: err });
        throw err;
    }
}

/**
 * Admin: system prompt via PATCH /agents (prompt.prompt); greeting via PATCH /agents (first_message).
 */
async function patchAgentPromptContent(agentId, {
    firstMessage = '',
    systemPrompt = '',
    knowledgeBaseId = '',
} = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        console.warn('[Agent Prompt Content] missing ELEVENLABS_API_URL or agentId');
        return null;
    }

    const baseSystem = String(systemPrompt || '').trim();
    const fullPrompt = baseSystem.includes('EXECUTION ORDER')
        ? baseSystem
        : `${baseSystem}\n\n${APPOINTMENT_AGENT_PROMPT}`;

    console.log('[Agent Prompt Content] agentId:', agentId);
    console.log('[Agent Prompt Content] PATCH /agents (prompt.prompt + first_message), no tools');

    const before = await fetchAgentSnapshot(agentId, 'BEFORE patch');
    const branchId = resolveAgentBranchId(before);
    const agentsUrl = agentsUrlFor(baseUrl, agentId, branchId);
    if (branchId) {
        console.log('[Agent Prompt Content] branch_id:', branchId);
    }

    const existingAgent = extractConversationAgent(before);
    const promptPatchResponse = await patchAgentSystemPrompt(agentId, fullPrompt, knowledgeBaseId, {
        branchId,
        label: 'admin system_prompt',
        existingAgent,
    });

    const firstMessagePatchResponse = await patchAgentFirstMessage(agentId, firstMessage, {
        branchId,
        label: 'admin first_message',
    });

    await patchAgentTurnConfig(agentId, { branchId });

    const after = await fetchAgentSnapshot(agentId, 'AFTER patch', branchId);
    const beforeMsg = getAgentFirstMessage(before);
    const afterMsg = getAgentFirstMessage(after);
    const beforePrompt = getAgentPromptText(before);
    const afterPrompt = getAgentPromptText(after);
    const expectedMsg = firstMessage || '';
    const verifyFirstMessageChanged = afterMsg !== beforeMsg;
    const verifyFirstMessageMatches = afterMsg.trim() === expectedMsg.trim();
    const verifyPromptChanged = normalizePromptForCompare(afterPrompt) !== normalizePromptForCompare(beforePrompt);
    const verifyPromptMatches = normalizePromptForCompare(afterPrompt) === normalizePromptForCompare(fullPrompt);
    const verifyChanged = verifyFirstMessageChanged || verifyPromptChanged;
    const verifyMatches = verifyFirstMessageMatches && verifyPromptMatches;

    console.log('[Agent Prompt Content] verify first_message changed:', verifyFirstMessageChanged);
    console.log('[Agent Prompt Content] verify first_message matches:', verifyFirstMessageMatches);
    console.log('[Agent Prompt Content] verify system_prompt changed:', verifyPromptChanged);
    console.log('[Agent Prompt Content] verify system_prompt matches:', verifyPromptMatches);
    console.log('[Agent Prompt Content] BEFORE greeting:', (beforeMsg || '').slice(0, 120));
    console.log('[Agent Prompt Content] AFTER greeting:', (afterMsg || '').slice(0, 120));
    console.log('[Agent Prompt Content] EXPECTED greeting:', expectedMsg.slice(0, 120));

    return {
        patchResponse: { prompt: promptPatchResponse, firstMessage: firstMessagePatchResponse },
        agentId,
        agentsUrl,
        verifyFirstMessageChanged,
        verifyMatchesExpected: verifyMatches,
        verifyFirstMessageMatches,
        verifyPromptMatches,
        beforeSnapshot: before,
        afterSnapshot: after,
    };
}

/**
 * School settings: prompt/KB via PATCH /prompt; human transfer via PATCH /agents built_in_tools.
 * Does not touch tools (those are set once at registration).
 */
async function syncSchoolAgent(agentId, {
    firstMessage = '',
    systemPrompt = '',
    knowledgeBaseId = '',
    humanTransfer = { enabled: false, condition: '', phoneNumber: '' },
} = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        return null;
    }

    const fullPrompt = `${systemPrompt || ''}\n\n${APPOINTMENT_AGENT_PROMPT}`;
    const transferOn = Boolean(humanTransfer?.enabled && humanTransfer?.phoneNumber);

    const before = await fetchAgentSnapshot(agentId, 'sync before');
    const branchId = resolveAgentBranchId(before);
    if (branchId) {
        console.log('[Agent Sync] branch_id:', branchId);
    }

    console.log('[Agent Sync] PATCH /agents (prompt.prompt + first_message), no tools');
    const promptPatchResponse = await patchAgentSystemPrompt(agentId, fullPrompt, knowledgeBaseId, {
        branchId,
        label: 'settings system_prompt',
        existingAgent: extractConversationAgent(before),
    });
    const firstMessagePatchResponse = await patchAgentFirstMessage(agentId, firstMessage, {
        branchId,
        label: 'settings first_message',
    });
    const patchResponse = { prompt: promptPatchResponse, firstMessage: firstMessagePatchResponse };

    await patchAgentTurnConfig(agentId, { branchId });

    const transferResult = await patchAgentHumanTransfer(agentId, humanTransfer, { branchId });
    if (transferOn && !transferResult) {
        const err = new Error('Prompt saved but human transfer failed to sync to ElevenLabs (built_in_tools).');
        reportElevenLabsAlert(err, {
            title: 'ElevenLabs agent sync failed',
            source: 'elevenlabs.syncSchoolAgent',
            metadata: { agentId },
        });
        err.statusCode = 502;
        throw err;
    }
    if (!transferOn) {
        console.log('[Agent Sync] human transfer disabled on agent');
    } else {
        console.log('[Agent Sync] human transfer synced via built_in_tools.transfer_to_number');
    }

    return patchResponse;
}

/**
 * Turn-taking config so Nora waits for callers to finish (esp. while spelling emails/numbers)
 * instead of cutting them off. Applied most-preferred first; on a 400 (unsupported field on
 * this API version) we fall back to progressively simpler configs so the safe settings still land.
 */
const TURN_CONFIG_ATTEMPTS = [
    { turn_timeout: 12, turn_eagerness: 'patient' },
    { turn_timeout: 12 },
];

async function patchAgentTurnConfig(agentId, { branchId = null, attempts = TURN_CONFIG_ATTEMPTS } = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        return null;
    }
    const url = agentsUrlFor(baseUrl, agentId, branchId);
    let lastErr = null;
    for (const turn of attempts) {
        try {
            const response = await axios.patch(url, { conversation_config: { turn } }, { headers: elevenLabsHeaders() });
            console.log('[Agent Turn] applied turn config:', JSON.stringify(turn));
            return response.data;
        } catch (err) {
            lastErr = err;
            if (err?.response?.status !== 400) break;
            console.warn('[Agent Turn] turn config rejected, trying simpler config:', JSON.stringify(err?.response?.data || {}));
        }
    }
    console.error('[Agent Turn] turn config patch failed:', lastErr?.response?.status, JSON.stringify(lastErr?.response?.data || {}));
    return null;
}

async function patchAgentHumanTransfer(agentId, humanTransfer, { branchId = null } = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        return null;
    }

    const enabled = Boolean(humanTransfer?.enabled && humanTransfer?.phoneNumber);
    const transferToolConfig = enabled
        ? {
            type: 'system',
            name: 'transfer_to_number',
            response_timeout_secs: 20,
            disable_interruptions: false,
            force_pre_tool_speech: false,
            pre_tool_speech: 'auto',
            assignments: [],
            tool_call_sound: null,
            tool_call_sound_behavior: 'auto',
            tool_error_handling_mode: 'auto',
            params: {
                system_tool_type: 'transfer_to_number',
                transfers: [{
                    custom_sip_headers: [],
                    transfer_destination: {
                        type: 'phone',
                        phone_number: humanTransfer.phoneNumber
                    },
                    transfer_type: 'sip_refer',
                    post_dial_digits: null,
                    phone_number: humanTransfer.phoneNumber,
                    condition: buildHumanTransferToolCondition(humanTransfer.condition),
                }],
                enable_client_message: true
            }
        }
        : null;

    try {
        const url = agentsUrlFor(baseUrl, agentId, branchId);
        const payload = {
            conversation_config: {
                agent: {
                    prompt: {
                        built_in_tools: {
                            transfer_to_number: transferToolConfig,
                        },
                    },
                },
            },
        };
        console.log('[Agent Human Transfer] PATCH /agents built_in_tools.transfer_to_number', enabled ? 'enabled' : 'disabled');
        if (enabled) {
            console.log('[Agent Human Transfer] condition:', buildHumanTransferToolCondition(humanTransfer.condition));
            console.log('[Agent Human Transfer] phone:', humanTransfer.phoneNumber);
        }

        const response = await axios.patch(url, payload, { headers: elevenLabsHeaders() });
        console.log('[Agent Human Transfer] status:', response.status);
        return response.data;
    } catch (err) {
        console.error('[Agent Human Transfer] failed:', err.response?.status, JSON.stringify(err.response?.data || {}));
        if (isToolsToolIdsConflict(err)) {
            console.error('[Agent Human Transfer] cannot set built_in_tools while agent uses tool_ids in the same prompt config');
        }
        return null;
    }
}

/** GET /conversations/:id/audio — used by the call-recording proxy. */
async function getConversationAudio(conversationId) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) return null;
    const response = await axios.get(`${baseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}/audio`, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: elevenLabsHeaders(),
    });
    return { buffer: Buffer.from(response.data), contentType: response.headers?.['content-type'] || 'audio/mpeg' };
}

/** Lightweight reachability probe for the admin health dashboard. */
async function checkHealth() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const baseUrl = (process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io').replace(/\/$/, '');
    if (!apiKey) {
        return { ok: false, detail: 'ELEVENLABS_API_KEY missing' };
    }
    try {
        const start = Date.now();
        await axios.get(`${baseUrl}/v1/user`, {
            headers: { 'xi-api-key': apiKey },
            timeout: 8000,
        });
        return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
        return { ok: false, detail: err.response?.status ? `HTTP ${err.response.status}` : err.message };
    }
}

/**
 * Orchestrates the full new-school provisioning sequence: ingest KB (if any) → create
 * agent with that KB attached → register + link the booked-slots tool.
 * Mirrors ElevenLabs' existing agent-creation order (KB id is passed at create time).
 */
async function provisionAgent(school) {
    const schoolName = school.name;
    let knowledgeBaseDocumentId = school.knowledgeBaseDocumentId || null;

    if (!knowledgeBaseDocumentId && Array.isArray(school.qaPairs) && school.qaPairs.length > 0) {
        const kbText = formatQAPairsForKB(school.qaPairs);
        if (kbText) {
            knowledgeBaseDocumentId = await ingestKnowledgeBaseDocument(kbText, schoolName);
        }
    }

    const agentId = await createSchoolAgent(schoolName, knowledgeBaseDocumentId);
    if (!agentId) {
        return { agentId: null, knowledgeBaseDocumentId };
    }

    const toolId = await registerTool(school._id.toString(), agentId);
    let toolIds = null;
    let toolsLinked = true;
    if (toolId) {
        toolIds = [toolId, GLOBAL_TIME_TOOL_ID];
        toolsLinked = Boolean(await linkAgentToolIds(agentId, toolIds));
    }

    return { agentId, knowledgeBaseDocumentId, toolIds, toolsLinked };
}

module.exports = {
    createSchoolAgent,
    importSipTrunk,
    deletePhoneNumber,
    updatePhoneNumber,
    registerTool,
    deleteTool,
    getBookedSlotsToolIds,
    patchAgentPrompt,
    patchAgentSystemPrompt,
    patchAgentFirstMessage,
    linkAgentToolIds,
    syncSchoolAgent,
    patchAgentPromptContent,
    patchAgentHumanTransfer,
    patchAgentTurnConfig,
    normalizeToolIds,
    isToolsToolIdsConflict,
    formatQAPairsForKB,
    ingestKnowledgeBaseDocument,
    deleteKnowledgeBaseDocument,
    getConversationAudio,
    checkHealth,
    provisionAgent,
    APPOINTMENT_AGENT_PROMPT,
    GLOBAL_TIME_TOOL_ID,
    NORA_SYSTEM_PROMPT_TEMPLATE,
    DEFAULT_FIRST_MESSAGE_TEMPLATE,
    buildDefaultSchoolAgentPrompts,
    HUMAN_TRANSFER_TOOL_CONDITION,
    buildHumanTransferToolCondition,
};
