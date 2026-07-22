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

    // Usuarios de la app: viven todos en `mecanicos`, con rol_app = mecanico | panol.
    // Se dan de alta desde el panel (Maestros → Mecánicos).
    const { data: u } = await supabase
      .from('mecanicos').select('id, nombre, clave_hash, activo, rol_app')
      .eq('usuario', usuario).maybeSingle();
    if (u && u.activo && verificarClave(clave, u.clave_hash)) {
      const rol = u.rol_app === 'panol' ? 'panol' : u.rol_app === 'supervisor' ? 'supervisor' : 'mecanico';
      return res.json({
        token: firmar({ rol, mid: u.id, nombre: u.nombre, exp }),
        rol, nombre: u.nombre,
      });
    }

    // Compatibilidad: pañol por variable de entorno (PANOL_USERS), si se usó
    const panol = usuariosPanol();
    if (panol[usuario] && panol[usuario] === clave) {
      return res.json({ token: firmar({ rol: 'panol', usuario, exp }), rol: 'panol', nombre: 'Pañol' });
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

// ── SUPERVISOR: pedidos de insumos (solo lectura) ─────────────
router.get('/api/app/insumos-pedidos', authApp('supervisor'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pedidos_insumos')
      .select('*, pedidos_insumos_items(*), capataces(nombre), objetivos(nombre)')
      .order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('app insumos supervisor:', err);
    res.status(500).json({ error: 'Error cargando pedidos' });
  }
});

// ── PLANILLA DE SERVICE (foto → IA → revisión → guardar) ─────
// El mecánico fotografía la planilla de papel; la IA la extrae y él revisa
// antes de guardar. Tabla: services_unidades (data jsonb flexible, como facturas).
const MODEL_SERVICE = process.env.ANTHROPIC_MODEL_EXTRACT || 'claude-haiku-4-5-20251001';

router.post('/api/app/service/extract', authApp('mecanico'), async (req, res) => {
  const t0 = Date.now();
  try {
    const { fileData, fileType } = req.body || {};
    if (!fileData) return res.status(400).json({ error: 'Falta la foto' });
    const part = { type: 'image', source: { type: 'base64', media_type: fileType || 'image/jpeg', data: fileData } };
    const prompt = 'Esta es una foto de una "Planilla de Service de Unidades" de EcoService, ' +
      'completada A MANO por un mecánico. Extraé los datos y devolvé ÚNICAMENTE JSON sin backticks:\n' +
      '{"fecha_service":"YYYY-MM-DD","unidad":"string","tipo_unidad":"tractor|giro cero|camioneta|otro",' +
      '"marca_modelo":"string","patente":"string","km_horas":"string",' +
      '"tareas":[{"tarea":"string","descripcion":"string","repuestos":"string","estado":"ok|seguimiento"}],' +
      '"repuestos_entregados":[{"repuesto":"string","marca":"string","cantidad":1,"codigo":"string","observaciones":"string"}],' +
      '"mecanico":"string","observaciones":"string"}\n' +
      'Reglas:\n' +
      '- Es letra manuscrita: interpretá con cuidado. Si un campo es ilegible o está vacío, poné null.\n' +
      '- En "tareas" incluí SOLO las filas del checklist que tengan algo escrito (descripción, repuestos o estado). ' +
      'Usá el nombre impreso de la tarea (ej. "Cambio de aceite motor").\n' +
      '- "estado": "ok" si dice OK, "seguimiento" si requiere seguimiento, null si no está claro.\n' +
      '- En "repuestos_entregados" una entrada por fila escrita de la tabla de repuestos.\n' +
      '- "tipo_unidad": el que esté tildado/marcado; si escribieron la marca (ej. Iveco) y no tildaron nada, deducilo (camión/camioneta→"camioneta", si no "otro").\n' +
      '- "km_horas" como texto tal cual (ej. "40.279 km").\n' +
      '- "mecanico": el nombre del mecánico responsable si está escrito.';
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      MODEL_SERVICE,
        max_tokens: 3000,
        messages:   [{ role: 'user', content: [part, { type: 'text', text: prompt }] }],
      }),
    });
    const data = await resp.json();
    const txt = (data.content || []).map(c => c.text || '').join('');
    console.log(`[service] planilla extraída en ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `(${MODEL_SERVICE}, ${(data.usage && data.usage.output_tokens) || '?'} tokens)`);
    try {
      res.json(JSON.parse(txt.replace(/```json|```/g, '').trim()));
    } catch (e) {
      res.json({ __error: 'No pude leer la planilla. Sacá la foto más derecha y con buena luz, o cargá los datos a mano.' });
    }
  } catch (err) {
    console.error('service extract:', err);
    res.status(500).json({ error: 'Error extrayendo la planilla' });
  }
});

// Guardar el service revisado. El mecánico que guarda queda registrado por token.
router.post('/api/app/service', authApp('mecanico'), async (req, res) => {
  try {
    const d = req.body || {};
    if (!d.unidad && !d.patente) return res.status(400).json({ error: 'Falta identificar la unidad (unidad o patente)' });
    const fila = {
      data: {
        fecha_service:       d.fecha_service || null,
        unidad:              d.unidad || null,
        tipo_unidad:         d.tipo_unidad || null,
        marca_modelo:        d.marca_modelo || null,
        patente:             d.patente || null,
        km_horas:            d.km_horas || null,
        proximo_service:     d.proximo_service || null,
        tareas:              Array.isArray(d.tareas) ? d.tareas : [],
        repuestos_entregados: Array.isArray(d.repuestos_entregados) ? d.repuestos_entregados : [],
        mecanico:            d.mecanico || req.app_user.nombre || null,
        observaciones:       d.observaciones || null,
      },
      mecanico_id: req.app_user.mid || null,
      mecanico_nombre: req.app_user.nombre || null,
    };
    const { data, error } = await supabase.from('services_unidades').insert(fila).select().single();
    if (error) throw error;
    res.json({ ok: true, id: data.id });
  } catch (err) {
    console.error('service guardar:', err);
    res.status(500).json({ error: 'Error guardando el service' });
  }
});

// Últimos services cargados (de TODOS los mecánicos: en el taller todos
// necesitan ver qué service se le hizo a cada unidad)
router.get('/api/app/services', authApp('mecanico'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('services_unidades').select('*')
      .order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('app services:', err);
    res.status(500).json({ error: 'Error cargando services' });
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
// Los iconos van embebidos en base64 (app_icons.js) en vez de como archivos
// binarios: así se pueden subir al repo por la interfaz web de GitHub sin que
// se corrompan, que es lo que rompía la instalación de la PWA.
const ICONOS = require('./app_icons');
function servirIcono(b64) {
  return (_req, res) => {
    const buf = Buffer.from(b64, 'base64');
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  };
}
router.get('/app/icon-192.png', servirIcono(ICONOS.icon192));
router.get('/app/icon-512.png', servirIcono(ICONOS.icon512));

module.exports = { router, hashClave };
