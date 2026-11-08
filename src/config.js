// config.js - every setting the CRM reads from its environment, in one place.
// Read on each call (not cached at start-up) so tests can change them.

const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

module.exports = {
  appUrl: () => trimSlash(env('APP_URL', 'http://localhost:3100')),
  isProduction: () => env('NODE_ENV') === 'production',

  // Webhooks
  metaVerifyToken: () => env('META_VERIFY_TOKEN'),
  metaAppSecret: () => env('META_APP_SECRET'),
  jotformSecret: () => env('JOTFORM_WEBHOOK_SECRET'),
  webhookSecret: () => env('WEBHOOK_SECRET'),

  // Meta Graph API
  metaApiVersion: () => env('META_API_VERSION', 'v23.0'),
  metaPageToken: () => env('META_PAGE_TOKEN'),          // reads lead details (leads_retrieval)
  metaAdsToken: () => env('META_ADS_TOKEN', env('META_PAGE_TOKEN')), // ads_read
  metaAdAccountId: () => env('META_AD_ACCOUNT_ID').replace(/^act_/, ''),
  adSyncHour: () => Number(env('AD_SYNC_HOUR', '10')),   // UTC
  adSyncLookbackDays: () => Number(env('AD_SYNC_LOOKBACK_DAYS', '7')),

  // Conversions API: the same names the dealer portal's CAPI setup uses, so
  // one dataset and one system-user token serve both.
  capiDatasetId: () => env('META_DATASET_ID', env('META_PIXEL_ID')),
  capiToken: () => env('META_CAPI_TOKEN'),
  capiTestCode: () => env('META_CAPI_TEST_EVENT_CODE'),
  capiEventNames: () => ({
    working: env('CAPI_EVENT_WORKING', 'Working'),
    signed: env('CAPI_EVENT_SIGNED', 'Signed'),
  }),

  // Notifications
  resendKey: () => env('RESEND_API_KEY'),
  emailFrom: () => env('EMAIL_FROM', 'Autobought CRM <crm@autobought.ca>'),
  welcomeFrom: () => env('WELCOME_FROM', env('EMAIL_FROM', 'Autobought <dealers@autobought.ca>')),
  welcomeBcc: () => env('WELCOME_BCC'),
  twilioSid: () => env('TWILIO_ACCOUNT_SID'),
  twilioToken: () => env('TWILIO_AUTH_TOKEN'),
  twilioFrom: () => env('TWILIO_FROM'),
  // When set, notifications only go to these addresses/numbers (staging).
  notifyAllowlist: () => env('NOTIFY_ALLOWLIST').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  // Lead bank
  leadBankUrl: () => trimSlash(env('LEADBANK_URL')),
  leadBankEmail: () => env('LEADBANK_EMAIL'),
  leadBankPassword: () => env('LEADBANK_PASSWORD'),
  leadBankWebhookSecret: () => env('LEADBANK_WEBHOOK_SECRET'),
  consumerFunnelId: () => env('CONSUMER_FUNNEL_ID'),
  // Our category -> the lead bank's categories. RV/Marine is "rv" there by
  // default; "rv_marine:rv,trailer" would sign them for both.
  leadBankCategoryMap: () => {
    const map = { automotive: ['automotive'], powersport: ['powersport'], rv_marine: ['rv'] };
    for (const part of env('LEADBANK_CATEGORY_MAP').split(';').map((s) => s.trim()).filter(Boolean)) {
      const [ours, theirs] = part.split(':');
      if (ours && theirs) map[ours.trim()] = theirs.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return map;
  },

  runScheduler: () => env('RUN_SCHEDULER', 'true') !== 'false',
};
