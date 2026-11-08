// routes/webhooks.js - the doors leads come in through.
//
//   GET  /webhooks/meta       Meta's subscription check (hub.challenge)
//   POST /webhooks/meta       Meta leadgen webhook (signed with the app secret)
//   POST /webhooks/jotform    Jotform's own webhook, ?secret=JOTFORM_WEBHOOK_SECRET
//   POST /webhooks/lead       Tidy JSON (Zapier, tests), header x-webhook-secret

const express = require('express');
const multer = require('multer');
const config = require('../config');
const intake = require('../intake');
const { verifyMetaSignature, leadgenChanges } = require('../sources');

const router = express.Router();
const formParts = multer({ limits: { fields: 400, fieldSize: 512 * 1024 } }).none();

router.get('/meta', (req, res) => {
  const ok = req.query['hub.mode'] === 'subscribe' && config.metaVerifyToken()
    && req.query['hub.verify_token'] === config.metaVerifyToken();
  if (!ok) return res.status(403).send('Verification failed.');
  res.status(200).send(String(req.query['hub.challenge'] || ''));
});

router.post('/meta', async (req, res) => {
  if (!verifyMetaSignature(req.rawBody, req.get('x-hub-signature-256'))) {
    return res.status(401).json({ error: 'Bad signature.' });
  }
  const changes = leadgenChanges(req.body);
  const rows = changes.map((c) => intake.receive('meta', c, c.leadgen_id)).filter((r) => !r.repeat).map((r) => r.row);
  // Meta wants a quick 200. Everything is already stored, so processing
  // (fetching the answers, alerting Mike) happens straight after.
  res.status(200).json({ received: changes.length, new: rows.length });
  for (const row of rows) await intake.processInbox(row);
});

router.post('/jotform', formParts, async (req, res) => {
  if (config.jotformSecret() && req.query.secret !== config.jotformSecret()) {
    return res.status(401).json({ error: 'Invalid or missing secret.' });
  }
  const body = req.body || {};
  if (typeof body.rawRequest !== 'string') return res.status(400).json({ error: 'Not a Jotform webhook (no rawRequest).' });
  const { row, repeat } = intake.receive('jotform', body, body.submissionID);
  if (repeat) return res.status(200).json({ ok: true, received: 'already received' });
  const result = await intake.processInbox(row);
  res.status(result.outcome === 'error' ? 202 : 200).json({ ok: true, outcome: result.outcome });
});

// Stripe: payment completed / invoices / cancellations.
router.post('/stripe', async (req, res) => {
  const stripe = require('../stripe');
  if (!stripe.verifyWebhook(req.rawBody, req.get('stripe-signature'))) return res.status(400).json({ error: 'Bad signature.' });
  const result = stripe.handleEvent(req.body || {});
  res.json({ received: true, ...result });
  if (result.handoff) await require('../deals').runHandoff(result.deal_id);
});

router.post('/lead', async (req, res) => {
  if (!config.webhookSecret()) return res.status(503).json({ error: 'WEBHOOK_SECRET is not set, so this door is closed.' });
  if ((req.get('x-webhook-secret') || req.query.secret) !== config.webhookSecret()) {
    return res.status(401).json({ error: 'Invalid or missing webhook secret.' });
  }
  const body = req.body || {};
  const { row, repeat } = intake.receive('flat', body, body.external_id || body.leadgen_id || body.meta_lead_id);
  if (repeat) return res.status(200).json({ ok: true, received: 'already received', lead_id: row.lead_id });
  const result = await intake.processInbox(row);
  if (result.outcome === 'error') return res.status(202).json({ ok: false, error: result.error, queued_for_retry: true });
  res.status(result.outcome === 'new' ? 201 : 200).json({ ok: true, outcome: result.outcome, lead_id: result.lead ? result.lead.id : null });
});

module.exports = router;
