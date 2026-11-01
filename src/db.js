// Base de datos SQLite (node:sqlite, incluido en Node 22). Esquema, carga inicial y repositorio.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SEED_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'provee.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categorias (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  padre_id INTEGER REFERENCES categorias(id)
);
CREATE TABLE IF NOT EXISTS productos (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  categoria_id INTEGER NOT NULL REFERENCES categorias(id),
  precio INTEGER NOT NULL,
  stock REAL NOT NULL DEFAULT 0,
  unidad TEXT NOT NULL,
  emoji TEXT,
  ventas INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS promociones (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('oferta', 'combo', 'promo')),
  titulo TEXT NOT NULL,
  detalle TEXT,
  precio INTEGER,
  precio_antes INTEGER,
  emoji TEXT,
  creada TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS promocion_productos (
  promocion_id TEXT NOT NULL REFERENCES promociones(id),
  producto_id TEXT NOT NULL REFERENCES productos(id),
  cantidad INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (promocion_id, producto_id)
);
CREATE TABLE IF NOT EXISTS socios (
  dni TEXT PRIMARY KEY,
  nro_socio TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  email TEXT, celular TEXT, telefono TEXT, direccion TEXT, zona TEXT, foto TEXT,
  actualizado TEXT
);
CREATE TABLE IF NOT EXISTS carrito_items (
  dni TEXT NOT NULL REFERENCES socios(dni),
  tipo TEXT NOT NULL CHECK (tipo IN ('producto', 'promo')),
  item_id TEXT NOT NULL,
  cantidad REAL NOT NULL CHECK (cantidad > 0),
  PRIMARY KEY (dni, tipo, item_id)
);
CREATE TABLE IF NOT EXISTS conversaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canal TEXT NOT NULL,
  cliente_nombre TEXT, cliente_telefono TEXT,
  estado TEXT NOT NULL,
  intencion TEXT, urgencia TEXT,
  pedido_id INTEGER,
  resumen TEXT, motivo_humano TEXT, error_ia TEXT,
  creada TEXT NOT NULL, actualizada TEXT NOT NULL, ultimo_cliente TEXT,
  primera_respuesta_ms INTEGER
);
CREATE TABLE IF NOT EXISTS mensajes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversacion_id INTEGER NOT NULL REFERENCES conversaciones(id),
  autor TEXT NOT NULL CHECK (autor IN ('cliente', 'bot', 'operador')),
  texto TEXT NOT NULL,
  creado TEXT NOT NULL,
  sugerida INTEGER NOT NULL DEFAULT 0,
  automatica INTEGER NOT NULL DEFAULT 0,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  conversacion_id INTEGER REFERENCES conversaciones(id),
  canal TEXT NOT NULL,
  cliente_nombre TEXT, cliente_telefono TEXT,
  cliente_dni TEXT REFERENCES socios(dni), cliente_socio TEXT,
  direccion TEXT, zona TEXT, dia TEXT, franja TEXT, forma_pago TEXT, notas TEXT,
  resumen TEXT, faltantes TEXT, problemas TEXT,
  subtotal INTEGER, costo_envio INTEGER, total INTEGER,
  estado TEXT NOT NULL,
  creado TEXT NOT NULL, actualizado TEXT
);
CREATE TABLE IF NOT EXISTS pedido_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  producto_id TEXT, nombre TEXT, unidad TEXT,
  precio_unitario INTEGER, cantidad REAL, subtotal INTEGER,
  texto_original TEXT, nota TEXT, estado TEXT,
  alternativa_id TEXT, alternativa_nombre TEXT
);
CREATE TABLE IF NOT EXISTS pedido_historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  estado TEXT NOT NULL,
  fecha TEXT NOT NULL,
  por TEXT
);
CREATE INDEX IF NOT EXISTS ix_mensajes_conv ON mensajes(conversacion_id);
CREATE INDEX IF NOT EXISTS ix_items_pedido ON pedido_items(pedido_id);
CREATE INDEX IF NOT EXISTS ix_pedidos_dni ON pedidos(cliente_dni);
CREATE INDEX IF NOT EXISTS ix_conv_tel ON conversaciones(cliente_telefono, canal);
`);

// Transacción; si ya hay una abierta, se suma a ella.
let enTx = false;
// Migraciones simples: columnas agregadas después de la primera versión.
for (const col of ['descuento_pago_pct INTEGER', 'descuento_pago INTEGER']) {
  try { db.exec(`ALTER TABLE pedidos ADD COLUMN ${col}`); } catch { /* ya existe */ }
}

function tx(fn) {
  if (enTx) return fn();
  db.exec('BEGIN');
  enTx = true;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    enTx = false;
  }
}

// ---- Carga inicial desde los JSON de data/ (solo si la base está vacía) ----
function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM productos').get().n > 0) return;
  const catalogo = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'catalogo.json'), 'utf8'));
  const promos = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'promociones.json'), 'utf8'));
  const socios = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'socios.json'), 'utf8'));
  tx(() => {
    const catIds = new Map();
    const insCat = db.prepare('INSERT INTO categorias (nombre, padre_id) VALUES (?, ?)');
    const catId = (ruta) => {
      const key = ruta.join('/');
      if (!catIds.has(key)) {
        const padre = ruta.length > 1 ? catId(ruta.slice(0, -1)) : null;
        catIds.set(key, Number(insCat.run(ruta[ruta.length - 1], padre).lastInsertRowid));
      }
      return catIds.get(key);
    };
    const insProd = db.prepare('INSERT INTO productos (id, nombre, categoria_id, precio, stock, unidad, emoji, ventas) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of catalogo) insProd.run(p.id, p.nombre, catId(p.ruta), p.precio, p.stock, p.unidad, p.emoji, p.ventas);
    const insPromo = db.prepare('INSERT INTO promociones (id, tipo, titulo, detalle, precio, precio_antes, emoji, creada) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insPP = db.prepare('INSERT INTO promocion_productos (promocion_id, producto_id, cantidad) VALUES (?, ?, ?)');
    for (const p of promos) {
      insPromo.run(p.id, p.tipo, p.titulo, p.detalle, p.precio, p.precio_antes, p.emoji, p.creada);
      const cant = new Map();
      for (const id of p.productos) cant.set(id, (cant.get(id) || 0) + 1);
      for (const [id, n] of cant) insPP.run(p.id, id, n);
    }
    const insSocio = db.prepare('INSERT INTO socios (dni, nro_socio, nombre, direccion, zona) VALUES (?, ?, ?, ?, ?)');
    for (const s of socios) insSocio.run(s.dni, s.socio, s.nombre, s.direccion || null, s.zona || null);
  });
  console.log(`[db] carga inicial: ${catalogo.length} productos, ${promos.length} promociones, ${socios.length} socios`);
}
seed();

// ---- Catálogo ----
const rutaCache = new Map();
function rutaDe(categoriaId) {
  if (!rutaCache.has(categoriaId)) {
    const ruta = [];
    let c = db.prepare('SELECT id, nombre, padre_id FROM categorias WHERE id = ?').get(categoriaId);
    while (c) {
      ruta.unshift(c.nombre);
      c = c.padre_id ? db.prepare('SELECT id, nombre, padre_id FROM categorias WHERE id = ?').get(c.padre_id) : null;
    }
    rutaCache.set(categoriaId, ruta);
  }
  return rutaCache.get(categoriaId);
}

function prodFromRow(r) {
  const ruta = rutaDe(r.categoria_id);
  return { id: r.id, nombre: r.nombre, precio: r.precio, stock: r.stock, unidad: r.unidad, emoji: r.emoji, ventas: r.ventas, ruta, categoria: ruta[0] };
}

const productos = () => db.prepare('SELECT * FROM productos ORDER BY id').all().map(prodFromRow);
function producto(id) {
  const r = id ? db.prepare('SELECT * FROM productos WHERE id = ?').get(id) : null;
  return r ? prodFromRow(r) : null;
}

function promociones() {
  const items = db.prepare('SELECT promocion_id, producto_id, cantidad FROM promocion_productos').all();
  return db.prepare('SELECT * FROM promociones ORDER BY creada DESC').all().map((p) => ({
    ...p,
    productos: items.filter((i) => i.promocion_id === p.id).map((i) => ({ id: i.producto_id, cantidad: i.cantidad })),
  }));
}
const promocion = (id) => promociones().find((p) => p.id === id) || null;

// Descuenta stock; si no alcanza, lanza error (se usa dentro de una transacción).
function descontarStock(productoId, cantidad) {
  const r = db.prepare('UPDATE productos SET stock = stock - ?, ventas = ventas + 1 WHERE id = ? AND stock >= ?').run(cantidad, productoId, cantidad);
  if (r.changes !== 1) {
    const p = producto(productoId);
    throw new Error(`No hay stock suficiente de ${p ? p.nombre : productoId}`);
  }
}

// ---- Socios ----
function socioFromRow(r) {
  return r && { dni: r.dni, socio: r.nro_socio, nombre: r.nombre, email: r.email || '', celular: r.celular || '', telefono: r.telefono || '', direccion: r.direccion || '', zona: r.zona, foto: r.foto };
}
const socio = (dni) => socioFromRow(db.prepare('SELECT * FROM socios WHERE dni = ?').get(dni));
const socioLogin = (dni, nro) => socioFromRow(db.prepare('SELECT * FROM socios WHERE dni = ? AND nro_socio = ?').get(dni, nro));
const CAMPOS_SOCIO = ['email', 'celular', 'telefono', 'direccion', 'zona', 'foto'];
function actualizarSocio(dni, cambios) {
  const campos = Object.keys(cambios).filter((k) => CAMPOS_SOCIO.includes(k));
  if (campos.length) {
    db.prepare(`UPDATE socios SET ${campos.map((k) => `${k} = ?`).join(', ')}, actualizado = ? WHERE dni = ?`)
      .run(...campos.map((k) => cambios[k] ?? null), new Date().toISOString(), dni);
  }
  return socio(dni);
}

// ---- Carrito ----
const carrito = (dni) => db.prepare('SELECT tipo, item_id AS id, cantidad FROM carrito_items WHERE dni = ? ORDER BY rowid').all(dni);
function fijarLineaCarrito(dni, tipo, id, cantidad) {
  if (cantidad > 0) {
    db.prepare('INSERT INTO carrito_items (dni, tipo, item_id, cantidad) VALUES (?, ?, ?, ?) ON CONFLICT (dni, tipo, item_id) DO UPDATE SET cantidad = excluded.cantidad').run(dni, tipo, id, cantidad);
  } else {
    db.prepare('DELETE FROM carrito_items WHERE dni = ? AND tipo = ? AND item_id = ?').run(dni, tipo, id);
  }
}
const vaciarCarrito = (dni) => db.prepare('DELETE FROM carrito_items WHERE dni = ?').run(dni);

// ---- Conversaciones ----
function msgFromRow(m) {
  const msg = { id: m.id, from: m.autor, text: m.texto, at: m.creado };
  if (m.sugerida) msg.suggested = true;
  if (m.automatica) msg.fallback = true;
  if (m.meta) msg.meta = JSON.parse(m.meta);
  return msg;
}
function convFromRow(r, mensajes) {
  return {
    id: r.id, channel: r.canal, customer: { name: r.cliente_nombre, phone: r.cliente_telefono },
    messages: mensajes.map(msgFromRow), status: r.estado, intent: r.intencion, urgency: r.urgencia,
    orderId: r.pedido_id, summary: r.resumen, needsHumanReason: r.motivo_humano, aiError: r.error_ia,
    createdAt: r.creada, updatedAt: r.actualizada, lastCustomerAt: r.ultimo_cliente, firstReplyMs: r.primera_respuesta_ms,
  };
}
function conversaciones() {
  const msgs = db.prepare('SELECT * FROM mensajes ORDER BY id').all();
  const porConv = new Map();
  for (const m of msgs) porConv.set(m.conversacion_id, [...(porConv.get(m.conversacion_id) || []), m]);
  return db.prepare('SELECT * FROM conversaciones').all().map((r) => convFromRow(r, porConv.get(r.id) || []));
}
function conversacion(id) {
  const r = db.prepare('SELECT * FROM conversaciones WHERE id = ?').get(Number(id));
  return r ? convFromRow(r, db.prepare('SELECT * FROM mensajes WHERE conversacion_id = ? ORDER BY id').all(r.id)) : null;
}
function conversacionAbierta(telefono, canal) {
  const r = db.prepare("SELECT id FROM conversaciones WHERE cliente_telefono = ? AND canal = ? AND estado <> 'cerrada' ORDER BY id DESC LIMIT 1").get(telefono, canal);
  return r ? conversacion(r.id) : null;
}
function crearConversacion(c) {
  const r = db.prepare('INSERT INTO conversaciones (canal, cliente_nombre, cliente_telefono, estado, urgencia, creada, actualizada) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(c.channel, c.customer.name, c.customer.phone, c.status, c.urgency, c.createdAt, c.updatedAt);
  c.id = Number(r.lastInsertRowid);
  return c;
}
// Guarda los cambios de la conversación e inserta los mensajes nuevos (los que todavía no tienen id).
function guardarConversacion(c) {
  tx(() => {
    db.prepare(`UPDATE conversaciones SET cliente_nombre = ?, cliente_telefono = ?, estado = ?, intencion = ?, urgencia = ?, pedido_id = ?,
      resumen = ?, motivo_humano = ?, error_ia = ?, actualizada = ?, ultimo_cliente = ?, primera_respuesta_ms = ? WHERE id = ?`)
      .run(c.customer.name, c.customer.phone, c.status, c.intent, c.urgency, c.orderId, c.summary, c.needsHumanReason, c.aiError,
        c.updatedAt, c.lastCustomerAt, c.firstReplyMs, c.id);
    const ins = db.prepare('INSERT INTO mensajes (conversacion_id, autor, texto, creado, sugerida, automatica, meta) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const m of c.messages) {
      if (m.id) continue;
      m.id = Number(ins.run(c.id, m.from, m.text, m.at, m.suggested ? 1 : 0, m.fallback ? 1 : 0, m.meta ? JSON.stringify(m.meta) : null).lastInsertRowid);
    }
  });
}

// ---- Pedidos ----
function orderFromRow(r, items, historial) {
  return {
    id: r.id, number: r.numero, conversationId: r.conversacion_id, channel: r.canal,
    customer: { name: r.cliente_nombre, phone: r.cliente_telefono, dni: r.cliente_dni, socio: r.cliente_socio },
    items: items.map((i) => ({
      productId: i.producto_id, name: i.nombre, unit: i.unidad, unitPrice: i.precio_unitario, quantity: i.cantidad, subtotal: i.subtotal,
      rawText: i.texto_original, note: i.nota, status: i.estado, alternativeId: i.alternativa_id, alternativeName: i.alternativa_nombre,
    })),
    address: r.direccion, zone: r.zona, deliveryDay: r.dia, deliverySlot: r.franja, paymentMethod: r.forma_pago, notes: r.notas,
    summary: r.resumen, missingFields: JSON.parse(r.faltantes || '[]'), problems: JSON.parse(r.problemas || '[]'),
    subtotal: r.subtotal, shippingCost: r.costo_envio, paymentDiscountPct: r.descuento_pago_pct || 0, paymentDiscount: r.descuento_pago || 0, total: r.total, status: r.estado,
    history: historial.map((h) => ({ id: h.id, status: h.estado, at: h.fecha, by: h.por })),
    createdAt: r.creado, updatedAt: r.actualizado,
  };
}
function pedidosDonde(where = '', ...params) {
  const rows = db.prepare(`SELECT * FROM pedidos ${where} ORDER BY id DESC`).all(...params);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const items = db.prepare(`SELECT * FROM pedido_items WHERE pedido_id IN (${marks}) ORDER BY id`).all(...ids);
  const hist = db.prepare(`SELECT * FROM pedido_historial WHERE pedido_id IN (${marks}) ORDER BY id`).all(...ids);
  return rows.map((r) => orderFromRow(r, items.filter((i) => i.pedido_id === r.id), hist.filter((h) => h.pedido_id === r.id)));
}
const pedidos = () => pedidosDonde();
const pedido = (id) => pedidosDonde('WHERE id = ?', Number(id))[0] || null;
const pedidosDeSocio = (dni) => pedidosDonde('WHERE cliente_dni = ?', dni);

function crearPedido(o) {
  const r = db.prepare('INSERT INTO pedidos (conversacion_id, canal, estado, creado) VALUES (?, ?, ?, ?)').run(o.conversationId, o.channel, o.status, o.createdAt);
  o.id = Number(r.lastInsertRowid);
  o.number = `P-${String(o.id).padStart(4, '0')}`;
  db.prepare('UPDATE pedidos SET numero = ? WHERE id = ?').run(o.number, o.id);
  guardarPedido(o);
  return o;
}
// Guarda cabecera, reemplaza los ítems y agrega las entradas nuevas del historial.
function guardarPedido(o) {
  const run = () => {
    db.prepare(`UPDATE pedidos SET cliente_nombre = ?, cliente_telefono = ?, cliente_dni = ?, cliente_socio = ?, direccion = ?, zona = ?, dia = ?,
      franja = ?, forma_pago = ?, notas = ?, resumen = ?, faltantes = ?, problemas = ?, subtotal = ?, costo_envio = ?, descuento_pago_pct = ?, descuento_pago = ?, total = ?, estado = ?, actualizado = ?
      WHERE id = ?`).run(
      o.customer?.name ?? null, o.customer?.phone ?? null, o.customer?.dni ?? null, o.customer?.socio ?? null, o.address ?? null, o.zone ?? null,
      o.deliveryDay ?? null, o.deliverySlot ?? null, o.paymentMethod ?? null, o.notes ?? null, o.summary ?? null,
      JSON.stringify(o.missingFields || []), JSON.stringify(o.problems || []), o.subtotal ?? null, o.shippingCost ?? null,
      o.paymentDiscountPct ?? 0, o.paymentDiscount ?? 0, o.total ?? null,
      o.status, o.updatedAt ?? null, o.id);
    db.prepare('DELETE FROM pedido_items WHERE pedido_id = ?').run(o.id);
    const insI = db.prepare(`INSERT INTO pedido_items (pedido_id, producto_id, nombre, unidad, precio_unitario, cantidad, subtotal, texto_original, nota, estado,
      alternativa_id, alternativa_nombre) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const i of o.items) {
      insI.run(o.id, i.productId, i.name, i.unit, i.unitPrice, i.quantity, i.subtotal, i.rawText, i.note, i.status, i.alternativeId, i.alternativeName);
    }
    const insH = db.prepare('INSERT INTO pedido_historial (pedido_id, estado, fecha, por) VALUES (?, ?, ?, ?)');
    for (const h of o.history) {
      if (!h.id) h.id = Number(insH.run(o.id, h.status, h.at, h.by).lastInsertRowid);
    }
  };
  tx(run);
}

function reset() {
  tx(() => {
    for (const t of ['pedido_historial', 'pedido_items', 'pedidos', 'mensajes', 'conversaciones', 'carrito_items']) db.exec(`DELETE FROM ${t}`);
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('pedido_historial', 'pedido_items', 'pedidos', 'mensajes', 'conversaciones')"); // numeración desde 1
  });
}

module.exports = {
  tx, productos, producto, promociones, promocion, descontarStock,
  socio, socioLogin, actualizarSocio, carrito, fijarLineaCarrito, vaciarCarrito,
  conversaciones, conversacion, conversacionAbierta, crearConversacion, guardarConversacion,
  pedidos, pedido, pedidosDeSocio, crearPedido, guardarPedido, reset,
};
