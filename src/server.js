const path = require('path');
const express = require('express');
const db = require('./db');
const desk = require('./desk');
const ai = require('./ai');
const negocio = require('../data/negocio.json');
const ejemplos = require('../data/ejemplos.json');
const auth = require('./auth');
const shop = require('./shop');

const app = express();
app.set('trust proxy', 1);
// El guard va antes del static: sin sesión de socio solo se ven login y back-office.
app.use(auth.guard);
const json50 = express.json({ limit: '50kb' });
app.use((req, res, next) => (req.path === '/api/me' ? next() : json50(req, res, next)));
// Ingreso de administradores (panel de envíos). Límite de intentos por IP.
const intentos = new Map();
app.post('/api/admin/login', (req, res) => {
  const t = Date.now();
  const arr = (intentos.get(req.ip) || []).filter((x) => t - x < 10 * 60 * 1000);
  if (arr.length >= 10) return res.status(429).json({ error: 'Demasiados intentos, esperá unos minutos.' });
  intentos.set(req.ip, [...arr, t]);
  const usuario = typeof req.body.usuario === 'string' ? req.body.usuario.trim() : '';
  const clave = typeof req.body.clave === 'string' ? req.body.clave : '';
  if (!auth.adminValido(usuario, clave)) return res.status(401).json({ error: 'Usuario o clave incorrectos.' });
  intentos.delete(req.ip);
  auth.setAdminSession(res, usuario);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  auth.clearAdminSession(res);
  res.json({ ok: true });
});
app.use(shop);
app.get('/favicon.ico', (req, res) => res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🛒</text></svg>'));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Límite de llamadas a la IA por IP (la key es compartida).
const LIMIT = Number(process.env.AI_LIMIT_PER_10MIN || 40);
const hits = new Map();
function aiLimiter(req, res, next) {
  const t = Date.now();
  const arr = (hits.get(req.ip) || []).filter((x) => t - x < 10 * 60 * 1000);
  if (arr.length >= LIMIT) return res.status(429).json({ error: 'Demasiados mensajes seguidos, probá en unos minutos.' });
  arr.push(t);
  hits.set(req.ip, arr);
  next();
}

const clean = (s, max = 2000) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

app.get('/health', (req, res) => {
  res.json({ ok: true, ai: ai.hasKey(), model: ai.MODEL, node: process.version });
});

app.get('/api/negocio', (req, res) => res.json(negocio));
app.get('/api/catalogo', (req, res) => res.json(db.productos()));

// Entrada de mensajes: chat del cliente (WhatsApp simulado / web) o carga del operador (pegar WhatsApp, notas de llamada).
app.post('/api/mensajes', aiLimiter, async (req, res) => {
  const text = clean(req.body.text);
  if (!text) return res.status(400).json({ error: 'El mensaje está vacío.' });
  const conv = await desk.receive({
    conversationId: req.body.conversationId,
    channel: clean(req.body.channel, 20) || 'web',
    name: clean(req.body.name, 80) || null,
    phone: clean(req.body.phone, 30) || null,
    text,
  });
  res.json(viewConversation(conv));
});

app.get('/api/conversaciones', (req, res) => {
  res.json(db.conversaciones().map(viewConversation).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
});

app.get('/api/conversaciones/:id', (req, res) => {
  const conv = desk.findConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'No existe' });
  res.json(viewConversation(conv));
});

app.post('/api/conversaciones/:id/responder', (req, res) => {
  const conv = desk.findConversation(req.params.id);
  const text = clean(req.body.text);
  if (!conv || !text) return res.status(400).json({ error: 'Datos inválidos' });
  desk.operatorReply(conv, text);
  res.json(viewConversation(conv));
});

app.post('/api/conversaciones/:id/cerrar', (req, res) => {
  const conv = desk.findConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'No existe' });
  conv.status = 'cerrada';
  db.guardarConversacion(conv);
  res.json(viewConversation(conv));
});

app.get('/api/pedidos', (req, res) => {
  res.json(db.pedidos());
});

app.patch('/api/pedidos/:id', (req, res) => {
  const order = desk.findOrder(req.params.id);
  const status = req.body.status;
  if (!order || !desk.ESTADOS_PEDIDO.includes(status)) return res.status(400).json({ error: 'Datos inválidos' });
  if (status === 'confirmado' && order.problems?.length) {
    return res.status(409).json({ error: `No se puede confirmar: ${order.problems.join(', ')}` });
  }
  desk.setOrderStatus(order, status, 'operador');
  db.guardarPedido(order);
  res.json(order);
});

app.get('/api/metricas', (req, res) => {
  const convs = db.conversaciones();
  const orders = db.pedidos();
  const msgsCliente = convs.reduce((s, c) => s + c.messages.filter((m) => m.from === 'cliente').length, 0);
  const respIA = convs.reduce((s, c) => s + c.messages.filter((m) => m.from === 'bot' && !m.fallback).length, 0);
  const tiempos = convs.map((c) => c.firstReplyMs).filter((x) => x != null);
  const vivos = orders.filter((o) => o.status !== 'cancelado' && o.status !== 'borrador');
  res.json({
    conversaciones: convs.length,
    mensajesCliente: msgsCliente,
    respuestasIA: respIA,
    sinResponder: convs.filter((c) => ['esperando_respuesta', 'requiere_humano'].includes(c.status)).length,
    primeraRespuestaSeg: tiempos.length ? Math.round(tiempos.reduce((a, b) => a + b, 0) / tiempos.length / 100) / 10 : null,
    pedidos: orders.length,
    pedidosConfirmados: vivos.length,
    facturacion: vivos.reduce((s, o) => s + (o.total || 0), 0),
  });
});

app.get('/api/ejemplos', (req, res) => res.json(ejemplos));

app.post('/api/demo/reset', (req, res) => {
  if (process.env.ALLOW_RESET !== '1') return res.status(403).json({ error: 'Deshabilitado' });
  db.reset();
  res.json({ ok: true });
});

function viewConversation(c) {
  const order = c.orderId ? desk.findOrder(c.orderId) : null;
  return { ...c, order };
}

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Provee Express escuchando en :${PORT} (IA ${ai.hasKey() ? 'activa, modelo ' + ai.MODEL : 'SIN KEY'})`));
