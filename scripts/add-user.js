// npm run add-user -- --email mike@autobought.ca --name Mike --password '...' [--admin] [--phone 780...] [--commission 0.2] [--notify]
const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(`--${k}`); return i > -1 ? args[i + 1] : undefined; };
const has = (k) => args.includes(`--${k}`);
const { createUser } = require('../src/auth');

(async () => {
  const email = get('email'); const password = get('password');
  if (!email || !password || password.length < 10) {
    console.error('Usage: npm run add-user -- --email x@y --name "Mike" --password "at least 10 chars" [--admin] [--phone 780...] [--commission 0.2] [--notify]');
    process.exit(1);
  }
  const u = await createUser({
    email, password, name: get('name') || email, role: has('admin') ? 'admin' : 'rep',
    phone: get('phone') || null, commission_rate: Number(get('commission') || 0), notify_new_leads: has('notify'),
  });
  console.log(`Created ${u.role} ${u.email}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
