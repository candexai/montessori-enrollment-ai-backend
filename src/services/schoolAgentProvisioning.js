const { getActiveProvider, getActiveProviderName } = require('./voiceProviders');
const AlertService = require('./alertService');

/**
 * Creates the voice agent (and KB/tools) for a brand-new school on whichever provider is
 * currently active (VOICE_PROVIDER env), and stamps school.voiceProvider so later
 * settings/prompt/phone-number operations route back to the same provider that created it.
 * Mutates `school` in place; caller is responsible for `school.save()`.
 */
async function provisionSchoolVoiceAgent(school, { source }) {
    const provider = getActiveProvider();
    const providerName = getActiveProviderName();
    const schoolName = school.name;

    const result = await provider.provisionAgent(school);

    if (!result?.agentId) {
        AlertService.create({
            type: 'AGENT_ERROR',
            severity: 'CRITICAL',
            schoolId: school._id,
            schoolName,
            title: `${source}: school registered without voice agent`,
            message: `provisionAgent returned no agentId (provider: ${providerName})`,
            source,
            metadata: { provider: providerName },
        });
        if (result?.knowledgeBaseDocumentId) {
            school.knowledgeBaseDocumentId = result.knowledgeBaseDocumentId;
        }
        return { agentId: null, providerName };
    }

    school.elevenlabsAgentId = result.agentId;
    school.voiceProvider = providerName;
    if (result.knowledgeBaseDocumentId) {
        school.knowledgeBaseDocumentId = result.knowledgeBaseDocumentId;
    }
    if (Array.isArray(result.toolIds) && result.toolIds.length > 0) {
        school.toolIds = result.toolIds;
    }

    if (result.toolIds && !result.toolsLinked) {
        AlertService.create({
            type: 'AGENT_ERROR',
            severity: 'WARNING',
            schoolId: school._id,
            schoolName,
            title: `${source}: tool linking failed`,
            message: `linkAgentToolIds failed for agent ${result.agentId} (provider: ${providerName})`,
            source,
            metadata: { provider: providerName, agentId: result.agentId },
        });
    }

    return { agentId: result.agentId, providerName };
}

module.exports = { provisionSchoolVoiceAgent };
