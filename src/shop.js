// Tienda online para socios: login, perfil, catálogo por categorías, carrito, checkout e IA "lista → carrito".
const express = require('express');
const db = require('./db');
const desk = require('./desk');
const ai = require('./ai');
const auth = require('./auth');
const ofertas = require('./ofertas');
const negocio = require('../data/negocio.json');

const router = express.Router();
const PERFIL = ['email', 'celular', 'telefono', 'direccion', 'zona', 'foto'];
const clean = (s, max = 200) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

router.post('/api/login', express.json(), (req, res) => {
  const dni = clean(req.body.dni, 12).replace(/\D/g, '');
  const nro = clean(req.body.socio, 12).replace(/\D/g, '');
  const s = db.socioLogin(dni, nro);
  if (!s) return res.status(401).json({ error: 'DNI o número de socio incorrectos. Esta tienda es exclusiva para socios.' });
  auth.setSession(res, s.dni);
  res.json({ ok: true, nombre: s.nombre });
});

router.post('/api/logout', (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

router.get('/api/me', (req, res) => res.json(db.socio(req.dni)));

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
  res.json(db.actualizarSocio(req.dni, cambios));
});

router.get('/api/promos', (req, res) => res.json(db.promociones()));

// Catálogo con ofertas aplicadas; orden por defecto: ofertas/promos primero, después más vendidos.
function catalogoVista() {
  const m = ofertas.mapas();
  return db.productos()
    .map((p) => {
      const o = m.oferta.get(p.id);
      return { ...p, precio: ofertas.precioFinal(p, m), precioAntes: o ? o.antes : null, descuento: o ? Math.round((1 - o.precio / o.antes) * 100) : null, enPromo: m.enPromo.get(p.id) || null, prioridad: ofertas.prioridad(p.id, m) };
    })
    .sort((a, b) => b.prioridad - a.prioridad || b.ventas - a.ventas);
}

router.get('/api/productos', (req, res) => res.json(catalogoVista()));

// Árbol de categorías a partir de las rutas de los productos (profundidad libre).
router.get('/api/categorias', (req, res) => {
  const root = {};
  for (const p of db.productos()) {
    let node = root;
    for (const nombre of p.ruta) {
      node[nombre] ||= { count: 0, hijos: {} };
      node[nombre].count++;
      node = node[nombre].hijos;
    }
  }
  res.json(root);
});

// ---- Carrito (en la base, para que la IA pueda cargar ítems) ----
function carritoView(dni) {
  const vista = new Map(catalogoVista().map((p) => [p.id, p]));
  const items = [];
  for (const l of db.carrito(dni)) {
    if (l.tipo === 'promo') {
      const pr = db.promocion(l.id);
      if (!pr || pr.precio == null) continue;
      items.push({ tipo: 'promo', id: pr.id, nombre: pr.titulo, emoji: pr.emoji, precio: pr.precio, cantidad: l.cantidad, subtotal: pr.precio * l.cantidad, unidad: 'unidad', componentes: pr.productos });
    } else {
      const p = vista.get(l.id);
      if (!p) continue;
      items.push({ tipo: 'producto', id: p.id, nombre: p.nombre, emoji: p.emoji, precio: p.precio, precioAntes: p.precioAntes, cantidad: l.cantidad, subtotal: Math.round(p.precio * l.cantidad), unidad: p.unidad, sinStock: p.stock < l.cantidad });
    }
  }
  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  return { items, subtotal, pedidoMinimo: negocio.pedido_minimo, envioGratisDesde: negocio.envio_gratis_desde };
}

function agregar(dni, tipo, id, cantidad, modo = 'sumar') {
  const valido = tipo === 'promo' ? db.promocion(id)?.precio != null : Boolean(db.producto(id));
  if (!valido) return false;
  const actual = db.carrito(dni).find((x) => x.tipo === tipo && x.id === id)?.cantidad || 0;
  const q = Number(cantidad) || 0;
  db.fijarLineaCarrito(dni, tipo, id, Math.round((modo === 'fijar' ? q : actual + q) * 100) / 100);
  return true;
}

router.get('/api/carrito', (req, res) => res.json(carritoView(req.dni)));

router.post('/api/carrito', express.json(), (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
  db.tx(() => {
    for (const it of items.slice(0, 50)) agregar(req.dni, it.tipo === 'promo' ? 'promo' : 'producto', String(it.id), it.cantidad ?? 1, it.modo);
  });
  res.json(carritoView(req.dni));
});

router.get('/api/negocio-publico', (req, res) => {
  res.json({ zonas: negocio.zonas, franjas: negocio.franjas_horarias, pagos: negocio.formas_pago, minimo: negocio.pedido_minimo, envioGratis: negocio.envio_gratis_desde });
});

// Checkout: en una sola transacción crea el pedido, descuenta stock y vacía el carrito.
// El pedido entra a la misma mesa de pedidos que WhatsApp y teléfono.
router.post('/api/checkout', express.json(), (req, res) => {
  const p = db.socio(req.dni);
  const cart = carritoView(req.dni);
  if (!cart.items.length) return res.status(400).json({ error: 'El carrito está vacío.' });
  const address = clean(req.body.direccion, 160);
  const zone = negocio.zonas.find((z) => z.zona === req.body.zona)?.zona || null;
  const slot = negocio.franjas_horarias.includes(req.body.franja) ? req.body.franja : null;
  const pay = negocio.formas_pago.includes(req.body.pago) ? req.body.pago : null;
  if (!address || !zone || !slot || !pay) return res.status(400).json({ error: 'Completá dirección, zona, franja horaria y forma de pago.' });
  if (cart.subtotal < negocio.pedido_minimo) return res.status(400).json({ error: `El pedido mínimo es $${negocio.pedido_minimo.toLocaleString('es-AR')}.` });

  try {
    const order = db.tx(() => {
      for (const i of cart.items) {
        if (i.tipo === 'producto') db.descontarStock(i.id, i.cantidad);
        else for (const c of i.componentes) db.descontarStock(c.id, c.cantidad * i.cantidad);
      }
      const conv = desk.getOrCreateConversation({ channel: 'web', name: p.nombre, phone: p.celular || p.telefono || `socio ${p.socio}` });
      const now = new Date().toISOString();
      const o = {
        id: null, number: null, conversationId: conv.id, channel: 'web',
        customer: { name: p.nombre, phone: conv.customer.phone, socio: p.socio, dni: p.dni },
        items: cart.items.map((i) => ({
          productId: i.tipo === 'producto' ? i.id : null,
          name: i.tipo === 'promo' ? `Promo: ${i.nombre}` : i.nombre,
          unit: i.unidad, unitPrice: i.precio, quantity: i.cantidad, subtotal: i.subtotal,
          rawText: null, note: null, status: 'ok', alternativeId: null, alternativeName: null,
        })),
        address, zone, deliveryDay: clean(req.body.dia, 40) || null, deliverySlot: slot, paymentMethod: pay,
        notes: clean(req.body.notas, 300) || null, missingFields: [], summary: `Pedido web del socio ${p.socio}`,
        status: 'borrador', history: [{ status: 'borrador', at: now, by: 'socio' }], createdAt: now,
      };
      desk.computeTotals(o);
      if (!o.problems.length) desk.setOrderStatus(o, 'confirmado', 'socio');
      db.crearPedido(o);
      conv.orderId = o.id;
      desk.addMessage(conv, 'cliente', `🛒 Pedido ${o.number} hecho en la tienda online: ${o.items.length} ítems, total $${o.total.toLocaleString('es-AR')}.`);
      conv.status = o.status === 'confirmado' ? 'respondida' : 'requiere_humano';
      conv.needsHumanReason = o.problems.length ? o.problems.join(', ') : null;
      conv.summary = o.summary;
      db.guardarConversacion(conv);
      db.vaciarCarrito(req.dni);
      return o;
    });
    res.json(order);
  } catch (err) {
    res.status(409).json({ error: `${err.message}. Ajustá el carrito y probá de nuevo.` });
  }
});

router.get('/api/mis-pedidos', (req, res) => res.json(db.pedidosDeSocio(req.dni)));

// IA: lista libre → ítems para revisar.
const hits = new Map();
function limitar(dni, max) {
  const t = Date.now();
  const arr = (hits.get(dni) || []).filter((x) => t - x < 10 * 60 * 1000);
  if (arr.length >= max) return false;
  hits.set(dni, [...arr, t]);
  return true;
}

router.post('/api/ia/lista', express.json(), async (req, res) => {
  const text = clean(req.body.text, 2000);
  if (!text) return res.status(400).json({ error: 'Escribí tu lista.' });
  if (!limitar(req.dni, 20)) return res.status(429).json({ error: 'Usaste mucho el asistente, probá en unos minutos.' });
  try {
    const out = await ai.listaACarrito(text);
    const items = desk.buildItems(out.items).map((i, n) => ({ ...i, emoji: db.producto(i.productId)?.emoji || '❓', note: out.items[n].note }));
    res.json({ reply: out.reply, items, meta: out._meta });
  } catch (err) {
    console.error('[ia/lista]', err.message);
    res.status(503).json({ error: 'El asistente no está disponible ahora. Podés armar el carrito desde el catálogo.' });
  }
});

router.post('/api/ia/similares', express.json(), async (req, res) => {
  const q = clean(req.body.q, 120);
  if (q.length < 2) return res.status(400).json({ error: 'Búsqueda muy corta.' });
  if (!limitar(req.dni, 40)) return res.status(429).json({ error: 'Usaste mucho el asistente, probá en unos minutos.' });
  const idsSinStock = (Array.isArray(req.body.sinStock) ? req.body.sinStock : []).map(String).slice(0, 10);
  const vista = catalogoVista();
  const porId = new Map(vista.map((p) => [p.id, p]));
  try {
    const out = await ai.similares(q, idsSinStock.map((id) => porId.get(id)?.nombre).filter(Boolean));
    // El servidor vuelve a filtrar por stock: la IA no decide disponibilidad.
    const items = out.items
      .map((i) => ({ ...porId.get(i.product_id), motivo: i.motivo }))
      .filter((p) => p.id && p.stock > 0)
      .sort((a, b) => b.prioridad - a.prioridad); // estable: dentro de cada grupo respeta el orden de la IA
    // Ofertas con stock de la misma subcategoría que no vinieron de la IA: se suman al final (máx. 2).
    const rutas = [...idsSinStock.map((id) => porId.get(id)), items[0]].filter(Boolean).map((p) => p.ruta.slice(0, 2).join('/'));
    const extra = vista.filter((p) => p.descuento && p.stock > 0 && rutas.includes(p.ruta.slice(0, 2).join('/')) && !items.some((i) => i.id === p.id));
    items.push(...extra.slice(0, 2).map((p) => ({ ...p, motivo: 'en oferta en la misma categoría' })));
    res.json({ reply: out.reply, items, meta: out._meta });
  } catch (err) {
    // Sin IA: sugerencias del catálogo por subcategoría o por palabras parecidas, ofertas primero.
    console.error('[ia/similares] uso alternativa local:', err.message);
    res.json({ reply: 'El asistente de IA no está disponible; te mostramos productos parecidos del catálogo.', items: similaresLocal(vista, q, idsSinStock), meta: { fallback: true } });
  }
});

const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function similaresLocal(vista, q, ids) {
  const porId = new Map(vista.map((p) => [p.id, p]));
  const rutas = ids.map((id) => porId.get(id)).filter(Boolean).map((p) => p.ruta.slice(0, 2).join('/'));
  const raices = norm(q).split(/\s+/).filter((w) => w.length >= 3).map((w) => w.slice(0, 4));
  const disponibles = vista.filter((p) => p.stock > 0 && !ids.includes(p.id));
  const mismaCat = disponibles.filter((p) => rutas.includes(p.ruta.slice(0, 2).join('/')));
  // Si hay de la misma subcategoría, alcanza; si no, se busca por palabras parecidas.
  const porNombre = mismaCat.length ? [] : disponibles.filter((p) => raices.some((r) => norm(p.nombre + ' ' + p.ruta.join(' ')).includes(r)));
  return [
    ...mismaCat.map((p) => ({ ...p, motivo: p.descuento ? 'en oferta, misma categoría' : 'misma categoría' })),
    ...porNombre.map((p) => ({ ...p, motivo: p.descuento ? 'en oferta, nombre parecido' : 'nombre parecido' })),
  ].slice(0, 6);
}

module.exports = router;
