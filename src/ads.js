// ads.js - daily ad spend from the Meta Marketing API, and what it bought.
//
// Spend is pulled per ad per day (Insights, level=ad, time_increment=1) and
// the last few days are re-pulled every sync, because Meta keeps revising
// recent spend. Each ad is labelled A or B from its ad set's destination:
// an Instant Form ad set (ON_AD) is A, a website one is B. When that guess
// is wrong, an override on the dashboard wins.

const config = require('./config');
const { db, nowISO, getSetting, setSetting } = require('./db');
const { backfillAdAttribution } = require('./intake');

const graph = (path) => `https://graph.facebook.com/${config.metaApiVersion()}/${path}`;

async function getAll(url) {
  const rows = [];
  let next = url;
  for (let page = 0; next && page < 50; page += 1) {
    const res = await fetch(next, { signal: AbortSignal.timeout(30000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Meta Marketing API: ${(json.error && json.error.message) || res.status}`);
    rows.push(...(json.data || []));
    next = json.paging && json.paging.next;
  }
  return rows;
}

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function syncAds({ since, until } = {}) {
  const account = config.metaAdAccountId();
  const token = config.metaAdsToken();
  if (!account || !token) throw new Error('META_AD_ACCOUNT_ID and META_ADS_TOKEN must be set to pull ad spend.');
  since = isDay(since) ? since : daysAgo(config.adSyncLookbackDays());
  until = isDay(until) ? until : daysAgo(0);
  const auth = `access_token=${encodeURIComponent(token)}`;

  // What each ad is, including paused and archived ones that still had spend.
  const adsets = await getAll(graph(`act_${account}/adsets?fields=id,name,destination_type,campaign{id,name}&limit=500&${auth}`));
  const adsetInfo = Object.fromEntries(adsets.map((s) => [s.id, s]));
  const ads = await getAll(graph(`act_${account}/ads?fields=id,name,adset_id,campaign_id&limit=500&${auth}`));
  const upsertAd = db.prepare(
    `INSERT INTO ads (ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, destination_type, updated_at)
     VALUES (@ad_id, @ad_name, @adset_id, @adset_name, @campaign_id, @campaign_name, @destination_type, @updated_at)
     ON CONFLICT(ad_id) DO UPDATE SET ad_name = excluded.ad_name, adset_id = excluded.adset_id, adset_name = excluded.adset_name,
       campaign_id = excluded.campaign_id, campaign_name = excluded.campaign_name,
       destination_type = COALESCE(excluded.destination_type, ads.destination_type), updated_at = excluded.updated_at`
  );
  const now = nowISO();
  db.transaction(() => {
    for (const a of ads) {
      const s = adsetInfo[a.adset_id] || {};
      upsertAd.run({
        ad_id: a.id, ad_name: a.name, adset_id: a.adset_id || null, adset_name: s.name || null,
        campaign_id: a.campaign_id || (s.campaign && s.campaign.id) || null,
        campaign_name: (s.campaign && s.campaign.name) || null,
        destination_type: s.destination_type || null, updated_at: now,
      });
    }
  })();

  const range = encodeURIComponent(JSON.stringify({ since, until }));
  const insights = await getAll(graph(
    `act_${account}/insights?level=ad&time_increment=1&time_range=${range}`
    + `&fields=date_start,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks&limit=500&${auth}`
  ));
  const upsertSpend = db.prepare(
    `INSERT INTO ad_spend (date, ad_id, campaign_id, campaign_name, adset_id, adset_name, ad_name, spend, impressions, clicks, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date, ad_id) DO UPDATE SET spend = excluded.spend, impressions = excluded.impressions, clicks = excluded.clicks,
       campaign_name = excluded.campaign_name, adset_name = excluded.adset_name, ad_name = excluded.ad_name, synced_at = excluded.synced_at`
  );
  db.transaction(() => {
    // Days in range with no row from Meta had no spend; clear stale numbers.
    db.prepare('DELETE FROM ad_spend WHERE date BETWEEN ? AND ?').run(since, until);
    for (const r of insights) {
      upsertSpend.run(r.date_start, r.ad_id, r.campaign_id, r.campaign_name, r.adset_id, r.adset_name, r.ad_name,
        Number(r.spend) || 0, Number(r.impressions) || 0, Number(r.clicks) || 0, now);
      db.prepare(`INSERT INTO ads (ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ad_id) DO NOTHING`)
        .run(r.ad_id, r.ad_name, r.adset_id, r.adset_name, r.campaign_id, r.campaign_name, now);
    }
  })();

  const credited = backfillAdAttribution();
  setSetting('ads_last_sync', JSON.stringify({ at: now, since, until, rows: insights.length, ads: ads.length, credited }));
  return { since, until, rows: insights.length, ads: ads.length, credited };
}

// --- Which source an ad feeds --------------------------------------------------

// override > the ad set's destination > whichever source its leads came from.
function adSource(ad, leadSources = {}) {
  if (ad.source_override === 'A' || ad.source_override === 'B') return ad.source_override;
  const dest = String(ad.destination_type || '').toUpperCase();
  if (['ON_AD', 'LEAD_FROM_IG_DIRECT', 'LEAD_FROM_MESSENGER', 'INSTANT_FORM'].includes(dest)) return 'A';
  if (['WEBSITE', 'UNDEFINED', 'APP'].includes(dest)) return 'B';
  const s = leadSources[ad.ad_id];
  if (s) return (s.A || 0) >= (s.B || 0) ? 'A' : 'B';
  return '?';
}

// --- The dashboard -------------------------------------------------------------

// No spend recorded means no cost to show, not a cost of $0.
const ratio = (spend, n) => (n > 0 && spend > 0 ? Math.round((spend / n) * 100) / 100 : null);

function dashboard({ from, to } = {}) {
  from = isDay(from) ? from : daysAgo(29);
  to = isDay(to) ? to : daysAgo(0);

  // Leads are counted by the day they came in; Working and Signed are the
  // outcomes of those same leads, so cost per Signed means "what we spent to
  // get the leads that went on to sign".
  const leads = db.prepare(
    `SELECT id, source, ad_id, ad_name, campaign_name, adset_name, stage, reached_working_at, signed_at, first_contact_at, created_at
       FROM leads WHERE substr(created_at, 1, 10) BETWEEN ? AND ?`
  ).all(from, to);

  const spendRows = db.prepare(
    `SELECT s.ad_id, MAX(s.ad_name) AS ad_name, MAX(s.adset_name) AS adset_name, MAX(s.campaign_name) AS campaign_name,
            SUM(s.spend) AS spend, SUM(s.impressions) AS impressions, SUM(s.clicks) AS clicks
       FROM ad_spend s WHERE s.date BETWEEN ? AND ? GROUP BY s.ad_id`
  ).all(from, to);
  const ads = Object.fromEntries(db.prepare('SELECT * FROM ads').all().map((a) => [a.ad_id, a]));

  const leadSources = {};
  for (const l of leads) {
    if (!l.ad_id) continue;
    const s = (leadSources[l.ad_id] ||= {});
    s[l.source] = (s[l.source] || 0) + 1;
  }

  const byAd = {};
  const row = (key, base) => (byAd[key] ||= { ...base, spend: 0, impressions: 0, clicks: 0, leads: 0, working: 0, signed: 0 });
  for (const s of spendRows) {
    const ad = ads[s.ad_id] || { ad_id: s.ad_id };
    const r = row(s.ad_id, {
      ad_id: s.ad_id, ad_name: s.ad_name || ad.ad_name, adset_name: s.adset_name || ad.adset_name,
      campaign_name: s.campaign_name || ad.campaign_name, source: adSource(ad, leadSources), source_override: ad.source_override || null,
    });
    r.spend += s.spend; r.impressions += s.impressions; r.clicks += s.clicks;
  }
  for (const l of leads) {
    const key = l.ad_id || `__none_${l.source}`;
    const ad = l.ad_id ? ads[l.ad_id] || { ad_id: l.ad_id } : null;
    const r = row(key, l.ad_id
      ? { ad_id: l.ad_id, ad_name: l.ad_name || ad.ad_name, adset_name: l.adset_name || ad.adset_name, campaign_name: l.campaign_name || ad.campaign_name, source: adSource(ad, leadSources), source_override: ad.source_override || null }
      : { ad_id: null, ad_name: `No ad matched (${l.source})`, adset_name: null, campaign_name: null, source: l.source });
    r.leads += 1;
    if (l.reached_working_at) r.working += 1;
    if (l.signed_at) r.signed += 1;
  }
  const finish = (r) => ({
    ...r,
    spend: Math.round(r.spend * 100) / 100,
    cost_per_lead: ratio(r.spend, r.leads), cost_per_working: ratio(r.spend, r.working), cost_per_signed: ratio(r.spend, r.signed),
  });
  const adRows = Object.values(byAd).map(finish).sort((a, b) => b.spend - a.spend || b.leads - a.leads);

  // Totals by source. Leads use the lead's own source; spend uses the ad's.
  const bySource = {};
  for (const key of ['A', 'B', '?']) bySource[key] = { source: key, spend: 0, leads: 0, working: 0, signed: 0 };
  for (const r of adRows) bySource[r.source in bySource ? r.source : '?'].spend += r.spend;
  for (const l of leads) {
    const s = bySource[l.source] || bySource['?'];
    s.leads += 1; if (l.reached_working_at) s.working += 1; if (l.signed_at) s.signed += 1;
  }
  const total = { source: 'All', spend: 0, leads: 0, working: 0, signed: 0 };
  for (const s of Object.values(bySource)) { total.spend += s.spend; total.leads += s.leads; total.working += s.working; total.signed += s.signed; }

  // Speed to lead for the same leads.
  const contacted = leads.filter((l) => l.first_contact_at);
  const mins = contacted.map((l) => Math.max(0, (new Date(l.first_contact_at) - new Date(l.created_at)) / 60000)).sort((a, b) => a - b);
  const speed = {
    contacted: contacted.length,
    waiting: leads.filter((l) => !l.first_contact_at && l.stage === 'new').length,
    average_minutes: mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
    median_minutes: mins.length ? Math.round(mins[Math.floor(mins.length / 2)]) : null,
    within_5: mins.filter((m) => m <= 5).length,
  };

  return {
    from, to,
    last_sync: JSON.parse(getSetting('ads_last_sync') || 'null'),
    sources: [...Object.values(bySource).filter((s) => s.source !== '?' || s.spend || s.leads), total].map(finish),
    ads: adRows,
    speed,
  };
}

function setSourceOverride(adId, source) {
  const value = source === 'A' || source === 'B' ? source : null;
  db.prepare('INSERT INTO ads (ad_id, source_override, updated_at) VALUES (?, ?, ?) ON CONFLICT(ad_id) DO UPDATE SET source_override = excluded.source_override')
    .run(adId, value, nowISO());
  return value;
}

module.exports = { syncAds, dashboard, adSource, setSourceOverride };
