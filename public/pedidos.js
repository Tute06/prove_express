// Listado detallado de pedidos de todos los canales (back-office).
const $ = (s) => document.querySelector(s);
const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('es-AR'));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fecha = (iso) => new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const CANAL = { web: '🛒 Tienda web', whatsapp: '🟢 WhatsApp', telefono: '📞 Teléfono' };
const ESTADOS = [['borrador', 'Borrador'], ['confirmado', 'Confirmado'], ['preparando', 'Preparando'], ['en_camino', 'En camino'], ['entregado', 'Entregado'], ['cancelado', 'Cancelado']];
const ESTADO_PILL = { borrador: 'warn', confirmado: 'info', preparando: '', en_camino: '', entregado: 'muted', cancelado: 'danger' };
const SIGUIENTE = { confirmado: 'preparando', preparando: 'en_camino', en_camino: 'entregado' };
const PAGO = { efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta_debito: 'Débito', tarjeta_credito: 'Crédito', mercado_pago: 'Mercado Pago' };
const nombreEstado = (k) => ESTADOS.find((e) => e[0] === k)?.[1] || k;

let pedidos = [];
let filtro = { estado: '', canal: '', q: '' };

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), 3000);
}

function chips() {
  const cuenta = (f) => pedidos.filter(f).length;
  $('#fEstado').innerHTML = [['', 'Todos los estados'], ...ESTADOS].map(([k, l]) =>
    `<a href="#" class="chip ${filtro.estado === k ? 'on' : ''}" data-estado="${k}">${l} <span style="opacity:.6">${cuenta((o) => !k || o.status === k)}</span></a>`).join('');
  $('#fCanal').innerHTML = [['', 'Todos los canales'], ...Object.entries(CANAL)].map(([k, l]) =>
    `<a href="#" class="chip ${filtro.canal === k ? 'on' : ''}" data-canal="${k}">${l} <span style="opacity:.6">${cuenta((o) => !k || o.channel === k)}</span></a>`).join('');
}

function tarjeta(o) {
  const sig = SIGUIENTE[o.status];
  const items = o.items.map((i) => `<tr>
      <td class="num">${i.quantity}${i.unit === 'kg' ? ' kg' : ' ×'}</td>
      <td>${esc(i.name || i.rawText)}${i.status !== 'ok' ? ` <span class="pill warn">${esc(i.status.replace('_', ' '))}</span>` : ''}${i.alternativeName ? `<br><small>↪ ofrecido: ${esc(i.alternativeName)}</small>` : ''}</td>
      <td class="num">${i.status === 'ok' ? money(i.subtotal) : '—'}</td></tr>`).join('');
  return `<article class="card order-detail">
    <div class="row" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
      <b style="font-size:1.15rem">${o.number}</b>
      <span class="pill ${o.channel === 'web' ? 'info' : 'muted'}">${CANAL[o.channel] || o.channel}</span>
      <span class="pill ${ESTADO_PILL[o.status] ?? ''}">${nombreEstado(o.status)}</span>
      <small style="margin-left:auto;color:var(--muted)">${fecha(o.createdAt)}</small>
    </div>
    <dl>
      <dt>Cliente</dt><dd>${esc(o.customer?.name || '—')}${o.customer?.socio ? ` · socio ${esc(o.customer.socio)}` : ''}${o.customer?.phone && !o.customer.phone.startsWith('socio') ? ` · ${esc(o.customer.phone)}` : ''}</dd>
      <dt>Entrega</dt><dd>${esc(o.address || '—')}${o.zone ? ` (${esc(o.zone)})` : ''}</dd>
      <dt>Horario</dt><dd>${esc([o.deliveryDay, o.deliverySlot].filter(Boolean).join(', ') || '—')}</dd>
      <dt>Pago</dt><dd>${esc(PAGO[o.paymentMethod] || o.paymentMethod || '—')}</dd>
      ${o.notes ? `<dt>Notas</dt><dd>${esc(o.notes)}</dd>` : ''}
    </dl>
    ${o.problems?.length ? `<div class="problems">${o.problems.map((p) => `<span class="pill warn">${esc(p)}</span>`).join('')}</div>` : ''}
    <table>${items}
      <tr><td></td><td>Subtotal</td><td class="num">${money(o.subtotal)}</td></tr>
      ${o.paymentDiscount ? `<tr><td></td><td>Descuento ${esc(PAGO[o.paymentMethod] || o.paymentMethod)} (${o.paymentDiscountPct}%)</td><td class="num">−${money(o.paymentDiscount)}</td></tr>` : ''}
      <tr><td></td><td>Envío</td><td class="num">${o.shippingCost === 0 ? 'Gratis' : money(o.shippingCost)}</td></tr>
      <tr class="tot"><td></td><td><b>Total</b></td><td class="num"><b>${money(o.total)}</b></td></tr>
    </table>
    <small style="color:var(--muted)">Historial: ${o.history.map((h) => `${nombreEstado(h.status)} (${h.by}, ${fecha(h.at)})`).join(' → ')}</small>
    <div class="actions">
      ${o.status === 'borrador' ? `<button class="small" data-st="confirmado" data-oid="${o.id}" ${o.problems?.length ? 'disabled title="Faltan datos"' : ''}>Confirmar</button>` : ''}
      ${sig ? `<button class="small" data-st="${sig}" data-oid="${o.id}">Pasar a ${nombreEstado(sig)}</button>` : ''}
      ${!['entregado', 'cancelado'].includes(o.status) ? `<button class="small ghost" data-st="cancelado" data-oid="${o.id}">Cancelar</button>` : ''}
      <a class="chip" href="/panel.html#conv-${o.conversationId}">Ver conversación</a>
    </div>
  </article>`;
}

function render() {
  const q = filtro.q.toLowerCase();
  const vis = pedidos.filter((o) => (!filtro.estado || o.status === filtro.estado) && (!filtro.canal || o.channel === filtro.canal)
    && (!q || [o.number, o.customer?.name, o.customer?.socio, o.customer?.phone, o.address].join(' ').toLowerCase().includes(q)));
  $('#cnt').textContent = `${vis.length} de ${pedidos.length}`;
  chips();
  $('#lista').innerHTML = vis.map(tarjeta).join('') || '<div class="empty card">No hay pedidos con esos filtros.</div>';
}

async function cargar() {
  const res = await fetch('/api/pedidos');
  if (res.status === 401) return (location.href = '/admin.html');
  pedidos = (await res.json()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  render();
}

document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-estado],[data-canal]');
  if (c) {
    e.preventDefault();
    if ('estado' in c.dataset) filtro.estado = c.dataset.estado;
    if ('canal' in c.dataset) filtro.canal = c.dataset.canal;
    return render();
  }
  const b = e.target.closest('button[data-st]');
  if (b) {
    const res = await fetch(`/api/pedidos/${b.dataset.oid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: b.dataset.st }) });
    const d = await res.json();
    if (!res.ok) return toast(d.error || 'No se pudo actualizar');
    toast(`${d.number}: ${nombreEstado(d.status)}`);
    cargar();
  }
});
$('#q').oninput = (e) => { filtro.q = e.target.value; render(); };
$('#adminLogout').onclick = async () => { await fetch('/api/admin/logout', { method: 'POST' }); location.href = '/admin.html'; };

const clock = $('#clock');
const tick = () => { clock.textContent = new Date().toLocaleString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
tick(); setInterval(tick, 1000);
cargar();
setInterval(cargar, 5000);
