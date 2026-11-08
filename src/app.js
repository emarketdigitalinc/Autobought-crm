// app.js - the web app: webhooks (open, secret-checked), the staff API and
// pages (signed in).

const path = require('path');
const express = require('express');
const { attachUser, requireUser } = require('./auth');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  // Meta signs the exact bytes it sent, so keep them for the check.
  app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true, commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'local' }));
  app.use('/webhooks', require('./routes/webhooks'));

  app.use(attachUser);
  app.use('/api', require('./routes/api'));

  const OPEN = new Set(['/login.html', '/styles.css', '/app.js', '/favicon.svg']);
  app.get('/', (req, res) => res.redirect(req.user ? '/index.html' : '/login.html'));
  app.use((req, res, next) => (OPEN.has(req.path) || !req.path.endsWith('.html') ? next() : requireUser(req, res, next)));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[error]', err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  });
  return app;
}

module.exports = { buildApp };
