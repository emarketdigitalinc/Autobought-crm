// npm run sync-ads -- 2026-10-01 2026-10-31   (defaults to the last AD_SYNC_LOOKBACK_DAYS days)
const { syncAds } = require('../src/ads');
syncAds({ since: process.argv[2], until: process.argv[3] })
  .then((r) => console.log(r))
  .catch((e) => { console.error(e.message); process.exit(1); });
