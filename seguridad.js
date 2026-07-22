// ── Seguridad: rate limit de logins, headers y firma de Twilio ──────────────
// Todo en memoria y sin dependencias nuevas. Objetivo: que nadie pueda
// fuerza-brutear el login del panel o de la app, que el webhook no acepte
// mensajes falsos, y headers básicos anti-clickjacking.

// ── Rate limit de intentos de login ─────────────────────────
// 5 intentos fallidos por (IP + usuario) en 15 minutos → bloqueado 15 minutos.
const VENTANA_MS = 15 * 60 * 1000;
const MAX_INTENTOS = Number(process.env.LOGIN_MAX_INTENTOS) || 5;
const intentos = {};   // clave → {n, desde}

function limpiar() {
  const ahora = Date.now();
  for (const k of Object.keys(intentos)) {
    if (ahora - intentos[k].desde > VENTANA_MS) delete intentos[k];
  }
}
setInterval(limpiar, 5 * 60 * 1000).unref();

function ipDe(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'sin-ip';
}

/** ¿Está bloqueado este intento? Llamar ANTES de verificar la clave. */
function loginBloqueado(req, usuario) {
  const k = ipDe(req) + '|' + String(usuario || '').toLowerCase();
  const e = intentos[k];
  if (!e) return false;
  if (Date.now() - e.desde > VENTANA_MS) { delete intentos[k]; return false; }
  return e.n >= MAX_INTENTOS;
}
/** Registrar un intento fallido. Devuelve cuántos van. */
function loginFallido(req, usuario) {
  const k = ipDe(req) + '|' + String(usuario || '').toLowerCase();
  const e = intentos[k] = intentos[k] || { n: 0, desde: Date.now() };
  e.n++;
  console.warn(`[seguridad] login fallido ${e.n}/${MAX_INTENTOS} — usuario "${usuario}" desde ${ipDe(req)}`);
  return e.n;
}
/** Login OK: limpiar el contador. */
function loginOk(req, usuario) {
  delete intentos[ipDe(req) + '|' + String(usuario || '').toLowerCase()];
}

// ── Headers de seguridad básicos ─────────────────────────────
function headersSeguridad(req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');                 // nadie embebe el panel en un iframe
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=()');
  next();
}

// ── Validación de firma del webhook de Twilio ────────────────
// Twilio firma cada request con X-Twilio-Signature usando el AUTH_TOKEN.
// Con esto, nadie puede simular mensajes de WhatsApp posteando al webhook.
// Requiere PUBLIC_URL en Railway (ej. https://ecoservice-production.up.railway.app).
// Si PUBLIC_URL no está seteada, se deja pasar con un warning (fail-open),
// para no romper el bot por un tema de configuración.
function validarTwilio(req) {
  const base = process.env.PUBLIC_URL;
  if (!base) {
    if (!validarTwilio._avisado) {
      console.warn('[seguridad] PUBLIC_URL no seteada: el webhook NO valida la firma de Twilio. Configurala en Railway para cerrar este agujero.');
      validarTwilio._avisado = true;
    }
    return true;
  }
  const firma = req.headers['x-twilio-signature'];
  if (!firma) return false;
  const url = base.replace(/\/$/, '') + req.originalUrl;
  const twilio = require('twilio');
  return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, firma, url, req.body || {});
}

module.exports = { loginBloqueado, loginFallido, loginOk, headersSeguridad, validarTwilio };
