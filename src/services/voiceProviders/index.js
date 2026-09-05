const shared = require('./shared/promptTemplates');

const providers = {
    elevenlabs: require('./elevenlabs'),
    cartesia: require('./cartesia'),
};

/** Provider used for brand-new agent creation. Existing agents route by School.voiceProvider instead. */
function getActiveProviderName() {
    const name = String(process.env.VOICE_PROVIDER || 'elevenlabs').trim().toLowerCase();
    return providers[name] ? name : 'elevenlabs';
}

function getProvider(name) {
    return providers[name] || providers.elevenlabs;
}

function getActiveProvider() {
    return getProvider(getActiveProviderName());
}

module.exports = {
    getProvider,
    getActiveProvider,
    getActiveProviderName,
    ...shared,
};
