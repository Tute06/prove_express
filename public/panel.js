const $ = (s) => document.querySelector(s);
const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('es-AR'));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hora = (iso) => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
const ALERTA_MIN = 5;

const CANAL = { whatsapp: '🟢 WhatsApp', telefono: '📞 Teléfono', web: '🛒 Tienda web' };
const ESTADO_CONV = {
  esperando_respuesta: ['Esperando', 'warn'],
  requiere_humano: ['Requiere humano', 'danger'],
  respuesta_sugerida: ['Respuesta sugerida', 'info'],
  respondida: ['Respondida', ''],
  cerrada: ['Cerrada', 'muted'],
};
const URG = { alta: 'danger', media: 'warn', baja: 'muted' };
const ESTADOS = [
  ['borrador', 'Borrador (falta info)'],
  ['confirmado', 'Confirmado'],
  ['preparando', 'Preparando'],
  ['en_camino', 'En camino'],
  ['entregado', 'Entregado'],
  ['cancelado', 'Cancelado'],
];
const SIGUIENTE = { confirmado: 'preparando', preparando: 'en_camino', en_camino: 'entregado' };
const ITEM_ESTADO = { ok: '', sin_stock: ['sin stock', 'danger'], a_definir: ['a definir', 'warn'], no_existe: ['no existe', 'danger'] };

let state = { convs: [], orders: [], selected: null };

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.style.display = 'none'), 3500);
}

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function waitingMin(c) {
  if (!['esperando_respuesta', 'requiere_humano'].includes(c.status) || !c.lastCustomerAt) return 0;
  return Math.floor((Date.now() - Date.parse(c.lastCustomerAt)) / 60000);
}

function priority(c) {
  const s = { requiere_humano: 0, esperando_respuesta: 1, respuesta_sugerida: 2, respondida: 3, cerrada: 4 }[c.status] ?? 5;
  const u = { alta: 0, media: 1, baja: 2 }[c.urgency] ?? 1;
  return s * 10 + u;
}

function renderInbox() {
  const list = [...state.convs].sort((a, b) => priority(a) - priority(b) || b.updatedAt.localeCompare(a.updatedAt));
  const pend = list.filter((c) => ['esperando_respuesta', 'requiere_humano', 'respuesta_sugerida'].includes(c.status)).length;
  $('#inboxCount').textContent = `${pend} pendientes`;
  $('#inbox').innerHTML = list.length
    ? list.map((c) => {
        const [lbl, cls] = ESTADO_CONV[c.status] || [c.status, ''];
        const w = waitingMin(c);
        const last = c.messages[c.messages.length - 1];
        return `<div class="conv ${c.id === state.selected ? 'active' : ''} ${w >= ALERTA_MIN || c.status === 'requiere_humano' ? 'alert' : ''}" data-id="${c.id}">
          <div class="row"><span class="name">${esc(c.customer.name || c.customer.phone || 'Sin nombre')}</span><span class="pill ${cls}">${lbl}</span></div>
          <div class="row" style="margin-top:.25rem"><small>${CANAL[c.channel] || c.channel}</small>
            ${c.intent ? `<span class="pill muted">${c.intent}</span>` : ''}
            <span class="pill ${URG[c.urgency] || ''}">${c.urgency}</span>
            ${w ? `<span class="wait">⏱ ${w} min</span>` : ''}</div>
          <div class="last">${esc(last?.text)}</div>
        </div>`;
      }).join('')
    : '<div class="empty">Todavía no entraron mensajes.<br>Probá con un ejemplo de abajo o abrí el chat del cliente.</div>';
}

function renderOrder(o, withActions = true) {
  if (!o) return '';
  const items = o.items.map((i) => {
    const st = ITEM_ESTADO[i.status];
    const badge = st ? `<span class="pill ${st[1]}">${st[0]}</span>` : '';
    const alt = i.alternativeName ? `<br><small>↪ ofrecido: ${esc(i.alternativeName)}</small>` : '';
    return `<tr><td>${i.quantity} ${i.unit === 'kg' ? 'kg' : '×'}</td>
      <td>${esc(i.name || i.rawText)} ${badge}${i.name && i.rawText ? `<br><small style="color:var(--muted)">“${esc(i.rawText)}”</small>` : ''}${alt}</td>
      <td class="num">${i.status === 'ok' ? money(i.subtotal) : '—'}</td></tr>`;
  }).join('');
  const est = ESTADOS.find((e) => e[0] === o.status)?.[1] || o.status;
  const sig = SIGUIENTE[o.status];
  const acciones = withActions ? `<div class="actions">
      ${o.status === 'borrador' ? `<button class="small" data-st="confirmado" data-oid="${o.id}" ${o.problems?.length ? 'disabled title="Faltan datos"' : ''}>Confirmar</button>` : ''}
      ${sig ? `<button class="small" data-st="${sig}" data-oid="${o.id}">Pasar a ${ESTADOS.find((e) => e[0] === sig)[1]}</button>` : ''}
      ${!['entregado', 'cancelado'].includes(o.status) ? `<button class="small ghost" data-st="cancelado" data-oid="${o.id}">Cancelar</button>` : ''}
    </div>` : '';
  return `<div class="order">
    <div class="row" style="display:flex;gap:.4rem;align-items:center"><b style="flex:1">Pedido ${o.number}</b><span class="pill">${est}</span></div>
    ${o.problems?.length ? `<div class="problems">${o.problems.map((p) => `<span class="pill warn">${esc(p)}</span>`).join('')}</div>` : ''}
    <table>${items}
      <tr><td></td><td>Subtotal</td><td class="num">${money(o.subtotal)}</td></tr>
      ${o.paymentDiscount ? `<tr><td></td><td>Descuento ${esc((o.paymentMethod || '').replace('_', ' '))} (${o.paymentDiscountPct}%)</td><td class="num">−${money(o.paymentDiscount)}</td></tr>` : ''}
      <tr><td></td><td>Envío ${o.zone ? '(' + esc(o.zone) + ')' : ''}</td><td class="num">${o.shippingCost === 0 ? 'gratis' : money(o.shippingCost)}</td></tr>
      <tr class="tot"><td></td><td>Total</td><td class="num">${money(o.total)}</td></tr>
    </table>
    <dl>
      <dt>Cliente</dt><dd>${esc(o.customer?.name || '—')} ${esc(o.customer?.phone || '')}</dd>
      <dt>Dirección</dt><dd>${esc(o.address || '—')}</dd>
      <dt>Entrega</dt><dd>${esc([o.deliveryDay, o.deliverySlot].filter(Boolean).join(', ') || '—')}</dd>
      <dt>Pago</dt><dd>${esc((o.paymentMethod || '—').replace('_', ' '))}</dd>
      ${o.notes ? `<dt>Notas</dt><dd>${esc(o.notes)}</dd>` : ''}
    </dl>
    ${acciones}
  </div>`;
}

function renderDetail() {
  const c = state.convs.find((x) => x.id === state.selected);
  if (!c) return;
  const [lbl, cls] = ESTADO_CONV[c.status] || [c.status, ''];
  const msgs = c.messages.map((m) => {
    const quien = m.from === 'cliente' ? (c.customer.name || 'Cliente') : m.from === 'bot' ? (m.suggested ? '🤖 IA · respuesta sugerida' : m.fallback ? '🤖 aviso automático' : '🤖 IA') : '🧑 Operador';
    return `<div class="msg ${m.from}">${esc(m.text)}<span class="meta">${quien} · ${hora(m.at)}</span></div>`;
  }).join('');
  const sugerida = [...c.messages].reverse().find((m) => m.from === 'bot' && m.suggested);
  $('#detail').innerHTML = `
    <h2>${esc(c.customer.name || 'Sin nombre')} <small style="font-weight:400;color:var(--muted)">${esc(c.customer.phone || '')} · ${CANAL[c.channel]}</small>
      <span class="pill ${cls} count">${lbl}</span></h2>
    ${c.needsHumanReason ? `<div class="summary" style="background:var(--danger-soft);color:var(--danger)">⚠ ${esc(c.needsHumanReason)}${c.aiError ? ' — ' + esc(c.aiError) : ''}</div>` : ''}
    ${c.summary ? `<div class="summary">🤖 ${esc(c.summary)}</div>` : ''}
    <div class="thread" id="thread">${msgs}</div>
    <form id="reply" style="display:flex;gap:.4rem;margin-top:.5rem">
      <input name="text" placeholder="${c.channel === 'telefono' ? 'Mensaje para enviar al cliente' : 'Responder como operador'}" value="${sugerida && c.status === 'respuesta_sugerida' ? esc(sugerida.text) : ''}">
      <button>Enviar</button>
      <button type="button" class="ghost" id="closeConv">Cerrar</button>
    </form>
    ${renderOrder(c.order)}`;
  const th = $('#thread');
  th.scrollTop = th.scrollHeight;
}

const hace = (iso) => {
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  return min < 1 ? 'recién' : min < 60 ? `hace ${min} min` : min < 1440 ? `hace ${Math.floor(min / 60)} h` : new Date(iso).toLocaleDateString('es-AR');
};
const ESTADO_PILL = { borrador: 'warn', confirmado: 'info', preparando: '', en_camino: '', entregado: 'muted', cancelado: 'danger' };

// Resumen: los 6 pedidos más recientes de todos los canales (el detalle completo está en /pedidos.html).
function renderBoard() {
  const recientes = [...state.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  $('#ordCount').textContent = `${state.orders.length} en total`;
  $('#board').innerHTML = recientes.map((o) => `
      <div class="ocard ${o.channel === 'web' ? 'web' : ''}" data-conv="${o.conversationId}">
        <div class="row"><b>${o.number} · ${esc(o.customer?.name || '—')}</b><span>${money(o.total)}</span></div>
        <div class="row" style="margin-top:.3rem"><span class="pill ${o.channel === 'web' ? 'info' : 'muted'}">${CANAL[o.channel] || o.channel}</span>
          <span class="pill ${ESTADO_PILL[o.status] ?? ''}">${ESTADOS.find((e) => e[0] === o.status)?.[1] || o.status}</span>
          <small style="margin-left:auto;color:var(--muted)">${hace(o.createdAt)}</small></div>
        <small style="color:var(--muted)">${o.items.length} ítems${o.zone ? ' · ' + esc(o.zone) : ''}${o.deliverySlot ? ' · ' + esc(o.deliverySlot) : ''}</small>
      </div>`).join('') || '<div class="empty">Todavía no hay pedidos.</div>';
}

async function renderKpis() {
  const m = await api('/api/metricas');
  const k = [
    [m.mensajesCliente, 'mensajes recibidos'],
    [m.respuestasIA, 'respondidos por IA'],
    [m.sinResponder, 'sin responder'],
    [m.pedidosConfirmados + ' / ' + m.pedidos, 'pedidos confirmados'],
    [money(m.facturacion), 'facturación confirmada'],
  ];
  $('#kpis').innerHTML = k.map(([v, l]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
}

async function refresh() {
  try {
    [state.convs, state.orders] = await Promise.all([api('/api/conversaciones'), api('/api/pedidos')]);
    const active = document.activeElement;
    const typing = active && active.closest && active.closest('#reply') && active.value;
    renderInbox();
    renderBoard();
    if (!typing) renderDetail();
    renderKpis();
  } catch (e) {
    console.error(e);
  }
}

document.addEventListener('click', async (e) => {
  const conv = e.target.closest('.conv, .ocard');
  if (conv) {
    state.selected = Number(conv.dataset.id || conv.dataset.conv);
    renderInbox();
    renderDetail();
    return;
  }
  const btn = e.target.closest('button[data-st]');
  if (btn) {
    try {
      await api(`/api/pedidos/${btn.dataset.oid}`, { method: 'PATCH', body: { status: btn.dataset.st } });
      await refresh();
    } catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id === 'closeConv') {
    await api(`/api/conversaciones/${state.selected}/cerrar`, { method: 'POST' });
    refresh();
  }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button:not([type=button])');
  btn.disabled = true;
  try {
    if (f.id === 'reply' && f.text.value.trim()) {
      await api(`/api/conversaciones/${state.selected}/responder`, { method: 'POST', body: { text: f.text.value } });
      f.text.value = '';
    }
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

(async function init() {
  const h = await api('/health');
  const s = $('#aiStatus');
  s.textContent = h.ai ? `IA activa · ${h.model}` : 'IA sin key: modo solo registro';
  s.className = 'pill ' + (h.ai ? '' : 'danger');
  const clock = $('#clock');
  const tick = () => { clock.textContent = new Date().toLocaleString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  tick();
  setInterval(tick, 1000);
  // Enlace directo desde la lista de pedidos: /panel.html#conv-<id>
  const m = location.hash.match(/conv-(\d+)/);
  if (m) state.selected = Number(m[1]);
  await refresh();
  setInterval(refresh, 3000);
})();
