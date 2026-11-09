// Importing existing dealers from the portal as clients.

process.env.DATA_DIR = ':memory:';
process.env.RUN_SCHEDULER = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

// No outside calls: geocoding lookups return nothing.
global.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

const { db } = require('../src/db');
const { createUser } = require('../src/auth');
const importer = require('../src/importer');
const clients = require('../src/clients');

const CSV = [
  'leadbank_dealer_id,dealer_name,contact_name,contact_phone,contact_email,portal_email,city,province,provinces,category,package,monthly_quota,distribution_mode,price_per_lead,start_date,status,account_manager,notes',
  'd1,Northside Motors,Sam Lee,(780) 555-0101,sam@northside.ca,"leads@northside.ca, gm@northside.ca",Edmonton,AB,AB;SK,automotive,essential,30,shared,25,2026-09-01,active,Mike,"Likes texts, not calls"',
  'd1,Northside Motors,,,,,,,,powersport,essential,10,shared,,,,,',
  'd2,Prairie RV & Trailer,Kim Fox,4035550102,kim@prairierv.ca,,Red Deer,Alberta,,trailer,application,15,exclusive,$32.50,10/01/2026,active,,',
  'd2,Prairie RV & Trailer,,,,,,,,rv,application,5,exclusive,,,,,',
  'd3,No Price Auto,Al Bo,4035550103,al@noprice.ca,,Calgary,AB,AB,automotive,essential,20,shared,,,paused,Somebody,',
  'd4,Broken Dealer,,,,,,,,boats,essential,x,shared,20,2026-13-45,whatever,,',
].join('\n');

test.before(async () => {
  await createUser({ email: 'mike@autobought.ca', name: 'Mike', password: 'mike-password-1', commission_rate: 0.2 });
});

test('CSV parsing handles quotes, commas inside quotes and $ prices', () => {
  const rows = importer.parseCsv(CSV);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].portal_email, 'leads@northside.ca, gm@northside.ca');
  assert.equal(rows[0].notes, 'Likes texts, not calls');
});

test('preview groups contracts per dealer and reports problems per dealer', () => {
  const p = importer.preview(CSV);
  assert.equal(p.clients.length, 4);
  assert.equal(p.ready, 3);
  const [north, rv, noPrice, broken] = p.clients;

  assert.deepEqual(north.quotas, { automotive: 30, powersport: 10 });
  assert.equal(north.leads_per_month, 40);
  assert.equal(north.monthly_value, 1000);
  assert.deepEqual(north.provinces, ['AB', 'SK']);
  assert.equal(north.portal_email, 'leads@northside.ca');
  assert.equal(north.account_manager, 'Mike');
  assert.equal(north.commission_rate, 0.2);

  assert.deepEqual(rv.quotas, { rv_marine: 20 }, 'trailer + rv both become RV/Marine');
  assert.equal(rv.package, 'application');
  assert.equal(rv.price_per_lead, 32.5);
  assert.equal(rv.start_date, '2026-10-01');
  assert.equal(rv.distribution_mode, 'exclusive');
  assert.deepEqual(rv.provinces, ['AB'], 'no provinces listed: falls back to its own');
  assert.ok(rv.warnings.some((w) => /anywhere/.test(w)));

  assert.equal(noPrice.price_per_lead, 0);
  assert.equal(noPrice.status, 'paused');
  assert.ok(noPrice.warnings.some((w) => /No price/.test(w)));
  assert.ok(noPrice.warnings.some((w) => /Somebody/.test(w)));

  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some((e) => /category/.test(e)));
  assert.ok(broken.errors.some((e) => /start date/.test(e)));
  assert.ok(broken.errors.some((e) => /status/.test(e)));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deals').get().n, 0, 'preview saves nothing');
});

test('commit creates clients marked as already in the portal, and a second import skips them', async () => {
  const r = await importer.commit(CSV, null);
  assert.equal(r.imported, 3);
  const deal = db.prepare("SELECT * FROM deals WHERE lb_dealer_id = 'd1'").get();
  assert.equal(deal.handoff_status, 'done', 'never handed off again');
  assert.equal(deal.monthly_value, 1000);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(deal.lead_id);
  assert.equal(lead.stage, 'signed');
  assert.equal(lead.source, 'I');
  assert.equal(lead.phone_key, '7805550101');
  assert.deepEqual(db.prepare('SELECT province FROM deal_areas WHERE deal_id = ? ORDER BY province').all(deal.id).map((a) => a.province), ['AB', 'SK']);

  const list = clients.list({ status: 'active' });
  assert.deepEqual(list.rows.map((c) => c.name).sort(), ['Northside Motors', 'Prairie RV & Trailer']);
  assert.equal(clients.list({ status: 'paused' }).rows[0].name, 'No Price Auto');

  const again = importer.preview(CSV);
  assert.equal(again.ready, 0);
  assert.ok(again.clients[0].errors.some((e) => /Already a client/.test(e)));
});
