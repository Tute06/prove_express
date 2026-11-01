// Sesiones con cookie firmada con HMAC (sin dependencias): socios (sid) y administradores (adm).
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'sid';
const ADMIN_COOKIE = 'adm';
const TTL_MS = 12 * 60 * 60 * 1000;

const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function createToken(payload) {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TTL_MS })).toString('base64url');
  return `${data}.${sign(data)}`;
}

function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [data, mac] = token.split('.');
  const expected = sign(data);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

const cookie = (name, value, maxAge) => `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const setSession = (res, dni) => res.setHeader('Set-Cookie', cookie(COOKIE, createToken({ dni }), TTL_MS / 1000));
const clearSession = (res) => res.setHeader('Set-Cookie', cookie(COOKIE, '', 0));
const setAdminSession = (res, usuario) => res.setHeader('Set-Cookie', cookie(ADMIN_COOKIE, createToken({ admin: usuario }), TTL_MS / 1000));
const clearAdminSession = (res) => res.setHeader('Set-Cookie', cookie(ADMIN_COOKIE, '', 0));

// Usuario y clave del panel: solo en el .env del servidor. Sin ADMIN_PASSWORD, el panel queda cerrado.
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
function adminValido(usuario, clave) {
  const u = process.env.ADMIN_USER || 'admin';
  const p = process.env.ADMIN_PASSWORD;
  if (!p) return false;
  const okU = crypto.timingSafeEqual(digest(usuario), digest(u));
  const okP = crypto.timingSafeEqual(digest(clave), digest(p));
  return okU && okP;
}

// Back-office: panel, pedidos y sus APIs. El chat simulado del cliente usa POST /api/mensajes y
// GET /api/conversaciones/:id, que siguen públicos.
const ADMIN = [
  /^\/(panel|pedidos)(\.html|\.js)$/,
  /^\/api\/(pedidos|metricas|ejemplos|negocio|catalogo)(\/|$)/,
  /^\/api\/conversaciones\/?$/,
  /^\/api\/conversaciones\/\d+\/(responder|cerrar)$/,
  /^\/api\/demo\//,
];
const PUBLIC = [
  /^\/login\.html$/, /^\/admin\.html$/, /^\/(styles|tienda)\.css$/, /^\/favicon\.ico$/, /^\/health$/,
  /^\/api\/login$/, /^\/api\/admin\/(login|logout)$/,
  /^\/chat(\.html|\.js)$/, /^\/api\/mensajes$/, /^\/api\/conversaciones\/\d+$/,
];

function guard(req, res, next) {
  if (ADMIN.some((re) => re.test(req.path))) {
    const adm = readToken(getCookie(req, ADMIN_COOKIE));
    if (adm?.admin) {
      req.admin = adm.admin;
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Ingresá como administrador' });
    return res.redirect('/admin.html');
  }
  const session = readToken(getCookie(req, COOKIE));
  if (session?.dni) {
    req.dni = session.dni;
    return next();
  }
  if (PUBLIC.some((re) => re.test(req.path))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Iniciá sesión' });
  return res.redirect('/login.html');
}

module.exports = { guard, setSession, clearSession, setAdminSession, clearAdminSession, adminValido };
