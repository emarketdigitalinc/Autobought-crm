// markets.js - which markets and categories are already held by a signed dealer.
//
// A market is a city (plus its surrounding towns, as aliases) in a province.
// A signed, active or paused deal holds each of its markets for each category
// it has a quota in. "Taken" means someone else holds it: worth knowing
// before you ring a dealer whose city you can no longer sell them.

const { db, CATEGORIES, CATEGORY_LABELS } = require('./db');

const simplify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\bst\.?\s/g, 'saint ').replace(/[^a-z0-9]+/g, ' ').trim();

// "Red Deer, AB" or "red deer" -> the Red Deer market.
function matchMarket(city, province = null) {
  const c = simplify(String(city || '').split(',')[0]);
  if (!c) return null;
  const markets = db.prepare('SELECT * FROM markets WHERE active = 1').all();
  const names = (m) => [m.name, ...String(m.aliases || '').split(',')].map(simplify).filter(Boolean);
  const hits = markets.filter((m) => names(m).includes(c));
  if (!hits.length) return null;
  const prov = String(province || '').toUpperCase();
  return hits.find((m) => m.province === prov) || hits[0];
}

// Every holding: market x category -> the dealer holding it.
function holdings() {
  return db.prepare(
    `SELECT dm.market_id, q.category, d.id AS deal_id, d.dealer_name, d.lead_id, d.status
       FROM deals d
       JOIN deal_markets dm ON dm.deal_id = d.id
       JOIN deal_quotas q ON q.deal_id = d.id
      WHERE d.status IN ('active', 'paused') AND q.monthly_quota > 0`
  ).all();
}

// For one lead: each category they sell (or all three when we cannot tell),
// open or taken in their market.
function availabilityFor(lead) {
  const market = lead.market_id ? db.prepare('SELECT * FROM markets WHERE id = ?').get(lead.market_id) : null;
  const sells = String(lead.categories || '').split(',').filter(Boolean);
  const cats = sells.length ? sells : CATEGORIES;
  if (!market) {
    return { market: null, categories: cats.map((c) => ({ category: c, label: CATEGORY_LABELS[c], status: 'unknown' })) };
  }
  const held = holdings().filter((h) => h.market_id === market.id && h.lead_id !== lead.id);
  return {
    market,
    categories: cats.map((c) => {
      const h = held.find((x) => x.category === c);
      return h
        ? { category: c, label: CATEGORY_LABELS[c], status: 'taken', dealer: h.dealer_name, deal_lead_id: h.lead_id }
        : { category: c, label: CATEGORY_LABELS[c], status: 'open' };
    }),
  };
}

// The market map: every market, every category, plus how much demand
// (dealer leads) each market has produced.
function overview() {
  const markets = db.prepare('SELECT * FROM markets ORDER BY province, name').all();
  const held = holdings();
  const demand = Object.fromEntries(
    db.prepare("SELECT market_id, COUNT(*) AS n, SUM(stage NOT IN ('lost','signed')) AS open FROM leads WHERE market_id IS NOT NULL GROUP BY market_id")
      .all().map((r) => [r.market_id, r])
  );
  return markets.map((m) => ({
    ...m,
    active: !!m.active,
    leads: demand[m.id] ? demand[m.id].n : 0,
    open_leads: demand[m.id] ? demand[m.id].open : 0,
    cells: CATEGORIES.map((c) => {
      const hs = held.filter((h) => h.market_id === m.id && h.category === c);
      return { category: c, status: hs.length ? 'taken' : 'open', dealers: hs.map((h) => ({ name: h.dealer_name, lead_id: h.lead_id, status: h.status })) };
    }),
  }));
}

module.exports = { matchMarket, availabilityFor, overview, holdings, simplify };
