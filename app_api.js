// API de la PWA (mecánicos + pañol).
// Se sirve desde el mismo origen que el panel, así que NO expone la key de
// Supabase al cliente (la app vieja de GitHub Pages sí lo hacía).
// Token firmado con el mismo HMAC del panel, pero con rol adentro:
//   { rol: 'mecanico', mid, nombre }  |  { rol: 'panol', usuario }

const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const supabase = require('./supabase');
const { notificarCapataz, mensajeEstadoIncidencia } = require('./notificar');
const seg = require('./seguridad');

const router = express.Router();
// SECRET de los tokens: SIEMPRE desde la env var. Si falta, se genera uno
// aleatorio por arranque (los tokens caducan en cada redeploy, molesto pero
// seguro) — jamás un default fijo que cualquiera pueda leer en el repo.
const SECRET = process.env.PANEL_SECRET ||
  (console.warn('[seguridad] PANEL_SECRET no seteada: usando secret aleatorio (las sesiones caen en cada redeploy)'),
   crypto.randomBytes(32).toString('hex'));

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
    const permitidos = Array.isArray(rol) ? rol : (rol ? [rol] : null);
    if (permitidos && !permitidos.includes(p.rol)) return res.status(403).json({ error: 'Sin permiso' });
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
    // Anti fuerza bruta: 5 intentos fallidos por IP+usuario → 15 min bloqueado
    if (seg.loginBloqueado(req, usuario)) {
      return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos y probá de nuevo.' });
    }
    const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;   // 30 días (es una app de campo)

    // Usuarios de la app: viven todos en `mecanicos`, con rol_app = mecanico | panol.
    // Se dan de alta desde el panel (Maestros → Mecánicos).
    const { data: u } = await supabase
      .from('mecanicos').select('id, nombre, clave_hash, activo, rol_app')
      .ilike('usuario', usuario).maybeSingle();
    if (u && u.activo && verificarClave(clave, u.clave_hash)) {
      seg.loginOk(req, usuario);
      const rol = u.rol_app === 'panol' ? 'panol' : u.rol_app === 'supervisor' ? 'supervisor' : 'mecanico';
      return res.json({
        token: firmar({ rol, mid: u.id, nombre: u.nombre, exp }),
        rol, nombre: u.nombre,
      });
    }

    // Capataces: viven en `capataces` (misma tabla que usa el bot, con su
    // objetivo_id y unidad). Se les agregan credenciales (usuario/clave_hash)
    // para que entren a la app y carguen combustible a su unidad/objetivo.
    const { data: cap } = await supabase
      .from('capataces').select('id, nombre, clave_hash, activo, usuario, objetivo_id, objetivos(nombre), unidad_id, unidades(id, patente)')
      // ilike y no eq: en el celular el teclado suele mandar la primera letra
      // en mayúscula y el capataz no tiene por qué pelearse con eso.
      .ilike('usuario', usuario).maybeSingle();
    if (cap && cap.activo && cap.clave_hash && verificarClave(clave, cap.clave_hash)) {
      seg.loginOk(req, usuario);
      return res.json({
        token: firmar({ rol: 'capataz', cid: cap.id, nombre: cap.nombre,
          objetivo_id: cap.objetivo_id || null,
          objetivo_nombre: cap.objetivos ? cap.objetivos.nombre : null,
          unidad_id: cap.unidad_id || null,
          patente: cap.unidades ? cap.unidades.patente : null, exp }),
        rol: 'capataz', nombre: cap.nombre,
      });
    }

    // Compatibilidad: pañol por variable de entorno (PANOL_USERS), si se usó
    const panol = usuariosPanol();
    if (panol[usuario] && panol[usuario] === clave) {
      seg.loginOk(req, usuario);
      return res.json({ token: firmar({ rol: 'panol', usuario, exp }), rol: 'panol', nombre: 'Pañol' });
    }

    seg.loginFallido(req, usuario);
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
      .select('id, estado, prioridad, descripcion, created_at, fecha_finalizado, numero_unidad, tipo_equipo, tipo_mant, ' +
              'equipos(nombre,tipo,codigo), objetivos(nombre), capataces(nombre,telefono), ' +
              'comentarios_incidencias(mecanico_nombre,texto,created_at), ' +
              'repuestos_taller(id,items,nota,estado,created_at)')
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

// Objetivos activos, para el selector del alta manual
router.get('/api/app/objetivos', authApp('mecanico'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('objetivos').select('id, nombre').eq('activo', true).order('nombre');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('app objetivos:', err);
    res.status(500).json({ error: 'Error cargando objetivos' });
  }
});

// Alta manual de incidencia por el mecánico (lo que entra al taller sin pasar
// por el bot del capataz). Puede ser correctivo o preventivo; queda asignada
// al mecánico que la crea.
router.post('/api/app/incidencias', authApp('mecanico'), async (req, res) => {
  try {
    const d = req.body || {};
    const tipoMant = d.tipo_mant === 'preventivo' ? 'preventivo' : 'correctivo';
    const tipoEquipo = String(d.tipo_equipo || '').trim();
    const numeroUnidad = String(d.numero_unidad || '').trim();
    if (!tipoEquipo) return res.status(400).json({ error: 'Falta el tipo de equipo' });
    if (!numeroUnidad) return res.status(400).json({ error: 'Falta el número de unidad o la patente' });
    const descripcion = String(d.descripcion || '').trim() ||
      (tipoMant === 'preventivo' ? 'Service preventivo' : 'Ingreso a taller');
    const PRIOS = ['critico', 'alta', 'media', 'baja'];
    const prioridad = PRIOS.includes(d.prioridad) ? d.prioridad
      : (tipoMant === 'preventivo' ? 'baja' : 'media');

    const { data: inc, error } = await supabase.from('incidencias').insert({
      capataz_id: null, objetivo_id: d.objetivo_id || null, equipo_id: null,
      mecanico_id: req.app_user.mid,
      prioridad, estado: 'pendiente', equipo_parado: false,
      descripcion, numero_unidad: numeroUnidad, tipo_equipo: tipoEquipo,
      tipo_falla: tipoMant === 'preventivo' ? 'Preventivo' : 'Ingreso taller',
      tipo_mant: tipoMant, origen: 'app',
    }).select('id').single();
    if (error) throw error;
    res.json({ ok: true, id: inc.id });
  } catch (err) {
    console.error('app alta incidencia:', err);
    res.status(500).json({ error: 'No pude crear la incidencia: ' + (err.message || 'error') });
  }
});

router.post('/api/app/incidencia/:id/estado', authApp('mecanico'), async (req, res) => {
  try {
    const estado = String((req.body || {}).estado || '');
    if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

    // Verificar que la incidencia sea suya antes de tocarla
    const { data: inc, error: e0 } = await supabase
      .from('incidencias')
      .select('id, mecanico_id, numero_unidad, tipo_equipo, equipos(nombre,tipo), capataces(nombre,telefono)')
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

    // Aviso al capataz en cada avance (diagnóstico, esperando repuestos,
    // en reparación, finalizado), con la última nota del mecánico si dejó una
    let notificado = false;
    const AVISAN = ['diagnostico', 'esperando_repuestos', 'en_reparacion', 'finalizado'];
    if (AVISAN.includes(estado) && inc.capataces && inc.capataces.telefono) {
      let comentario = null;
      try {
        const { data: com } = await supabase.from('comentarios_incidencias')
          .select('texto').eq('incidencia_id', req.params.id)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (com) comentario = com.texto;
      } catch (e) { /* sin comentarios */ }
      const msg = mensajeEstadoIncidencia(estado, {
        equipo:   inc.equipos ? (inc.equipos.nombre || inc.equipos.tipo) : (inc.tipo_equipo || 'el equipo'),
        unidad:   inc.numero_unidad,
        mecanico: req.app_user.nombre,
        comentario,
      });
      if (msg) notificado = await notificarCapataz(inc.capataces.telefono, msg);
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

// Sugerencia IA: analiza la falla + comentarios y propone la lista probable
// (editable — el mecánico agrega/borra/corrige antes de mandar)
router.post('/api/app/incidencia/:id/repuestos/sugerir', authApp('mecanico'), async (req, res) => {
  try {
    const { data: inc } = await supabase.from('incidencias')
      .select('mecanico_id').eq('id', req.params.id).single();
    if (!inc || String(inc.mecanico_id) !== String(req.app_user.mid)) {
      return res.status(403).json({ error: 'Esa reparación no es tuya' });
    }
    const { sugerirRepuestos } = require('./repuestos_ia');
    res.json(await sugerirRepuestos(req.params.id));
  } catch (err) {
    console.error('app repuestos sugerir:', err);
    res.status(500).json({ error: 'No pude armar la sugerencia. Cargalo a mano.' });
  }
});

// ── Circuito de repuestos: REFERENTE ─────────────────────────────────────
// El Referente es un mecánico con el flag es_referente en su ficha: valida
// técnicamente los pedidos, cotiza y carga la nota de pedido. No compra ni
// aprueba (eso es de José en el panel).
async function esReferente(mid) {
  try {
    const { data } = await supabase.from('mecanicos').select('es_referente').eq('id', mid).maybeSingle();
    return !!(data && data.es_referente);
  } catch (e) { return false; }
}

// Cola del Referente: todo lo que está antes de la compra. Devuelve
// es_referente:false (200, no 403) para que la app pueda decidir si muestra
// el botón sin manejar errores.
router.get('/api/app/referente/cola', authApp(['mecanico', 'panol']), async (req, res) => {
  try {
    if (!await esReferente(req.app_user.mid)) return res.json({ es_referente: false, pedidos: [] });
    const { data, error } = await supabase.from('repuestos_taller')
      .select('*, incidencias(id, prioridad, estado, equipo_parado, numero_unidad, tipo_equipo, created_at, equipos(nombre,tipo), mecanicos(nombre))')
      .in('estado', ['pedido', 'en_cotizacion', 'cotizado'])
      .order('created_at', { ascending: true }).limit(120);
    if (error) throw error;
    res.json({ es_referente: true, pedidos: data || [] });
  } catch (err) {
    console.error('referente cola:', err.message);
    res.status(500).json({ error: 'Error cargando la cola' });
  }
});

// Acciones del Referente sobre un pedido. body: { accion, ... }
//  tomar            → pedido → en_cotizacion (exige foto o sin_foto_motivo)
//  sin_foto         → marca "identificado sin foto" con motivo (obligatorio)
//  pieza_proveedor  → sub-marca "la pieza quedó en el proveedor" (hoy)
//  descripcion      → corrige la descripción técnica (items)
//  nota             → carga la nota de pedido → cotizado (proveedor+precio+plazo, adjunto opcional)
router.post('/api/app/referente/repuestos/:id', authApp(['mecanico', 'panol']), async (req, res) => {
  try {
    if (!await esReferente(req.app_user.mid)) return res.status(403).json({ error: 'Sin permiso de referente' });
    const { data: ped } = await supabase.from('repuestos_taller').select('*').eq('id', req.params.id).single();
    if (!ped) return res.status(404).json({ error: 'Pedido inexistente' });
    const b = req.body || {};
    const patch = {};
    const ahora = new Date().toISOString();
    if (b.accion === 'tomar') {
      if (ped.estado !== 'pedido') return res.status(422).json({ error: 'El pedido no está en estado "pedido".' });
      patch.estado = 'en_cotizacion'; patch.estado_desde = ahora;
      patch.referente_nombre = req.app_user.nombre;
    } else if (b.accion === 'sin_foto') {
      const motivo = String(b.motivo || '').trim();
      if (!motivo) return res.status(400).json({ error: 'Falta el motivo' });
      patch.sin_foto_motivo = motivo;
    } else if (b.accion === 'pieza_proveedor') {
      patch.pieza_en_proveedor = b.quitar ? null : ahora.slice(0, 10);
    } else if (b.accion === 'descripcion') {
      const items = (Array.isArray(b.items) ? b.items : [])
        .map(i => ({ descripcion: String(i.descripcion || '').trim(), cantidad: Number(i.cantidad) || 1, codigo: String(i.codigo || '').trim(), comprado: !!i.comprado }))
        .filter(i => i.descripcion);
      if (!items.length) return res.status(400).json({ error: 'La descripción no puede quedar vacía' });
      patch.items = items;
    } else if (b.accion === 'nota') {
      if (!['pedido', 'en_cotizacion'].includes(ped.estado)) return res.status(422).json({ error: 'El pedido ya está cotizado o más adelante.' });
      const proveedor = String(b.proveedor || '').trim();
      const precio = Number(String(b.precio || '').replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.'));
      const plazo = String(b.plazo || '').trim();
      if (!proveedor || !precio || !plazo) return res.status(400).json({ error: 'La nota necesita proveedor, precio y plazo.' });
      patch.nota_proveedor = proveedor; patch.nota_precio = precio; patch.nota_plazo = plazo;
      patch.estado = 'cotizado'; patch.estado_desde = ahora;
      patch.cotizado_at = ahora; patch.cotizado_por = req.app_user.nombre;
      patch.referente_nombre = ped.referente_nombre || req.app_user.nombre;
      patch.observacion = null;   // si venía devuelto con observación, se limpia
      if (b.adjuntoData) {
        try {
          const ext = (b.adjuntoTipo === 'application/pdf') ? '.pdf' : '.jpg';
          const ruta = 'notas/' + req.params.id + '_' + Date.now() + ext;
          const { error: eAdj } = await supabase.storage.from('repuestos')
            .upload(ruta, Buffer.from(b.adjuntoData, 'base64'), { contentType: b.adjuntoTipo || 'image/jpeg' });
          if (!eAdj) patch.nota_adjunto = ruta;
        } catch (e) { console.error('nota adjunto:', e.message); }
      }
    } else {
      return res.status(400).json({ error: 'Acción desconocida' });
    }
    const { data, error } = await supabase.from('repuestos_taller')
      .update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('referente accion:', err.message);
    res.status(500).json({ error: err.message || 'No pude aplicar la acción' });
  }
});

// Foto o adjunto de un pedido (URL firmada 1 hora)
router.get('/api/app/referente/archivo/:id', authApp(), async (req, res) => {
  try {
    const { data: ped } = await supabase.from('repuestos_taller')
      .select('foto_ruta, nota_adjunto').eq('id', req.params.id).single();
    const ruta = req.query.tipo === 'adjunto' ? (ped && ped.nota_adjunto) : (ped && ped.foto_ruta);
    if (!ruta) return res.status(404).json({ error: 'Sin archivo' });
    const { data, error } = await supabase.storage.from('repuestos').createSignedUrl(ruta, 3600);
    if (error) throw error;
    res.json({ url: data.signedUrl });
  } catch (err) {
    res.status(500).json({ error: 'No pude generar el enlace' });
  }
});

// Pedir repuestos para una reparación (crea o reemplaza el pedido pendiente)
router.post('/api/app/incidencia/:id/repuestos', authApp('mecanico'), async (req, res) => {
  try {
    const items = (Array.isArray((req.body || {}).items) ? req.body.items : [])
      .map(i => ({ descripcion: String(i.descripcion || '').trim(), cantidad: Number(i.cantidad) || 1, codigo: String(i.codigo || '').trim() }))
      .filter(i => i.descripcion);
    if (!items.length) return res.status(400).json({ error: 'Cargá al menos un repuesto' });
    const { data: inc } = await supabase.from('incidencias')
      .select('mecanico_id').eq('id', req.params.id).single();
    if (!inc || String(inc.mecanico_id) !== String(req.app_user.mid)) {
      return res.status(403).json({ error: 'Esa reparación no es tuya' });
    }
    // Si ya hay un pedido sin entregar para esta reparación, se actualiza
    const { data: prev } = await supabase.from('repuestos_taller')
      .select('id, items, estado').eq('incidencia_id', req.params.id).neq('estado', 'entregado').maybeSingle();
    // Si se edita un pedido existente, conservar los tildes de "comprado" que
    // ya haya puesto compras (match por descripción)
    if (prev && Array.isArray(prev.items)) {
      const marcados = {};
      prev.items.forEach(i => { if (i.comprado) marcados[String(i.descripcion || '').toLowerCase()] = true; });
      items.forEach(i => { if (marcados[i.descripcion.toLowerCase()]) i.comprado = true; });
    }
    const fila = { items, nota: String((req.body || {}).nota || '').trim() || null, pedido_por: req.app_user.nombre };
    // Circuito con Referente: marca/modelo y foto del repuesto. La foto es
    // OPCIONAL (decisión 7-ago): suma para identificar la pieza, pero un
    // pedido sin foto avanza igual por el circuito.
    if ((req.body || {}).marca_modelo !== undefined) fila.marca_modelo = String(req.body.marca_modelo || '').trim() || null;
    // ORDEN DE COMPRA del propio mecánico: si cotizó (proveedor+precio+plazo),
    // el pedido queda COTIZADO directo, listo para la aprobación en Compras.
    const bb = req.body || {};
    const provOC = String(bb.proveedor || '').trim();
    const precioOC = Number(String(bb.precio || '').replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.'));
    const plazoOC = String(bb.plazo || '').trim();
    const cotizaOC = !!(provOC && precioOC && plazoOC);
    if (cotizaOC) {
      fila.nota_proveedor = provOC; fila.nota_precio = precioOC; fila.nota_plazo = plazoOC;
      fila.cotizado_at = new Date().toISOString(); fila.cotizado_por = req.app_user.nombre;
      fila.observacion = null;
    }
    if ((req.body || {}).fotoData) {
      try {
        const ruta = 'pedidos/' + req.params.id + '_' + Date.now() + '.jpg';
        const { error: eFoto } = await supabase.storage.from('repuestos')
          .upload(ruta, Buffer.from(req.body.fotoData, 'base64'), { contentType: 'image/jpeg' });
        if (!eFoto) fila.foto_ruta = ruta;
        else console.error('repuestos foto:', eFoto.message);
      } catch (e) { console.error('repuestos foto:', e.message); }
    }
    // Estado resultante: si cotizó → cotizado; si no → pedido (solo se pisa
    // el estado de pedidos que todavía están en la etapa del circuito previo
    // a la aprobación — un a_comprar/comprado no se retrocede).
    if (cotizaOC && (!prev || ['pedido', 'en_cotizacion', 'cotizado'].includes(prev.estado))) {
      fila.estado = 'cotizado'; fila.estado_desde = new Date().toISOString();
    }
    let q;
    if (prev) q = supabase.from('repuestos_taller').update(fila).eq('id', prev.id).select().single();
    else q = supabase.from('repuestos_taller').insert({ ...fila, incidencia_id: req.params.id, estado: fila.estado || 'pedido', estado_desde: fila.estado_desde || new Date().toISOString() }).select().single();
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('app repuestos:', err);
    res.status(500).json({ error: 'Error guardando el pedido de repuestos' });
  }
});

// ── SUPERVISOR de objetivos ───────────────────────────────────
// Ve las incidencias abiertas de los objetivos que tiene a cargo, agrupadas
// por objetivo; puede abrir el detalle (estados) y "reclamar la prisa".
router.get('/api/app/supervisor/incidencias', authApp('supervisor'), async (req, res) => {
  try {
    // Objetivos a cargo del supervisor (guardados en mecanicos.objetivos_cargo)
    const { data: sup } = await supabase.from('mecanicos')
      .select('objetivos_cargo').eq('id', req.app_user.mid).maybeSingle();
    const aCargo = (sup && Array.isArray(sup.objetivos_cargo)) ? sup.objetivos_cargo.map(String) : [];
    if (!aCargo.length) return res.json({ objetivos: [], sin_asignar: true });

    const { data, error } = await supabase.from('incidencias')
      .select('id, estado, prioridad, descripcion, created_at, equipo_parado, numero_unidad, tipo_equipo, tipo_falla, reclamada, reclamada_at, objetivo_id, objetivos(nombre), equipos(nombre,tipo), mecanicos(nombre), comentarios_incidencias(texto,mecanico_nombre,created_at)')
      .in('objetivo_id', aCargo)
      .neq('estado', 'finalizado')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Agrupar por objetivo
    const porObj = {};
    (data || []).forEach(i => {
      const oid = String(i.objetivo_id);
      const o = porObj[oid] || (porObj[oid] = {
        objetivo_id: oid, objetivo: i.objetivos ? i.objetivos.nombre : 'Sin objetivo',
        incidencias: [], abiertas: 0, criticas: 0, reclamadas: 0,
      });
      const ult = (i.comentarios_incidencias || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      o.incidencias.push({
        id: i.id, estado: i.estado, prioridad: i.prioridad,
        equipo: i.tipo_equipo || (i.equipos && (i.equipos.nombre || i.equipos.tipo)) || 'Equipo',
        unidad: i.numero_unidad, falla: i.tipo_falla, descripcion: i.descripcion,
        parado: i.equipo_parado, mecanico: i.mecanicos ? i.mecanicos.nombre : null,
        dias: Math.floor((Date.now() - new Date(i.created_at)) / 86400000),
        reclamada: !!i.reclamada, ultima_nota: ult ? ult.texto : null,
      });
      o.abiertas++;
      if (i.prioridad === 'critico') o.criticas++;
      if (i.reclamada) o.reclamadas++;
    });
    // Ordenar objetivos por criticidad
    const objetivos = Object.values(porObj).sort((a, b) => (b.criticas - a.criticas) || (b.abiertas - a.abiertas));
    res.json({ objetivos });
  } catch (err) {
    console.error('supervisor incidencias:', err);
    res.status(500).json({ error: 'Error cargando incidencias' });
  }
});

router.post('/api/app/supervisor/incidencia/:id/reclamar', authApp('supervisor'), async (req, res) => {
  try {
    // Solo puede reclamar incidencias de sus objetivos
    const { data: sup } = await supabase.from('mecanicos')
      .select('objetivos_cargo').eq('id', req.app_user.mid).maybeSingle();
    const aCargo = (sup && Array.isArray(sup.objetivos_cargo)) ? sup.objetivos_cargo.map(String) : [];
    const { data: inc } = await supabase.from('incidencias')
      .select('objetivo_id, reclamada').eq('id', req.params.id).maybeSingle();
    if (!inc || !aCargo.includes(String(inc.objetivo_id))) {
      return res.status(403).json({ error: 'Esa incidencia no es de tus objetivos' });
    }
    const nuevo = !inc.reclamada;   // toggle
    const patch = nuevo
      ? { reclamada: true, reclamada_at: new Date().toISOString(), reclamada_por: req.app_user.nombre }
      : { reclamada: false, reclamada_at: null, reclamada_por: null };
    const { error } = await supabase.from('incidencias').update(patch).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true, reclamada: nuevo });
  } catch (err) {
    console.error('supervisor reclamar:', err);
    res.status(500).json({ error: 'Error al reclamar' });
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

// Editar un service ya guardado (cualquier mecánico puede corregir; queda
// registrado quién lo editó y cuándo)
router.put('/api/app/service/:id', authApp('mecanico'), async (req, res) => {
  try {
    const d = req.body || {};
    if (!d.unidad && !d.patente) return res.status(400).json({ error: 'Falta identificar la unidad (unidad o patente)' });
    const { data: prev, error: e1 } = await supabase
      .from('services_unidades').select('data').eq('id', req.params.id).single();
    if (e1 || !prev) return res.status(404).json({ error: 'Service no encontrado' });
    const data = {
      ...prev.data,
      fecha_service:        d.fecha_service || null,
      unidad:               d.unidad || null,
      tipo_unidad:          d.tipo_unidad || null,
      marca_modelo:         d.marca_modelo || null,
      patente:              d.patente || null,
      km_horas:             d.km_horas || null,
      proximo_service:      d.proximo_service || null,
      tareas:               Array.isArray(d.tareas) ? d.tareas : [],
      repuestos_entregados: Array.isArray(d.repuestos_entregados) ? d.repuestos_entregados : [],
      observaciones:        d.observaciones || null,
      editado_por:          req.app_user.nombre || null,
      editado_at:           new Date().toISOString(),
    };
    const { error } = await supabase.from('services_unidades')
      .update({ data }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('service editar:', err);
    res.status(500).json({ error: 'Error editando el service' });
  }
});

// ══ CARGA DE COMBUSTIBLE · SUPERVISORES ══════════════════════
// El supervisor fotografía el remito, la IA lo lee (reusa extraerComprobante),
// él confirma litros por tipo y reparte cada tipo a destinos (unidad/bidones a
// objetivos). Entra a cargas_combustible como cualquier carga → aparece en el
// panel de Combustible con su modal de detalle. Solo super y gasoil.
const MODEL_REMITO_SUP = process.env.ANTHROPIC_MODEL_EXTRACT || 'claude-haiku-4-5-20251001';

// Un remito que el supervisor carga hoy no puede ser de hace años ni del futuro.
// Si el OCR leyó una fecha fuera de una ventana razonable (últimos 90 días,
// nunca futura), la descartamos y usamos hoy. Evita que la carga quede
// enterrada en 2007/2019 por una mala lectura y no aparezca en el panel.
function fechaValida(f) {
  const hoy = new Date();
  const hoyISO = hoy.toISOString().slice(0, 10);
  if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(String(f))) return hoyISO;
  const d = new Date(f + 'T12:00:00');
  if (isNaN(d)) return hoyISO;
  const dias = (hoy - d) / 86400000;
  if (dias < -1 || dias > 90) return hoyISO;  // futura o más vieja que 90 días → hoy
  return String(f);
}

// 1) Leer el remito: foto → IA precarga proveedor, número, fecha y litros por tipo
// La carga de combustible también la hacen el pañol y los mecánicos (mismo
// flujo del supervisor: foto del remito → IA → reparto). La ruta conserva el
// nombre "supervisor" para no romper la PWA ya instalada.
router.post('/api/app/supervisor/combustible/leer', authApp(['supervisor', 'panol', 'mecanico']), async (req, res) => {
  try {
    const { fileData, fileType } = req.body || {};
    if (!fileData) return res.status(400).json({ error: 'Falta la foto del remito' });
    const { extraerComprobante } = require('./extraccion');
    const buffer = Buffer.from(fileData, 'base64');
    const datos = await extraerComprobante(buffer, fileType || 'image/jpeg');
    // Agrupar litros por tipo (super / gasoil), que es como reparte el supervisor
    const norm = s => String(s || '').toUpperCase();
    const tipos = { gasoil: 0, super: 0 };
    (datos.items || []).forEach(it => {
      const p = norm(it.producto), l = Number(it.litros) || 0;
      if (/SUPER|NAFTA/.test(p) && !/DIESEL|GASOIL/.test(p)) tipos.super += l;
      else tipos.gasoil += l;  // diesel/gasoil y cualquier otro combustible líquido
    });
    res.json({
      ok: true,
      proveedor: datos.proveedor || null,
      cuit: datos.cuit || null,
      numero: datos.numero || null,
      fecha: datos.fecha || null,
      tipo_doc: datos.tipo_doc || 'remito',
      litros: {
        gasoil: Math.round(tipos.gasoil * 100) / 100,
        super:  Math.round(tipos.super  * 100) / 100,
      },
      items_raw: datos.items || [],
    });
  } catch (err) {
    console.error('sup combustible leer:', err);
    res.json({ __error: 'No pude leer el remito. Sacá la foto más derecha y con buena luz, o cargá los litros a mano.' });
  }
});

// 2) Guardar la carga con su reparto multi-destino.
// body: { proveedor, numero, fecha, tipo_doc, imagen(base64 opcional),
//   repartos:[{ tipo:'gasoil'|'super', litros, destino:'unidad'|'bidon',
//               objetivo_nombre, objetivo_id, patente }] }
router.post('/api/app/supervisor/combustible', authApp(['supervisor', 'panol', 'mecanico']), async (req, res) => {
  try {
    const d = req.body || {};
    const repartos = Array.isArray(d.repartos) ? d.repartos.filter(r => Number(r.litros) > 0) : [];
    if (!repartos.length) return res.status(400).json({ error: 'No hay litros para cargar' });

    // Resolver proveedor por nombre (o dejar en raw). Best-effort, nunca frena.
    let proveedorId = null;
    if (d.proveedor) {
      const { data: prov } = await supabase.from('proveedores')
        .select('id').ilike('nombre', d.proveedor.trim()).limit(1).maybeSingle();
      if (prov) proveedorId = prov.id;
    }
    // Resolver objetivos por nombre para los que no vengan con id
    const nombresObj = [...new Set(repartos.filter(r => r.destino === 'bidon' && !r.objetivo_id && r.objetivo_nombre).map(r => r.objetivo_nombre.trim()))];
    const mapaObj = {};
    if (nombresObj.length) {
      const { data: objs } = await supabase.from('objetivos').select('id, nombre').eq('activo', true);
      (objs || []).forEach(o => { mapaObj[o.nombre.trim().toUpperCase()] = o.id; });
    }

    // El supervisor suele existir TAMBIÉN como capataz (mismo nombre). Lo
    // buscamos para poner capataz_id y, sobre todo, para usar SU objetivo
    // (ej. "Supervisores") como objetivo de la carga — igual que el bot.
    //
    // FIX 11-ago (caso Alexis Barraza, supervisor nuevo): esto dependía de que
    // el supervisor ESTUVIERA en la tabla `capataces` con el nombre escrito
    // igual. Un supervisor nuevo no está, así que la carga quedaba sin objetivo
    // (y si la columna no lo admite, se caía entera). Ahora hay cascada de
    // respaldo y nada de esto puede frenar la carga.
    let capatazId = null, objetivoCapataz = null, comoResolvio = 'sin objetivo';
    const nombreSup = (req.app_user.nombre || '').trim();
    if (nombreSup) {
      // 1) match exacto por nombre
      const { data: cap } = await supabase.from('capataces')
        .select('id, objetivo_id').ilike('nombre', nombreSup).eq('activo', true).limit(1).maybeSingle();
      if (cap) { capatazId = cap.id; objetivoCapataz = cap.objetivo_id || null; comoResolvio = 'capataz exacto'; }
      // 2) match flexible: "Alexis Barraza" contra "BARRAZA, ALEXIS" o "Alexis B."
      if (!cap) {
        const { data: caps } = await supabase.from('capataces')
          .select('id, nombre, objetivo_id').eq('activo', true);
        const norm = t => String(t || '').toUpperCase().normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
        const mio = norm(nombreSup);
        const hit = (caps || []).find(c => {
          const suyo = norm(c.nombre);
          return mio.length && suyo.length && mio.every(p => suyo.includes(p));
        });
        if (hit) { capatazId = hit.id; objetivoCapataz = hit.objetivo_id || null; comoResolvio = 'capataz por nombre parecido'; }
      }
    }
    // 3) Sin capataz: el primer objetivo que el supervisor tenga a cargo
    if (!objetivoCapataz && req.app_user.mid) {
      const { data: me } = await supabase.from('mecanicos')
        .select('objetivos_cargo').eq('id', req.app_user.mid).maybeSingle();
      const aCargo = (me && Array.isArray(me.objetivos_cargo)) ? me.objetivos_cargo : [];
      if (aCargo.length) { objetivoCapataz = aCargo[0]; comoResolvio = 'objetivo a cargo'; }
    }
    // 4) Último recurso: el objetivo "SUPERVISORES", donde caen todas las
    // cargas de supervisor en el panel
    if (!objetivoCapataz) {
      const { data: os } = await supabase.from('objetivos')
        .select('id').ilike('nombre', '%supervisor%').limit(1).maybeSingle();
      if (os) { objetivoCapataz = os.id; comoResolvio = 'objetivo SUPERVISORES'; }
    }

    const litrosTotal = repartos.reduce((s, r) => s + Number(r.litros), 0);
    // El campo 'destino' de la carga solo acepta 'unidad' | 'bidon' | 'mixto'
    // (check constraint). Se calcula igual que en el bot.
    const dests = repartos.map(r => r.destino === 'bidon' ? 'bidon' : 'unidad');
    const destinoCarga = dests.length && dests.every(d => d === 'unidad') ? 'unidad'
                       : dests.length && dests.every(d => d === 'bidon')  ? 'bidon'
                       : 'mixto';
    const resumenTxt = repartos.map(r => `${r.litros}lt ${r.tipo} ${r.destino === 'bidon' ? '→ ' + (r.objetivo_nombre || '?') : '→ unidad'}`).join(' · ');

    const { data: carga, error } = await supabase.from('cargas_combustible').insert({
      origen: 'remito_capataz',  // valor permitido por el check (como el bot); el detalle de que fue el supervisor queda en respuesta_capataz
      tipo_doc: d.tipo_doc || 'remito',
      estado: 'sin_facturar',
      destino: destinoCarga,
      // El objetivo de la CARGA es el del supervisor (ej. "Supervisores"), como
      // en el bot; los objetivos de cada bidón viven en los items.
      objetivo_id: objetivoCapataz
        || repartos.find(r => r.objetivo_id)?.objetivo_id
        || (repartos.find(r => r.destino === 'bidon' && r.objetivo_nombre) ? mapaObj[repartos.find(r => r.destino === 'bidon' && r.objetivo_nombre).objetivo_nombre.trim().toUpperCase()] : null) || null,
      capataz_id: capatazId,
      proveedor_id: proveedorId,
      fecha: fechaValida(d.fecha),
      numero_remito: d.numero || null,
      patente_raw: repartos.find(r => r.patente)?.patente || null,
      litros_total: litrosTotal,
      datos_ia: d.datos_ia || null,
      respuesta_capataz: `Cargado por ${({supervisor:'supervisor',panol:'pañol',mecanico:'mecánico'})[req.app_user.rol] || 'app'}: ${req.app_user.nombre || '—'} · ${resumenTxt}`,
    }).select('id').single();
    if (error || !carga) throw (error || new Error('no se creó la carga'));
    // Log para poder rastrear una carga que "no aparece" en el panel
    console.log('[combustible app] carga ' + carga.id + ' · ' + (req.app_user.rol || '?') + ' ' +
      (req.app_user.nombre || '?') + ' · fecha ' + fechaValida(d.fecha) + ' · objetivo ' +
      (objetivoCapataz || 'NINGUNO') + ' (' + comoResolvio + ') · capataz ' + (capatazId || 'sin match') +
      ' · ' + litrosTotal + ' lt');

    const items = repartos.map(r => {
      const oid = r.objetivo_id || (r.destino === 'bidon' && r.objetivo_nombre ? mapaObj[r.objetivo_nombre.trim().toUpperCase()] : null) || null;
      return {
        carga_id: carga.id,
        producto: r.tipo === 'super' ? 'SUPER' : 'GASOIL',
        es_combustible: true,
        litros: Number(r.litros),
        destino: r.destino === 'bidon' ? 'bidon' : 'unidad',
        objetivo_id: r.destino === 'bidon' ? oid : null,
        destino_detalle: r.destino === 'bidon' ? (r.objetivo_nombre || null) : null,
      };
    });
    await supabase.from('cargas_combustible_items').insert(items);
    res.json({ ok: true, id: carga.id });
  } catch (err) {
    console.error('sup combustible guardar:', err);
    res.status(500).json({ error: 'Error guardando la carga: ' + (err.message || err.details || err.hint || 'desconocido') });
  }
});

// Objetivos para el buscador del reparto
// Insumos de los objetivos a cargo del supervisor: qué está pedido y qué hay
// para retirar/llevar. Solo lectura — la entrega la registra el pañol.
router.get('/api/app/supervisor/insumos', authApp('supervisor'), async (req, res) => {
  try {
    const { data: sup } = await supabase.from('mecanicos')
      .select('objetivos_cargo').eq('id', req.app_user.mid).maybeSingle();
    const aCargo = (sup && Array.isArray(sup.objetivos_cargo)) ? sup.objetivos_cargo.map(String) : [];
    if (!aCargo.length) return res.json({ pedidos: [], sin_asignar: true });
    // Select con comodines: columnas como entrega_completa o comprado pueden
    // no existir todavía (SQLs opcionales) y nombrarlas rompería el select.
    const { data, error } = await supabase.from('pedidos_insumos')
      .select('*, objetivos(nombre), capataces(nombre), pedidos_insumos_items(*)')
      .in('objetivo_id', aCargo)
      .order('created_at', { ascending: false })
      .limit(60);
    if (error) throw error;
    res.json({ pedidos: data || [] });
  } catch (err) {
    console.error('supervisor insumos:', err.message);
    res.status(500).json({ error: 'Error cargando insumos' });
  }
});

router.get('/api/app/supervisor/objetivos', authApp(['supervisor', 'panol', 'mecanico']), async (req, res) => {
  try {
    const { data } = await supabase.from('objetivos').select('id, nombre').eq('activo', true).order('nombre');
    res.json(data || []);
  } catch (err) {
    res.json([]);
  }
});

// ══ TRAZABILIDAD DE MAQUINARIA ═══════════════════════════════
// Los supervisores (los autorizados a mover máquinas entre objetivos y del
// taller a un objetivo) marcan EGRESO e INGRESO desde la app. Una fila por
// VIAJE en movimientos_unidades: el egreso la abre 'en_transito', el ingreso
// la cierra 'recibida'. La ubicación de cada máquina se deriva del último
// viaje cerrado, y las que salieron y no llegaron quedan visibles.
// Mecánicos y pañol también pueden marcar (el auxiliar logístico suele ser
// el que va a buscar las máquinas), por eso los tres roles.
const ROLES_MOV = ['supervisor', 'panol', 'mecanico'];
const rotuloUnidad = u => [u.codigo, u.patente, u.marca_modelo].filter(Boolean).join(' · ') || ('Unidad ' + u.id);

// Resuelve la máquina por lo que el supervisor ESCRIBIÓ (número interno o
// patente). Nada de listas: en el campo saben el número, no el uuid.
async function resolverUnidad(texto) {
  const t = String(texto || '').trim();
  if (!t) return { error: 'Escribí el número de la máquina.' };
  const norm = x => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const n = norm(t);
  const { data } = await supabase.from('unidades').select('id, codigo, patente, marca_modelo');
  const todas = data || [];
  const exactas = todas.filter(u => norm(u.codigo) === n || norm(u.patente) === n);
  if (exactas.length === 1) return { unidad: exactas[0] };
  if (exactas.length > 1) {
    return { error: 'Hay ' + exactas.length + ' máquinas con ese número: ' +
      exactas.map(u => rotuloUnidad(u)).join(', ') + '. Escribí la patente.' };
  }
  // Coincidencia parcial, por si escribió de más o de menos
  const parciales = todas.filter(u => norm(u.codigo) && (norm(u.codigo).includes(n) || n.includes(norm(u.codigo)))
    || (norm(u.patente) && norm(u.patente).includes(n)));
  if (parciales.length === 1) return { unidad: parciales[0] };
  if (parciales.length > 1 && parciales.length <= 6) {
    return { error: 'No sé cuál es. ¿Alguna de estas? ' + parciales.map(u => rotuloUnidad(u)).join(' · ') };
  }
  return { error: 'No encontré la máquina "' + t + '". Fijate el número interno o la patente.' };
}

// Qué ve el supervisor al entrar// Qué ve el supervisor al entrar: lo que tiene en sus objetivos (para dar
// EGRESO), lo que viene en camino (para dar INGRESO) y el historial reciente.
router.get('/api/app/supervisor/maquinaria', authApp(ROLES_MOV), async (req, res) => {
  try {
    const { data: sup } = await supabase.from('mecanicos')
      .select('objetivos_cargo').eq('id', req.app_user.mid).maybeSingle();
    const aCargo = (sup && Array.isArray(sup.objetivos_cargo)) ? sup.objetivos_cargo.map(String) : [];

    const [unidadesR, movsR, objetivosR] = await Promise.all([
      supabase.from('unidades').select('id, codigo, patente, marca_modelo, tipo_activo').order('codigo'),
      supabase.from('movimientos_unidades')
        .select('*, unidades(id, codigo, patente, marca_modelo)')
        .neq('estado', 'anulado').order('salida_at', { ascending: false }).limit(400),
      supabase.from('objetivos').select('id, nombre').eq('activo', true).order('nombre'),
    ]);
    if (movsR.error) throw movsR.error;
    const unidades = unidadesR.data || [];
    const movs = movsR.data || [];
    const objetivos = objetivosR.data || [];
    // IDs SIEMPRE como string: en esta base unidades.id y objetivos.id son
    // uuid, así que cualquier Number() los volvía NaN.
    const nombreObj = new Map(objetivos.map(o => [String(o.id), o.nombre]));
    const lugar = (tipo, oid) => tipo === 'taller' ? 'Taller' : (nombreObj.get(String(oid)) || 'Objetivo');

    // Último movimiento por unidad → ubicación actual
    const ultimo = new Map();
    for (const m of movs) if (!ultimo.has(m.unidad_id)) ultimo.set(m.unidad_id, m);

    const aca = [], enCamino = [], otras = [];
    for (const u of unidades) {
      const m = ultimo.get(u.id) || null;
      const item = {
        unidad_id: u.id, rotulo: rotuloUnidad(u), tipo_activo: u.tipo_activo || null,
        movimiento_id: m ? m.id : null,
        situacion: !m ? 'sin_registrar' : (m.estado === 'en_transito' ? 'en_transito' : 'ubicada'),
        donde: m ? (m.estado === 'en_transito' ? lugar(m.origen_tipo, m.origen_objetivo_id) : lugar(m.destino_tipo, m.destino_objetivo_id)) : null,
        hacia: m && m.estado === 'en_transito' ? lugar(m.destino_tipo, m.destino_objetivo_id) : null,
        destino_objetivo_id: m ? m.destino_objetivo_id : null,
        destino_tipo: m ? m.destino_tipo : null,
        estado_maquina: m ? (m.llegada_estado || m.salida_estado) : null,
        retira: m ? m.retira : null,
        salida_at: m ? m.salida_at : null,
        desde: m ? (m.llegada_at || m.salida_at) : null,
      };
      const destinoMio = m && m.destino_tipo === 'objetivo' && aCargo.includes(String(m.destino_objetivo_id));
      if (item.situacion === 'en_transito' && destinoMio) enCamino.push(item);
      else if (item.situacion === 'ubicada' && destinoMio) aca.push(item);
      else otras.push(item);
    }
    // Las que están en tránsito hacia cualquier lado también se pueden recibir
    // (si la máquina va a un objetivo que no es el mío, igual la veo en "otras").
    res.json({
      a_cargo: aCargo.length ? aCargo : null,
      aca, en_camino: enCamino, otras,
      objetivos,
      historial: movs.slice(0, 40).map(m => ({
        id: m.id, unidad: m.unidades ? rotuloUnidad(m.unidades) : ('Unidad ' + m.unidad_id),
        desde: lugar(m.origen_tipo, m.origen_objetivo_id), hasta: lugar(m.destino_tipo, m.destino_objetivo_id),
        salida_at: m.salida_at, salida_por: m.salida_por, llegada_at: m.llegada_at, llegada_por: m.llegada_por,
        estado: m.estado, retira: m.retira,
        estado_maquina: m.llegada_estado || m.salida_estado,
        obs: [m.salida_obs, m.llegada_obs].filter(Boolean).join(' · ') || null,
      })),
    });
  } catch (err) {
    console.error('app maquinaria:', err.message);
    res.status(500).json({ error: (/movimientos_unidades/.test(err.message || '')
      ? 'Falta correr movimientos_maquinaria.sql en Supabase.' : 'Error cargando la maquinaria') });
  }
});

// EGRESO: la máquina sale de donde está hacia un destino. Abre el viaje.
// La máquina se ESCRIBE (número interno o patente) y el destino es UN SOLO
// selector con todos los lugares: los objetivos ya incluyen Taller, Taller
// Insumos y Depósito, así que no hace falta un "tipo" aparte.
router.post('/api/app/supervisor/maquinaria/egreso', authApp(ROLES_MOV), async (req, res) => {
  try {
    const b = req.body || {};
    const r = await resolverUnidad(b.maquina || b.unidad_id);
    if (r.error) return res.status(400).json({ error: r.error });
    const unidadId = r.unidad.id;
    const destinoObj = String(b.destino_objetivo_id || '').trim() || null;
    if (!destinoObj) return res.status(400).json({ error: 'Elegí a dónde va la máquina.' });

    // ¿Ya está en viaje? El índice único lo impide igual, pero el mensaje
    // claro vale más que un error de Postgres.
    const { data: abierto } = await supabase.from('movimientos_unidades')
      .select('id, salida_at, salida_por').eq('unidad_id', unidadId).eq('estado', 'en_transito').maybeSingle();
    if (abierto) return res.status(409).json({
      error: rotuloUnidad(r.unidad) + ' ya figura en viaje (la sacó ' + (abierto.salida_por || 'alguien') +
        '). Primero marcá que llegó a donde está.' });

    // De dónde sale: el destino del último viaje cerrado
    const { data: prev } = await supabase.from('movimientos_unidades')
      .select('destino_objetivo_id').eq('unidad_id', unidadId).eq('estado', 'recibida')
      .order('salida_at', { ascending: false }).limit(1).maybeSingle();

    const { data, error } = await supabase.from('movimientos_unidades').insert({
      unidad_id: unidadId,
      origen_tipo: 'objetivo', origen_objetivo_id: prev ? prev.destino_objetivo_id : null,
      destino_tipo: 'objetivo', destino_objetivo_id: destinoObj,
      retira: String(b.retira || '').trim() || null,
      salida_por: req.app_user.nombre, salida_rol: req.app_user.rol,
      salida_estado: b.estado === 'con_falla' ? 'con_falla' : 'anda',
      salida_obs: String(b.observaciones || '').trim() || null,
      estado: 'en_transito',
    }).select('id').single();
    if (error) throw error;
    console.log('[maquinaria] EGRESO ' + rotuloUnidad(r.unidad) + ' por ' + (req.app_user.nombre || '?'));
    res.json({ ok: true, id: data.id, maquina: rotuloUnidad(r.unidad) });
  } catch (err) {
    console.error('app maquinaria egreso:', err.message);
    res.status(500).json({ error: (/movimientos_unidades/.test(err.message || '')
      ? 'Falta correr movimientos_maquinaria.sql en Supabase.' : (err.message || 'No pude registrar la salida')) });
  }
});

// INGRESO: la máquina llegó. Cierra el viaje abierto; si nadie marcó la
// salida, igual registra dónde está (una fila ya cerrada), así la ubicación
// nunca queda vieja por culpa de un olvido.
router.post('/api/app/supervisor/maquinaria/ingreso', authApp(ROLES_MOV), async (req, res) => {
  try {
    const b = req.body || {};
    const r = await resolverUnidad(b.maquina || b.unidad_id);
    if (r.error) return res.status(400).json({ error: r.error });
    const unidadId = r.unidad.id;
    const destinoObj = String(b.destino_objetivo_id || '').trim() || null;
    if (!destinoObj) return res.status(400).json({ error: 'Elegí dónde está ahora la máquina.' });
    const ahora = new Date().toISOString();
    const llegada = {
      destino_tipo: 'objetivo', destino_objetivo_id: destinoObj,   // manda dónde llegó DE VERDAD
      llegada_at: ahora, llegada_por: req.app_user.nombre, llegada_rol: req.app_user.rol,
      llegada_estado: b.estado === 'con_falla' ? 'con_falla' : 'anda',
      llegada_obs: String(b.observaciones || '').trim() || null,
      estado: 'recibida',
    };
    const { data: abierto } = await supabase.from('movimientos_unidades')
      .select('id').eq('unidad_id', unidadId).eq('estado', 'en_transito').maybeSingle();
    if (abierto) {
      const { error } = await supabase.from('movimientos_unidades').update(llegada).eq('id', abierto.id);
      if (error) throw error;
      console.log('[maquinaria] INGRESO ' + rotuloUnidad(r.unidad) + ' (cierra viaje) por ' + (req.app_user.nombre || '?'));
      return res.json({ ok: true, id: abierto.id, cerro_viaje: true, maquina: rotuloUnidad(r.unidad) });
    }
    const { data: prev } = await supabase.from('movimientos_unidades')
      .select('destino_objetivo_id').eq('unidad_id', unidadId).eq('estado', 'recibida')
      .order('salida_at', { ascending: false }).limit(1).maybeSingle();
    const { data, error } = await supabase.from('movimientos_unidades').insert({
      unidad_id: unidadId,
      origen_tipo: 'objetivo', origen_objetivo_id: prev ? prev.destino_objetivo_id : null,
      salida_at: ahora, salida_por: req.app_user.nombre, salida_rol: req.app_user.rol,
      salida_estado: llegada.llegada_estado,
      salida_obs: 'Llegada registrada sin egreso previo',
      ...llegada,
    }).select('id').single();
    if (error) throw error;
    console.log('[maquinaria] INGRESO ' + rotuloUnidad(r.unidad) + ' (sin egreso previo) por ' + (req.app_user.nombre || '?'));
    res.json({ ok: true, id: data.id, alta: true, maquina: rotuloUnidad(r.unidad) });
  } catch (err) {
    console.error('app maquinaria ingreso:', err.message);
    res.status(500).json({ error: err.message || 'No pude registrar la llegada' });
  }
});

// ══ CARGA DE COMBUSTIBLE · CAPATACES ═════════════════════════
// Igual que supervisor pero SIMPLE: todo va a SU objetivo y SU unidad
// (automáticos del login). El capataz solo reparte cuántos litros a la
// unidad y cuántos a bidones — sin elegir objetivo.

// Leer el remito (idéntico al del supervisor)
router.post('/api/app/capataz/combustible/leer', authApp('capataz'), async (req, res) => {
  try {
    const { fileData, fileType } = req.body || {};
    if (!fileData) return res.status(400).json({ error: 'Falta la foto del remito' });
    const { extraerComprobante } = require('./extraccion');
    const buffer = Buffer.from(fileData, 'base64');
    const datos = await extraerComprobante(buffer, fileType || 'image/jpeg');
    const norm = s => String(s || '').toUpperCase();
    const tipos = { gasoil: 0, super: 0 };
    (datos.items || []).forEach(it => {
      const p = norm(it.producto), l = Number(it.litros) || 0;
      if (/SUPER|NAFTA/.test(p) && !/DIESEL|GASOIL/.test(p)) tipos.super += l;
      else tipos.gasoil += l;
    });
    res.json({
      ok: true, proveedor: datos.proveedor || null, cuit: datos.cuit || null,
      numero: datos.numero || null, fecha: datos.fecha || null, tipo_doc: datos.tipo_doc || 'remito',
      litros: { gasoil: Math.round(tipos.gasoil * 100) / 100, super: Math.round(tipos.super * 100) / 100 },
      items_raw: datos.items || [],
      // El capataz ve a dónde va (su objetivo y unidad), no los elige
      objetivo_nombre: req.app_user.objetivo_nombre || null,
      patente: req.app_user.patente || null,
    });
  } catch (err) {
    console.error('capataz combustible leer:', err);
    res.json({ __error: 'No pude leer el remito. Sacá la foto más derecha y con buena luz, o cargá los litros a mano.' });
  }
});

// Guardar: objetivo y unidad salen del token del capataz
router.post('/api/app/capataz/combustible', authApp('capataz'), async (req, res) => {
  try {
    const d = req.body || {};
    const repartos = Array.isArray(d.repartos) ? d.repartos.filter(r => Number(r.litros) > 0) : [];
    if (!repartos.length) return res.status(400).json({ error: 'No hay litros para cargar' });

    const objetivoId = req.app_user.objetivo_id || null;
    const objetivoNom = req.app_user.objetivo_nombre || null;
    const unidadId = req.app_user.unidad_id || null;

    let proveedorId = null;
    if (d.proveedor) {
      const { data: prov } = await supabase.from('proveedores')
        .select('id').ilike('nombre', d.proveedor.trim()).limit(1).maybeSingle();
      if (prov) proveedorId = prov.id;
    }

    const litrosTotal = repartos.reduce((s, r) => s + Number(r.litros), 0);
    const dests = repartos.map(r => r.destino === 'bidon' ? 'bidon' : 'unidad');
    const destinoCarga = dests.every(x => x === 'unidad') ? 'unidad'
                       : dests.every(x => x === 'bidon') ? 'bidon' : 'mixto';
    const resumenTxt = repartos.map(r => `${r.litros}lt ${r.tipo} ${r.destino === 'bidon' ? '→ bidón' : '→ unidad'}`).join(' · ');

    const { data: carga, error } = await supabase.from('cargas_combustible').insert({
      origen: 'remito_capataz',
      tipo_doc: d.tipo_doc || 'remito',
      estado: 'sin_facturar',
      destino: destinoCarga,
      objetivo_id: objetivoId,
      capataz_id: req.app_user.cid || null,
      unidad_id: unidadId,
      proveedor_id: proveedorId,
      fecha: fechaValida(d.fecha),
      numero_remito: d.numero || null,
      // La patente sale de la ficha; si el capataz no tiene camión fijo, de lo
      // que escribió en el renglón de la máquina.
      patente_raw: req.app_user.patente || repartos.find(r => r.patente)?.patente || null,
      litros_total: litrosTotal,
      datos_ia: d.datos_ia || null,
      respuesta_capataz: `Cargado por capataz: ${req.app_user.nombre || '—'} · ${resumenTxt}`,
    }).select('id').single();
    if (error || !carga) throw (error || new Error('no se creó la carga'));
    console.log('[combustible app] carga ' + carga.id + ' · capataz ' + (req.app_user.nombre || '?') +
      ' · fecha ' + fechaValida(d.fecha) + ' · objetivo ' + (objetivoId || 'NINGUNO') +
      ' · unidad ' + (unidadId || 'ninguna') + ' · ' + litrosTotal + ' lt');

    const items = repartos.map(r => ({
      carga_id: carga.id,
      producto: r.tipo === 'super' ? 'SUPER' : 'GASOIL',
      es_combustible: true,
      litros: Number(r.litros),
      destino: r.destino === 'bidon' ? 'bidon' : 'unidad',
      // Los bidones del capataz caen a SU objetivo; la unidad al tanque
      objetivo_id: r.destino === 'bidon' ? objetivoId : null,
      unidad_id: r.destino === 'bidon' ? null : unidadId,
      destino_detalle: r.destino === 'bidon' ? objetivoNom : null,
    }));
    await supabase.from('cargas_combustible_items').insert(items);
    res.json({ ok: true, id: carga.id });
  } catch (err) {
    console.error('capataz combustible guardar:', err);
    res.status(500).json({ error: 'Error guardando la carga: ' + (err.message || err.details || 'desconocido') });
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
