// End-to-end tests: the real app on a random port, with Meta, Twilio,
// Resend and the lead bank replaced by a fake `fetch`.

process.env.DATA_DIR = ':memory:';
process.env.RUN_SCHEDULER = 'false';
process.env.APP_URL = 'https://crm.test';
process.env.WEBHOOK_SECRET = 'flat-secret';
process.env.JOTFORM_WEBHOOK_SECRET = 'jot-secret';
process.env.META_VERIFY_TOKEN = 'verify-me';
process.env.META_APP_SECRET = 'app-secret';
process.env.META_PAGE_TOKEN = 'page-token';
process.env.META_ADS_TOKEN = 'ads-token';
process.env.META_AD_ACCOUNT_ID = 'act_111';
process.env.META_DATASET_ID = '999';
process.env.META_CAPI_TOKEN = 'capi-token';
process.env.RESEND_API_KEY = 're_test';
process.env.TWILIO_ACCOUNT_SID = 'AC1';
process.env.TWILIO_AUTH_TOKEN = 'tok';
process.env.TWILIO_FROM = '+15875550000';
process.env.LEADBANK_URL = 'https://bank.test';
process.env.LEADBANK_EMAIL = 'crm@autobought.ca';
process.env.LEADBANK_PASSWORD = 'bank-password';
process.env.LEADBANK_WEBHOOK_SECRET = 'bank-secret';
process.env.CONSUMER_FUNNEL_ID = 'consumer-funnel';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// --- The fake outside world ---------------------------------------------------
const realFetch = global.fetch;
const calls = [];
const bank = { dealers: {}, contracts: [], users: [], consumer: [] };
let metaLeads = {};
let failNextResend = false;

function reply(status, json, headers = {}) {
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
}

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  const body = opts.body && typeof opts.body === 'string' ? (() => { try { return JSON.parse(opts.body); } catch (e) { return opts.body; } })() : opts.body;
  calls.push({ url: u, method: opts.method || 'GET', body, headers: opts.headers || {} });

  if (u.startsWith('https://api.twilio.com')) return reply(201, { sid: 'SM1' });
  if (u.startsWith('https://api.resend.com')) {
    if (failNextResend) { failNextResend = false; return reply(422, { message: 'domain not verified' }); }
    return reply(200, { id: 'em_1' });
  }
  if (/graph\.facebook\.com\/v[\d.]+\/999\/events/.test(u)) return reply(200, { events_received: 1 });
  const leadMatch = u.match(/graph\.facebook\.com\/v[\d.]+\/(\d+)\?fields=/);
  if (leadMatch) return metaLeads[leadMatch[1]] ? reply(200, metaLeads[leadMatch[1]]) : reply(400, { error: { message: 'no such lead' } });
  if (u.includes('/act_111/adsets')) {
    return reply(200, { data: [
      { id: 'as1', name: 'Dealers IF', destination_type: 'ON_AD', campaign: { id: 'c1', name: 'Dealer Signups' } },
      { id: 'as2', name: 'Dealers LP', destination_type: 'WEBSITE', campaign: { id: 'c1', name: 'Dealer Signups' } },
    ] });
  }
  if (u.includes('/act_111/ads')) return reply(200, { data: [{ id: 'ad1', name: 'Video A', adset_id: 'as1', campaign_id: 'c1' }, { id: 'ad2', name: 'Carousel B', adset_id: 'as2', campaign_id: 'c1' }] });
  if (u.includes('/act_111/insights')) {
    return reply(200, { data: [
      { date_start: today(), ad_id: 'ad1', ad_name: 'Video A', adset_id: 'as1', adset_name: 'Dealers IF', campaign_id: 'c1', campaign_name: 'Dealer Signups', spend: '120.00', impressions: '5000', clicks: '80' },
      { date_start: today(), ad_id: 'ad2', ad_name: 'Carousel B', adset_id: 'as2', adset_name: 'Dealers LP', campaign_id: 'c1', campaign_name: 'Dealer Signups', spend: '60.00', impressions: '3000', clicks: '40' },
    ] });
  }

  // The lead bank.
  if (u === 'https://bank.test/api/auth/login') {
    return reply(200, { user: { role: 'staff' } }, { 'set-cookie': 'ab_session=abc; Path=/; HttpOnly' });
  }
  if (u === 'https://bank.test/api/webhook/lead') {
    if (opts.headers['x-webhook-secret'] !== 'bank-secret') return reply(401, { error: 'bad secret' });
    bank.consumer.push(body);
    return reply(201, { lead: { id: 'bank-lead-1' } });
  }
  if (u.startsWith('https://bank.test/api/')) {
    assert.equal(opts.headers.Cookie, 'ab_session=abc');
    const path = u.replace('https://bank.test', '');
    if (path === '/api/dealers' && opts.method === 'POST') {
      const id = `d${Object.keys(bank.dealers).length + 1}`;
      bank.dealers[id] = { id, ...body };
      return reply(201, { dealer: bank.dealers[id] });
    }
    let m = path.match(/^\/api\/dealers\/([^/]+)$/);
    if (m && opts.method === 'PATCH') { Object.assign(bank.dealers[m[1]], body); return reply(200, { dealer: bank.dealers[m[1]] }); }
    m = path.match(/^\/api\/dealers\/([^/]+)\/contracts$/);
    if (m) { bank.contracts.push({ dealer_id: m[1], ...body }); return reply(201, {}); }
    if (path === '/api/users' && opts.method === 'POST') {
      if (bank.users.find((x) => x.email === body.email)) return reply(409, { error: 'exists' });
      const user = { id: `u${bank.users.length + 1}`, ...body };
      bank.users.push(user);
      return reply(201, { user });
    }
    if (path === '/api/users') return reply(200, { users: bank.users });
    m = path.match(/^\/api\/users\/([^/]+)\/password$/);
    if (m) { bank.users.find((x) => x.id === m[1]).password = body.password; return reply(200, { ok: true }); }
  }
  throw new Error(`Unexpected fetch in test: ${opts.method || 'GET'} ${u}`);
};

const today = () => new Date().toISOString().slice(0, 10);

// --- The app ---------------------------------------------------------------------
const { buildApp } = require('../src/app');
const { createUser } = require('../src/auth');
const { db } = require('../src/db');
const { mapFields, categoriesFrom, isShopperRole } = require('../src/fields');
const { prettyEntries } = require('../src/sources');
const { hashedUserData, sha256 } = require('../src/capi');

let base;
let cookie;
let server;
let mike;

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

function jotformForm(answers, extra = {}) {
  const fd = new FormData();
  fd.append('formID', '262247338358060');
  fd.append('submissionID', extra.submissionID || String(Date.now() + Math.random()));
  fd.append('rawRequest', JSON.stringify(answers));
  if (extra.pretty) fd.append('pretty', extra.pretty);
  return fd;
}

test.before(async () => {
  mike = await createUser({ email: 'mike@autobought.ca', name: 'Mike', password: 'mike-password-1', phone: '780-555-0100', commission_rate: 0.2, notify_new_leads: true });
  await createUser({ email: 'rory@emarket.digital', name: 'Rory', role: 'admin', password: 'rory-password-1' });
  server = buildApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await http('/api/auth/login', { method: 'POST', body: { email: 'rory@emarket.digital', password: 'rory-password-1' } });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});
test.after(() => server.close());

// --- Unit-level ---------------------------------------------------------------------

test('field mapping reads both Jotform forms and Meta names', () => {
  const a = mapFields(prettyEntries('Contact name:Jane Doe, Dealership or company name:Prairie Powersports, Business email:Jane@Prairie.ca, Mobile phone number:(403) 555-0199, Dealership city:Red Deer, Your Market:Central Alberta, What does your dealership sell?:ATVs, side-by-sides and sleds, How many leads are you looking for each month?:25-50'));
  assert.equal(a.name, 'Jane Doe');
  assert.equal(a.dealership, 'Prairie Powersports');
  assert.equal(a.email, 'Jane@Prairie.ca');
  assert.equal(a.phone, '(403) 555-0199');
  assert.equal(a.city, 'Red Deer');
  assert.equal(a.leads_wanted_n, 50);
  assert.deepEqual(categoriesFrom(a.sells), ['powersport']);

  const b = mapFields([['full_name', 'Bob Smith'], ['phone_number', '+17805550142'], ['work_email', 'bob@smithauto.ca'], ['city', 'Edmonton'],
    ['dealership_name', 'Smith Auto'], ['what_best_describes_you?', 'Sales manager'], ['what_do_you_sell?', 'Used cars and trucks'], ['how_many_leads_per_month_do_you_want?', '20']]);
  assert.equal(b.dealership, 'Smith Auto');
  assert.equal(b.role, 'Sales manager');
  assert.equal(b.sells, 'Used cars and trucks');
  assert.equal(b.leads_wanted, '20');
  assert.ok(isShopperRole('I’m shopping for a vehicle'));
  assert.ok(isShopperRole("I'm shopping for a vehicle"));
  assert.ok(!isShopperRole('Owner'));
  assert.deepEqual(categoriesFrom('RVs, boats and trailers'), ['rv_marine']);
});

test('CAPI user data is normalised and hashed the way Meta asks', () => {
  const ud = hashedUserData({ email: ' Bob@SmithAuto.ca ', phone: '(780) 555-0142', name: 'Bob Smith', city: 'Red Deer', province: 'AB', meta_lead_id: '123456' });
  assert.deepEqual(ud.em, [sha256('bob@smithauto.ca')]);
  assert.deepEqual(ud.ph, [sha256('17805550142')]);
  assert.deepEqual(ud.fn, [sha256('bob')]);
  assert.deepEqual(ud.ln, [sha256('smith')]);
  assert.deepEqual(ud.ct, [sha256('reddeer')]);
  assert.equal(ud.lead_id, 123456);
});

// --- Intake ------------------------------------------------------------------------------

test('webhooks refuse missing secrets', async () => {
  assert.equal((await http('/webhooks/jotform', { method: 'POST', raw: jotformForm({}) })).status, 401);
  assert.equal((await http('/webhooks/lead', { method: 'POST', body: { name: 'x' } })).status, 401);
  assert.equal((await http('/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
  const ok = await http('/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=4242');
  assert.equal(ok.json, 4242);
});

let landingLeadId;
test('landing page (B) lead via Jotform: fields, UTMs, market, and Mike is texted + emailed', async () => {
  calls.length = 0;
  const res = await http('/webhooks/jotform?secret=jot-secret', {
    method: 'POST',
    raw: jotformForm({
      q3_contactName: { first: 'Bob', last: 'Smith' }, q4_dealershipOr: 'Smith Auto Sales', q5_businessEmail: 'bob@smithauto.ca',
      q6_mobilePhone: { full: '(780) 555-0142' }, q9_dealershipCity: 'Sherwood Park', q10_province: 'Alberta',
      q8_whatDo: 'Used cars, trucks and SUVs', q18_howMany: '30', q30_utm_source: 'facebook', q31_utm_campaign: 'Dealer Signups',
      q32_utm_content: 'Carousel B', q33_utm_term: 'Dealers LP', q34_role: 'General Manager',
    }, { submissionID: 'sub-1' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.outcome, 'new');
  const lead = db.prepare('SELECT * FROM leads').get();
  landingLeadId = lead.id;
  assert.equal(lead.source, 'B');
  assert.equal(lead.name, 'Bob Smith');
  assert.equal(lead.dealership, 'Smith Auto Sales');
  assert.equal(lead.phone_key, '7805550142');
  assert.equal(lead.province, 'AB');
  assert.equal(lead.categories, 'automotive');
  assert.equal(lead.utm_content, 'Carousel B');
  assert.equal(lead.role, 'General Manager');
  const market = db.prepare('SELECT name FROM markets WHERE id = ?').get(lead.market_id);
  assert.equal(market.name, 'Edmonton', 'Sherwood Park is an alias of Edmonton');
  assert.equal(lead.owner_id, mike.id);

  const sms = calls.find((c) => c.url.includes('twilio'));
  assert.ok(sms, 'texted');
  const smsBody = new URLSearchParams(sms.body);
  assert.equal(smsBody.get('To'), '+17805550100');
  assert.match(smsBody.get('Body'), /Bob Smith – Smith Auto Sales, Sherwood Park/);
  assert.match(smsBody.get('Body'), /Call: \+17805550142/);
  const email = calls.find((c) => c.url.includes('resend'));
  assert.deepEqual(email.body.to, ['mike@autobought.ca']);
  assert.match(email.body.html, /href="tel:\+17805550142"/);

  // Jotform retrying the same submission does not make a second lead.
  const again = await http('/webhooks/jotform?secret=jot-secret', { method: 'POST', raw: jotformForm({ q3_contactName: 'Bob' }, { submissionID: 'sub-1' }) });
  assert.equal(again.json.received, 'already received');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 1);
});

function signedMeta(body) {
  const raw = JSON.stringify(body);
  const sig = `sha256=${crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
  return { method: 'POST', raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } };
}
const waitFor = async (fn) => { for (let i = 0; i < 50; i += 1) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return fn(); };

let metaLeadId;
test('Instant Form (A) lead via Meta webhook: answers and campaign/ad set/ad fetched from the Graph API', async () => {
  metaLeads['5551'] = {
    id: '5551', created_time: '2026-11-07T15:00:00+0000', ad_id: 'ad1', ad_name: 'Video A', adset_id: 'as1', adset_name: 'Dealers IF',
    campaign_id: 'c1', campaign_name: 'Dealer Signups', form_id: 'f1',
    field_data: [
      { name: 'full_name', values: ['Jane Doe'] }, { name: 'phone_number', values: ['+14035550199'] },
      { name: 'work_email', values: ['jane@prairiepower.ca'] }, { name: 'city', values: ['Red Deer'] },
      { name: 'dealership_name', values: ['Prairie Powersports'] }, { name: 'what_is_your_role?', values: ['Owner'] },
      { name: 'what_do_you_sell?', values: ['ATVs and snowmobiles'] }, { name: 'how_many_leads_per_month?', values: ['10-20'] },
    ],
  };
  const body = { object: 'page', entry: [{ id: 'p1', time: 1, changes: [{ field: 'leadgen', value: { leadgen_id: '5551', form_id: 'f1', ad_id: 'ad1', created_time: 1762527600 } }] }] };

  const bad = await http('/webhooks/meta', { ...signedMeta(body), headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=nope' } });
  assert.equal(bad.status, 401);

  const res = await http('/webhooks/meta', signedMeta(body));
  assert.equal(res.status, 200);
  const lead = await waitFor(() => db.prepare("SELECT * FROM leads WHERE meta_lead_id = '5551'").get());
  assert.ok(lead, 'lead created');
  metaLeadId = lead.id;
  assert.equal(lead.source, 'A');
  assert.equal(lead.created_at, '2026-11-07T15:00:00.000Z');
  assert.equal(lead.campaign_name, 'Dealer Signups');
  assert.equal(lead.adset_name, 'Dealers IF');
  assert.equal(lead.ad_id, 'ad1');
  assert.equal(lead.categories, 'powersport');
  assert.equal(lead.leads_wanted_n, 20);
  assert.equal(db.prepare('SELECT name FROM markets WHERE id = ?').get(lead.market_id).name, 'Red Deer');
});

test('duplicates merge on phone or email, keeping the first source', async () => {
  const res = await http('/webhooks/lead', {
    method: 'POST', headers: { 'x-webhook-secret': 'flat-secret' },
    body: { source: 'B', name: 'Jane D', phone: '403.555.0199', website: 'prairiepower.ca', external_id: 'zap-1' },
  });
  assert.equal(res.json.outcome, 'merged');
  assert.equal(res.json.lead_id, metaLeadId);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(metaLeadId);
  assert.equal(lead.submissions, 2);
  assert.equal(lead.source, 'A');
  assert.equal(lead.name, 'Jane Doe', 'known fields are not overwritten');
  assert.equal(lead.website, 'prairiepower.ca', 'unknown fields are filled in');

  const byEmail = await http('/webhooks/lead', { method: 'POST', headers: { 'x-webhook-secret': 'flat-secret' }, body: { email: 'BOB@smithauto.ca', external_id: 'zap-2' } });
  assert.equal(byEmail.json.lead_id, landingLeadId);
});

test('"I\'m shopping for a vehicle" goes to the consumer funnel, never the dealer pipeline', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM leads').get().n;
  const res = await http('/webhooks/lead', {
    method: 'POST', headers: { 'x-webhook-secret': 'flat-secret' },
    body: { source: 'A', full_name: 'Sam Shopper', phone_number: '5875550111', email: 'sam@gmail.com', city: 'Calgary', role: "I'm shopping for a vehicle", external_id: '7777' },
  });
  assert.equal(res.json.outcome, 'consumer');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, before);
  assert.equal(bank.consumer.length, 1);
  assert.equal(bank.consumer[0].funnel_id, 'consumer-funnel');
  assert.equal(bank.consumer[0].name, 'Sam Shopper');
  assert.equal(bank.consumer[0].source_ref, 'crm:A:7777');
});

test('a Meta lookup failure is kept and retried, not lost', async () => {
  const body = { entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: '8888' } }] }] };
  await http('/webhooks/meta', signedMeta(body));
  const row = await waitFor(() => db.prepare("SELECT * FROM inbox WHERE external_id = '8888' AND attempts > 0").get());
  assert.equal(row.status, 'pending');
  assert.match(row.error, /no such lead/);
  metaLeads['8888'] = { id: '8888', field_data: [{ name: 'full_name', values: ['Late Larry'] }, { name: 'phone_number', values: ['2045550123'] }] };
  await require('../src/intake').retryPending();
  assert.equal(db.prepare("SELECT status FROM inbox WHERE external_id = '8888'").get().status, 'done');
  assert.ok(db.prepare("SELECT 1 FROM leads WHERE name = 'Late Larry'").get());
});

// --- Pipeline -----------------------------------------------------------------------------

test('Lost needs a reason from the list; Other needs a note', async () => {
  const larry = db.prepare("SELECT id FROM leads WHERE name = 'Late Larry'").get().id;
  let r = await http(`/api/leads/${larry}/stage`, { method: 'POST', body: { stage: 'lost' } });
  assert.equal(r.status, 400);
  r = await http(`/api/leads/${larry}/stage`, { method: 'POST', body: { stage: 'lost', lost_reason: 'Other' } });
  assert.equal(r.status, 400);
  r = await http(`/api/leads/${larry}/stage`, { method: 'POST', body: { stage: 'lost', lost_reason: 'Not a dealer' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.lead.lost_reason, 'Not a dealer');
  assert.equal(r.json.lead.first_contact_at, null, 'losing a lead is not contacting it');
});

test('logging a call records first contact and moves New to Contacted', async () => {
  const r = await http(`/api/leads/${landingLeadId}/activities`, { method: 'POST', body: { type: 'call', body: 'Left voicemail' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.lead.stage, 'contacted');
  assert.ok(r.json.lead.first_contact_at);
  const note = await http(`/api/leads/${landingLeadId}/activities`, { method: 'POST', body: { type: 'note', body: 'Wants 30/mo, used inventory' } });
  assert.equal(note.status, 201);
  const detail = await http(`/api/leads/${landingLeadId}`);
  assert.ok(detail.json.activities.some((a) => a.type === 'note' && a.body === 'Wants 30/mo, used inventory'));
  assert.ok(detail.json.activities.some((a) => a.type === 'stage'));
  assert.equal(typeof detail.json.lead.minutes_to_first_contact, 'number');
  const list = await http('/api/leads?stage=contacted');
  assert.equal(list.json.leads.length, 1);
  assert.equal(typeof list.json.average_minutes_to_first_contact, 'number');
});

test('Working sends a CRM event to Meta, once', async () => {
  calls.length = 0;
  const r = await http(`/api/leads/${metaLeadId}/stage`, { method: 'POST', body: { stage: 'working' } });
  assert.equal(r.status, 200);
  const sent = calls.filter((c) => c.url.includes('/999/events'));
  assert.equal(sent.length, 1);
  const ev = sent[0].body.data[0];
  assert.equal(ev.event_name, 'Working');
  assert.equal(ev.action_source, 'system_generated');
  assert.equal(ev.user_data.lead_id, 5551);
  assert.deepEqual(ev.user_data.em, [sha256('jane@prairiepower.ca')]);
  assert.equal(ev.custom_data.event_source, 'crm');
  // Out and back in: not sent again.
  await http(`/api/leads/${metaLeadId}/stage`, { method: 'POST', body: { stage: 'contacted' } });
  await http(`/api/leads/${metaLeadId}/stage`, { method: 'POST', body: { stage: 'working' } });
  assert.equal(calls.filter((c) => c.url.includes('/999/events')).length, 1);
});

test('Signed: deal saved, lead bank dealer + contracts + portal login created, welcome emailed, market taken', async () => {
  const redDeer = db.prepare("SELECT id FROM markets WHERE name = 'Red Deer'").get().id;
  const bad = await http(`/api/leads/${metaLeadId}/stage`, { method: 'POST', body: { stage: 'signed', deal: { price_per_lead: 30, market_ids: [redDeer] } } });
  assert.equal(bad.status, 400, 'needs a quota');

  calls.length = 0;
  failNextResend = false;
  const r = await http(`/api/leads/${metaLeadId}/stage`, {
    method: 'POST',
    body: { stage: 'signed', deal: { package: 'application', price_per_lead: 35, quotas: { powersport: 20 }, market_ids: [redDeer], account_manager_id: mike.id, start_date: '2026-11-01' } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = r.json.deal;
  assert.equal(d.handoff_status, 'done', d.handoff_error);
  assert.equal(d.monthly_value, 700);
  assert.equal(d.commission_rate, 0.2);
  assert.equal(d.leads_per_month, 20);

  const dealer = bank.dealers[d.lb_dealer_id];
  assert.equal(dealer.name, 'Prairie Powersports');
  assert.equal(dealer.provinces, 'AB');
  assert.equal(dealer.notify_emails, 'jane@prairiepower.ca');
  assert.equal(dealer.account_manager, 'Mike');
  assert.deepEqual(bank.contracts.map((c) => [c.vehicle_category, c.info_depth, c.monthly_quota]), [['powersport', 'application', 20]]);
  const user = bank.users.find((u) => u.id === d.lb_user_id);
  assert.equal(user.role, 'dealer');
  assert.equal(user.dealer_id, d.lb_dealer_id);
  const welcome = calls.find((c) => c.url.includes('resend') && c.body.to.includes('jane@prairiepower.ca'));
  assert.ok(welcome, 'welcome email sent');
  assert.ok(welcome.body.text.includes(user.password), 'welcome email carries the working password');
  assert.match(welcome.body.text, /https:\/\/bank\.test\/login\.html/);
  assert.ok(welcome.body.bcc.includes('mike@autobought.ca'));

  // Signed teaches Meta "Signed" (Working was already sent).
  assert.deepEqual(calls.filter((c) => c.url.includes('/999/events')).map((c) => c.body.data[0].event_name), ['Signed']);

  // Another powersport dealer in Red Deer now sees it taken.
  const other = await http('/webhooks/lead', { method: 'POST', headers: { 'x-webhook-secret': 'flat-secret' }, body: { name: 'Rival Rick', phone: '4035550777', city: 'Lacombe', sells: 'Snowmobiles and boats', dealership: 'Rick Rides', external_id: 'zap-3' } });
  const av = (await http(`/api/leads/${other.json.lead_id}`)).json.availability;
  assert.equal(av.market.name, 'Red Deer');
  assert.deepEqual(av.categories.map((c) => [c.category, c.status]), [['powersport', 'taken'], ['rv_marine', 'open']]);
  assert.equal(av.categories[0].dealer, 'Prairie Powersports');
  const map = (await http('/api/markets')).json.markets.find((m) => m.name === 'Red Deer');
  assert.equal(map.cells.find((c) => c.category === 'powersport').status, 'taken');
});

test('a failed welcome email stops the handoff, and Retry finishes it with a fresh password', async () => {
  const edm = db.prepare("SELECT id FROM markets WHERE name = 'Edmonton'").get().id;
  failNextResend = true;
  const r = await http(`/api/leads/${landingLeadId}/stage`, {
    method: 'POST',
    body: { stage: 'signed', deal: { package: 'essential', price_per_lead: 25, quotas: { automotive: 30 }, market_ids: [edm] } },
  });
  assert.equal(r.json.deal.handoff_status, 'failed');
  assert.match(r.json.deal.handoff_error, /domain not verified/);
  const dealersBefore = Object.keys(bank.dealers).length;
  const retry = await http(`/api/leads/${landingLeadId}/handoff`, { method: 'POST' });
  assert.equal(retry.json.deal.handoff_status, 'done');
  assert.equal(Object.keys(bank.dealers).length, dealersBefore, 'no second dealer');
  const user = bank.users.find((u) => u.email === 'bob@smithauto.ca');
  const welcome = calls.filter((c) => c.url.includes('resend') && c.body.to.includes('bob@smithauto.ca')).pop();
  assert.ok(welcome.body.text.includes(user.password), 'the reset password is the one emailed');
});

// --- Dashboard and revenue -------------------------------------------------------------------

test('ad spend sync and cost per lead / Working / Signed by source and ad', async () => {
  const sync = await http('/api/ads/sync', { method: 'POST', body: {} });
  assert.equal(sync.status, 200, JSON.stringify(sync.json));
  // The Meta lead was created 2026-11-07 per Meta; move it into today's window for a single-day check.
  db.prepare('UPDATE leads SET created_at = ? WHERE id = ?').run(new Date().toISOString(), metaLeadId);
  const d = (await http(`/api/dashboard?from=${today()}&to=${today()}`)).json;
  const A = d.sources.find((s) => s.source === 'A');
  const B = d.sources.find((s) => s.source === 'B');
  assert.equal(A.spend, 120);
  assert.equal(B.spend, 60);
  assert.equal(A.leads, 2, 'Jane and Larry came through Instant Forms today');
  assert.equal(A.cost_per_lead, 60);
  assert.equal(A.cost_per_working, 120);
  assert.equal(A.cost_per_signed, 120);
  const ad2 = d.ads.find((a) => a.ad_id === 'ad2');
  assert.equal(ad2.source, 'B');
  assert.equal(ad2.leads, 1, 'the landing page lead was credited to Carousel B through its UTM');
  assert.equal(ad2.cost_per_signed, 60);

  // A wrong guess can be overridden.
  await http('/api/ads/ad2/source', { method: 'POST', body: { source: 'A' } });
  const d2 = (await http(`/api/dashboard?from=${today()}&to=${today()}`)).json;
  assert.equal(d2.sources.find((s) => s.source === 'A').spend, 180);
});

test('monthly revenue and commission (Mike 20%)', async () => {
  const r = (await http('/api/revenue?month=2026-11')).json;
  assert.equal(r.totals.deals, 2);
  assert.equal(r.totals.revenue, 700 + 750);
  const m = r.by_manager.find((x) => x.account_manager === 'Mike');
  assert.equal(m.commission, (700 + 750) * 0.2);
  const oct = (await http('/api/revenue?month=2026-10')).json;
  assert.equal(oct.totals.deals, 0, 'not billing before the start date');

  // Cancelling ends billing after this month.
  const deal = db.prepare('SELECT id FROM deals WHERE lead_id = ?').get(landingLeadId);
  await http(`/api/deals/${deal.id}`, { method: 'PATCH', body: { status: 'cancelled', end_date: '2026-11-30' } });
  assert.equal((await http('/api/revenue?month=2026-12')).json.totals.deals, 1);
  // ...and frees the market.
  const edm = (await http('/api/markets')).json.markets.find((x) => x.name === 'Edmonton');
  assert.equal(edm.cells.find((c) => c.category === 'automotive').status, 'open');
});

test('pages need a sign-in', async () => {
  const saved = cookie;
  cookie = null;
  const page = await http('/index.html', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 302);
  assert.equal((await http('/api/leads')).status, 401);
  assert.equal((await http('/login.html')).status, 200);
  cookie = saved;
});
