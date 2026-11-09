// importer.js - bringing existing dealers in from the portal (lead bank) as
// clients, from a CSV with one row per dealer contract.
//
// Columns (header names are matched loosely; order doesn't matter):
//   leadbank_dealer_id, dealer_name, contact_name, contact_phone, contact_email,
//   portal_email, city, province, provinces, category, package, monthly_quota,
//   distribution_mode, price_per_lead, start_date, status, account_manager, notes
//
// Rows for the same dealer (same leadbank_dealer_id, else same dealer_name)
// become ONE client with a quota per category. Imported clients are marked
// as already handed off: they exist in the portal, so the CRM must never
// create them there a second time.

const crypto = require('crypto');
const { db, nowISO, phoneKey, emailKey, logActivity, PROVINCES } = require('./db');
const geo = require('./geo');

// RFC 4180-ish CSV: quoted fields, doubled quotes, commas and newlines inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = []; let field = ''; let quoted = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const key = (h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const header = rows[0].map(key);
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

const ALIASES = {
  leadbank_dealer_id: ['leadbank_dealer_id', 'dealer_id', 'id', 'portal_dealer_id'],
  dealer_name: ['dealer_name', 'dealership', 'dealership_name', 'name', 'dealer'],
  contact_name: ['contact_name', 'contact'],
  contact_phone: ['contact_phone', 'phone', 'mobile'],
  contact_email: ['contact_email', 'email'],
  portal_email: ['portal_email', 'portal_login', 'login_email', 'notify_emails'],
  city: ['city'],
  province: ['province', 'state'],
  provinces: ['provinces', 'provinces_served', 'areas', 'territory'],
  category: ['category', 'vehicle_category', 'product'],
  package: ['package', 'info_depth', 'lead_type'],
  monthly_quota: ['monthly_quota', 'quota', 'leads_per_month'],
  distribution_mode: ['distribution_mode', 'mode', 'sharing'],
  price_per_lead: ['price_per_lead', 'price', 'cost_per_lead'],
  start_date: ['start_date', 'started_on', 'start'],
  status: ['status', 'active'],
  account_manager: ['account_manager', 'am', 'rep'],
  notes: ['notes', 'contact_note', 'note'],
};
function pick(row, field) {
  for (const k of ALIASES[field]) if (row[k] !== undefined && row[k] !== '') return row[k];
  return '';
}

// The portal's categories -> ours. Trailer and RV are both RV/Marine here.
const CATEGORY = { automotive: 'automotive', auto: 'automotive', powersport: 'powersport', powersports: 'powersport', rv: 'rv_marine', trailer: 'rv_marine', rv_marine: 'rv_marine', marine: 'rv_marine' };
const STATUS = { active: 'active', yes: 'active', true: 'active', '1': 'active', paused: 'paused', inactive: 'paused', no: 'paused', false: 'paused', '0': 'paused', cancelled: 'cancelled', canceled: 'cancelled', churned: 'cancelled' };
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

function toDay(v) {
  if (!v) return null;
  // The right shape isn't enough: 2026-13-45 must not get through.
  if (isDay(v)) {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Reads the file into clients, without saving anything. Every problem is
// reported against the dealer it belongs to, so the file can be fixed.
function preview(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) return { error: 'The file has no rows (or no header row).' };
  const groups = new Map();
  rows.forEach((r, i) => {
    const id = pick(r, 'leadbank_dealer_id');
    const name = pick(r, 'dealer_name');
    const key = id ? `id:${id}` : `name:${name.toLowerCase()}`;
    if (!id && !name) return;
    if (!groups.has(key)) groups.set(key, { rows: [], lines: [] });
    groups.get(key).rows.push(r);
    groups.get(key).lines.push(i + 2);
  });

  const users = db.prepare('SELECT id, name, email, commission_rate FROM users').all();
  const clients = [];
  for (const { rows: rs, lines } of groups.values()) {
    const first = rs[0];
    const get = (f) => { for (const r of rs) { const v = pick(r, f); if (v) return v; } return ''; };
    const warnings = [];
    const errors = [];

    const quotas = {};
    const packages = new Set();
    for (const r of rs) {
      const raw = pick(r, 'category').toLowerCase().replace(/[^a-z_]/g, '');
      const cat = CATEGORY[raw];
      if (!raw) continue;
      if (!cat) { errors.push(`Unknown category "${pick(r, 'category')}"`); continue; }
      const q = Number(pick(r, 'monthly_quota') || 0);
      if (!Number.isFinite(q) || q < 0) { errors.push(`Bad monthly quota "${pick(r, 'monthly_quota')}"`); continue; }
      quotas[cat] = (quotas[cat] || 0) + Math.round(q);
      const pkg = pick(r, 'package').toLowerCase();
      if (pkg) packages.add(pkg.startsWith('app') ? 'application' : 'essential');
    }
    const leadsPerMonth = Object.values(quotas).reduce((a, n) => a + n, 0);
    if (!leadsPerMonth) errors.push('No category with a monthly quota');
    if (packages.size > 1) warnings.push('Has both Essential and Application contracts; imported as Application (the CRM keeps one package per client)');

    const priceRaw = get('price_per_lead').replace(/[$,\s]/g, '');
    const price = priceRaw === '' ? null : Number(priceRaw);
    if (price === null) warnings.push('No price per lead: imported at $0, so its value shows as $0 until you set the price');
    else if (!Number.isFinite(price) || price < 0) errors.push(`Bad price "${get('price_per_lead')}"`);

    const ownProvince = geo.provinceCode(get('province'));
    let provinces = get('provinces').split(/[;,/|\s]+/).map((p) => geo.provinceCode(p)).filter(Boolean);
    if (!provinces.length) {
      if (ownProvince) { provinces = [ownProvince]; warnings.push(`No provinces listed (the portal treats that as "anywhere"); imported as ${PROVINCES[ownProvince]}`); }
      else errors.push('No provinces, and no province for the dealer itself');
    }

    const startDate = toDay(get('start_date'));
    if (get('start_date') && !startDate) errors.push(`Bad start date "${get('start_date')}"`);
    if (!startDate) warnings.push('No start date: imported as today');

    const statusRaw = get('status').toLowerCase();
    const status = statusRaw ? STATUS[statusRaw] : 'active';
    if (!status) errors.push(`Unknown status "${get('status')}"`);

    const amRaw = get('account_manager');
    const am = amRaw ? users.find((u) => u.name.toLowerCase() === amRaw.toLowerCase() || u.email === amRaw.toLowerCase()
      || u.name.toLowerCase().split(' ')[0] === amRaw.toLowerCase().split(' ')[0]) : null;
    if (amRaw && !am) warnings.push(`Account manager "${amRaw}" isn't a CRM user; left unassigned`);

    const portalEmail = (get('portal_email').split(/[,;]/)[0] || get('contact_email')).trim().toLowerCase();
    const name = get('dealer_name');
    if (!name) errors.push('No dealer name');

    const dupe = (get('leadbank_dealer_id') && db.prepare('SELECT id FROM deals WHERE lb_dealer_id = ?').get(get('leadbank_dealer_id')))
      || db.prepare('SELECT id FROM deals WHERE lower(dealer_name) = lower(?)').get(name);
    if (dupe) errors.push('Already a client in the CRM (skipped)');

    clients.push({
      lines,
      leadbank_dealer_id: get('leadbank_dealer_id') || null,
      dealer_name: name,
      contact_name: get('contact_name') || null,
      contact_phone: get('contact_phone') || null,
      contact_email: get('contact_email') || null,
      portal_email: portalEmail || null,
      city: get('city') || null,
      province: ownProvince || provinces[0] || null,
      provinces,
      quotas,
      leads_per_month: leadsPerMonth,
      package: packages.has('application') ? 'application' : 'essential',
      distribution_mode: (get('distribution_mode') || '').toLowerCase().startsWith('excl') ? 'exclusive' : 'shared',
      price_per_lead: price === null || !Number.isFinite(price) ? 0 : price,
      monthly_value: Math.round(leadsPerMonth * (price || 0) * 100) / 100,
      start_date: startDate || new Date().toISOString().slice(0, 10),
      status: status || 'active',
      account_manager_id: am ? am.id : null,
      account_manager: am ? am.name : null,
      commission_rate: am ? am.commission_rate : 0,
      notes: get('notes') || null,
      warnings,
      errors,
      ok: errors.length === 0,
    });
  }
  return {
    rows: rows.length,
    clients,
    ready: clients.filter((c) => c.ok).length,
    skipped: clients.filter((c) => !c.ok).length,
  };
}

// Saves the clients that previewed cleanly. Each becomes a lead (stage
// Signed, source "I" for imported) with a deal, quotas and province areas.
async function commit(csvText, actorId) {
  const p = preview(csvText);
  if (p.error) return p;
  const now = nowISO();
  const created = [];
  const save = db.transaction((c) => {
    const existing = (c.contact_phone && db.prepare('SELECT * FROM leads WHERE phone_key = ?').get(phoneKey(c.contact_phone)))
      || (c.contact_email && db.prepare('SELECT * FROM leads WHERE email_key = ?').get(emailKey(c.contact_email)));
    let leadId;
    const startedAt = `${c.start_date}T12:00:00.000Z`;
    if (existing) {
      leadId = existing.id;
      db.prepare("UPDATE leads SET stage = 'signed', stage_changed_at = ?, signed_at = COALESCE(signed_at, ?), reached_working_at = COALESCE(reached_working_at, ?), dealership = COALESCE(dealership, ?) WHERE id = ?")
        .run(now, startedAt, startedAt, c.dealer_name, leadId);
    } else {
      leadId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO leads (id, name, phone, phone_key, email, email_key, city, province, dealership, categories, source,
                            created_at, received_at, stage, stage_changed_at, owner_id, reached_working_at, signed_at, first_contact_at, last_activity_at, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'I', ?, ?, 'signed', ?, ?, ?, ?, ?, ?, ?)`
      ).run(leadId, c.contact_name || c.dealer_name, c.contact_phone, phoneKey(c.contact_phone), c.contact_email, emailKey(c.contact_email),
        c.city, c.province, c.dealer_name, Object.keys(c.quotas).join(','), startedAt, now, now, c.account_manager_id,
        startedAt, startedAt, startedAt, now, c.notes);
    }
    const dealId = db.prepare(
      `INSERT INTO deals (lead_id, dealer_name, package, leads_per_month, price_per_lead, monthly_value, start_date, end_date, status,
                          account_manager_id, commission_rate, distribution_mode, portal_email, lb_dealer_id, handoff_status, handoff_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', NULL, ?, ?)`
    ).run(leadId, c.dealer_name, c.package, c.leads_per_month, c.price_per_lead, c.monthly_value, c.start_date,
      c.status === 'cancelled' ? new Date().toISOString().slice(0, 10) : null, c.status, c.account_manager_id, c.commission_rate,
      c.distribution_mode, c.portal_email || c.contact_email || '', c.leadbank_dealer_id, now, now).lastInsertRowid;
    for (const [cat, n] of Object.entries(c.quotas)) db.prepare('INSERT INTO deal_quotas (deal_id, category, monthly_quota) VALUES (?, ?, ?)').run(dealId, cat, n);
    for (const code of c.provinces) db.prepare("INSERT INTO deal_areas (deal_id, kind, province, label) VALUES (?, 'province', ?, ?)").run(dealId, code, PROVINCES[code]);
    logActivity(leadId, 'system', `Imported from the portal${c.leadbank_dealer_id ? ` (dealer ${c.leadbank_dealer_id})` : ''}: ${c.leads_per_month} leads/month, ${c.provinces.join(', ')}. Already set up in the portal, so no handoff runs.${c.warnings.length ? ` Notes: ${c.warnings.join('; ')}.` : ''}`, actorId);
    return leadId;
  });
  for (const c of p.clients.filter((x) => x.ok)) created.push({ dealer_name: c.dealer_name, lead_id: save(c) });
  for (const x of created) if (!db.prepare('SELECT lat FROM leads WHERE id = ?').get(x.lead_id).lat) await geo.placeLead(x.lead_id);
  return { ...p, imported: created.length, created };
}

module.exports = { parseCsv, preview, commit };
