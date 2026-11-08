// notify.js - texts and emails. Twilio for SMS, Resend for email, both over
// plain HTTPS (Railway blocks outbound SMTP). With no keys set, sending is
// simulated: logged and reported as simulated, never as sent.

const config = require('./config');
const { db, e164, CATEGORY_LABELS, SOURCES } = require('./db');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function allowed(address) {
  const list = config.notifyAllowlist();
  return !list.length || list.includes(String(address || '').toLowerCase());
}

async function sendEmail({ to, subject, html, text, from = config.emailFrom(), bcc, replyTo }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean).filter(allowed);
  if (!recipients.length) return { sent: false, simulated: false, detail: 'No allowed recipient.' };
  if (!config.resendKey()) {
    console.log(`[email:simulated] to=${recipients.join(',')} subject="${subject}"`);
    return { sent: false, simulated: true, detail: 'RESEND_API_KEY not set; simulated.' };
  }
  const body = { from, to: recipients, subject, html, text };
  if (bcc) body.bcc = (Array.isArray(bcc) ? bcc : String(bcc).split(',')).map((s) => s.trim()).filter(Boolean);
  if (replyTo) body.reply_to = replyTo;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Resend refused the email (HTTP ${res.status})`);
  return { sent: true, id: json.id };
}

async function sendSms({ to, body }) {
  const number = e164(to);
  if (!number) return { sent: false, simulated: false, detail: 'No usable phone number.' };
  if (!allowed(number)) return { sent: false, simulated: false, detail: 'Number not on NOTIFY_ALLOWLIST.' };
  if (!config.twilioSid() || !config.twilioToken() || !config.twilioFrom()) {
    console.log(`[sms:simulated] to=${number} body="${body}"`);
    return { sent: false, simulated: true, detail: 'Twilio not configured; simulated.' };
  }
  const auth = Buffer.from(`${config.twilioSid()}:${config.twilioToken()}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid()}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: number, From: config.twilioFrom(), Body: body }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Twilio refused the text (HTTP ${res.status})`);
  return { sent: true, id: json.sid };
}

// Speed-to-lead: everyone with "text me new leads" on hears immediately.
function newLeadMessages(lead, { repeat = false } = {}) {
  const tel = e164(lead.phone);
  const link = `${config.appUrl()}/lead.html?id=${encodeURIComponent(lead.id)}`;
  const where = [lead.dealership, lead.city].filter(Boolean).join(', ');
  const head = repeat ? 'Dealer lead submitted AGAIN' : 'New dealer lead';
  const src = `${lead.source} · ${SOURCES[lead.source] || ''}`;
  const sells = (lead.categories || '').split(',').filter(Boolean).map((c) => CATEGORY_LABELS[c]).join(', ');

  const sms = [
    `${head} (${src})`,
    `${lead.name || 'No name'}${where ? ` – ${where}` : ''}`,
    lead.role ? `Role: ${lead.role}` : null,
    tel ? `Call: ${tel}` : 'No phone given',
    link,
  ].filter(Boolean).join('\n');

  const rows = [
    ['Name', lead.name], ['Dealership', lead.dealership], ['City', lead.city], ['Role', lead.role],
    ['Sells', sells || lead.sells], ['Leads/month', lead.leads_wanted], ['Phone', lead.phone], ['Email', lead.email],
    ['Source', src], ['Ad', lead.ad_name || lead.utm_content],
  ].filter(([, v]) => v);

  const html = `<!doctype html><html><body style="margin:0;background:#eef1f6;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
 <div style="background:#fff;border-radius:8px;padding:22px 24px">
  <p style="margin:0 0 4px;font-size:11px;letter-spacing:1.3px;text-transform:uppercase;color:#f47a2a;font-weight:bold">${esc(head)}</p>
  <h2 style="margin:0 0 14px;font-size:20px;color:#0e2544">${esc(lead.name || 'No name')}${lead.dealership ? ` · ${esc(lead.dealership)}` : ''}</h2>
  ${tel ? `<a href="tel:${esc(tel)}" style="display:block;text-align:center;background:#127a4b;color:#fff;text-decoration:none;font-weight:bold;font-size:17px;padding:14px;border-radius:8px;margin-bottom:16px">Call ${esc(lead.phone)}</a>` : ''}
  <table style="border-collapse:collapse;font-size:14px;margin-bottom:16px">${rows.map(([k, v]) => `<tr><td style="padding:5px 16px 5px 0;color:#63708c">${esc(k)}</td><td style="padding:5px 0;color:#101a2e;font-weight:600">${esc(v)}</td></tr>`).join('')}</table>
  <a href="${esc(link)}" style="color:#1263b4;font-weight:bold">Open in the CRM</a>
 </div></div></body></html>`;

  const text = `${sms}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}`;
  const subject = `${head}: ${lead.name || 'No name'}${lead.dealership ? ` (${lead.dealership})` : ''}`;
  return { sms, email: { subject, html, text } };
}

async function alertNewLead(lead, opts = {}) {
  const people = db.prepare('SELECT * FROM users WHERE active = 1 AND notify_new_leads = 1').all();
  const msg = newLeadMessages(lead, opts);
  const results = [];
  for (const p of people) {
    for (const [channel, fn] of [
      ['text', () => (p.phone ? sendSms({ to: p.phone, body: msg.sms }) : { sent: false, detail: 'no phone on file' })],
      ['email', () => sendEmail({ to: p.email, ...msg.email })],
    ]) {
      try {
        results.push({ to: p.name, channel, ...(await fn()) });
      } catch (err) {
        results.push({ to: p.name, channel, sent: false, error: err.message });
      }
    }
  }
  return results;
}

module.exports = { sendEmail, sendSms, alertNewLead, newLeadMessages, esc };
