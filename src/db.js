// db.js - where the CRM keeps everything, and the vocabulary the rest agrees on.
//
// One SQLite file, the same choice the lead bank made: at our size it is fast,
// and a backup is a copy of one file. DATA_DIR must point at a permanent disk
// on Railway or every deploy starts from empty.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (DATA_DIR !== ':memory:' && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = DATA_DIR === ':memory:' ? ':memory:' : path.join(DATA_DIR, 'crm.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Vocabulary ----------------------------------------------------------

const STAGES = ['new', 'contacted', 'working', 'signed', 'lost'];
const STAGE_LABELS = { new: 'New', contacted: 'Contacted', working: 'Working', signed: 'Signed', lost: 'Lost' };

const LOST_REASONS = [
  'Not a dealer',
  'Wrong person',
  'Not interested',
  'Went with competitor',
  'No response',
  'Other',
];

// What a dealership can sign for. The lead bank splits RV and trailers into
// their own categories; LEADBANK_CATEGORY_MAP says how ours map onto theirs.
const CATEGORIES = ['automotive', 'powersport', 'rv_marine'];
const CATEGORY_LABELS = { automotive: 'Automotive', powersport: 'Powersport', rv_marine: 'RV/Marine' };

const PACKAGES = ['essential', 'application'];
const PACKAGE_LABELS = { essential: 'Essential', application: 'Application' };

const DEAL_STATUSES = ['active', 'paused', 'cancelled'];

// A = Meta Instant Form, B = the autobought.ca/dealers landing page (Jotform).
const SOURCES = { A: 'Instant Form', B: 'Landing page' };

// Activity types that count as reaching the person. The first one sets the
// lead's first-contact time, which is what speed-to-lead is measured on.
const CONTACT_ACTIVITY = ['call', 'text', 'email'];

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'rep',          -- admin | rep
    phone TEXT,                                -- for new-lead texts
    commission_rate REAL NOT NULL DEFAULT 0,   -- 0.20 = 20%
    notify_new_leads INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  -- Every webhook delivery, stored BEFORE it is processed. If processing
  -- fails (Meta's API is down, a bug), the delivery is still here and the
  -- scheduler retries it. A lead is never lost to a bad minute.
  CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,                        -- meta | jotform | flat
    external_id TEXT,                          -- leadgen id / submission id
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',    -- pending | done | failed
    outcome TEXT,                              -- new | merged | consumer | ignored
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    lead_id TEXT,
    received_at TEXT NOT NULL,
    processed_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_external ON inbox(kind, external_id) WHERE external_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status);

  CREATE TABLE IF NOT EXISTS markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    province TEXT NOT NULL,
    aliases TEXT,                              -- comma separated, e.g. "Sherwood Park, St. Albert"
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(name, province)
  );

  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT,
    phone_key TEXT,
    email TEXT,
    email_key TEXT,
    city TEXT,
    province TEXT,
    dealership TEXT,
    role TEXT,
    sells TEXT,
    categories TEXT,                           -- ours, comma separated, read from "what they sell"
    leads_wanted TEXT,
    leads_wanted_n INTEGER,
    website TEXT,
    message TEXT,
    market_id INTEGER REFERENCES markets(id),

    source TEXT NOT NULL,                      -- A | B
    meta_lead_id TEXT,
    form_id TEXT,
    campaign_id TEXT, campaign_name TEXT,
    adset_id TEXT, adset_name TEXT,
    ad_id TEXT, ad_name TEXT,
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
    fbclid TEXT,

    created_at TEXT NOT NULL,                  -- when they submitted (the source's own time)
    received_at TEXT NOT NULL,                 -- when it reached us
    submissions INTEGER NOT NULL DEFAULT 1,

    stage TEXT NOT NULL DEFAULT 'new',
    stage_changed_at TEXT,
    lost_reason TEXT,
    owner_id TEXT REFERENCES users(id),
    first_contact_at TEXT,
    reached_working_at TEXT,
    signed_at TEXT,
    last_activity_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone_key);
  CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email_key);
  CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage, created_at);
  CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
  CREATE INDEX IF NOT EXISTS idx_leads_ad ON leads(ad_id);

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id TEXT NOT NULL REFERENCES leads(id),
    type TEXT NOT NULL,                        -- note | call | text | email | stage | submission | notify | capi | handoff | system
    body TEXT,
    actor_id TEXT REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id, created_at);

  -- Shoppers who picked "I'm shopping for a vehicle" on a dealer form.
  -- Never a dealer lead; handed to the lead bank's consumer funnel instead.
  CREATE TABLE IF NOT EXISTS consumer_forwards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id INTEGER REFERENCES inbox(id),
    source TEXT,
    name TEXT, phone TEXT, email TEXT, city TEXT,
    status TEXT NOT NULL,                      -- sent | failed | skipped
    detail TEXT,
    created_at TEXT NOT NULL
  );

  -- What each ad is, from the Marketing API. destination_type tells an
  -- Instant Form ad set (ON_AD) from a website one, which is how spend is
  -- split between A and B. source_override is for when that guess is wrong.
  CREATE TABLE IF NOT EXISTS ads (
    ad_id TEXT PRIMARY KEY,
    ad_name TEXT,
    adset_id TEXT, adset_name TEXT,
    campaign_id TEXT, campaign_name TEXT,
    destination_type TEXT,
    source_override TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS ad_spend (
    date TEXT NOT NULL,                        -- YYYY-MM-DD, ad account time zone
    ad_id TEXT NOT NULL,
    campaign_id TEXT, campaign_name TEXT,
    adset_id TEXT, adset_name TEXT,
    ad_name TEXT,
    spend REAL NOT NULL DEFAULT 0,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL,
    PRIMARY KEY (date, ad_id)
  );

  -- Outcomes sent back to Meta. event_id is fixed per lead and event, so a
  -- retry (or Meta seeing it twice) never counts twice.
  CREATE TABLE IF NOT EXISTS capi_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id TEXT NOT NULL REFERENCES leads(id),
    stage TEXT NOT NULL,
    event_name TEXT NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    event_time INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',    -- pending | sent | failed | skipped
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );

  -- A signed dealer.
  CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id),
    dealer_name TEXT NOT NULL,
    package TEXT NOT NULL,                     -- essential | application
    leads_per_month INTEGER NOT NULL,
    price_per_lead REAL NOT NULL,
    monthly_value REAL NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    account_manager_id TEXT REFERENCES users(id),
    commission_rate REAL NOT NULL DEFAULT 0,   -- snapshot at signing, editable
    distribution_mode TEXT NOT NULL DEFAULT 'shared',
    portal_email TEXT NOT NULL,

    lb_dealer_id TEXT,
    lb_user_id TEXT,
    handoff_status TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed | skipped
    handoff_error TEXT,
    welcome_sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS deal_quotas (
    deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    monthly_quota INTEGER NOT NULL,
    PRIMARY KEY (deal_id, category)
  );

  CREATE TABLE IF NOT EXISTS deal_markets (
    deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    market_id INTEGER NOT NULL REFERENCES markets(id),
    PRIMARY KEY (deal_id, market_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Starter markets: the cities dealers actually ask about. Only seeded into an
// empty table, and fully editable on the market map afterwards.
const STARTER_MARKETS = [
  ['Calgary', 'AB', 'Airdrie, Cochrane, Chestermere, Okotoks'],
  ['Edmonton', 'AB', 'Sherwood Park, St. Albert, Spruce Grove, Leduc, Fort Saskatchewan'],
  ['Red Deer', 'AB', 'Lacombe, Sylvan Lake, Innisfail'],
  ['Lethbridge', 'AB', 'Taber, Coaldale'],
  ['Medicine Hat', 'AB', 'Brooks'],
  ['Grande Prairie', 'AB', ''],
  ['Fort McMurray', 'AB', 'Wood Buffalo'],
  ['Lloydminster', 'AB', ''],
  ['Saskatoon', 'SK', 'Martensville, Warman'],
  ['Regina', 'SK', 'Moose Jaw'],
  ['Winnipeg', 'MB', 'Steinbach, Selkirk'],
  ['Vancouver', 'BC', 'Surrey, Burnaby, Richmond, Coquitlam, Langley, Abbotsford'],
  ['Kelowna', 'BC', 'Vernon, Penticton, West Kelowna'],
  ['Kamloops', 'BC', ''],
  ['Prince George', 'BC', ''],
  ['Toronto', 'ON', 'Mississauga, Brampton, Vaughan, Markham, Scarborough, Etobicoke'],
  ['Ottawa', 'ON', 'Kanata, Gatineau'],
  ['Hamilton', 'ON', 'Burlington, Stoney Creek'],
  ['London', 'ON', ''],
  ['Halifax', 'NS', 'Dartmouth'],
];
if (db.prepare('SELECT COUNT(*) AS n FROM markets').get().n === 0) {
  const ins = db.prepare('INSERT INTO markets (name, province, aliases) VALUES (?, ?, ?)');
  db.transaction(() => STARTER_MARKETS.forEach((m) => ins.run(...m)))();
}

// --- Small shared helpers -------------------------------------------------

const nowISO = () => new Date().toISOString();

// Digits only, without the North American leading 1, so "(780) 555-0142"
// and "+1 780-555-0142" are recognised as the same person.
function phoneKey(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (digits.length < 7) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function emailKey(value) {
  const s = String(value || '').trim().toLowerCase();
  return s.includes('@') ? s : null;
}

// +1XXXXXXXXXX for a ten-digit North American number, for tel: links and SMS.
function e164(value) {
  const key = phoneKey(value);
  if (!key) return null;
  if (key.length === 10) return `+1${key}`;
  return `+${key}`;
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value === null || value === undefined ? null : String(value));
}

function logActivity(leadId, type, body, actorId = null, at = nowISO()) {
  db.prepare('INSERT INTO activities (lead_id, type, body, actor_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(leadId, type, body || null, actorId, at);
  db.prepare('UPDATE leads SET last_activity_at = ? WHERE id = ?').run(at, leadId);
}

module.exports = {
  db, DB_PATH, nowISO, phoneKey, emailKey, e164, getSetting, setSetting, logActivity,
  STAGES, STAGE_LABELS, LOST_REASONS, CATEGORIES, CATEGORY_LABELS,
  PACKAGES, PACKAGE_LABELS, DEAL_STATUSES, SOURCES, CONTACT_ACTIVITY,
};
