// auth.js - staff sign-in. Same approach as the lead bank: scrypt password
// hashes, random session tokens in an HttpOnly cookie, only a hash stored.

const crypto = require('crypto');
const { promisify } = require('util');
const { db, nowISO } = require('./db');
const config = require('./config');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'abcrm_session';
const SESSION_DAYS = 30;

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(plain, stored) {
  const [scheme, N, r, p, saltHex, keyHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !keyHex) return false;
  try {
    const key = await scrypt(String(plain), Buffer.from(saltHex, 'hex'), keyHex.length / 2, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
  } catch (e) {
    return false;
  }
}

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, nowISO(), expires);
  return { token, expires };
}

function userForToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  ).get(hashToken(token));
  if (!row || !row.active) return null;
  if (row.expires_at <= nowISO()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return publicUser(row);
}

const publicUser = (u) => u && ({
  id: u.id, email: u.email, name: u.name, role: u.role, phone: u.phone,
  commission_rate: u.commission_rate, notify_new_leads: !!u.notify_new_leads, active: !!u.active,
});

async function createUser({ email, name, role = 'rep', phone = null, commission_rate = 0, notify_new_leads = false, password }) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, name, role, phone, commission_rate, notify_new_leads, password_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, String(email).trim().toLowerCase(), name, role, phone, Number(commission_rate) || 0,
    notify_new_leads ? 1 : 0, await hashPassword(password), nowISO());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token, expires) {
  // COOKIE_SAMESITE=none lets sign-in work when the CRM is shown inside
  // another page (a preview pane). Normal deployments leave it as Lax.
  const embedded = process.env.COOKIE_SAMESITE === 'none';
  const bits = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', embedded ? 'SameSite=None' : 'SameSite=Lax',
    `Expires=${new Date(expires).toUTCString()}`];
  if (config.isProduction() || embedded) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function attachUser(req, res, next) {
  req.sessionToken = readCookie(req, COOKIE);
  req.user = userForToken(req.sessionToken);
  next();
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if ((req.get('accept') || '').includes('text/html')) {
    return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return res.status(401).json({ error: 'Please sign in.' });
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (!req.user) return requireUser(req, res, next);
  return res.status(403).json({ error: 'Admins only.' });
}

// Slows password guessing. In memory: it only needs to last minutes.
const attempts = new Map();
function tooManyAttempts(key) {
  const recent = (attempts.get(key) || []).filter((t) => Date.now() - t < 15 * 60000);
  attempts.set(key, recent);
  return recent.length >= 8;
}
const recordFailure = (key) => attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
const clearAttempts = (key) => attempts.delete(key);

// First run: no accounts, so nobody could sign in. Creates one admin from
// BOOTSTRAP_ADMIN_* and only when the users table is empty.
async function bootstrapAdmin() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return null;
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return null;
  const user = await createUser({
    email, password, role: 'admin', name: process.env.BOOTSTRAP_ADMIN_NAME || 'Admin',
  });
  console.log(`[bootstrap] Created admin ${user.email}. Remove BOOTSTRAP_ADMIN_* now.`);
  return user;
}

module.exports = {
  hashPassword, verifyPassword, createSession, userForToken, createUser, publicUser,
  setSessionCookie, clearSessionCookie, attachUser, requireUser, requireAdmin,
  tooManyAttempts, recordFailure, clearAttempts, bootstrapAdmin, hashToken,
};
