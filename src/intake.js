// intake.js - "a dealer lead just came in".
//
// Every delivery is written to the inbox first, then processed:
//   1. Read it into one shape (sources.js).
//   2. Shopper on a dealer form? Hand them to the lead bank's consumer
//      funnel and stop: they never become a dealer lead.
//   3. Same phone or email as an existing lead? Merge into it.
//   4. Otherwise create the lead, work out which ad it came from, text +
//      email whoever takes new leads, then put it on the map.

const crypto = require('crypto');
const { db, nowISO, phoneKey, emailKey, logActivity } = require('./db');
const sources = require('./sources');
const { isShopperRole, categoriesFrom } = require('./fields');
const { knownPlace, placeLead, provinceCode } = require('./geo');
const { alertNewLead } = require('./notify');
const config = require('./config');

const MAX_ATTEMPTS = 6;

// Store first. Returns the inbox row, or the earlier one if this exact
// delivery was already received (Meta and Jotform both retry).
function receive(kind, payload, externalId = null) {
  const ext = externalId ? String(externalId) : null;
  if (ext) {
    const earlier = db.prepare('SELECT * FROM inbox WHERE kind = ? AND external_id = ?').get(kind, ext);
    if (earlier) return { row: earlier, repeat: true };
  }
  const info = db.prepare('INSERT INTO inbox (kind, external_id, payload, received_at) VALUES (?, ?, ?, ?)')
    .run(kind, ext, JSON.stringify(payload), nowISO());
  return { row: db.prepare('SELECT * FROM inbox WHERE id = ?').get(info.lastInsertRowid), repeat: false };
}

async function toSubmission(row) {
  const payload = JSON.parse(row.payload);
  if (row.kind === 'meta') return sources.fromMetaLead(await sources.fetchMetaLead(payload.leadgen_id), payload);
  if (row.kind === 'jotform') return sources.fromJotform(payload);
  return sources.fromFlat(payload);
}

async function processInbox(row) {
  db.prepare('UPDATE inbox SET attempts = attempts + 1 WHERE id = ?').run(row.id);
  try {
    const sub = await toSubmission(row);
    const result = await handleSubmission(sub, row.id);
    db.prepare("UPDATE inbox SET status = 'done', outcome = ?, lead_id = ?, error = NULL, processed_at = ? WHERE id = ?")
      .run(result.outcome, result.lead ? result.lead.id : null, nowISO(), row.id);
    return result;
  } catch (err) {
    const attempts = row.attempts + 1;
    db.prepare('UPDATE inbox SET status = ?, error = ? WHERE id = ?')
      .run(attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', err.message, row.id);
    console.error(`[intake] inbox ${row.id} (${row.kind}) failed: ${err.message}`);
    return { outcome: 'error', error: err.message };
  }
}

// Deliveries that failed (Meta down, a token expired) are tried again.
async function retryPending() {
  // attempts = 0 and a few minutes old: received, then the app restarted
  // before it was processed.
  const stale = new Date(Date.now() - 3 * 60000).toISOString();
  const rows = db.prepare(
    "SELECT * FROM inbox WHERE status = 'pending' AND (attempts > 0 OR received_at < ?) AND attempts < ? ORDER BY id LIMIT 20"
  ).all(stale, MAX_ATTEMPTS);
  for (const row of rows) await processInbox(row);
  return rows.length;
}

// --- The decision ----------------------------------------------------------

async function handleSubmission(sub, inboxId = null) {
  const f = sub.fields;
  if (isShopperRole(f.role)) {
    const forward = await forwardConsumer(sub, inboxId);
    return { outcome: 'consumer', forward };
  }

  const existing = findExisting(f.phone, f.email);
  if (existing) {
    const lead = mergeInto(existing, sub);
    const alerts = await alertNewLead(lead, { repeat: true });
    logAlerts(lead.id, alerts);
    if (lead.lat === null) await placeLead(lead.id);
    return { outcome: 'merged', lead: refetch(lead.id) };
  }

  // Alert first: speed to lead matters more than the map pin.
  const lead = createLead(sub);
  const alerts = await alertNewLead(lead);
  logAlerts(lead.id, alerts);
  if (lead.lat === null) await placeLead(lead.id);
  return { outcome: 'new', lead: refetch(lead.id) };
}

const refetch = (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

function findExisting(phone, email) {
  const pk = phoneKey(phone);
  const ek = emailKey(email);
  if (!pk && !ek) return null;
  return db.prepare(
    `SELECT * FROM leads WHERE (phone_key = ? AND ? IS NOT NULL) OR (email_key = ? AND ? IS NOT NULL)
      ORDER BY created_at ASC LIMIT 1`
  ).get(pk, pk, ek, ek);
}

const LEAD_COLUMNS = [
  'name', 'phone', 'email', 'city', 'province', 'dealership', 'role', 'sells', 'leads_wanted', 'leads_wanted_n',
  'website', 'message',
];
const ATTR_COLUMNS = [
  'meta_lead_id', 'form_id', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid',
];

function rowFrom(sub) {
  const f = sub.fields;
  const row = {};
  for (const c of LEAD_COLUMNS) if (f[c] !== undefined && f[c] !== null && f[c] !== '') row[c] = f[c];
  for (const c of ATTR_COLUMNS) {
    const v = sub.attribution[c] !== undefined ? sub.attribution[c] : f[c];
    if (v) row[c] = String(v);
  }
  if (row.province) row.province = normaliseProvince(row.province);
  const cats = categoriesFrom(`${f.sells || ''} ${f.dealership || ''}`);
  if (cats.length) row.categories = cats.join(',');
  return row;
}

function createLead(sub) {
  const id = crypto.randomUUID();
  const row = rowFrom(sub);
  Object.assign(row, resolveAd(row));
  // Known towns are placed at once; anything else is geocoded after the alert.
  const place = knownPlace(row.city, row.province);
  const owner = defaultOwner();
  const now = nowISO();
  const record = {
    id, ...row,
    phone_key: phoneKey(row.phone), email_key: emailKey(row.email),
    lat: place ? place.lat : null,
    lng: place ? place.lng : null,
    province: row.province || (place ? place.province : null),
    source: sub.source,
    created_at: sub.created_at || now,
    received_at: now,
    stage: 'new', stage_changed_at: now,
    owner_id: owner ? owner.id : null,
    last_activity_at: now,
  };
  const cols = Object.keys(record);
  db.prepare(`INSERT INTO leads (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => record[c]));
  logActivity(id, 'submission', describeSubmission(sub), null, now);
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
}

// A second submission fills in what we did not know; it never overwrites
// what we did, and the first touch keeps the source and ad credit.
function mergeInto(lead, sub) {
  const row = rowFrom(sub);
  const sets = {};
  for (const [k, v] of Object.entries(row)) if (lead[k] === null || lead[k] === undefined || lead[k] === '') sets[k] = v;
  if (sets.phone) sets.phone_key = phoneKey(sets.phone);
  if (sets.email) sets.email_key = emailKey(sets.email);
  if (lead.lat === null && (sets.city || lead.city)) {
    const p = knownPlace(sets.city || lead.city, sets.province || lead.province);
    if (p) Object.assign(sets, { lat: p.lat, lng: p.lng });
  }
  const keys = Object.keys(sets);
  db.prepare(`UPDATE leads SET ${[...keys.map((k) => `${k} = ?`), 'submissions = submissions + 1'].join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => sets[k]), lead.id);
  logActivity(lead.id, 'submission', `Submitted again. ${describeSubmission(sub)}`);
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
}

function describeSubmission(sub) {
  const a = sub.attribution;
  const via = sub.source === 'A' ? 'Meta Instant Form' : 'autobought.ca/dealers';
  const ad = [a.campaign_name, a.adset_name, a.ad_name].filter(Boolean).join(' › ');
  const utm = ['utm_source', 'utm_campaign', 'utm_content'].map((k) => sub.fields[k] || a[k]).filter(Boolean).join(' / ');
  return `Source ${sub.source} (${via})${ad ? `: ${ad}` : ''}${!ad && utm ? `: ${utm}` : ''}.`;
}

function logAlerts(leadId, results) {
  if (!results.length) {
    logActivity(leadId, 'notify', 'Nobody has "text me new leads" switched on, so no one was alerted.');
    return;
  }
  const line = results.map((r) => `${r.channel} to ${r.to}: ${r.sent ? 'sent' : r.simulated ? 'simulated' : `not sent (${r.error || r.detail})`}`);
  logActivity(leadId, 'notify', line.join('; '));
}

// New leads belong to whoever takes them (Mike), or the first admin.
function defaultOwner() {
  return db.prepare("SELECT id FROM users WHERE active = 1 AND notify_new_leads = 1 ORDER BY created_at LIMIT 1").get()
    || db.prepare("SELECT id FROM users WHERE active = 1 ORDER BY role = 'admin' DESC, created_at LIMIT 1").get()
    || null;
}

// Landing-page leads name their ad only through UTMs. Match them against
// the ads synced from Meta: the ad's id or name in utm_content, the ad
// set's in utm_term, the campaign's in utm_campaign.
function resolveAd(row) {
  if (row.ad_id) return {};
  const out = {};
  const like = (v) => String(v || '').trim().toLowerCase();
  const find = (sql, v) => (v ? db.prepare(sql).get(like(v), like(v)) : null);
  const ad = find('SELECT * FROM ads WHERE ad_id = ? OR lower(ad_name) = ? LIMIT 1', row.utm_content)
    || find('SELECT * FROM ads WHERE ad_id = ? OR lower(ad_name) = ? LIMIT 1', row.utm_term);
  if (ad) {
    Object.assign(out, {
      ad_id: ad.ad_id, ad_name: ad.ad_name, adset_id: ad.adset_id, adset_name: ad.adset_name,
      campaign_id: ad.campaign_id, campaign_name: ad.campaign_name,
    });
    return out;
  }
  const set = find('SELECT * FROM ads WHERE adset_id = ? OR lower(adset_name) = ? LIMIT 1', row.utm_term);
  if (set && !row.adset_id) Object.assign(out, { adset_id: set.adset_id, adset_name: set.adset_name });
  const camp = find('SELECT * FROM ads WHERE campaign_id = ? OR lower(campaign_name) = ? LIMIT 1', row.utm_campaign);
  if (camp && !row.campaign_id) Object.assign(out, { campaign_id: camp.campaign_id, campaign_name: camp.campaign_name });
  return out;
}

// After an ad sync, landing-page leads that arrived before their ad was
// known can be credited properly.
function backfillAdAttribution() {
  const rows = db.prepare("SELECT * FROM leads WHERE ad_id IS NULL AND (utm_content IS NOT NULL OR utm_term IS NOT NULL OR utm_campaign IS NOT NULL)").all();
  let n = 0;
  for (const lead of rows) {
    const found = resolveAd(lead);
    const keys = Object.keys(found).filter((k) => !lead[k]);
    if (!keys.length) continue;
    db.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => found[k]), lead.id);
    n += 1;
  }
  return n;
}

function normaliseProvince(value) {
  return provinceCode(value) || String(value || '').trim().slice(0, 40) || null;
}

// --- Shoppers ----------------------------------------------------------------

// Someone shopping for a vehicle filled in the dealer form. They are a
// consumer lead, so they go to the lead bank's consumer funnel, which sells
// them to a dealer like any other.
async function forwardConsumer(sub, inboxId) {
  const f = sub.fields;
  const record = (status, detail) => {
    db.prepare(
      'INSERT INTO consumer_forwards (inbox_id, source, name, phone, email, city, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(inboxId, sub.source, f.name || null, f.phone || null, f.email || null, f.city || null, status, detail, nowISO());
    return { status, detail };
  };
  const url = config.leadBankUrl();
  if (!url || !config.consumerFunnelId()) {
    return record('skipped', 'LEADBANK_URL or CONSUMER_FUNNEL_ID not set; kept here only.');
  }
  const body = {
    funnel_id: config.consumerFunnelId(),
    source_ref: `crm:${sub.source}:${sub.external_id || crypto.randomUUID()}`,
    name: f.name, phone: f.phone, email: f.email, city: f.city, province: f.province,
    message: f.message, 'Came in through': sub.source === 'A' ? 'Dealer Instant Form' : 'autobought.ca/dealers',
  };
  const headers = { 'Content-Type': 'application/json' };
  if (config.leadBankWebhookSecret()) headers['x-webhook-secret'] = config.leadBankWebhookSecret();
  const res = await fetch(`${url}/api/webhook/lead`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  // Thrown, so the inbox keeps the delivery and tries again.
  if (!res.ok) throw new Error(`Lead bank refused the consumer lead: ${json.error || res.status}`);
  return record('sent', json.lead ? `Lead bank lead ${json.lead.id}` : 'sent');
}

module.exports = {
  receive, processInbox, retryPending, handleSubmission, findExisting, resolveAd, backfillAdAttribution,
  defaultOwner,
};
