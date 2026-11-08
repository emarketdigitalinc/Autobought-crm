// geo.js - where leads are, where signed dealers want leads from, and who
// already covers a spot.
//
// A dealer's areas work like Meta's location targeting: whole provinces, or a
// point plus a radius ("Red Deer +50 km"). Dealers can overlap: coverage is
// information for the call ("two dealers already take Powersport around
// here"), never a lock.

const { db, PROVINCES, CATEGORIES, CATEGORY_LABELS } = require('./db');

const simplify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\bst\.?\s/g, 'saint ').replace(/[^a-z0-9]+/g, ' ').trim();

// "Alberta", "alta", "AB" -> "AB".
const PROVINCE_WORDS = {
  AB: ['alberta', 'alta'], BC: ['british columbia'], MB: ['manitoba'], NB: ['new brunswick'],
  NL: ['newfoundland', 'labrador'], NS: ['nova scotia'], NT: ['northwest territories'], NU: ['nunavut'],
  ON: ['ontario'], PE: ['prince edward island', 'pei'], QC: ['quebec', 'québec'], SK: ['saskatchewan', 'sask'], YT: ['yukon'],
};
function provinceCode(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  const up = v.toUpperCase().replace(/[^A-Z]/g, '');
  if (PROVINCES[up]) return up;
  const low = v.toLowerCase();
  for (const [code, words] of Object.entries(PROVINCE_WORDS)) if (words.some((w) => low.includes(w))) return code;
  return null;
}

// Great-circle distance in km.
function km(aLat, aLng, bLat, bLng) {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// --- Finding a place --------------------------------------------------------

function knownPlace(city, province = null) {
  const c = simplify(String(city || '').split(',')[0]);
  if (!c) return null;
  const prov = provinceCode(province);
  const hits = db.prepare('SELECT * FROM places').all()
    .filter((p) => [p.name, ...String(p.aliases || '').split(',')].map(simplify).includes(c));
  return hits.find((p) => p.province === prov) || (prov ? null : hits[0]) || hits[0] || null;
}

// Open-Meteo's free geocoder (no key). Canada only. Never throws.
async function geocodeRemote(query, count = 6) {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=${count}&countryCode=CA&language=en&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.results || [])
      .map((r) => ({ name: r.name, province: provinceCode(r.admin1), lat: r.latitude, lng: r.longitude, population: r.population || 0 }))
      .filter((r) => r.province);
  } catch (e) {
    return [];
  }
}

// City (+ province) -> { name, province, lat, lng } or null. Results from the
// geocoder are remembered, so each town is looked up once.
async function locate(city, province = null) {
  const known = knownPlace(city, province);
  if (known) return known;
  const name = String(city || '').split(',')[0].trim();
  if (!name) return null;
  const prov = provinceCode(province);
  const results = await geocodeRemote(name);
  const best = results.find((r) => !prov || r.province === prov);
  if (!best) return null;
  db.prepare("INSERT OR IGNORE INTO places (name, province, lat, lng, source) VALUES (?, ?, ?, ?, 'geocoder')")
    .run(best.name, best.province, best.lat, best.lng);
  return best;
}

// Suggestions for the area picker's search box: known places first.
async function search(query) {
  const q = simplify(query);
  if (q.length < 2) return [];
  const local = db.prepare('SELECT * FROM places').all()
    .filter((p) => simplify(p.name).startsWith(q) || String(p.aliases || '').split(',').some((a) => simplify(a).startsWith(q)))
    .slice(0, 6)
    .map((p) => ({ name: p.name, province: p.province, lat: p.lat, lng: p.lng }));
  const remote = local.length >= 6 ? [] : await geocodeRemote(query);
  const seen = new Set(local.map((p) => `${simplify(p.name)}|${p.province}`));
  return [...local, ...remote.filter((r) => !seen.has(`${simplify(r.name)}|${r.province}`))].slice(0, 8)
    .map((p) => ({ ...p, label: `${p.name}, ${p.province}` }));
}

// Puts a lead on the map from its city. Safe to call repeatedly.
async function placeLead(leadId) {
  const lead = db.prepare('SELECT id, city, province FROM leads WHERE id = ?').get(leadId);
  if (!lead || !lead.city) return null;
  const p = await locate(lead.city, lead.province);
  if (!p) return null;
  db.prepare('UPDATE leads SET lat = ?, lng = ?, province = COALESCE(province, ?) WHERE id = ?').run(p.lat, p.lng, p.province, lead.id);
  return p;
}

// --- Areas --------------------------------------------------------------------

// Checks and tidies the areas a dealer picked. Returns { areas } or { error }.
function cleanAreas(input) {
  const out = [];
  for (const a of Array.isArray(input) ? input : []) {
    if (a.kind === 'province') {
      const code = provinceCode(a.province);
      if (!code) return { error: `Unknown province: ${a.province}` };
      if (!out.some((x) => x.kind === 'province' && x.province === code)) {
        out.push({ kind: 'province', province: code, label: PROVINCES[code], lat: null, lng: null, radius_km: null });
      }
    } else if (a.kind === 'radius') {
      const lat = Number(a.lat); const lng = Number(a.lng); const r = Number(a.radius_km);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 41 || lat > 84 || lng < -142 || lng > -52) return { error: 'A radius area needs a point in Canada.' };
      if (!Number.isFinite(r) || r < 5 || r > 500) return { error: 'A radius must be between 5 and 500 km.' };
      const code = provinceCode(a.province) || nearestProvince(lat, lng);
      const name = String(a.name || a.label || '').replace(/\s*\+\d+\s*km$/i, '').trim() || 'Pin';
      out.push({ kind: 'radius', province: code, label: `${name} +${Math.round(r)} km`, lat, lng, radius_km: Math.round(r) });
    }
  }
  if (!out.length) return { error: 'Choose at least one area: a province, or a city and radius.' };
  return { areas: out };
}

// The province of the closest known place: good enough for a pin dropped on the map.
function nearestProvince(lat, lng) {
  let best = null;
  for (const p of db.prepare('SELECT province, lat, lng FROM places').all()) {
    const d = km(lat, lng, p.lat, p.lng);
    if (!best || d < best.d) best = { d, province: p.province };
  }
  return best ? best.province : 'AB';
}

function areaCovers(area, lead) {
  if (area.kind === 'province') return Boolean(lead.province) && lead.province === area.province;
  if (lead.lat === null || lead.lat === undefined) return false;
  return km(area.lat, area.lng, lead.lat, lead.lng) <= area.radius_km;
}

// Every signed dealer (active or paused) with its areas and categories.
function liveDeals() {
  const deals = db.prepare(
    `SELECT id, lead_id, dealer_name, status FROM deals WHERE status IN ('active', 'paused') ORDER BY dealer_name`
  ).all();
  const areas = db.prepare('SELECT * FROM deal_areas').all();
  const quotas = db.prepare('SELECT * FROM deal_quotas WHERE monthly_quota > 0').all();
  return deals.map((d) => ({
    ...d,
    areas: areas.filter((a) => a.deal_id === d.id),
    categories: quotas.filter((q) => q.deal_id === d.id).map((q) => q.category),
  }));
}

// Who already takes leads where this lead is. Overlap is fine; this is so
// you know before you call.
function coverageFor(lead, deals = liveDeals()) {
  const sells = String(lead.categories || '').split(',').filter(Boolean);
  const located = Boolean(lead.province || lead.lat !== null);
  const dealers = deals
    .filter((d) => d.lead_id !== lead.id)
    .map((d) => ({ d, hit: d.areas.find((a) => areaCovers(a, lead)) }))
    .filter((x) => x.hit)
    .map(({ d, hit }) => ({
      deal_id: d.id, lead_id: d.lead_id, dealer_name: d.dealer_name, status: d.status, area: hit.label,
      categories: d.categories, same_category: !sells.length || d.categories.some((c) => sells.includes(c)),
    }));
  return {
    located,
    dealers,
    same_category: dealers.filter((x) => x.same_category).length,
  };
}

// The coverage map: provinces with how many dealers take them, every radius,
// and open dealer leads as pins.
function mapData() {
  const deals = liveDeals();
  const leads = db.prepare(
    "SELECT id, name, dealership, city, province, lat, lng, stage, categories FROM leads WHERE lat IS NOT NULL AND stage NOT IN ('lost')"
  ).all();
  const provinces = {};
  for (const d of deals) {
    for (const a of d.areas) {
      if (a.kind !== 'province') continue;
      (provinces[a.province] ||= []).push({ deal_id: d.id, dealer_name: d.dealer_name, categories: d.categories });
    }
  }
  return {
    deals: deals.map((d) => ({
      id: d.id, lead_id: d.lead_id, dealer_name: d.dealer_name, status: d.status,
      categories: d.categories.map((c) => ({ key: c, label: CATEGORY_LABELS[c] })),
      areas: d.areas.map((a) => ({ kind: a.kind, province: a.province, label: a.label, lat: a.lat, lng: a.lng, radius_km: a.radius_km })),
    })),
    provinces,
    leads,
    categories: CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABELS[c] })),
  };
}

module.exports = {
  provinceCode, km, knownPlace, locate, search, placeLead, cleanAreas, areaCovers, liveDeals, coverageFor, mapData, simplify,
};
