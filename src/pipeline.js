// pipeline.js - moving a lead through New -> Contacted -> Working -> Signed / Lost,
// and the speed-to-lead clock.

const { db, nowISO, logActivity, STAGES, STAGE_LABELS, LOST_REASONS, CONTACT_ACTIVITY } = require('./db');
const capi = require('./capi');
const deals = require('./deals');

const getLead = (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

// The first time anyone reaches the person. Moving past New counts too, for
// a call made from a personal phone and never logged.
function markFirstContact(lead, at = nowISO()) {
  if (lead.first_contact_at) return false;
  db.prepare('UPDATE leads SET first_contact_at = ? WHERE id = ? AND first_contact_at IS NULL').run(at, lead.id);
  const mins = minutesBetween(lead.created_at, at);
  logActivity(lead.id, 'system', `First contact, ${formatMinutes(mins)} after the lead came in.`, null, at);
  return true;
}

function minutesBetween(from, to) {
  if (!from || !to) return null;
  return Math.max(0, Math.round((new Date(to) - new Date(from)) / 60000));
}
function formatMinutes(m) {
  if (m === null || m === undefined) return '—';
  if (m < 60) return `${m} min`;
  if (m < 60 * 48) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${Math.round(m / 1440)} days`;
}

// A call, text, email or note. Contact types start the speed-to-lead clock;
// a call or text from New also moves the lead to Contacted.
function addActivity(leadId, { type, body }, actor) {
  const lead = getLead(leadId);
  if (!lead) return { error: 'Lead not found.' };
  const allowed = ['note', ...CONTACT_ACTIVITY];
  if (!allowed.includes(type)) return { error: `Activity must be one of: ${allowed.join(', ')}` };
  const text = String(body || '').trim();
  if (type === 'note' && !text) return { error: 'Write the note first.' };
  const label = { call: 'Called', text: 'Texted', email: 'Emailed' }[type];
  logActivity(lead.id, type, label ? `${label}${text ? `: ${text}` : '.'}` : text, actor && actor.id);
  if (CONTACT_ACTIVITY.includes(type)) {
    markFirstContact(lead);
    if (lead.stage === 'new') setStageRow(lead, 'contacted', actor, null);
  }
  return { lead: getLead(lead.id) };
}

function setStageRow(lead, stage, actor, lostReason) {
  const now = nowISO();
  const sets = { stage, stage_changed_at: now, lost_reason: stage === 'lost' ? lostReason : null };
  if ((stage === 'working' || stage === 'signed') && !lead.reached_working_at) sets.reached_working_at = now;
  if (stage === 'signed' && !lead.signed_at) sets.signed_at = now;
  const keys = Object.keys(sets);
  db.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => sets[k]), lead.id);
  logActivity(lead.id, 'stage', `${STAGE_LABELS[lead.stage]} → ${STAGE_LABELS[stage]}${stage === 'lost' ? ` (${lostReason})` : ''}`, actor && actor.id, now);
}

// Returns { lead, deal? } or { error, status }.
async function changeStage(leadId, { stage, lost_reason, note, deal: dealInput }, actor) {
  const lead = getLead(leadId);
  if (!lead) return { error: 'Lead not found.', status: 404 };
  if (!STAGES.includes(stage)) return { error: `Stage must be one of: ${STAGES.join(', ')}`, status: 400 };

  let reason = null;
  if (stage === 'lost') {
    if (!LOST_REASONS.includes(lost_reason)) return { error: `Choose why it was lost: ${LOST_REASONS.join(', ')}.`, status: 400 };
    if (lost_reason === 'Other' && !String(note || '').trim()) return { error: 'Say what "Other" was.', status: 400 };
    reason = lost_reason;
  }

  let dealParts = null;
  if (stage === 'signed') {
    const checked = deals.validateDealInput(dealInput, lead);
    if (checked.error) return { error: checked.error, status: 400 };
    dealParts = checked;
  }
  if (stage === lead.stage && stage !== 'signed') return { lead };

  // Leaving Signed ends the deal; the lead bank dealer is left as it is.
  if (lead.stage === 'signed' && stage !== 'signed') {
    const d = deals.dealForLead(lead.id);
    if (d && d.status !== 'cancelled') {
      deals.updateDeal(d.id, { status: 'cancelled' }, actor && actor.id);
      logActivity(lead.id, 'system', 'Deal cancelled because the lead left Signed. The dealer in the lead bank was not paused: do that there if they should stop receiving leads.', actor && actor.id);
    }
  }

  if (stage !== 'new' && stage !== 'lost') markFirstContact(lead);
  if (stage !== lead.stage) setStageRow(lead, stage, actor, reason);
  if (note && String(note).trim()) logActivity(lead.id, 'note', String(note).trim(), actor && actor.id);

  const fresh = getLead(lead.id);
  const result = { lead: fresh };

  if (stage === 'working' || stage === 'signed') {
    // Signed implies Working, so a lead that skipped it still teaches Meta both.
    if (stage === 'signed') await capi.trackStage(fresh, 'working');
    await capi.trackStage(fresh, stage);
  }
  if (stage === 'signed') {
    const d = deals.saveDeal(fresh, dealParts);
    logActivity(lead.id, 'system', `Signed: ${d.dealer_name}, ${d.leads_per_month} leads/month at $${d.price_per_lead}/lead ($${d.monthly_value}/month).`, actor && actor.id);
    result.deal = await deals.runHandoff(d.id, actor && actor.id);
  }
  result.lead = getLead(lead.id);
  return result;
}

module.exports = { changeStage, addActivity, markFirstContact, minutesBetween, formatMinutes, getLead };
