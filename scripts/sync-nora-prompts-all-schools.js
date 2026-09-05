#!/usr/bin/env node
/**
 * Push the latest Nora first message + system prompt to every school's ElevenLabs agent.
 * Usage:
 *   node scripts/sync-nora-prompts-all-schools.js [--dry-run] [--schoolId=<id>]
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const School = require('../src/models/School');
const {
    syncSchoolAgent,
    buildDefaultSchoolAgentPrompts,
} = require('../src/services/voiceProviders/elevenlabs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function syncNoraPromptsAllSchools() {
    const dryRun = process.argv.includes('--dry-run');
    const schoolIdArg = process.argv.find((arg) => arg.startsWith('--schoolId='));
    const schoolIdFilter = schoolIdArg ? schoolIdArg.split('=')[1] : null;

    if (!process.env.MONGODB_URI) {
        throw new Error('MONGODB_URI is not set');
    }
    if (!dryRun && !process.env.ELEVENLABS_API_URL) {
        throw new Error('ELEVENLABS_API_URL is not set');
    }

    await mongoose.connect(process.env.MONGODB_URI);
    console.log(`Connected to MongoDB${dryRun ? ' (dry run)' : ''}`);

    const query = {
        ...(schoolIdFilter ? { _id: new mongoose.Types.ObjectId(schoolIdFilter) } : {}),
    };

    const schools = await School.find(query)
        .select('name script systemPrompt elevenlabsAgentId knowledgeBaseDocumentId enableHumanTransfer humanTransferCondition humanTransferPhoneNumber status')
        .sort({ name: 1 })
        .lean();

    console.log(`Found ${schools.length} school(s)`);

    let synced = 0;
    let skipped = 0;
    let failed = 0;

    for (const school of schools) {
        const agentId = String(school.elevenlabsAgentId || '').trim();
        const { firstMessage, systemPrompt } = buildDefaultSchoolAgentPrompts(school.name);

        if (!agentId) {
            skipped += 1;
            console.log(`[skip] ${school.name}: no elevenlabsAgentId`);
            continue;
        }

        console.log(`[${dryRun ? 'would sync' : 'sync'}] ${school.name} (${agentId})`);

        if (dryRun) {
            synced += 1;
            continue;
        }

        try {
            await syncSchoolAgent(agentId, {
                firstMessage,
                systemPrompt,
                knowledgeBaseId: school.knowledgeBaseDocumentId || '',
                humanTransfer: {
                    enabled: Boolean(school.enableHumanTransfer),
                    condition: school.humanTransferCondition || '',
                    phoneNumber: school.humanTransferPhoneNumber || '',
                },
            });

            await School.updateOne(
                { _id: school._id },
                { $set: { script: firstMessage, systemPrompt } }
            );

            synced += 1;
            console.log(`[ok] ${school.name}`);
            await sleep(400);
        } catch (err) {
            failed += 1;
            const detail = err?.response?.data?.detail || err?.message || String(err);
            console.error(`[fail] ${school.name}: ${detail}`);
        }
    }

    console.log(`Done. Synced: ${synced}, skipped: ${skipped}, failed: ${failed}.`);
    await mongoose.disconnect();
}

syncNoraPromptsAllSchools().catch((err) => {
    console.error('Sync failed:', err);
    process.exit(1);
});
