#!/usr/bin/env node
/**
 * Re-register get_booked_slots for every school against the new ElevenLabs wrapper URL.
 * Deletes old booked-slots tool IDs (from school creation) and links the new tool to each agent.
 *
 * Usage:
 *   node scripts/reregister-booked-slots-all-schools.js [--dry-run] [--schoolId=<id>]
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const School = require('../src/models/School');
const {
    registerTool,
    deleteTool,
    linkAgentToolIds,
    getBookedSlotsToolIds,
    GLOBAL_TIME_TOOL_ID,
} = require('../src/services/voiceProviders/elevenlabs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reregisterBookedSlotsAllSchools() {
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
    console.log(`ElevenLabs API: ${process.env.ELEVENLABS_API_URL || '(not set)'}`);

    const query = {
        ...(schoolIdFilter ? { _id: new mongoose.Types.ObjectId(schoolIdFilter) } : {}),
    };

    const schools = await School.find(query)
        .select('name elevenlabsAgentId toolIds')
        .sort({ name: 1 })
        .lean();

    console.log(`Found ${schools.length} school(s)`);

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const school of schools) {
        const agentId = String(school.elevenlabsAgentId || '').trim();
        const oldBookedSlotsToolIds = getBookedSlotsToolIds(school.toolIds);

        if (!agentId) {
            skipped += 1;
            console.log(`[skip] ${school.name}: no elevenlabsAgentId`);
            continue;
        }

        console.log(
            `[${dryRun ? 'would update' : 'update'}] ${school.name} (${agentId})`
            + (oldBookedSlotsToolIds.length ? ` — delete old: ${oldBookedSlotsToolIds.join(', ')}` : ' — no old booked-slots tool')
        );

        if (dryRun) {
            updated += 1;
            continue;
        }

        try {
            const newToolId = await registerTool(school._id.toString(), agentId);
            if (!newToolId) {
                throw new Error('registerTool returned no tool_id');
            }

            const nextToolIds = [newToolId, GLOBAL_TIME_TOOL_ID];
            const linked = await linkAgentToolIds(agentId, nextToolIds);
            if (!linked) {
                console.warn(`[warn] ${school.name}: tool registered (${newToolId}) but linkAgentToolIds failed`);
            }

            for (const oldToolId of oldBookedSlotsToolIds) {
                if (oldToolId === newToolId) continue;
                const deleted = await deleteTool(oldToolId);
                if (!deleted) {
                    console.warn(`[warn] ${school.name}: could not delete old tool ${oldToolId} (may still be orphaned in ElevenLabs)`);
                }
                await sleep(200);
            }

            await School.updateOne(
                { _id: school._id },
                { $set: { toolIds: nextToolIds } }
            );

            updated += 1;
            console.log(`[ok] ${school.name}: new tool ${newToolId}`);
            await sleep(400);
        } catch (err) {
            failed += 1;
            const detail = err?.response?.data?.detail || err?.message || String(err);
            console.error(`[fail] ${school.name}: ${detail}`);
        }
    }

    console.log(`Done. Updated: ${updated}, skipped: ${skipped}, failed: ${failed}.`);
    await mongoose.disconnect();
}

reregisterBookedSlotsAllSchools().catch((err) => {
    console.error('Re-register booked slots failed:', err);
    process.exit(1);
});
