#!/usr/bin/env node
/**
 * Exercises detectParentSegment / classifyLeadTemperature against fixture
 * transcripts covering the reported misclassification failure modes plus the
 * new hot/warm/cold tier. No DB connection required — pure function checks.
 * Usage: node scripts/verify-lead-classification.js
 */
const { detectParentSegment, classifyLeadTemperature } = require('../src/services/leadInsightService');

function callerTextFromTranscript(transcript) {
    return transcript
        .filter((t) => t.role === 'user')
        .map((t) => t.message)
        .join(' | ');
}

const CASES = [
    {
        name: 'FM1 fixed: new parent asks for a person but also mentions tuition/tour',
        transcript: [
            { role: 'user', message: 'Can I speak to someone about touring the school? My daughter starts preschool in the fall and I want to know about tuition.' },
        ],
        expectSegment: 'new_parent',
        expectTemperature: 'hot',
    },
    {
        name: 'FM1 regression guard: caller wants a human, zero other content',
        transcript: [{ role: 'user', message: 'Can I talk to someone please?' }],
        expectSegment: 'unknown',
        expectTemperature: 'cold',
    },
    {
        name: 'FM1 regression guard: agent confirms current family despite vague caller ask',
        transcript: [
            { role: 'user', message: 'I need to talk to the front desk about my kid.' },
            { role: 'agent', message: "I understand you're a current family, connecting you to the front desk now." },
        ],
        expectSegment: 'current_family',
    },
    {
        name: 'FM2 fixed: current family self-ID via new phrasing ("returning family")',
        transcript: [
            { role: 'user', message: "Hi, we're a returning family, my son's already enrolled and I have a question about the waitlist for the toddler room." },
        ],
        expectSegment: 'current_family',
        expectTemperature: 'hot',
    },
    {
        name: 'FM2 fixed: existing client phrasing',
        transcript: [
            { role: 'user', message: "We're an existing client, just wondering about your holiday closure schedule." },
        ],
        expectSegment: 'current_family',
        expectTemperature: 'hot',
    },
    {
        name: 'FM3 fixed: idle KB question alone -> warm, not hot',
        transcript: [
            { role: 'user', message: 'What are your hours and do you serve lunch?' },
        ],
        expectSegment: 'new_parent',
        expectTemperature: 'warm',
    },
    {
        name: 'FM3 fixed: KB question + concrete enrollment intent -> hot',
        transcript: [
            { role: 'user', message: 'What are your hours? I want to enroll my son starting next month.' },
        ],
        expectSegment: 'new_parent',
        expectTemperature: 'hot',
    },
    {
        name: 'FM4 fixed: soft first-person intent missed by old patterns (single soft signal -> warm, not unknown/cold)',
        transcript: [
            { role: 'user', message: "We're moving to the area next month and need to find childcare for our daughter." },
        ],
        expectSegment: 'new_parent',
        expectTemperature: 'warm',
    },
    {
        name: 'FM4 fixed: current family asks about waitlist for a second child',
        transcript: [
            { role: 'user', message: "I'm already enrolled, is there a waitlist for the toddler room for my second child?" },
        ],
        expectSegment: 'current_family',
        expectTemperature: 'hot',
    },
    {
        name: 'New warm case: generic tour interest, no urgency, no KB question',
        transcript: [
            { role: 'user', message: 'Just want to look around sometime, not sure when we will start.' },
        ],
        expectSegment: 'new_parent',
        expectTemperature: 'warm',
    },
    {
        name: 'New warm case: current family light chat, not substantive',
        transcript: [
            { role: 'user', message: "I'm a current family, just wanted to say hi to the director." },
        ],
        expectSegment: 'current_family',
        expectTemperature: 'cold',
    },
    {
        name: 'Confirmed: tour booked always hot, regardless of stated urgency',
        transcript: [
            { role: 'user', message: 'Just exploring options for next year, no rush, but go ahead and book the tour anyway.' },
        ],
        tourBooked: true,
        expectSegment: 'new_parent',
        expectTemperature: 'hot',
    },
    {
        name: 'Boundary: non-parent (teacher) never hot',
        transcript: [
            { role: 'user', message: "Hi, I'm a teacher calling about tuition rates and hours." },
        ],
        expectTemperature: 'cold',
    },
    {
        name: 'Boundary: no meaningful interaction always cold',
        transcript: [
            { role: 'user', message: 'Hi.' },
            { role: 'agent', message: 'Hi, thanks for calling! How can I help?' },
        ],
        expectSegment: 'unknown',
        expectTemperature: 'cold',
    },
];

let pass = 0;
let fail = 0;

for (const c of CASES) {
    const callerText = callerTextFromTranscript(c.transcript);
    const segment = detectParentSegment(c.tags || [], '', { transcript: c.transcript }, { tourBooked: c.tourBooked || false });
    const temperature = classifyLeadTemperature({
        tags: c.tags || [],
        callerText,
        parentSegment: segment,
        tourBooked: c.tourBooked || false,
    });

    const segOk = !c.expectSegment || segment === c.expectSegment;
    const tempOk = !c.expectTemperature || temperature === c.expectTemperature;

    if (segOk && tempOk) {
        pass += 1;
        console.log(`PASS  ${c.name}`);
    } else {
        fail += 1;
        console.log(
            `FAIL  ${c.name}  segment=${segment}${c.expectSegment ? ` (want ${c.expectSegment})` : ''} `
            + `temp=${temperature}${c.expectTemperature ? ` (want ${c.expectTemperature})` : ''}`
        );
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
