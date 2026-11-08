// server.js - starts the CRM and its background jobs.

const fs = require('fs');
const path = require('path');
// A local .env, if there is one. Railway sets real variables instead.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const config = require('./config');
const { buildApp } = require('./app');
const { bootstrapAdmin } = require('./auth');
const { startScheduler } = require('./scheduler');

const warn = (cond, msg) => { if (cond) console.warn(`[warn] ${msg}`); };
warn(!config.metaAppSecret(), 'META_APP_SECRET is not set: Meta webhook signatures are not checked.');
warn(!config.jotformSecret(), 'JOTFORM_WEBHOOK_SECRET is not set: the Jotform webhook is open.');
warn(!config.twilioSid(), 'Twilio is not set: new-lead texts are simulated.');
warn(!config.resendKey(), 'RESEND_API_KEY is not set: emails are simulated.');

bootstrapAdmin().catch((err) => console.error('[bootstrap]', err.message));
if (config.runScheduler()) startScheduler();

const port = Number(process.env.PORT || 3100);
buildApp().listen(port, () => console.log(`Autobought CRM on http://localhost:${port}`));
