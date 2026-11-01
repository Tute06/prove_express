// Utilidades comunes de la tienda de socios.
const $ = (s) => document.querySelector(s);
const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('es-AR'));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = (ruta) => encodeURIComponent(ruta.join('/'));

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
  const el = $('#cartN'); if (el) { el.textContent = n; el.style.display = n ? '' : 'none'; }
}

async function header() {
  const [me, cart] = await Promise.all([api('/api/me'), api('/api/carrito')]);
  const av = me.foto ? `<img class="avatar" src="${me.foto}" alt="">` : `<span class="avatar">${esc(me.nombre[0])}</span>`;
  document.body.insertAdjacentHTML('afterbegin', `
    <header class="top">
      <a href="/" style="text-decoration:none"><h1>🛒 La Esquina · Socios</h1></a>
      <div class="spacer"></div>
      <a class="btn" href="/productos.html">Productos</a>
      <a class="btn cartbtn" href="/carrito.html">🧺 Carrito <span class="n" id="cartN"></span></a>
      <a class="btn" href="/perfil.html">${av} ${esc(me.nombre.split(' ')[0])}</a>
      <a class="btn" href="#" id="logout">Salir</a>
    </header>`);
  setCartCount(cart);
  $('#logout').onclick = async (e) => { e.preventDefault(); await api('/api/logout', { method: 'POST' }); location.href = '/login.html'; };
  return me;
}

function prodCard(p, extra = '') {
  const unidad = p.unidad === 'kg' ? ' <small>/kg</small>' : '';
  return `<div class="prod">${extra}
    <div class="ph">${p.emoji}</div>
    ${p.descuento ? `<span class="pill danger" style="align-self:flex-start">OFERTA −${p.descuento}%</span>` : p.enPromo ? `<span class="pill warn" style="align-self:flex-start" title="${esc(p.enPromo.join(', '))}">En promo</span>` : ''}
    <div class="nm">${esc(p.nombre)}</div>
    <div class="pr">${money(p.precio)}${unidad}${p.precioAntes ? ` <small style="text-decoration:line-through">${money(p.precioAntes)}</small>` : ''}</div>
    ${p.stock <= 0 ? '<div class="ns">Sin stock</div>' : ''}
    <button class="small" data-add="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}>Agregar</button>
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
    <h3>✨ Armá tu carrito con IA</h3>
    <small>Escribí o pegá tu lista como la mandarías por WhatsApp. La IA la convierte en productos del catálogo y vos revisás antes de agregar.</small>
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
      $('#iaRes').innerHTML = `<div class="summary">🤖 ${esc(r.reply)} <small>(${(r.meta.ms / 1000).toFixed(1)} s)</small></div>
        <table>${items.map((i, n) => `<tr>
          <td><input type="checkbox" data-i="${n}" ${i.status === 'ok' ? 'checked' : ''} ${i.productId ? '' : 'disabled'}></td>
          <td>${i.emoji}</td>
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
