// Tienda online para socios: login, perfil, catálogo por categorías, carrito, checkout e IA "lista → carrito".
const express = require('express');
const store = require('./store');
const desk = require('./desk');
const ai = require('./ai');
const auth = require('./auth');
const ofertas = require('./ofertas');
const negocio = require('../data/negocio.json');
const catalogo = require('../data/catalogo.json');
const promociones = require('../data/promociones.json');
const socios = require('../data/socios.json');

const router = express.Router();
const byId = new Map(catalogo.map((p) => [p.id, p]));
const promoById = new Map(promociones.map((p) => [p.id, p]));
const PERFIL = ['email', 'celular', 'telefono', 'direccion', 'zona', 'foto'];
const clean = (s, max = 200) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

function db() {
  const d = store.db;
  d.perfiles ||= {};
  d.carritos ||= {};
  return d;
}

function perfil(dni) {
  const base = socios.find((s) => s.dni === dni);
  if (!base) return null;
  return { ...base, ...(db().perfiles[dni] || {}) };
}

router.post('/api/login', express.json(), (req, res) => {
  const dni = clean(req.body.dni, 12).replace(/\D/g, '');
  const socio = clean(req.body.socio, 12).replace(/\D/g, '');
  const s = socios.find((x) => x.dni === dni && x.socio === socio);
  if (!s) return res.status(401).json({ error: 'DNI o número de socio incorrectos. Esta tienda es exclusiva para socios.' });
  auth.setSession(res, s.dni);
  res.json({ ok: true, nombre: s.nombre });
});

router.post('/api/logout', (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

router.get('/api/me', (req, res) => res.json(perfil(req.dni)));

router.put('/api/me', express.json({ limit: '600kb' }), (req, res) => {
  const cambios = {};
  for (const k of PERFIL) {
    if (!(k in req.body)) continue;
    if (k === 'foto') {
      const f = req.body.foto;
      if (f && (typeof f !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(f) || f.length > 500000)) {
        return res.status(400).json({ error: 'La foto tiene que ser una imagen JPG/PNG de menos de 350 KB.' });
      }
      cambios.foto = f || null;
    } else if (k === 'email') {
      const e = clean(req.body.email, 120);
      if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'El email no es válido.' });
      cambios.email = e;
    } else if (k === 'zona') {
      const z = clean(req.body.zona, 60);
      cambios.zona = negocio.zonas.some((x) => x.zona === z) ? z : null;
    } else {
      cambios[k] = clean(req.body[k], 120);
    }
  }
  db().perfiles[req.dni] = { ...(db().perfiles[req.dni] || {}), ...cambios };
  store.save();
  res.json(perfil(req.dni));
});

router.get('/api/promos', (req, res) => {
  res.json([...promociones].sort((a, b) => b.creada.localeCompare(a.creada)));
});

// Catálogo con ofertas aplicadas; orden por defecto: ofertas/promos primero, después más vendidos.
const catalogoVista = catalogo
  .map((p) => {
    const o = ofertas.oferta.get(p.id);
    return { ...p, precio: ofertas.precioFinal(p), precioAntes: o ? o.antes : null, descuento: o ? Math.round((1 - o.precio / o.antes) * 100) : null, enPromo: ofertas.enPromo.get(p.id) || null, prioridad: ofertas.prioridad(p.id) };
  })
  .sort((a, b) => b.prioridad - a.prioridad || b.ventas - a.ventas);
const vistaById = new Map(catalogoVista.map((p) => [p.id, p]));

router.get('/api/productos', (req, res) => res.json(catalogoVista));

// Árbol de categorías a partir de las rutas de los productos (profundidad libre).
router.get('/api/categorias', (req, res) => {
  const root = {};
  for (const p of catalogo) {
    let node = root;
    for (const nombre of p.ruta) {
      node[nombre] ||= { count: 0, hijos: {} };
      node[nombre].count++;
      node = node[nombre].hijos;
    }
  }
  res.json(root);
});

// ---- Carrito (en el servidor, para que la IA pueda cargar ítems) ----
function lineas(dni) {
  return db().carritos[dni] || [];
}

function carritoView(dni) {
  const items = [];
  for (const l of lineas(dni)) {
    if (l.tipo === 'promo') {
      const pr = promoById.get(l.id);
      if (!pr || pr.precio == null) continue;
      items.push({ tipo: 'promo', id: pr.id, nombre: pr.titulo, emoji: pr.emoji, precio: pr.precio, cantidad: l.cantidad, subtotal: pr.precio * l.cantidad, unidad: 'unidad' });
    } else {
      const p = vistaById.get(l.id);
      if (!p) continue;
      items.push({ tipo: 'producto', id: p.id, nombre: p.nombre, emoji: p.emoji, precio: p.precio, precioAntes: p.precioAntes, cantidad: l.cantidad, subtotal: Math.round(p.precio * l.cantidad), unidad: p.unidad, sinStock: p.stock < l.cantidad });
    }
  }
  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  return { items, subtotal, pedidoMinimo: negocio.pedido_minimo, envioGratisDesde: negocio.envio_gratis_desde };
}

function agregar(dni, tipo, id, cantidad, modo = 'sumar') {
  const valido = tipo === 'promo' ? promoById.get(id)?.precio != null : byId.has(id);
  if (!valido) return false;
  const arr = (db().carritos[dni] ||= []);
  const l = arr.find((x) => x.tipo === tipo && x.id === id);
  const q = Number(cantidad) || 0;
  if (l) l.cantidad = Math.round((modo === 'fijar' ? q : l.cantidad + q) * 100) / 100;
  else if (q > 0) arr.push({ tipo, id, cantidad: q });
  db().carritos[dni] = arr.filter((x) => x.cantidad > 0);
  return true;
}

router.get('/api/carrito', (req, res) => res.json(carritoView(req.dni)));

router.post('/api/carrito', express.json(), (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
  for (const it of items.slice(0, 50)) agregar(req.dni, it.tipo === 'promo' ? 'promo' : 'producto', String(it.id), it.cantidad ?? 1, it.modo);
  store.save();
  res.json(carritoView(req.dni));
});

router.get('/api/negocio-publico', (req, res) => {
  res.json({ zonas: negocio.zonas, franjas: negocio.franjas_horarias, pagos: negocio.formas_pago, minimo: negocio.pedido_minimo, envioGratis: negocio.envio_gratis_desde });
});

// Checkout: el pedido entra a la misma mesa de pedidos que WhatsApp y teléfono.
router.post('/api/checkout', express.json(), (req, res) => {
  const p = perfil(req.dni);
  const cart = carritoView(req.dni);
  if (!cart.items.length) return res.status(400).json({ error: 'El carrito está vacío.' });
  const address = clean(req.body.direccion, 160);
  const zone = negocio.zonas.find((z) => z.zona === req.body.zona)?.zona || null;
  const slot = negocio.franjas_horarias.includes(req.body.franja) ? req.body.franja : null;
  const pay = negocio.formas_pago.includes(req.body.pago) ? req.body.pago : null;
  if (!address || !zone || !slot || !pay) return res.status(400).json({ error: 'Completá dirección, zona, franja horaria y forma de pago.' });
  if (cart.subtotal < negocio.pedido_minimo) return res.status(400).json({ error: `El pedido mínimo es $${negocio.pedido_minimo.toLocaleString('es-AR')}.` });

  const conv = desk.getOrCreateConversation({ channel: 'web', name: p.nombre, phone: p.celular || p.telefono || `socio ${p.socio}` });
  const items = cart.items.map((i) => ({
    productId: i.tipo === 'producto' ? i.id : null,
    name: i.tipo === 'promo' ? `Promo: ${i.nombre}` : i.nombre,
    unit: i.unidad, unitPrice: i.precio, quantity: i.cantidad, subtotal: i.subtotal,
    rawText: null, note: null, status: i.sinStock ? 'sin_stock' : 'ok', alternativeId: null, alternativeName: null,
  }));
  const order = {
    id: store.nextId('order'), number: null, conversationId: conv.id, channel: 'web',
    customer: { name: p.nombre, phone: conv.customer.phone, socio: p.socio, dni: p.dni },
    items, address, zone, deliveryDay: clean(req.body.dia, 40) || null, deliverySlot: slot, paymentMethod: pay,
    notes: clean(req.body.notas, 300) || null, missingFields: [], summary: `Pedido web del socio ${p.socio}`,
    status: 'borrador', history: [{ status: 'borrador', at: new Date().toISOString(), by: 'socio' }], createdAt: new Date().toISOString(),
  };
  order.number = `P-${String(order.id).padStart(4, '0')}`;
  desk.computeTotals(order);
  if (!order.problems.length) desk.setOrderStatus(order, 'confirmado', 'socio');
  store.db.orders.push(order);
  conv.orderId = order.id;
  desk.addMessage(conv, 'cliente', `🛒 Pedido ${order.number} hecho en la tienda online: ${items.length} ítems, total $${order.total.toLocaleString('es-AR')}.`);
  conv.status = order.status === 'confirmado' ? 'respondida' : 'requiere_humano';
  conv.needsHumanReason = order.problems.length ? order.problems.join(', ') : null;
  conv.summary = order.summary;
  db().carritos[req.dni] = [];
  store.save();
  res.json(order);
});

router.get('/api/mis-pedidos', (req, res) => {
  res.json(store.db.orders.filter((o) => o.customer?.dni === req.dni).sort((a, b) => b.id - a.id));
});

// IA: lista libre → ítems para revisar.
const hits = new Map();
router.post('/api/ia/lista', express.json(), async (req, res) => {
  const text = clean(req.body.text, 2000);
  if (!text) return res.status(400).json({ error: 'Escribí tu lista.' });
  const t = Date.now();
  const arr = (hits.get(req.dni) || []).filter((x) => t - x < 10 * 60 * 1000);
  if (arr.length >= 20) return res.status(429).json({ error: 'Usaste mucho el asistente, probá en unos minutos.' });
  hits.set(req.dni, [...arr, t]);
  try {
    const out = await ai.listaACarrito(text);
    const items = desk.buildItems(out.items).map((i, n) => ({ ...i, emoji: byId.get(i.productId)?.emoji || '❓', note: out.items[n].note }));
    res.json({ reply: out.reply, items, meta: out._meta });
  } catch (err) {
    console.error('[ia/lista]', err.message);
    res.status(503).json({ error: 'El asistente no está disponible ahora. Podés armar el carrito desde el catálogo.' });
  }
});

router.post('/api/ia/similares', express.json(), async (req, res) => {
  const q = clean(req.body.q, 120);
  if (q.length < 2) return res.status(400).json({ error: 'Búsqueda muy corta.' });
  const t = Date.now();
  const arr = (hits.get(req.dni) || []).filter((x) => t - x < 10 * 60 * 1000);
  if (arr.length >= 40) return res.status(429).json({ error: 'Usaste mucho el asistente, probá en unos minutos.' });
  hits.set(req.dni, [...arr, t]);
  const sinStock = (Array.isArray(req.body.sinStock) ? req.body.sinStock : []).map((id) => byId.get(id)?.nombre).filter(Boolean).slice(0, 10);
  try {
    const out = await ai.similares(q, sinStock);
    // El servidor vuelve a filtrar por stock: la IA no decide disponibilidad.
    const items = out.items
      .map((i) => ({ ...vistaById.get(i.product_id), motivo: i.motivo }))
      .filter((p) => p.id && p.stock > 0)
      .sort((a, b) => b.prioridad - a.prioridad); // estable: dentro de cada grupo respeta el orden de la IA
    // Ofertas con stock de la misma subcategoría que no vinieron de la IA: se suman al final (máx. 2).
    const rutas = [...(req.body.sinStock || []).map((id) => byId.get(id)), items[0]].filter(Boolean).map((p) => p.ruta.slice(0, 2).join('/'));
    const extra = catalogoVista.filter((p) => p.descuento && p.stock > 0 && rutas.includes(p.ruta.slice(0, 2).join('/')) && !items.some((i) => i.id === p.id));
    items.push(...extra.slice(0, 2).map((p) => ({ ...p, motivo: 'en oferta en la misma categoría' })));
    res.json({ reply: out.reply, items, meta: out._meta });
  } catch (err) {
    // Sin IA: sugerencias del catálogo por subcategoría o por palabras parecidas, ofertas primero.
    console.error('[ia/similares] uso alternativa local:', err.message);
    res.json({ reply: 'El asistente de IA no está disponible; te mostramos productos parecidos del catálogo.', items: similaresLocal(q, req.body.sinStock), meta: { fallback: true } });
  }
});

const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function similaresLocal(q, sinStock) {
  const ids = Array.isArray(sinStock) ? sinStock : [];
  const rutas = ids.map((id) => byId.get(id)).filter(Boolean).map((p) => p.ruta.slice(0, 2).join('/'));
  const raices = norm(q).split(/\s+/).filter((w) => w.length >= 3).map((w) => w.slice(0, 4));
  const disponibles = catalogoVista.filter((p) => p.stock > 0 && !ids.includes(p.id));
  const mismaCat = disponibles.filter((p) => rutas.includes(p.ruta.slice(0, 2).join('/')));
  // Si hay de la misma subcategoría, alcanza; si no, se busca por palabras parecidas.
  const porNombre = mismaCat.length ? [] : disponibles.filter((p) => raices.some((r) => norm(p.nombre + ' ' + p.ruta.join(' ')).includes(r)));
  return [
    ...mismaCat.map((p) => ({ ...p, motivo: p.descuento ? 'en oferta, misma categoría' : 'misma categoría' })),
    ...porNombre.map((p) => ({ ...p, motivo: p.descuento ? 'en oferta, nombre parecido' : 'nombre parecido' })),
  ].slice(0, 6);
}

module.exports = router;
