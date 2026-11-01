// Utilidades comunes de la tienda de socios.
const $ = (s) => document.querySelector(s);
const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('es-AR'));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = (ruta) => encodeURIComponent(ruta.join('/'));
const TINT = {
  'Lácteos': '#e6f0ff', 'Panadería': '#fdebd3', 'Almacén': '#f6ecd9', 'Bebidas': '#dff3fb', 'Frutas y verduras': '#e3f6e0',
  'Carnicería': '#fde2e0', 'Limpieza': '#e4ecfb', 'Perfumería': '#f3e5fb',
};
const CAT_EMOJI = { 'Lácteos': '🥛', 'Panadería': '🥖', 'Almacén': '🥫', 'Bebidas': '🥤', 'Frutas y verduras': '🍎', 'Carnicería': '🥩', 'Limpieza': '🧽', 'Perfumería': '🧴' };
const tint = (cat) => TINT[cat] || '#f1ede2';
// Foto real si hay; si no, el emoji del producto.
const thumb = (p) => (p.img ? `<img src="/${p.img}" alt="${esc(p.nombre || p.name || '')}" loading="lazy">` : `<span class="e">${p.emoji || '🛒'}</span>`);

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Sesión vencida'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.append(t); }
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), 2500);
}

function setCartCount(cart) {
  const n = cart.items.length;
  const el = $('#cartN'); if (el) el.textContent = n;
}

async function header({ search = true } = {}) {
  const [me, cart] = await Promise.all([api('/api/me'), api('/api/carrito')]);
  const av = me.foto ? `<img class="avatar" src="${me.foto}" alt="">` : `<span class="avatar">${esc(me.nombre[0])}</span>`;
  document.body.insertAdjacentHTML('afterbegin', `
    <header class="nav">
      <a class="logo" href="/"><span class="logo-mark">PE</span><span>Provee Express<small>Club de socios</small></span></a>
      ${search ? `<form class="nav-search" action="/productos.html"><input name="q" placeholder="Buscá leche, yerba, detergente…" autocomplete="off"></form>` : '<div style="flex:1"></div>'}
      <nav class="nav-links">
        <a class="hide-sm" href="/productos.html">Productos</a>
        <a class="cart-pill" href="/carrito.html">🧺 Carrito <b id="cartN">0</b></a>
        <a href="/perfil.html" title="Mi perfil">${av}</a>
        <button id="logout" title="Salir">Salir</button>
      </nav>
    </header>`);
  footer();
  setCartCount(cart);
  $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login.html'; };
  return me;
}

// Footer común: marca al centro, fecha y hora en vivo a la derecha.
function footer() {
  document.body.insertAdjacentHTML('beforeend', `<footer class="foot"><span></span><span class="brand">Provee Express · 2026</span><span id="clock"></span></footer>`);
  const tick = () => { $('#clock').textContent = new Date().toLocaleString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  tick();
  setInterval(tick, 1000);
}

function prodCard(p, extra = '') {
  const unidad = p.unidad === 'kg' ? ' <small>/kg</small>' : '';
  const badge = p.stock <= 0 ? '<span class="badge ns">Sin stock</span>'
    : p.descuento ? `<span class="badge off">−${p.descuento}%</span>`
    : p.enPromo ? `<span class="badge promo-b" title="${esc(p.enPromo.join(', '))}">Promo</span>` : '';
  return `<div class="prod">
    <div class="ph${p.img ? ' foto' : ''}" style="--tint:${tint(p.ruta?.[0])}">${thumb(p)}${badge}
      <button class="add" data-add="${p.id}" ${p.stock <= 0 ? 'disabled' : ''} aria-label="Agregar ${esc(p.nombre)}">+</button></div>
    <div class="pr">${money(p.precio)}${unidad}${p.precioAntes ? `<s>${money(p.precioAntes)}</s>` : ''}</div>
    <div class="nm">${esc(p.nombre)}</div>${extra}
  </div>`;
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-add],[data-addpromo]');
  if (!b) return;
  const body = b.dataset.add ? { tipo: 'producto', id: b.dataset.add, cantidad: 1 } : { tipo: 'promo', id: b.dataset.addpromo, cantidad: 1 };
  try { setCartCount(await api('/api/carrito', { method: 'POST', body })); toast('Agregado al carrito ✔'); } catch (err) { toast(err.message); }
});

// Asistente IA: lista libre → ítems revisables → carrito.
function iaBox(el) {
  el.innerHTML = `<div class="ia-box">
    <span class="eyebrow" style="color:var(--accent)">Asistente con IA</span>
    <h3><span class="spark">✦</span> Armá tu carrito escribiendo tu lista</h3>
    <small>Pegala como la mandarías por WhatsApp. La IA la convierte en productos del catálogo, te avisa lo que no hay y vos revisás antes de agregar.</small>
    <textarea id="iaText" placeholder="ej: 2 leches, un kilo de pan, medio de queso cremoso, 3 coca grandes y yerba playadito" style="margin-top:.5rem"></textarea>
    <div style="display:flex;gap:.5rem;margin-top:.4rem"><button id="iaGo">Armar con IA</button></div>
    <div class="ia-res" id="iaRes"></div></div>`;
  let items = [];
  $('#iaGo').onclick = async () => {
    const text = $('#iaText').value.trim();
    if (!text) return;
    const b = $('#iaGo'); b.disabled = true; b.textContent = 'Pensando…';
    try {
      const r = await api('/api/ia/lista', { method: 'POST', body: { text } });
      items = r.items;
      const st = { ok: '', sin_stock: '<span class="pill danger">sin stock</span>', a_definir: '<span class="pill warn">no encontrado</span>', no_existe: '<span class="pill danger">no existe</span>' };
      $('#iaRes').innerHTML = `<div class="summary">🤖 ${esc(r.reply)}</div>
        <table>${items.map((i, n) => `<tr>
          <td><input type="checkbox" data-i="${n}" ${i.status === 'ok' ? 'checked' : ''} ${i.productId ? '' : 'disabled'}></td>
          <td><div class="mini">${thumb(i)}</div></td>
          <td><b>${esc(i.name || i.rawText)}</b> ${st[i.status] || ''}<br><small style="color:var(--muted)">“${esc(i.rawText)}”${i.note ? ' · ' + esc(i.note) : ''}</small>
            ${i.alternativeId ? `<br><label style="display:inline;color:var(--ink)"><input type="checkbox" data-alt="${n}" checked style="width:auto"> Reemplazar por <b>${esc(i.alternativeName)}</b></label>` : ''}</td>
          <td class="num">${i.quantity}${i.unit === 'kg' ? ' kg' : ' u'}</td>
          <td class="num">${i.status === 'ok' ? money(i.subtotal) : ''}</td></tr>`).join('')}</table>
        <button id="iaAdd" style="margin-top:.5rem">Agregar seleccionados al carrito</button>`;
      $('#iaAdd').onclick = async () => {
        const sel = [];
        items.forEach((i, n) => {
          const alt = document.querySelector(`[data-alt="${n}"]`);
          if (i.alternativeId && alt?.checked) sel.push({ tipo: 'producto', id: i.alternativeId, cantidad: i.quantity });
          else if (document.querySelector(`[data-i="${n}"]`)?.checked) sel.push({ tipo: 'producto', id: i.productId, cantidad: i.quantity });
        });
        if (!sel.length) return toast('No hay ítems seleccionados');
        setCartCount(await api('/api/carrito', { method: 'POST', body: { items: sel } }));
        toast(`${sel.length} productos agregados ✔`);
        $('#iaRes').innerHTML = `<div class="summary">✔ Listo. <a href="/carrito.html">Ver carrito</a></div>`;
        $('#iaText').value = '';
      };
    } catch (err) { $('#iaRes').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
    finally { b.disabled = false; b.textContent = 'Armar con IA'; }
  };
}
