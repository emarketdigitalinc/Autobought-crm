// app.js - shared by every page: talking to the API, the header, formatting.

const CRM = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      throw new Error('Signed out');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  function toast(msg, bad = false) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = bad ? 'bad' : '';
    t.style.display = 'block';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.display = 'none'; }, bad ? 6000 : 2600);
  }

  let meta = null;
  async function header(active) {
    meta = await api('/meta');
    const links = [['index', 'Leads'], ['dashboard', 'Dashboard'], ['markets', 'Market map']];
    const h = document.createElement('header');
    h.className = 'top';
    h.innerHTML = `<a class="brand" href="/index.html">Autobought <span>CRM</span></a>
      <nav>${links.map(([p, l]) => `<a href="/${p}.html" class="${p === active ? 'on' : ''}">${l}</a>`).join('')}</nav>
      <div class="who"><span>${esc(meta.me.name)}</span><button class="ghost" id="signout">Sign out</button></div>`;
    document.body.prepend(h);
    h.querySelector('#signout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.href = '/login.html'; };
    return meta;
  }

  const fmtMinutes = (m) => {
    if (m === null || m === undefined) return '—';
    if (m < 60) return `${m} min`;
    if (m < 2880) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return `${Math.round(m / 1440)} days`;
  };
  const fmtWhen = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    const diff = (Date.now() - d) / 60000;
    if (diff < 1) return 'just now';
    if (diff < 60) return `${Math.round(diff)} min ago`;
    if (diff < 1440 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };
  const money = (n, dp = 2) => (n === null || n === undefined ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
  const pct = (r) => `${Math.round(Number(r || 0) * 1000) / 10}%`;
  const STAGE = { new: 'New', contacted: 'Contacted', working: 'Working', signed: 'Signed', lost: 'Lost' };
  const stageBadge = (s) => `<span class="badge ${esc(s)}">${STAGE[s] || esc(s)}</span>`;
  const AV = { open: 'Open', taken: 'Taken', partly: 'Partly taken', unknown: 'Market?' };
  const availBadge = (a) => `<span class="badge ${esc(a)}">${AV[a] || esc(a)}</span>`;
  const CAT = { automotive: 'Automotive', powersport: 'Powersport', rv_marine: 'RV/Marine' };
  const cats = (csv) => String(csv || '').split(',').filter(Boolean).map((c) => CAT[c] || c).join(', ');
  const tel = (phone) => {
    const d = String(phone || '').replace(/\D/g, '');
    if (d.length < 7) return null;
    return d.length === 10 ? `+1${d}` : `+${d}`;
  };
  const qs = (k) => new URLSearchParams(location.search).get(k);

  return { api, toast, header, esc, fmtMinutes, fmtWhen, money, pct, stageBadge, availBadge, cats, tel, qs, STAGE, CAT, get meta() { return meta; } };
})();
