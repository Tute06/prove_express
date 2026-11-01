// Mesa de pedidos: recibe mensajes de cualquier canal, los guarda SIEMPRE, consulta a la IA
// y aplica el pedido estructurado validándolo contra el catálogo (precios y stock los calcula el servidor).
const db = require('./db');
const ai = require('./ai');
const negocio = require('../data/negocio.json');
const ofertas = require('./ofertas');

const CANALES = ['whatsapp', 'telefono', 'web'];
const ESTADOS_PEDIDO = ['borrador', 'confirmado', 'preparando', 'en_camino', 'entregado', 'cancelado'];
const now = () => new Date().toISOString();

const findConversation = (id) => db.conversacion(id);
const findOrder = (id) => db.pedido(id);

function getOrCreateConversation({ conversationId, channel, name, phone }) {
  let conv = conversationId ? findConversation(conversationId) : null;
  // Mismo teléfono y canal con conversación abierta: se continúa ahí (evita pedidos duplicados).
  if (!conv && phone) conv = db.conversacionAbierta(phone, channel);
  if (!conv) {
    conv = {
      id: null,
      channel: CANALES.includes(channel) ? channel : 'web',
      customer: { name: name || null, phone: phone || null },
      messages: [],
      status: 'esperando_respuesta',
      intent: null,
      urgency: 'media',
      orderId: null,
      summary: null,
      needsHumanReason: null,
      aiError: null,
      createdAt: now(),
      updatedAt: now(),
      lastCustomerAt: null,
      firstReplyMs: null,
    };
    db.crearConversacion(conv);
  }
  if (name && !conv.customer.name) conv.customer.name = name;
  return conv;
}

function addMessage(conv, from, text, extra = {}) {
  const msg = { id: null, from, text, at: now(), ...extra };
  conv.messages.push(msg);
  conv.updatedAt = msg.at;
  if (from === 'cliente') {
    conv.lastCustomerAt = msg.at;
    conv.status = 'esperando_respuesta';
  } else if (conv.firstReplyMs == null && conv.lastCustomerAt) {
    conv.firstReplyMs = Date.parse(msg.at) - Date.parse(conv.messages.find((m) => m.from === 'cliente').at);
  }
  return msg;
}

function zoneCost(zone) {
  return negocio.zonas.find((z) => z.zona === zone)?.costo_envio ?? null;
}

// Convierte la salida de la IA en ítems validados contra el catálogo.
function buildItems(aiItems) {
  const m = ofertas.mapas();
  return aiItems.map((it) => {
    const prod = db.producto(it.product_id);
    const alt = it.alternative_product_id !== it.product_id ? db.producto(it.alternative_product_id) : null;
    const qty = Number(it.quantity) > 0 ? Number(it.quantity) : 1;
    let status = 'ok';
    if (!prod) status = it.product_id ? 'no_existe' : 'a_definir';
    else if (prod.stock <= 0 || prod.stock < qty) status = 'sin_stock';
    return {
      productId: prod ? prod.id : null,
      name: prod ? prod.nombre : null,
      unit: prod ? prod.unidad : null,
      unitPrice: prod ? ofertas.precioFinal(prod, m) : 0,
      quantity: qty,
      subtotal: prod ? Math.round(ofertas.precioFinal(prod, m) * qty) : 0,
      rawText: it.raw_text,
      note: it.note,
      status,
      alternativeId: alt ? alt.id : null,
      alternativeName: alt ? alt.nombre : null,
    };
  });
}

function computeTotals(order) {
  const valid = order.items.filter((i) => i.status === 'ok');
  order.subtotal = valid.reduce((s, i) => s + i.subtotal, 0);
  const cost = zoneCost(order.zone);
  order.shippingCost = cost == null ? null : order.subtotal >= negocio.envio_gratis_desde ? 0 : cost;
  order.total = order.subtotal + (order.shippingCost || 0);
  // Problemas que impiden despachar, calculados por el servidor (no se confía solo en la IA).
  const problems = [];
  if (!valid.length) problems.push('sin ítems válidos');
  const pend = order.items.filter((i) => i.status !== 'ok');
  if (pend.length) problems.push(`${pend.length} ítem(s) a resolver`);
  if (!order.address) problems.push('falta dirección');
  if (!order.zone) problems.push('falta zona');
  if (!order.deliverySlot) problems.push('falta franja');
  if (!order.paymentMethod) problems.push('falta forma de pago');
  if (valid.length && order.subtotal < negocio.pedido_minimo) problems.push(`no llega al mínimo ($${negocio.pedido_minimo})`);
  order.problems = problems;
}

function setOrderStatus(order, status, by) {
  if (order.status === status) return;
  order.status = status;
  order.updatedAt = now();
  order.history.push({ status, at: order.updatedAt, by });
}

function applyAiOrder(conv, out) {
  const o = out.order;
  let order = conv.orderId ? findOrder(conv.orderId) : null;
  if (!order && !o.items.length) return null; // consulta sin pedido
  const editable = !order || order.status === 'borrador';
  if (!order) {
    order = {
      id: null,
      number: null,
      conversationId: conv.id,
      channel: conv.channel,
      customer: { ...conv.customer },
      items: [],
      status: 'borrador',
      history: [{ status: 'borrador', at: now(), by: 'ia' }],
      createdAt: now(),
    };
    db.crearPedido(order);
    conv.orderId = order.id;
  }
  if (editable) {
    order.items = buildItems(o.items);
    order.address = o.address;
    order.zone = o.zone;
    order.deliveryDay = o.delivery_day;
    order.deliverySlot = o.delivery_slot;
    order.paymentMethod = o.payment_method;
    order.notes = o.notes;
    if (o.customer_name) {
      order.customer.name = o.customer_name;
      if (!conv.customer.name) conv.customer.name = o.customer_name;
    }
    order.missingFields = out.missing_fields;
    order.summary = out.operator_summary;
    order.updatedAt = now();
    computeTotals(order);
    if (out.intent === 'cancelacion') setOrderStatus(order, 'cancelado', 'ia');
    else if (out.customer_confirmed && order.problems.length === 0) setOrderStatus(order, 'confirmado', 'ia');
    db.guardarPedido(order);
  }
  return order;
}

// Punto de entrada único para todos los canales.
async function receive({ conversationId, channel, name, phone, text }) {
  const conv = getOrCreateConversation({ conversationId, channel, name, phone });
  addMessage(conv, 'cliente', text);
  db.guardarConversacion(conv); // el mensaje queda guardado antes de llamar a la IA: no se pierde aunque falle

  try {
    const order = conv.orderId ? findOrder(conv.orderId) : null;
    const out = await ai.agentTurn({ channel: conv.channel, messages: conv.messages, order });
    const updated = applyAiOrder(conv, out);
    conv.intent = out.intent;
    conv.urgency = out.urgency;
    conv.summary = out.operator_summary;
    conv.aiError = null;
    // Un pedido ya confirmado no lo modifica la IA: lo deriva a un humano.
    const lockedChange = updated && updated.status !== 'borrador' && ['modificacion', 'cancelacion'].includes(out.intent);
    conv.needsHumanReason = out.needs_human ? out.needs_human_reason || 'la IA pidió un humano' : lockedChange ? 'cambio sobre pedido ya confirmado' : null;
    const sugerida = conv.channel === 'telefono';
    addMessage(conv, 'bot', out.reply, { suggested: sugerida, meta: out._meta });
    conv.status = conv.needsHumanReason ? 'requiere_humano' : sugerida ? 'respuesta_sugerida' : 'respondida';
  } catch (err) {
    console.error('[desk] fallo IA:', err.message);
    conv.aiError = err.message;
    conv.status = 'requiere_humano';
    conv.needsHumanReason = 'la IA no respondió';
    conv.urgency = 'alta';
    if (conv.channel !== 'telefono') {
      addMessage(conv, 'bot', '¡Hola! Recibimos tu mensaje 🙌 En un ratito te responde una persona del equipo de envíos.', { fallback: true });
    }
  }
  db.guardarConversacion(conv);
  return conv;
}

function operatorReply(conv, text) {
  addMessage(conv, 'operador', text);
  conv.status = 'respondida';
  conv.needsHumanReason = null;
  db.guardarConversacion(conv);
}

module.exports = {
  receive, operatorReply, findConversation, findOrder, setOrderStatus, buildItems, computeTotals,
  getOrCreateConversation, addMessage, ESTADOS_PEDIDO, CANALES,
};
