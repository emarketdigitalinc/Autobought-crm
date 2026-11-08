// deals.js - a signed dealer: the package they bought, what it is worth, who
// earns commission on it, and handing them over to the lead bank.

const crypto = require('crypto');
const { db, nowISO, logActivity, CATEGORIES, CATEGORY_LABELS, PACKAGES, PACKAGE_LABELS, DEAL_STATUSES } = require('./db');
const config = require('./config');
const leadbank = require('./leadbank');
const { sendEmail, esc } = require('./notify');
const geo = require('./geo');

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const money = (n) => Math.round(Number(n) * 100) / 100;

// Checks and tidies what the Signed form sent. Returns { deal } or { error }.
function validateDealInput(input, lead) {
  const b = input || {};
  const quotas = {};
  for (const c of CATEGORIES) {
    const n = Number((b.quotas || {})[c] || 0);
    if (!Number.isFinite(n) || n < 0) return { error: `The ${CATEGORY_LABELS[c]} quota must be zero or more.` };
    if (n > 0) quotas[c] = Math.round(n);
  }
  if (!Object.keys(quotas).length) return { error: 'Give at least one category a monthly lead quota.' };
  const leadsPerMonth = Object.values(quotas).reduce((a, n) => a + n, 0);

  const pkg = b.package || 'essential';
  if (!PACKAGES.includes(pkg)) return { error: 'Package must be Essential or Application.' };
  const price = Number(b.price_per_lead);
  if (!Number.isFinite(price) || price < 0) return { error: 'Enter the price per lead.' };
  const startDate = b.start_date || new Date().toISOString().slice(0, 10);
  if (!isDay(startDate)) return { error: 'The start date needs to be a real date.' };

  const checkedAreas = geo.cleanAreas(b.areas);
  if (checkedAreas.error) return { error: checkedAreas.error };

  const email = String(b.portal_email || lead.email || '').trim().toLowerCase();
  if (!email.includes('@')) return { error: 'A portal login email is needed.' };

  const am = b.account_manager_id || lead.owner_id;
  const amUser = am ? db.prepare('SELECT * FROM users WHERE id = ?').get(am) : null;
  if (am && !amUser) return { error: 'That account manager does not exist.' };
  const rate = b.commission_rate !== undefined && b.commission_rate !== '' && b.commission_rate !== null
    ? Number(b.commission_rate) : amUser ? amUser.commission_rate : 0;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) return { error: 'Commission must be between 0% and 100%.' };

  const monthlyValue = b.monthly_value !== undefined && b.monthly_value !== '' && b.monthly_value !== null
    ? Number(b.monthly_value) : leadsPerMonth * price;
  if (!Number.isFinite(monthlyValue) || monthlyValue < 0) return { error: 'Monthly value must be zero or more.' };

  return {
    deal: {
      dealer_name: String(b.dealer_name || lead.dealership || lead.name || '').trim() || 'Unnamed dealer',
      package: pkg,
      leads_per_month: leadsPerMonth,
      price_per_lead: money(price),
      monthly_value: money(monthlyValue),
      start_date: startDate,
      account_manager_id: amUser ? amUser.id : null,
      commission_rate: rate,
      distribution_mode: b.distribution_mode === 'exclusive' ? 'exclusive' : 'shared',
      portal_email: email,
    },
    quotas,
    areas: checkedAreas.areas,
  };
}

function writeAreas(dealId, areas) {
  db.prepare('DELETE FROM deal_areas WHERE deal_id = ?').run(dealId);
  const ins = db.prepare('INSERT INTO deal_areas (deal_id, kind, province, label, lat, lng, radius_km) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const a of areas) ins.run(dealId, a.kind, a.province, a.label, a.lat, a.lng, a.radius_km);
}

function saveDeal(lead, { deal, quotas, areas }) {
  const existing = db.prepare('SELECT * FROM deals WHERE lead_id = ?').get(lead.id);
  const now = nowISO();
  let id;
  db.transaction(() => {
    if (existing) {
      // Re-signing (e.g. after a cancel) reopens the same deal.
      const keys = Object.keys(deal);
      db.prepare(`UPDATE deals SET ${keys.map((k) => `${k} = ?`).join(', ')}, status = 'active', end_date = NULL, handoff_status = 'pending', updated_at = ? WHERE id = ?`)
        .run(...keys.map((k) => deal[k]), now, existing.id);
      id = existing.id;
    } else {
      const cols = ['lead_id', ...Object.keys(deal), 'created_at'];
      const vals = [lead.id, ...Object.values(deal), now];
      id = db.prepare(`INSERT INTO deals (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals).lastInsertRowid;
    }
    db.prepare('DELETE FROM deal_quotas WHERE deal_id = ?').run(id);
    for (const [c, n] of Object.entries(quotas)) db.prepare('INSERT INTO deal_quotas (deal_id, category, monthly_quota) VALUES (?, ?, ?)').run(id, c, n);
    writeAreas(id, areas);
  })();
  return getDeal(id);
}

function getDeal(id) {
  const d = db.prepare(
    `SELECT d.*, u.name AS account_manager_name FROM deals d LEFT JOIN users u ON u.id = d.account_manager_id WHERE d.id = ?`
  ).get(id);
  if (!d) return null;
  d.quotas = db.prepare('SELECT category, monthly_quota FROM deal_quotas WHERE deal_id = ?').all(id);
  d.areas = db.prepare('SELECT * FROM deal_areas WHERE deal_id = ? ORDER BY kind DESC, label').all(id);
  return d;
}
const dealForLead = (leadId) => {
  const row = db.prepare('SELECT id FROM deals WHERE lead_id = ?').get(leadId);
  return row ? getDeal(row.id) : null;
};

const EDITABLE = ['dealer_name', 'package', 'price_per_lead', 'monthly_value', 'start_date', 'end_date', 'status',
  'account_manager_id', 'commission_rate', 'leads_per_month'];

function updateDeal(id, body, actorId) {
  const deal = getDeal(id);
  if (!deal) return { error: 'Deal not found.' };
  const sets = {};
  for (const k of EDITABLE) if (body[k] !== undefined) sets[k] = body[k] === '' ? null : body[k];
  if (sets.status && !DEAL_STATUSES.includes(sets.status)) return { error: 'Status must be active, paused or cancelled.' };
  if (sets.package && !PACKAGES.includes(sets.package)) return { error: 'Package must be Essential or Application.' };
  for (const k of ['start_date', 'end_date']) if (sets[k] && !isDay(sets[k])) return { error: 'Dates need to be real dates.' };
  for (const k of ['price_per_lead', 'monthly_value', 'commission_rate', 'leads_per_month']) {
    if (sets[k] === undefined) continue;
    if (sets[k] === null || !Number.isFinite(Number(sets[k])) || Number(sets[k]) < 0) return { error: `${k.replace(/_/g, ' ')} must be a number.` };
    sets[k] = Number(sets[k]);
  }
  if (sets.commission_rate > 1) return { error: 'Commission must be between 0% and 100%.' };
  // Repricing without an explicit monthly value recomputes it.
  if ((sets.price_per_lead !== undefined || sets.leads_per_month !== undefined) && body.monthly_value === undefined) {
    sets.monthly_value = money((sets.leads_per_month ?? deal.leads_per_month) * (sets.price_per_lead ?? deal.price_per_lead));
  }
  if (sets.status === 'cancelled' && !sets.end_date && !deal.end_date) sets.end_date = new Date().toISOString().slice(0, 10);
  if (sets.status === 'active' && deal.status === 'cancelled' && body.end_date === undefined) sets.end_date = null;
  const keys = Object.keys(sets);
  if (!keys.length) return { deal };
  db.prepare(`UPDATE deals SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => sets[k]), nowISO(), id);
  logActivity(deal.lead_id, 'system', `Deal updated: ${keys.map((k) => `${k.replace(/_/g, ' ')} → ${sets[k] ?? 'none'}`).join(', ')}.`, actorId);
  return { deal: getDeal(id) };
}

// --- Revenue and commission ----------------------------------------------------

const monthBounds = (month) => {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
};
const thisMonth = () => new Date().toISOString().slice(0, 7);

// A deal bills for a month when it had started by the month's end and had not
// ended before it began. Pause history is not kept, so a paused deal stops
// counting from the current month on and still counts in months already past.
function billsIn(deal, month) {
  const { start, end } = monthBounds(month);
  if (deal.start_date > end) return false;
  if (deal.end_date && deal.end_date < start) return false;
  if (deal.status === 'cancelled' && !deal.end_date) return false;
  if (deal.status === 'paused' && month >= thisMonth()) return false;
  return true;
}

function revenueReport(month = thisMonth()) {
  if (!/^\d{4}-\d{2}$/.test(month)) month = thisMonth();
  const deals = db.prepare(
    `SELECT d.*, u.name AS account_manager_name FROM deals d LEFT JOIN users u ON u.id = d.account_manager_id ORDER BY d.dealer_name`
  ).all();
  const rows = deals.filter((d) => billsIn(d, month)).map((d) => ({
    deal_id: d.id, lead_id: d.lead_id, dealer_name: d.dealer_name, status: d.status,
    package: PACKAGE_LABELS[d.package], leads_per_month: d.leads_per_month, price_per_lead: d.price_per_lead,
    monthly_value: d.monthly_value, start_date: d.start_date, end_date: d.end_date,
    account_manager: d.account_manager_name || 'Unassigned', commission_rate: d.commission_rate,
    commission: money(d.monthly_value * d.commission_rate),
  }));
  const byManager = {};
  for (const r of rows) {
    const m = (byManager[r.account_manager] ||= { account_manager: r.account_manager, deals: 0, revenue: 0, commission: 0 });
    m.deals += 1; m.revenue = money(m.revenue + r.monthly_value); m.commission = money(m.commission + r.commission);
  }
  const trend = [];
  const [y, m] = month.split('-').map(Number);
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const key = d.toISOString().slice(0, 7);
    const live = deals.filter((x) => billsIn(x, key));
    trend.push({
      month: key,
      deals: live.length,
      revenue: money(live.reduce((a, x) => a + x.monthly_value, 0)),
      commission: money(live.reduce((a, x) => a + x.monthly_value * x.commission_rate, 0)),
    });
  }
  return {
    month,
    rows,
    by_manager: Object.values(byManager),
    totals: {
      deals: rows.length,
      revenue: money(rows.reduce((a, r) => a + r.monthly_value, 0)),
      commission: money(rows.reduce((a, r) => a + r.commission, 0)),
    },
    trend,
  };
}

// The lead bank filters by province only, so a radius sends its province.
// The exact radius is written on the dealer's record for staff to see.
const provincesOf = (deal) => [...new Set(deal.areas.map((a) => a.province))].join(',');
const areasNote = (deal) => `Signed through the CRM. Lead areas: ${deal.areas.map((a) => a.label).join(', ')}.`;

// A signed dealer changing where they want leads from.
async function updateAreas(dealId, input, actorId) {
  const deal = getDeal(dealId);
  if (!deal) return { error: 'Deal not found.' };
  const checked = geo.cleanAreas(input);
  if (checked.error) return { error: checked.error };
  writeAreas(dealId, checked.areas);
  const fresh = getDeal(dealId);
  logActivity(deal.lead_id, 'system', `Lead areas changed to: ${fresh.areas.map((a) => a.label).join(', ')}.`, actorId);
  if (deal.lb_dealer_id && leadbank.isConfigured()) {
    try {
      await leadbank.call('PATCH', `/api/dealers/${encodeURIComponent(deal.lb_dealer_id)}`, { provinces: provincesOf(fresh), contact_note: areasNote(fresh) });
      logActivity(deal.lead_id, 'handoff', `Lead bank: provinces updated to ${provincesOf(fresh)}.`, actorId);
    } catch (err) {
      logActivity(deal.lead_id, 'handoff', `Could not update the lead bank's provinces: ${err.message}`, actorId);
      return { deal: fresh, warning: `Saved here, but the lead bank was not updated: ${err.message}` };
    }
  }
  return { deal: fresh };
}

function markAwaitingPayment(dealId) {
  db.prepare("UPDATE deals SET handoff_status = 'awaiting_payment', handoff_error = NULL, updated_at = ? WHERE id = ?").run(nowISO(), dealId);
  const d = getDeal(dealId);
  logActivity(d.lead_id, 'handoff', 'Portal handoff will run as soon as the dealer pays.');
}

// Send the Stripe link to the dealer: a text to the lead's phone, or an email
// to the portal address. Paying on their phone while Mike is on the call.
async function sendPaymentLink(dealId, via, actorId) {
  const stripe = require('./stripe');
  const { sendSms } = require('./notify');
  const deal = getDeal(dealId);
  if (!deal) return { error: 'Deal not found.' };
  let url;
  try { url = await stripe.paymentLink(deal); } catch (err) { return { error: err.message }; }
  if (via === 'link') return { url };
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(deal.lead_id);
  const first = String(lead.name || '').split(' ')[0] || 'there';
  const amount = `$${deal.monthly_value.toFixed(2)}/month`;
  let result;
  try {
    if (via === 'text') {
      if (!lead.phone) return { error: 'This lead has no phone number.' };
      result = await sendSms({ to: lead.phone, body: `Hi ${first}, here's your Autobought sign-up link (${deal.leads_per_month} leads/month, ${amount}). Pay securely by card, Apple Pay or Google Pay: ${url}` });
    } else if (via === 'email') {
      result = await sendEmail({
        to: deal.portal_email, from: config.welcomeFrom(),
        subject: `Your Autobought sign-up: ${deal.leads_per_month} leads/month`,
        text: `Hi ${first},\n\nThanks for signing up with Autobought. Here's your secure payment link for ${deal.leads_per_month} ${PACKAGE_LABELS[deal.package]} leads a month at $${deal.price_per_lead}/lead (${amount}):\n\n${url}\n\nYour dealer portal is set up as soon as payment goes through.\n\nThe Autobought team`,
        html: `<p>Hi ${esc(first)},</p><p>Thanks for signing up with Autobought. Here's your secure payment link for <strong>${deal.leads_per_month} ${esc(PACKAGE_LABELS[deal.package])} leads a month</strong> at $${deal.price_per_lead}/lead (${esc(amount)}).</p><p><a href="${esc(url)}" style="display:inline-block;background:#1263b4;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold">Pay and activate</a></p><p>Your dealer portal is set up as soon as payment goes through.</p>`,
      });
    } else {
      return { error: 'Send by text or email.' };
    }
  } catch (err) {
    return { error: err.message };
  }
  const how = result.sent ? 'sent' : result.simulated ? 'simulated (not configured)' : `not sent (${result.detail})`;
  logActivity(deal.lead_id, via === 'text' ? 'text' : 'email', `Payment link ${via === 'text' ? 'texted' : 'emailed'} to the dealer: ${how}.`, actorId);
  if (result.sent || result.simulated) db.prepare("UPDATE deals SET payment_status = CASE WHEN payment_status IN ('none','link_created') THEN 'link_sent' ELSE payment_status END WHERE id = ?").run(dealId);
  return { url, sent: Boolean(result.sent), simulated: Boolean(result.simulated), detail: result.detail };
}

// --- Handoff to the lead bank ------------------------------------------------------

const tempPassword = () => crypto.randomBytes(12).toString('base64url').replace(/[-_]/g, 'x').slice(0, 14);

// Every step remembers what it finished, so a retry after a failure (lead
// bank down, email refused) carries on from where it stopped rather than
// creating a second dealer.
async function runHandoff(dealId, actorId = null) {
  let deal = getDeal(dealId);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(deal.lead_id);
  const log = (msg) => logActivity(lead.id, 'handoff', msg, actorId);
  const setDeal = (fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE deals SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), nowISO(), dealId);
    deal = getDeal(dealId);
  };

  if (!leadbank.isConfigured()) {
    setDeal({ handoff_status: 'skipped', handoff_error: 'The lead bank is not connected (LEADBANK_URL / LEADBANK_EMAIL / LEADBANK_PASSWORD).' });
    log('Portal handoff skipped: the lead bank is not connected. Set it up, then press "Retry handoff".');
    return deal;
  }

  const provinces = provincesOf(deal);
  const am = deal.account_manager_name || null;
  let password = null;

  try {
    // 1. The dealership.
    const dealerFields = {
      name: deal.dealer_name,
      notify_emails: deal.portal_email,
      contact_name: lead.name, contact_phone: lead.phone, contact_email: lead.email,
      website: lead.website, city: lead.city, account_manager: am, started_on: deal.start_date,
      provinces,
      contact_note: areasNote(deal),
    };
    if (!deal.lb_dealer_id) {
      const { dealer } = await leadbank.call('POST', '/api/dealers', dealerFields);
      setDeal({ lb_dealer_id: dealer.id });
      log(`Lead bank: created dealer "${deal.dealer_name}" (${dealer.id}), provinces ${provinces || 'any'}.`);
    } else {
      await leadbank.call('PATCH', `/api/dealers/${encodeURIComponent(deal.lb_dealer_id)}`, { ...dealerFields, active: true });
    }

    // 2. Categories and monthly quotas, as contracts.
    const map = config.leadBankCategoryMap();
    const lines = [];
    for (const q of deal.quotas) {
      for (const lbCat of map[q.category] || []) {
        await leadbank.call('POST', `/api/dealers/${encodeURIComponent(deal.lb_dealer_id)}/contracts`, {
          vehicle_category: lbCat, info_depth: deal.package, monthly_quota: q.monthly_quota,
          distribution_mode: deal.distribution_mode, active: true,
        });
        lines.push(`${lbCat} ${deal.package} ${q.monthly_quota}/mo`);
      }
    }
    log(`Lead bank: contracts set (${lines.join(', ')}).`);

    // 3. The portal login.
    if (!deal.lb_user_id) {
      password = tempPassword();
      try {
        const { user } = await leadbank.call('POST', '/api/users', {
          email: deal.portal_email, name: lead.name || deal.dealer_name, role: 'dealer', dealer_id: deal.lb_dealer_id, password,
        });
        setDeal({ lb_user_id: user.id });
        log(`Lead bank: portal login created for ${deal.portal_email}.`);
      } catch (err) {
        if (err.status !== 409) throw err;
        const { users } = await leadbank.call('GET', '/api/users');
        const found = users.find((u) => u.email.toLowerCase() === deal.portal_email);
        if (!found || found.dealer_id !== deal.lb_dealer_id) {
          throw new Error(`${deal.portal_email} already has a lead bank login for a different account. Use another portal email.`);
        }
        setDeal({ lb_user_id: found.id });
        password = null;
      }
    }

    // 4. The welcome email, with a working password. If the login was made on
    // an earlier attempt, that password is gone, so issue a fresh one.
    if (!deal.welcome_sent_at) {
      if (!password) {
        password = tempPassword();
        await leadbank.call('POST', `/api/users/${encodeURIComponent(deal.lb_user_id)}/password`, { password });
      }
      const result = await sendWelcome(deal, lead, password);
      setDeal({ welcome_sent_at: result.sent || result.simulated ? nowISO() : null });
      log(`Welcome email to ${deal.portal_email}: ${result.sent ? 'sent' : result.simulated ? 'simulated (no RESEND_API_KEY)' : `not sent (${result.detail})`}.`);
      if (!result.sent && !result.simulated) throw new Error(`Welcome email not sent: ${result.detail}`);
    }

    setDeal({ handoff_status: 'done', handoff_error: null });
    return deal;
  } catch (err) {
    setDeal({ handoff_status: 'failed', handoff_error: err.message });
    log(`Portal handoff stopped: ${err.message}`);
    return deal;
  }
}

function welcomeMessage(deal, lead, password) {
  const login = leadbank.portalUrl();
  const cats = deal.quotas.map((q) => `${CATEGORY_LABELS[q.category]}: ${q.monthly_quota} leads/month`);
  const markets = deal.areas.map((a) => a.label).join(' · ');
  const first = String(lead.name || '').split(' ')[0] || 'there';
  const rows = [
    ['Portal', login], ['Login email', deal.portal_email], ['Temporary password', password],
    ['Package', `${PACKAGE_LABELS[deal.package]} leads`], ['Categories', cats.join(' · ')], ['Lead areas', markets],
    ['Starts', deal.start_date], ['Your account manager', deal.account_manager_name],
  ].filter(([, v]) => v);
  const subject = `Welcome to Autobought, ${deal.dealer_name}`;
  const text = `Hi ${first},\n\nWelcome aboard. Your Autobought dealer portal is ready: every lead we send you lands there as well as in your inbox.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nPlease sign in and change your password under Settings.\n\nThe Autobought team`;
  const html = `<!doctype html><html><body style="margin:0;background:#eef1f6;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:28px 16px"><div style="background:#fff;border-radius:8px;overflow:hidden">
<div style="height:6px;background:#f47a2a"></div><div style="padding:24px 28px">
<h2 style="margin:0 0 12px;color:#0e2544">Welcome to Autobought, ${esc(deal.dealer_name)}</h2>
<p style="color:#48556f;font-size:15px;line-height:22px">Hi ${esc(first)}, welcome aboard. Your dealer portal is ready: every lead we send you lands there as well as in your inbox.</p>
<table style="border-collapse:collapse;font-size:14px;margin:14px 0 20px">${rows.map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#63708c;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#101a2e;font-weight:600">${esc(v)}</td></tr>`).join('')}</table>
<a href="${esc(login)}" style="display:inline-block;background:#1263b4;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:6px">Sign in to your portal</a>
<p style="color:#63708c;font-size:13px;margin-top:20px">Please change your password after signing in (Settings).</p>
</div></div></div></body></html>`;
  return { subject, text, html };
}

async function sendWelcome(deal, lead, password) {
  const msg = welcomeMessage(deal, lead, password);
  const am = deal.account_manager_id ? db.prepare('SELECT email FROM users WHERE id = ?').get(deal.account_manager_id) : null;
  const bcc = [config.welcomeBcc(), am && am.email].filter(Boolean).join(',');
  try {
    return await sendEmail({ to: deal.portal_email, from: config.welcomeFrom(), bcc: bcc || undefined, replyTo: am ? am.email : undefined, ...msg });
  } catch (err) {
    return { sent: false, detail: err.message };
  }
}

module.exports = {
  validateDealInput, saveDeal, getDeal, dealForLead, updateDeal, updateAreas, markAwaitingPayment, sendPaymentLink, revenueReport, runHandoff, billsIn, welcomeMessage, thisMonth,
};
