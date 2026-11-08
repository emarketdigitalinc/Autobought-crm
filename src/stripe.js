// stripe.js - collecting payment from a signed dealer.
//
// Signing creates a Stripe Checkout link for a monthly subscription
// (leads/month × price per lead, in CAD). Mike can text or email it to the
// dealer while they're on the phone, and they pay on their phone with a card,
// Apple Pay or Google Pay. Or Mike opens it himself and keys the card in.
//
// When Stripe says the checkout completed, the deal is marked paid and, if
// HANDOFF_AFTER_PAYMENT is on (the default once Stripe is set up), the portal
// handoff runs then: no login until they've paid. Later invoices keep the
// payment status current (paid / past due / cancelled) and are recorded for
// the Overview's "collected" figure.
//
// No SDK: Stripe's API is plain form-encoded HTTPS.

const crypto = require('crypto');
const config = require('./config');
const { db, nowISO, logActivity, PACKAGE_LABELS } = require('./db');

const isConfigured = () => Boolean(config.stripeKey());

// Stripe wants nested form fields: a[b][0][c]=x.
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(method, path, body) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.stripeKey()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body ? form(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe: ${(json.error && json.error.message) || `HTTP ${res.status}`}`);
  return json;
}

const cents = (dollars) => Math.round(Number(dollars) * 100);

// A Checkout Session for the deal's monthly subscription. Reused while it's
// still open, so texting the link twice sends the same link.
async function paymentLink(deal) {
  if (!isConfigured()) throw new Error('Stripe is not connected (STRIPE_SECRET_KEY).');
  if (deal.payment_status === 'paid') throw new Error('This dealer has already paid.');
  if (deal.stripe_checkout_url && deal.stripe_checkout_expires && deal.stripe_checkout_expires > Date.now() / 1000 + 600) {
    return deal.stripe_checkout_url;
  }
  // "30 leads × $25" on the invoice when the value is exactly that; one line
  // for the monthly value when it was set by hand.
  const exact = Math.abs(deal.leads_per_month * deal.price_per_lead - deal.monthly_value) < 0.01;
  const product = `Autobought ${PACKAGE_LABELS[deal.package]} leads`;
  const line = exact
    ? { quantity: deal.leads_per_month, price_data: { currency: 'cad', unit_amount: cents(deal.price_per_lead), recurring: { interval: 'month' }, product_data: { name: `${product} (per lead)` } } }
    : { quantity: 1, price_data: { currency: 'cad', unit_amount: cents(deal.monthly_value), recurring: { interval: 'month' }, product_data: { name: `${product}, ${deal.leads_per_month}/month` } } };
  const meta = { deal_id: deal.id, lead_id: deal.lead_id, dealer: deal.dealer_name.slice(0, 200) };
  const base = config.appUrl();
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'subscription',
    customer_email: deal.portal_email,
    client_reference_id: String(deal.id),
    line_items: { 0: line },
    metadata: meta,
    subscription_data: { metadata: meta, description: `${deal.dealer_name}: ${deal.leads_per_month} ${PACKAGE_LABELS[deal.package]} leads/month` },
    automatic_tax: config.stripeAutomaticTax() ? { enabled: 'true' } : undefined,
    billing_address_collection: config.stripeAutomaticTax() ? 'required' : 'auto',
    custom_text: { submit: { message: `Your Autobought dealer portal is set up as soon as payment goes through.` } },
    success_url: `${base}/paid.html?dealer=${encodeURIComponent(deal.dealer_name)}`,
    cancel_url: `${base}/paid.html?cancelled=1`,
  });
  db.prepare("UPDATE deals SET stripe_checkout_id = ?, stripe_checkout_url = ?, stripe_checkout_expires = ?, payment_status = CASE WHEN payment_status IN ('none') THEN 'link_created' ELSE payment_status END, updated_at = ? WHERE id = ?")
    .run(session.id, session.url, session.expires_at || null, nowISO(), deal.id);
  logActivity(deal.lead_id, 'system', `Payment link created: ${deal.leads_per_month} leads × $${deal.price_per_lead} = $${deal.monthly_value}/month (CAD${config.stripeAutomaticTax() ? ', plus tax' : ''}).`);
  return session.url;
}

// Stripe signs each webhook: "t=<time>,v1=<hmac of `${t}.${body}`>".
function verifyWebhook(rawBody, header, toleranceSec = 300) {
  const secret = config.stripeWebhookSecret();
  if (!secret || !rawBody || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, v]));
  const sigs = String(header).split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!parts.t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

function dealFor(obj) {
  const meta = obj.metadata || {};
  const sub = obj.subscription && typeof obj.subscription === 'object' ? obj.subscription : null;
  const id = Number(meta.deal_id || obj.client_reference_id || (sub && sub.metadata && sub.metadata.deal_id)
    || (obj.subscription_details && obj.subscription_details.metadata && obj.subscription_details.metadata.deal_id)
    || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.metadata && obj.parent.subscription_details.metadata.deal_id));
  if (id) return db.prepare('SELECT * FROM deals WHERE id = ?').get(id);
  const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.object === 'subscription' ? obj.id : null;
  if (subId) return db.prepare('SELECT * FROM deals WHERE stripe_subscription_id = ?').get(subId);
  if (obj.customer) return db.prepare('SELECT * FROM deals WHERE stripe_customer_id = ?').get(obj.customer);
  return null;
}

// Returns what changed, and whether the portal handoff should run now.
function handleEvent(event) {
  const obj = event.data && event.data.object ? event.data.object : {};
  const deal = dealFor(obj);
  if (!deal) return { handled: false, reason: 'no matching deal' };
  const set = (fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE deals SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), nowISO(), deal.id);
  };
  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.payment_status && obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') return { handled: true, deal_id: deal.id };
      const first = deal.payment_status !== 'paid' && !deal.paid_at;
      set({ payment_status: 'paid', paid_at: deal.paid_at || nowISO(), stripe_customer_id: obj.customer || deal.stripe_customer_id, stripe_subscription_id: obj.subscription || deal.stripe_subscription_id });
      if (first) logActivity(deal.lead_id, 'system', `Paid through Stripe: subscription started ($${(Number(obj.amount_total || 0) / 100).toFixed(2)} ${String(obj.currency || 'cad').toUpperCase()} today).`);
      return { handled: true, deal_id: deal.id, handoff: first && config.handoffAfterPayment() && deal.handoff_status !== 'done' };
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      db.prepare(`INSERT INTO payments (deal_id, stripe_invoice_id, amount, currency, status, paid_at)
                  VALUES (?, ?, ?, ?, 'paid', ?) ON CONFLICT(stripe_invoice_id) DO UPDATE SET status = 'paid', amount = excluded.amount`)
        .run(deal.id, obj.id, Number(obj.amount_paid || 0) / 100, String(obj.currency || 'cad'), new Date((obj.status_transitions && obj.status_transitions.paid_at ? obj.status_transitions.paid_at : event.created) * 1000).toISOString());
      if (deal.payment_status !== 'paid') set({ payment_status: 'paid', paid_at: deal.paid_at || nowISO() });
      return { handled: true, deal_id: deal.id };
    }
    case 'invoice.payment_failed':
      set({ payment_status: 'past_due' });
      logActivity(deal.lead_id, 'system', `Stripe: a payment failed ($${(Number(obj.amount_due || 0) / 100).toFixed(2)}). Stripe will retry; the dealer may need to update their card.`);
      return { handled: true, deal_id: deal.id };
    case 'customer.subscription.updated':
      if (obj.status === 'past_due' || obj.status === 'unpaid') set({ payment_status: 'past_due' });
      else if (obj.status === 'active' && deal.payment_status === 'past_due') set({ payment_status: 'paid' });
      return { handled: true, deal_id: deal.id };
    case 'customer.subscription.deleted':
      set({ payment_status: 'cancelled' });
      logActivity(deal.lead_id, 'system', 'Stripe: the subscription was cancelled. Pause or cancel the deal if they should stop receiving leads.');
      return { handled: true, deal_id: deal.id };
    default:
      return { handled: false, reason: `ignored ${event.type}` };
  }
}

module.exports = { isConfigured, paymentLink, verifyWebhook, handleEvent, form };
