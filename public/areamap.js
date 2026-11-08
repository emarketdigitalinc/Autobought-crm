// areamap.js - the map pieces: a Canada map with clickable provinces, and an
// area picker that works like Meta's location targeting (whole provinces,
// or a city + radius). Needs Leaflet loaded first.

const AreaMap = (() => {
  let provincesPromise = null;
  const loadProvinces = () => (provincesPromise ||= fetch('/geo/ca-provinces.json').then((r) => r.json()));

  const BLUE = '#1263b4';
  const ORANGE = '#f47a2a';

  // A Leaflet map of Canada with the provinces drawn on it.
  async function create(el, { onProvinceClick, onMapClick, provinceStyle, provinceTooltip } = {}) {
    const map = L.map(el, { zoomSnap: 0.25, scrollWheelZoom: false, attributionControl: true }).setView([56, -96], 3.25);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 12, subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
    map.on('focus', () => map.scrollWheelZoom.enable());
    map.on('blur', () => map.scrollWheelZoom.disable());

    const geo = await loadProvinces();
    const style = provinceStyle || (() => ({ color: '#8a97ad', weight: 1, fillOpacity: 0.04, fillColor: '#8a97ad' }));
    const layer = L.geoJSON(geo, {
      style: (f) => style(f.properties.code),
      onEachFeature: (f, lyr) => {
        if (provinceTooltip) lyr.bindTooltip(() => provinceTooltip(f.properties.code, f.properties.name), { sticky: true });
        lyr.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (onProvinceClick) onProvinceClick(f.properties.code, e.latlng, f.properties.name);
          else if (onMapClick) onMapClick(e.latlng);
        });
        lyr.on('mouseover', () => lyr.setStyle({ weight: 2 }));
        lyr.on('mouseout', () => layer.resetStyle(lyr));
      },
    }).addTo(map);
    if (onMapClick) map.on('click', (e) => onMapClick(e.latlng));

    const overlay = L.layerGroup().addTo(map);
    return {
      map,
      overlay,
      restyle: () => layer.setStyle((f) => style(f.properties.code)),
      provinceBounds: (code) => {
        let b = null;
        layer.eachLayer((l) => { if (l.feature.properties.code === code) b = l.getBounds(); });
        return b;
      },
      fitTo(areas, pins = []) {
        const bounds = L.latLngBounds([]);
        for (const a of areas) {
          if (a.kind === 'radius') bounds.extend(L.latLng(a.lat, a.lng).toBounds(a.radius_km * 2000));
          else { const b = this.provinceBounds(a.province); if (b) bounds.extend(b); }
        }
        for (const p of pins) bounds.extend([p[0], p[1]]);
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 7 });
      },
    };
  }

  // The area picker. Returns { get(): areas }.
  async function picker(container, { areas = [], onChange = () => {}, center = null } = {}) {
    let list = areas.map((a) => ({ ...a }));
    let mode = 'province';
    let radius = 50;
    let selected = -1;
    container.innerHTML = `
      <div class="picker">
        <div class="row" style="gap:8px;align-items:center;margin-bottom:8px">
          <div class="tabs"><button type="button" data-mode="province" class="on">Provinces</button><button type="button" data-mode="radius">City + radius</button></div>
          <div class="searchbox"><input type="search" placeholder="Search a city or town" autocomplete="off" /><div class="results" hidden></div></div>
          <label class="radius" hidden>Radius <input type="range" min="10" max="300" step="5" value="50" /> <strong>50 km</strong></label>
        </div>
        <p class="small muted hint" style="margin:0 0 6px">Click a province to add or remove it.</p>
        <div class="mapbox"></div>
        <div class="chips"></div>
      </div>`;
    const $ = (s) => container.querySelector(s);
    const hint = $('.hint');
    const slider = $('.radius input');
    const sliderLabel = $('.radius strong');

    const style = (code) => list.some((a) => a.kind === 'province' && a.province === code)
      ? { color: BLUE, weight: 2, fillColor: BLUE, fillOpacity: 0.28 }
      : { color: '#8a97ad', weight: 1, fillColor: '#8a97ad', fillOpacity: 0.04 };

    const m = await create($('.mapbox'), {
      provinceStyle: style,
      provinceTooltip: (code, name) => name,
      onProvinceClick: (code, latlng, name) => {
        if (mode === 'radius') return addRadius({ name: 'Pin', lat: latlng.lat, lng: latlng.lng, province: code });
        const i = list.findIndex((a) => a.kind === 'province' && a.province === code);
        if (i > -1) list.splice(i, 1);
        else list.push({ kind: 'province', province: code, label: name });
        changed();
      },
      onMapClick: (latlng) => { if (mode === 'radius') addRadius({ name: 'Pin', lat: latlng.lat, lng: latlng.lng }); },
    });

    function addRadius(p) {
      list.push({ kind: 'radius', name: p.name, province: p.province || null, lat: p.lat, lng: p.lng, radius_km: radius, label: `${p.name} +${radius} km` });
      selected = list.length - 1;
      changed();
    }

    function draw() {
      m.restyle();
      m.overlay.clearLayers();
      list.forEach((a, i) => {
        if (a.kind !== 'radius') return;
        const c = L.circle([a.lat, a.lng], { radius: a.radius_km * 1000, color: i === selected ? ORANGE : BLUE, weight: 2, fillOpacity: 0.18 });
        c.on('click', (e) => { L.DomEvent.stopPropagation(e); select(i); });
        c.bindTooltip(a.label);
        c.addTo(m.overlay);
        L.circleMarker([a.lat, a.lng], { radius: 3, color: i === selected ? ORANGE : BLUE, fillOpacity: 1 }).addTo(m.overlay);
      });
      $('.chips').innerHTML = list.length
        ? list.map((a, i) => `<span class="chip ${i === selected ? 'sel' : ''}" data-i="${i}">${a.kind === 'province' ? '▦' : '◎'} ${CRM.esc(a.label)} <button type="button" data-x="${i}" aria-label="Remove">×</button></span>`).join('')
        : '<span class="small muted">No areas yet.</span>';
      container.querySelectorAll('.chip').forEach((el) => el.onclick = (e) => {
        if (e.target.dataset.x !== undefined) { list.splice(Number(e.target.dataset.x), 1); selected = -1; changed(); return; }
        select(Number(el.dataset.i));
      });
    }

    function select(i) {
      selected = i;
      const a = list[i];
      if (a && a.kind === 'radius') {
        setMode('radius');
        slider.value = a.radius_km; radius = a.radius_km; sliderLabel.textContent = `${radius} km`;
      }
      draw();
    }

    function changed() { draw(); onChange(get()); }
    function get() { return list.map((a) => ({ ...a })); }

    function setMode(next) {
      mode = next;
      container.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
      $('.radius').hidden = mode !== 'radius';
      hint.textContent = mode === 'province'
        ? 'Click a province to add or remove it.'
        : 'Search a town or click the map to drop a radius. Click a circle to change its size.';
    }
    container.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => setMode(b.dataset.mode));

    slider.oninput = () => {
      radius = Number(slider.value);
      sliderLabel.textContent = `${radius} km`;
      const a = list[selected];
      if (a && a.kind === 'radius') {
        a.radius_km = radius;
        a.label = `${(a.name || a.label.replace(/\s*\+\d+\s*km$/, ''))} +${radius} km`;
        changed();
      }
    };

    // City search -> a radius around it.
    const input = $('.searchbox input');
    const results = $('.searchbox .results');
    let timer;
    input.oninput = () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { results.hidden = true; return; }
      timer = setTimeout(async () => {
        const { results: found } = await CRM.api(`/geocode?q=${encodeURIComponent(q)}`);
        results.innerHTML = found.length
          ? found.map((r, i) => `<button type="button" data-i="${i}">${CRM.esc(r.label)}</button>`).join('')
          : '<div class="small muted" style="padding:8px">No match.</div>';
        results.hidden = false;
        results.querySelectorAll('button').forEach((b) => b.onclick = () => {
          const r = found[Number(b.dataset.i)];
          setMode('radius');
          addRadius({ name: r.name, province: r.province, lat: r.lat, lng: r.lng });
          m.map.setView([r.lat, r.lng], 7);
          input.value = ''; results.hidden = true;
        });
      }, 250);
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const b = results.querySelector('button'); if (b) b.click(); } };

    if (list[0] && list[0].kind === 'radius') setMode('radius');
    draw();
    if (list.length) setTimeout(() => m.fitTo(list), 60);
    else if (center) m.map.setView(center, 6);
    // Dialogs open after the map is built; let it measure itself again.
    setTimeout(() => m.map.invalidateSize(), 50);
    return { get, map: m.map, refresh: () => m.map.invalidateSize() };
  }

  return { create, picker, loadProvinces, BLUE, ORANGE };
})();
