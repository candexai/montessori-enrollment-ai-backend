const mongoose = require('mongoose');

const phoneNumberSchema = new mongoose.Schema({
    phone_number_id: { type: String, required: true, unique: true },
    phone_number: { type: String, required: true },
    provider: { type: String, enum: ['sip_trunk'], required: true },
    // Which voice-provider platform (ElevenLabs vs Cartesia) this phone_number_id lives in —
    // separate from `provider` above, which is the SIP import method. A number can only be
    // assigned to a school whose voiceProvider matches this field.
    voiceProvider: { type: String, enum: ['elevenlabs', 'cartesia'], default: 'elevenlabs' },
    label: { type: String, default: '' },
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

module.exports = mongoose.model('PhoneNumber', phoneNumberSchema);
