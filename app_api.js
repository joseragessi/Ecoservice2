// API de la PWA (mecánicos + pañol).
// Se sirve desde el mismo origen que el panel, así que NO expone la key de
// Supabase al cliente (la app vieja de GitHub Pages sí lo hacía).
// Token firmado con el mismo HMAC del panel, pero con rol adentro:
//   { rol: 'mecanico', mid, nombre }  |  { rol: 'panol', usuario }

const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const supabase = require('./supabase');
const { notificarCapataz } = require('./notificar');

const router = express.Router();
const SECRET = process.env.PANEL_SECRET || 'cambiar-este-secret-en-railway';

// ── Claves ────────────────────────────────────────────────────
// Hash con salt por usuario. Formato guardado: "salt:hash".
function hashClave(clave, salt) {
  salt = salt || crypto.randomBytes(12).toString('hex');
  const h = crypto.createHmac('sha256', SECRET).update(salt + ':' + clave).digest('hex');
  return `${salt}:${h}`;
}
function verificarClave(clave, guardado) {
  if (!guardado || !clave) return false;
  const [salt] = String(guardado).split(':');
  if (!salt) return false;
  const calc = hashClave(clave, salt);
  // Comparación de tiempo constante
  const a = Buffer.from(calc), b = Buffer.from(String(guardado));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Token ─────────────────────────────────────────────────────
function firmar(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verificar(token) {
  if (!token) return null;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const esperado = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig !== esperado) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}
// Middleware: exige token válido y, opcionalmente, un rol puntual.
function authApp(rol) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const p = verificar(h.startsWith('Bearer ') ? h.slice(7) : null);
    if (!p || !p.rol) return res.status(401).json({ error: 'No autorizado' });
    if (rol && p.rol !== rol) return res.status(403).json({ error: 'Sin permiso' });
    req.app_user = p;
    next();
  };
}

// ── Login ─────────────────────────────────────────────────────
/** PANOL_USERS = "panol:clave123" (mismo formato que PANEL_USERS) */
function usuariosPanol() {
  const map = {};
  (process.env.PANOL_USERS || '').split(',').forEach(par => {
    const i = par.indexOf(':');
    if (i > 0) map[par.slice(0, i).trim()] = par.slice(i + 1);
  });
  return map;
}

router.post('/api/app/login', async (req, res) => {
  try {
    const usuario = String((req.body || {}).usuario || '').trim();
    const clave   = String((req.body || {}).clave || '');
    if (!usuario || !clave) return res.status(400).json({ error: 'Faltan usuario y clave' });
    const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;   // 30 días (es una app de campo)

    // 1) ¿Pañol? (usuarios de variable de entorno)
    const panol = usuariosPanol();
    if (panol[usuario] && panol[usuario] === clave) {
      return res.json({ token: firmar({ rol: 'panol', usuario, exp }), rol: 'panol', nombre: 'Pañol' });
    }

    // 2) ¿Mecánico? (tabla mecanicos, clave hasheada)
    const { data: mec } = await supabase
      .from('mecanicos').select('id, nombre, clave_hash, activo')
      .eq('usuario', usuario).maybeSingle();
    if (mec && mec.activo && verificarClave(clave, mec.clave_hash)) {
      return res.json({
        token: firmar({ rol: 'mecanico', mid: mec.id, nombre: mec.nombre, exp }),
        rol: 'mecanico', nombre: mec.nombre,
      });
    }
    res.status(401).json({ error: 'Usuario o clave incorrectos' });
  } catch (err) {
    console.error('app login:', err);
    res.status(500).json({ error: 'Error de login' });
  }
});

// ── MECÁNICO ──────────────────────────────────────────────────
const CAMPO_FECHA = {
  diagnostico:         'fecha_diagnostico',
  esperando_repuestos: 'fecha_espera_repuestos',
  en_reparacion:       'fecha_en_reparacion',
  finalizado:          'fecha_finalizado',
};
const ESTADOS = ['pendiente', 'diagnostico', 'esperando_repuestos', 'en_reparacion', 'finalizado'];

// Solo las incidencias asignadas a ESTE mecánico (el token manda, no el cliente).
router.get('/api/app/mis-incidencias', authApp('mecanico'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('incidencias')
      .select('id, estado, prioridad, descripcion, created_at, fecha_finalizado, ' +
              'equipos(nombre,tipo,codigo), objetivos(nombre), capataces(nombre,telefono), ' +
              'comentarios_incidencias(mecanico_nombre,texto,created_at)')
      .eq('mecanico_id', req.app_user.mid)
      .order('created_at', { ascending: false })
      .limit(150);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('app incidencias:', err);
    res.status(500).json({ error: 'Error cargando tus reparaciones' });
  }
});

router.post('/api/app/incidencia/:id/estado', authApp('mecanico'), async (req, res) => {
  try {
    const estado = String((req.body || {}).estado || '');
    if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

    // Verificar que la incidencia sea suya antes de tocarla
    const { data: inc, error: e0 } = await supabase
      .from('incidencias')
      .select('id, mecanico_id, equipos(nombre,tipo), capataces(nombre,telefono)')
      .eq('id', req.params.id).single();
    if (e0 || !inc) return res.status(404).json({ error: 'Incidencia inexistente' });
    if (String(inc.mecanico_id) !== String(req.app_user.mid)) {
      return res.status(403).json({ error: 'Esa reparación no es tuya' });
    }

    const patch = { estado };
    const campo = CAMPO_FECHA[estado];
    if (campo) patch[campo] = new Date().toISOString();
    const { data, error } = await supabase
      .from('incidencias').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;

    // Avisarle al capataz cuando la reparación se termina
    let notificado = false;
    if (estado === 'finalizado' && inc.capataces && inc.capataces.telefono) {
      const eq = inc.equipos ? (inc.equipos.nombre || inc.equipos.tipo) : 'el equipo';
      notificado = await notificarCapataz(
        inc.capataces.telefono,
        `🔧 *Reparación terminada*\n\n${eq} ya está listo.\n` +
        `Lo reparó ${req.app_user.nombre}.\n\n_EcoService · Taller_`
      );
    }
    res.json({ ...data, _notificado: notificado });
  } catch (err) {
    console.error('app estado:', err);
    res.status(500).json({ error: 'Error cambiando el estado' });
  }
});

router.post('/api/app/incidencia/:id/comentario', authApp('mecanico'), async (req, res) => {
  try {
    const texto = String((req.body || {}).texto || '').trim();
    if (!texto) return res.status(400).json({ error: 'Falta el texto' });
    const { data: inc } = await supabase
      .from('incidencias').select('mecanico_id').eq('id', req.params.id).single();
    if (!inc || String(inc.mecanico_id) !== String(req.app_user.mid)) {
      return res.status(403).json({ error: 'Esa reparación no es tuya' });
    }
    const { data, error } = await supabase.from('comentarios_incidencias')
      .insert({ incidencia_id: req.params.id, mecanico_nombre: req.app_user.nombre, texto })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('app comentario:', err);
    res.status(500).json({ error: 'Error guardando la observación' });
  }
});

// ── PAÑOL ─────────────────────────────────────────────────────
router.get('/api/app/pedidos', authApp('panol'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pedidos_insumos')
      .select('*, pedidos_insumos_items(*), capataces(nombre), objetivos(nombre)')
      .order('created_at', { ascending: false }).limit(120);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('app pedidos:', err);
    res.status(500).json({ error: 'Error cargando los pedidos' });
  }
});

// Entrega con ajuste: se entrega lo que realmente sale del depósito.
router.post('/api/app/pedidos/:id/entregar', authApp('panol'), async (req, res) => {
  try {
    const items = Array.isArray((req.body || {}).items) ? req.body.items : null;
    if (items) {
      const limpios = items
        .map(i => ({ pedido_id: req.params.id,
          item: String(i.item || '').trim(),
          cantidad: i.cantidad ? String(i.cantidad).trim() : null }))
        .filter(i => i.item);
      const { error: eDel } = await supabase
        .from('pedidos_insumos_items').delete().eq('pedido_id', req.params.id);
      if (eDel) throw eDel;
      if (limpios.length) {
        const { error: eIns } = await supabase.from('pedidos_insumos_items').insert(limpios);
        if (eIns) throw eIns;
      }
    }
    const { data, error } = await supabase
      .from('pedidos_insumos').update({ estado: 'entregado' }).eq('id', req.params.id)
      .select('*, capataces(nombre,telefono), objetivos(nombre), pedidos_insumos_items(*)').single();
    if (error) throw error;

    let notificado = false;
    if (data.capataces && data.capataces.telefono) {
      const obj = data.objetivos ? data.objetivos.nombre : (data.objetivo_texto || '—');
      const lista = (data.pedidos_insumos_items || [])
        .map(i => `• ${i.item}${i.cantidad ? ' — ' + i.cantidad : ''}`).join('\n');
      notificado = await notificarCapataz(
        data.capataces.telefono,
        `📦 *Pedido listo para retirar*\n\n📍 Objetivo: ${obj}\n` +
        (lista ? `\n${lista}\n` : '') +
        `\nTu pedido de insumos ya está disponible en depósito. ✅\n\n_EcoService · Depósito_`
      );
    }
    res.json({ ...data, _notificado: notificado });
  } catch (err) {
    console.error('app entregar:', err);
    res.status(500).json({ error: 'Error entregando el pedido' });
  }
});

// ── Archivos de la PWA ────────────────────────────────────────
router.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'app.html')));
router.get('/app/manifest.json', (_req, res) => res.sendFile(path.join(__dirname, 'app-manifest.json')));
router.get('/app/sw.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'app-sw.js'));
});
router.get('/app/icon-192.png', (_req, res) => res.sendFile(path.join(__dirname, 'app-icon-192.png')));
router.get('/app/icon-512.png', (_req, res) => res.sendFile(path.join(__dirname, 'app-icon-512.png')));

module.exports = { router, hashClave };
