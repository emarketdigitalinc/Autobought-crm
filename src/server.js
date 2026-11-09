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

// A hosted demo seeds itself once, into an empty database only.
async function maybeSeedDemo() {
  if (process.env.SEED_DEMO !== 'true') return;
  const { db } = require('./db');
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  try {
    await require('../scripts/demo').seedDemo({ password: process.env.DEMO_PASSWORD });
  } catch (err) {
    console.error('[demo]', err.message);
  }
}

// Locked out with no terminal to hand (Railway): set RESET_PASSWORD_EMAIL and
// RESET_PASSWORD (10+ characters), redeploy, sign in, then remove both. The
// account is switched back on and signed out everywhere else.
async function maybeResetPassword() {
  const email = String(process.env.RESET_PASSWORD_EMAIL || '').trim().toLowerCase();
  const password = process.env.RESET_PASSWORD || '';
  if (!email || !password) return;
  const { db } = require('./db');
  const { hashPassword } = require('./auth');
  if (password.length < 10) return console.error('[reset] RESET_PASSWORD needs at least 10 characters.');
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return console.error(`[reset] No account for ${email}.`);
  db.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?').run(await hashPassword(password), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  console.log(`[reset] Password reset for ${email}. Remove RESET_PASSWORD_EMAIL and RESET_PASSWORD now.`);
}

maybeSeedDemo()
  .then(() => maybeResetPassword())
  .then(() => bootstrapAdmin())
  .catch((err) => console.error('[bootstrap]', err.message));
if (config.runScheduler()) startScheduler();

const port = Number(process.env.PORT || 3100);
buildApp().listen(port, () => console.log(`Autobought CRM on http://localhost:${port}`));
