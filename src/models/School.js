const mongoose = require('mongoose');

const schoolSchema = new mongoose.Schema({
    name: { type: String, required: true },
    aiNumber: { type: String, default: '' },
    /** Set when aiNumber first becomes non-empty or changes (digits). Used to exclude pre-assignment VoiceAI history when a number is reused. */
    aiNumberAssignedAt: { type: Date, default: null },
    routingNumber: { type: String, default: '' },
    escalationNumber: { type: String, default: '' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    language: { type: String, enum: ['EN', 'ES'], default: 'EN' },
    script: { type: String, default: "Hi, thanks for calling our school, this is Nora, a virtual assistant.\nYou can speak in English or Spanish — si prefiere, puede hablar en español. ¿Le puedo ayudar en algo? How can I help you today?" },
    systemPrompt: { type: String, default: '' }, // System prompt for agent configuration
    businessHoursStart: { type: String, default: '09:00' },
    businessHoursEnd: { type: String, default: '17:00' },
    // Automation
    smsAutoFollowup: { type: Boolean, default: false },
    emailAutoFollowup: { type: Boolean, default: false },
    smsTemplate: { type: String, default: 'Thank you for your interest in our school! Please complete our inquiry form here: {form_link}' },
    emailTemplate: { type: String, default: 'Dear {parent_name},\n\nThank you for contacting us regarding enrollment.\n\nPlease find the inquiry form at: {form_link}\n\nWarm regards,\n{school_name}' },
    // AI Knowledge Base
    qaPairs: [{
        question: { type: String, default: '' },
        answer: { type: String, default: '' }
    }],
    knowledgeBaseDocumentId: { type: String, default: '' },
    preferredCalendar: { type: String, enum: ['google', 'outlook', 'both', 'none'], default: 'google' },
    preferredEmailProvider: { type: String, enum: ['google', 'outlook'], default: 'google' },
    address: { type: String, default: '' },
    timezone: { type: String, default: 'America/Chicago' }, // School's local timezone
    adminEmail: { type: String, default: '' }, // Admin email for webhook notifications
    elevenlabsAgentId: { type: String, default: '' }, // Voice-provider agent ID for inbound call identification (name kept for compat; see voiceProvider)
    // Which voice provider elevenlabsAgentId/toolIds/agentPhoneNumberId belong to. Set once at agent
    // creation from the active VOICE_PROVIDER env; existing schools always route through this field,
    // not the current env value, so flipping VOICE_PROVIDER only affects brand-new schools.
    voiceProvider: { type: String, enum: ['elevenlabs', 'cartesia'], default: 'elevenlabs' },
    agentPhoneNumberId: { type: String, default: '' }, // Associated SIP trunk number ID
    // Tour confirmation templates
    tourConfirmationEmailTemplate: { type: String, default: 'Dear {parent_name},\n\nYour tour at {school_name} has been scheduled for {tour_date}.\n\nLocation: {school_address}\n\nWe look forward to seeing you!\n\nWarm regards,\n{school_name}' },
    tourReminderSmsTemplate: { type: String, default: 'Hi {parent_name}, this is a reminder for your tour at {school_name} tomorrow, {tour_date}. See you then!' },
    // Human transfer
    enableHumanTransfer: { type: Boolean, default: false },
    humanTransferCondition: { type: String, default: '' },
    humanTransferPhoneNumber: { type: String, default: '' },
    // Persist ElevenLabs tool IDs so later prompt updates do not clear tools.
    toolIds: { type: [String], default: [] },
    // Analytics
    wordCloud: { type: Array, default: [] },
    // Billing / PayPal (metered minutes when billingMode === 'metered')
    billingMode: { type: String, enum: ['none', 'metered'], default: 'none' },
    subscriptionPlanKey: {
        type: String,
        enum: ['starter', 'growth', 'full_enrollment', 'demo', ''],
        default: '',
    },
    subscriptionStatus: {
        type: String,
        enum: ['none', 'active', 'approval_pending', 'suspended', 'cancelled', 'past_due'],
        default: 'none',
    },
    paypalSubscriptionId: { type: String, default: '' },
    paypalLastPaymentId: { type: String, default: '' },
    /** Remaining minute credits (includes rollover + top-ups). Only enforced when billingMode is metered. */
    minuteBalance: { type: Number, default: null },
    foundingPartner: { type: Boolean, default: false },
    onboardingFeePaid: { type: Boolean, default: false },
    lastBillingCyclePaymentAt: { type: Date, default: null },
    /** First-login product UI tour for newly registered schools */
    productTour: {
        status: {
            type: String,
            enum: ['pending', 'in_progress', 'completed', 'dismissed'],
            default: 'pending',
        },
        currentStepId: { type: String, default: null },
        completedAt: { type: Date, default: null },
        skippedSteps: { type: [String], default: [] },
    },
}, { timestamps: true });

module.exports = mongoose.model('School', schoolSchema);
