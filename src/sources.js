// sources.js - reading a submission from each door into one shape:
//
//   { source: 'A'|'B', external_id, created_at, fields, attribution, raw }
//
//   A  Meta Instant Form. Meta's webhook only says "lead 123 exists"; the
//      answers and the campaign / ad set / ad are fetched from the Graph API.
//   B  The autobought.ca/dealers landing page, a Jotform form posting its
//      own webhook. Campaign and ad come from UTM hidden fields.
//   flat  Anything already tidy (Zapier, a test, a backfill): plain fields.

const crypto = require('crypto');
const config = require('./config');
const { mapFields } = require('./fields');

const ATTRIBUTION_KEYS = [
  'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name', 'form_id',
];

// --- Meta ------------------------------------------------------------------

// Meta signs every webhook body with the app secret. Without the secret set
// we accept unsigned deliveries (local testing) and say so at start-up.
function verifyMetaSignature(rawBody, header) {
  const secret = config.metaAppSecret();
  if (!secret) return true;
  if (!header || !rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// One webhook can carry several leads. Returns [{ leadgen_id, form_id, ad_id, created_time }].
function leadgenChanges(body) {
  const out = [];
  for (const entry of (body && body.entry) || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen' || !change.value || !change.value.leadgen_id) continue;
      out.push({ ...change.value, leadgen_id: String(change.value.leadgen_id) });
    }
  }
  return out;
}

const LEAD_FIELDS = 'id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic,platform';

async function fetchMetaLead(leadgenId) {
  const token = config.metaPageToken();
  if (!token) throw new Error('META_PAGE_TOKEN is not set, so the lead details cannot be read from Meta.');
  const url = `https://graph.facebook.com/${config.metaApiVersion()}/${encodeURIComponent(leadgenId)}`
    + `?fields=${LEAD_FIELDS}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta refused the lead lookup: ${(json.error && json.error.message) || res.status}`);
  return json;
}

// A lead as the Graph API returns it -> our shape.
function fromMetaLead(lead, hint = {}) {
  const entries = (lead.field_data || []).map((f) => [f.name, (f.values || []).join(', ')]);
  const attribution = { meta_lead_id: String(lead.id || hint.leadgen_id) };
  for (const k of ATTRIBUTION_KEYS) {
    const v = lead[k] || (k === 'adset_id' ? hint.adgroup_id : hint[k]);
    if (v) attribution[k] = String(v);
  }
  return {
    source: 'A',
    external_id: attribution.meta_lead_id,
    created_at: toISO(lead.created_time || hint.created_time),
    fields: mapFields(entries),
    attribution,
    raw: lead,
  };
}

// --- Jotform ---------------------------------------------------------------

// Jotform's webhook posts multipart fields; the answers are one JSON string
// (rawRequest) keyed like "q7_whatDo". `pretty` holds the real question
// labels ("What do you sell?:Cars, Trucks"); both are read.
function prettyEntries(pretty) {
  if (!pretty) return [];
  return String(pretty)
    .split(/,\s*(?=[^,:]{2,80}:)/)
    .map((pair) => {
      const i = pair.indexOf(':');
      return i > 0 ? [pair.slice(0, i).trim(), pair.slice(i + 1).trim()] : null;
    })
    .filter(Boolean);
}

function fromJotform(body) {
  let answers = {};
  try { answers = JSON.parse(body.rawRequest || '{}'); } catch (e) { answers = {}; }
  const rawEntries = Object.entries(answers).filter(([k]) => /^q\d+_/.test(k));
  // Structured answers first: they're exact. The pretty labels fill in any
  // field whose generated name we don't recognise. (Pretty text can't be split
  // reliably when a question's own label contains commas, e.g. a consent line.)
  const fields = mapFields([...rawEntries, ...prettyEntries(body.pretty)]);

  // Hidden fields carry the UTMs, and sometimes the Meta ids if the ad's URL
  // passes {{campaign.id}} etc. Read any we recognise.
  const attribution = {};
  for (const [k, v] of rawEntries) {
    const key = k.replace(/^q\d+_/, '').toLowerCase();
    const val = typeof v === 'string' ? v.trim() : '';
    if (!val) continue;
    for (const a of ATTRIBUTION_KEYS) if (key === a || key === a.replace('_', '')) attribution[a] = val;
  }
  return {
    source: 'B',
    external_id: body.submissionID ? String(body.submissionID) : null,
    created_at: new Date().toISOString(),
    fields,
    attribution,
    raw: { formID: body.formID, submissionID: body.submissionID, pretty: body.pretty, answers },
  };
}

// --- Flat ------------------------------------------------------------------

function fromFlat(body) {
  const source = String(body.source || '').toUpperCase() === 'A' ? 'A' : 'B';
  const entries = Object.entries(body).filter(([k]) => !['source', 'secret', 'external_id', 'created_time'].includes(k));
  const attribution = {};
  for (const k of [...ATTRIBUTION_KEYS, 'meta_lead_id']) if (body[k]) attribution[k] = String(body[k]);
  if (!attribution.meta_lead_id && body.leadgen_id) attribution.meta_lead_id = String(body.leadgen_id);
  return {
    source,
    external_id: body.external_id ? String(body.external_id) : attribution.meta_lead_id || null,
    created_at: toISO(body.created_time),
    fields: mapFields(entries),
    attribution,
    raw: body,
  };
}

function toISO(value) {
  if (!value) return new Date().toISOString();
  const n = Number(value);
  // Meta sends unix seconds in webhooks and ISO strings ("+0000") from the API.
  const d = Number.isFinite(n) && n > 1e9 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(value).replace(/\+0000$/, 'Z'));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

module.exports = { verifyMetaSignature, leadgenChanges, fetchMetaLead, fromMetaLead, fromJotform, fromFlat, prettyEntries, toISO };
