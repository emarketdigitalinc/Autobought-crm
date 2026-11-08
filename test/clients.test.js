// The client list and customer value, on data built directly in the database.

process.env.DATA_DIR = ':memory:';
process.env.RUN_SCHEDULER = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../src/db');
const clients = require('../src/clients');

const iso = (d) => d.toISOString();
const monthsAgo = (n) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };

function lead(id, name, stage, extra = {}) {
  db.prepare(`INSERT INTO leads (id, name, dealership, phone, city, province, source, stage, created_at, received_at, stage_changed_at, leads_wanted, leads_wanted_n, categories)
              VALUES (?, ?, ?, ?, 'Red Deer', 'AB', 'A', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, `${name} Motors`, '4035550100', stage, iso(new Date()), iso(new Date()), extra.changed || iso(new Date()),
      extra.wanted ? String(extra.wanted) : null, extra.wanted || null, extra.categories || 'automotive');
}
function deal(leadId, { status = 'active', start, end = null, value, price = 25, leads = 20 }) {
  const id = db.prepare(`INSERT INTO deals (lead_id, dealer_name, package, leads_per_month, price_per_lead, monthly_value, start_date, end_date, status, portal_email, created_at)
                         VALUES (?, ?, 'essential', ?, ?, ?, ?, ?, ?, 'x@y.z', ?)`)
    .run(leadId, `${leadId} Motors`, leads, price, value, start, end, status, iso(new Date())).lastInsertRowid;
  db.prepare("INSERT INTO deal_quotas (deal_id, category, monthly_quota) VALUES (?, 'automotive', ?)").run(id, leads);
  db.prepare("INSERT INTO deal_areas (deal_id, kind, province, label) VALUES (?, 'province', 'AB', 'Alberta')").run(id);
  return id;
}

test('customer value: monthly, lifetime (months billed), collected, months as client', () => {
  lead('a', 'Alpha', 'signed');
  const id = deal('a', { start: monthsAgo(2), value: 500, price: 25, leads: 20 });
  db.prepare("INSERT INTO payments (deal_id, stripe_invoice_id, amount, status, paid_at) VALUES (?, 'in_a1', 500, 'paid', ?), (?, 'in_a2', 500, 'paid', ?)")
    .run(id, iso(new Date()), id, iso(new Date()));
  const v = clients.valueOf(db.prepare('SELECT * FROM deals WHERE id = ?').get(id));
  assert.equal(v.monthly_value, 500);
  assert.equal(v.months_billed, 3, 'two months ago, last month, this month');
  assert.equal(v.lifetime_value, 1500);
  assert.equal(v.collected, 1000);
  assert.ok(v.months_as_client >= 1.5 && v.months_as_client < 3.2, String(v.months_as_client));
});

test('a cancelled client keeps its lifetime value up to its end date but is worth nothing monthly', () => {
  lead('c', 'Charlie', 'signed');
  const id = deal('c', { status: 'cancelled', start: monthsAgo(5), end: monthsAgo(3).slice(0, 8) + '28', value: 300 });
  const v = clients.valueOf(db.prepare('SELECT * FROM deals WHERE id = ?').get(id));
  assert.equal(v.monthly_value, 0);
  assert.equal(v.months_billed, 3);
  assert.equal(v.lifetime_value, 900);
});

test('client list: tabs, summary, and the Working pipeline valued at the average price', () => {
  lead('p', 'Papa', 'signed');
  deal('p', { status: 'paused', start: monthsAgo(1), value: 200 });
  lead('w1', 'Whiskey', 'working', { wanted: 40, changed: iso(new Date(Date.now() - 9 * 86400000)) });
  lead('w2', 'Xray', 'working');

  const active = clients.list({ status: 'active' });
  assert.deepEqual(active.counts, { active: 1, working: 2, paused: 1, cancelled: 1 });
  assert.equal(active.rows.length, 1);
  assert.equal(active.rows[0].name, 'a Motors');
  assert.deepEqual(active.rows[0].areas, ['Alberta']);
  assert.equal(active.summary.mrr, 500);
  assert.equal(active.summary.average_client_value, 500);
  assert.equal(active.summary.average_price_per_lead, 25, 'from active clients');
  assert.equal(active.summary.pipeline_value, 1000, '40 leads x $25');
  assert.equal(active.summary.pipeline_unpriced, 1);
  assert.equal(active.summary.lifetime_value, 1500 + 900 + 400 - 200, 'paused stops counting from this month');

  const working = clients.list({ status: 'working' });
  assert.equal(working.rows[0].name, 'Whiskey Motors', 'longest in Working first');
  assert.equal(working.rows[0].days_in_stage, 9);
  assert.equal(working.rows[0].estimated_value, 1000);

  assert.equal(clients.list({ status: 'all', q: 'xray' }).rows.length, 1);
});
