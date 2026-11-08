// npm run demo - fills an EMPTY database with made-up leads, signed dealers
// and ad spend, so the screens can be tried out. Refuses to touch a database
// that already has leads. Every name, phone and email here is fictional.
//
// Logins it creates:  rory@autobought.ca and mike@autobought.ca, with the
// password in DEMO_PASSWORD (default demo-password-1 for local use only).
//
// A hosted copy can seed itself on first boot: set SEED_DEMO=true and a
// DEMO_PASSWORD of at least 10 characters (see server.js).

// While seeding, nothing may leave the building: no texts, emails, lead bank,
// Meta or Stripe calls, whatever keys are set. Restored afterwards.
const QUIET = ['RESEND_API_KEY', 'TWILIO_ACCOUNT_SID', 'LEADBANK_URL', 'META_DATASET_ID', 'META_CAPI_TOKEN', 'STRIPE_SECRET_KEY'];

const { db } = require('../src/db');
const { createUser } = require('../src/auth');
const intake = require('../src/intake');
const pipeline = require('../src/pipeline');

const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const LEADS = [
  // [source, name, dealership, city, province, sells, leads/mo, role, ad, days ago, stage, minutes to first contact]
  ['A', 'Jane Doe', 'Prairie Powersports', 'Red Deer', 'AB', 'ATVs, side-by-sides and sleds', '20', 'Owner', 'ad1', 21, 'signed', 4],
  ['B', 'Bob Smith', 'Smith Auto Sales', 'Sherwood Park', 'AB', 'Used cars and trucks', '30', 'General Manager', 'ad3', 18, 'signed', 7],
  ['A', 'Priya Natt', 'Bow River RV', 'Calgary', 'AB', 'RVs, trailers and boats', '15', 'Sales Manager', 'ad2', 15, 'signed', 3],
  ['A', 'Dan Wiebe', 'Prairie Auto Finance', 'Saskatoon', 'SK', 'Pre-owned cars', '40', 'F&I Manager', 'ad1', 12, 'working', 11],
  ['B', 'Marc Leblanc', 'Leblanc Motors', 'Regina', 'SK', 'New and used trucks', '25', 'Owner', 'ad3', 10, 'working', 26],
  ['A', 'Rick Moreau', 'Rick Rides', 'Lacombe', 'AB', 'Snowmobiles and dirt bikes', '10', 'Owner', 'ad2', 8, 'contacted', 5],
  ['A', 'Sara Kim', 'Coast Auto Group', 'Kelowna', 'BC', 'Used cars, SUVs', '50', 'Sales Manager', 'ad1', 7, 'contacted', 42],
  ['B', 'Tom Becker', 'Becker Marine', 'Kamloops', 'BC', 'Boats and pontoons', '10', 'Owner', 'ad4', 6, 'lost', 9, 'Went with competitor'],
  ['A', 'Lee Chan', 'Northside Cars', 'Edmonton', 'AB', 'Used cars', '20', 'Finance Manager', 'ad1', 5, 'lost', null, 'No response'],
  ['A', 'Nina Patel', '', 'Calgary', 'AB', '', '', 'Salesperson', 'ad2', 4, 'lost', 2, 'Wrong person'],
  ['B', 'Greg Olson', 'Olson Power & Marine', 'Lethbridge', 'AB', 'ATVs, boats', '15', 'Owner', 'ad4', 3, 'working', 6],
  ['A', 'Amy Tran', 'Winnipeg Auto Credit', 'Winnipeg', 'MB', 'Used cars', '35', 'General Manager', 'ad1', 2, 'contacted', 14],
  ['A', 'Kyle Dube', 'Dube Motorsports', 'Grande Prairie', 'AB', 'Motorcycles and side-by-sides', '12', 'Owner', 'ad2', 1, 'new', null],
  ['B', 'Erin Walsh', 'Walsh RV Centre', 'Medicine Hat', 'AB', 'Travel trailers and fifth wheels', '10', 'Sales Manager', 'ad4', 0.03, 'new', null],
  ['A', 'Owen Price', 'Price Auto', 'Prince Albert', 'SK', 'Used trucks', '20', 'Owner', 'ad1', 0.008, 'new', null],
];

const ADS = [
  ['ad1', 'Dealer video – "More leads"', 'as1', 'Dealers – Instant Form', 'ON_AD', 28],
  ['ad2', 'Carousel – Powersport', 'as1', 'Dealers – Instant Form', 'ON_AD', 17],
  ['ad3', 'Lander – Automotive', 'as2', 'Dealers – Landing page', 'WEBSITE', 14],
  ['ad4', 'Lander – RV & Marine', 'as2', 'Dealers – Landing page', 'WEBSITE', 9],
];

async function seedDemo({ password = 'demo-password-1' } = {}) {
  if (db.prepare('SELECT COUNT(*) AS n FROM leads').get().n > 0 || db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
    throw new Error('This database already has data. The demo only fills an empty one.');
  }
  if (String(password).length < 10) throw new Error('The demo password needs at least 10 characters.');
  const saved = Object.fromEntries(QUIET.map((k) => [k, process.env[k]]));
  for (const k of QUIET) delete process.env[k];
  try {
    await fill(password);
  } finally {
    for (const k of QUIET) if (saved[k] !== undefined) process.env[k] = saved[k];
  }
}

async function fill(password) {
  await createUser({ email: 'rory@autobought.ca', name: 'Rory', role: 'admin', password, commission_rate: 0 });
  const mike = await createUser({ email: 'mike@autobought.ca', name: 'Mike', password, phone: '7805550100', commission_rate: 0.2, notify_new_leads: true });

  for (const [id, name, adsetId, adsetName, dest] of ADS) {
    db.prepare('INSERT INTO ads (ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, destination_type, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, adsetId, adsetName, 'c1', 'Dealer Signups', dest, ago(0));
  }
  for (let n = 0; n < 30; n += 1) {
    for (const [id, name, adsetId, adsetName, , daily] of ADS) {
      const spend = Math.round(daily * (0.7 + ((n * 7 + id.length * 3) % 10) / 15) * 100) / 100;
      db.prepare('INSERT INTO ad_spend (date, ad_id, campaign_id, campaign_name, adset_id, adset_name, ad_name, spend, impressions, clicks, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(day(n), id, 'c1', 'Dealer Signups', adsetId, adsetName, name, spend, Math.round(spend * 45), Math.round(spend * 0.9), ago(0));
    }
  }

  const actor = { id: mike.id };
  const areasFor = {
    'Prairie Powersports': [{ kind: 'radius', name: 'Red Deer', lat: 52.269, lng: -113.812, radius_km: 80 }],
    'Smith Auto Sales': [{ kind: 'radius', name: 'Edmonton', lat: 53.546, lng: -113.494, radius_km: 100 }, { kind: 'radius', name: 'Red Deer', lat: 52.269, lng: -113.812, radius_km: 40 }],
    'Bow River RV': [{ kind: 'province', province: 'AB' }],
  };
  const prices = { 'Prairie Powersports': [35, 'application', 'powersport'], 'Smith Auto Sales': [25, 'essential', 'automotive'], 'Bow River RV': [30, 'essential', 'rv_marine'] };

  for (const [source, name, dealership, city, province, sells, wanted, role, ad, daysAgo, stage, firstMins, lostReason] of LEADS) {
    const first = name.split(' ')[0].toLowerCase();
    const adRow = ADS.find((a) => a[0] === ad);
    const created = ago(daysAgo * 1440);
    const r = await intake.handleSubmission({
      source,
      external_id: `demo-${first}`,
      created_at: created,
      fields: {
        name, dealership: dealership || undefined, city, province, sells: sells || undefined, leads_wanted: wanted || undefined, role,
        phone: `403555${String(1000 + LEADS.findIndex((l) => l[1] === name) * 37).slice(-4)}`,
        email: dealership ? `${first}@${dealership.toLowerCase().replace(/[^a-z]/g, '')}.example` : `${first}@example.com`,
        leads_wanted_n: wanted ? Number(wanted) : undefined,
        utm_source: source === 'B' ? 'facebook' : undefined, utm_content: source === 'B' ? ad : undefined,
      },
      attribution: source === 'A' ? { meta_lead_id: String(9000 + daysAgo), ad_id: ad, ad_name: adRow[1], adset_id: adRow[2], adset_name: adRow[3], campaign_id: 'c1', campaign_name: 'Dealer Signups' } : {},
      raw: {},
    });
    const lead = r.lead;
    db.prepare('UPDATE leads SET created_at = ?, received_at = ? WHERE id = ?').run(created, created, lead.id);
    db.prepare('UPDATE activities SET created_at = ? WHERE lead_id = ?').run(created, lead.id);

    if (firstMins !== null) {
      const at = new Date(new Date(created).getTime() + firstMins * 60000).toISOString();
      db.prepare("INSERT INTO activities (lead_id, type, body, actor_id, created_at) VALUES (?, 'call', ?, ?, ?)").run(lead.id, 'Called. Interested, wants pricing.', mike.id, at);
      db.prepare('UPDATE leads SET first_contact_at = ? WHERE id = ?').run(at, lead.id);
    }
    if (stage === 'new') continue;
    if (stage === 'lost') {
      await pipeline.changeStage(lead.id, { stage: 'lost', lost_reason: lostReason, note: lostReason === 'Other' ? 'demo' : undefined }, actor);
      continue;
    }
    await pipeline.changeStage(lead.id, { stage: 'contacted' }, actor);
    if (stage === 'contacted') continue;
    await pipeline.changeStage(lead.id, { stage: 'working' }, actor);
    pipeline.addActivity(lead.id, { type: 'note', body: 'Sent the one-pager. Following up Thursday.' }, actor);
    if (stage === 'working') continue;
    const [price, pkg, cat] = prices[dealership];
    await pipeline.changeStage(lead.id, {
      stage: 'signed',
      deal: {
        package: pkg, price_per_lead: price, quotas: { [cat]: Number(wanted) }, areas: areasFor[dealership],
        account_manager_id: mike.id, start_date: day(Math.max(0, daysAgo - 3)),
      },
    }, actor);
  }
  // Targets for this month, and payment states so the Overview has something to show.
  const { setSetting } = require('../src/db');
  setSetting(`targets:${day(0).slice(0, 7)}`, JSON.stringify({ ad_budget: 2500, dealer_leads: 30, max_cpl: 60, working: 8, signed: 4, new_mrr: 3000, mrr: 4000 }));
  const deals = db.prepare('SELECT * FROM deals ORDER BY id').all();
  deals.forEach((d, i) => {
    if (i < 2) {
      db.prepare("UPDATE deals SET payment_status = 'paid', paid_at = ? WHERE id = ?").run(ago(1440 * (10 - i * 3)), d.id);
      db.prepare("INSERT INTO payments (deal_id, stripe_invoice_id, amount, currency, status, paid_at) VALUES (?, ?, ?, 'cad', 'paid', ?)").run(d.id, `in_demo_${d.id}`, d.monthly_value, ago(1440 * (10 - i * 3)));
    } else {
      db.prepare("UPDATE deals SET payment_status = 'link_sent' WHERE id = ?").run(d.id);
    }
  });
  console.log(`Demo ready: ${LEADS.length} leads, 3 signed dealers, 30 days of ad spend. Logins: rory@autobought.ca (admin), mike@autobought.ca (rep).`);
}

module.exports = { seedDemo };

if (require.main === module) {
  seedDemo({ password: process.env.DEMO_PASSWORD || 'demo-password-1' })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
