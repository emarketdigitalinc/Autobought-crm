// routes/api.js - everything the CRM screens ask for. Signed-in staff only.

const express = require('express');
const {
  db, nowISO, logActivity, STAGES, STAGE_LABELS, LOST_REASONS, CATEGORIES, CATEGORY_LABELS,
  PACKAGES, PACKAGE_LABELS, SOURCES, DEAL_STATUSES, phoneKey, emailKey,
} = require('../db');
const auth = require('../auth');
const pipeline = require('../pipeline');
const deals = require('../deals');
const geo = require('../geo');
const ads = require('../ads');
const leadbank = require('../leadbank');
const config = require('../config');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Sign in -------------------------------------------------------------------

router.post('/auth/login', wrap(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  const key = `${email}|${req.ip}`;
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
  if (auth.tooManyAttempts(key)) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !user.active || !(await auth.verifyPassword(password, user.password_hash))) {
    auth.recordFailure(key);
    return res.status(401).json({ error: 'That email and password do not match.' });
  }
  auth.clearAttempts(key);
  const { token, expires } = auth.createSession(user.id);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowISO(), user.id);
  auth.setSessionCookie(res, token, expires);
  res.json({ user: auth.publicUser(user) });
}));

router.post('/auth/logout', (req, res) => {
  if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.hashToken(req.sessionToken));
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.use(auth.requireUser);

router.get('/auth/me', (req, res) => res.json({ user: req.user }));

// --- Vocabulary for the screens ----------------------------------------------------

router.get('/meta', (req, res) => {
  res.json({
    stages: STAGES.map((s) => ({ key: s, label: STAGE_LABELS[s] })),
    lost_reasons: LOST_REASONS,
    categories: CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABELS[c] })),
    packages: PACKAGES.map((p) => ({ key: p, label: PACKAGE_LABELS[p] })),
    deal_statuses: DEAL_STATUSES,
    sources: SOURCES,
    users: db.prepare('SELECT id, name, commission_rate FROM users WHERE active = 1 ORDER BY name').all(),
    provinces: Object.entries(require('../db').PROVINCES).map(([code, name]) => ({ code, name })),
    leadbank_connected: leadbank.isConfigured(),
    stripe_connected: require('../stripe').isConfigured(),
    me: req.user,
  });
});

// --- Leads -----------------------------------------------------------------------------

router.get('/leads', (req, res) => {
  const where = [];
  const params = [];
  if (STAGES.includes(req.query.stage)) { where.push('l.stage = ?'); params.push(req.query.stage); }
  if (req.query.source === 'A' || req.query.source === 'B') { where.push('l.source = ?'); params.push(req.query.source); }
  if (req.query.q) {
    const q = `%${String(req.query.q).toLowerCase()}%`;
    const pk = phoneKey(req.query.q);
    where.push('(lower(l.name) LIKE ? OR lower(l.dealership) LIKE ? OR lower(l.email) LIKE ? OR lower(l.city) LIKE ? OR (l.phone_key LIKE ?))');
    params.push(q, q, q, q, pk ? `%${pk}%` : '__none__');
  }
  const rows = db.prepare(
    `SELECT l.*, u.name AS owner_name
       FROM leads l LEFT JOIN users u ON u.id = l.owner_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.created_at DESC LIMIT 1000`
  ).all(...params);
  const deals = geo.liveDeals();
  const leads = rows.map((l) => ({
    id: l.id, name: l.name, dealership: l.dealership, phone: l.phone, email: l.email, city: l.city,
    role: l.role, categories: l.categories, leads_wanted: l.leads_wanted, source: l.source,
    ad_name: l.ad_name || l.utm_content, campaign_name: l.campaign_name || l.utm_campaign,
    stage: l.stage, lost_reason: l.lost_reason, created_at: l.created_at, first_contact_at: l.first_contact_at,
    minutes_to_first_contact: pipeline.minutesBetween(l.created_at, l.first_contact_at),
    province: l.province, coverage: summarise(geo.coverageFor(l, deals)), owner_name: l.owner_name, submissions: l.submissions,
  }));

  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage').all()) counts[r.stage] = r.n;
  const speed = db.prepare(
    `SELECT AVG((julianday(first_contact_at) - julianday(created_at)) * 1440) AS avg, COUNT(*) AS n
       FROM leads WHERE first_contact_at IS NOT NULL`
  ).get();
  res.json({
    leads, counts, total: Object.values(counts).reduce((a, b) => a + b, 0),
    average_minutes_to_first_contact: speed.n ? Math.round(Math.max(0, speed.avg)) : null,
    contacted_count: speed.n,
  });
});

// For the table: how many dealers already take leads here, in what they sell.
const summarise = (c) => ({ located: c.located, dealers: c.dealers.length, same_category: c.same_category });

router.get('/leads/:id', (req, res) => {
  const lead = db.prepare(
    `SELECT l.*, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id = l.owner_id WHERE l.id = ?`
  ).get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });
  const activities = db.prepare(
    `SELECT a.*, u.name AS actor_name FROM activities a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.lead_id = ? ORDER BY a.created_at DESC, a.id DESC`
  ).all(lead.id);
  res.json({
    lead: { ...lead, minutes_to_first_contact: pipeline.minutesBetween(lead.created_at, lead.first_contact_at) },
    activities,
    coverage: geo.coverageFor(lead),
    deal: deals.dealForLead(lead.id),
    client: (() => { const d = db.prepare('SELECT * FROM deals WHERE lead_id = ?').get(lead.id); return d ? require('../clients').valueOf(d) : null; })(),
    capi: db.prepare('SELECT stage, event_name, status, attempts, last_error, sent_at FROM capi_events WHERE lead_id = ? ORDER BY id').all(lead.id),
  });
});

const EDITABLE_LEAD = ['name', 'phone', 'email', 'city', 'province', 'dealership', 'role', 'sells', 'leads_wanted', 'website', 'owner_id', 'categories'];

router.patch('/leads/:id', wrap(async (req, res) => {
  const lead = pipeline.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });
  const body = req.body || {};
  const sets = {};
  for (const k of EDITABLE_LEAD) if (body[k] !== undefined) sets[k] = body[k] === '' ? null : body[k];
  if (sets.categories !== undefined && sets.categories !== null) {
    const list = (Array.isArray(sets.categories) ? sets.categories : String(sets.categories).split(',')).map((s) => s.trim()).filter((c) => CATEGORIES.includes(c));
    sets.categories = list.join(',') || null;
  }
  if (sets.province !== undefined && sets.province !== null) sets.province = geo.provinceCode(sets.province) || sets.province;
  if (sets.owner_id && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(sets.owner_id)) return res.status(400).json({ error: 'Unknown user.' });
  if (sets.phone !== undefined) sets.phone_key = phoneKey(sets.phone);
  if (sets.email !== undefined) sets.email_key = emailKey(sets.email);
  const keys = Object.keys(sets);
  if (!keys.length) return res.json({ lead });
  db.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => sets[k]), lead.id);
  const shown = keys.filter((k) => !k.endsWith('_key'));
  logActivity(lead.id, 'system', `Edited ${shown.map((k) => k.replace(/_id$/, '').replace(/_/g, ' ')).join(', ')}.`, req.user.id);
  // A new city moves the pin.
  if (sets.city !== undefined || sets.province !== undefined) {
    db.prepare('UPDATE leads SET lat = NULL, lng = NULL WHERE id = ?').run(lead.id);
    await geo.placeLead(lead.id);
  }
  res.json({ lead: pipeline.getLead(lead.id) });
}));

router.post('/leads/:id/stage', wrap(async (req, res) => {
  const result = await pipeline.changeStage(req.params.id, req.body || {}, req.user);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.json(result);
}));

router.post('/leads/:id/activities', (req, res) => {
  const result = pipeline.addActivity(req.params.id, req.body || {}, req.user);
  if (result.error) return res.status(result.error === 'Lead not found.' ? 404 : 400).json({ error: result.error });
  res.status(201).json(result);
});

// Payment link: { via: 'link' | 'text' | 'email' }.
router.post('/deals/:id/payment-link', wrap(async (req, res) => {
  const r = await deals.sendPaymentLink(Number(req.params.id), (req.body || {}).via || 'link', req.user.id);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
}));

router.post('/leads/:id/handoff', wrap(async (req, res) => {
  const deal = deals.dealForLead(req.params.id);
  if (!deal) return res.status(404).json({ error: 'This lead has no deal yet. Move it to Signed first.' });
  res.json({ deal: await deals.runHandoff(deal.id, req.user.id) });
}));

// --- Deals and revenue -------------------------------------------------------------------

router.put('/deals/:id/areas', wrap(async (req, res) => {
  const result = await deals.updateAreas(Number(req.params.id), (req.body || {}).areas, req.user.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

router.patch('/deals/:id', (req, res) => {
  // Commission and who earns it are the owner's call, set on the Overview.
  const b = req.body || {};
  if ((b.commission_rate !== undefined || b.account_manager_id !== undefined) && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only an admin can change commission.' });
  }
  const result = deals.updateDeal(Number(req.params.id), req.body || {}, req.user.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// The owner's overview: targets, the month's accounting, dealer accounts.
router.get('/overview', auth.requireAdmin, wrap(async (req, res) => res.json(await require('../overview').overview(req.query.month))));

router.put('/targets', auth.requireAdmin, (req, res) => {
  const r = require('../overview').saveTargets((req.body || {}).month, (req.body || {}).targets);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

router.get('/revenue', auth.requireAdmin, (req, res) => res.json(deals.revenueReport(req.query.month)));

// --- Ad cost dashboard -------------------------------------------------------------------

router.get('/dashboard', auth.requireAdmin, (req, res) => {
  const data = ads.dashboard(req.query);
  data.health = {
    inbox_failed: db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE status = 'failed'").get().n,
    inbox_retrying: db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE status = 'pending' AND attempts > 0").get().n,
    capi_failed: db.prepare("SELECT COUNT(*) AS n FROM capi_events WHERE status IN ('failed','pending') AND attempts > 0").get().n,
    shoppers_routed: db.prepare("SELECT COUNT(*) AS n FROM consumer_forwards WHERE substr(created_at,1,10) BETWEEN ? AND ?").get(data.from, data.to).n,
    meta_configured: Boolean(config.metaAdAccountId() && config.metaAdsToken()),
    capi_configured: Boolean(config.capiDatasetId() && config.capiToken()),
  };
  res.json(data);
});

router.post('/ads/sync', auth.requireAdmin, wrap(async (req, res) => {
  try {
    res.json(await ads.syncAds(req.body || {}));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

router.post('/ads/:adId/source', auth.requireAdmin, (req, res) => {
  res.json({ ad_id: req.params.adId, source_override: ads.setSourceOverride(req.params.adId, (req.body || {}).source) });
});

// --- Clients ----------------------------------------------------------------------------------

// Signed dealers as accounts with their value, plus the prospects being worked.
router.get('/clients', (req, res) => res.json(require('../clients').list({ status: String(req.query.status || 'active'), q: req.query.q })));

// --- Coverage map --------------------------------------------------------------------------

router.get('/map', (req, res) => res.json(geo.mapData()));

// Search for a city or town (area picker). Known places first, then Open-Meteo.
router.get('/geocode', wrap(async (req, res) => res.json({ results: await geo.search(String(req.query.q || '')) })));

// --- Team (account managers, who gets new-lead alerts) --------------------------------------

router.get('/users', auth.requireAdmin, (req, res) => {
  res.json({ users: db.prepare('SELECT * FROM users ORDER BY name').all().map(auth.publicUser) });
});

router.post('/users', auth.requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  if (!String(b.email || '').includes('@') || !String(b.name || '').trim()) return res.status(400).json({ error: 'Name and email are required.' });
  if (String(b.password || '').length < 10) return res.status(400).json({ error: 'The password needs at least 10 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(String(b.email).trim().toLowerCase())) return res.status(409).json({ error: 'That email already has an account.' });
  const user = await auth.createUser({
    email: b.email, name: String(b.name).trim(), role: b.role === 'admin' ? 'admin' : 'rep', phone: b.phone || null,
    commission_rate: Number(b.commission_rate) || 0, notify_new_leads: !!b.notify_new_leads, password: b.password,
  });
  res.status(201).json({ user: auth.publicUser(user) });
}));

router.patch('/users/:id', wrap(async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const self = user.id === req.user.id;
  if (!self && req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  const b = req.body || {};
  const sets = {};
  if (b.name !== undefined) sets.name = String(b.name).trim() || user.name;
  if (b.phone !== undefined) sets.phone = String(b.phone).trim() || null;
  if (b.notify_new_leads !== undefined) sets.notify_new_leads = b.notify_new_leads ? 1 : 0;
  if (req.user.role === 'admin') {
    if (b.commission_rate !== undefined) {
      const r = Number(b.commission_rate);
      if (!Number.isFinite(r) || r < 0 || r > 1) return res.status(400).json({ error: 'Commission must be between 0% and 100%.' });
      sets.commission_rate = r;
    }
    if (b.role !== undefined && !self) sets.role = b.role === 'admin' ? 'admin' : 'rep';
    if (b.active !== undefined && !self) sets.active = b.active ? 1 : 0;
  }
  if (b.password !== undefined) {
    if (String(b.password).length < 10) return res.status(400).json({ error: 'The password needs at least 10 characters.' });
    sets.password_hash = await auth.hashPassword(b.password);
  }
  const keys = Object.keys(sets);
  if (keys.length) db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => sets[k]), user.id);
  if (sets.active === 0 || sets.password_hash) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, auth.hashToken(req.sessionToken || ''));
  res.json({ user: auth.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
}));

module.exports = router;
