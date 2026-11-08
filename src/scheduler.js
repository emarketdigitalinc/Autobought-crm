// scheduler.js - the background jobs, once a minute:
//   - retry webhook deliveries that failed to process
//   - retry Conversions API events Meta did not accept
//   - once a day (AD_SYNC_HOUR, UTC), pull the last week of ad spend

const config = require('./config');
const intake = require('./intake');
const capi = require('./capi');
const ads = require('./ads');
const { getSetting, setSetting } = require('./db');

async function tick(now = new Date()) {
  try { await intake.retryPending(); } catch (err) { console.error('[scheduler] intake retry:', err.message); }
  try { await capi.retryPending(); } catch (err) { console.error('[scheduler] capi retry:', err.message); }

  const today = now.toISOString().slice(0, 10);
  if (config.metaAdAccountId() && config.metaAdsToken() && now.getUTCHours() >= config.adSyncHour()
      && getSetting('ads_daily_sync_day') !== today) {
    setSetting('ads_daily_sync_day', today);
    try {
      const r = await ads.syncAds();
      console.log(`[scheduler] ad spend synced ${r.since}..${r.until}: ${r.rows} rows`);
    } catch (err) {
      console.error('[scheduler] ad sync:', err.message);
    }
  }
}

function startScheduler() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(); } finally { running = false; }
  };
  setTimeout(run, 5000);
  return setInterval(run, 60000);
}

module.exports = { tick, startScheduler };
