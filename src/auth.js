// Sesión de socios: cookie firmada con HMAC (sin dependencias).
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'sid';
const TTL_MS = 12 * 60 * 60 * 1000;

const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function createToken(dni) {
  const data = Buffer.from(JSON.stringify({ dni, exp: Date.now() + TTL_MS })).toString('base64url');
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

function setSession(res, dni) {
  res.setHeader('Set-Cookie', `${COOKIE}=${createToken(dni)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL_MS / 1000}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// Rutas que no piden login: pantalla de login, recursos comunes y el back-office de envíos.
const PUBLIC = [
  /^\/login\.html$/, /^\/(styles|tienda)\.css$/, /^\/favicon\.ico$/, /^\/health$/, /^\/api\/login$/,
  /^\/(panel|pedidos)(\.html|\.js)$/, /^\/chat(\.html|\.js)$/,
  /^\/api\/(mensajes|conversaciones|pedidos|metricas|ejemplos|negocio)(\/|$)/,
];

function guard(req, res, next) {
  const session = readToken(getCookie(req, COOKIE));
  if (session) {
    req.dni = session.dni;
    return next();
  }
  if (PUBLIC.some((re) => re.test(req.path))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Iniciá sesión' });
  return res.redirect('/login.html');
}

module.exports = { guard, setSession, clearSession };
