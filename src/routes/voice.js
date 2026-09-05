const express = require('express');
const mongoose = require('mongoose');
const CallLog = require('../models/CallLog');
const School = require('../models/School');
const TourBooking = require('../models/TourBooking');
const { triggerAutomation } = require('../services/automation');
const { createCalendarEvent, getFreeSlots, isSlotAvailable, getBusySlots, getBusinessHoursRange } = require('../services/calendarService');
const { sendEmail } = require('../services/mailService');

const router = express.Router();

// Normalize phone for lookup (digits only, optional + prefix)
function normalizePhone(s) {
    if (!s || typeof s !== 'string') return '';
    const digits = s.replace(/\D/g, '');
    return digits ? `+${digits}` : '';
}

/**
 * AGENT INTEGRATION
 * Your AI voice agent (Vapi, Bland, Retell, or custom) should:
 *
 * 1. When a call starts: GET /api/voice/agent-config?to=+15551234567
 *    (use the "To" number). Response: schoolId, script, businessHours, formLink, etc.
 *
 * 2. During the call: Use script to answer; collect parentName, phone, email, childAge, reason.
 *    If they want a tour, collect preferred date/time and send it in call-end as leadData.tourScheduledAt (ISO).
 *
 * 3. When call ends: POST /api/voice/call-end with body:
 *    { schoolId, callerName, callerPhone, callType: 'inquiry'|'general', duration, recordingUrl?, leadData?: { parentName, phone, email, childAge, reason, tourScheduledAt? } }
 *    We will: create call log, send SMS/email with form link, and if tourScheduledAt present, book tour in Google/Outlook.
 */

// GET /api/voice/agent-config - No auth. Agent calls with the number that was dialed ("To").
// Query: to=+15551234567  OR  schoolId=507f1f77bcf86cd799439011
router.get('/agent-config', async (req, res) => {
    try {
        const { to, schoolId: schoolIdParam } = req.query;
        let school = null;

        if (schoolIdParam && mongoose.Types.ObjectId.isValid(schoolIdParam)) {
            school = await School.findById(schoolIdParam).select('name script businessHoursStart businessHoursEnd language routingNumber escalationNumber').lean();
        }
        if (!school && to) {
            const normalizedTo = normalizePhone(to);
            if (normalizedTo) {
                const all = await School.find({}).select('name script businessHoursStart businessHoursEnd language routingNumber escalationNumber aiNumber').lean();
                school = all.find(s => normalizePhone(s.aiNumber) === normalizedTo) || null;
            }
        }

        if (!school) {
            return res.status(404).json({ error: 'School not found for this number. Set aiNumber in Settings.' });
        }

        const formLink = process.env.FORM_BASE_URL
            ? `${process.env.FORM_BASE_URL}/inquiry/${school._id}`
            : `https://enrollmentai.com/inquiry/${school._id}`;

        res.json({
            schoolId: school._id.toString(),
            schoolName: school.name,
            script: school.script || "Hi, thanks for calling our school, this is Nora, a virtual assistant.\nYou can speak in English or Spanish — si prefiere, puede hablar en español. ¿Le puedo ayudar en algo? How can I help you today?",
            businessHoursStart: school.businessHoursStart || '09:00',
            businessHoursEnd: school.businessHoursEnd || '17:00',
            formLink,
            language: school.language || 'EN',
            routingNumber: school.routingNumber || '',
            escalationNumber: school.escalationNumber || '',
        });
    } catch (err) {
        console.error('Agent config error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/voice/current-datetime - No auth. Cartesia get_current_datetime_cst tool: current date/time anchor for the call.
// Query: schoolId=xxx (optional; falls back to America/Chicago when omitted or not found)
router.get('/current-datetime', async (req, res) => {
    try {
        const { schoolId } = req.query;
        let timezone = 'America/Chicago';
        if (schoolId && mongoose.Types.ObjectId.isValid(schoolId)) {
            const school = await School.findById(schoolId).select('timezone').lean();
            if (school?.timezone) timezone = school.timezone;
        }

        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
            weekday: 'long',
        }).formatToParts(now).reduce((acc, part) => {
            acc[part.type] = part.value;
            return acc;
        }, {});

        res.json({
            date: `${parts.year}-${parts.month}-${parts.day}`,
            time: `${parts.hour}:${parts.minute}:${parts.second}`,
            day_of_week: parts.weekday,
            timezone,
            iso: now.toISOString(),
        });
    } catch (err) {
        console.error('Current datetime error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/voice/availability - No auth. Agent calls to get free 30-min slots for a day (respects blocked times, no overlaps).
// Query: schoolId=xxx&date=YYYY-MM-DD
router.get('/availability', async (req, res) => {
    try {
        const { schoolId, date } = req.query;
        if (!schoolId || !date) {
            return res.status(400).json({ error: 'schoolId and date (YYYY-MM-DD) are required' });
        }
        const school = await School.findById(schoolId).select('businessHoursStart businessHoursEnd').lean();
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }
        const { freeSlots, error } = await getFreeSlots(schoolId, date, {
            start: school.businessHoursStart || '09:00',
            end: school.businessHoursEnd || '17:00',
        });
        if (error) {
            return res.status(400).json({ error });
        }
        res.json({ date, freeSlots });
    } catch (err) {
        console.error('Availability error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/voice/booked-slots - No auth. Returns both available and booked slots for a specific date.
// Query: schoolId=xxx&date=YYYY-MM-DD (date is required)
router.get('/booked-slots', async (req, res) => {
    try {
        const { schoolId, date } = req.query;
        
        if (!schoolId) {
            return res.status(400).json({ error: 'schoolId is required' });
        }
        
        if (!date) {
            return res.status(400).json({ error: 'date parameter is required (format: YYYY-MM-DD)' });
        }

        // Validate date format
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(date)) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }

        // Get school with business hours
        const school = await School.findById(schoolId).select('businessHoursStart businessHoursEnd').lean();
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        // Calculate date range for the day
        // Get business-specific UTC range for the date
        const { rangeStart, rangeEnd, error: rangeError } = await getBusinessHoursRange(schoolId, date);
        if (rangeError) {
            return res.status(400).json({ error: rangeError });
        }
        console.log(`[booked-slots] rangeStart: ${rangeStart.toISOString()}, rangeEnd: ${rangeEnd.toISOString()}`);
        console.log(`[booked-slots] rangeStart: ${rangeStart.toISOString()}, rangeEnd: ${rangeEnd.toISOString()}`);

        const businessHours = {
            start: school.businessHoursStart || '09:00',
            end: school.businessHoursEnd || '17:00'
        };

        // Get available slots using the same range logic
        const { freeSlots, error: freeSlotsError } = await getFreeSlots(schoolId, date, businessHours);
        if (freeSlotsError) {
            return res.status(400).json({ error: freeSlotsError });
        }

        // Get booked slots for the SAME window (eliminates irrelevant bookings)
        const { busySlots, error: busySlotsError } = await getBusySlots(schoolId, rangeStart, rangeEnd);
        if (busySlotsError) {
            return res.status(400).json({ error: busySlotsError });
        }

        // Format booked slots
        const bookedSlots = busySlots.map(s => ({
            start: s.start.toISOString(),
            end: s.end.toISOString()
        }));

        res.json({
            schoolId,
            date,
            businessHours,
            availableSlots: freeSlots,
            bookedSlots: bookedSlots
        });
    } catch (err) {
        console.error('Booked slots error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// POST /api/voice/call-end - Called by AI agent when call completes
router.post('/call-end', async (req, res) => {
    try {
        const { schoolId, callerName, callerPhone, callType, duration, recordingUrl, leadData, summary } = req.body;

        if (!schoolId) {
            return res.status(400).json({ error: 'schoolId is required' });
        }

        const school = await School.findById(schoolId).select('name adminEmail emailAutoFollowup emailTemplate').lean();
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const callLog = await CallLog.create({
            schoolId,
            callerName: callerName || 'Unknown',
            callerPhone: callerPhone || '',
            callType: callType || 'inquiry',
            duration: duration || 0,
            recordingUrl: recordingUrl || '',
        });

        const parentName = leadData?.parentName || callerName;
        const phone = leadData?.phone || callerPhone;
        const email = leadData?.email;
        const childAge = leadData?.childAge;
        const childName = leadData?.childName;
        const reason = leadData?.reason;
        const tourScheduledAt = leadData?.tourScheduledAt; // ISO date string if parent booked a tour

        if (callType === 'inquiry' && leadData) {
            await triggerAutomation(schoolId, {
                parentName,
                phone,
                email,
                childAge,
                reason,
            });
        }

        let tourBooking = null;
        let tourError = null;
        if (tourScheduledAt) {
            const start = new Date(tourScheduledAt);
            if (!isNaN(start.getTime())) {
                // Validate that the booking date is not in the past
                const now = new Date();
                if (start < now) {
                    tourError = 'Cannot book a tour for a past date. Please select a future date and time.';
                } else {
                    const end = new Date(start.getTime() + 30 * 60 * 1000); // 30-min block
                    const { available, error: slotError } = await isSlotAvailable(schoolId, start, end);
                    if (!available) {
                        tourError = slotError || 'That time is no longer available or overlaps an existing event.';
                    } else {
                        const title = `School Tour – ${parentName || 'Parent'}`;
                        const calResult = await createCalendarEvent(schoolId, {
                            title,
                            startDateTime: start,
                            endDateTime: end,
                            description: `Tour for ${parentName || 'Parent'}. Phone: ${phone || 'N/A'}. Email: ${email || 'N/A'}. Reason: ${reason || 'Inquiry'}.`,
                            parentEmail: email || null,
                        });
                        tourBooking = await TourBooking.create({
                            schoolId,
                            parentName,
                            phone: phone || '',
                            email: email || '',
                            childName: childName || '',
                            childAge: childAge || '',
                            reason: reason || '',
                            scheduledAt: start,
                            calendarEventId: calResult.success ? calResult.eventId : '',
                            calendarProvider: calResult.success ? calResult.provider : '',
                            calendarEmail: calResult.success ? calResult.email : '',
                            callLogId: callLog._id,
                        });
                    }
                }
            } else {
                // Past date validation failed - tourError already set above
            }
        }

        // Send Admin Summary Email
        if (school && school.adminEmail) {
            const summaryTitle = tourBooking ? `🎉 Tour Booked: ${parentName || 'New Parent'}` : `📞 New Call Summary: ${parentName || 'Parent'}`;
            const summaryBody = `
                <div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; border: 1px solid #eee; padding: 20px; border-radius: 12px;">
                    <h2 style="color: #2563eb; margin-top: 0;">Call Processed Successfully</h2>
                    <p><strong>Caller:</strong> ${parentName || 'Parent'} (${phone || 'N/A'})</p>
                    <p><strong>Contact Info:</strong> ${email || 'N/A'}</p>
                    <p><strong>AI Summary:</strong></p>
                    <blockquote style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 12px; margin: 0; font-style: italic;">
                        "${summary || 'No summary available.'}"
                    </blockquote>
                    ${tourBooking ? `
                        <div style="margin-top: 20px; padding: 15px; background: #ecfdf5; border: 1px solid #10b981; border-radius: 8px;">
                            <p style="color: #047857; font-weight: bold; margin: 0;">✅ Tour scheduled for: ${new Date(tourScheduledAt).toLocaleString()}</p>
                        </div>
                    ` : '<p style="margin-top: 20px; color: #64748b;">No tour was scheduled during this call.</p>'}
                    <hr style="margin: 20px 0; border: 0; border-top: 1px solid #eee;">
                    <p style="font-size: 12px; color: #94a3b8;">This is an automated notification from your Enrollment AI Assistant at ${school.name || 'our school'}.</p>
                </div>
            `;
            
            sendEmail(schoolId, {
                to: school.adminEmail,
                subject: summaryTitle,
                text: `New call from ${parentName || 'Parent'}. Summary: ${summary || 'None'}`,
                html: summaryBody
            }).catch(err => console.error('[Admin Notification] Failed to send email:', err.message));
        }

        res.json({
            success: true,
            callLogId: callLog._id,
            recordingUrl: callLog.recordingUrl || undefined,
            tourBooked: !!tourBooking,
            tourBookingId: tourBooking?._id?.toString(),
            tourError: tourError || undefined,
            message: tourBooking ? 'Tour booked and invite sent' : 'Call summary processed'
        });
    } catch (err) {
        console.error('Voice call-end error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
