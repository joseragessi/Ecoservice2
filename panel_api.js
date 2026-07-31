const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const supabase = require('./supabase');
const supabaseCompras = require('./supabase_compras');
const { notificarCapataz, notificarCapatazTemplate, mensajeEstadoIncidencia } = require('./notificar');
const { hashClave } = require('./app_api');
const control = require('./control');
const seg = require('./seguridad');

const router = express.Router();

// ── Auth: token firmado con HMAC (sin dependencias externas) ──
// SECRET de los tokens: SIEMPRE desde la env var. Si falta, se genera uno
// aleatorio por arranque (los tokens caducan en cada redeploy, molesto pero
// seguro) — jamás un default fijo que cualquiera pueda leer en el repo.
const SECRET = process.env.PANEL_SECRET ||
  (console.warn('[seguridad] PANEL_SECRET no seteada: usando secret aleatorio (las sesiones caen en cada redeploy)'),
   crypto.randomBytes(32).toString('hex'));

/** PANEL_USERS = "jose:clave123,owen:clave456" (fallback de emergencia: admin total) */
function usuarios() {
  const raw = process.env.PANEL_USERS || '';
  const map = {};
  raw.split(',').forEach(par => {
    const i = par.indexOf(':');
    if (i > 0) map[par.slice(0, i).trim()] = par.slice(i + 1);
  });
  return map;
}

// ── Permisos por módulo ───────────────────────────────────────
// Cada usuario del panel tiene una lista de módulos habilitados. El admin ve
// todo. Los usuarios de PANEL_USERS (env) son admin siempre — así José nunca
// puede quedar afuera aunque la tabla se rompa.
const MODULOS_PANEL = ['dashboard','facturas','insumos','combustible','compras','reparaciones','stock','maestros'];
function moduloDeRuta(p) {
  if (p.startsWith('/api/dashboard'))     return 'dashboard';
  if (p.startsWith('/api/facturas'))      return 'facturas';
  if (p.startsWith('/api/insumos'))       return 'insumos';
  if (p.startsWith('/api/combustible'))   return 'combustible';
  if (p.startsWith('/api/viajes'))        return 'bateas';
  if (p.startsWith('/api/compras'))       return 'compras';
  if (p.startsWith('/api/reparaciones') || p.startsWith('/api/services')) return 'reparaciones';
  if (p.startsWith('/api/stock'))         return 'stock';
  if (p.startsWith('/api/maestros') || p.startsWith('/api/mecanicos') ||
      p.startsWith('/api/objetivos') || p.startsWith('/api/usuarios')) return 'maestros';
  return null;   // rutas generales: alcanza con estar logueado
}

function firmar(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verificar(token) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const esperado = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig !== esperado) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const payload = verificar(token);
  if (!payload) return res.status(401).json({ error: 'No autorizado' });
  // Kill switch: con el PIN vencido, ningún módulo del panel opera. Se responde
  // 423 (Locked) para que el front muestre la pantalla de bloqueo.
  if (!(await control.estaOperativo())) {
    return res.status(423).json({ error: 'Sistema bloqueado: PIN vencido. Renová SYSTEM_PIN en Railway.', bloqueado: true });
  }
  // Permisos por módulo: admin ve todo; tokens viejos (sin mods) se tratan como
  // admin por compatibilidad (eran los usuarios de PANEL_USERS).
  const mods = Array.isArray(payload.mods) ? payload.mods : null;
  const esAdmin = payload.admin === true || mods === null;
  const modulo = moduloDeRuta(req.path);
  if (modulo && !esAdmin && !mods.includes(modulo)) {
    return res.status(403).json({ error: 'No tenés acceso a este módulo' });
  }
  req.usuario = payload.usuario;
  req.esAdmin = esAdmin;
  next();
}

// Estado del kill switch (público, sin auth): el panel lo consulta para mostrar
// la pantalla de bloqueo o el aviso de vencimiento próximo.
router.get('/api/control/estado', async (req, res) => {
  try {
    const st = await control.estado();
    res.json(st);
  } catch (e) {
    res.json({ activo: false, bloqueado: false });   // fail-open
  }
});

// ── Login ─────────────────────────────────────────────────────
router.post('/api/login', async (req, res) => {
  // Kill switch: con el PIN vencido no se puede ni entrar (vos ves la pantalla
  // de bloqueo que te dice qué hacer).
  if (!(await control.estaOperativo())) {
    return res.status(423).json({ error: 'Sistema bloqueado: PIN vencido. Renová SYSTEM_PIN en Railway.', bloqueado: true });
  }
  const { usuario, clave } = req.body || {};
  if (!usuario || !clave) return res.status(401).json({ error: 'Usuario o clave incorrectos' });
  // Anti fuerza bruta: 5 intentos fallidos por IP+usuario → 15 min bloqueado
  if (seg.loginBloqueado(req, usuario)) {
    return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos y probá de nuevo.' });
  }
  const exp = Date.now() + 12 * 60 * 60 * 1000;   // 12h

  // 1) Usuarios de la tabla (dados de alta desde Maestros → Usuarios)
  try {
    const { data: u } = await supabase.from('usuarios_panel')
      .select('*').eq('usuario', String(usuario).trim()).maybeSingle();
    if (u && u.activo && verificarClavePanel(clave, u.clave_hash)) {
      seg.loginOk(req, usuario);
      const mods = Array.isArray(u.modulos) ? u.modulos.filter(m => MODULOS_PANEL.includes(m)) : [];
      const token = firmar({ usuario: u.usuario, nombre: u.nombre, admin: !!u.admin, mods, exp });
      return res.json({ token, usuario: u.usuario, nombre: u.nombre, admin: !!u.admin, modulos: u.admin ? MODULOS_PANEL : mods });
    }
  } catch (e) { /* tabla puede no existir aún: cae al fallback */ }

  // 2) Fallback: PANEL_USERS (env) = admin total. Nunca depende de la DB.
  const users = usuarios();
  if (users[usuario] === clave) {
    seg.loginOk(req, usuario);
    const token = firmar({ usuario, admin: true, mods: MODULOS_PANEL, exp });
    return res.json({ token, usuario, admin: true, modulos: MODULOS_PANEL });
  }
  seg.loginFallido(req, usuario);
  res.status(401).json({ error: 'Usuario o clave incorrectos' });
});

// ── Usuarios del panel (solo admin) ───────────────────────────
function hashClavePanel(clave) {
  const salt = crypto.randomBytes(8).toString('hex');
  const h = crypto.createHmac('sha256', salt).update(String(clave)).digest('hex');
  return `${salt}$${h}`;
}
function verificarClavePanel(clave, guardado) {
  if (!guardado || !guardado.includes('$')) return false;
  const [salt, h] = guardado.split('$');
  const calc = crypto.createHmac('sha256', salt).update(String(clave)).digest('hex');
  return calc === h;
}
function soloAdmin(req, res, next) {
  if (!req.esAdmin) return res.status(403).json({ error: 'Solo el administrador puede gestionar usuarios' });
  next();
}
router.get('/api/usuarios', auth, soloAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('usuarios_panel')
      .select('id, usuario, nombre, modulos, admin, activo, created_at')
      .order('usuario');
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: 'Error cargando usuarios (¿existe la tabla usuarios_panel?)' }); }
});
router.post('/api/usuarios', auth, soloAdmin, async (req, res) => {
  try {
    const { id, usuario, nombre, clave, modulos, admin, activo } = req.body || {};
    if (!usuario || !String(usuario).trim()) return res.status(400).json({ error: 'Falta el usuario' });
    const fila = {
      usuario: String(usuario).trim().toLowerCase(),
      nombre: nombre || null,
      modulos: (Array.isArray(modulos) ? modulos : []).filter(m => MODULOS_PANEL.includes(m)),
      admin: !!admin,
      activo: activo !== false,
    };
    if (clave) fila.clave_hash = hashClavePanel(clave);
    let q;
    if (id) q = supabase.from('usuarios_panel').update(fila).eq('id', id).select().single();
    else {
      if (!clave) return res.status(400).json({ error: 'Falta la clave para el usuario nuevo' });
      q = supabase.from('usuarios_panel').insert(fila).select().single();
    }
    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, id: data.id });
  } catch (err) {
    console.error('usuarios save:', err);
    res.status(500).json({ error: err.message && err.message.includes('duplicate') ? 'Ya existe un usuario con ese nombre' : 'Error guardando usuario' });
  }
});

// ── Dashboard ─────────────────────────────────────────────────
router.get('/api/dashboard', auth, async (req, res) => {
  try {
    const periodo = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Cordoba' }).slice(0, 7);
    const mesAnterior = (() => {
      const [a, m] = periodo.split('-').map(Number);
      const d = new Date(a, m - 2, 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    })();

    const [fact, ins, carg, reps, censos, objs, invFact] = await Promise.all([
      supabase.from('facturas_proveedor').select('estado, total'),
      supabase.from('pedidos_insumos').select('estado, created_at, objetivos(nombre), capataces(nombre), pedidos_insumos_items(item)'),
      supabase.from('cargas_combustible').select('estado, litros_total, fecha').neq('estado', 'anulada'),
      supabase.from('incidencias').select('estado, prioridad, created_at, fecha_finalizado, equipo_parado, tipo_equipo, tipo_falla, numero_unidad, mecanicos(nombre), equipos(nombre,tipo), objetivos(nombre)'),
      supabase.from('censos_stock').select('periodo, estado').eq('periodo', periodo),
      supabase.from('objetivos').select('id').eq('activo', true).eq('tipo', 'operativo'),
      supabaseCompras.from('facturas').select('*'),
    ]);

    const facturas = fact.data || [], insumos = ins.data || [], cargas = carg.data || [];
    const incid = reps.data || [], cens = censos.data || [];
    // Las facturas de compras guardan los totales dentro del JSON `data`
    const compras = (invFact.data || []).map(aplanar);
    const cuenta = (a, c, v) => a.filter(x => x[c] === v).length;
    const suma = (a, c) => a.reduce((s, x) => s + (Number(x[c]) || 0), 0);
    const mesDe = iso => String(iso || '').slice(0, 7);

    // ── Compras: gasto del mes vs el anterior
    const mesFac = f => {
      const s = String(f.fecha_factura || '').trim();
      let m = s.match(/^(\d{4})-(\d{2})/); if (m) return m[1] + '-' + m[2];
      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return m[3] + '-' + String(m[2]).padStart(2, '0');
      return '';
    };
    const otrosPag = f => (f.otros_conceptos || []).reduce((s, o) => s + (o.exento ? 0 : (Number(o.monto) || 0)), 0);
    const totalFac = f => (Number(f.total_sin_iva) || 0) + (Number(f.total_iva) || 0) + otrosPag(f)
      - (f.notas_credito || []).reduce((s, n) => s + (Number(n.total_sin_iva) || 0) + (Number(n.total_iva) || 0), 0);
    const gastoMes = compras.filter(f => mesFac(f) === periodo).reduce((s, f) => s + totalFac(f), 0);
    const gastoAnt = compras.filter(f => mesFac(f) === mesAnterior).reduce((s, f) => s + totalFac(f), 0);

    // ── Pendiente de pago (Estado de cuenta): facturas sin marcar pagada
    const sinPagar = compras.filter(f => !f.pagada);
    const pendPago = {
      total: sinPagar.reduce((s, f) => s + totalFac(f), 0),
      facturas: sinPagar.length,
      proveedores: new Set(sinPagar.map(f => f.proveedor || 'Sin nombre')).size,
    };

    // ── Evolución del gasto: últimos 6 meses (incluye el actual)
    const meses6 = [];
    { const [a, m] = periodo.split('-').map(Number);
      for (let i = 5; i >= 0; i--) {
        const d = new Date(a, m - 1 - i, 1);
        meses6.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
      } }
    const evolucion = meses6.map(mes => ({
      mes, total: compras.filter(f => mesFac(f) === mes).reduce((s, f) => s + totalFac(f), 0),
    }));

    // ── Gasto por objetivo del mes: reparte el total de cada factura según su
    // imputación (por ítem o total), proporcional al monto de los ítems, así la
    // suma de objetivos = gasto del mes. Sin imputación → "Sin asignar".
    const porObj = {};
    compras.filter(f => mesFac(f) === periodo).forEach(f => {
      const tot = totalFac(f);
      if (!tot) return;
      const items = f.items || [];
      const montoIt = it => (Number(it.monto_sin_iva) || 0) + (Number(it.monto_iva) || 0);
      const objTotal = (f.totalAssign && f.totalAssign.objetivo) || null;
      if (f.assignmentMode === 'per-item' && f.assignments && items.length) {
        const sumIt = items.reduce((s, it) => s + montoIt(it), 0) || 1;
        items.forEach((it, ix) => {
          const asg = f.assignments[ix] || {};
          const k = asg.objetivo || objTotal || 'Sin asignar';
          porObj[k] = (porObj[k] || 0) + tot * (montoIt(it) / sumIt);
        });
      } else {
        const k = objTotal || 'Sin asignar';
        porObj[k] = (porObj[k] || 0) + tot;
      }
    });
    const objetivosGasto = Object.entries(porObj).map(([nombre, total]) => ({ nombre, total }))
      .sort((a, b) => b.total - a.total);
    const sinAsignar = porObj['Sin asignar'] || 0;

    // ── Combustible del mes
    const cargasMes = cargas.filter(c => mesDe(c.fecha) === periodo);

    // ── Taller
    const activas = incid.filter(i => i.estado !== 'finalizado');
    const criticas = activas.filter(i => i.prioridad === 'critico' || i.prioridad === 'alta');
    const finMes = incid.filter(i => i.estado === 'finalizado' && mesDe(i.fecha_finalizado) === periodo);
    const dias = (a, b) => { if (!a || !b) return null; const d = (new Date(b) - new Date(a)) / 86400000; return d >= 0 ? d : null; };
    const tiempos = incid.filter(i => i.estado === 'finalizado')
      .map(i => dias(i.created_at, i.fecha_finalizado)).filter(t => t != null);
    const resolProm = tiempos.length ? tiempos.reduce((s, t) => s + t, 0) / tiempos.length : null;
    const porMec = {};
    activas.forEach(i => {
      const k = i.mecanicos ? i.mecanicos.nombre : 'Sin asignar';
      porMec[k] = (porMec[k] || 0) + 1;
    });
    const carga = Object.entries(porMec).map(([nombre, valor]) => ({ nombre, valor }))
      .sort((a, b) => b.valor - a.valor);
    // La más vieja sin resolver: la que más urge
    const masVieja = activas.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0] || null;

    // ── Semáforo por prioridad + máquinas paradas ahora
    const porPrio = { critico: 0, alta: 0, media: 0, baja: 0 };
    activas.forEach(i => { if (porPrio[i.prioridad] != null) porPrio[i.prioridad]++; });
    const esUnidad = i => /toyota|camioneta|cami[oó]n|atego|unidad/i.test(String(i.tipo_equipo || (i.equipos && i.equipos.tipo) || ''));
    const paradas = activas.filter(i => i.equipo_parado)
      .map(i => ({
        equipo: [i.tipo_equipo || (i.equipos && (i.equipos.nombre || i.equipos.tipo)) || 'Equipo',
                 i.numero_unidad ? 'N° ' + i.numero_unidad : ''].filter(Boolean).join(' '),
        falla: i.tipo_falla || '',
        objetivo: i.objetivos ? i.objetivos.nombre : '',
        prioridad: i.prioridad,
        unidad: esUnidad(i),
        dias: Math.floor((Date.now() - new Date(i.created_at)) / 86400000),
      }))
      .sort((a, b) => b.dias - a.dias);

    // ── Stock: censo del período
    const censoResp = cuenta(cens, 'estado', 'respondido');
    const censoPend = cens.length - censoResp;

    // ── Insumos pendientes (para la lista de acción)
    const insPend = insumos.filter(p => p.estado === 'pendiente' || p.estado === 'en_compra');

    res.json({
      periodo,
      // Lo que requiere acción, en orden de urgencia
      acciones: {
        facturas_pendientes: cuenta(facturas, 'estado', 'pendiente'),
        insumos_pendientes:  insPend.length,
        reparaciones_urgentes: criticas.length,
        combustible_sin_facturar: cuenta(cargas, 'estado', 'sin_facturar'),
        stock_sin_responder: censoPend,
      },
      compras: {
        gasto_mes: gastoMes,
        gasto_anterior: gastoAnt,
        var_pct: gastoAnt ? ((gastoMes - gastoAnt) * 100 / gastoAnt) : null,
        facturas_total: compras.length,
        por_imputar: suma(facturas.filter(f => f.estado === 'pendiente'), 'total'),
        pendiente_pago: pendPago,
        evolucion,
        objetivos_gasto: objetivosGasto,
        sin_asignar: sinAsignar,
      },
      combustible: {
        cargas_mes: cargasMes.length,
        litros_mes: suma(cargasMes, 'litros_total'),
        sin_facturar: cuenta(cargas, 'estado', 'sin_facturar'),
      },
      taller: {
        activas: activas.length,
        criticas: criticas.length,
        finalizadas_mes: finMes.length,
        resolucion_prom: resolProm,
        carga_mecanicos: carga,
        por_prioridad: porPrio,
        paradas,
        mas_vieja: masVieja ? {
          equipo: masVieja.equipos ? (masVieja.equipos.nombre || masVieja.equipos.tipo) : 'Equipo',
          objetivo: masVieja.objetivos ? masVieja.objetivos.nombre : '—',
          prioridad: masVieja.prioridad,
          dias: Math.floor((Date.now() - new Date(masVieja.created_at)) / 86400000),
        } : null,
      },
      stock: {
        total: cens.length,
        respondieron: censoResp,
        pendientes: censoPend,
        objetivos_operativos: (objs.data || []).length,
      },
      insumos_lista: insPend.slice(0, 5).map(p => ({
        objetivo: p.objetivos ? p.objetivos.nombre : '—',
        capataz: p.capataces ? p.capataces.nombre : '—',
        items: (p.pedidos_insumos_items || []).map(i => i.item).join(', '),
        dias: Math.floor((Date.now() - new Date(p.created_at)) / 86400000),
      })),
      // Compatibilidad con el contador del sidebar
      facturas: { pendientes: cuenta(facturas, 'estado', 'pendiente') },
      insumos: { pendientes: insPend.length, en_compra: 0 },
    });
  } catch (err) {
    console.error('dashboard:', err);
    res.status(500).json({ error: 'Error cargando el dashboard' });
  }
});

// ── Facturas de proveedor ─────────────────────────────────────
router.get('/api/facturas', auth, async (req, res) => {
  try {
    let q = supabase
      .from('facturas_proveedor')
      .select('*, facturas_proveedor_items(*), objetivos(nombre)')
      .order('created_at', { ascending: false });
    if (req.query.estado) q = q.eq('estado', req.query.estado);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('facturas:', err);
    res.status(500).json({ error: 'Error cargando facturas' });
  }
});

router.post('/api/facturas/:id', auth, async (req, res) => {
  try {
    const patch = {};
    for (const k of ['estado', 'objetivo_id', 'categoria']) {
      if (req.body[k] !== undefined) patch[k] = req.body[k] || null;
    }
    const { data, error } = await supabase
      .from('facturas_proveedor').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('factura update:', err);
    res.status(500).json({ error: 'Error actualizando la factura' });
  }
});

// ── Pedidos de insumos ────────────────────────────────────────
router.get('/api/insumos', auth, async (req, res) => {
  try {
    let q = supabase
      .from('pedidos_insumos')
      .select('*, pedidos_insumos_items(*), capataces(nombre), objetivos(nombre)')
      .order('created_at', { ascending: false });
    if (req.query.estado) q = q.eq('estado', req.query.estado);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('insumos:', err);
    res.status(500).json({ error: 'Error cargando insumos' });
  }
});

router.post('/api/insumos/:id', auth, async (req, res) => {
  try {
    // Si el panel manda items, reemplazan a los del pedido (lo que realmente
    // se entrega puede diferir de lo pedido). El pedido original queda en
    // texto_original como respaldo.
    if (Array.isArray(req.body.items)) {
      const limpios = req.body.items
        .map(i => ({ pedido_id: req.params.id,
          item: String(i.item || '').trim(), cantidad: i.cantidad ? String(i.cantidad).trim() : null }))
        .filter(i => i.item);
      const { error: eDel } = await supabase
        .from('pedidos_insumos_items').delete().eq('pedido_id', req.params.id);
      if (eDel) throw eDel;
      if (limpios.length) {
        const { error: eIns } = await supabase.from('pedidos_insumos_items').insert(limpios);
        if (eIns) throw eIns;
      }
    }

    const patch = {};
    if (req.body.estado !== undefined) patch.estado = req.body.estado;
    if (req.body.estado === 'entregado') patch.entregado_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('pedidos_insumos').update(patch).eq('id', req.params.id)
      .select('*, capataces(nombre,telefono), objetivos(nombre), pedidos_insumos_items(*)').single();
    if (error) throw error;

    // Aviso al capataz cuando el pedido se entrega
    let notificado = false;
    if (req.body.estado === 'entregado' && data.capataces && data.capataces.telefono) {
      const obj = data.objetivos ? data.objetivos.nombre : (data.objetivo_texto || '—');
      const items = (data.pedidos_insumos_items || [])
        .map(i => `• ${i.item}${i.cantidad ? ' — ' + i.cantidad : ''}`).join('\n');
      notificado = await notificarCapataz(
        data.capataces.telefono,
        `📦 *Pedido listo para retirar*\n\n` +
        `📍 Objetivo: ${obj}\n` +
        (items ? `\n${items}\n` : '') +
        `\nTu pedido de insumos ya está disponible en depósito. ✅\n\n_EcoService · Depósito_`
      );
    }
    res.json({ ...data, _notificado: notificado });
  } catch (err) {
    console.error('insumo update:', err);
    res.status(500).json({ error: 'Error actualizando el pedido' });
  }
});

// ── Combustible ───────────────────────────────────────────────
router.get('/api/combustible', auth, async (req, res) => {
  try {
    let q = supabase
      .from('cargas_combustible')
      .select('*, cargas_combustible_items(*), proveedores(nombre), unidades(patente), objetivos(nombre), capataces(nombre)')
      .order('fecha', { ascending: false });
    // ?mes=YYYY-MM trae ese mes COMPLETO (sin tope práctico). Sin mes, las
    // últimas 200 — el tope viejo recortaba silenciosamente los análisis.
    const mes = String(req.query.mes || '');
    if (/^\d{4}-\d{2}$/.test(mes)) {
      const [a, m] = mes.split('-').map(Number);
      const desde = `${mes}-01`;
      const hasta = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
      q = q.gte('fecha', desde).lt('fecha', hasta).limit(2000);
    } else {
      q = q.limit(200);
    }
    // Por defecto las anuladas no se muestran (se ven con el filtro "Anulada")
    if (req.query.estado) q = q.eq('estado', req.query.estado);
    else q = q.neq('estado', 'anulada');
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('combustible:', err);
    res.status(500).json({ error: 'Error cargando combustible' });
  }
});

// Anular una carga (ej. remito cargado dos veces). No se borra: queda como
// "anulada" para auditoría y deja de contar en listados y análisis.
router.post('/api/combustible/:id/anular', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('cargas_combustible')
      .update({ estado: 'anulada' }).eq('id', req.params.id).select('id').single();
    if (error) throw error;
    console.log(`[combustible] carga ${req.params.id} anulada por ${req.usuario}`);
    res.json({ ok: true, id: data.id });
  } catch (err) {
    console.error('anular carga:', err);
    res.status(500).json({ error: 'Error anulando la carga' });
  }
});

// Restaurar una carga anulada por error: vuelve a su estado natural
// (facturada si tiene número de factura, si no sin_facturar)
router.post('/api/combustible/:id/restaurar', auth, async (req, res) => {
  try {
    const { data: c } = await supabase.from('cargas_combustible')
      .select('numero_factura').eq('id', req.params.id).single();
    const estado = c && c.numero_factura ? 'facturada' : 'sin_facturar';
    const { error } = await supabase.from('cargas_combustible')
      .update({ estado }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true, estado });
  } catch (err) {
    console.error('restaurar carga:', err);
    res.status(500).json({ error: 'Error restaurando la carga' });
  }
});

// ── Viajes / bateas (roll off) ────────────────────────────────
router.get('/api/viajes', auth, async (req, res) => {
  try {
    let q = supabase.from('viajes_bateas')
      .select('*, capataces(nombre), unidades(patente)')
      .order('fecha', { ascending: false }).limit(300);
    if (req.query.desde) q = q.gte('fecha', req.query.desde);
    if (req.query.hasta) q = q.lte('fecha', req.query.hasta);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('viajes:', err);
    res.status(500).json({ error: 'Error cargando viajes (¿existe la tabla viajes_bateas?)' });
  }
});

router.get('/api/viajes/indicadores', auth, async (req, res) => {
  try {
    const desde = req.query.desde || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const hasta = req.query.hasta || new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase.from('viajes_bateas')
      .select('*, capataces(nombre), unidades(patente)')
      .gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
    if (error) throw error;
    const viajes = data || [];

    const kmTotal = viajes.reduce((s, v) => s + (Number(v.km) || 0), 0);
    const bateasTotal = viajes.reduce((s, v) => s + (Number(v.total_bateas) || 0), 0);
    const puntosTotal = viajes.reduce((s, v) => s + (Number(v.puntos_bajada) || 0), 0);
    const jornadas = viajes.length;
    const M3_POR_BATEA = 14;

    // Días con actividad (fechas distintas) para el promedio de bateas por día
    const diasConViajes = new Set(viajes.map(v => v.fecha)).size;

    // Por chofer
    const porChofer = {};
    viajes.forEach(v => {
      const k = v.capataces ? v.capataces.nombre : 'Sin chofer';
      const o = porChofer[k] || (porChofer[k] = { chofer: k, km: 0, bateas: 0, puntos: 0, jornadas: 0 });
      o.km += Number(v.km) || 0; o.bateas += Number(v.total_bateas) || 0;
      o.puntos += Number(v.puntos_bajada) || 0; o.jornadas++;
    });

    // Bateas por objetivo (suma de todas las paradas)
    const porObjetivo = {};
    viajes.forEach(v => (v.paradas || []).forEach(p => {
      const k = p.objetivo_nombre || 'Sin objetivo';
      porObjetivo[k] = (porObjetivo[k] || 0) + (Number(p.bateas) || 0);
    }));

    res.json({
      periodo: { desde, hasta },
      kpis: {
        km_total: Math.round(kmTotal * 10) / 10,
        puntos_total: puntosTotal,
        m3_total: bateasTotal * M3_POR_BATEA,
        bateas_promedio_dia: diasConViajes ? Math.round((bateasTotal / diasConViajes) * 10) / 10 : 0,
        bateas_total: bateasTotal,
        dias_activos: diasConViajes,
      },
      por_chofer: Object.values(porChofer).map(o => ({
        ...o, km: Math.round(o.km * 10) / 10, m3: o.bateas * M3_POR_BATEA,
      })).sort((a, b) => b.km - a.km),
      por_objetivo: Object.entries(porObjetivo).map(([nombre, bateas]) => ({ nombre, bateas, m3: bateas * M3_POR_BATEA }))
        .sort((a, b) => b.bateas - a.bateas),
    });
  } catch (err) {
    console.error('viajes indicadores:', err);
    res.status(500).json({ error: 'Error calculando indicadores' });
  }
});

router.post('/api/viajes/:id/anular', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('viajes_bateas').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error eliminando el viaje' });
  }
});

// ── Objetivos (para los selectores de imputación) ─────────────
router.get('/api/objetivos', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('objetivos').select('id, nombre').eq('activo', true).order('nombre');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('objetivos:', err);
    res.status(500).json({ error: 'Error cargando objetivos' });
  }
});

// ── Reparaciones (incidencias del taller) ─────────────────────
router.get('/api/reparaciones', auth, async (req, res) => {
  try {
    let q = supabase
      .from('incidencias')
      .select('*, equipos(nombre,tipo,codigo), capataces(nombre), objetivos(nombre), mecanicos(nombre,habilidades), comentarios_incidencias(mecanico_nombre,texto,created_at), repuestos_taller(id,items,nota,estado,created_at)')
      .order('created_at', { ascending: false });
    if (req.query.estado) q = q.eq('estado', req.query.estado);
    if (req.query.prioridad) q = q.eq('prioridad', req.query.prioridad);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('reparaciones:', err);
    res.status(500).json({ error: 'Error cargando reparaciones' });
  }
});

// ── Preventivo (rodados) ──────────────────────────────────────
// Mantenimiento programado por tiempo. Solo rodados: la unidad del maestro
// tiene `tipo_rodado` y cada tipo un intervalo en días (preventivo_config).
// El "último service" sale de services_unidades (planillas) o de la última
// incidencia preventiva finalizada, lo que sea más nuevo.
const ROD_LABEL = { camioneta: 'Camioneta', tractor: 'Tractor', desmalezadora: 'Desmalezadora', mini_tractor: 'Mini tractor', giro_cero: 'Giro cero' };
const normUni = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Las planillas guardan la fecha como texto (dd/mm/aaaa la mayoría). Si no se
// puede leer, se usa la fecha de carga del registro.
function fechaDeService(d, createdAt) {
  const t = String((d && d.fecha_service) || '').trim();
  const m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let a = Number(m[3]); if (a < 100) a += 2000;
    const f = new Date(a, Number(m[2]) - 1, Number(m[1]));
    if (!isNaN(f)) return f;
  }
  if (t) { const f2 = new Date(t); if (!isNaN(f2)) return f2; }
  return createdAt ? new Date(createdAt) : null;
}

router.get('/api/reparaciones/preventivo', auth, async (req, res) => {
  try {
    const [cfgR, uniR, servR, prevR, abiertasR] = await Promise.all([
      supabase.from('preventivo_config').select('*'),
      supabase.from('unidades').select('id, codigo, patente, marca_modelo, responsable, tipo_rodado, prev_pospuesto_hasta, prev_pospuesto_at')
        .eq('activo', true).not('tipo_rodado', 'is', null),
      supabase.from('services_unidades').select('data, created_at'),
      supabase.from('incidencias').select('numero_unidad, fecha_finalizado')
        .eq('tipo_mant', 'preventivo').eq('estado', 'finalizado').not('fecha_finalizado', 'is', null),
      supabase.from('incidencias')
        .select('id, numero_unidad, tipo_equipo, estado, prioridad, created_at, mecanicos(nombre)')
        .eq('tipo_mant', 'preventivo').neq('estado', 'finalizado')
        .order('created_at', { ascending: false }),
    ]);
    const cfg = {};
    (cfgR.data || []).forEach(c => { cfg[c.tipo] = c; });

    // Última fecha conocida por clave (código de unidad o patente, normalizados)
    const ult = {};
    const marcar = (clave, f) => {
      const k = normUni(clave);
      if (!k || !f || isNaN(f)) return;
      if (!ult[k] || f > ult[k]) ult[k] = f;
    };
    (servR.data || []).forEach(s => {
      const f = fechaDeService(s.data, s.created_at);
      marcar(s.data && s.data.unidad, f);
      marcar(s.data && s.data.patente, f);
    });
    (prevR.data || []).forEach(i => marcar(i.numero_unidad, new Date(i.fecha_finalizado)));

    const hoy = Date.now();
    const rodados = (uniR.data || []).map(u => {
      const c = cfg[u.tipo_rodado] || null;
      const intervalo = c && c.activo !== false ? c.intervalo_dias : null;
      const f = ult[normUni(u.codigo)] || ult[normUni(u.patente)] || null;
      const dias = f ? Math.floor((hoy - f.getTime()) / 86400000) : null;

      // Próximo vencimiento: último service + intervalo. Si se reprogramó
      // (y no hubo un service posterior a la reprogramación), manda esa fecha.
      let proximo = (f && intervalo) ? new Date(f.getTime() + intervalo * 86400000) : null;
      let reprogramado = false;
      if (u.prev_pospuesto_hasta) {
        const pAt = u.prev_pospuesto_at ? new Date(u.prev_pospuesto_at) : null;
        const vigente = !f || !pAt || f <= pAt;   // sin service después de posponer
        const ph = new Date(u.prev_pospuesto_hasta);
        if (vigente && !isNaN(ph) && (!proximo || ph > proximo)) { proximo = ph; reprogramado = true; }
      }
      const restan = proximo ? Math.ceil((proximo.getTime() - hoy) / 86400000) : null;

      let estado = 'sin_config';
      if (intervalo) {
        if (restan == null) estado = 'sin_service';
        else estado = restan <= 0 ? 'vencido' : restan <= intervalo * 0.25 ? 'por_vencer' : 'al_dia';
      }
      return {
        id: u.id, tipo: u.tipo_rodado, tipo_label: ROD_LABEL[u.tipo_rodado] || u.tipo_rodado,
        codigo: u.codigo, patente: u.patente, marca_modelo: u.marca_modelo,
        intervalo, ultimo: f ? f.toISOString() : null, dias, restan, reprogramado, estado,
        proximo: proximo ? proximo.toISOString() : null,
        incidencia_abierta: (abiertasR.data || []).find(i =>
          normUni(i.numero_unidad) && (normUni(i.numero_unidad) === normUni(u.codigo) || normUni(i.numero_unidad) === normUni(u.patente))
        ) ? (abiertasR.data || []).find(i =>
          normUni(i.numero_unidad) && (normUni(i.numero_unidad) === normUni(u.codigo) || normUni(i.numero_unidad) === normUni(u.patente))
        ).estado : null,
      };
    });
    res.json({ config: cfgR.data || [], rodados, en_curso: abiertasR.data || [] });
  } catch (err) {
    console.error('preventivo:', err);
    res.status(500).json({ error: 'Error cargando el preventivo' });
  }
});

// Guardar los intervalos por tipo
router.post('/api/reparaciones/preventivo/config', auth, async (req, res) => {
  try {
    const tipos = Array.isArray((req.body || {}).tipos) ? req.body.tipos : [];
    const filas = tipos
      .filter(t => ROD_LABEL[t.tipo] && Number(t.intervalo_dias) > 0)
      .map(t => ({ tipo: t.tipo, intervalo_dias: Math.round(Number(t.intervalo_dias)), activo: true }));
    if (!filas.length) return res.status(400).json({ error: 'Nada válido para guardar' });
    const { error } = await supabase.from('preventivo_config').upsert(filas, { onConflict: 'tipo' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('preventivo config:', err);
    res.status(500).json({ error: 'No pude guardar los intervalos' });
  }
});

// Dar de alta la incidencia preventiva de un rodado desde el panel
router.post('/api/reparaciones/preventivo/alta', auth, async (req, res) => {
  try {
    const unidadId = (req.body || {}).unidad_id;
    if (!unidadId) return res.status(400).json({ error: 'Falta la unidad' });
    const { data: u, error: e0 } = await supabase.from('unidades')
      .select('id, codigo, patente, tipo_rodado').eq('id', unidadId).single();
    if (e0 || !u) return res.status(404).json({ error: 'Unidad inexistente' });
    const { data: inc, error } = await supabase.from('incidencias').insert({
      capataz_id: null, objetivo_id: null, equipo_id: null, mecanico_id: null,
      prioridad: 'baja', estado: 'pendiente', equipo_parado: false,
      descripcion: 'Service preventivo programado',
      numero_unidad: u.codigo || u.patente,
      tipo_equipo: ROD_LABEL[u.tipo_rodado] || u.tipo_rodado || 'Rodado',
      tipo_falla: 'Preventivo',
      tipo_mant: 'preventivo', origen: 'panel',
    }).select('id').single();
    if (error) throw error;
    res.json({ ok: true, id: inc.id });
  } catch (err) {
    console.error('preventivo alta:', err);
    res.status(500).json({ error: 'No pude crear la incidencia: ' + (err.message || 'error') });
  }
});

// Marcar el preventivo como realizado hoy, sin pasar por una incidencia.
// Se registra como una planilla mínima en services_unidades (aparece en el
// historial de Services) y se limpia cualquier reprogramación pendiente.
router.post('/api/reparaciones/preventivo/realizado', auth, async (req, res) => {
  try {
    const unidadId = (req.body || {}).unidad_id;
    if (!unidadId) return res.status(400).json({ error: 'Falta la unidad' });
    const { data: u, error: e0 } = await supabase.from('unidades')
      .select('id, codigo, patente, tipo_rodado').eq('id', unidadId).single();
    if (e0 || !u) return res.status(404).json({ error: 'Unidad inexistente' });
    const hoy = new Date();
    const fecha = String(hoy.getDate()).padStart(2, '0') + '/' +
                  String(hoy.getMonth() + 1).padStart(2, '0') + '/' + hoy.getFullYear();
    const { error: e1 } = await supabase.from('services_unidades').insert({
      data: {
        fecha_service: fecha,
        unidad: u.codigo || null,
        patente: u.patente || null,
        tipo_unidad: ROD_LABEL[u.tipo_rodado] || u.tipo_rodado || null,
        tareas: [],
        observaciones: 'Preventivo marcado como realizado desde el panel',
        mecanico: 'Panel · ' + (req.usuario || ''),
      },
      mecanico_id: null,
      mecanico_nombre: 'Panel · ' + (req.usuario || ''),
    });
    if (e1) throw e1;
    await supabase.from('unidades')
      .update({ prev_pospuesto_hasta: null, prev_pospuesto_at: null }).eq('id', unidadId);
    res.json({ ok: true });
  } catch (err) {
    console.error('preventivo realizado:', err);
    res.status(500).json({ error: 'No pude registrar el service: ' + (err.message || 'error') });
  }
});

// Reprogramar: correr el vencimiento N días desde hoy. Queda anotado cuándo
// se pospuso; un service posterior lo pisa automáticamente.
router.post('/api/reparaciones/preventivo/reprogramar', auth, async (req, res) => {
  try {
    const unidadId = (req.body || {}).unidad_id;
    const dias = Math.round(Number((req.body || {}).dias));
    if (!unidadId) return res.status(400).json({ error: 'Falta la unidad' });
    if (!dias || dias < 1 || dias > 365) return res.status(400).json({ error: 'Los días tienen que ser entre 1 y 365' });
    const hasta = new Date(Date.now() + dias * 86400000).toISOString();
    const { error } = await supabase.from('unidades')
      .update({ prev_pospuesto_hasta: hasta, prev_pospuesto_at: new Date().toISOString() })
      .eq('id', unidadId);
    if (error) throw error;
    res.json({ ok: true, hasta });
  } catch (err) {
    console.error('preventivo reprogramar:', err);
    res.status(500).json({ error: 'No pude reprogramar: ' + (err.message || 'error') });
  }
});

// Alta manual de incidencia desde el panel (correctivo o preventivo),
// espejo del alta de la app pero con mecánico y prioridad a elección.
router.post('/api/reparaciones/nueva', auth, async (req, res) => {
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
      mecanico_id: d.mecanico_id || null,
      prioridad, estado: 'pendiente', equipo_parado: !!d.equipo_parado,
      descripcion, numero_unidad: numeroUnidad, tipo_equipo: tipoEquipo,
      tipo_falla: tipoMant === 'preventivo' ? 'Preventivo' : 'Ingreso taller',
      tipo_mant: tipoMant, origen: 'panel',
    }).select('id').single();
    if (error) throw error;
    res.json({ ok: true, id: inc.id });
  } catch (err) {
    console.error('reparaciones nueva:', err);
    res.status(500).json({ error: 'No pude crear la incidencia: ' + (err.message || 'error') });
  }
});

// ── Repuestos de taller (lo que hay que comprar para reparar) ─
// El pedido nace en la reparación (mecánico desde la app o vos desde el
// panel) y se gestiona en Compras → Repuestos.
router.post('/api/reparaciones/:id/repuestos', auth, async (req, res) => {
  try {
    const items = (Array.isArray((req.body || {}).items) ? req.body.items : [])
      .map(i => ({ descripcion: String(i.descripcion || '').trim(), cantidad: Number(i.cantidad) || 1, codigo: String(i.codigo || '').trim() }))
      .filter(i => i.descripcion);
    if (!items.length) return res.status(400).json({ error: 'Cargá al menos un repuesto' });
    const { data: prev } = await supabase.from('repuestos_taller')
      .select('id, items').eq('incidencia_id', req.params.id).neq('estado', 'entregado').maybeSingle();
    // Si se edita un pedido existente, conservar los tildes de "comprado" que
    // ya haya puesto compras (match por descripción)
    if (prev && Array.isArray(prev.items)) {
      const marcados = {};
      prev.items.forEach(i => { if (i.comprado) marcados[String(i.descripcion || '').toLowerCase()] = true; });
      items.forEach(i => { if (marcados[i.descripcion.toLowerCase()]) i.comprado = true; });
    }
    const fila = { items, nota: String((req.body || {}).nota || '').trim() || null, pedido_por: 'Panel · ' + (req.usuario || 'admin') };
    let q;
    if (prev) q = supabase.from('repuestos_taller').update(fila).eq('id', prev.id).select().single();
    else q = supabase.from('repuestos_taller').insert({ ...fila, incidencia_id: req.params.id }).select().single();
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('rep repuestos:', err);
    res.status(500).json({ error: 'Error guardando el pedido (¿existe la tabla repuestos_taller?)' });
  }
});

// Sugerencia IA de repuestos (misma lógica que en la app del mecánico)
router.post('/api/reparaciones/:id/repuestos/sugerir', auth, async (req, res) => {
  try {
    const { sugerirRepuestos } = require('./repuestos_ia');
    res.json(await sugerirRepuestos(req.params.id));
  } catch (err) {
    console.error('rep repuestos sugerir:', err);
    res.status(500).json({ error: 'No pude armar la sugerencia. Cargalo a mano.' });
  }
});

router.get('/api/compras/repuestos', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('repuestos_taller')
      .select('*, incidencias(id, prioridad, estado, equipo_parado, numero_unidad, tipo_equipo, created_at, equipos(nombre,tipo), objetivos(nombre), mecanicos(nombre))')
      .order('created_at', { ascending: false }).limit(300);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('compras repuestos:', err);
    res.status(500).json({ error: 'Error cargando repuestos (¿existe la tabla repuestos_taller?)' });
  }
});

// Marcar UN ítem como comprado / pendiente (compra parcial). El pedido pasa a
// "comprado" recién cuando todos los ítems están tildados; si falta alguno,
// sigue pendiente en "a_comprar".
router.post('/api/compras/repuestos/:id/item', auth, async (req, res) => {
  try {
    const idx = Number((req.body || {}).index);
    const comprado = !!(req.body || {}).comprado;
    const { data: ped } = await supabase.from('repuestos_taller')
      .select('items, estado').eq('id', req.params.id).single();
    if (!ped) return res.status(404).json({ error: 'Pedido inexistente' });
    const items = Array.isArray(ped.items) ? ped.items : [];
    if (!items[idx]) return res.status(400).json({ error: 'Ítem inválido' });
    items[idx] = { ...items[idx], comprado };
    const todos = items.length && items.every(i => i.comprado);
    const patch = { items, estado: ped.estado === 'entregado' ? 'entregado' : (todos ? 'comprado' : 'a_comprar') };
    if (todos && ped.estado !== 'entregado') patch.comprado_at = new Date().toISOString();
    const { data, error } = await supabase.from('repuestos_taller')
      .update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('repuestos item:', err);
    res.status(500).json({ error: 'Error actualizando el ítem' });
  }
});

router.post('/api/compras/repuestos/:id/estado', auth, async (req, res) => {
  try {
    const estado = String((req.body || {}).estado || '');
    if (!['a_comprar', 'comprado', 'entregado'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const patch = { estado };
    if (estado === 'comprado') {
      // Marcar todo comprado de una: tildar todos los ítems
      const { data: ped } = await supabase.from('repuestos_taller')
        .select('items').eq('id', req.params.id).single();
      if (ped) patch.items = (Array.isArray(ped.items) ? ped.items : []).map(i => ({ ...i, comprado: true }));
      patch.comprado_at = new Date().toISOString();
    }
    if (estado === 'entregado') patch.entregado_at = new Date().toISOString();
    const { data, error } = await supabase.from('repuestos_taller')
      .update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('repuestos estado:', err);
    res.status(500).json({ error: 'Error actualizando el pedido' });
  }
});

// Agregar una observación desde el panel (queda en el mismo hilo que las del
// mecánico y viaja en el próximo aviso de estado al capataz)
router.post('/api/reparaciones/:id/comentario', auth, async (req, res) => {
  try {
    const texto = String((req.body || {}).texto || '').trim();
    if (!texto) return res.status(400).json({ error: 'Falta el texto' });
    const { data, error } = await supabase.from('comentarios_incidencias')
      .insert({ incidencia_id: req.params.id, mecanico_nombre: 'Panel · ' + (req.usuario || 'admin'), texto })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('rep comentario panel:', err);
    res.status(500).json({ error: 'Error guardando la observación' });
  }
});

// Planillas de service cargadas desde la app del mecánico (foto + IA)
router.get('/api/services', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('services_unidades').select('*')
      .order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('services:', err);
    res.status(500).json({ error: 'Error cargando services' });
  }
});

// Avanzar estado / reasignar mecánico
const FECHA_ESTADO = {
  diagnostico:         'fecha_diagnostico',
  esperando_repuestos: 'fecha_espera_repuestos',
  en_reparacion:       'fecha_en_reparacion',
  finalizado:          'fecha_finalizado',
};
router.post('/api/reparaciones/:id', auth, async (req, res) => {
  try {
    const patch = {};
    if (req.body.estado) {
      patch.estado = req.body.estado;
      const campoFecha = FECHA_ESTADO[req.body.estado];
      if (campoFecha) patch[campoFecha] = new Date().toISOString();
    }
    if (req.body.mecanico_id !== undefined) patch.mecanico_id = req.body.mecanico_id || null;
    if (['correctivo', 'preventivo'].includes(req.body.tipo_mant)) patch.tipo_mant = req.body.tipo_mant;
    const { data, error } = await supabase
      .from('incidencias').update(patch).eq('id', req.params.id)
      .select('*, capataces(nombre,telefono), equipos(nombre), mecanicos(nombre)').single();
    if (error) throw error;

    // Aviso al capataz en cada avance de estado (diagnóstico, esperando
    // repuestos, en reparación, finalizado), con la última nota del mecánico
    let notificado = false;
    const AVISAN = ['diagnostico', 'esperando_repuestos', 'en_reparacion', 'finalizado'];
    if (AVISAN.includes(req.body.estado) && data.capataces && data.capataces.telefono) {
      let comentario = null;
      try {
        const { data: com } = await supabase.from('comentarios_incidencias')
          .select('texto').eq('incidencia_id', req.params.id)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (com) comentario = com.texto;
      } catch (e) { /* sin comentarios */ }
      const msg = mensajeEstadoIncidencia(req.body.estado, {
        equipo:   data.equipos ? data.equipos.nombre : (data.tipo_equipo || '—'),
        unidad:   data.numero_unidad,
        mecanico: data.mecanicos ? data.mecanicos.nombre : null,
        comentario,
      });
      if (msg) notificado = await notificarCapataz(data.capataces.telefono, msg);
    }
    res.json({ ...data, _notificado: notificado });
  } catch (err) {
    console.error('reparacion update:', err);
    res.status(500).json({ error: 'Error actualizando la reparación' });
  }
});

// ── Mecánicos (para reasignar) ────────────────────────────────
router.get('/api/mecanicos', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('mecanicos').select('id, nombre, habilidades').eq('activo', true)
      .or('rol_app.is.null,rol_app.neq.panol')   // el pañol vive en esta tabla pero no repara
      .order('nombre');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('mecanicos:', err);
    res.status(500).json({ error: 'Error cargando mecánicos' });
  }
});

// ── MAESTROS · ABM de mecánicos, objetivos y capataces ────────
// Lista blanca de campos editables por tabla (protege columnas críticas)
// Listas para los desplegables de imputación de Compras.
// Antes estaban hardcodeadas dentro del panel; ahora salen de los maestros.
router.get('/api/compras/listas', auth, async (req, res) => {
  try {
    const [cc, un] = await Promise.all([
      supabase.from('centros_costo').select('nombre').eq('activo', true).order('nombre'),
      supabase.from('unidades').select('codigo, marca_modelo, patente, responsable')
        .eq('activo', true).order('codigo'),
    ]);
    if (cc.error) throw cc.error;
    if (un.error) throw un.error;
    // La unidad se arma igual que antes: "U12 — Fiat Strada — AC770AY — Agustín"
    const unidades = (un.data || []).map(u =>
      [u.codigo, u.marca_modelo, u.patente, u.responsable].filter(Boolean).join(' — ')
    ).filter(Boolean);
    res.json({ objetivos: (cc.data || []).map(c => c.nombre), unidades });
  } catch (err) {
    console.error('compras listas:', err);
    res.status(500).json({ error: 'Error cargando las listas de imputación' });
  }
});

// Consolidado de combustible por objetivo (submódulo de Compras).
// Toma los listados/remitos del proveedor y reparte el gasto por objetivo.
//
// El objetivo de cada fila se resuelve en cascada, porque ninguna fuente sola
// alcanza: el listado del proveedor trae patente y chofer, pero no el objetivo.
//   1. Por PATENTE → unidad → objetivo asignado a esa unidad.
//   2. Por CHOFER → unidad cuyo responsable es ese chofer → su objetivo.
//   3. Por CHOFER → capataz con ese nombre → su objetivo.
// Lo que no se resuelve se devuelve aparte, con chofer y patente, para que se
// pueda identificar a mano.
router.get('/api/compras/combustible/consolidado', auth, async (req, res) => {
  try {
    const normP = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const normN = s => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');

    const { data: rems, error: e1 } = await supabaseCompras
      .from('remitos_combustible').select('*').order('created_at', { ascending: false });
    if (e1) throw e1;

    // Selección: ?ids=uuid,uuid | ?ids=todos | sin parámetro = el más reciente
    const idsParam = String(req.query.ids || '').trim();
    let sel = rems || [];
    if (idsParam && idsParam !== 'todos') {
      const set = new Set(idsParam.split(',').map(s => s.trim()).filter(Boolean));
      sel = sel.filter(r => set.has(String(r.id)));
    } else if (!idsParam && sel.length > 1) {
      sel = [sel[0]];
    }

    // Maestros para resolver el objetivo
    const [uni, cap] = await Promise.all([
      supabase.from('unidades').select('patente, codigo, responsable, objetivos(nombre)'),
      supabase.from('capataces').select('nombre, objetivos(nombre)'),
    ]);
    if (uni.error) throw uni.error;
    if (cap.error) throw cap.error;

    const porPatente = {}, porResponsable = {}, porCapataz = {};
    (uni.data || []).forEach(u => {
      const obj = u.objetivos ? u.objetivos.nombre : null;
      if (u.patente) porPatente[normP(u.patente)] = { objetivo: obj, codigo: u.codigo, responsable: u.responsable };
      if (u.responsable && obj) porResponsable[normN(u.responsable)] = obj;
    });
    (cap.data || []).forEach(c => {
      if (c.nombre && c.objetivos) porCapataz[normN(c.nombre)] = c.objetivos.nombre;
    });

    // Resolver cada fila
    const resolver = (patente, chofer) => {
      const p = normP(patente);
      if (p && porPatente[p] && porPatente[p].objetivo)
        return { objetivo: porPatente[p].objetivo, via: 'patente' };
      const c = normN(chofer);
      if (c && porResponsable[c]) return { objetivo: porResponsable[c], via: 'chofer (responsable de unidad)' };
      if (c && porCapataz[c])     return { objetivo: porCapataz[c],     via: 'chofer (capataz)' };
      return { objetivo: null, via: null };
    };

    const objetivos = {};    // nombre → { litros, monto, cargas, unidades:Set, choferes:Set }
    const sinAsignar = {};   // patente|chofer → { patente, chofer, litros, monto, cargas, fechas }
    let totalMonto = 0, totalLitros = 0, totalFilas = 0;

    sel.forEach(r => {
      const filas = (r.data && r.data.filas) || [];
      filas.forEach(f => {
        const litros = Number(f.litros) || 0;
        const monto  = Number(f.total)  || 0;
        totalMonto += monto; totalLitros += litros; totalFilas++;

        const { objetivo, via } = resolver(f.patente, f.chofer);
        if (objetivo) {
          if (!objetivos[objetivo]) objetivos[objetivo] =
            { nombre: objetivo, litros: 0, monto: 0, cargas: 0, unidades: new Set(), choferes: new Set(), vias: new Set() };
          const o = objetivos[objetivo];
          o.litros += litros; o.monto += monto; o.cargas++;
          if (f.patente) o.unidades.add(String(f.patente).toUpperCase());
          if (f.chofer)  o.choferes.add(f.chofer);
          if (via) o.vias.add(via);
        } else {
          // Se agrupa por PATENTE normalizada, no por patente+chofer: el listado
          // escribe el mismo chofer de formas distintas ("ARCE" / "ARCE SANTIAGO")
          // y la misma patente con o sin guiones, y eso partía una unidad en varias filas.
          const k = normP(f.patente) || ('SINPAT|' + normN(f.chofer));
          if (!sinAsignar[k]) {
            const u = porPatente[normP(f.patente)];   // ¿la unidad ya existe en el maestro?
            sinAsignar[k] = {
              patente: f.patente || null, chofer: f.chofer || null,
              litros: 0, monto: 0, cargas: 0, fechas: [], productos: new Set(), choferes: new Set(),
              // Si la unidad existe pero no tiene objetivo, lo decimos: no hay que
              // crearla, solo falta completarle el objetivo.
              unidad_conocida: u ? { codigo: u.codigo, responsable: u.responsable } : null,
            };
          }
          const s = sinAsignar[k];
          s.litros += litros; s.monto += monto; s.cargas++;
          if (f.chofer) s.choferes.add(f.chofer);
          if (f.fecha && !s.fechas.includes(f.fecha)) s.fechas.push(f.fecha);
          if (f.producto) s.productos.add(f.producto);
        }
      });
    });

    const pct = m => totalMonto ? (m * 100 / totalMonto) : 0;
    const listaObj = Object.values(objetivos).map(o => ({
      nombre: o.nombre, litros: o.litros, monto: o.monto, cargas: o.cargas,
      pct: pct(o.monto),
      unidades: [...o.unidades], choferes: [...o.choferes], vias: [...o.vias],
    })).sort((a, b) => b.monto - a.monto);

    const listaSin = Object.values(sinAsignar).map(s => ({
      ...s, productos: [...s.productos], choferes: [...s.choferes],
      pct: pct(s.monto), fechas: s.fechas.sort(),
    })).sort((a, b) => b.monto - a.monto);

    const montoSin = listaSin.reduce((s, x) => s + x.monto, 0);

    // Objetivos disponibles para asignar desde el desplegable inline
    const { data: objsDisp } = await supabase
      .from('objetivos').select('id, nombre').eq('activo', true).order('nombre');

    res.json({
      remitos: sel.map(r => ({ id: r.id, proveedor: r.proveedor,
        periodo_desde: r.periodo_desde, periodo_hasta: r.periodo_hasta,
        total: r.total_general, filas: ((r.data && r.data.filas) || []).length })),
      objetivos_disponibles: objsDisp || [],
      totales: {
        monto: totalMonto, litros: totalLitros, filas: totalFilas,
        asignado: totalMonto - montoSin,
        sin_asignar: montoSin,
        pct_asignado: pct(totalMonto - montoSin),
        pct_sin_asignar: pct(montoSin),
        objetivos: listaObj.length,
      },
      objetivos: listaObj,
      sin_asignar: listaSin,
    });
  } catch (err) {
    console.error('compras combustible consolidado:', err);
    res.status(500).json({ error: 'Error consolidando el combustible' });
  }
});

// Asignar un objetivo a una patente. Se persiste en el MAESTRO de unidades
// (no en una tabla aparte), así vale para todos los remitos futuros y además
// el bot de combustible reconoce la unidad. Una sola fuente de verdad.
router.post('/api/compras/combustible/asignar', auth, async (req, res) => {
  try {
    const { patente, chofer, objetivo_id } = req.body || {};
    if (!patente) return res.status(400).json({ error: 'Falta la patente' });
    const normP = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const p = normP(patente);

    // ¿Ya existe la unidad? (comparando patentes normalizadas)
    const { data: todas, error: e0 } = await supabase
      .from('unidades').select('id, patente, responsable');
    if (e0) throw e0;
    const existente = (todas || []).find(u => normP(u.patente) === p);

    if (existente) {
      const patch = { objetivo_id: objetivo_id || null };
      // Si la unidad no tenía responsable y el remito trae chofer, lo completamos
      if (!existente.responsable && chofer) patch.responsable = chofer;
      const { error } = await supabase.from('unidades').update(patch).eq('id', existente.id);
      if (error) throw error;
      console.log(`[combustible] unidad ${existente.patente} asignada a objetivo ${objetivo_id || 'ninguno'}`);
      return res.json({ ok: true, creada: false });
    }

    // No existe: se crea, porque si aparece en el remito es una unidad que carga
    const { error } = await supabase.from('unidades').insert({
      patente: String(patente).trim(),
      responsable: chofer || null,
      objetivo_id: objetivo_id || null,
      activo: true,
    });
    if (error) throw error;
    console.log(`[combustible] unidad ${patente} creada y asignada`);
    res.json({ ok: true, creada: true });
  } catch (err) {
    console.error('combustible asignar:', err);
    res.status(500).json({ error: 'Error asignando el objetivo' });
  }
});

const CAMPOS_MAESTRO = {
  mecanicos: ['nombre', 'habilidades', 'activo', 'usuario', 'rol_app', 'objetivos_cargo'],
  objetivos: ['nombre', 'ubicacion', 'tipo', 'activo', 'codigo_flexxus'],
  capataces: ['nombre', 'telefono', 'objetivo_id', 'rol', 'activo', 'es_chofer', 'unidad_id'],
  centros_costo: ['nombre', 'activo', 'codigo_flexxus'],
  unidades: ['codigo', 'marca_modelo', 'patente', 'responsable', 'objetivo_id', 'activo', 'tipo_rodado', 'tipo_activo'],
};

function filtrarCampos(tipo, body) {
  const permitidos = CAMPOS_MAESTRO[tipo] || [];
  const out = {};
  for (const k of permitidos) if (body[k] !== undefined) out[k] = body[k] === '' ? null : body[k];
  // La clave de la app nunca se guarda en texto plano. Vacía = no se cambia.
  if (tipo === 'mecanicos' && body.clave) out.clave_hash = hashClave(String(body.clave));
  return out;
}

// Listar (incluye inactivos, para poder reactivar)
router.get('/api/maestros/:tipo', auth, async (req, res) => {
  const tipo = req.params.tipo;
  if (!CAMPOS_MAESTRO[tipo]) return res.status(400).json({ error: 'Tipo inválido' });
  try {
    const sel = tipo === 'capataces' ? '*, objetivos(nombre)'
              : tipo === 'unidades'  ? '*, objetivos(nombre)'
              : '*';
    // `unidades` no tiene columna nombre: se ordena por código.
    const orden = tipo === 'unidades' ? 'codigo' : 'nombre';
    const { data, error } = await supabase.from(tipo).select(sel).order(orden);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('maestros list:', err);
    res.status(500).json({ error: 'Error cargando ' + tipo });
  }
});

// Crear
router.post('/api/maestros/:tipo', auth, async (req, res) => {
  const tipo = req.params.tipo;
  if (!CAMPOS_MAESTRO[tipo]) return res.status(400).json({ error: 'Tipo inválido' });
  try {
    const fila = filtrarCampos(tipo, req.body);
    // Las unidades no tienen "nombre": se identifican por código o patente.
    if (tipo === 'unidades') {
      if (!fila.codigo && !fila.patente) return res.status(400).json({ error: 'Cargá el código o la patente' });
    } else if (!fila.nombre) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
    }
    if (fila.activo === undefined) fila.activo = true;
    const { data, error } = await supabase.from(tipo).insert(fila).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('maestros create:', err);
    res.status(500).json({ error: 'No pude crear: ' + (err.message || 'error') });
  }
});

// Editar / activar-desactivar
router.post('/api/maestros/:tipo/:id', auth, async (req, res) => {
  const tipo = req.params.tipo;
  if (!CAMPOS_MAESTRO[tipo]) return res.status(400).json({ error: 'Tipo inválido' });
  try {
    const patch = filtrarCampos(tipo, req.body);
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
    const { data, error } = await supabase.from(tipo).update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('maestros update:', err);
    res.status(500).json({ error: 'No pude actualizar: ' + (err.message || 'error') });
  }
});

// ── COMPRAS (segunda base de datos) ───────────────────────────
// Las tablas guardan pocos campos duros + un jsonb `data` con el resto.
// Aplanamos el data para que el front lo consuma directo.
function aplanar(row) {
  const { data, ...duros } = row;
  return { ...(data || {}), ...duros };
}

// ── Flexxus ERP ───────────────────────────────────────────────
// "Probar conexión": login + lista de códigos (depósitos, multiplazos,
// percepciones) para configurar las variables en Railway.
router.get('/api/flexxus/estado', auth, async (req, res) => {
  try {
    const { probarConexion } = require('./flexxus');
    res.json(await probarConexion());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Imputar una factura de Compras en Flexxus (manual, desde el detalle)
router.post('/api/compras/facturas/:id/flexxus', auth, async (req, res) => {
  try {
    const letra = ['A', 'B', 'C'].includes((req.body || {}).letra) ? req.body.letra : 'A';
    const { data: fila, error: e0 } = await supabaseCompras.from('facturas')
      .select('*').eq('id', req.params.id).single();
    if (e0 || !fila) return res.status(404).json({ error: 'Factura inexistente' });
    const f = fila.data || {};
    if (f.flexxus && f.flexxus.ok && !(req.body || {}).force) {
      return res.status(409).json({ error: 'Esta factura ya fue imputada en Flexxus el ' + (f.flexxus.fecha || '') });
    }
    const { imputarFactura } = require('./flexxus');
    let r;
    try {
      r = await imputarFactura(f, letra, { permitirAlta: !!(req.body || {}).permitir_alta });
    } catch (e) {
      if (e.code === 'PROV_NO_EXISTE') return res.status(422).json({ error: e.message, code: 'PROV_NO_EXISTE' });
      if (e.code === 'NUMERO_INVALIDO') return res.status(422).json({ error: e.message, code: 'NUMERO_INVALIDO' });
      // Si Flexxus dice que el comprobante YA existe, es que ya está imputado:
      // lo marcamos como tal en vez de mostrar el error técnico.
      if (/ya existe/i.test(e.message || '')) {
        const flexxus = {
          ok: true, fecha: new Date().toISOString(), ya_existia: true,
          tipocomprobante: 'F' + letra,
          numerocomprobante: Number(String(f.numero_factura || '').replace(/\D/g, '')) || null,
          por: req.usuario || 'panel',
        };
        await supabaseCompras.from('facturas')
          .update({ data: { ...f, flexxus } }).eq('id', req.params.id);
        return res.json({ ok: true, flexxus, ya_existia: true });
      }
      throw e;
    }
    // Centro de costo: apropiación sobre el asiento, con el reparto que la
    // factura ya tiene cargado por ítem/total. Best-effort: nunca frena.
    let centroCosto = null;
    try {
      const { apropiarCentroCosto } = require('./flexxus');
      const { data: objs } = await supabase.from('centros_costo').select('nombre, codigo_flexxus');
      centroCosto = await apropiarCentroCosto(f, r, objs || []);
    } catch (e) {
      centroCosto = { ok: false, motivo: e.message };
    }
    const flexxus = {
      ok: true, fecha: new Date().toISOString(),
      tipocomprobante: r.tipocomprobante, numerocomprobante: r.numerocomprobante,
      proveedor_creado: r.proveedor_creado, proveedor_codigo: r.proveedor_codigo,
      proveedor_nombre: r.proveedor_nombre, por: req.usuario || 'panel',
      centro_costo: centroCosto,
    };
    await supabaseCompras.from('facturas')
      .update({ data: { ...f, flexxus } }).eq('id', req.params.id);
    res.json({ ok: true, flexxus });
  } catch (err) {
    console.error('flexxus imputar:', err.message);
    res.status(500).json({ error: err.message || 'Error imputando en Flexxus' });
  }
});

router.get('/api/compras/facturas', auth, async (req, res) => {
  try {
    const { data, error } = await supabaseCompras
      .from('facturas').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json((data || []).map(aplanar));
  } catch (err) {
    console.error('compras facturas:', err);
    res.status(500).json({ error: 'Error cargando facturas de compras' });
  }
});

router.get('/api/compras/remitos', auth, async (req, res) => {
  try {
    const { data, error } = await supabaseCompras
      .from('remitos_combustible').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json((data || []).map(aplanar));
  } catch (err) {
    console.error('compras remitos:', err);
    res.status(500).json({ error: 'Error cargando remitos de combustible' });
  }
});

// Modelo para EXTRACCIÓN de documentos (OCR estructurado, no razonamiento):
// Haiku es notablemente más rápido que Sonnet y con la misma precisión en esta
// tarea. Se puede forzar otro con ANTHROPIC_MODEL_EXTRACT.
const MODEL_EXTRACT = process.env.ANTHROPIC_MODEL_EXTRACT || 'claude-haiku-4-5-20251001';
// Las facturas de compras son pocas por día y valen plata: usan un modelo más
// capaz salvo que se fuerce otro con ANTHROPIC_MODEL_FACTURAS.
const MODEL_FACTURAS = process.env.ANTHROPIC_MODEL_FACTURAS || 'claude-sonnet-4-6';

// Extraer datos de una factura con IA (proxy a Claude, key server-side)
router.post('/api/compras/extract', auth, async (req, res) => {
  const t0 = Date.now();
  try {
    const { fileData, fileType } = req.body || {};
    if (!fileData) return res.status(400).json({ error: 'Falta el archivo' });
    const isImg = fileType && fileType.startsWith('image/');
    const part = isImg
      ? { type: 'image',    source: { type: 'base64', media_type: fileType, data: fileData } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } };
    const prompt = 'Analizá esta factura argentina y devolvé ÚNICAMENTE JSON sin backticks:\n' +
      '{"fecha_factura":"YYYY-MM-DD","numero_factura":"string","proveedor":"string","cuit":"string",' +
      '"items":[{"descripcion":"string","cantidad":1,"monto_sin_iva":0.00,"monto_iva":0.00}],' +
      '"total_sin_iva":0.00,"total_iva":0.00,' +
      '"otros_conceptos":[{"concepto":"string","monto":0.00,"tipo":"percepcion|impuesto|otro"}]}\n' +
      'Reglas:\n' +
      '- Montos como números, sin separador de miles. Campos ilegibles: null.\n' +
      '- "proveedor" es la razón social del EMISOR, transcripta EXACTA carácter por carácter ' +
      '(no corrijas ni interpretes apellidos: si dice COCCONI es COCCONI). Nunca uses el nombre ' +
      'de fantasía/logo si figura la razón social. ECOSERVICE (CUIT 30-70793029-9) es siempre el ' +
      'CLIENTE: jamás lo pongas como proveedor ni uses su CUIT.\n' +
      '- "cuit" es el CUIT del emisor. Transcribí números EXACTOS, dígito por dígito.\n' +
      '- PROHIBIDO tomar como ítem o como concepto las líneas de TOTALES del pie: ' +
      '"Subtotal", "Total", "Importe Total", "Total a pagar", "Neto Gravado", "IVA 21%", ' +
      '"Importe Otros Tributos" y similares son SUMAS de lo anterior, no conceptos nuevos. ' +
      'Meterlas duplica la factura.\n' +
      '- Los datos fiscales del encabezado (CUIT, Ingresos Brutos, Inicio de Actividades, ' +
      'condición IVA, CAE) son identificación, NUNCA montos ni impuestos.\n' +
      '- Factura C (monotributista): no discrimina IVA → total_iva=0, y el importe de cada ' +
      'ítem va completo en monto_sin_iva.\n' +
      '- El IVA de cada ítem va en "monto_iva" (NO en "iva").\n' +
      '- Si la factura NO desglosa el IVA por ítem y solo lo trae en el total, ' +
      'prorrateá el IVA total entre los ítems proporcional a su monto_sin_iva, ' +
      'de modo que la suma de los monto_iva dé exactamente total_iva.\n' +
      '- La suma de monto_sin_iva de los ítems tiene que dar total_sin_iva.\n' +
      '- "otros_conceptos": SOLO cargos extra reales que no son neto ni IVA: percepciones ' +
      '(IIBB/Ingresos Brutos de cualquier provincia, percepción IVA, ganancias), impuestos ' +
      '(sellados, tasa SSN, servicios sociales, gastos notariales, impuestos internos, tasa municipal), ' +
      'bonificaciones/descuentos (monto negativo). Nombre tal como figura, en "concepto". ' +
      'tipo="percepcion" para percepciones, tipo="impuesto" para sellados/tasas/servicios, tipo="otro" para el resto. ' +
      'Si no hay ninguno, otros_conceptos = [].\n' +
      '- VERIFICACIÓN FINAL obligatoria: total_sin_iva + total_iva + suma de otros_conceptos ' +
      'tiene que dar EXACTAMENTE el "Importe Total"/"Total" impreso en la factura. ' +
      'Si no cierra, revisá: casi siempre metiste un subtotal o total como concepto. Corregilo antes de responder.';
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      MODEL_FACTURAS,
        max_tokens: 4000,   // una factura rara vez pasa de 30 ítems
        messages:   [{ role: 'user', content: [part, { type: 'text', text: prompt }] }],
      }),
    });
    const data = await resp.json();
    const txt = (data.content || []).map(c => c.text || '').join('');
    console.log(`[factura] extraída en ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `(${MODEL_FACTURAS}, ${(data.usage && data.usage.output_tokens) || '?'} tokens)`);
    try {
      const parsed = JSON.parse(txt.replace(/```json|```/g, '').trim());
      // ── Defensas duras post-extracción (independientes del prompt) ──
      const avisos = [];
      const RX_TOTAL = /^(sub\s*-?\s*totales?|totales?\b|importe\s+total|total\s+a\s+pagar|neto(\s+gravado)?$|iva(\s*21.*)?$|importe\s+otros\s+tributos|saldo|son\s+pesos)/i;
      if (Array.isArray(parsed.otros_conceptos)) {
        const antes = parsed.otros_conceptos.length;
        parsed.otros_conceptos = parsed.otros_conceptos.filter(c => !RX_TOTAL.test(String(c.concepto || '').trim()));
        if (parsed.otros_conceptos.length !== antes) avisos.push('Descarté líneas de totales que la lectura tomó como conceptos.');
      }
      if (Array.isArray(parsed.items)) {
        const antes = parsed.items.length;
        parsed.items = parsed.items.filter(i => !RX_TOTAL.test(String(i.descripcion || '').trim()));
        if (parsed.items.length !== antes) avisos.push('Descarté líneas de totales que la lectura tomó como ítems.');
      }
      // El CUIT de EcoService jamás es el del proveedor
      if (String(parsed.cuit || '').replace(/\D/g, '') === '30707930299') {
        parsed.cuit = null;
        avisos.push('La lectura trajo el CUIT de EcoService (cliente) como proveedor: revisá el CUIT del emisor.');
      }
      // Coherencia aritmética entre ítems y totales
      const sumaItems = (parsed.items || []).reduce((s, i) => s + (Number(i.monto_sin_iva) || 0), 0);
      if (parsed.total_sin_iva != null && sumaItems > 0 &&
          Math.abs(sumaItems - Number(parsed.total_sin_iva)) > Math.max(1, Number(parsed.total_sin_iva) * 0.005)) {
        avisos.push('Los ítems suman ' + sumaItems.toFixed(2) + ' y el neto leído es ' + Number(parsed.total_sin_iva).toFixed(2) + ': verificá los montos contra el papel.');
      }
      if (avisos.length) parsed.__avisos = avisos;
      res.json(parsed);
    } catch (e) {
      res.json({ __error: 'No se pudo extraer automáticamente. Completá los campos a mano.' });
    }
  } catch (err) {
    console.error('compras extract:', err);
    res.status(500).json({ error: 'Error extrayendo la factura' });
  }
});

// Guardar una factura (con su asignación) en la base de compras
// Clave de duplicado: mismo proveedor (por CUIT si hay, si no por nombre) y
// mismo número de factura. Es la regla real: un proveedor no emite dos veces
// el mismo número.
function claveFactura(inv) {
  const num = String(inv.numero_factura || '').replace(/[\s-]/g, '').toUpperCase();
  const prov = String(inv.cuit || inv.proveedor || '').replace(/[\s-]/g, '').toUpperCase();
  return num && prov ? `${prov}|${num}` : null;
}

// Chequeo previo: ¿ya existe esta factura? Se llama antes de guardar.
router.post('/api/compras/duplicado', auth, async (req, res) => {
  try {
    const clave = claveFactura(req.body || {});
    if (!clave) return res.json({ duplicado: false });
    const { data, error } = await supabaseCompras.from('facturas').select('*');
    if (error) throw error;
    const existente = (data || []).map(aplanar)
      .filter(f => !f.anulada)
      .find(f => claveFactura(f) === clave);
    res.json(existente
      ? { duplicado: true, factura: { id: existente.id, fecha_factura: existente.fecha_factura,
          proveedor: existente.proveedor, numero_factura: existente.numero_factura,
          total: (Number(existente.total_sin_iva) || 0) + (Number(existente.total_iva) || 0) } }
      : { duplicado: false });
  } catch (err) {
    console.error('compras duplicado:', err);
    res.status(500).json({ error: 'Error verificando duplicados' });
  }
});

// ── Comprobantes (PDF/imagen de la factura) ───────────────────
// Se guardan en Supabase Storage, no en la fila: el listado de Compras trae
// las 210 facturas de una, y meter los PDF adentro lo volvería inusable.
// En la fila queda solo la ruta; el archivo se pide aparte al abrir la ficha.
const BUCKET = 'comprobantes';

// Sube el comprobante y devuelve la ruta. Se llama al guardar la factura.
async function subirComprobante(fileData, fileType, nombre) {
  if (!fileData) return null;
  try {
    const ext = (fileType || '').startsWith('image/')
      ? (fileType.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
      : 'pdf';
    const ruta = `${new Date().toISOString().slice(0, 7)}/${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const buf = Buffer.from(fileData, 'base64');
    const { error } = await supabaseCompras.storage.from(BUCKET)
      .upload(ruta, buf, { contentType: fileType || 'application/pdf', upsert: false });
    if (error) { console.error('[comprobante] error subiendo:', error.message); return null; }
    console.log(`[comprobante] subido ${ruta} (${Math.round(buf.length / 1024)}kb)`);
    return { ruta, tipo: fileType || 'application/pdf', nombre: nombre || null,
             subido_at: new Date().toISOString() };
  } catch (err) {
    console.error('[comprobante] error subiendo:', err.message || err);
    return null;   // que falle el archivo no debe impedir guardar la factura
  }
}

// URL firmada temporal para ver el comprobante (el bucket es privado)
router.get('/api/compras/factura/:id/comprobante', auth, async (req, res) => {
  try {
    const { data: row, error: e0 } = await supabaseCompras
      .from('facturas').select('*').eq('id', req.params.id).single();
    if (e0 || !row) return res.status(404).json({ error: 'Factura inexistente' });
    const inv = aplanar(row);
    if (!inv.comprobante || !inv.comprobante.ruta) {
      return res.status(404).json({ error: 'Esta factura no tiene comprobante adjunto' });
    }
    const { data, error } = await supabaseCompras.storage.from(BUCKET)
      .createSignedUrl(inv.comprobante.ruta, 3600);   // 1 hora
    if (error) throw error;
    res.json({ url: data.signedUrl, tipo: inv.comprobante.tipo, nombre: inv.comprobante.nombre });
  } catch (err) {
    console.error('compras comprobante:', err);
    res.status(500).json({ error: 'Error abriendo el comprobante' });
  }
});

// Adjuntar (o reemplazar) el comprobante de una factura ya cargada
router.post('/api/compras/factura/:id/comprobante', auth, async (req, res) => {
  try {
    const { fileData, fileType, fileName } = req.body || {};
    if (!fileData) return res.status(400).json({ error: 'Falta el archivo' });
    const { data: row, error: e0 } = await supabaseCompras
      .from('facturas').select('*').eq('id', req.params.id).single();
    if (e0 || !row) return res.status(404).json({ error: 'Factura inexistente' });
    const inv = aplanar(row);

    const comp = await subirComprobante(fileData, fileType, fileName);
    if (!comp) return res.status(500).json({ error: 'No se pudo subir el archivo' });

    // Si ya tenía uno, borrar el viejo para no dejar basura
    if (inv.comprobante && inv.comprobante.ruta) {
      await supabaseCompras.storage.from(BUCKET).remove([inv.comprobante.ruta]).catch(() => {});
    }
    const nuevo = { ...inv, comprobante: comp };
    delete nuevo.id; delete nuevo.created_at;
    const { data, error } = await supabaseCompras
      .from('facturas').update({ data: nuevo }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(aplanar(data));
  } catch (err) {
    console.error('compras adjuntar comprobante:', err);
    res.status(500).json({ error: 'Error adjuntando el comprobante' });
  }
});

router.post('/api/compras/factura', auth, async (req, res) => {
  try {
    const inv = req.body || {};
    // El PDF/imagen viaja aparte de los datos; se sube a Storage y en la fila
    // queda solo la ruta.
    const { fileData, fileType, fileName, ...datos } = inv;
    const comp = await subirComprobante(fileData, fileType, fileName);
    if (comp) datos.comprobante = comp;

    const { data, error } = await supabaseCompras
      .from('facturas').insert({ numero_factura: datos.numero_factura || null, data: datos })
      .select().single();
    if (error) throw error;
    res.json(aplanar(data));
  } catch (err) {
    console.error('compras crear factura:', err);
    res.status(500).json({ error: 'Error guardando la factura' });
  }
});

// Editar una factura ya cargada (corregir montos, proveedor, imputación...)
router.put('/api/compras/factura/:id', auth, async (req, res) => {
  try {
    const inv = req.body || {};
    const { data: prev, error: e0 } = await supabaseCompras
      .from('facturas').select('*').eq('id', req.params.id).single();
    if (e0 || !prev) return res.status(404).json({ error: 'Factura inexistente' });
    // Se preservan los campos que el panel no manda (notas de crédito, etc.)
    const anterior = aplanar(prev);
    const nuevo = { ...anterior, ...inv, id: undefined, created_at: undefined,
      editadoAt: new Date().toISOString() };
    delete nuevo.id; delete nuevo.created_at;
    const { data, error } = await supabaseCompras
      .from('facturas')
      .update({ numero_factura: nuevo.numero_factura || null, data: nuevo })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(aplanar(data));
  } catch (err) {
    console.error('compras editar factura:', err);
    res.status(500).json({ error: 'Error editando la factura' });
  }
});

router.delete('/api/compras/factura/:id', auth, async (req, res) => {
  try {
    // Borrar también el comprobante del bucket, para no dejar archivos huérfanos
    const { data: row } = await supabaseCompras
      .from('facturas').select('*').eq('id', req.params.id).single();
    const inv = row ? aplanar(row) : null;
    if (inv && inv.comprobante && inv.comprobante.ruta) {
      const { error: eDel } = await supabaseCompras.storage.from(BUCKET)
        .remove([inv.comprobante.ruta]);
      if (eDel) console.error('[comprobante] no pude borrar el archivo:', eDel.message);
    }
    const { error } = await supabaseCompras.from('facturas').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('compras borrar factura:', err);
    res.status(500).json({ error: 'Error borrando la factura' });
  }
});

// Nota de crédito: descuenta sobre una factura ya cargada. Se guarda DENTRO de
// la factura (array `notas_credito`), así el neto siempre se calcula contra su
// factura y no queda un documento suelto que haya que cruzar después.
router.post('/api/compras/factura/:id/nota-credito', auth, async (req, res) => {
  try {
    const nc = req.body || {};
    const neto = Number(nc.total_sin_iva) || 0;
    const iva  = Number(nc.total_iva) || 0;
    if (neto <= 0 && iva <= 0) return res.status(400).json({ error: 'La nota de crédito tiene que tener un monto' });

    const { data: prev, error: e0 } = await supabaseCompras
      .from('facturas').select('*').eq('id', req.params.id).single();
    if (e0 || !prev) return res.status(404).json({ error: 'Factura inexistente' });
    const inv = aplanar(prev);

    const notas = Array.isArray(inv.notas_credito) ? inv.notas_credito.slice() : [];
    // No se puede acreditar más que el total de la factura
    const totalFactura = (Number(inv.total_sin_iva) || 0) + (Number(inv.total_iva) || 0);
    const yaAcreditado = notas.reduce((s, n) =>
      s + (Number(n.total_sin_iva) || 0) + (Number(n.total_iva) || 0), 0);
    if (yaAcreditado + neto + iva > totalFactura + 0.01) {
      return res.status(400).json({
        error: `La nota supera el saldo de la factura. Total ${totalFactura.toFixed(2)}, ya acreditado ${yaAcreditado.toFixed(2)}.` });
    }

    notas.push({
      id: crypto.randomBytes(6).toString('hex'),
      fecha: nc.fecha || new Date().toISOString().slice(0, 10),
      numero: nc.numero || null,
      motivo: nc.motivo || null,
      total_sin_iva: neto,
      total_iva: iva,
      created_at: new Date().toISOString(),
    });
    const nuevo = { ...inv, notas_credito: notas };
    delete nuevo.id; delete nuevo.created_at;

    const { data, error } = await supabaseCompras
      .from('facturas').update({ data: nuevo }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(aplanar(data));
  } catch (err) {
    console.error('compras nota credito:', err);
    res.status(500).json({ error: 'Error guardando la nota de crédito' });
  }
});

router.delete('/api/compras/factura/:id/nota-credito/:ncid', auth, async (req, res) => {
  try {
    const { data: prev, error: e0 } = await supabaseCompras
      .from('facturas').select('*').eq('id', req.params.id).single();
    if (e0 || !prev) return res.status(404).json({ error: 'Factura inexistente' });
    const inv = aplanar(prev);
    const notas = (inv.notas_credito || []).filter(n => String(n.id) !== String(req.params.ncid));
    const nuevo = { ...inv, notas_credito: notas };
    delete nuevo.id; delete nuevo.created_at;
    const { data, error } = await supabaseCompras
      .from('facturas').update({ data: nuevo }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(aplanar(data));
  } catch (err) {
    console.error('compras borrar nota credito:', err);
    res.status(500).json({ error: 'Error borrando la nota de crédito' });
  }
});

// ── COMBUSTIBLE · Conciliación con listados del proveedor ──────
// El proveedor (Ferreyra, SERVISUD...) emite un listado consolidado del período.
// Reintentar SOLO la apropiación de centro de costo de una factura ya
// imputada (sin reimputar el comprobante). Usa el asiento guardado.
router.post('/api/compras/facturas/:id/flexxus-centrocosto', auth, async (req, res) => {
  try {
    const { data: fila, error: e0 } = await supabaseCompras.from('facturas')
      .select('*').eq('id', req.params.id).single();
    if (e0 || !fila) return res.status(404).json({ error: 'Factura inexistente' });
    const f = fila.data || {};
    if (!f.flexxus || !f.flexxus.ok) return res.status(422).json({ error: 'La factura no está imputada en Flexxus todavía.' });
    const cc0 = f.flexxus.centro_costo || {};
    const numeroasiento = cc0.numeroasiento ?? f.flexxus.numeroasiento ?? null;
    if (numeroasiento == null) {
      return res.status(422).json({ error: 'No tengo guardado el número de asiento de esta imputación (es anterior a esta función). Anulá el comprobante en Flexxus y reimputá.' });
    }
    const { apropiarCentroCosto } = require('./flexxus');
    const { data: objs } = await supabase.from('centros_costo').select('nombre, codigo_flexxus');
    const cc = await apropiarCentroCosto(f, { respuesta: { numeroasiento } }, objs || []);
    const flexxus = { ...f.flexxus, centro_costo: cc };
    await supabaseCompras.from('facturas')
      .update({ data: { ...f, flexxus } }).eq('id', req.params.id);
    res.json({ ok: true, centro_costo: cc });
  } catch (err) {
    console.error('flexxus centrocosto retry:', err.message);
    res.status(500).json({ error: err.message || 'No pude apropiar el centro de costo' });
  }
});

// Verificación previa: a qué proveedor de Flexxus iría la factura y con qué
// número, SIN imputar nada. El panel la muestra antes de confirmar.
router.get('/api/compras/facturas/:id/flexxus-preview', auth, async (req, res) => {
  try {
    const { data: fila, error: e0 } = await supabaseCompras.from('facturas')
      .select('*').eq('id', req.params.id).single();
    if (e0 || !fila) return res.status(404).json({ error: 'Factura inexistente' });
    const { verificarImputacion } = require('./flexxus');
    const v = await verificarImputacion(fila.data || {}, String(req.query.letra || 'A').toUpperCase());
    res.json(v);
  } catch (err) {
    console.error('flexxus preview:', err.message);
    res.status(500).json({ error: err.message || 'No pude verificar contra Flexxus' });
  }
});

// Se extrae con IA, se guarda en remitos_combustible (base compras) y el
// análisis lo cruza contra cargas_combustible (base bot): match por
// numero_remito, fallback patente+fecha — como prevé el ciclo de vida del módulo.

router.post('/api/combustible/remito/extract', auth, async (req, res) => {
  const t0 = Date.now();
  try {
    const { fileData, fileType } = req.body || {};
    if (!fileData) return res.status(400).json({ error: 'Falta el archivo' });
    console.log(`[listado] recibido ${Math.round(fileData.length / 1024)}kb tipo=${fileType || 'pdf'}`);
    const isImg = fileType && fileType.startsWith('image/');
    const part = isImg
      ? { type: 'image',    source: { type: 'base64', media_type: fileType, data: fileData } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } };
    // JSON COMPACTO: con claves de una letra el modelo escribe ~40% menos tokens
    // de salida, y en un listado de 100 filas eso es la mayor parte del tiempo.
    // Se expanden a los nombres reales acá abajo.
    const prompt = 'Esto es un comprobante de combustible de un proveedor argentino: puede ser ' +
      'un LISTADO mensual (varias filas) o un TICKET de surtidor individual (una carga). ' +
      'Devolvé ÚNICAMENTE JSON compacto sin backticks, sin espacios ni saltos de línea innecesarios:\n' +
      '{"p":"proveedor","d":"YYYY-MM-DD","h":"YYYY-MM-DD","t":0.0,' +
      '"f":[["YYYY-MM-DD","nro_remito","patente","chofer","producto",litros,precio,total,"nro_factura"]]}\n' +
      'Donde: p=proveedor, d=período desde, h=período hasta, t=total general, f=filas.\n' +
      'Cada fila es un ARRAY en ese orden exacto: [fecha, nro_remito, patente, chofer, producto, litros, precio_unit, total, nro_factura].\n' +
      'REGLAS IMPORTANTES SOBRE LOS LITROS:\n' +
      '- Los litros son el número que apariciona ANTES del nombre del producto, con coma decimal. ' +
      'Ejemplo: en "46,0070.....(11001)PUMA SUPER" los litros son 46,00 (=46.0), NO 11001.\n' +
      '- El número entre paréntesis como "(11001)" o "(11008)" es el CÓDIGO INTERNO del producto de la estación. ' +
      'NUNCA lo uses como litros ni como precio. Ignoralo por completo o descartalo.\n' +
      '- La coma es separador decimal: "46,0070" son 46 litros con centésimos, no 460070. Convertí a punto: 46.007.\n' +
      '- Si en el ticket no figura precio unitario ni total, dejalos en null. NO inventes montos.\n' +
      'Otras reglas: el año de las fechas sacalo del encabezado o de la fecha del ticket. ' +
      'Una fila por cada línea de producto (si hay 2 productos, son 2 filas con el mismo nro_remito). ' +
      'Patente tal como figura. El chofer suele figurar como "Chofer: APELLIDO". ' +
      'Montos como números sin separador de miles. Campos ilegibles o ausentes: null.';
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      MODEL_EXTRACT,
        max_tokens: 16000,   // alcanza para ~300 filas en formato compacto
        messages:   [{ role: 'user', content: [part, { type: 'text', text: prompt }] }],
      }),
    });
    const data = await resp.json();
    const segs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[listado] anthropic status=${resp.status} stop=${data.stop_reason || '?'} en ${segs}s ` +
      `(${MODEL_EXTRACT}, ${(data.usage && data.usage.output_tokens) || '?'} tokens)`);
    if (!resp.ok) {
      const emsg = (data.error && data.error.message) || ('HTTP ' + resp.status);
      console.error('[listado] error anthropic:', emsg);
      return res.json({ __error: 'La IA rechazó el pedido: ' + emsg });
    }
    const txt = (data.content || []).map(c => c.text || '').join('');
    // Parseo robusto: quedarnos con lo que hay entre la primera { y la última }
    let raw = txt.replace(/```json|```/g, '').trim();
    const i0 = raw.indexOf('{'), i1 = raw.lastIndexOf('}');
    if (i0 >= 0 && i1 > i0) raw = raw.slice(i0, i1 + 1);
    try {
      const c = JSON.parse(raw);
      // Expandir el formato compacto al que espera el resto del sistema
      const parsed = {
        proveedor:     c.p || c.proveedor || null,
        periodo_desde: c.d || c.periodo_desde || null,
        periodo_hasta: c.h || c.periodo_hasta || null,
        total_general: Number(c.t != null ? c.t : c.total_general) || 0,
        filas: (c.f || c.filas || []).map(f => Array.isArray(f)
          ? { fecha: f[0] || null, numero_remito: f[1] || null, patente: f[2] || null,
              chofer: f[3] || null, producto: f[4] || null,
              litros: Number(f[5]) || 0, precio_unit: Number(f[6]) || 0,
              total: Number(f[7]) || 0, numero_factura: f[8] || null }
          : f),   // por si el modelo devolvió objetos igual
      };
      // Red de seguridad: un tanque de camioneta rara vez pasa de ~150 litros y
      // un bidón de 300. Si un litraje es absurdamente alto (típico cuando la IA
      // confundió el código de producto con los litros, ej. 11001), lo marcamos
      // para que el usuario lo revise en vez de meter basura al análisis.
      let sospechosas = 0;
      parsed.filas.forEach(f => {
        if (f.litros > 2000) { f._litros_dudoso = true; sospechosas++; }
        // Si litros y total son casi iguales y ambos son "redondos", suele ser
        // el código pegado en las dos columnas.
        if (f.litros > 2000 && f.total > 2000 && Math.abs(f.litros - f.total) < 1) {
          f._litros_dudoso = true;
        }
      });
      if (sospechosas) parsed._advertencia =
        `${sospechosas} carga(s) tienen un litraje muy alto y pueden estar mal leídas. Revisalas antes de guardar.`;
      console.log(`[listado] extraídas ${parsed.filas.length} filas de ${parsed.proveedor || '?'} en ${segs}s` +
        (sospechosas ? ` · ${sospechosas} con litros dudosos` : ''));
      res.json(parsed);
    } catch (e) {
      console.error('[listado] respuesta no parseable (stop=' + (data.stop_reason || '?') + '):', txt.slice(0, 300));
      if (data.stop_reason === 'max_tokens') {
        return res.json({ __error: 'El listado es muy largo y la respuesta se cortó. Probá subirlo en partes (por página).' });
      }
      res.json({ __error: 'No se pudo interpretar el listado.' });
    }
  } catch (err) {
    console.error('[listado] extract error:', err.message || err);
    res.status(500).json({ error: 'Error extrayendo el listado' });
  }
});

router.post('/api/combustible/remito', auth, async (req, res) => {
  try {
    const r = req.body || {};
    const { data, error } = await supabaseCompras
      .from('remitos_combustible')
      .insert({
        proveedor:      r.proveedor || null,
        periodo_desde:  r.periodo_desde || null,
        periodo_hasta:  r.periodo_hasta || null,
        total_general:  Number(r.total_general) || 0,
        data:           { filas: r.filas || [], origen: 'panel_conciliacion' },
      }).select().single();
    if (error) throw error;
    res.json(aplanar(data));
  } catch (err) {
    console.error('combustible remito guardar:', err);
    res.status(500).json({ error: 'Error guardando el listado' });
  }
});

router.get('/api/combustible/remito/:id', auth, async (req, res) => {
  try {
    const { data, error } = await supabaseCompras
      .from('remitos_combustible').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(aplanar(data));
  } catch (err) {
    console.error('combustible remito ver:', err);
    res.status(500).json({ error: 'Error trayendo el listado' });
  }
});

router.delete('/api/combustible/remito/:id', auth, async (req, res) => {
  try {
    const { error } = await supabaseCompras
      .from('remitos_combustible').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('combustible remito eliminar:', err);
    res.status(500).json({ error: 'Error eliminando el listado' });
  }
});

router.get('/api/combustible/analisis', auth, async (req, res) => {
  try {
    const normN = s => String(s || '').replace(/\D/g, '').replace(/^0+/, '');
    const normP = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

    // 1) Listados del proveedor (base compras)
    const { data: rems, error: e1 } = await supabaseCompras
      .from('remitos_combustible').select('*').order('created_at', { ascending: false });
    if (e1) throw e1;

    // Selección de listados: ?ids=uuid,uuid → esos | ?ids=todos → todos |
    // sin parámetro → solo el más reciente (default para no mezclar períodos).
    const idsParam = String(req.query.ids || '').trim();
    let remsSel = rems || [];
    if (idsParam && idsParam !== 'todos') {
      const setIds = new Set(idsParam.split(',').map(s => s.trim()).filter(Boolean));
      remsSel = remsSel.filter(r => setIds.has(String(r.id)));
    } else if (!idsParam && remsSel.length > 1) {
      remsSel = [remsSel[0]]; // vienen ordenados por created_at desc
    }

    const filas = [];
    remsSel.forEach(r => {
      const fs = (r.data && r.data.filas) || [];
      fs.forEach(f => filas.push({ ...f, __prov: r.proveedor, __remId: r.id }));
    });

    // 2) Cargas de los capataces (base bot), acotadas al rango de los listados
    let q = supabase.from('cargas_combustible')
      .select('*, cargas_combustible_items(*), unidades(patente,codigo,marca), capataces(nombre), proveedores(nombre), objetivos(nombre)')
      .neq('estado', 'anulada');
    const fechas = filas.map(f => f.fecha).filter(Boolean).sort();
    if (fechas.length) q = q.gte('fecha', fechas[0]).lte('fecha', fechas[fechas.length - 1]);
    const { data: cargas, error: e2 } = await q;
    if (e2) throw e2;

    // 3) Agrupar filas del listado por remito (un remito puede tener 2 productos)
    const grupos = {};
    filas.forEach(f => {
      const k = normN(f.numero_remito) || ('SR|' + normP(f.patente) + '|' + (f.fecha || ''));
      if (!grupos[k]) grupos[k] = { key: k, numero_remito: f.numero_remito, fecha: f.fecha, patente: f.patente,
        chofer: f.chofer, proveedor: f.__prov, litros: 0, total: 0, productos: [] };
      grupos[k].litros += Number(f.litros) || 0;
      grupos[k].total  += Number(f.total)  || 0;
      if (f.producto) grupos[k].productos.push(f.producto);
    });

    // 4) Indexar cargas por remito y por patente+fecha
    const byNum = {}, byPatFecha = {};
    (cargas || []).forEach(c => {
      const n = normN(c.numero_remito); if (n) byNum[n] = c;
      const p = normP((c.unidades && c.unidades.patente) || c.patente_raw);
      if (p && c.fecha) byPatFecha[p + '|' + c.fecha] = c;
    });

    // 5) Matchear
    const sinTicket = [], desvios = [], matcheadas = [];
    const cargasUsadas = new Set();
    Object.values(grupos).forEach(g => {
      let c = byNum[g.key] || byPatFecha[normP(g.patente) + '|' + (g.fecha || '')] || null;
      if (!c) { sinTicket.push(g); return; }
      cargasUsadas.add(c.id);
      const lt = Number(c.litros_total) || 0;
      const dif = Math.round((g.litros - lt) * 100) / 100;
      const fila = { ...g, carga_id: c.id, litros_ticket: lt, dif,
        capataz: c.capataces ? c.capataces.nombre : null,
        objetivo: c.objetivos ? c.objetivos.nombre : null };
      if (Math.abs(dif) > 1) desvios.push(fila); else matcheadas.push(fila);
    });
    const sinRespaldo = (cargas || []).filter(c => !cargasUsadas.has(c.id) && c.origen !== 'pdf_consolidado');

    // 6) Resumen por unidad (patente)
    const porUnidad = {};
    const uniDe = p => { const k = normP(p) || 'SINPAT';
      if (!porUnidad[k]) porUnidad[k] = { patente: p || '—', litros_prov: 0, litros_ticket: 0, entregas: 0, cargas: 0, sin_ticket: 0 };
      return porUnidad[k]; };
    Object.values(grupos).forEach(g => { const u = uniDe(g.patente); u.litros_prov += g.litros; u.entregas++; });
    sinTicket.forEach(g => { uniDe(g.patente).sin_ticket++; });
    (cargas || []).forEach(c => {
      const u = uniDe((c.unidades && c.unidades.patente) || c.patente_raw);
      u.litros_ticket += Number(c.litros_total) || 0; u.cargas++;
    });
    const unidades = Object.values(porUnidad)
      .map(u => ({ ...u, litros_prov: Math.round(u.litros_prov * 100) / 100,
        litros_ticket: Math.round(u.litros_ticket * 100) / 100,
        dif: Math.round((u.litros_prov - u.litros_ticket) * 100) / 100 }))
      .sort((a, b) => b.litros_prov - a.litros_prov);

    const litrosProv   = unidades.reduce((s, u) => s + u.litros_prov, 0);
    const litrosTicket = unidades.reduce((s, u) => s + u.litros_ticket, 0);
    res.json({
      remitos: (rems || []).map(r => {
        const fs = (r.data && r.data.filas) || [];
        return { id: r.id, proveedor: r.proveedor,
          periodo_desde: r.periodo_desde, periodo_hasta: r.periodo_hasta,
          total_general: r.total_general, filas: fs.length,
          litros: Math.round(fs.reduce((s, f) => s + (Number(f.litros) || 0), 0) * 100) / 100 };
      }),
      ids_aplicados: remsSel.map(r => String(r.id)),
      kpis: {
        litros_prov:   Math.round(litrosProv * 100) / 100,
        litros_ticket: Math.round(litrosTicket * 100) / 100,
        entregas:      Object.keys(grupos).length,
        con_ticket:    matcheadas.length + desvios.length,
        sin_ticket:    sinTicket.length,
        desvios:       desvios.length,
        cobertura_pct: Object.keys(grupos).length
          ? Math.round((matcheadas.length + desvios.length) * 100 / Object.keys(grupos).length) : null,
      },
      unidades, sin_ticket: sinTicket, desvios, matcheadas,
      sin_respaldo: sinRespaldo.map(c => ({ id: c.id, fecha: c.fecha, numero_remito: c.numero_remito,
        patente: (c.unidades && c.unidades.patente) || c.patente_raw, litros: c.litros_total,
        capataz: c.capataces ? c.capataces.nombre : null, proveedor: c.proveedores ? c.proveedores.nombre : null,
        objetivo: c.objetivos ? c.objetivos.nombre : null })),
    });
  } catch (err) {
    console.error('combustible analisis:', err);
    res.status(500).json({ error: 'Error armando el análisis' });
  }
});

// ── STOCK de maquinaria · censos por objetivo ──────────────────
// El panel pide el stock por WhatsApp (notificarCapataz) y los capataces
// responden por el bot (stock.js). Acá se listan los censos y se piden/reenvían.

function periodoStockActual() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Cordoba' }).slice(0, 7);
}
const MESES_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function mesLindo(periodo) {
  const [a, m] = String(periodo).split('-').map(Number);
  return (MESES_ES[(m || 1) - 1] || '') + ' ' + (a || '');
}
// Template de WhatsApp aprobado por Meta para el pedido de stock: es el primer
// contacto de la conversación (el capataz no le escribió nada al bot en las
// últimas 24hs), así que Meta exige un Content Template en vez de texto libre.
// Configurable por env var para no tener que tocar código si se recrea el template.
const TEMPLATE_STOCK = process.env.TWILIO_TEMPLATE_STOCK || 'HXc8e60dbab0ff3c5080d1e120d5eeca03';

function mensajeStock(periodo, nombre) {
  const nom = (nombre || '').trim().split(' ')[0] || null;
  const saludo = nom ? `👋 Hola *${nom}*!\n\n` : '👋 Hola!\n\n';
  return saludo +
         `📋 *Stock de maquinaria — ${mesLindo(periodo)}*\n\n` +
         `¿Nos pasás el listado de maquinaria de tu objetivo? Respondé este mismo mensaje ` +
         `con las cantidades y los números de máquina.\n\n` +
         `Ejemplo:\n_3 motoguadañas N° 12, 15 y 21, 1 tractor N° 4, 2 hidrolavadoras_\n\n` +
         `¡Gracias! 🙌\n_EcoService · Logística_`;
}

router.get('/api/stock', auth, async (req, res) => {
  try {
    const periodo = String(req.query.periodo || '').trim() || periodoStockActual();
    const { data: censos, error: e1 } = await supabase
      .from('censos_stock')
      .select('*, objetivos(nombre), capataces(nombre), censos_stock_items(*)')
      .eq('periodo', periodo)
      .order('created_at', { ascending: true });
    if (e1) throw e1;
    const { data: pers, error: e2 } = await supabase
      .from('censos_stock').select('periodo');
    if (e2) throw e2;
    const periodos = [...new Set([periodoStockActual(), ...(pers || []).map(p => p.periodo)])]
      .sort().reverse();

    // Candidatos para pedir stock: objetivos operativos activos, con su capataz
    // y el estado del censo de este período (si ya existe).
    const { data: objs, error: e3 } = await supabase
      .from('objetivos').select('id, nombre, tipo').eq('activo', true).eq('tipo', 'operativo');
    if (e3) throw e3;
    const { data: caps, error: e4 } = await supabase
      .from('capataces').select('nombre, telefono, objetivo_id').eq('activo', true);
    if (e4) throw e4;
    const estadoPorObj = {};
    (censos || []).forEach(c => { estadoPorObj[c.objetivo_id] = c.estado; });
    const candidatos = (objs || []).map(o => {
      const cs = (caps || []).filter(c => c.objetivo_id === o.id && c.telefono);
      return { id: o.id, nombre: o.nombre,
        capataces: cs.map(c => c.nombre),
        sin_capataz: cs.length === 0,
        estado: estadoPorObj[o.id] || null };
    }).sort((a, b) => a.nombre.localeCompare(b.nombre));

    res.json({ periodo, periodos, censos: censos || [], candidatos });
  } catch (err) {
    console.error('stock listar:', err);
    res.status(500).json({ error: 'Error cargando el stock' });
  }
});

// Pide el stock por WhatsApp. Sin objetivo_id: a todos los objetivos operativos
// activos que aún no respondieron el período (crea el censo pendiente si no existe,
// o reenvía si ya estaba pendiente). Con objetivo_id: solo a ese.
router.post('/api/stock/pedir', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const periodo = String(body.periodo || '').trim() || periodoStockActual();

    let qObjs = supabase.from('objetivos').select('id, nombre').eq('activo', true);
    if (Array.isArray(body.objetivo_ids) && body.objetivo_ids.length) {
      qObjs = qObjs.in('id', body.objetivo_ids);   // selección explícita del panel
    } else if (body.objetivo_id) {
      qObjs = qObjs.eq('id', body.objetivo_id);
    } else {
      qObjs = qObjs.eq('tipo', 'operativo');
    }
    const { data: objs, error: e1 } = await qObjs;
    if (e1) throw e1;

    const { data: caps, error: e2 } = await supabase
      .from('capataces').select('id, nombre, telefono, objetivo_id').eq('activo', true);
    if (e2) throw e2;

    const { data: existentes, error: e3 } = await supabase
      .from('censos_stock').select('id, objetivo_id, estado').eq('periodo', periodo);
    if (e3) throw e3;
    const porObj = {};
    (existentes || []).forEach(c => { porObj[c.objetivo_id] = c; });

    let enviados = 0, sinCapataz = 0, yaRespondidos = 0, fallidos = 0;

    for (const o of (objs || [])) {
      const censo = porObj[o.id];
      if (censo && censo.estado === 'respondido') { yaRespondidos++; continue; }
      const capsObj = (caps || []).filter(c => c.objetivo_id === o.id && c.telefono);
      if (!capsObj.length) { sinCapataz++; continue; }

      if (!censo) {
        const { error } = await supabase.from('censos_stock')
          .insert({ periodo, objetivo_id: o.id, estado: 'pendiente', origen: 'manual' });
        if (error) { console.error('stock pedir insert:', error); continue; }
      } else {
        await supabase.from('censos_stock')
          .update({ reenviado_at: new Date().toISOString() }).eq('id', censo.id);
      }
      let algunoOk = false;
      for (const c of capsObj) {
        const ok = await notificarCapatazTemplate(c.telefono, TEMPLATE_STOCK);
        if (ok) algunoOk = true; else fallidos++;
      }
      if (algunoOk) enviados++;
    }
    console.log(`[stock] pedido ${periodo}: enviados=${enviados} sin_capataz=${sinCapataz} ya_respondidos=${yaRespondidos} fallidos=${fallidos}`);
    res.json({ enviados, sin_capataz: sinCapataz, ya_respondidos: yaRespondidos, fallidos });
  } catch (err) {
    console.error('stock pedir:', err);
    res.status(500).json({ error: 'Error pidiendo el stock' });
  }
});

router.post('/api/stock/reenviar/:id', auth, async (req, res) => {
  try {
    const { data: censo, error: e1 } = await supabase
      .from('censos_stock').select('id, periodo, objetivo_id, estado').eq('id', req.params.id).single();
    if (e1 || !censo) throw (e1 || new Error('Censo inexistente'));
    if (censo.estado === 'respondido') return res.json({ enviados: 0, ya_respondido: true });

    const { data: caps, error: e2 } = await supabase
      .from('capataces').select('nombre, telefono')
      .eq('activo', true).eq('objetivo_id', censo.objetivo_id);
    if (e2) throw e2;
    const conTel = (caps || []).filter(c => c.telefono);
    if (!conTel.length) return res.json({ enviados: 0, sin_capataz: true });

    let enviados = 0;
    for (const c of conTel) { if (await notificarCapatazTemplate(c.telefono, TEMPLATE_STOCK)) enviados++; }
    await supabase.from('censos_stock')
      .update({ reenviado_at: new Date().toISOString() }).eq('id', censo.id);
    res.json({ enviados });
  } catch (err) {
    console.error('stock reenviar:', err);
    res.status(500).json({ error: 'Error reenviando el pedido' });
  }
});

// ── STOCK · Inventario oficial y consolidado ──────────────────
// El inventario (stock_objetivo) es lo que la empresa DICE que tiene.
// Se siembra con el primer censo (stock.js) y después se edita a mano acá.
// El desvío = censo del período − inventario oficial.

// Trae el último censo respondido por objetivo (para comparar), del período pedido.
async function censoPorObjetivo(periodo) {
  const { data, error } = await supabase
    .from('censos_stock')
    .select('objetivo_id, censos_stock_items(tipo_equipo, cantidad)')
    .eq('periodo', periodo).eq('estado', 'respondido');
  if (error) throw error;
  const mapa = {};   // objetivo_id -> { tipo -> cantidad }
  (data || []).forEach(c => {
    mapa[c.objetivo_id] = mapa[c.objetivo_id] || {};
    (c.censos_stock_items || []).forEach(i => {
      mapa[c.objetivo_id][i.tipo_equipo] = (mapa[c.objetivo_id][i.tipo_equipo] || 0) + (i.cantidad || 0);
    });
  });
  return mapa;
}

router.get('/api/stock/inventario', auth, async (req, res) => {
  try {
    const periodo = String(req.query.periodo || '').trim() || periodoStockActual();
    const { data: inv, error: e1 } = await supabase
      .from('stock_objetivo').select('*, objetivos(nombre)').order('id');
    if (e1) throw e1;
    const censo = await censoPorObjetivo(periodo);

    const filas = (inv || []).map(r => {
      // Si el objetivo respondió el censo y NO mencionó este tipo, informó 0
      // (no "sin dato"). Solo es null si el objetivo no censó en el período.
      const tiposDelObjetivo = censo[r.objetivo_id];
      const cen = tiposDelObjetivo ? (tiposDelObjetivo[r.tipo_equipo] || 0) : null;
      return {
        id: r.id, objetivo_id: r.objetivo_id,
        objetivo: r.objetivos ? r.objetivos.nombre : '—',
        tipo_equipo: r.tipo_equipo, cantidad: r.cantidad,
        numeros: r.numeros || [], observacion: r.observacion, origen: r.origen,
        censo: cen,
        dif: cen != null ? cen - r.cantidad : null,
      };
    });

    // Huérfanos: tipos que el capataz informó pero que NO tienen línea en el
    // inventario oficial (equipo nuevo, o el objetivo ya tenía otras líneas y la
    // semilla no corre). Se muestran con oficial 0 y botón para incorporarlos.
    const nombres = {};
    (inv || []).forEach(r => { if (r.objetivos) nombres[r.objetivo_id] = r.objetivos.nombre; });
    const faltanNombres = Object.keys(censo).filter(id => !nombres[id]);
    if (faltanNombres.length) {
      const { data: objsN } = await supabase
        .from('objetivos').select('id, nombre').in('id', faltanNombres);
      (objsN || []).forEach(o => { nombres[o.id] = o.nombre; });
    }
    const yaHay = new Set((inv || []).map(r => r.objetivo_id + '|' + r.tipo_equipo));
    Object.entries(censo).forEach(([objId, tipos]) => {
      Object.entries(tipos).forEach(([tipo, cant]) => {
        if (yaHay.has(objId + '|' + tipo)) return;
        filas.push({
          id: null, objetivo_id: objId, objetivo: nombres[objId] || '—',
          tipo_equipo: tipo, cantidad: 0, numeros: [], observacion: null,
          origen: 'huerfano', censo: cant, dif: cant, huerfano: true,
        });
      });
    });
    filas.sort((a, b) => a.objetivo.localeCompare(b.objetivo) || a.tipo_equipo.localeCompare(b.tipo_equipo));

    // Objetivos operativos que todavía no tienen inventario (nunca censaron)
    const { data: objs, error: e2 } = await supabase
      .from('objetivos').select('id').eq('activo', true).eq('tipo', 'operativo');
    if (e2) throw e2;
    const conInv = new Set((inv || []).map(r => r.objetivo_id));
    const sinInventario = (objs || []).filter(o => !conInv.has(o.id)).length;

    const objetivosConDesvio = new Set(filas.filter(f => f.dif != null && f.dif !== 0).map(f => f.objetivo_id));
    const objetivosComparados = new Set(filas.filter(f => f.dif != null).map(f => f.objetivo_id));
    res.json({
      periodo, filas,
      kpis: {
        coinciden:      objetivosComparados.size - objetivosConDesvio.size,
        faltantes:      filas.reduce((s, f) => s + (f.dif != null && f.dif < 0 ? -f.dif : 0), 0),
        sin_inventario: sinInventario,
        huerfanos:      filas.filter(f => f.huerfano).length,
      },
    });
  } catch (err) {
    console.error('stock inventario:', err);
    res.status(500).json({ error: 'Error cargando el inventario' });
  }
});

// Siembra el inventario desde los censos respondidos del período: crea las
// líneas que falten. NO pisa las existentes (idempotente). Cubre los objetivos
// que censaron antes de que existiera el inventario y los tipos nuevos.
router.post('/api/stock/inventario/sembrar', auth, async (req, res) => {
  try {
    const periodo = String((req.body || {}).periodo || '').trim() || periodoStockActual();
    const { data: censos, error: e1 } = await supabase
      .from('censos_stock')
      .select('objetivo_id, censos_stock_items(tipo_equipo, cantidad, numeros, observacion)')
      .eq('periodo', periodo).eq('estado', 'respondido');
    if (e1) throw e1;
    const { data: inv, error: e2 } = await supabase
      .from('stock_objetivo').select('objetivo_id, tipo_equipo');
    if (e2) throw e2;
    const yaHay = new Set((inv || []).map(r => r.objetivo_id + '|' + r.tipo_equipo));

    const nuevas = [];
    (censos || []).forEach(c => {
      (c.censos_stock_items || []).forEach(i => {
        const k = c.objetivo_id + '|' + i.tipo_equipo;
        if (yaHay.has(k)) return;
        yaHay.add(k);   // por si el censo repite el tipo
        nuevas.push({
          objetivo_id: c.objetivo_id, tipo_equipo: i.tipo_equipo,
          cantidad: i.cantidad || 0, numeros: i.numeros || [],
          observacion: i.observacion || null, origen: 'censo',
        });
      });
    });
    if (nuevas.length) {
      const { error } = await supabase.from('stock_objetivo').insert(nuevas);
      if (error) throw error;
    }
    console.log(`[stock] sembrado desde censo ${periodo}: ${nuevas.length} líneas nuevas`);
    res.json({ creadas: nuevas.length });
  } catch (err) {
    console.error('stock sembrar:', err);
    res.status(500).json({ error: 'Error sembrando el inventario' });
  }
});

// Editar / crear / borrar una línea del inventario oficial (a mano, desde el panel).
router.post('/api/stock/inventario/:id?', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const fila = {
      cantidad:       Math.max(0, parseInt(b.cantidad) || 0),
      numeros:        Array.isArray(b.numeros) ? b.numeros.map(String)
                      : String(b.numeros || '').split(',').map(s => s.trim()).filter(Boolean),
      observacion:    b.observacion || null,
      origen:         'manual',
      actualizado_at: new Date().toISOString(),
    };
    if (req.params.id) {
      const { data, error } = await supabase.from('stock_objetivo')
        .update(fila).eq('id', req.params.id).select().single();
      if (error) throw error;
      return res.json(data);
    }
    if (!b.objetivo_id || !b.tipo_equipo) return res.status(400).json({ error: 'Falta objetivo o tipo de equipo' });
    const { data, error } = await supabase.from('stock_objetivo')
      .insert({ ...fila, objetivo_id: b.objetivo_id, tipo_equipo: b.tipo_equipo })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('stock inventario guardar:', err);
    res.status(500).json({ error: 'Error guardando la línea del inventario' });
  }
});

router.delete('/api/stock/inventario/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('stock_objetivo').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('stock inventario borrar:', err);
    res.status(500).json({ error: 'Error borrando la línea' });
  }
});

// Consolidado: toda la maquinaria de EcoService sumada por tipo.
router.get('/api/stock/consolidado', auth, async (req, res) => {
  try {
    const periodo = String(req.query.periodo || '').trim() || periodoStockActual();
    const { data: inv, error: e1 } = await supabase
      .from('stock_objetivo').select('objetivo_id, tipo_equipo, cantidad');
    if (e1) throw e1;
    const censo = await censoPorObjetivo(periodo);

    const porTipo = {};
    const de = t => { if (!porTipo[t]) porTipo[t] = { tipo_equipo: t, oficial: 0, informado: 0, objetivos: new Set() };
      return porTipo[t]; };
    (inv || []).forEach(r => { const t = de(r.tipo_equipo);
      t.oficial += r.cantidad || 0; t.objetivos.add(r.objetivo_id); });
    Object.values(censo).forEach(tipos => {
      Object.entries(tipos).forEach(([tipo, cant]) => { de(tipo).informado += cant; });
    });
    const filas = Object.values(porTipo)
      .map(t => ({ tipo_equipo: t.tipo_equipo, oficial: t.oficial, informado: t.informado,
        dif: t.informado - t.oficial, objetivos: t.objetivos.size }))
      .sort((a, b) => b.oficial - a.oficial);
    res.json({ periodo, filas,
      total_oficial: filas.reduce((s, f) => s + f.oficial, 0),
      total_informado: filas.reduce((s, f) => s + f.informado, 0) });
  } catch (err) {
    console.error('stock consolidado:', err);
    res.status(500).json({ error: 'Error armando el consolidado' });
  }
});

// Histórico de un objetivo: qué informó en cada período.
router.get('/api/stock/historico/:objetivo_id', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('censos_stock')
      .select('periodo, estado, respondido_at, censos_stock_items(tipo_equipo, cantidad, numeros)')
      .eq('objetivo_id', req.params.objetivo_id)
      .eq('estado', 'respondido')
      .order('periodo', { ascending: false });
    if (error) throw error;
    res.json((data || []).map(c => ({
      periodo: c.periodo, respondido_at: c.respondido_at,
      items: c.censos_stock_items || [],
      total: (c.censos_stock_items || []).reduce((s, i) => s + (i.cantidad || 0), 0),
    })));
  } catch (err) {
    console.error('stock historico:', err);
    res.status(500).json({ error: 'Error cargando el histórico' });
  }
});

// Resumen por objetivo: una fila por objetivo operativo con sus totales y desvío.
router.get('/api/stock/objetivos', auth, async (req, res) => {
  try {
    const periodo = String(req.query.periodo || '').trim() || periodoStockActual();
    const { data: objs, error: e1 } = await supabase
      .from('objetivos').select('id, nombre').eq('activo', true).eq('tipo', 'operativo');
    if (e1) throw e1;
    const { data: inv, error: e2 } = await supabase
      .from('stock_objetivo').select('objetivo_id, tipo_equipo, cantidad');
    if (e2) throw e2;
    const { data: censos, error: e3 } = await supabase
      .from('censos_stock')
      .select('objetivo_id, estado, respondido_at, capataces(nombre), censos_stock_items(tipo_equipo, cantidad)')
      .eq('periodo', periodo);
    if (e3) throw e3;

    const invPorObj = {};
    (inv || []).forEach(r => {
      invPorObj[r.objetivo_id] = invPorObj[r.objetivo_id] || { total: 0, tipos: {} };
      invPorObj[r.objetivo_id].total += r.cantidad || 0;
      invPorObj[r.objetivo_id].tipos[r.tipo_equipo] = r.cantidad || 0;
    });
    const cenPorObj = {};
    (censos || []).forEach(c => { cenPorObj[c.objetivo_id] = c; });

    const filas = (objs || []).map(o => {
      const i = invPorObj[o.id] || { total: 0, tipos: {} };
      const c = cenPorObj[o.id];
      const respondio = c && c.estado === 'respondido';
      const tiposCenso = {};
      if (respondio) (c.censos_stock_items || []).forEach(it => {
        tiposCenso[it.tipo_equipo] = (tiposCenso[it.tipo_equipo] || 0) + (it.cantidad || 0);
      });
      const totalCenso = Object.values(tiposCenso).reduce((s, v) => s + v, 0);
      // Desvío por tipo (une los tipos del inventario y los del censo)
      const todos = new Set([...Object.keys(i.tipos), ...Object.keys(tiposCenso)]);
      let conDesvio = 0;
      todos.forEach(t => { if ((tiposCenso[t] || 0) !== (i.tipos[t] || 0)) conDesvio++; });
      return {
        id: o.id, nombre: o.nombre,
        capataz:      c && c.capataces ? c.capataces.nombre : null,
        estado:       c ? c.estado : null,
        respondido_at: c ? c.respondido_at : null,
        oficial:      i.total,
        censo:        respondio ? totalCenso : null,
        dif:          respondio ? totalCenso - i.total : null,
        tipos_desvio: respondio ? conDesvio : null,
        sin_inventario: i.total === 0 && !Object.keys(i.tipos).length,
      };
    }).sort((a, b) => a.nombre.localeCompare(b.nombre));
    res.json({ periodo, filas });
  } catch (err) {
    console.error('stock objetivos:', err);
    res.status(500).json({ error: 'Error cargando los objetivos' });
  }
});

// Ficha completa de un objetivo: inventario + censo del período + histórico.
router.get('/api/stock/objetivo/:id', auth, async (req, res) => {
  try {
    const periodo = String(req.query.periodo || '').trim() || periodoStockActual();
    const objetivoId = req.params.id;

    const { data: obj, error: e0 } = await supabase
      .from('objetivos').select('id, nombre').eq('id', objetivoId).single();
    if (e0) throw e0;
    const { data: inv, error: e1 } = await supabase
      .from('stock_objetivo').select('*').eq('objetivo_id', objetivoId).order('tipo_equipo');
    if (e1) throw e1;
    const { data: censo, error: e2 } = await supabase
      .from('censos_stock')
      .select('*, capataces(nombre), censos_stock_items(*)')
      .eq('objetivo_id', objetivoId).eq('periodo', periodo).maybeSingle();
    if (e2) throw e2;
    const { data: hist, error: e3 } = await supabase
      .from('censos_stock')
      .select('periodo, respondido_at, censos_stock_items(tipo_equipo, cantidad)')
      .eq('objetivo_id', objetivoId).eq('estado', 'respondido')
      .order('periodo', { ascending: false });
    if (e3) throw e3;

    const respondio = censo && censo.estado === 'respondido';
    const tiposCenso = {};
    const numsCenso = {};
    if (respondio) (censo.censos_stock_items || []).forEach(i => {
      tiposCenso[i.tipo_equipo] = (tiposCenso[i.tipo_equipo] || 0) + (i.cantidad || 0);
      numsCenso[i.tipo_equipo] = (i.numeros || []);
    });

    // Filas comparadas: todo lo que está en inventario + lo que informó y no está
    const filas = (inv || []).map(r => ({
      id: r.id, tipo_equipo: r.tipo_equipo, cantidad: r.cantidad,
      numeros: r.numeros || [], observacion: r.observacion, origen: r.origen,
      censo: respondio ? (tiposCenso[r.tipo_equipo] || 0) : null,
      censo_numeros: numsCenso[r.tipo_equipo] || [],
      dif: respondio ? (tiposCenso[r.tipo_equipo] || 0) - r.cantidad : null,
    }));
    const enInv = new Set((inv || []).map(r => r.tipo_equipo));
    Object.entries(tiposCenso).forEach(([t, c]) => {
      if (enInv.has(t)) return;
      filas.push({ id: null, tipo_equipo: t, cantidad: 0, numeros: [],
        censo: c, censo_numeros: numsCenso[t] || [], dif: c, huerfano: true });
    });
    filas.sort((a, b) => a.tipo_equipo.localeCompare(b.tipo_equipo));

    res.json({
      objetivo: obj, periodo, filas,
      censo: censo ? { estado: censo.estado, respondido_at: censo.respondido_at,
        reenviado_at: censo.reenviado_at, id: censo.id,
        capataz: censo.capataces ? censo.capataces.nombre : null } : null,
      historico: (hist || []).map(h => ({
        periodo: h.periodo, respondido_at: h.respondido_at,
        items: h.censos_stock_items || [],
        total: (h.censos_stock_items || []).reduce((s, i) => s + (i.cantidad || 0), 0),
      })),
    });
  } catch (err) {
    console.error('stock ficha objetivo:', err);
    res.status(500).json({ error: 'Error cargando la ficha del objetivo' });
  }
});

// ── Servir el panel (HTML + JS extraído en Fase 3) ────────────
router.get('/panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel.html'));
});
router.get('/panel.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel.js'));
});

module.exports = router;
