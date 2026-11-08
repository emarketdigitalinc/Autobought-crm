// capi.js - telling Meta which leads turned into real dealers.
//
// When a lead reaches Working, and again when it reaches Signed, a CRM event
// goes to Meta's Conversions API, matched on the Meta lead id (Instant Form
// leads) and hashed email + phone (everyone). Meta then optimises delivery
// toward people who become real dealers, not just people who fill in forms.
//
// Built to be the same setup the dealer portal uses: one dataset
// (META_DATASET_ID), one system-user token (META_CAPI_TOKEN), and nothing in
// here specific to the CRM except the event names. The portal can require
// this file as it is.
//
// Each event is queued, sent at once, and retried by the scheduler if Meta
// is unreachable. event_id is fixed per lead and stage, so a retry, or a
// lead moved out of Working and back, never counts twice.

const crypto = require('crypto');
const config = require('./config');
const { db, nowISO, phoneKey, logActivity } = require('./db');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Meta's normalisation rules: lowercase and trimmed; phone as digits with
// the country code; names without punctuation; city with no spaces.
function hashedUserData(lead) {
  const ud = {};
  const email = String(lead.email || '').trim().toLowerCase();
  if (email.includes('@')) ud.em = [sha256(email)];
  const pk = phoneKey(lead.phone);
  if (pk) ud.ph = [sha256(pk.length === 10 ? `1${pk}` : pk)];
  const [first, ...rest] = String(lead.name || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const clean = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  if (first && clean(first)) ud.fn = [sha256(clean(first))];
  if (rest.length && clean(rest[rest.length - 1])) ud.ln = [sha256(clean(rest[rest.length - 1]))];
  const ct = String(lead.city || '').split(',')[0].toLowerCase().replace(/[^a-z]/g, '');
  if (ct) ud.ct = [sha256(ct)];
  if (lead.province && /^[A-Z]{2}$/.test(lead.province)) ud.st = [sha256(lead.province.toLowerCase())];
  ud.country = [sha256('ca')];
  // The lead id is sent as-is (it is Meta's own identifier, not personal data).
  if (lead.meta_lead_id && /^\d+$/.test(lead.meta_lead_id)) ud.lead_id = Number(lead.meta_lead_id);
  return ud;
}

function buildEvent(lead, stage, eventName, eventId, eventTime) {
  return {
    event_name: eventName,
    event_time: eventTime,
    event_id: eventId,
    action_source: 'system_generated',
    user_data: hashedUserData(lead),
    custom_data: {
      event_source: 'crm',
      lead_event_source: 'Autobought CRM',
      stage,
      lead_source: lead.source === 'A' ? 'instant_form' : 'landing_page',
    },
  };
}

// Queue the event for this lead and stage (once ever) and try to send it.
async function trackStage(lead, stage) {
  const name = config.capiEventNames()[stage];
  if (!name) return null;
  const eventId = `abcrm_${lead.id}_${stage}`;
  const exists = db.prepare('SELECT * FROM capi_events WHERE event_id = ?').get(eventId);
  if (exists) return exists;
  db.prepare('INSERT INTO capi_events (lead_id, stage, event_name, event_id, event_time, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(lead.id, stage, name, eventId, Math.floor(Date.now() / 1000), nowISO());
  return sendQueued(db.prepare('SELECT * FROM capi_events WHERE event_id = ?').get(eventId));
}

async function sendQueued(ev) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(ev.lead_id);
  if (!config.capiDatasetId() || !config.capiToken()) {
    db.prepare("UPDATE capi_events SET status = 'skipped', last_error = ? WHERE id = ?")
      .run('META_DATASET_ID / META_CAPI_TOKEN not set.', ev.id);
    logActivity(lead.id, 'capi', `${ev.event_name} not sent to Meta: Conversions API is not configured.`);
    return { ...ev, status: 'skipped' };
  }
  const body = { data: [buildEvent(lead, ev.stage, ev.event_name, ev.event_id, ev.event_time)] };
  if (config.capiTestCode()) body.test_event_code = config.capiTestCode();
  db.prepare('UPDATE capi_events SET attempts = attempts + 1 WHERE id = ?').run(ev.id);
  try {
    const res = await fetch(
      `https://graph.facebook.com/${config.metaApiVersion()}/${config.capiDatasetId()}/events?access_token=${encodeURIComponent(config.capiToken())}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json.error && json.error.message) || `HTTP ${res.status}`);
    db.prepare("UPDATE capi_events SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?").run(nowISO(), ev.id);
    logActivity(lead.id, 'capi', `Sent "${ev.event_name}" to Meta${lead.meta_lead_id ? ' (matched on Meta lead id + hashed email/phone)' : ' (matched on hashed email/phone)'}.`);
    return { ...ev, status: 'sent' };
  } catch (err) {
    const failed = ev.attempts + 1 >= 8;
    db.prepare('UPDATE capi_events SET status = ?, last_error = ? WHERE id = ?').run(failed ? 'failed' : 'pending', err.message, ev.id);
    if (failed) logActivity(lead.id, 'capi', `Gave up sending "${ev.event_name}" to Meta: ${err.message}`);
    return { ...ev, status: failed ? 'failed' : 'pending', last_error: err.message };
  }
}

async function retryPending() {
  const rows = db.prepare("SELECT * FROM capi_events WHERE status = 'pending' AND attempts > 0 ORDER BY id LIMIT 50").all();
  for (const ev of rows) await sendQueued(ev);
  return rows.length;
}

module.exports = { trackStage, sendQueued, retryPending, hashedUserData, buildEvent, sha256 };
