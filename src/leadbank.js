// leadbank.js - talking to the lead bank (and its dealer portal).
//
// The CRM signs in to the lead bank's own staff API as a staff account
// (LEADBANK_EMAIL / LEADBANK_PASSWORD), exactly as a person would, so it can
// only do what a staff member could do on the Dealers and Settings screens,
// and every change it makes goes through the lead bank's own checks.

const config = require('./config');

let cookie = null;

async function login() {
  const url = config.leadBankUrl();
  if (!url) throw new Error('LEADBANK_URL is not set.');
  if (!config.leadBankEmail() || !config.leadBankPassword()) throw new Error('LEADBANK_EMAIL / LEADBANK_PASSWORD are not set.');
  const res = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.leadBankEmail(), password: config.leadBankPassword() }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Lead bank sign-in failed: ${json.error || res.status}`);
  if (!['admin', 'staff'].includes(json.user && json.user.role)) throw new Error('The lead bank account the CRM uses must be staff or admin.');
  const set = res.headers.get('set-cookie') || '';
  const m = set.match(/ab_session=[^;]+/);
  if (!m) throw new Error('Lead bank sign-in returned no session.');
  cookie = m[0];
}

async function call(method, path, body, retried = false) {
  if (!cookie) await login();
  const res = await fetch(`${config.leadBankUrl()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 && !retried) {
    cookie = null;
    return call(method, path, body, true);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Lead bank ${method} ${path}: ${json.error || `HTTP ${res.status}`}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const isConfigured = () => Boolean(config.leadBankUrl() && config.leadBankEmail() && config.leadBankPassword());
const portalUrl = () => `${config.leadBankUrl()}/login.html`;
const resetSession = () => { cookie = null; };

module.exports = { call, login, isConfigured, portalUrl, resetSession };
