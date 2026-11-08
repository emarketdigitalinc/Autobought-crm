// fields.js - turns whatever a form calls its questions into our fields.
//
// Meta Instant Forms name custom questions after their text
// ("what_do_you_sell?"), Jotform after its own generated names
// ("q7_whatDo") with the real label only in `pretty`, and Zapier can rename
// anything. So each field is recognised by patterns over a normalised key,
// and the first non-empty answer wins.

const { CATEGORIES } = require('./db');

// Lowercase, letters and digits only: "What do you sell?" -> "whatdoyousell".
const norm = (k) => String(k || '').toLowerCase().replace(/^q\d+_/, '').replace(/[^a-z0-9]/g, '');

// Order matters: more specific patterns first, and each field is matched
// against keys not already claimed by an earlier field.
const FIELD_PATTERNS = [
  ['utm_source', [/^utmsource$/]],
  ['utm_medium', [/^utmmedium$/]],
  ['utm_campaign', [/^utmcampaign$/]],
  ['utm_content', [/^utmcontent$/]],
  ['utm_term', [/^utmterm$/]],
  ['fbclid', [/^fbclid$/]],
  ['dealership', [/dealership(or(company)?)?name/, /^dealershipor$/, /^dealership$/, /companyname/, /^company$/, /businessname/, /dealername/]],
  ['email', [/workemail/, /businessemail/, /^email/, /emailaddress/, /^e?mail$/]],
  ['phone', [/phone/, /mobile/, /^cell/]],
  ['first_name', [/^firstname$/, /^first$/]],
  ['last_name', [/^lastname$/, /^last$/]],
  ['name', [/^fullname$/, /^contactname$/, /^name$/, /^yourname$/]],
  ['role', [/^role$/, /yourrole/, /^position/, /jobtitle/, /^title$/, /whatbestdescribesyou/, /whatisyourrole/, /whichbestdescribes/]],
  ['leads_wanted', [/howmany(additional)?leads/, /^howmany$/, /^approximatelyhowmanyadditional/, /leadspermonth/, /leadsmonth/, /leadswanted/, /monthlyleads/]],
  ['sells', [/whatdo(es)?(you|your|yourdealership)sell/, /^whatdo(es)?$/, /^sells?$/, /typeofleads/, /whattypeofleads/, /vehicletype/, /whatyousell/, /inventory/]],
  ['city', [/dealershipcity/, /^city$/, /yourcity/, /yourmarket/, /targetmarket/, /whereisyourtargetmarket/]],
  ['province', [/^province/, /^state$/, /provinceorterritory/]],
  ['website', [/website/, /^url$/]],
  ['message', [/anythingelse/, /^message$/, /comments?$/, /notes?$/]],
];

function stringify(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(stringify).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if (value.full) return String(value.full);                    // Jotform phone
    if (value.first || value.last) return [value.first, value.last].filter(Boolean).join(' '); // Jotform name
    if (value.city) return String(value.city);                    // Jotform address
    return Object.values(value).map(stringify).filter(Boolean).join(' ');
  }
  return String(value).trim();
}

// entries: [[key, value], ...] in the order the form sent them.
function mapFields(entries) {
  const out = {};
  const claimed = new Set();
  // Patterns are tried in order, so "Dealership city" beats "Your market"
  // whichever the form asked first.
  for (const [field, patterns] of FIELD_PATTERNS) {
    for (const pattern of patterns) {
      for (const [key, value] of entries) {
        if (claimed.has(key) || !pattern.test(norm(key))) continue;
        const v = stringify(value);
        if (!v) continue;
        claimed.add(key);
        out[field] = v;
        break;
      }
      if (out[field] !== undefined) break;
    }
  }
  if (!out.name && (out.first_name || out.last_name)) out.name = [out.first_name, out.last_name].filter(Boolean).join(' ');
  delete out.first_name;
  delete out.last_name;
  if (out.leads_wanted) {
    const n = String(out.leads_wanted).match(/\d+/g);
    // "25-50" -> 50: plan for the top of the range they asked for.
    out.leads_wanted_n = n ? Math.max(...n.map(Number)) : null;
  }
  return out;
}

// The role a consumer picks on a dealer form. Matched loosely, because the
// apostrophe arrives as ' or ’ or not at all.
function isShopperRole(role) {
  const r = String(role || '').toLowerCase().replace(/[’']/g, '');
  return /im shopping for a vehicle|shopping for a vehicle|i am shopping/.test(r);
}

// Which of our categories a dealership sells, from their own words.
const CATEGORY_WORDS = {
  automotive: /\b(auto(motive)?s?|cars?|trucks?|suvs?|vehicles?|used|pre-?owned|new and used|dealership)\b/i,
  powersport: /\b(power ?sports?|atvs?|utvs?|side[- ]by[- ]sides?|sxs|snowmobiles?|sleds?|motorcycles?|dirt ?bikes?|sea-?doos?|jet ?skis?|pwc)\b/i,
  rv_marine: /\b(rvs?|r\.v\.|motorhomes?|campers?|trailers?|fifth[- ]wheels?|travel trailers?|marine|boats?|pontoons?)\b/i,
};
function categoriesFrom(text) {
  const t = String(text || '');
  return CATEGORIES.filter((c) => CATEGORY_WORDS[c].test(t));
}

module.exports = { mapFields, isShopperRole, categoriesFrom, norm, stringify };
