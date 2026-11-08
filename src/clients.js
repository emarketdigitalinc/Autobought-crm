// clients.js - the client list: every signed dealer as an account, with what
// they're worth, plus the dealers still being worked and what they'd be worth.
//
//   Active     signed and billing
//   Working    prospects in the Working stage: the pipeline
//   Paused     signed, billing on hold
//   Cancelled  former clients
//
// Customer value, per client:
//   monthly value   what they pay a month now
//   lifetime value  every month billed since they started (to their end date)
//   collected       what Stripe has actually taken from them
//   months          how long they've been a client

const { db, CATEGORY_LABELS, PACKAGE_LABELS } = require('./db');
const { billsIn } = require('./deals');

const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const thisMonth = () => new Date().toISOString().slice(0, 7);

function monthsBetween(fromMonth, toMonth) {
  const [fy, fm] = fromMonth.split('-').map(Number);
  const [ty, tm] = toMonth.split('-').map(Number);
  const out = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y += 1, m = 1) : (m += 1)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (out.length > 600) break;
  }
  return out;
}

// What one signed dealer is worth.
function valueOf(deal, collectedByDeal = null) {
  const now = thisMonth();
  const last = deal.end_date && deal.end_date.slice(0, 7) < now ? deal.end_date.slice(0, 7) : now;
  const months = deal.start_date.slice(0, 7) <= last ? monthsBetween(deal.start_date.slice(0, 7), last) : [];
  const billed = months.filter((m) => billsIn(deal, m));
  const collected = collectedByDeal
    ? collectedByDeal[deal.id] || 0
    : db.prepare("SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE deal_id = ? AND status = 'paid'").get(deal.id).v;
  const start = new Date(`${deal.start_date}T00:00:00Z`);
  const end = deal.end_date && deal.status === 'cancelled' ? new Date(`${deal.end_date}T00:00:00Z`) : new Date();
  return {
    monthly_value: deal.status === 'active' ? deal.monthly_value : 0,
    contract_value: deal.monthly_value,
    lifetime_value: money(billed.length * deal.monthly_value),
    months_billed: billed.length,
    months_as_client: Math.max(0, Math.round(((end - start) / 86400000 / 30.44) * 10) / 10),
    collected: money(collected),
  };
}

// The average price per lead across active clients: used to estimate what a
// prospect would be worth from the leads/month they asked for.
function averagePrice() {
  const r = db.prepare("SELECT AVG(price_per_lead) AS v FROM deals WHERE status = 'active'").get();
  return r.v ? money(r.v) : 30;
}

function list({ status = 'active', q = '' } = {}) {
  const collectedByDeal = Object.fromEntries(
    db.prepare("SELECT deal_id, SUM(amount) AS v FROM payments WHERE status = 'paid' GROUP BY deal_id").all().map((r) => [r.deal_id, r.v])
  );
  const deals = db.prepare(
    `SELECT d.*, l.name AS contact_name, l.phone, l.email, l.city, l.province, l.last_activity_at, l.source,
            u.name AS account_manager_name
       FROM deals d JOIN leads l ON l.id = d.lead_id LEFT JOIN users u ON u.id = d.account_manager_id
      ORDER BY d.monthly_value DESC, d.dealer_name`
  ).all();
  const quotas = db.prepare('SELECT * FROM deal_quotas WHERE monthly_quota > 0').all();
  const areas = db.prepare('SELECT deal_id, label FROM deal_areas').all();

  const clients = deals.map((d) => ({
    kind: 'client',
    deal_id: d.id, lead_id: d.lead_id, name: d.dealer_name, status: d.status,
    contact_name: d.contact_name, phone: d.phone, email: d.email, city: d.city, province: d.province,
    package: PACKAGE_LABELS[d.package], leads_per_month: d.leads_per_month, price_per_lead: d.price_per_lead,
    categories: quotas.filter((x) => x.deal_id === d.id).map((x) => CATEGORY_LABELS[x.category]),
    areas: areas.filter((x) => x.deal_id === d.id).map((x) => x.label),
    start_date: d.start_date, end_date: d.end_date,
    payment_status: d.payment_status, account_manager: d.account_manager_name || 'Unassigned',
    last_activity_at: d.last_activity_at, source: d.source,
    ...valueOf(d, collectedByDeal),
  }));

  // The pipeline: prospects being worked, valued at what they asked for.
  const avg = averagePrice();
  const working = db.prepare(
    `SELECT l.*, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id = l.owner_id
      WHERE l.stage = 'working' ORDER BY l.stage_changed_at ASC`
  ).all().map((l) => ({
    kind: 'prospect',
    lead_id: l.id, name: l.dealership || l.name, status: 'working',
    contact_name: l.name, phone: l.phone, email: l.email, city: l.city, province: l.province,
    categories: String(l.categories || '').split(',').filter(Boolean).map((c) => CATEGORY_LABELS[c]),
    leads_wanted: l.leads_wanted, leads_per_month: l.leads_wanted_n || null,
    estimated_value: l.leads_wanted_n ? money(l.leads_wanted_n * avg) : null,
    days_in_stage: Math.floor((Date.now() - new Date(l.stage_changed_at || l.created_at)) / 86400000),
    account_manager: l.owner_name || 'Unassigned', last_activity_at: l.last_activity_at, source: l.source,
  }));

  const counts = {
    active: clients.filter((c) => c.status === 'active').length,
    working: working.length,
    paused: clients.filter((c) => c.status === 'paused').length,
    cancelled: clients.filter((c) => c.status === 'cancelled').length,
  };
  const active = clients.filter((c) => c.status === 'active');
  const summary = {
    active_clients: counts.active,
    mrr: money(active.reduce((a, c) => a + c.monthly_value, 0)),
    average_client_value: counts.active ? money(active.reduce((a, c) => a + c.monthly_value, 0) / counts.active) : null,
    lifetime_value: money(clients.reduce((a, c) => a + c.lifetime_value, 0)),
    collected: money(clients.reduce((a, c) => a + c.collected, 0)),
    pipeline_value: money(working.reduce((a, w) => a + (w.estimated_value || 0), 0)),
    pipeline_unpriced: working.filter((w) => w.estimated_value === null).length,
    average_price_per_lead: avg,
    churned: counts.cancelled,
  };

  let rows = status === 'working' ? working : status === 'all' ? [...clients, ...working] : clients.filter((c) => c.status === status);
  const needle = String(q || '').trim().toLowerCase();
  if (needle) {
    rows = rows.filter((r) => [r.name, r.contact_name, r.city, r.email, r.phone].some((v) => String(v || '').toLowerCase().includes(needle)));
  }
  return { status, counts, summary, rows };
}

module.exports = { list, valueOf, averagePrice, monthsBetween };
