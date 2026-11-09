// overview.js - the owner's monthly view: targets against actuals, and the
// month's accounting: what was billed, what Stripe collected, what the ads
// cost, what commission is owed, what's left, and how many leads each dealer
// has been sent.

const { db, getSetting, setSetting, PACKAGE_LABELS } = require('./db');
const deals = require('./deals');
const leadbank = require('./leadbank');

const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const thisMonth = () => new Date().toISOString().slice(0, 7);
const validMonth = (m) => (/^\d{4}-\d{2}$/.test(String(m || '')) ? m : thisMonth());

// What can be targeted, and which way is good.
const TARGETS = [
  { key: 'ad_budget', label: 'Ad spend', unit: 'money', better: 'under' },
  { key: 'dealer_leads', label: 'Dealer leads', unit: 'count', better: 'over' },
  { key: 'max_cpl', label: 'Cost per lead', unit: 'money', better: 'under', ratio: true },
  { key: 'working', label: 'Reached Working', unit: 'count', better: 'over' },
  { key: 'signed', label: 'Dealers signed', unit: 'count', better: 'over' },
  { key: 'new_mrr', label: 'New monthly revenue', unit: 'money', better: 'over' },
  { key: 'mrr', label: 'Monthly revenue (all dealers)', unit: 'money', better: 'over', level: true },
];

// A month's targets, or the most recent month's before it: targets carry
// forward until changed.
function targetsFor(month) {
  const own = getSetting(`targets:${month}`);
  if (own) return { month, inherited_from: null, values: JSON.parse(own) };
  const earlier = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'targets:%' AND key < ? ORDER BY key DESC LIMIT 1").get(`targets:${month}`);
  return earlier ? { month, inherited_from: earlier.key.slice(8), values: JSON.parse(earlier.value) } : { month, inherited_from: null, values: {} };
}

function saveTargets(month, values) {
  const clean = {};
  for (const t of TARGETS) {
    const v = values ? values[t.key] : undefined;
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { error: `${t.label} must be a number.` };
    clean[t.key] = n;
  }
  setSetting(`targets:${validMonth(month)}`, JSON.stringify(clean));
  return { targets: targetsFor(validMonth(month)) };
}

function inMonth(col) { return `substr(${col}, 1, 7) = ?`; }

function actuals(month) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const spend = one(`SELECT COALESCE(SUM(spend), 0) AS v FROM ad_spend WHERE ${inMonth('date')}`, month).v;
  const leads = one(`SELECT COUNT(*) AS v FROM leads WHERE source != 'I' AND ${inMonth('created_at')}`, month).v;
  const working = one(`SELECT COUNT(*) AS v FROM leads WHERE source != 'I' AND ${inMonth('reached_working_at')}`, month).v;
  const signed = one(`SELECT COUNT(*) AS v FROM leads WHERE source != 'I' AND ${inMonth('signed_at')}`, month).v;
  const newMrr = one(`SELECT COALESCE(SUM(d.monthly_value), 0) AS v FROM deals d JOIN leads l ON l.id = d.lead_id WHERE l.source != 'I' AND ${inMonth('l.signed_at')}`, month).v;
  const speed = one(`SELECT AVG((julianday(first_contact_at) - julianday(created_at)) * 1440) AS v, COUNT(*) AS n FROM leads WHERE source != 'I' AND first_contact_at IS NOT NULL AND ${inMonth('created_at')}`, month);
  const collected = one(`SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE status = 'paid' AND ${inMonth('paid_at')}`, month).v;
  const rev = deals.revenueReport(month);
  return {
    ad_budget: money(spend),
    dealer_leads: leads,
    max_cpl: leads && spend ? money(spend / leads) : null,
    working,
    signed,
    new_mrr: money(newMrr),
    mrr: rev.totals.revenue,
    commission: rev.totals.commission,
    collected: money(collected),
    minutes_to_first_contact: speed.n ? Math.round(Math.max(0, speed.v)) : null,
    revenue: rev,
  };
}

// How far through the month we are: 1 for past months, 0..1 for this one.
function monthProgress(month) {
  const now = new Date();
  const cur = thisMonth();
  if (month < cur) return 1;
  if (month > cur) return 0;
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.min(1, (now.getUTCDate() - 1 + now.getUTCHours() / 24) / days);
}

// Leads the lead bank has delivered to each signed dealer this month, from
// its own contract counters. Cached for a few minutes; empty if not connected.
let deliveredCache = { at: 0, data: {} };
async function deliveredThisMonth(dealList) {
  if (!leadbank.isConfigured()) return { connected: false, data: {} };
  if (Date.now() - deliveredCache.at < 5 * 60000) return { connected: true, data: deliveredCache.data };
  const data = {};
  for (const d of dealList.filter((x) => x.lb_dealer_id)) {
    try {
      const { dealer } = await leadbank.call('GET', `/api/dealers/${encodeURIComponent(d.lb_dealer_id)}`);
      const contracts = (dealer.contracts || []).filter((c) => c.active);
      data[d.id] = {
        delivered: contracts.reduce((a, c) => a + (c.delivered || 0), 0),
        target: contracts.reduce((a, c) => a + (c.target || c.monthly_quota || 0), 0),
      };
    } catch (err) {
      data[d.id] = { error: err.message };
    }
  }
  deliveredCache = { at: Date.now(), data };
  return { connected: true, data };
}

async function overview(monthIn) {
  const month = validMonth(monthIn);
  const act = actuals(month);
  const targets = targetsFor(month);
  const progress = monthProgress(month);

  const cards = TARGETS.map((t) => {
    const actual = act[t.key];
    const target = targets.values[t.key];
    // Expected by today: a pace line for totals that build through the month.
    const expected = target === undefined ? null : t.ratio || t.level ? target : money(target * progress);
    let status = null;
    if (target !== undefined && actual !== null) {
      const cmp = t.better === 'over' ? actual - (expected ?? target) : (expected ?? target) - actual;
      status = cmp >= 0 ? 'on_track' : 'behind';
    }
    return { ...t, actual, target: target ?? null, expected, status };
  });

  const allDeals = db.prepare(
    `SELECT d.*, u.name AS account_manager_name FROM deals d LEFT JOIN users u ON u.id = d.account_manager_id`
  ).all();
  const current = month === thisMonth();
  const delivered = current ? await deliveredThisMonth(allDeals.filter((d) => d.status !== 'cancelled')) : { connected: leadbank.isConfigured(), data: {} };
  const collectedByDeal = Object.fromEntries(db.prepare(`SELECT deal_id, SUM(amount) AS v FROM payments WHERE status = 'paid' AND ${inMonth('paid_at')} GROUP BY deal_id`).all(month).map((r) => [r.deal_id, money(r.v)]));
  const billing = new Set(act.revenue.rows.map((r) => r.deal_id));
  const accounts = allDeals
    .filter((d) => billing.has(d.id) || (current && d.status !== 'cancelled'))
    .map((d) => ({
      deal_id: d.id, lead_id: d.lead_id, dealer_name: d.dealer_name, status: d.status,
      package: PACKAGE_LABELS[d.package], leads_per_month: d.leads_per_month, price_per_lead: d.price_per_lead,
      monthly_value: d.monthly_value, billed: billing.has(d.id) ? d.monthly_value : 0,
      collected: collectedByDeal[d.id] || 0, payment_status: d.payment_status,
      delivered: delivered.data[d.id] || null,
      account_manager_id: d.account_manager_id, account_manager: d.account_manager_name || 'Unassigned',
      commission_rate: d.commission_rate, commission: billing.has(d.id) ? money(d.monthly_value * d.commission_rate) : 0,
      start_date: d.start_date,
    }))
    .sort((a, b) => b.monthly_value - a.monthly_value);

  const pnl = {
    billed: act.mrr,
    collected: act.collected,
    ad_spend: act.ad_budget,
    commission: act.commission,
    margin: money(act.mrr - act.ad_budget - act.commission),
    leads_delivered: accounts.reduce((a, x) => a + (x.delivered && x.delivered.delivered ? x.delivered.delivered : 0), 0),
  };

  // Twelve months of the same, for the trend table.
  const trend = act.revenue.trend.map((t) => {
    const spend = db.prepare(`SELECT COALESCE(SUM(spend), 0) AS v FROM ad_spend WHERE ${inMonth('date')}`).get(t.month).v;
    const leads = db.prepare(`SELECT COUNT(*) AS v FROM leads WHERE source != 'I' AND ${inMonth('created_at')}`).get(t.month).v;
    const signed = db.prepare(`SELECT COUNT(*) AS v FROM leads WHERE source != 'I' AND ${inMonth('signed_at')}`).get(t.month).v;
    return { ...t, ad_spend: money(spend), leads, signed, margin: money(t.revenue - spend - t.commission) };
  });

  return {
    month, progress, targets, cards, pnl, accounts,
    by_manager: act.revenue.by_manager,
    minutes_to_first_contact: act.minutes_to_first_contact,
    leadbank_connected: delivered.connected,
    trend,
  };
}

module.exports = { overview, targetsFor, saveTargets, TARGETS, actuals };
