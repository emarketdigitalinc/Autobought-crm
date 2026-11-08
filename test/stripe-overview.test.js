// Stripe payment links + webhook, the owner's Overview and targets, and the
// new lander Jotform's fields. Same harness idea as crm.test.js: real app,
// fake outside world.

process.env.DATA_DIR = ':memory:';
process.env.RUN_SCHEDULER = 'false';
process.env.APP_URL = 'https://crm.test';
process.env.WEBHOOK_SECRET = 'flat-secret';
process.env.JOTFORM_WEBHOOK_SECRET = 'jot-secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.TWILIO_ACCOUNT_SID = 'AC1';
process.env.TWILIO_AUTH_TOKEN = 'tok';
process.env.TWILIO_FROM = '+15875550000';
process.env.RESEND_API_KEY = 're_test';
process.env.LEADBANK_URL = 'https://bank.test';
process.env.LEADBANK_EMAIL = 'crm@autobought.ca';
process.env.LEADBANK_PASSWORD = 'bank-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const realFetch = global.fetch;
const calls = [];
const bank = { dealers: {}, users: [] };
const reply = (status, json, headers = {}) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  const body = typeof opts.body === 'string' ? (() => { try { return JSON.parse(opts.body); } catch (e) { return opts.body; } })() : opts.body;
  calls.push({ url: u, method: opts.method || 'GET', body, headers: opts.headers || {} });
  if (u === 'https://api.stripe.com/v1/checkout/sessions') {
    return reply(200, { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', expires_at: Math.floor(Date.now() / 1000) + 86400 });
  }
  if (u.startsWith('https://api.twilio.com')) return reply(201, { sid: 'SM1' });
  if (u.startsWith('https://api.resend.com')) return reply(200, { id: 'em_1' });
  if (u.startsWith('https://geocoding-api.open-meteo.com')) return reply(200, {});
  if (u === 'https://bank.test/api/auth/login') return reply(200, { user: { role: 'staff' } }, { 'set-cookie': 'ab_session=abc; Path=/' });
  if (u === 'https://bank.test/api/dealers' && opts.method === 'POST') { bank.dealers.d1 = { id: 'd1', ...body }; return reply(201, { dealer: bank.dealers.d1 }); }
  if (u === 'https://bank.test/api/dealers/d1' && (opts.method || 'GET') === 'GET') {
    return reply(200, { dealer: { id: 'd1', contracts: [{ active: true, delivered: 7, target: 20 }] } });
  }
  if (u.startsWith('https://bank.test/api/dealers/d1')) return reply(201, { dealer: bank.dealers.d1 });
  if (u === 'https://bank.test/api/users' && opts.method === 'POST') { const user = { id: 'u1', ...body }; bank.users.push(user); return reply(201, { user }); }
  throw new Error(`Unexpected fetch: ${opts.method || 'GET'} ${u}`);
};

const { buildApp } = require('../src/app');
const { createUser } = require('../src/auth');
const { db } = require('../src/db');
const { mapFields, categoriesFrom, isShopperRole } = require('../src/fields');
const { prettyEntries } = require('../src/sources');
const { form } = require('../src/stripe');

let base; let server; let cookie; let mike; let leadId; let dealId;
async function http(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let payload = raw;
  if (body !== undefined && raw === undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await realFetch(`${base}${path}`, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = text; }
  return { status: res.status, json, headers: res.headers };
}
function stripeEvent(event) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${raw}`).digest('hex');
  return { method: 'POST', raw, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` } };
}

test.before(async () => {
  mike = await createUser({ email: 'mike@autobought.ca', name: 'Mike', password: 'mike-password-1', commission_rate: 0.2, notify_new_leads: true });
  await createUser({ email: 'rory@autobought.ca', name: 'Rory', role: 'admin', password: 'rory-password-1' });
  server = buildApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = (await http('/api/auth/login', { method: 'POST', body: { email: 'rory@autobought.ca', password: 'rory-password-1' } })).headers.get('set-cookie').split(';')[0];
});
test.after(() => server.close());

test('the new lander form ("Autobought Dealer Partner Program") maps cleanly', () => {
  const { fromJotform } = require('../src/sources');
  const sub = fromJotform({
    formID: '263114714910046', submissionID: '1',
    pretty: 'Full name:Jane Doe, Dealership name:Prairie Powersports, Your role:Sales Manager, Mobile phone:(403) 555-0199, Work email:jane@prairie.ca, Dealership city:Red Deer, Province:Alberta, What do you sell?:Powersports (ATVs, side-by-sides, sleds, motorcycles), How many leads do you want per month?:25-50, Anything else we should know?:Busy in spring, I agree that Autobought may contact me by phone, email or text about leads and its services.:Yes',
    rawRequest: JSON.stringify({
      q3_fullName: { first: 'Jane', last: 'Doe' }, q4_dealershipName: 'Prairie Powersports', q5_yourRole: 'Sales Manager',
      q6_mobilePhone: { full: '(403) 555-0199' }, q7_workEmail: 'jane@prairie.ca', q8_dealershipCity: 'Red Deer', q9_province: 'Alberta',
      q10_whatDo: ['Powersports (ATVs, side-by-sides, sleds, motorcycles)'], q11_howMany: '25-50', q12_anythingElse: 'Busy in spring',
      q13_iAgree: ['I agree that Autobought may contact me by phone, email or text about leads and its services.'],
      q14_utm_source: 'facebook', q16_utm_campaign: 'Dealer Signups', q17_utm_content: '120210000000001', q19_fbclid: 'abc',
    }),
  });
  const f = sub.fields;
  assert.equal(sub.source, 'B');
  assert.equal(f.name, 'Jane Doe');
  assert.equal(f.dealership, 'Prairie Powersports');
  assert.equal(f.role, 'Sales Manager');
  assert.equal(f.phone, '(403) 555-0199', 'the consent line mentions "phone" but does not steal the field');
  assert.equal(f.email, 'jane@prairie.ca');
  assert.equal(f.city, 'Red Deer');
  assert.equal(f.province, 'Alberta');
  assert.equal(f.leads_wanted_n, 50);
  assert.equal(f.message, 'Busy in spring');
  assert.equal(f.utm_source, 'facebook');
  assert.equal(f.utm_content, '120210000000001');
  assert.equal(f.fbclid, 'abc');
  assert.deepEqual(categoriesFrom(f.sells), ['powersport']);
  assert.deepEqual(categoriesFrom('Cars, trucks & SUVs, RVs, trailers & marine'), ['automotive', 'rv_marine']);
  assert.ok(isShopperRole("I'm shopping for a vehicle"));
  void mapFields; void prettyEntries;
});

test('Stripe form encoding handles nested fields', () => {
  assert.equal(form({ line_items: { 0: { price_data: { currency: 'cad', unit_amount: 2500 } } }, mode: 'subscription' }).toString(),
    'line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=cad&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=2500&mode=subscription');
});

test('signing with Stripe connected: payment link created, portal handoff waits for payment', async () => {
  const r = await http('/webhooks/lead', { method: 'POST', headers: { 'x-webhook-secret': 'flat-secret' }, body: { name: 'Bob Smith', phone: '7805550142', email: 'bob@smith.ca', city: 'Edmonton', dealership: 'Smith Auto', sells: 'used cars', external_id: 's1' } });
  leadId = r.json.lead_id;
  // The Signed form no longer takes commission; it comes from the account manager.
  const s = await http(`/api/leads/${leadId}/stage`, {
    method: 'POST',
    body: { stage: 'signed', deal: { package: 'essential', price_per_lead: 25, quotas: { automotive: 30 }, areas: [{ kind: 'province', province: 'AB' }], account_manager_id: mike.id } },
  });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const d = s.json.deal;
  dealId = d.id;
  assert.equal(d.commission_rate, 0.2, "Mike's default rate");
  assert.equal(d.handoff_status, 'awaiting_payment');
  assert.equal(d.payment_status, 'link_created');
  assert.equal(Object.keys(bank.dealers).length, 0, 'no lead bank dealer before payment');
  const checkout = calls.find((c) => c.url.endsWith('/checkout/sessions'));
  const p = new URLSearchParams(checkout.body.toString());
  assert.equal(checkout.headers.Authorization, 'Bearer sk_test_x');
  assert.equal(p.get('mode'), 'subscription');
  assert.equal(p.get('customer_email'), 'bob@smith.ca');
  assert.equal(p.get('line_items[0][quantity]'), '30');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '2500');
  assert.equal(p.get('line_items[0][price_data][currency]'), 'cad');
  assert.equal(p.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(p.get('metadata[deal_id]'), String(dealId));
});

test('the payment link can be texted to the dealer (same link, not a new one)', async () => {
  calls.length = 0;
  const r = await http(`/api/deals/${dealId}/payment-link`, { method: 'POST', body: { via: 'text' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sent, true);
  const sms = calls.find((c) => c.url.includes('twilio'));
  const b = new URLSearchParams(sms.body.toString());
  assert.equal(b.get('To'), '+17805550142');
  assert.match(b.get('Body'), /checkout\.stripe\.com\/c\/pay\/cs_test_1/);
  assert.ok(!calls.some((c) => c.url.endsWith('/checkout/sessions')), 'reused the open session');
  assert.equal(db.prepare('SELECT payment_status FROM deals WHERE id = ?').get(dealId).payment_status, 'link_sent');
});

test('Stripe webhook: bad signature refused; paid -> portal handoff runs; invoices recorded', async () => {
  const bad = await http('/webhooks/stripe', { method: 'POST', raw: '{}', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' } });
  assert.equal(bad.status, 400);

  const done = await http('/webhooks/stripe', stripeEvent({
    id: 'evt_1', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'cs_test_1', object: 'checkout.session', payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1', amount_total: 75000, currency: 'cad', client_reference_id: String(dealId), metadata: { deal_id: String(dealId) } } },
  }));
  assert.equal(done.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId);
  assert.equal(deal.payment_status, 'paid');
  assert.equal(deal.stripe_subscription_id, 'sub_1');
  assert.equal(deal.handoff_status, 'done', deal.handoff_error);
  assert.equal(bank.dealers.d1.name, 'Smith Auto');

  await http('/webhooks/stripe', stripeEvent({
    id: 'evt_2', type: 'invoice.paid', created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'in_1', object: 'invoice', customer: 'cus_1', subscription: 'sub_1', amount_paid: 75000, currency: 'cad', status_transitions: { paid_at: Math.floor(Date.now() / 1000) } } },
  }));
  assert.equal(db.prepare('SELECT SUM(amount) AS v FROM payments WHERE deal_id = ?').get(dealId).v, 750);

  await http('/webhooks/stripe', stripeEvent({ id: 'evt_3', type: 'invoice.payment_failed', created: 1, data: { object: { id: 'in_2', customer: 'cus_1', subscription: 'sub_1', amount_due: 75000 } } }));
  assert.equal(db.prepare('SELECT payment_status FROM deals WHERE id = ?').get(dealId).payment_status, 'past_due');
});

test('Overview: targets carry forward, actuals, accounting, leads delivered from the lead bank', async () => {
  const month = new Date().toISOString().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  db.prepare('INSERT INTO ad_spend (date, ad_id, spend, synced_at) VALUES (?, ?, ?, ?)').run(`${month}-01`, 'ad1', 300, new Date().toISOString());

  assert.equal((await http('/api/targets', { method: 'PUT', body: { month: prev, targets: { signed: 4, ad_budget: 2000, max_cpl: 50, dealer_leads: 'x' } } })).status, 400);
  assert.equal((await http('/api/targets', { method: 'PUT', body: { month: prev, targets: { signed: 4, ad_budget: 2000, max_cpl: 50 } } })).status, 200);

  const o = (await http(`/api/overview?month=${month}`)).json;
  assert.equal(o.targets.inherited_from, prev, 'last month\'s targets carry forward');
  const signed = o.cards.find((c) => c.key === 'signed');
  assert.equal(signed.actual, 1);
  assert.equal(signed.target, 4);
  const cpl = o.cards.find((c) => c.key === 'max_cpl');
  assert.equal(cpl.actual, 300, '$300 spend / 1 lead');
  assert.equal(cpl.status, 'behind');
  assert.equal(o.pnl.billed, 750);
  assert.equal(o.pnl.collected, 750);
  assert.equal(o.pnl.ad_spend, 300);
  assert.equal(o.pnl.commission, 150);
  assert.equal(o.pnl.margin, 300);
  assert.equal(o.pnl.leads_delivered, 7);
  const acct = o.accounts[0];
  assert.deepEqual(acct.delivered, { delivered: 7, target: 20 });
  assert.equal(acct.payment_status, 'past_due');
  assert.equal(o.by_manager[0].account_manager, 'Mike');
});

test('commission is changed on the Overview, and only by an admin', async () => {
  const ok = await http(`/api/deals/${dealId}`, { method: 'PATCH', body: { commission_rate: 0.15 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.deal.commission_rate, 0.15);
  const saved = cookie;
  cookie = (await http('/api/auth/login', { method: 'POST', body: { email: 'mike@autobought.ca', password: 'mike-password-1' } })).headers.get('set-cookie').split(';')[0];
  assert.equal((await http(`/api/deals/${dealId}`, { method: 'PATCH', body: { commission_rate: 0.5 } })).status, 403);
  assert.equal((await http('/api/overview')).status, 403);
  assert.equal((await http(`/api/deals/${dealId}`, { method: 'PATCH', body: { status: 'paused' } })).status, 200, 'reps can still pause a deal');
  cookie = saved;
  assert.equal((await http('/paid.html')).status, 200, 'the post-payment page is public');
});
