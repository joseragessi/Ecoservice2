const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const supabase = require('./supabase');
const supabaseCompras = require('./supabase_compras');
const { notificarCapataz, notificarCapatazTemplate, mensajeEstadoIncidencia, mensajeCierreSinReparar } = require('./notificar');
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
const MODULOS_PANEL = ['dashboard','facturas','insumos','combustible','compras','reparaciones','stock','movimientos','maestros'];
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

// ── Credenciales de app para CAPATACES ────────────────────────
// Lista de capataces con su estado de acceso a la app
router.get('/api/capataces-login', auth, soloAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('capataces')
      .select('id, nombre, usuario, activo, objetivo_id, unidad_id, clave_hash, objetivos(nombre), unidades(patente)')
      .order('nombre');
    if (error) throw error;
    res.json((data || []).map(c => ({
      id: c.id, nombre: c.nombre, usuario: c.usuario || null,
      activo: c.activo !== false, tiene_clave: !!c.clave_hash,
      objetivo: c.objetivos ? c.objetivos.nombre : null,
      patente: c.unidades ? c.unidades.patente : null,
      listo: !!(c.objetivo_id && c.unidad_id),
    })));
  } catch (err) { res.status(500).json({ error: 'Error cargando capataces' }); }
});
// Asignar/actualizar usuario y clave de un capataz (hashea con el SECRET de la app)
router.post('/api/capataces-login', auth, soloAdmin, async (req, res) => {
  try {
    const { id, usuario, clave, activo } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Falta el capataz' });
    const fila = {};
    if (usuario != null) fila.usuario = String(usuario).trim().toLowerCase() || null;
    if (activo != null) fila.activo = !!activo;
    if (clave) fila.clave_hash = hashClave(clave);   // formato de la app (verificarClave)
    if (!Object.keys(fila).length) return res.status(400).json({ error: 'Nada para actualizar' });
    const { error } = await supabase.from('capataces').update(fila).eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('capataces-login save:', err);
    res.status(500).json({ error: err.message && err.message.includes('duplicate') ? 'Ese usuario ya está en uso' : 'Error guardando credenciales' });
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

    const [fact, ins, carg, reps, censos, objs, invFact, repu, viaj] = await Promise.all([
      supabase.from('facturas_proveedor').select('estado, total'),
      supabase.from('pedidos_insumos').select('estado, created_at, objetivos(nombre), capataces(nombre), pedidos_insumos_items(item)'),
      supabase.from('cargas_combustible').select('estado, litros_total, fecha').neq('estado', 'anulada'),
      supabase.from('incidencias').select('estado, prioridad, created_at, fecha_finalizado, equipo_parado, tipo_equipo, tipo_falla, numero_unidad, mecanicos(nombre), equipos(nombre,tipo), objetivos(nombre)'),
      supabase.from('censos_stock').select('periodo, estado').eq('periodo', periodo),
      supabase.from('objetivos').select('id').eq('activo', true).eq('tipo', 'operativo'),
      supabaseCompras.from('facturas').select('*'),
      supabase.from('repuestos_taller').select('id, estado, nota_precio, estado_desde, created_at'),
      supabase.from('viajes_bateas').select('fecha, total_bateas, chofer_id, unidad_id').neq('estado', 'anulado'),
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

    // ═══ DESVÍOS ═══════════════════════════════════════════════
    // Un número solo no dice nada: lo que sirve es contra qué se compara.

    // El mes en curso está incompleto. Comparar sus 14 días contra un mes
    // entero SIEMPRE da caída y no significa nada. Se compara a IGUAL DÍA
    // y se proyecta el cierre con el ritmo de lo que va del mes.
    const hoyCba = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Cordoba' }));
    const diaHoy = hoyCba.getDate();
    const diasDelMes = new Date(hoyCba.getFullYear(), hoyCba.getMonth() + 1, 0).getDate();
    const diaDeFactura = f => {
      const s2 = String(f.fecha_factura || '').trim();
      let m = s2.match(/^\d{4}-\d{2}-(\d{2})/); if (m) return Number(m[1]);
      m = s2.match(/^(\d{1,2})\/\d{1,2}\/\d{4}/); if (m) return Number(m[1]);
      return 99;
    };
    const gastoAntMismoDia = compras
      .filter(f => mesFac(f) === mesAnterior && diaDeFactura(f) <= diaHoy)
      .reduce((x, f) => x + totalFac(f), 0);
    const proyeccion = diaHoy > 0 ? gastoMes * (diasDelMes / diaHoy) : gastoMes;
    // Promedio de los meses cerrados con movimiento (hasta 3)
    const cerrados = evolucion.slice(0, -1).filter(e => e.total > 0).slice(-3);
    const promedio3 = cerrados.length ? cerrados.reduce((a, e) => a + e.total, 0) / cerrados.length : null;

    // Objetivos: lo que importa no es quién gastó más, sino quién se salió de
    // SU propio promedio. Un objetivo grande siempre encabeza la lista; uno
    // que duplicó lo suyo es el que hay que mirar.
    const gastoObjMes = (mes) => {
      const acc = {};
      compras.filter(f => mesFac(f) === mes).forEach(f => {
        const tot = totalFac(f); if (!tot) return;
        const items = f.items || [];
        const montoIt = it => (Number(it.monto_sin_iva) || 0) + (Number(it.monto_iva) || 0);
        const objTotal = (f.totalAssign && f.totalAssign.objetivo) || null;
        if (f.assignmentMode === 'per-item' && f.assignments && items.length) {
          const sumIt = items.reduce((x, it) => x + montoIt(it), 0) || 1;
          items.forEach((it, ix) => {
            const asg = f.assignments[ix] || {};
            const k = asg.objetivo || objTotal || 'Sin asignar';
            acc[k] = (acc[k] || 0) + tot * (montoIt(it) / sumIt);
          });
        } else {
          const k = objTotal || 'Sin asignar';
          acc[k] = (acc[k] || 0) + tot;
        }
      });
      return acc;
    };
    const histObj = {};
    evolucion.slice(0, -1).forEach(e => {
      const g = gastoObjMes(e.mes);
      Object.entries(g).forEach(([k, v]) => { (histObj[k] = histObj[k] || []).push(v); });
    });
    const desviosObjetivo = objetivosGasto.map(o => {
      const hist = histObj[o.nombre] || [];
      const prom = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : null;
      const proy = diaHoy > 0 ? o.total * (diasDelMes / diaHoy) : o.total;
      return { nombre: o.nombre, total: o.total, proyectado: proy, promedio: prom,
               veces: prom ? proy / prom : null, meses_historia: hist.length };
    }).sort((a, b) => (b.veces || 0) - (a.veces || 0));

    // ── Taller: envejecimiento. No alcanza con "13 activas": importa cuántas
    // llevan demasiado tiempo abiertas.
    const diasDesde = iso => Math.floor((Date.now() - new Date(iso)) / 86400000);
    const edades = activas.map(i => diasDesde(i.created_at));
    const envejecimiento = {
      hasta_3: edades.filter(d => d <= 3).length,
      de_4_a_7: edades.filter(d => d > 3 && d <= 7).length,
      de_8_a_15: edades.filter(d => d > 7 && d <= 15).length,
      mas_15: edades.filter(d => d > 15).length,
    };
    // Estancadas: abiertas hace más de 7 días y que NO están esperando
    // repuestos (esas tienen motivo). Son las que se durmieron.
    const estancadas = activas
      .filter(i => diasDesde(i.created_at) > 7 && i.estado !== 'esperando_repuestos')
      .map(i => ({
        equipo: [i.tipo_equipo || 'Equipo', i.numero_unidad ? 'N° ' + i.numero_unidad : ''].filter(Boolean).join(' '),
        estado: i.estado, prioridad: i.prioridad,
        mecanico: i.mecanicos ? i.mecanicos.nombre : 'sin asignar',
        objetivo: i.objetivos ? i.objetivos.nombre : '',
        dias: diasDesde(i.created_at),
      })).sort((a, b) => b.dias - a.dias);

    // ── Plata frenada en el circuito de repuestos
    const repuestos = repu.data || [];
    const esperandoAprob = repuestos.filter(r => r.estado === 'cotizado');
    const repuestosFrenados = {
      cotizados: esperandoAprob.length,
      monto: esperandoAprob.reduce((a, r) => a + (Number(r.nota_precio) || 0), 0),
      sin_cotizar: repuestos.filter(r => r.estado === 'pedido' || r.estado === 'en_cotizacion').length,
      demorados: repuestos.filter(r => ['pedido', 'en_cotizacion', 'cotizado'].includes(r.estado)
        && diasDesde(r.estado_desde || r.created_at) > 3).length,
    };

    // ── Bateas: ritmo del mes contra el anterior a igual día ────
    const viajes = viaj.data || [];
    const diaDeFecha = f => Number(String(f || '').slice(8, 10)) || 99;
    const bateasDe = (mes, hastaDia) => {
      const v = viajes.filter(x => mesDe(x.fecha) === mes && (!hastaDia || diaDeFecha(x.fecha) <= hastaDia));
      const bat = v.reduce((a, x) => a + (Number(x.total_bateas) || 0), 0);
      return { bateas: bat, jornadas: v.length, prom: v.length ? bat / v.length : 0 };
    };
    const batMes = bateasDe(periodo), batAntIgual = bateasDe(mesAnterior, diaHoy), batAntTotal = bateasDe(mesAnterior);
    const bateas = {
      bateas: batMes.bateas, jornadas: batMes.jornadas, prom_jornada: batMes.prom,
      m3: batMes.bateas * 14,
      anterior_mismo_dia: batAntIgual.bateas,
      anterior_total: batAntTotal.bateas,
      prom_anterior: batAntTotal.prom,
      var_pct: batAntIgual.bateas ? ((batMes.bateas - batAntIgual.bateas) * 100 / batAntIgual.bateas) : null,
      proyectado: diaHoy > 0 ? Math.round(batMes.bateas * (diasDelMes / diaHoy)) : batMes.bateas,
    };

    // ── Combustible: litros del mes contra el anterior a igual día ──
    const litrosDe = (mes, hastaDia) => cargas
      .filter(c => mesDe(c.fecha) === mes && (!hastaDia || diaDeFecha(c.fecha) <= hastaDia))
      .reduce((a, c) => a + (Number(c.litros_total) || 0), 0);
    const litMes = litrosDe(periodo), litAntIgual = litrosDe(mesAnterior, diaHoy);
    const combustibleMes = {
      litros: litMes, cargas: cargasMes.length,
      anterior_mismo_dia: litAntIgual, anterior_total: litrosDe(mesAnterior),
      var_pct: litAntIgual ? ((litMes - litAntIgual) * 100 / litAntIgual) : null,
      proyectado: diaHoy > 0 ? litMes * (diasDelMes / diaHoy) : litMes,
      sin_facturar: cuenta(cargas, 'estado', 'sin_facturar'),
    };

    // ── Tiempo de máquina frenada: lo que cuesta de verdad una rotura ──
    // Se mide sobre las incidencias con equipo_parado: cuánto estuvo la
    // máquina sin poder trabajar. Las abiertas cuentan hasta hoy.
    const paradasCerradas = incid.filter(i => i.equipo_parado && i.estado === 'finalizado'
      && mesDe(i.fecha_finalizado) === periodo);
    const dParadas = paradasCerradas.map(i => dias(i.created_at, i.fecha_finalizado)).filter(x => x != null);
    const diasAbiertas = activas.filter(i => i.equipo_parado).reduce((a, i) => a + diasDesde(i.created_at), 0);
    const frenado = {
      prom_dias: dParadas.length ? dParadas.reduce((a, b) => a + b, 0) / dParadas.length : null,
      peor: dParadas.length ? Math.max(...dParadas) : null,
      resueltas_mes: dParadas.length,
      dias_acumulados_abiertas: diasAbiertas,
      parada_mas_vieja: paradas.length ? paradas[0].dias : 0,
    };

    // ── Alertas: lo que hay que mirar hoy. Solo entra lo que tiene una
    // acción concreta detrás, ordenado por urgencia.
    const alertas = [];
    const paradasViejas = paradas.filter(p => p.dias >= 3);
    if (paradasViejas.length) alertas.push({ nivel: 'alto', modulo: 'reparaciones',
      texto: `${paradasViejas.length} máquina(s) parada(s) hace 3 días o más`,
      detalle: paradasViejas.slice(0, 3).map(p => `${p.equipo} (${p.dias} d)`).join(' · ') });
    if (repuestosFrenados.cotizados) alertas.push({ nivel: 'alto', modulo: 'compras',
      texto: `${repuestosFrenados.cotizados} pedido(s) de repuestos esperando tu aprobación`,
      detalle: repuestosFrenados.monto ? '$' + Math.round(repuestosFrenados.monto).toLocaleString('es-AR') + ' frenados' : '' });
    if (estancadas.length) alertas.push({ nivel: 'medio', modulo: 'reparaciones',
      texto: `${estancadas.length} reparación(es) abiertas hace más de 7 días`,
      detalle: estancadas.slice(0, 3).map(e => `${e.equipo} (${e.dias} d)`).join(' · ') });
    if (censoPend) alertas.push({ nivel: 'medio', modulo: 'stock',
      texto: `${censoPend} objetivo(s) no informaron el stock de este mes`, detalle: '' });
    if (cuenta(facturas, 'estado', 'pendiente')) alertas.push({ nivel: 'medio', modulo: 'compras',
      texto: `${cuenta(facturas, 'estado', 'pendiente')} factura(s) sin imputar`, detalle: '' });
    if (sinAsignar > 0) alertas.push({ nivel: 'medio', modulo: 'compras',
      texto: 'Gasto del mes sin objetivo asignado',
      detalle: '$' + Math.round(sinAsignar).toLocaleString('es-AR') + ' que no se puede atribuir' });
    if (insPend.length) alertas.push({ nivel: 'bajo', modulo: 'insumos',
      texto: `${insPend.length} pedido(s) de insumos pendientes`, detalle: '' });
    const ordenNivel = { alto: 0, medio: 1, bajo: 2 };
    alertas.sort((a, b) => ordenNivel[a.nivel] - ordenNivel[b.nivel]);

    res.json({
      periodo,
      dia_del_mes: diaHoy,
      dias_del_mes: diasDelMes,
      alertas,
      desvios: {
        gasto_vs_mismo_dia: gastoAntMismoDia,
        gasto_proyectado: proyeccion,
        promedio_3m: promedio3,
        var_mismo_dia: gastoAntMismoDia ? ((gastoMes - gastoAntMismoDia) * 100 / gastoAntMismoDia) : null,
        var_vs_promedio: promedio3 ? ((proyeccion - promedio3) * 100 / promedio3) : null,
        objetivos: desviosObjetivo,
      },
      envejecimiento,
      estancadas,
      bateas,
      combustible_mes: combustibleMes,
      frenado,
      repuestos_frenados: repuestosFrenados,
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

// Marcar un insumo como COMPRADO en todos los pedidos pendientes que lo piden.
// La agrupación es por nombre normalizado (sin mayúsculas/acentos): "Guantes"
// y "guantes " son el mismo ítem. body: { item, comprado:true|false }
router.post('/api/insumos/comprar', auth, async (req, res) => {
  try {
    const norm = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    const clave = norm((req.body || {}).item);
    if (!clave) return res.status(400).json({ error: 'Falta el ítem' });
    const marcar = (req.body || {}).comprado !== false;
    const { data: pends } = await supabase.from('pedidos_insumos')
      .select('id, estado, pedidos_insumos_items(id, item)')
      .in('estado', ['pendiente', 'en_compra']);
    const ids = [];
    (pends || []).forEach(p => (p.pedidos_insumos_items || []).forEach(i => { if (norm(i.item) === clave) ids.push(i.id); }));
    if (!ids.length) return res.json({ ok: true, actualizados: 0 });
    const { error } = await supabase.from('pedidos_insumos_items')
      .update({ comprado: marcar, comprado_at: marcar ? new Date().toISOString() : null }).in('id', ids);
    if (error) throw error;
    res.json({ ok: true, actualizados: ids.length });
  } catch (err) {
    console.error('insumos comprar:', err.message);
    res.status(500).json({ error: 'No pude marcar el ítem: ' + (err.message || '') + (String(err.message||'').includes('comprado') ? ' — ¿corriste el SQL que agrega la columna comprado?' : '') });
  }
});

router.post('/api/insumos/:id', auth, async (req, res) => {
  try {
    // Si el panel manda items, registra la ENTREGA: cada item queda marcado
    // como entregado (con su cantidad real) o como faltante. NO se borran los
    // no entregados — así se conserva pedido vs entregado y se ve si hubo
    // faltantes. `items` trae {item, cantidad, entregado} por cada material.
    let huboFaltante = false;
    if (Array.isArray(req.body.items)) {
      // Traigo los items actuales para actualizarlos uno a uno por nombre
      const { data: actuales } = await supabase
        .from('pedidos_insumos_items').select('*').eq('pedido_id', req.params.id);
      const mapa = {};
      (actuales || []).forEach(a => { mapa[String(a.item).trim().toLowerCase()] = a; });
      for (const it of req.body.items) {
        const nombre = String(it.item || '').trim();
        if (!nombre) continue;
        const entregado = it.entregado !== false;
        if (!entregado) huboFaltante = true;
        const fila = mapa[nombre.toLowerCase()];
        const campos = {
          cantidad: it.cantidad ? String(it.cantidad).trim() : null,
          entregado,
          cantidad_entregada: entregado ? (it.cantidad ? String(it.cantidad).trim() : null) : null,
        };
        if (fila) {
          await supabase.from('pedidos_insumos_items').update(campos).eq('id', fila.id);
        } else {
          await supabase.from('pedidos_insumos_items')
            .insert({ pedido_id: req.params.id, item: nombre, ...campos });
        }
      }
    }

    const patch = {};
    if (req.body.estado !== undefined) patch.estado = req.body.estado;
    if (req.body.estado === 'entregado') {
      patch.entregado_at = new Date().toISOString();
      if (Array.isArray(req.body.items)) patch.entrega_completa = !huboFaltante;
    }
    const { data, error } = await supabase
      .from('pedidos_insumos').update(patch).eq('id', req.params.id)
      .select('*, capataces(nombre,telefono), objetivos(nombre), pedidos_insumos_items(*)').single();
    if (error) throw error;

    // Aviso al capataz cuando el pedido se entrega
    let notificado = false;
    if (req.body.estado === 'entregado' && data.capataces && data.capataces.telefono) {
      const obj = data.objetivos ? data.objetivos.nombre : (data.objetivo_texto || '—');
      const entregados = (data.pedidos_insumos_items || []).filter(i => i.entregado !== false);
      const faltantes = (data.pedidos_insumos_items || []).filter(i => i.entregado === false);
      const itemsTxt = entregados
        .map(i => `• ${i.item}${i.cantidad ? ' — ' + i.cantidad : ''}`).join('\n');
      const faltaTxt = faltantes.length
        ? `\n⚠️ *No disponible por ahora:*\n${faltantes.map(i => `• ${i.item}`).join('\n')}\n` : '';
      notificado = await notificarCapataz(
        data.capataces.telefono,
        `📦 *Pedido listo para retirar*\n\n` +
        `📍 Objetivo: ${obj}\n` +
        (itemsTxt ? `\n${itemsTxt}\n` : '') +
        faltaTxt +
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

    // Por chofer (jornadas = filas de ese chofer; prom = bateas ÷ jornadas)
    const porChofer = {};
    viajes.forEach(v => {
      const k = v.capataces ? v.capataces.nombre : 'Sin chofer';
      const o = porChofer[k] || (porChofer[k] = { chofer: k, bateas: 0, puntos: 0, jornadas: 0 });
      o.bateas += Number(v.total_bateas) || 0;
      o.puntos += Number(v.puntos_bajada) || 0; o.jornadas++;
    });

    // Por camión / unidad (mismo cálculo, agrupado por patente)
    const porUnidad = {};
    viajes.forEach(v => {
      const k = v.unidades ? v.unidades.patente : (v.patente_raw || 'Sin unidad');
      const o = porUnidad[k] || (porUnidad[k] = { unidad: k, bateas: 0, jornadas: 0 });
      o.bateas += Number(v.total_bateas) || 0; o.jornadas++;
    });

    // Bateas por objetivo. La clave es el objetivo_id cuando la parada
    // matcheó; si no, el nombre NORMALIZADO — así "ucc" y "Ucc" caen en la
    // misma fila aunque todavía no estén corregidas.
    const porObjetivo = {};
    viajes.forEach(v => (v.paradas || []).forEach(p => {
      const nombre = p.objetivo_nombre || 'Sin objetivo';
      const k = p.objetivo_id ? 'id:' + p.objetivo_id : 'txt:' + normObjetivo(nombre);
      const o = porObjetivo[k] || (porObjetivo[k] = { nombre, bateas: 0, sin_objetivo: !p.objetivo_id });
      o.bateas += Number(p.bateas) || 0;
    }));

    // Paradas que no matchearon ningún objetivo: van al panel de pendientes
    // para asignarlas a mano (y de paso aprender el alias).
    const sinObjetivo = [];
    viajes.forEach(v => (v.paradas || []).forEach((p, idx) => {
      if (p.objetivo_id) return;
      sinObjetivo.push({
        viaje_id: v.id,
        idx,
        fecha: v.fecha,
        chofer: v.capataces ? v.capataces.nombre : null,
        texto: p.texto_original || p.objetivo_nombre || '',
        bateas: Number(p.bateas) || 0,
      });
    }));
    sinObjetivo.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

    const prom = (bat, jor) => jor ? Math.round((bat / jor) * 10) / 10 : 0;

    res.json({
      periodo: { desde, hasta },
      kpis: {
        puntos_total: puntosTotal,
        m3_total: bateasTotal * M3_POR_BATEA,
        bateas_total: bateasTotal,
        jornadas_total: jornadas,
        // Promedio real: total de bateas ÷ total de jornadas trabajadas
        bateas_promedio_jornada: prom(bateasTotal, jornadas),
        dias_activos: diasConViajes,
      },
      por_chofer: Object.values(porChofer).map(o => ({
        ...o, m3: o.bateas * M3_POR_BATEA, prom_jornada: prom(o.bateas, o.jornadas),
      })).sort((a, b) => b.prom_jornada - a.prom_jornada),
      por_unidad: Object.values(porUnidad).map(o => ({
        ...o, m3: o.bateas * M3_POR_BATEA, prom_jornada: prom(o.bateas, o.jornadas),
      })).sort((a, b) => b.prom_jornada - a.prom_jornada),
      por_objetivo: Object.values(porObjetivo)
        .map(o => ({ nombre: o.nombre, bateas: o.bateas, m3: o.bateas * M3_POR_BATEA, sin_objetivo: o.sin_objetivo }))
        .sort((a, b) => b.bateas - a.bateas),
      sin_objetivo: sinObjetivo,
    });
  } catch (err) {
    console.error('viajes indicadores:', err);
    res.status(500).json({ error: 'Error calculando indicadores' });
  }
});

// Normaliza un nombre de objetivo para comparar y para guardar alias.
// Tiene que dar EXACTAMENTE lo mismo que normObjetivo() en viajes.js.
function normObjetivo(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// ── Corregir el objetivo de una parada de bateas ──────────────
// El chofer escribe libre por WhatsApp; acá se reasigna contra la lista real.
// Con recordar=true el texto queda como alias y la próxima matchea solo.
// Cargar un viaje a mano desde el panel. El bot lo carga por WhatsApp,
// pero cuando el chofer no lo hizo (o hay que cargar días viejos) tiene
// que poder hacerse desde acá.
router.post('/api/viajes', auth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(b.fecha)) {
      return res.status(422).json({ error: 'Falta la fecha (o el formato no es AAAA-MM-DD)' });
    }
    if (!b.unidad_id) return res.status(422).json({ error: 'Elegí el camión' });
    const paradas = (Array.isArray(b.paradas) ? b.paradas : [])
      .map(p => ({
        objetivo_id: p.objetivo_id || null,
        objetivo_nombre: String(p.objetivo_nombre || '').trim(),
        bateas: Number(p.bateas) || 0,
      }))
      .filter(p => p.objetivo_nombre && p.bateas > 0);
    if (!paradas.length) return res.status(422).json({ error: 'Cargá al menos una parada con bateas' });

    const total = paradas.reduce((a, p) => a + p.bateas, 0);
    const { data: uni } = await supabase.from('unidades').select('patente').eq('id', b.unidad_id).maybeSingle();

    const fila = {
      chofer_id: b.chofer_id || null,
      unidad_id: b.unidad_id,
      patente_raw: uni ? uni.patente : null,
      fecha: b.fecha,
      paradas,
      total_bateas: total,
      puntos_bajada: paradas.length,
    };
    // OJO: viajes_bateas NO tiene `capataz_id` — solo `chofer_id`. El
    // select del dashboard la nombra pero la columna no existe.

    if (b.id) {
      const { error } = await supabase.from('viajes_bateas').update(fila).eq('id', b.id);
      if (error) throw error;
      console.log(`[viajes] editado desde el panel: ${b.fecha} · ${total} bateas`);
      return res.json({ ok: true, id: b.id, total_bateas: total });
    }
    const { data, error } = await supabase.from('viajes_bateas').insert(fila).select().single();
    if (error) throw error;
    console.log(`[viajes] cargado desde el panel: ${b.fecha} · ${uni ? uni.patente : '?'} · ${total} bateas en ${paradas.length} paradas`);
    res.json({ ok: true, id: data.id, total_bateas: total });
  } catch (err) {
    console.error('viaje manual:', err);
    res.status(500).json({ error: 'No pude guardar el viaje: ' + (err.message || '') });
  }
});

// Choferes y camiones para el alta manual
router.get('/api/viajes/opciones', auth, async (req, res) => {
  try {
    const [ch, un, ob] = await Promise.all([
      supabase.from('capataces').select('id, nombre, unidad_id').eq('activo', true).order('nombre'),
      supabase.from('unidades').select('id, patente, marca_modelo').eq('activo', true).order('patente'),
      supabase.from('objetivos').select('id, nombre').eq('activo', true).order('nombre'),
    ]);
    res.json({ choferes: ch.data || [], unidades: un.data || [], objetivos: ob.data || [] });
  } catch (err) {
    res.status(500).json({ error: 'No pude traer las opciones' });
  }
});

router.post('/api/viajes/:id/parada', auth, async (req, res) => {
  try {
    const { idx, objetivo_id, recordar } = req.body || {};
    const i = Number(idx);
    if (!Number.isInteger(i) || i < 0) return res.status(422).json({ error: 'Índice de parada inválido' });
    if (!objetivo_id) return res.status(422).json({ error: 'Falta el objetivo' });

    const { data: obj, error: eObj } = await supabase
      .from('objetivos').select('id, nombre').eq('id', objetivo_id).maybeSingle();
    if (eObj) throw eObj;
    if (!obj) return res.status(422).json({ error: 'Ese objetivo no existe' });

    const { data: viaje, error: eV } = await supabase
      .from('viajes_bateas').select('id, paradas').eq('id', req.params.id).maybeSingle();
    if (eV) throw eV;
    if (!viaje) return res.status(404).json({ error: 'No encontré esa jornada' });

    const paradas = Array.isArray(viaje.paradas) ? viaje.paradas.slice() : [];
    if (!paradas[i]) return res.status(422).json({ error: 'Esa parada ya no existe' });

    const previa = paradas[i];
    // El texto que escribió el chofer: si es la primera corrección lo tomamos
    // del nombre guardado, porque texto_original recién existe desde hoy.
    const textoOriginal = previa.texto_original || previa.objetivo_nombre || '';

    paradas[i] = Object.assign({}, previa, {
      objetivo_id: obj.id,
      objetivo_nombre: obj.nombre,
      texto_original: textoOriginal,
      reconocido: true,
      corregido_por: req.usuario || null,
      corregido_at: new Date().toISOString(),
    });

    const { error: eU } = await supabase
      .from('viajes_bateas').update({ paradas }).eq('id', viaje.id);
    if (eU) throw eU;

    // Aprender el alias. Si falla (tabla sin crear, alias ya tomado por otro
    // objetivo) la corrección de la parada NO se pierde: se avisa y listo.
    let alias = null, alias_error = null;
    const aliasNorm = normObjetivo(textoOriginal);
    if (recordar && aliasNorm && aliasNorm !== normObjetivo(obj.nombre)) {
      const { error: eA } = await supabase.from('objetivos_alias')
        .upsert({
          alias: aliasNorm,
          alias_original: textoOriginal,
          objetivo_id: obj.id,
          creado_por: req.usuario || null,
        }, { onConflict: 'alias' });
      if (eA) alias_error = eA.message; else alias = aliasNorm;
    }

    console.log(`[bateas] parada corregida · viaje ${viaje.id} #${i} · "${textoOriginal}" → ${obj.nombre}` +
      (alias ? ` · alias "${alias}"` : ''));
    res.json({ ok: true, objetivo: obj, alias, alias_error });
  } catch (err) {
    console.error('corregir parada:', err);
    res.status(500).json({ error: 'No pude corregir la parada' });
  }
});

// ── Alias de objetivos ────────────────────────────────────────
// Van bajo /api/viajes a propósito: moduloDeRuta() mandaría /api/objetivos*
// al permiso 'maestros', y esto lo maneja quien usa Bateas.
router.get('/api/viajes/alias', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('objetivos_alias').select('id, alias, alias_original, objetivo_id, creado_por, objetivos(nombre)')
      .order('alias');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'No pude cargar los alias (¿corriste objetivos_alias.sql?)' });
  }
});

router.delete('/api/viajes/alias/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('objetivos_alias').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No pude borrar el alias' });
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
//
// DESDE EL 21-ago cada UNIDAD puede tener su propia frecuencia y esa MANDA
// sobre la del tipo; la del tipo queda como valor por defecto.

/* Suma días SALTEANDO sábados y domingos: "cada 40 días hábiles" son 8
   semanas de trabajo, no 40 corridos (que serían menos de 6 semanas). */
function sumarHabiles(desde, n) {
  const d = new Date(desde);
  let quedan = Math.max(0, Math.round(n));
  while (quedan > 0) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) quedan--;
  }
  return d;
}
/* Si la fecha cae fin de semana se ADELANTA al viernes: el taller no
   trabaja sábado ni domingo, y adelantar es más seguro que atrasar —
   la máquina no arranca el lunes ya vencida. */
function aDiaHabil(f) {
  const d = new Date(f);
  const dow = d.getDay();
  if (dow === 6) d.setDate(d.getDate() - 1);
  else if (dow === 0) d.setDate(d.getDate() - 2);
  return d;
}
function proximoPreventivo(ultimo, intervalo, habiles) {
  if (!ultimo || !intervalo) return null;
  const base = new Date(ultimo);
  if (isNaN(base)) return null;
  const bruto = habiles ? sumarHabiles(base, intervalo)
    : new Date(base.getTime() + intervalo * 86400000);
  return aDiaHabil(bruto);
}
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
      supabase.from('unidades').select('id, codigo, patente, marca_modelo, responsable, tipo_rodado, prev_pospuesto_hasta, prev_pospuesto_at, prev_intervalo_dias, prev_habiles, prev_desde, prev_mecanico_id, prev_tarea, prev_activo, mecanicos:prev_mecanico_id(nombre)')
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
      // La frecuencia de la UNIDAD manda; la del tipo es el valor por defecto
      const propio = u.prev_activo !== false && u.prev_intervalo_dias > 0 ? Number(u.prev_intervalo_dias) : null;
      const intervalo = propio || (c && c.activo !== false ? c.intervalo_dias : null);
      const habiles = propio ? u.prev_habiles !== false : false;   // el del tipo sigue siendo en corridos
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
      // Si la unidad tiene plan propio, el próximo se recalcula salteando
      // fines de semana y corriendo la fecha si cae sábado o domingo.
      if (propio) {
        const base = f || (u.prev_desde ? new Date(u.prev_desde) : null);
        const px = proximoPreventivo(base, propio, habiles);
        if (px && (!proximo || !reprogramado)) proximo = px;
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
        plan_propio: !!propio, habiles, prev_desde: u.prev_desde || null,
        prev_tarea: u.prev_tarea || null, prev_activo: u.prev_activo !== false,
        prev_mecanico_id: u.prev_mecanico_id || null,
        prev_mecanico: u.mecanicos ? u.mecanicos.nombre : null,
        proximo: proximo ? proximo.toISOString() : null,
        incidencia_abierta: (abiertasR.data || []).find(i =>
          normUni(i.numero_unidad) && (normUni(i.numero_unidad) === normUni(u.codigo) || normUni(i.numero_unidad) === normUni(u.patente))
        ) ? (abiertasR.data || []).find(i =>
          normUni(i.numero_unidad) && (normUni(i.numero_unidad) === normUni(u.codigo) || normUni(i.numero_unidad) === normUni(u.patente))
        ).estado : null,
      };
    });
    // Los planes son independientes de `unidades`: cubren cualquier máquina
    // (hidro grúas, motoguadañas), no solo los rodados del semáforo.
    let planes = [];
    try {
      const hoyD = new Date();
      const { data: pl } = await supabase.from('preventivo_planes').select('*, mecanicos(nombre)').eq('activo', true);
      planes = (pl || []).map(p => {
        const px = p.proximo ? new Date(p.proximo)
          : proximoPreventivo(p.ultimo || p.desde, p.intervalo_dias, p.habiles);
        const restan = px ? Math.ceil((px.getTime() - hoyD.getTime()) / 86400000) : null;
        return { ...p, proximo: px ? px.toISOString().slice(0, 10) : null, restan,
          estado: restan == null ? 'sin_service' : restan <= 0 ? 'vencido' : restan <= 3 ? 'por_vencer' : 'al_dia',
          mecanico: p.mecanicos ? p.mecanicos.nombre : null };
      });
    } catch (e) { /* si la tabla todavía no existe, el resto sigue andando */ }

    res.json({ config: cfgR.data || [], rodados, en_curso: abiertasR.data || [], planes });
  } catch (err) {
    console.error('preventivo:', err);
    res.status(500).json({ error: 'Error cargando el preventivo' });
  }
});

// Guardar los intervalos por tipo
// Alta / edición del plan de CUALQUIER máquina. Se identifica por equipo +
// número, igual que las incidencias, así no depende de la tabla unidades.
function normUnidadPlan(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^\s*(numero|num|nro|unidad|interno|n[°ºo]|n)\s*\.?\s*/, '')
    .replace(/[^a-z0-9]/g, '') || 'sn';
}
router.post('/api/reparaciones/preventivo/plan-maquina', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const equipo = String(b.equipo || '').trim();
    if (!equipo) return res.status(422).json({ error: 'Falta el equipo' });
    const dias = Number(b.intervalo_dias);
    if (!(dias > 0)) return res.status(422).json({ error: 'La frecuencia tiene que ser mayor a cero' });

    const habiles = b.habiles !== false;
    const desde = b.desde || null;
    const ultimo = b.ultimo || null;
    const px = proximoPreventivo(ultimo || desde, dias, habiles);

    const fila = {
      equipo, unidad: String(b.unidad || '').trim() || null,
      unidad_norm: normUnidadPlan(b.unidad),
      intervalo_dias: dias, habiles, desde, ultimo,
      proximo: px ? px.toISOString().slice(0, 10) : null,
      mecanico_id: b.mecanico_id || null,
      tarea: String(b.tarea || '').trim() || null,
      objetivo_id: b.objetivo_id || null,
      activo: b.activo !== false,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('preventivo_planes')
      .upsert(fila, { onConflict: 'equipo,unidad_norm' }).select().single();
    if (error) throw error;
    console.log(`[preventivo] plan ${equipo} ${fila.unidad || ''}: cada ${dias} días${habiles ? ' hábiles' : ''} · próximo ${fila.proximo || '—'}`);
    res.json({ ok: true, plan: data });
  } catch (err) {
    console.error('preventivo plan-maquina:', err);
    res.status(500).json({ error: 'No pude guardar el plan: ' + (err.message || '') });
  }
});

// Marcar el service hecho: corre el próximo vencimiento
router.post('/api/reparaciones/preventivo/plan-maquina/:id/realizado', auth, async (req, res) => {
  try {
    const { data: p, error: e0 } = await supabase.from('preventivo_planes')
      .select('*').eq('id', req.params.id).maybeSingle();
    if (e0 || !p) return res.status(404).json({ error: 'Plan inexistente' });
    const hoy = (req.body || {}).fecha || new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Cordoba' });
    const px = proximoPreventivo(hoy, p.intervalo_dias, p.habiles);
    const { data, error } = await supabase.from('preventivo_planes').update({
      ultimo: hoy, proximo: px ? px.toISOString().slice(0, 10) : null, updated_at: new Date().toISOString(),
    }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, plan: data });
  } catch (err) {
    console.error('preventivo realizado:', err);
    res.status(500).json({ error: 'No pude actualizar el plan' });
  }
});

router.delete('/api/reparaciones/preventivo/plan-maquina/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('preventivo_planes').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No pude borrar el plan' });
  }
});

// Alta / edición del plan de preventivo de UNA unidad. La frecuencia se
// carga en días y puede contarse en hábiles (sin fines de semana).
router.post('/api/reparaciones/preventivo/plan', auth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.unidad_id) return res.status(422).json({ error: 'Falta la unidad' });
    const dias = b.intervalo_dias == null || b.intervalo_dias === '' ? null : Number(b.intervalo_dias);
    if (dias != null && !(dias > 0)) return res.status(422).json({ error: 'La frecuencia tiene que ser mayor a cero' });

    const patch = {
      prev_intervalo_dias: dias,
      prev_habiles: b.habiles !== false,
      prev_desde: b.desde || null,
      prev_mecanico_id: b.mecanico_id || null,
      prev_tarea: String(b.tarea || '').trim() || null,
      prev_activo: b.activo !== false,
    };
    const { data, error } = await supabase.from('unidades').update(patch).eq('id', b.unidad_id).select().single();
    if (error) throw error;
    console.log(`[preventivo] plan ${dias ? dias + (patch.prev_habiles ? ' días hábiles' : ' días corridos') : 'sin frecuencia propia'} · unidad ${data.codigo || data.patente || b.unidad_id}`);
    res.json({ ok: true, unidad: data });
  } catch (err) {
    console.error('preventivo plan:', err);
    res.status(500).json({ error: 'No pude guardar el plan: ' + (err.message || '') });
  }
});

// Generar la ORDEN de trabajo del preventivo. José elige el mecánico ANTES
// de crearla, así no aparece una incidencia sin dueño en el Resumen.
router.post('/api/reparaciones/preventivo/generar', auth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.unidad_id) return res.status(422).json({ error: 'Falta la unidad' });
    if (!b.mecanico_id) return res.status(422).json({ error: 'Elegí el mecánico que lo va a hacer' });

    const { data: u, error: e0 } = await supabase.from('unidades')
      .select('*').eq('id', b.unidad_id).maybeSingle();
    if (e0 || !u) return res.status(404).json({ error: 'Unidad inexistente' });

    const vence = b.vence || new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Cordoba' });
    // No generar dos veces la orden del mismo vencimiento
    const { data: yaHay } = await supabase.from('incidencias')
      .select('id').eq('preventivo_unidad_id', b.unidad_id).eq('preventivo_vence', vence)
      .neq('estado', 'finalizado').maybeSingle();
    if (yaHay) return res.status(409).json({ error: 'Ese preventivo ya tiene una orden abierta' });

    const equipo = ROD_LABEL[u.tipo_rodado] || u.tipo_rodado || 'Equipo';
    const { data, error } = await supabase.from('incidencias').insert({
      tipo_equipo: equipo,
      numero_unidad: u.codigo || u.patente || null,
      tipo_falla: 'Preventivo',
      tipo_mant: 'preventivo',
      descripcion: u.prev_tarea || `Service preventivo programado de ${equipo} ${u.codigo || u.patente || ''}`.trim(),
      prioridad: b.prioridad || 'media',
      estado: 'pendiente',
      mecanico_id: b.mecanico_id,
      equipo_parado: false,
      preventivo_unidad_id: u.id,
      preventivo_vence: vence,
    }).select('*, mecanicos(nombre)').single();
    if (error) throw error;
    console.log(`[preventivo] orden generada: ${equipo} ${u.codigo || u.patente || ''} · vence ${vence} · ${data.mecanicos ? data.mecanicos.nombre : ''}`);
    res.json({ ok: true, incidencia: data });
  } catch (err) {
    console.error('preventivo generar:', err);
    res.status(500).json({ error: 'No pude generar la orden: ' + (err.message || '') });
  }
});

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
    // Cada repuesto se cotiza POR SEPARADO: el cable puede venir de un
    // proveedor y el reloj de otro. Por eso proveedor y precio son del ítem.
    const numPrecio = v => {
      if (v == null || v === '') return null;
      const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(',', '.'));
      return isNaN(n) || n <= 0 ? null : n;
    };
    const items = (Array.isArray((req.body || {}).items) ? req.body.items : [])
      .map(i => ({
        descripcion: String(i.descripcion || '').trim(),
        cantidad: Number(i.cantidad) || 1,
        codigo: String(i.codigo || '').trim(),
        proveedor: String(i.proveedor || '').trim() || null,
        precio: numPrecio(i.precio),
      }))
      .filter(i => i.descripcion);
    if (!items.length) return res.status(400).json({ error: 'Cargá al menos un repuesto' });
    const { data: prev } = await supabase.from('repuestos_taller')
      .select('id, items, estado').eq('incidencia_id', req.params.id).neq('estado', 'entregado').maybeSingle();
    // Si se edita un pedido existente, conservar los tildes de "comprado" que
    // ya haya puesto compras (match por descripción)
    if (prev && Array.isArray(prev.items)) {
      const marcados = {};
      prev.items.forEach(i => { if (i.comprado) marcados[String(i.descripcion || '').toLowerCase()] = true; });
      items.forEach(i => { if (marcados[i.descripcion.toLowerCase()]) i.comprado = true; });
    }
    const bb = req.body || {};
    // Quién lo solicita: el mecánico elegido en el modal; si no eligieron,
    // queda el usuario del panel como antes.
    const solicitante = String(bb.solicitante || '').trim();
    const fila = { items, nota: String(bb.nota || '').trim() || null, pedido_por: solicitante || ('Panel · ' + (req.usuario || 'admin')) };
    if (bb.marca_modelo !== undefined) fila.marca_modelo = String(bb.marca_modelo || '').trim() || null;
    // COTIZACIÓN POR ÍTEM: el pedido pasa a 'cotizado' cuando TODOS los
    // repuestos tienen proveedor y precio. Con algunos cotizados y otros no,
    // sigue en pedido — todavía falta averiguar.
    const cotizados = items.filter(i => i.proveedor && i.precio);
    const todosCotizados = items.length > 0 && cotizados.length === items.length;
    // El total y el resumen de proveedores se guardan en los campos que ya
    // lee Compras, para no romper lo que muestra hoy.
    if (cotizados.length) {
      const total = cotizados.reduce((a, i) => a + i.precio * (Number(i.cantidad) || 1), 0);
      const provs = [...new Set(cotizados.map(i => i.proveedor))];
      fila.nota_precio = Math.round(total * 100) / 100;
      fila.nota_proveedor = provs.length === 1 ? provs[0] : provs.join(' · ');
      fila.cotizado_at = new Date().toISOString();
      fila.cotizado_por = req.usuario || 'panel';
      fila.observacion = null;
      if (todosCotizados && (!prev || ['pedido', 'en_cotizacion', 'cotizado'].includes(prev.estado))) {
        fila.estado = 'cotizado'; fila.estado_desde = new Date().toISOString();
      }
      console.log(`[repuestos] ${cotizados.length}/${items.length} cotizados · ${provs.length} proveedor${provs.length === 1 ? '' : 'es'} · total ${total}`);
    }
    let q;
    if (prev) q = supabase.from('repuestos_taller').update(fila).eq('id', prev.id).select().single();
    // También los pedidos cargados desde el panel entran al circuito:
    // nacen en 'pedido' (o directo en 'cotizado' si vino la orden de compra).
    else q = supabase.from('repuestos_taller').insert({ ...fila, incidencia_id: req.params.id, estado: fila.estado || 'pedido', estado_desde: fila.estado_desde || new Date().toISOString() }).select().single();
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

// ── Circuito de repuestos: acciones del REFERENTE desde el PANEL ─────────
// El Referente gestiona desde el panel (decisión 7-ago): tomar, marcar pieza
// en el proveedor y cargar la nota de pedido. Cualquier usuario del panel con
// el módulo puede operar; queda registrado con su nombre.
router.post('/api/compras/repuestos/:id/referente', auth, async (req, res) => {
  try {
    const { data: ped } = await supabase.from('repuestos_taller').select('*').eq('id', req.params.id).single();
    if (!ped) return res.status(404).json({ error: 'Pedido inexistente' });
    const b = req.body || {};
    const ahora = new Date().toISOString();
    const patch = {};
    if (b.accion === 'tomar') {
      if (ped.estado !== 'pedido') return res.status(422).json({ error: 'El pedido no está en estado "pedido".' });
      patch.estado = 'en_cotizacion'; patch.estado_desde = ahora;
      patch.referente_nombre = req.usuario || 'panel';
    } else if (b.accion === 'pieza_proveedor') {
      patch.pieza_en_proveedor = b.quitar ? null : ahora.slice(0, 10);
    } else if (b.accion === 'descripcion') {
      const items = (Array.isArray(b.items) ? b.items : [])
        .map(i => ({ descripcion: String(i.descripcion || '').trim(), cantidad: Number(i.cantidad) || 1, codigo: String(i.codigo || '').trim(), comprado: !!i.comprado }))
        .filter(i => i.descripcion);
      if (!items.length) return res.status(400).json({ error: 'Tiene que quedar al menos un repuesto' });
      patch.items = items;
      if (b.marca_modelo !== undefined) patch.marca_modelo = String(b.marca_modelo || '').trim() || null;
    } else if (b.accion === 'nota') {
      // También se puede corregir una nota ya cargada mientras no esté aprobada
      if (!['pedido', 'en_cotizacion', 'cotizado'].includes(ped.estado)) return res.status(422).json({ error: 'El pedido ya fue aprobado: no se edita la nota.' });
      const proveedor = String(b.proveedor || '').trim();
      const precio = Number(String(b.precio || '').replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.'));
      const plazo = String(b.plazo || '').trim();
      if (!proveedor || !precio || !plazo) return res.status(400).json({ error: 'La nota necesita proveedor, precio y plazo.' });
      patch.nota_proveedor = proveedor; patch.nota_precio = precio; patch.nota_plazo = plazo;
      patch.estado = 'cotizado'; patch.estado_desde = ahora;
      patch.cotizado_at = ahora; patch.cotizado_por = req.usuario || 'panel';
      patch.referente_nombre = ped.referente_nombre || req.usuario || 'panel';
      patch.observacion = null;
    } else {
      return res.status(400).json({ error: 'Acción desconocida' });
    }
    const { data, error } = await supabase.from('repuestos_taller')
      .update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('referente panel:', err.message);
    res.status(500).json({ error: err.message || 'No pude aplicar la acción' });
  }
});

// Eliminar un pedido del circuito (se confundieron, duplicado, etc.).
// Los entregados no se borran: son historial del taller.
router.delete('/api/compras/repuestos/:id', auth, async (req, res) => {
  try {
    const { data: ped } = await supabase.from('repuestos_taller').select('estado').eq('id', req.params.id).single();
    if (!ped) return res.status(404).json({ error: 'Pedido inexistente' });
    if (ped.estado === 'entregado') return res.status(422).json({ error: 'Un pedido entregado no se elimina (es historial).' });
    const { error } = await supabase.from('repuestos_taller').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('repuestos eliminar:', err.message);
    res.status(500).json({ error: 'No pude eliminar el pedido' });
  }
});

// ── Circuito de repuestos: APROBACIÓN (José) ─────────────────────────────
// Aprobar la nota de pedido: cotizado → a_comprar. Protegido con el mismo PIN
// de súper admin que Performance (env PERFORMANCE_PIN): los mecánicos también
// entran al panel y esta es la decisión de gastar.
// Sin PIN (decisión 7-ago): aprueba cualquier usuario del panel con el módulo,
// y queda registrado con su nombre en aprobado_por.
router.post('/api/compras/repuestos/:id/aprobar', auth, async (req, res) => {
  try {
    const { data: ped } = await supabase.from('repuestos_taller').select('estado').eq('id', req.params.id).single();
    if (!ped) return res.status(404).json({ error: 'Pedido inexistente' });
    if (ped.estado !== 'cotizado') return res.status(422).json({ error: 'Solo se aprueban pedidos en estado "cotizado".' });
    const ahora = new Date().toISOString();
    const { data, error } = await supabase.from('repuestos_taller')
      .update({ estado: 'a_comprar', estado_desde: ahora, aprobado_at: ahora, aprobado_por: req.usuario || 'panel' })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('repuestos aprobar:', err.message);
    res.status(500).json({ error: err.message || 'No pude aprobar' });
  }
});

// Observar: devuelve el pedido al Referente con un comentario (→ en_cotizacion).
router.post('/api/compras/repuestos/:id/observar', auth, async (req, res) => {
  try {
    const comentario = String((req.body || {}).comentario || '').trim();
    if (!comentario) return res.status(400).json({ error: 'Escribí qué hay que revisar' });
    const { data: ped } = await supabase.from('repuestos_taller').select('estado').eq('id', req.params.id).single();
    if (!ped) return res.status(404).json({ error: 'Pedido inexistente' });
    if (ped.estado !== 'cotizado') return res.status(422).json({ error: 'Solo se observan pedidos cotizados.' });
    const { data, error } = await supabase.from('repuestos_taller')
      .update({ estado: 'en_cotizacion', estado_desde: new Date().toISOString(), observacion: comentario + ' — ' + (req.usuario || 'panel') })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('repuestos observar:', err.message);
    res.status(500).json({ error: 'No pude devolver el pedido' });
  }
});

// Foto del pedido o adjunto de la nota, para el panel (URL firmada 1 hora)
router.get('/api/compras/repuestos/:id/archivo', auth, async (req, res) => {
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

// PIN de súper admin para la vista Performance (ranking del bono). Los
// mecánicos SÍ entran al panel, así que ocultar el botón no alcanza: la vista
// exige además este PIN, que vive en la env PERFORMANCE_PIN de Railway (fuera
// del código y de la DB). Sin la env seteada, alcanza con ser admin (fail-open
// avisado). Rate limit reusado del login para que no se pueda adivinar.
// ── Puntaje analizado de una reparación ───────────────────────
// Reemplaza la tabla fija de pesos: mira criticidad, falla, lo que el
// mecánico dijo que hizo y los repuestos, y estima HORAS de mano de obra.
// 1 punto ≈ 1 hora. Sin temperature ni prefill (familia 5 los rechaza).
const PUNTOS_MIN = 1, PUNTOS_MAX = 12;

async function analizarPuntaje(id) {
  const { data: inc, error } = await supabase.from('incidencias')
    .select('id, tipo_equipo, numero_unidad, tipo_falla, descripcion, prioridad, equipo_parado, tipo_mant, created_at, fecha_finalizado, comentarios_incidencias(mecanico_nombre,texto), repuestos_taller(items,estado), equipos(nombre)')
    .eq('id', id).maybeSingle();
  if (error) throw error;
  if (!inc) throw new Error('no encontré la incidencia');

  const coms = (inc.comentarios_incidencias || [])
    .map(c => `- ${c.mecanico_nombre || '?'}: ${c.texto}`).join('\n') || '(sin comentarios del taller)';
  const reps = (inc.repuestos_taller || [])
    .map(r => (Array.isArray(r.items) ? r.items : []).map(i => i.descripcion || i.nombre || '').filter(Boolean).join(', '))
    .filter(Boolean).join(' · ') || '(sin repuestos registrados)';

  const prompt = `Sos el jefe de un taller de maquinaria de espacios verdes en Córdoba,
Argentina. Trabajan con motoguadañas, motosierras, extensibles (pértigas),
sopladoras (todas motor 2 tiempos), cortadoras y planas, giro cero y mini
tractores, y vehículos (camionetas, camiones, hidrogrúas, tractores).

Tenés que estimar cuántas HORAS DE MANO DE OBRA de mecánico llevó esta
reparación. No cuentes días de espera de repuestos ni la máquina parada en el
taller: solo el tiempo con las manos en el fierro.

REPARACIÓN
- Equipo: ${inc.tipo_equipo || (inc.equipos ? inc.equipos.nombre : '?')} N° ${inc.numero_unidad || '?'}
- Prioridad asignada: ${inc.prioridad || 'sin definir'}${inc.equipo_parado ? ' · LA MÁQUINA ESTABA PARADA (no podía trabajar)' : ''}
- Tipo: ${inc.tipo_mant || 'correctivo'}
- Falla declarada: ${inc.tipo_falla || 'sin especificar'}
- Descripción del capataz: ${inc.descripcion || '(sin descripción)'}
- Qué hizo el taller: ${coms}
- Repuestos pedidos: ${reps}

CÓMO ESTIMAR
- Guía de referencia: en 2 tiempos chicas, una bujía, una piola o una tanza es
  15-30 min; una carburación o un embrague, 1-2 h; un pistón o motor completo,
  3-4 h. En giro cero o mini tractor, una correa o cuchillas es 1-2 h y una
  hidráulica o transmisión es una jornada entera (6-8 h). En vehículos, un
  service es 2-4 h y frenos o eléctrico complejo, 3-6 h.
- Los COMENTARIOS DEL TALLER y los REPUESTOS mandan sobre la falla declarada:
  es lo que realmente se hizo. Si dicen poco, guiate por la falla y bajá la
  confianza.
- Una prioridad crítica o una máquina parada suele implicar trabajo a
  contrarreloj: podés sumar hasta un 30% por eso, no más.
- Si no hay casi información, estimá lo típico para ese equipo y esa falla y
  poné confianza "baja".

Devolvé SOLO un objeto JSON, sin texto antes ni después y sin markdown:
{"horas": number, "confianza":"alta"|"media"|"baja", "motivo":"una frase corta en criollo explicando de dónde sale la estimación"}`;

  // Primero el modelo rápido (3-6s en vez de 10-20s). Solo si no sirve se
  // reintenta con el grande: en un lote de 40 la diferencia son minutos.
  const pedir = async modelo => {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelo, max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!resp.ok) throw new Error(`API Claude ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const crudo = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
      .replace(/```json/gi, '').replace(/```/g, '').trim();
    try { return JSON.parse(crudo); } catch (e) {
      const a = crudo.indexOf('{'), b = crudo.lastIndexOf('}');
      if (a >= 0 && b > a) { try { return JSON.parse(crudo.slice(a, b + 1)); } catch (e2) { /* nada */ } }
    }
    return null;
  };
  let parsed = null, ultimo = null;
  for (const modelo of [MODEL_FACTURAS_RAPIDO, MODEL_FACTURAS]) {
    try { parsed = await pedir(modelo); } catch (e) { ultimo = e; parsed = null; }
    if (parsed && parsed.horas != null) break;
  }
  if (!parsed || parsed.horas == null) throw new Error(ultimo ? ultimo.message : 'la IA no devolvió una estimación legible');

  const horas = Number(parsed.horas) || 0;
  const puntos = Math.min(PUNTOS_MAX, Math.max(PUNTOS_MIN, Math.round(horas)));
  const patch = {
    puntos_ia: puntos,
    puntos_ia_horas: horas,
    puntos_ia_motivo: String(parsed.motivo || '').slice(0, 400),
    puntos_ia_confianza: parsed.confianza || 'media',
    puntos_ia_at: new Date().toISOString(),
  };
  const { error: eU } = await supabase.from('incidencias').update(patch).eq('id', id);
  if (eU) throw eU;
  console.log(`[puntaje] ${inc.tipo_equipo || '?'} ${inc.numero_unidad || ''} → ${horas}h = ${puntos} pts (${patch.puntos_ia_confianza})`);
  return patch;
}

// Analizar una sola (botón del ranking)
router.post('/api/reparaciones/:id/puntaje', auth, async (req, res) => {
  try { res.json(await analizarPuntaje(req.params.id)); }
  catch (err) {
    console.error('puntaje:', err);
    res.status(500).json({ error: 'No pude analizar: ' + (err.message || err) });
  }
});

// Corrección a mano: si José carga un valor, ese manda sobre el de la IA.
router.post('/api/reparaciones/:id/puntaje-manual', auth, async (req, res) => {
  try {
    const v = req.body && req.body.puntos;
    const patch = (v === null || v === '' || v === undefined)
      ? { puntos_manual: null, puntos_manual_por: null }
      : { puntos_manual: Math.min(PUNTOS_MAX, Math.max(0, Number(v) || 0)), puntos_manual_por: req.usuario || null };
    const { error } = await supabase.from('incidencias').update(patch).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true, puntos_manual: patch.puntos_manual });
  } catch (err) {
    res.status(500).json({ error: 'No pude guardar el puntaje' });
  }
});

// Recalcular el mes: analiza las finalizadas que todavía no tienen puntaje.
// De a una y con tope, para no dispararle 70 llamadas juntas a la API.
router.post('/api/reparaciones/puntaje-lote', auth, async (req, res) => {
  try {
    const desde = String((req.body && req.body.desde) || '').slice(0, 10);
    const forzar = !!(req.body && req.body.forzar);
    let q = supabase.from('incidencias').select('id')
      .eq('estado', 'finalizado').not('fecha_finalizado', 'is', null)
      .order('fecha_finalizado', { ascending: false }).limit(40);
    if (desde) q = q.gte('fecha_finalizado', desde);
    if (!forzar) q = q.is('puntos_ia', null);
    const { data, error } = await q;
    if (error) throw error;

    // De a 5 en paralelo: 40 incidencias pasan de ~5 min a menos de 1.
    // Más concurrencia que esto empieza a comerse el rate limit de la API.
    const CONCURRENCIA = 5;
    let ok = 0, fallaron = 0, ultimoError = null;
    const pendientes = (data || []).slice();
    const t0 = Date.now();
    while (pendientes.length) {
      const tanda = pendientes.splice(0, CONCURRENCIA);
      await Promise.all(tanda.map(async r => {
        try { await analizarPuntaje(r.id); ok++; }
        catch (e) { fallaron++; ultimoError = e.message || String(e); }
      }));
    }
    console.log(`[puntaje] lote de ${ok + fallaron} en ${Math.round((Date.now() - t0) / 1000)}s`);
    res.json({ analizadas: ok, fallaron, pendientes: Math.max(0, (data || []).length - ok - fallaron), error: ultimoError });
  } catch (err) {
    console.error('puntaje-lote:', err);
    res.status(500).json({ error: 'No pude recalcular: ' + (err.message || err) });
  }
});

// Análisis IA de un rebote: ¿la vuelta es atribuible al arreglo anterior?
// Devuelve una SUGERENCIA con motivo — la decisión final la toma el usuario
// con el botón "No atribuir". Sin temperature: los modelos de la familia 5
// no lo aceptan y acá tampoco hace falta.
router.post('/api/reparaciones/rebote-analisis', auth, async (req, res) => {
  try {
    const { base_id, vuelta_id } = req.body || {};
    if (!base_id || !vuelta_id) return res.status(422).json({ error: 'Faltan las incidencias' });

    const traer = async id => {
      const { data, error } = await supabase.from('incidencias')
        .select('id, tipo_equipo, numero_unidad, tipo_falla, descripcion, created_at, fecha_finalizado, equipo_parado, comentarios_incidencias(mecanico_nombre,texto,created_at), repuestos_taller(items,estado), mecanicos(nombre)')
        .eq('id', id).maybeSingle();
      if (error) throw error;
      return data;
    };
    const [base, vuelta] = await Promise.all([traer(base_id), traer(vuelta_id)]);
    if (!base || !vuelta) return res.status(404).json({ error: 'No encontré alguna de las incidencias' });

    const arm = (inc, rol) => {
      const coms = (inc.comentarios_incidencias || [])
        .map(c => `- ${c.mecanico_nombre || '?'}: ${c.texto}`).join('\n') || '(sin comentarios)';
      const reps = (inc.repuestos_taller || [])
        .map(r => (Array.isArray(r.items) ? r.items : []).map(i => i.descripcion || i.nombre || '').filter(Boolean).join(', '))
        .filter(Boolean).join(' · ') || '(sin repuestos registrados)';
      return `${rol}:
- Equipo: ${inc.tipo_equipo || '?'} N° ${inc.numero_unidad || '?'}
- Falla declarada al entrar: ${inc.tipo_falla || 'sin especificar'}
- Descripción: ${inc.descripcion || '(sin descripción)'}
- Comentarios del taller (lo que se hizo): ${coms}
- Repuestos pedidos: ${reps}
- Mecánico: ${inc.mecanicos ? inc.mecanicos.nombre : 'sin asignar'}`;
    };

    const dias = Math.round((new Date(vuelta.created_at) - new Date(base.fecha_finalizado)) / 86400000);
    const prompt = `Sos el jefe de un taller de maquinaria de espacios verdes (motoguadañas,
motosierras, extensibles, sopladoras, tractores). Una máquina volvió al taller
${dias} día(s) después de una reparación y hay que decidir si la vuelta es
ATRIBUIBLE al arreglo anterior (misma causa, arreglo que no duró) o si es un
problema NUEVO/independiente (otra pieza, rotura de uso, mal uso en obra).

${arm(base, 'REPARACIÓN ANTERIOR (finalizada)')}

${arm(vuelta, 'VUELTA AL TALLER (nueva incidencia)')}

Criterio técnico: pensá si lo que se hizo y los repuestos de la primera
reparación tienen relación causal con lo que presenta la vuelta. Un carburador
regulado que vuelve porque no arranca puede ser lo mismo; un trinquete
cambiado que vuelve con el pistón fundido es otra cosa.

Devolvé SOLO un objeto JSON, sin texto antes ni después:
{"atribuible":"si"|"no"|"dudoso","confianza":"alta"|"media"|"baja","motivo":"una o dos frases en criollo, concretas"}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_FACTURAS,
        max_tokens: 400,
        // SIN prefill assistant: los modelos de la familia 5 lo rechazan
        // ("does not support assistant message prefill"). El JSON se pesca
        // del texto con el recorte primera/última llave.
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) {
      const det = await resp.text();
      throw new Error(`API Claude ${resp.status}: ${det.slice(0, 200)}`);
    }
    const data = await resp.json();
    const crudo = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
      .replace(/```json/gi, '').replace(/```/g, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(crudo); } catch (e) {
      const a = crudo.indexOf('{'), b = crudo.lastIndexOf('}');
      if (a >= 0 && b > a) { try { parsed = JSON.parse(crudo.slice(a, b + 1)); } catch (e2) { /* nada */ } }
    }
    if (!parsed || !parsed.atribuible) throw new Error('la IA no devolvió un dictamen legible');

    console.log(`[perf] análisis rebote ${base_id}→${vuelta_id}: ${parsed.atribuible} (${parsed.confianza || '?'})`);
    res.json({ atribuible: parsed.atribuible, confianza: parsed.confianza || 'media', motivo: parsed.motivo || '' });
  } catch (err) {
    console.error('rebote-analisis:', err);
    res.status(500).json({ error: 'No pude analizar: ' + (err.message || err) });
  }
});

// Marcar/desmarcar la incidencia de una vuelta como "no atribuible" al
// arreglo anterior (volvió por otra falla). Afecta solo la calidad del bono.
router.post('/api/reparaciones/:id/rebote', auth, async (req, res) => {
  try {
    const descartar = !!(req.body && req.body.descartar);
    const motivo = String((req.body && req.body.motivo) || '').trim();
    const patch = descartar
      ? { rebote_descartado: true, rebote_motivo: motivo || null,
          rebote_descartado_por: req.usuario || null, rebote_descartado_at: new Date().toISOString() }
      : { rebote_descartado: false, rebote_motivo: null,
          rebote_descartado_por: null, rebote_descartado_at: null };
    const { error } = await supabase.from('incidencias').update(patch).eq('id', req.params.id);
    if (error) throw error;
    console.log(`[perf] rebote ${descartar ? 'descartado' : 'restaurado'} · incidencia ${req.params.id} · por ${req.usuario || '?'}` +
      (motivo ? ` · "${motivo}"` : ''));
    res.json({ ok: true });
  } catch (err) {
    console.error('rebote descartar:', err);
    res.status(500).json({ error: 'No pude guardar (¿corriste rebotes_descarte.sql?)' });
  }
});

router.post('/api/reparaciones/performance-pin', auth, async (req, res) => {
  const envPin = String(process.env.PERFORMANCE_PIN || '').trim();
  if (!envPin) return res.json({ ok: true, sin_pin: true });
  const quien = 'perf|' + (req.usuario || 'panel');
  if (seg.loginBloqueado(req, quien)) {
    return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos.' });
  }
  if (String((req.body || {}).pin || '').trim() === envPin) {
    seg.loginOk(req, quien);
    return res.json({ ok: true });
  }
  seg.loginFallido(req, quien);
  res.status(401).json({ error: 'PIN incorrecto' });
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

    // Al FINALIZAR se dispara el análisis de puntaje en segundo plano: recién
    // ahí están los comentarios y repuestos que le dan sustancia. No se espera
    // la respuesta para no demorar el panel; si falla, queda el log y el botón
    // "Recalcular puntajes" del ranking lo levanta después.
    if (req.body.estado === 'finalizado' && data.tipo_mant !== 'preventivo') {
      analizarPuntaje(req.params.id).catch(e =>
        console.error('[puntaje] falló el automático de', req.params.id, e.message || e));
    }

    // Aviso al capataz en cada avance de estado (diagnóstico, esperando
    // repuestos, en reparación, finalizado), con la última nota del mecánico
    let notificado = false;
    const AVISAN = ['diagnostico', 'esperando_repuestos', 'en_reparacion', 'finalizado'];
    if (AVISAN.includes(req.body.estado) && data.capataces && data.capataces.telefono) {
      // Al FINALIZAR se mandan TODAS las observaciones del taller (es lo que
      // el capataz necesita para saber qué se le hizo al equipo); en los
      // estados intermedios, solo la última, para no repetir en cada aviso.
      let comentario = null;
      try {
        const todas = req.body.estado === 'finalizado';
        let q = supabase.from('comentarios_incidencias')
          .select('texto').eq('incidencia_id', req.params.id)
          .order('created_at', { ascending: todas });
        if (!todas) q = q.limit(1);
        const { data: com } = await q;
        const textos = (com || []).map(c => c.texto).filter(Boolean);
        comentario = todas ? textos : (textos[0] || null);
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
  objetivos: ['nombre', 'ubicacion', 'tipo', 'activo', 'codigo_flexxus', 'grupo_stock'],
  capataces: ['nombre', 'telefono', 'objetivo_id', 'rol', 'activo', 'es_chofer', 'unidad_id', 'usuario'],
  centros_costo: ['nombre', 'activo', 'codigo_flexxus'],
  unidades: ['codigo', 'marca_modelo', 'patente', 'responsable', 'objetivo_id', 'activo', 'tipo_rodado', 'tipo_activo'],
};

function filtrarCampos(tipo, body) {
  const permitidos = CAMPOS_MAESTRO[tipo] || [];
  const out = {};
  for (const k of permitidos) if (body[k] !== undefined) out[k] = body[k] === '' ? null : body[k];
  // La clave de la app nunca se guarda en texto plano. Vacía = no se cambia.
  // Vale para mecánicos/pañol/supervisores Y para capataces (11-ago): los
  // capataces ahora entran a la PWA con usuario propio a cargar combustible.
  if ((tipo === 'mecanicos' || tipo === 'capataces') && body.clave) out.clave_hash = hashClave(String(body.clave));
  if (tipo === 'capataces' && out.usuario) out.usuario = String(out.usuario).trim().toLowerCase();
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
    // El hash de la clave no sale del server: el panel solo necesita saber SI
    // tiene clave puesta, no cuál es.
    res.json((data || []).map(f => {
      if (!f || f.clave_hash === undefined) return f;
      const { clave_hash, ...resto } = f;
      return { ...resto, tiene_clave: !!clave_hash };
    }));
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
// Las facturas guardan casi todo dentro del jsonb `data`, y algunas columnas
// duras de la tabla repiten esos campos. El spread de las columnas va después,
// así que una columna VACÍA pisaba el valor bueno que estaba en `data`: la
// factura quedaba sin fecha_factura y no caía en ningún mes (gasto del mes en
// $0 con facturas cargadas, 14-ago). Ahora las columnas nulas no pisan nada.
function aplanar(row) {
  const { data, ...duros } = row;
  const out = { ...(data || {}) };
  for (const [k, v] of Object.entries(duros)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
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
// ── Clase contable por proveedor (deriva la cuenta en Flexxus) ──────
// Lista las clases disponibles en Flexxus (para el selector)
router.get('/api/compras/clases-proveedor', auth, async (req, res) => {
  try {
    const { listarClasesProveedor } = require('./flexxus');
    const clases = await listarClasesProveedor();
    res.json(clases);
  } catch (err) {
    console.error('clases proveedor:', err);
    res.status(500).json({ error: 'No pude traer las clases de Flexxus: ' + (err.message || '') });
  }
});
// Las clases ya asignadas a proveedores (por CUIT)
router.get('/api/compras/proveedores-clase', auth, async (req, res) => {
  try {
    const { data, error } = await supabaseCompras.from('proveedores_clase')
      .select('*').order('razon_social');
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: 'Error cargando clases de proveedores' }); }
});
// Asignar/actualizar la clase fija de un proveedor
router.post('/api/compras/proveedores-clase', auth, async (req, res) => {
  try {
    const { cuit, razon_social, codigo_clase, clase_descripcion } = req.body || {};
    const cuitL = String(cuit || '').replace(/\D/g, '');
    if (!cuitL) return res.status(400).json({ error: 'Falta el CUIT del proveedor' });
    if (!codigo_clase) return res.status(400).json({ error: 'Falta la clase' });
    const { error } = await supabaseCompras.from('proveedores_clase').upsert({
      cuit: cuitL, razon_social: razon_social || null,
      codigo_clase: String(codigo_clase), clase_descripcion: clase_descripcion || null,
      actualizado_at: new Date().toISOString(),
    }, { onConflict: 'cuit' });
    if (error) throw error;
    // UNIFICACIÓN: intentar actualizar también la ficha del proveedor en
    // Flexxus, para que ambos sistemas queden con la misma clase. Best-effort:
    // si el API no lo permite, la clase igual se aplica en cada imputación.
    let flexxus_sync = null;
    try {
      const { actualizarClaseProveedorFlexxus } = require('./flexxus');
      flexxus_sync = await actualizarClaseProveedorFlexxus(cuitL, String(codigo_clase));
    } catch (e) { flexxus_sync = { ok: false, motivo: String(e.message || '').slice(0, 200) }; }
    res.json({ ok: true, flexxus_sync });
  } catch (err) {
    console.error('proveedor clase save:', err);
    const det = err.message || err.details || err.hint || '';
    const falta = /does not exist|relation.*proveedores_clase/i.test(det);
    res.status(500).json({ error: falta
      ? 'Falta crear la tabla: corré proveedores_clase.sql en la base de COMPRAS (Supabase) y reintentá.'
      : 'Error guardando la clase: ' + det });
  }
});

// NÚCLEO de la imputación (extraído del POST para poder correrlo también en
// segundo plano desde /flexxus-encolar). Devuelve { status, body } con el mismo
// shape que siempre respondió el endpoint — el panel no nota la diferencia.
async function procesarImputacion(id, letraIn, permitirAlta, force, usuario) {
  try {
    const letra = ['A', 'B', 'C'].includes(letraIn) ? letraIn : 'A';
    const { data: fila, error: e0 } = await supabaseCompras.from('facturas')
      .select('*').eq('id', id).single();
    if (e0 || !fila) return { status: 404, body: { error: 'Factura inexistente' } };
    const f = fila.data || {};
    if (f.flexxus && f.flexxus.ok && !force) {
      return { status: 409, body: { error: 'Esta factura ya fue imputada en Flexxus el ' + (f.flexxus.fecha || '') } };
    }
    const { imputarFactura } = require('./flexxus');
    // Clase contable fija del proveedor (si se le asignó una): deriva la cuenta
    // contable en Flexxus. Se busca por CUIT.
    let claseProveedor = null;
    const cuitF = String(f.cuit || '').replace(/\D/g, '');
    if (cuitF) {
      const { data: pc } = await supabaseCompras.from('proveedores_clase')
        .select('codigo_clase').eq('cuit', cuitF).maybeSingle();
      if (pc) claseProveedor = pc.codigo_clase;
    }
    let r;
    try {
      r = await imputarFactura(f, letra, { permitirAlta: !!permitirAlta, claseProveedor });
    } catch (e) {
      if (e.code === 'PROV_NO_EXISTE') return { status: 422, body: { error: e.message, code: 'PROV_NO_EXISTE' } };
      if (e.code === 'NUMERO_INVALIDO') return { status: 422, body: { error: e.message, code: 'NUMERO_INVALIDO' } };
      // Si Flexxus dice que el comprobante YA existe, es que ya está imputado:
      // lo marcamos como tal en vez de mostrar el error técnico.
      if (/ya existe/i.test(e.message || '')) {
        const flexxus = {
          ok: true, fecha: new Date().toISOString(), ya_existia: true,
          tipocomprobante: 'F' + letra,
          numerocomprobante: Number(String(f.numero_factura || '').replace(/\D/g, '')) || null,
          por: usuario || 'panel',
        };
        await supabaseCompras.from('facturas')
          .update({ data: { ...f, flexxus } }).eq('id', id);
        return { status: 200, body: { ok: true, flexxus, ya_existia: true } };
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
      numerocomprobante_fmt: 'F' + String(r.tipocomprobante||'').slice(-1) + ' ' + require('./flexxus').formatearNumeroFlexxus(r.numerocomprobante),
      proveedor_creado: r.proveedor_creado, proveedor_codigo: r.proveedor_codigo,
      proveedor_nombre: r.proveedor_nombre, por: usuario || 'panel',
      centro_costo: centroCosto,
    };
    // VERIFICACIÓN DE CUENTA: no podemos elegir la cuenta por API, pero sí
    // leer a cuál fue el asiento. Si el proveedor es de bienes de uso (clase
    // 016 EQUIPOS/017 MAQUINAS) y el asiento fue a MERCADERIAS, avisamos al
    // instante para corregirlo en Flexxus (en vez de descubrirlo después).
    try {
      const esBienUso = ['016', '017'].includes(String(claseProveedor || ''));
      const na = centroCosto && centroCosto.numeroasiento, ce = centroCosto && centroCosto.codigoejercicio;
      if (esBienUso && na && ce) {
        const { leerCuentasAsiento } = require('./flexxus');
        const cuentas = await leerCuentasAsiento(na, ce);
        const fueMercaderia = cuentas.some(c => /MERCADERIA/i.test(c));
        const fueBienUso = cuentas.some(c => /BIEN.*DE.*USO|BIENES DE USO/i.test(c));
        if (fueMercaderia && !fueBienUso) {
          flexxus.advertencia_cuenta = 'OJO: el proveedor es de bienes de uso (clase ' + claseProveedor +
            ') pero el asiento ' + na + ' fue a MERCADERIAS. Hay que corregir la cuenta en Flexxus (asiento o parametrización).';
        }
      }
    } catch (e) { /* la advertencia es best-effort, no frena la imputación */ }
    await supabaseCompras.from('facturas')
      .update({ data: { ...f, flexxus } }).eq('id', id);
    return { status: 200, body: { ok: true, flexxus } };
  } catch (err) {
    console.error('flexxus imputar:', err.message);
    return { status: 500, body: { error: err.message || 'Error imputando en Flexxus' } };
  }
}

// Endpoint clásico (sincrónico): sigue existiendo tal cual para no romper nada.
router.post('/api/compras/facturas/:id/flexxus', auth, async (req, res) => {
  const b = req.body || {};
  const r = await procesarImputacion(req.params.id, b.letra, b.permitir_alta, b.force, req.usuario);
  res.status(r.status).json(r.body);
});

// ── MOTOR DE IMPUTACIÓN EN SEGUNDO PLANO (10-ago) ────────────────────────────
// El POST + la apropiación + la verificación son de Flexxus y tardan lo que
// tardan. Lo que SÍ se puede hacer es no hacer esperar al usuario: este endpoint
// deja la imputación corriendo en el server y responde AL INSTANTE. El estado
// vive en data.flexxus_job de la factura, así que sobrevive a que el usuario
// cierre la pestaña (Railway procesa igual) y el panel lo consulta por polling.
async function marcarJob(id, job) {
  // Read-modify-write del jsonb: siempre sobre la versión fresca de data,
  // para no pisar el flexxus que el núcleo pudo haber escrito mientras tanto.
  const { data: fila } = await supabaseCompras.from('facturas')
    .select('data').eq('id', id).single();
  if (!fila) return;
  await supabaseCompras.from('facturas')
    .update({ data: { ...(fila.data || {}), flexxus_job: job } }).eq('id', id);
}
router.post('/api/compras/facturas/:id/flexxus-encolar', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    const { data: fila } = await supabaseCompras.from('facturas')
      .select('*').eq('id', id).single();
    if (!fila) return res.status(404).json({ error: 'Factura inexistente' });
    const f = fila.data || {};
    if (f.flexxus && f.flexxus.ok && !b.force)
      return res.status(409).json({ error: 'Esta factura ya fue imputada en Flexxus el ' + (f.flexxus.fecha || '') });
    const j = f.flexxus_job;
    // Candado anti doble imputación: si ya hay un job corriendo (y no quedó
    // colgado de hace más de 5 min), no se encola otro.
    if (j && j.estado === 'en_proceso' && Date.now() - new Date(j.iniciado).getTime() < 5 * 60 * 1000)
      return res.status(409).json({ error: 'Esta factura ya se está imputando (la arrancó ' + (j.por || 'alguien') + ' hace un momento). Esperá que termine.' });
    const job = { estado: 'en_proceso', iniciado: new Date().toISOString(), por: req.usuario || 'panel', letra: b.letra || 'A' };
    await supabaseCompras.from('facturas').update({ data: { ...f, flexxus_job: job } }).eq('id', id);
    // Respuesta INSTANTÁNEA: el trabajo pesado sigue en segundo plano.
    res.json({ ok: true, encolada: true, job });
    // Segundo plano (después de responder). setImmediate para soltar el request.
    setImmediate(async () => {
      const t0 = Date.now();
      let r;
      try { r = await procesarImputacion(id, b.letra, b.permitir_alta, b.force, req.usuario); }
      catch (e) { r = { status: 500, body: { error: e.message || 'Error imputando' } }; }
      const fin = {
        estado: r.status === 200 ? 'ok' : 'error',
        iniciado: job.iniciado, fin: new Date().toISOString(), ms: Date.now() - t0,
        por: job.por, letra: job.letra,
        resultado: r.status === 200 ? r.body : null,
        error: r.status === 200 ? null : (r.body && r.body.error) || 'Error imputando',
        code: (r.body && r.body.code) || null,
      };
      try { await marcarJob(id, fin); }
      catch (e) { console.error('flexxus-encolar/marcarJob:', e.message); }
      console.log('[flexxus-job]', id, fin.estado, fin.ms + 'ms', fin.error || '');
    });
  } catch (err) {
    console.error('flexxus-encolar:', err.message);
    res.status(500).json({ error: err.message || 'No pude encolar la imputación' });
  }
});
// Polling liviano del panel: cómo viene el job de esta factura.
router.get('/api/compras/facturas/:id/flexxus-estado', auth, async (req, res) => {
  try {
    const { data: fila } = await supabaseCompras.from('facturas')
      .select('data').eq('id', req.params.id).single();
    if (!fila) return res.status(404).json({ error: 'Factura inexistente' });
    const f = fila.data || {};
    res.json({ job: f.flexxus_job || null, flexxus: f.flexxus || null });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error consultando el estado' });
  }
});

// Ficha técnica cruda del proveedor en Flexxus (para descubrir el campo de la
// clase de comprobante comparando un proveedor bien configurado vs uno libre)
router.get('/api/compras/proveedor-ficha', auth, async (req, res) => {
  try {
    const cuit = String(req.query.cuit || '').replace(/\D/g, '');
    if (!cuit) return res.status(400).json({ error: 'Falta el CUIT' });
    const { fichaProveedorPorCuit } = require('./flexxus');
    res.json(await fichaProveedorPorCuit(cuit));
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error trayendo la ficha' });
  }
});

// DESTINO CONTABLE de una factura: a qué cuenta va (o fue) en Flexxus.
// Antes de imputar sale de la ficha del proveedor (clase de comprobante +
// rubro); después de imputar se RELEEN las cuentas reales del asiento, que es
// la única verdad (Flexxus puede haber mandado el gasto a otro lado).
router.get('/api/compras/facturas/:id/destino-contable', auth, async (req, res) => {
  const out = { imputada: false, clase: null, rubro: null, rubro_desc: null, cuentas: [], asiento: null };
  try {
    const { data: fila } = await supabaseCompras.from('facturas')
      .select('*').eq('id', req.params.id).single();
    if (!fila) return res.status(404).json({ error: 'Factura inexistente' });
    const f = fila.data || {};
    const cuit = String(f.cuit || '').replace(/\D/g, '');
    const { fichaProveedorPorCuit, listarRubrosBienesUso, leerCuentasAsiento } = require('./flexxus');
    // 1) Lo que dice la ficha del proveedor (lo que VA a pasar al imputar)
    if (cuit) {
      try {
        const fi = await fichaProveedorPorCuit(cuit);
        const pf = (fi && fi.existe && fi.lista) || {};
        if ('clasecomprobante' in pf || pf.tipocomprobante) {
          out.clase = pf.tipocomprobante || (Number(pf.clasecomprobante) === 0 ? 'BIENES DE CAMBIO' : null);
          const cta = String(pf.cuenta || '');
          if (cta && cta !== '0') {
            out.rubro = cta;
            try {
              const rubros = await listarRubrosBienesUso();
              const r = (rubros || []).find(x => x.codigo === cta);
              if (r) out.rubro_desc = r.descripcion;
            } catch (e) { /* el código solo ya sirve */ }
          }
        }
      } catch (e) { out.motivo_ficha = e.message; }
    }
    // 2) Lo que REALMENTE quedó en el asiento (si ya se imputó)
    const fx = f.flexxus || {};
    if (fx.ok) {
      out.imputada = true;
      out.comprobante = fx.numerocomprobante_fmt || fx.numerocomprobante || null;
      out.advertencia = fx.advertencia_cuenta || null;
      const cc = fx.centro_costo || {};
      if (cc.numeroasiento && cc.codigoejercicio) {
        out.asiento = cc.numeroasiento;
        try { out.cuentas = await leerCuentasAsiento(cc.numeroasiento, cc.codigoejercicio); }
        catch (e) { out.motivo_asiento = e.message; }
      }
    }
    res.json(out);
  } catch (err) {
    res.json({ ...out, error: err.message || 'No pude leer el destino contable' });
  }
});

// Rubros de bienes de uso (subcuentas 121… del plan, tal como salen en Flexxus)
router.get('/api/compras/rubros-bienes-uso', auth, async (req, res) => {
  try {
    const { listarRubrosBienesUso } = require('./flexxus');
    res.json(await listarRubrosBienesUso());
  } catch (err) { res.json([]); }
});

// Colocar la clase de comprobante en la ficha del proveedor (solo si está
// libre/en blanco = Bienes de cambio 0). Es la palanca de la cuenta contable.
router.post('/api/compras/proveedor-clase-comprobante', auth, async (req, res) => {
  try {
    const cuit = String((req.body || {}).cuit || '').replace(/\D/g, '');
    const clase = Number((req.body || {}).clase);
    const cuenta = String((req.body || {}).cuenta || '') || null;
    if (!cuit || !clase) return res.status(400).json({ error: 'Falta el CUIT o la clase' });
    const { colocarClaseComprobante } = require('./flexxus');
    res.json(await colocarClaseComprobante(cuit, clase, cuenta));
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error colocando la clase de comprobante' });
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

// ── Reporte financiero contable (para Soledad) ────────────────
// Agrega las facturas del mes: totales (neto/IVA/total), IVA crédito fiscal,
// pagado vs pendiente, estado en Flexxus, y desgloses por clase contable
// (= a qué cuenta va), por objetivo (centro de costo) y por proveedor.
router.get('/api/compras/reporte-financiero', auth, async (req, res) => {
  try {
    const mes = String(req.query.mes || '').slice(0, 7);  // YYYY-MM ('' = todo)
    const [{ data: filas, error: e1 }, { data: clasesProv }] = await Promise.all([
      supabaseCompras.from('facturas').select('*'),
      supabaseCompras.from('proveedores_clase').select('*'),
    ]);
    if (e1) throw e1;
    const mapaClase = {};
    (clasesProv || []).forEach(p => { mapaClase[p.cuit] = p; });

    const fs = (filas || []).map(aplanar).filter(f => {
      if (!mes) return true;
      const ff = String(f.fecha_factura || f.createdAt || '').slice(0, 7);
      return ff === mes;
    });

    const otrosDe = f => (f.otros_conceptos || []).filter(o => !o.exento).reduce((s, o) => s + (Number(o.monto) || 0), 0);
    const totalDe = f => (Number(f.total_sin_iva) || 0) + (Number(f.total_iva) || 0) + otrosDe(f);

    const kpis = { cantidad: fs.length, neto: 0, iva: 0, otros: 0, total: 0,
      pagado: 0, pendiente: 0, iva_credito_a: 0,
      imputadas_flexxus: 0, sin_imputar: 0, cc_ok: 0, cc_pendiente: 0 };
    const porClase = {}, porObjetivo = {}, porProveedor = {};

    for (const f of fs) {
      const neto = Number(f.total_sin_iva) || 0, iva = Number(f.total_iva) || 0;
      const otros = otrosDe(f), total = totalDe(f);
      kpis.neto += neto; kpis.iva += iva; kpis.otros += otros; kpis.total += total;
      if (f.pagada) kpis.pagado += total; else kpis.pendiente += total;
      if ((f.letra || '').toUpperCase() === 'A') kpis.iva_credito_a += iva;
      const flx = f.flexxus || {};
      if (flx.ok) {
        kpis.imputadas_flexxus++;
        const cc = flx.centro_costo || {};
        if (cc.ok) kpis.cc_ok++; else kpis.cc_pendiente++;
      } else kpis.sin_imputar++;

      // Por clase contable (cuenta destino en Flexxus)
      const cuitN = String(f.cuit || '').replace(/\D/g, '');
      const cl = mapaClase[cuitN];
      const kCl = cl ? (cl.codigo_clase + ' · ' + (cl.clase_descripcion || '')) : 'Sin clase asignada';
      porClase[kCl] = porClase[kCl] || { neto: 0, iva: 0, total: 0, cant: 0 };
      porClase[kCl].neto += neto; porClase[kCl].iva += iva; porClase[kCl].total += total; porClase[kCl].cant++;

      // Por objetivo (centro de costo): total o por ítem según cómo se asignó
      if (f.assignmentMode === 'per-item' && f.assignments && Object.keys(f.assignments).length) {
        const items = f.items || [];
        for (const [ix, a] of Object.entries(f.assignments)) {
          if (!a || !a.objetivo) continue;
          const it = items[Number(ix)] || {};
          const m = (Number(it.monto_sin_iva) || 0) + (Number(it.iva) || 0);
          porObjetivo[a.objetivo] = porObjetivo[a.objetivo] || { total: 0, cant: 0 };
          porObjetivo[a.objetivo].total += m; porObjetivo[a.objetivo].cant++;
        }
      } else {
        const obj = (f.totalAssign && f.totalAssign.objetivo) || 'Sin objetivo';
        porObjetivo[obj] = porObjetivo[obj] || { total: 0, cant: 0 };
        porObjetivo[obj].total += total; porObjetivo[obj].cant++;
      }

      // Por proveedor
      const kP = f.proveedor || cuitN || '—';
      porProveedor[kP] = porProveedor[kP] || { total: 0, cant: 0, cuit: cuitN, clase: cl ? cl.codigo_clase : null };
      porProveedor[kP].total += total; porProveedor[kP].cant++;
    }

    const aLista = (o, extra) => Object.entries(o)
      .map(([k, v]) => ({ nombre: k, ...v }))
      .sort((a, b) => b.total - a.total);
    res.json({ mes: mes || 'todo', kpis,
      por_clase: aLista(porClase), por_objetivo: aLista(porObjetivo),
      por_proveedor: aLista(porProveedor).slice(0, 20) });
  } catch (err) {
    console.error('reporte financiero:', err);
    res.status(500).json({ error: 'Error armando el reporte financiero' });
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
// Modelo rápido para el primer intento: resuelve la mayoría de las facturas en
// 3-6s en vez de 12-22s. Si la lectura sale vacía o incompleta, el endpoint
// reintenta solo con MODEL_FACTURAS (sonnet), así no se pierde precisión.
const MODEL_FACTURAS_RAPIDO = process.env.ANTHROPIC_MODEL_FACTURAS_RAPIDO || 'claude-haiku-4-5-20251001';

// Extraer datos de una factura con IA (proxy a Claude, key server-side)
// Pasa el JSON compacto del extractor (claves cortas, ítems como arrays) al
// formato de siempre. Si el modelo responde en el formato largo, lo deja pasar
// tal cual: así un cambio de modelo no rompe la carga.
function expandirFactura(d) {
  if (!d || typeof d !== 'object') return d;
  if ('fecha_factura' in d || 'total_sin_iva' in d) return d;   // formato largo
  const TIPO = { p: 'percepcion', i: 'impuesto', x: 'otro' };
  const num = v => (v == null || v === '' ? null : Number(v));
  const item = x => Array.isArray(x)
    ? { descripcion: x[0] ?? null, monto_sin_iva: num(x[1]) || 0, cantidad: num(x[2]) || 1 }
    : { descripcion: (x && (x.descripcion ?? x.d)) ?? null, monto_sin_iva: num(x && (x.monto_sin_iva ?? x.m)) || 0, cantidad: num(x && (x.cantidad ?? x.q)) || 1 };
  const otro = x => Array.isArray(x)
    ? { concepto: x[0] ?? null, monto: num(x[1]) || 0, tipo: TIPO[x[2]] || x[2] || 'otro' }
    : { concepto: (x && (x.concepto ?? x.c)) ?? null, monto: num(x && (x.monto ?? x.m)) || 0, tipo: TIPO[x && x.tipo] || (x && x.tipo) || 'otro' };
  return {
    fecha_factura: d.f ?? null,
    numero_factura: d.n ?? null,
    letra: d.l ?? null,
    proveedor: d.p ?? null,
    cuit: d.c ?? null,
    total_sin_iva: num(d.tn) || 0,
    total_iva: num(d.ti) || 0,
    // Alícuotas discriminadas: [[21, 103281.87], [10.5, 700777.52]].
    // Muchas facturas de ferretería/agro mezclan 21% y 10,5%; Flexxus
    // acepta varias y hasta ahora se mandaba todo como 21%.
    ivas: Array.isArray(d.iv)
      ? d.iv.map(x => Array.isArray(x)
            ? { porcentaje: num(x[0]) || 0, monto: num(x[1]) || 0 }
            : { porcentaje: num(x && x.porcentaje) || 0, monto: num(x && x.monto) || 0 })
          .filter(x => x.monto)
      : [],
    items: Array.isArray(d.i) ? d.i.map(item) : [],
    otros_conceptos: Array.isArray(d.o) ? d.o.map(otro) : [],
  };
}

// Plan de cuentas completo para sub-seleccionar la cuenta en CUALQUIER clase
// de comprobante (Bienes de uso ya usa /rubros-bienes-uso con el prefijo 121;
// Servicios/Otros/Locaciones/Nacionalizaciones necesitan el resto del plan).
router.get('/api/compras/plan-cuentas', auth, async (req, res) => {
  try {
    const { listarPlanCuentas } = require('./flexxus');
    // ?refrescar=1 saltea la caché de 30 min (útil después de tocar el sondeo:
    // si no, la respuesta cortada seguía viva media hora).
    const forzar = ['1', 'true', 'si'].includes(String(req.query.refrescar || '').toLowerCase());
    const { cuentas, ruta, base, sondeo } = await listarPlanCuentas(forzar);
    const pref = String(req.query.prefijo || '').trim();
    const filtradas = pref ? cuentas.filter(c => c.codigo.startsWith(pref)) : cuentas;
    // Las cuentas de movimiento son las hojas: si el API no marca "imputable",
    // se toman las que no son prefijo de ninguna otra (no tienen hijas).
    const conMarca = filtradas.some(c => c.imputable !== null);
    const hojas = conMarca ? filtradas.filter(c => c.imputable)
      : filtradas.filter(c => !filtradas.some(o => o.codigo !== c.codigo && o.codigo.startsWith(c.codigo)));
    // Diagnóstico: cuántas cuentas por grupo y qué aportó cada variante del
    // sondeo. Sirve para ver de una si el plan vino completo o cortado.
    const por_grupo = {};
    for (const c of cuentas) { const g = c.codigo.slice(0, 3); por_grupo[g] = (por_grupo[g] || 0) + 1; }
    res.json({
      ruta, total: cuentas.length, primera_pagina: base, por_grupo,
      sondeo: (sondeo || []).filter(s => s.nuevas > 0 || s.error),
      cuentas: hojas.length ? hojas : filtradas,
    });
  } catch (err) {
    console.error('plan-cuentas:', err.message);
    res.status(500).json({ error: 'No pude leer el plan de cuentas' });
  }
});

// TODOS los centros de costo de Flexxus (el GET plano suele traer solo los
// activos: por eso LA DESEADA, PROVINCIA y otros aparecen "sin número").
// Cruza contra la tabla centros_costo del panel y dice qué falta de cada lado.
router.get('/api/compras/centroscosto-flexxus', auth, async (req, res) => {
  try {
    const norm = (t) => String(t || '').toUpperCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    const { listarCentrosCostoTodos } = require('./flexxus');
    // forzar: este endpoint es el botón "🔍 Ver códigos en Flexxus" de Maestros,
    // ahí sí se quiere relectura fresca (el resto usa la caché de 6 h).
    const { centros, intentos } = await listarCentrosCostoTodos(true);
    const { data: locales } = await supabase.from('centros_costo').select('nombre, codigo_flexxus, activo');
    const porNombre = new Map((locales || []).map(l => [norm(l.nombre), l]));
    const enFlexxus = centros.map(c => {
      const loc = porNombre.get(norm(c.descripcion));
      return {
        codigo: c.codigo,
        descripcion: c.descripcion,
        activo: c.activo,
        en_panel: !!loc,
        codigo_en_panel: loc ? (loc.codigo_flexxus ?? null) : null,
        coincide: !!(loc && Number(loc.codigo_flexxus) === Number(c.codigo)),
      };
    });
    const nombresFlexxus = new Set(centros.map(c => norm(c.descripcion)));
    const soloEnPanel = (locales || [])
      .filter(l => !nombresFlexxus.has(norm(l.nombre)))
      .map(l => ({ nombre: l.nombre, codigo_flexxus: l.codigo_flexxus ?? null, activo: l.activo }));
    res.json({
      total_flexxus: centros.length,
      intentos,
      centros: enFlexxus,
      sin_codigo_en_panel: enFlexxus.filter(c => c.en_panel && c.codigo_en_panel == null),
      desajustados: enFlexxus.filter(c => c.en_panel && c.codigo_en_panel != null && !c.coincide),
      solo_en_panel: soloEnPanel,
    });
  } catch (err) {
    console.error('centroscosto-flexxus:', err.message);
    res.status(500).json({ error: err.message || 'No pude leer los centros de costo' });
  }
});

// Escribe en la tabla del panel los códigos que faltan (match exacto por
// nombre normalizado). No pisa códigos ya cargados salvo forzar=true.
router.post('/api/compras/centroscosto-sincronizar', auth, async (req, res) => {
  try {
    const forzar = !!(req.body || {}).forzar;
    const norm = (t) => String(t || '').toUpperCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    const { listarCentrosCostoTodos } = require('./flexxus');
    const { centros } = await listarCentrosCostoTodos(true);
    const porNombre = new Map(centros.map(c => [norm(c.descripcion), c.codigo]));
    const { data: locales } = await supabase.from('centros_costo').select('id, nombre, codigo_flexxus');
    const cambios = [];
    for (const l of (locales || [])) {
      const cod = porNombre.get(norm(l.nombre));
      if (cod == null) continue;
      if (l.codigo_flexxus != null && !forzar && Number(l.codigo_flexxus) === Number(cod)) continue;
      if (l.codigo_flexxus != null && !forzar) continue;
      const { error } = await supabase.from('centros_costo').update({ codigo_flexxus: cod }).eq('id', l.id);
      if (!error) cambios.push({ nombre: l.nombre, codigo: cod });
    }
    res.json({ actualizados: cambios.length, cambios });
  } catch (err) {
    console.error('centroscosto-sincronizar:', err.message);
    res.status(500).json({ error: err.message || 'No pude sincronizar' });
  }
});

// Diagnóstico de la API de IA: prueba la key REAL que usa el server (la de
// Railway) con una llamada mínima y muestra sus últimos caracteres, para poder
// compararla con la del console de Anthropic cuando el saldo "está pero no anda"
// (suele ser otra organización o un workspace con límite de gasto en 0).
router.get('/api/compras/diag-ia', auth, async (req, res) => {
  const key = String(process.env.ANTHROPIC_API_KEY || '');
  const out = {
    key_presente: !!key,
    key_termina_en: key ? '…' + key.slice(-6) : null,
    key_largo: key.length,
    modelo_rapido: MODEL_FACTURAS_RAPIDO,
    modelo_respaldo: MODEL_FACTURAS,
    pruebas: [],
  };
  for (const modelo of [MODEL_FACTURAS_RAPIDO, MODEL_FACTURAS]) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelo, max_tokens: 5, messages: [{ role: 'user', content: 'ok' }] }),
      });
      const d = await r.json();
      out.pruebas.push({
        modelo,
        http: r.status,
        ok: !d.error,
        error: d.error ? (d.error.type + ': ' + String(d.error.message || '').slice(0, 160)) : null,
      });
    } catch (e) {
      out.pruebas.push({ modelo, ok: false, error: 'fallo de red: ' + e.message });
    }
  }
  console.log('[diag-ia]', JSON.stringify(out));
  res.json(out);
});

router.post('/api/compras/extract', auth, async (req, res) => {
  const t0 = Date.now();
  try {
    const { fileData, fileType } = req.body || {};
    // Facturas de VARIAS PÁGINAS: llegan como `paginas`, un array de
    // {data, type}. Se mandan todas juntas en el mismo mensaje — el modelo
    // lee la factura completa y devuelve UN solo JSON. Compatible con el
    // envío de una sola página de siempre.
    const paginas = Array.isArray(req.body && req.body.paginas) && req.body.paginas.length
      ? req.body.paginas
      : (fileData ? [{ data: fileData, type: fileType }] : []);
    if (!paginas.length) return res.status(400).json({ error: 'Falta el archivo' });
    if (paginas.length > 6) return res.status(422).json({ error: 'Máximo 6 páginas por factura' });

    const aParte = (pg) => {
      const esImg = pg.type && String(pg.type).startsWith('image/');
      return esImg
        ? { type: 'image',    source: { type: 'base64', media_type: pg.type, data: pg.data } }
        : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pg.data } };
    };
    const partes = paginas.map(aParte);
    const part = partes[0];   // compatibilidad con el resto del handler
    // FORMATO COMPACTO: claves de 1-2 letras y los ítems como arrays. El
    // grueso del tiempo de extracción son los tokens que el modelo ESCRIBE;
    // con este formato una factura de 10 ítems escribe la mitad. Se remapea
    // acá abajo al formato de siempre, así el resto del sistema no cambia.
    const prompt = (partes.length > 1
        ? `Te paso ${partes.length} imágenes: son las PÁGINAS DE UNA MISMA FACTURA, en orden. ` +
          'Leelas todas juntas como un solo documento: los ítems se acumulan de todas las páginas y ' +
          'los totales están en la última. Cabecera (proveedor, CUIT, número, fecha) una sola vez, ' +
          'sin repetir. Devolvé UN SOLO JSON para la factura completa.\n\n'
        : '') +
      'Leé esta factura argentina y devolvé ÚNICAMENTE este JSON, sin backticks ni texto:\n' +
      '{"f":"YYYY-MM-DD","n":"numero","l":"A|B|C","p":"razon social emisor","c":"cuit emisor",' +
      '"tn":neto_sin_iva,"ti":iva_total,"iv":[[porcentaje,monto]],' +
      '"i":[["descripcion",monto_sin_iva,cantidad]],' +
      '"o":[["concepto",monto,"p|i|x"]]}\n' +
      'Reglas:\n' +
      '- Números sin separador de miles. Campo ilegible: null. Sin ítems: "i":[]. Sin otros: "o":[].\n- cantidad = la CANTIDAD facturada del ítem (columna Cant./Un.). Si no figura o es ilegible: 1. El monto_sin_iva sigue siendo el TOTAL del renglón, NO el precio unitario.\n' +
      '- "p": razón social del EMISOR transcripta EXACTA carácter por carácter (si dice COCCONI es ' +
      'COCCONI, no corrijas apellidos). Nunca el nombre de fantasía/logo si figura la razón social. ' +
      'ECOSERVICE (CUIT 30-70793029-9) es el CLIENTE: jamás va como emisor ni su CUIT en "c".\n' +
      '- "c": CUIT del emisor, dígito por dígito.\n' +
      '- "l": la letra sola impresa en el recuadro grande del centro (C = monotributista). Si no se ve, null.\n' +
      '- PROHIBIDO tomar como ítem o concepto las líneas de TOTALES del pie ("Subtotal", "Total", ' +
      '"Importe Total", "Total a pagar", "Neto Gravado", "IVA 21%", "Importe Otros Tributos"): son ' +
      'sumas de lo anterior, meterlas duplica la factura.\n' +
      '- Los datos fiscales del encabezado (CUIT, Ingresos Brutos, Inicio de Actividades, condición ' +
      'IVA, CAE) son identificación, NUNCA montos.\n' +
      '- Cada ítem lleva SOLO su importe sin IVA. El IVA no va por ítem.\n' +
      '- "iv" = las ALÍCUOTAS DE IVA discriminadas en el pie, una por cada tasa distinta: ' +
      '[[21,103281.87],[10.5,700777.52]]. Muchas facturas tienen DOS (21% y 10,5%) y hay que ' +
      'traer las dos por separado, con su porcentaje exacto. "ti" sigue siendo la SUMA de todas. ' +
      'Si hay una sola alícuota igual poné "iv":[[21,monto]]. Factura C o sin IVA: "iv":[].\n' +
      '- Factura C: no discrimina IVA → "ti":0 y el importe completo de cada ítem en su monto.\n' +
      '- La suma de los montos de "i" tiene que dar "tn".\n' +
      '- "o" = SOLO cargos extra reales que no son neto ni IVA: percepciones (IIBB de cualquier ' +
      'provincia, percepción IVA, ganancias) → "p"; impuestos/tasas (sellados, tasa SSN, servicios ' +
      'sociales, gastos notariales, impuestos internos, tasa municipal) → "i"; el resto ' +
      '(bonificaciones y descuentos con monto negativo) → "x". El concepto, tal como figura.\n' +
      '- La suma de los montos de "iv" tiene que dar "ti".\n' +
      '- VERIFICACIÓN FINAL: tn + ti + suma de "o" tiene que dar EXACTAMENTE el "Importe Total" ' +
      'impreso. Si no cierra, casi siempre metiste un subtotal como concepto: corregilo antes de responder.';
    // Parseo a prueba de balas: el modelo puede devolver el JSON tal cual, o
    // repetir la llave del prefill ("{{…}"), o envolverlo en backticks, o
    // dejar texto colgado. Se prueban todas las variantes antes de rendirse.
    function parseJsonFactura(bruto) {
      const base = String(bruto || '').replace(/```json|```/g, '').trim();
      const candidatos = [];
      const empuja = (t) => {
        t = String(t || '').trim();
        if (!t) return;
        candidatos.push(t);
        const i = t.indexOf('{'), f = t.lastIndexOf('}');
        if (i >= 0 && f > i) candidatos.push(t.slice(i, f + 1));
      };
      empuja(base);                                    // ya viene completo
      empuja('{' + base);                              // faltaba la llave del prefill
      empuja(base.replace(/^\{+/, '{'));               // llegó duplicada: {{…}
      empuja('{' + base.replace(/^\{+/, ''));
      for (const c of candidatos) {
        try { const o = JSON.parse(c); if (o && typeof o === 'object') return o; } catch (e) {}
      }
      return null;
    }

    // Un intento contra un modelo. PREFILL '{': el modelo arranca obligado
    // dentro del JSON, así no puede contestar en prosa ("No puedo leer…"),
    // que era la causa real de "No se pudo extraer" (respuestas de ~125 tokens).
    async function intentoExtraccion(modelo) {
      const t1 = Date.now();
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model:      modelo,
          max_tokens: 2500,   // con el formato compacto sobra para 30+ ítems
          temperature: 0,
          messages: [
            // Texto ANTES que la imagen y con cache_control: las reglas son
            // estáticas, así que de la 2ª factura de la tanda en adelante el
            // modelo las toma de caché en vez de reprocesarlas (ventana ~5 min).
            { role: 'user',      content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }, ...partes] },
            { role: 'assistant', content: '{' },
          ],
        }),
      });
      const data = await resp.json();
      const crudo = (data.content || []).map(c => c.text || '').join('');
      console.log(`[factura] ${modelo} en ${((Date.now() - t1) / 1000).toFixed(1)}s ` +
        `(${paginas.length > 1 ? paginas.length + ' págs, ' : ''}` +
        `${Math.round(paginas.reduce((a, p) => a + String(p.data || '').length, 0) * 0.75 / 1024)} KB, ` +
        `${(data.usage && data.usage.input_tokens) || '?'} in / ${(data.usage && data.usage.output_tokens) || '?'} out` +
        ((data.usage && data.usage.cache_read_input_tokens) ? `, ${data.usage.cache_read_input_tokens} de caché` : '') + ')');
      if (data.error) {
        const det = (data.error.message || JSON.stringify(data.error)).slice(0, 160);
        console.error('[factura] error de API con ' + modelo + ': ' + det);
        ultimoMotivo = modelo + ': ' + det;
        return null;
      }
      if (data.stop_reason && data.stop_reason !== 'end_turn') {
        console.error('[factura] stop_reason con ' + modelo + ': ' + data.stop_reason);
        if (data.stop_reason === 'max_tokens') ultimoMotivo = 'la respuesta se cortó por largo';
      }
      const obj = parseJsonFactura(crudo);
      if (!obj) {
        console.error('[factura] respuesta no parseable con ' + modelo + ': ' + JSON.stringify(String(crudo).slice(0, 400)));
        ultimoMotivo = 'respuesta no interpretable: ' + String(crudo).replace(/\s+/g, ' ').slice(0, 120);
        return null;
      }
      try {
        return expandirFactura(obj);
      } catch (e) {
        console.error('[factura] expandirFactura falló:', e.message);
        ultimoMotivo = 'estructura inesperada en la respuesta';
        return null;
      }
    }
    let ultimoMotivo = '';
    // ¿La lectura sirve? Sin proveedor y sin números no hay nada que guardar.
    const sirve = (p) => !!(p && (p.proveedor || p.cuit) &&
      (p.numero_factura || Number(p.total_sin_iva) > 0 || (p.items || []).length));

    let parsed = await intentoExtraccion(MODEL_FACTURAS_RAPIDO);
    if (!sirve(parsed)) {
      console.log('[factura] primer intento insuficiente → reintento con ' + MODEL_FACTURAS);
      const segundo = await intentoExtraccion(MODEL_FACTURAS);
      if (sirve(segundo) || !parsed) parsed = segundo;
    }
    console.log(`[factura] total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (!sirve(parsed)) {
      return res.json({ __error: (parsed
        ? 'No pude leer los datos de esta factura (¿foto borrosa o cortada?). Cargala a mano o probá con una imagen más nítida.'
        : 'La lectura automática falló. Completá los campos a mano.')
        + (ultimoMotivo ? ' [' + ultimoMotivo + ']' : '') });
    }
    {
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
    const { fileData, fileType, fileName, paginasExtra, ...datos } = inv;
    const comp = await subirComprobante(fileData, fileType, fileName);
    if (comp) datos.comprobante = comp;
    // Facturas de varias hojas: la 1ª es el comprobante principal y el resto
    // quedan como páginas adicionales, así el respaldo está completo.
    if (Array.isArray(paginasExtra) && paginasExtra.length) {
      const extra = [];
      for (let i = 0; i < paginasExtra.length && i < 5; i++) {
        const pg = paginasExtra[i];
        const c = await subirComprobante(pg.data, pg.type, pg.name || `pagina-${i + 2}`);
        if (c) extra.push(c);
      }
      if (extra.length) datos.comprobante_paginas = extra;
    }

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

// ANULAR en Flexxus el comprobante de una factura ya imputada. No borra nada
// del panel: devuelve si Flexxus la anuló (verificado releyendo el asiento) o
// el detalle de por qué no pudo, y el panel decide qué hacer.
router.post('/api/compras/facturas/:id/flexxus-anular', auth, async (req, res) => {
  try {
    const { data: fila } = await supabaseCompras.from('facturas')
      .select('*').eq('id', req.params.id).single();
    if (!fila) return res.status(404).json({ error: 'Factura inexistente' });
    const f = fila.data || {};
    if (!f.flexxus || !f.flexxus.ok) return res.status(422).json({ error: 'La factura no está imputada en Flexxus.' });
    const { anularComprobanteCompra } = require('./flexxus');
    const r = await anularComprobanteCompra(f);
    if (r.ok) {
      // Queda registrado por si no se borra la factura del panel
      const flexxus = { ...f.flexxus, anulada: true, anulada_at: new Date().toISOString(), anulada_por: req.usuario || 'panel', anulada_via: r.via };
      await supabaseCompras.from('facturas').update({ data: { ...f, flexxus } }).eq('id', req.params.id);
    }
    res.json(r);
  } catch (err) {
    console.error('flexxus anular:', err.message);
    res.status(500).json({ error: err.message || 'No pude anular el comprobante en Flexxus' });
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

// PASO DE REVISIÓN del centro de costo ANTES de imputar. Una vez imputada la
// factura ya no se puede editar, así que acá se muestra exactamente el reparto
// que se va a mandar, con el código de cada objetivo CONTRASTADO contra la
// lista real de centros de costo de Flexxus.
router.get('/api/compras/facturas/:id/centrocosto-preview', auth, async (req, res) => {
  try {
    const { data: fila } = await supabaseCompras.from('facturas')
      .select('*').eq('id', req.params.id).single();
    if (!fila) return res.status(404).json({ error: 'Factura inexistente' });
    const f = fila.data || {};
    const { repartoCentroCosto, listarCentrosCostoTodos } = require('./flexxus');
    const { data: objs } = await supabase.from('centros_costo').select('nombre, codigo_flexxus');
    const r = repartoCentroCosto(f, objs || []);
    // Contraste contra Flexxus: que el código exista y con qué nombre figura allá
    let centrosFlx = null, motivoFlx = null;
    // Lista COMPLETA: el GET plano pagina en 42 y marcaba como inexistentes
    // códigos válidos (LA DESEADA 57, PROVINCIA 62) — falso positivo.
    try { centrosFlx = (await listarCentrosCostoTodos()).centros; }
    catch (e) { motivoFlx = e.message; }
    const total = (Number(f.total_sin_iva) || 0);
    const pesoTot = (r.reparto || []).reduce((s, x) => s + (Number(x.peso) || 0), 0) || 1;
    const filas = (r.reparto || []).map(x => {
      const enFlx = centrosFlx ? centrosFlx.find(c => c.codigo === Number(x.codigocentrocosto)) : null;
      return {
        objetivo: x.objetivo,
        codigo: x.codigocentrocosto,
        porcentaje: x.porcentaje,
        monto: Math.round(total * (Number(x.peso) || 0) / pesoTot * 100) / 100,
        nombre_flexxus: enFlx ? enFlx.descripcion : null,
        existe: centrosFlx ? !!enFlx : null,
      };
    });
    res.json({
      ok: r.ok, motivo: r.motivo || null, sin_codigo: r.sin_codigo || [],
      modo: f.assignmentMode === 'per-item' ? 'per-item' : 'total',
      reparto: filas,
      suma: Math.round(filas.reduce((s, x) => s + (Number(x.porcentaje) || 0), 0) * 100) / 100,
      flexxus_leido: !!centrosFlx, motivo_flexxus: motivoFlx,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'No pude armar la vista previa del centro de costo' });
  }
});

// TODO EL PREVIO DE UNA (10-ago): el panel hacía 4 viajes EN SERIE antes de
// imputar — flexxus-preview → proveedor-ficha → rubros-bienes-uso →
// centrocosto-preview — y cada uno vuelve a hablar con Flexxus. Acá se resuelven
// EN PARALELO en el server (que está al lado de Flexxus) y viajan juntos al
// navegador. El panel lo dispara APENAS abre el detalle de la factura, así que
// cuando se aprieta "Imputar" la data ya está y el modal abre al instante.
router.get('/api/compras/facturas/:id/flexxus-previo', auth, async (req, res) => {
  const t0 = Date.now();
  try {
    const { data: fila } = await supabaseCompras.from('facturas')
      .select('*').eq('id', req.params.id).single();
    if (!fila) return res.status(404).json({ error: 'Factura inexistente' });
    const f = fila.data || {};
    const letra = String(req.query.letra || f.letra || 'A').toUpperCase();
    const flx = require('./flexxus');
    const cuitP = String(f.cuit || '').replace(/\D/g, '');

    // Todo junto: nada de esto depende de lo otro. Cada parte se cronometra
    // (partes_ms en la respuesta) para ver de una dónde se va el tiempo.
    const partes_ms = {};
    const medir = (nombre, p) => { const t = Date.now(); return p.finally(() => { partes_ms[nombre] = Date.now() - t; }); };
    const [prev, claseAsig, ficha, rubros, plan, objs, ccFlx] = await Promise.all([
      medir('preview', flx.verificarImputacion(f, letra).catch(e => ({ __error: e.message, __code: e.code || null }))),
      cuitP ? supabaseCompras.from('proveedores_clase').select('codigo_clase, clase_descripcion')
        .eq('cuit', cuitP).maybeSingle().then(r => r.data || null).catch(() => null) : null,
      cuitP ? medir('ficha', flx.fichaProveedorPorCuit(cuitP).catch(() => null)) : null,
      medir('rubros', flx.listarRubrosBienesUso().catch(() => [])),
      medir('plan', flx.listarPlanCuentas().catch(() => ({ cuentas: [] }))),
      supabase.from('centros_costo').select('nombre, codigo_flexxus').then(r => r.data || []).catch(() => []),
      medir('centros', flx.listarCentrosCostoTodos().then(r => r.centros).catch(() => null)),
    ]);

    // Preview (mismo shape que /flexxus-preview, para que el panel no cambie)
    const preview = (prev && prev.__error) ? null : { ...prev, clase_asignada: claseAsig, cuit_norm: cuitP || null };

    // Centro de costo: mismo cálculo que /centrocosto-preview
    const r = flx.repartoCentroCosto(f, objs);
    const total = Number(f.total_sin_iva) || 0;
    const pesoTot = (r.reparto || []).reduce((s, x) => s + (Number(x.peso) || 0), 0) || 1;
    const filas = (r.reparto || []).map(x => {
      const enFlx = ccFlx ? ccFlx.find(c => c.codigo === Number(x.codigocentrocosto)) : null;
      return {
        objetivo: x.objetivo, codigo: x.codigocentrocosto, porcentaje: x.porcentaje,
        monto: Math.round(total * (Number(x.peso) || 0) / pesoTot * 100) / 100,
        nombre_flexxus: enFlx ? enFlx.descripcion : null,
        existe: ccFlx ? !!enFlx : null,
      };
    });

    // Plan de cuentas: solo las cuentas de movimiento (mismas reglas que /plan-cuentas)
    const cuentas = (plan && plan.cuentas) || [];
    const conMarca = cuentas.some(c => c.imputable !== null);
    const hojas = conMarca ? cuentas.filter(c => c.imputable)
      : cuentas.filter(c => !cuentas.some(o => o.codigo !== c.codigo && o.codigo.startsWith(c.codigo)));

    res.json({
      letra,
      preview,
      preview_error: prev && prev.__error ? prev.__error : null,
      preview_code: prev && prev.__code ? prev.__code : null,
      ficha: ficha && ficha.existe && ficha.lista ? ficha.lista : null,
      rubros: Array.isArray(rubros) ? rubros : [],
      plan: { total: cuentas.length, cuentas: hojas.length ? hojas : cuentas },
      centrocosto: {
        ok: r.ok, motivo: r.motivo || null, sin_codigo: r.sin_codigo || [],
        modo: f.assignmentMode === 'per-item' ? 'per-item' : 'total',
        reparto: filas,
        suma: Math.round(filas.reduce((s, x) => s + (Number(x.porcentaje) || 0), 0) * 100) / 100,
        flexxus_leido: !!ccFlx,
      },
      ms: Date.now() - t0,
      partes_ms,
    });
    console.log('[flexxus-previo]', req.params.id, (Date.now() - t0) + 'ms', JSON.stringify(partes_ms));
  } catch (err) {
    console.error('flexxus-previo:', err.message);
    res.status(500).json({ error: err.message || 'No pude preparar la imputación' });
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
    // Sumamos la clase contable fija del proveedor (si tiene una asignada)
    const cuitP = String((fila.data || {}).cuit || '').replace(/\D/g, '');
    if (cuitP) {
      const { data: pc } = await supabaseCompras.from('proveedores_clase')
        .select('codigo_clase, clase_descripcion').eq('cuit', cuitP).maybeSingle();
      v.clase_asignada = pc || null;
      v.cuit_norm = cuitP;
    }
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
// El cuerpo del pedido de stock vive acá (y no dentro del handler) para que
// el recordatorio automático de stock_recordatorio.js use exactamente la
// misma lógica que el botón "Pedir stock" del panel.
async function pedirStockObjetivos(body) {
  {
    const periodo = String(body.periodo || '').trim() || periodoStockActual();

    let qObjs = supabase.from('objetivos').select('id, nombre, grupo_stock').eq('activo', true);
    if (Array.isArray(body.objetivo_ids) && body.objetivo_ids.length) {
      qObjs = qObjs.in('id', body.objetivo_ids);   // selección explícita del panel
    } else if (body.objetivo_id) {
      qObjs = qObjs.eq('id', body.objetivo_id);
    } else if (body.grupo) {
      // Pedido por grupo: depósito cada 15 días, privado 1 vez al mes
      qObjs = qObjs.eq('grupo_stock', body.grupo);
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
      if (algunoOk) {
        enviados++;
        // Queda registrado cuándo se le pidió por última vez a este objetivo:
        // es lo que usa el recordatorio automático para no repetir.
        await supabase.from('objetivos')
          .update({ stock_ultimo_pedido: new Date().toISOString() }).eq('id', o.id);
      }
    }
    console.log(`[stock] pedido ${periodo}${body.grupo ? ' (' + body.grupo + ')' : ''}: enviados=${enviados} sin_capataz=${sinCapataz} ya_respondidos=${yaRespondidos} fallidos=${fallidos}`);
    return { enviados, sin_capataz: sinCapataz, ya_respondidos: yaRespondidos, fallidos };
  }
}

router.post('/api/stock/pedir', auth, async (req, res) => {
  try {
    res.json(await pedirStockObjetivos(req.body || {}));
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
    const numsCenso  = {};
    const obsCenso   = {};
    const detCenso   = {};
    if (respondio) (censo.censos_stock_items || []).forEach(i => {
      const t = i.tipo_equipo;
      tiposCenso[t] = (tiposCenso[t] || 0) + (i.cantidad || 0);
      // ACUMULAR, no pisar: un mismo tipo puede venir en varios ítems (el
      // capataz los separa por marca o modelo). Antes cada ítem borraba los
      // números del anterior y la ficha mostraba solo los del último.
      numsCenso[t] = (numsCenso[t] || []).concat(i.numeros || []);
      if (i.observacion) obsCenso[t] = (obsCenso[t] || []).concat(i.observacion);
      // Detalle línea por línea, tal cual lo informó el capataz.
      detCenso[t] = (detCenso[t] || []).concat([{
        cantidad: i.cantidad || 0, numeros: i.numeros || [], observacion: i.observacion || null,
      }]);
    });

    // Filas comparadas: todo lo que está en inventario + lo que informó y no está
    const filas = (inv || []).map(r => ({
      id: r.id, tipo_equipo: r.tipo_equipo, cantidad: r.cantidad,
      numeros: r.numeros || [], observacion: r.observacion, origen: r.origen,
      censo: respondio ? (tiposCenso[r.tipo_equipo] || 0) : null,
      censo_numeros: numsCenso[r.tipo_equipo] || [],
      censo_obs: obsCenso[r.tipo_equipo] || [],
      censo_detalle: detCenso[r.tipo_equipo] || [],
      dif: respondio ? (tiposCenso[r.tipo_equipo] || 0) - r.cantidad : null,
    }));
    const enInv = new Set((inv || []).map(r => r.tipo_equipo));
    Object.entries(tiposCenso).forEach(([t, c]) => {
      if (enInv.has(t)) return;
      filas.push({ id: null, tipo_equipo: t, cantidad: 0, numeros: [],
        censo: c, censo_numeros: numsCenso[t] || [], censo_obs: obsCenso[t] || [],
        censo_detalle: detCenso[t] || [], dif: c, huerfano: true });
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

// ══ MOVIMIENTOS DE MAQUINARIA (trazabilidad) ═════════════════
// Los supervisores marcan egreso/ingreso desde la PWA; acá se lee todo junto:
// dónde está cada máquina, qué salió y no llegó, el historial de cada una y el
// cruce por objetivo. Una sola llamada: el volumen es chico (una fila por
// viaje) y así el panel no encadena requests.
router.get('/api/movimientos', auth, async (req, res) => {
  try {
    const dias = Math.min(365, Math.max(7, Number(req.query.dias) || 30));
    const desde = new Date(Date.now() - dias * 864e5).toISOString();
    const [unidadesR, movsR, objetivosR] = await Promise.all([
      supabase.from('unidades').select('id, codigo, patente, marca_modelo, tipo_activo').order('codigo'),
      supabase.from('movimientos_unidades').select('*').neq('estado', 'anulado')
        .order('salida_at', { ascending: false }).limit(2000),
      supabase.from('objetivos').select('id, nombre'),
    ]);
    if (movsR.error) throw movsR.error;
    const unidades = unidadesR.data || [];
    const movs = movsR.data || [];
    // IDs como STRING: unidades.id y objetivos.id son uuid en esta base.
    const nombreObj = new Map((objetivosR.data || []).map(o => [String(o.id), o.nombre]));
    const lugar = (tipo, oid) => tipo === 'taller' ? 'Taller' : (nombreObj.get(String(oid)) || '—');
    const rotulo = u => [u.codigo, u.patente].filter(Boolean).join(' · ') || ('Unidad ' + u.id);
    const porUnidad = new Map(unidades.map(u => [u.id, u]));
    const dias_de = iso => iso ? Math.ceil((Date.now() - new Date(iso).getTime()) / 864e5) : null;

    // Historial por unidad (el más nuevo primero)
    const hist = new Map();
    for (const m of movs) {
      if (!hist.has(m.unidad_id)) hist.set(m.unidad_id, []);
      hist.get(m.unidad_id).push(m);
    }

    const flota = unidades.map(u => {
      const h = hist.get(u.id) || [];
      const m = h[0] || null;
      const enViaje = !!(m && m.estado === 'en_transito');
      return {
        unidad_id: u.id, rotulo: rotulo(u), detalle: u.marca_modelo || u.tipo_activo || '',
        situacion: !m ? 'sin_registrar' : (enViaje ? 'en_transito' : 'ubicada'),
        donde: m ? (enViaje ? lugar(m.origen_tipo, m.origen_objetivo_id) : lugar(m.destino_tipo, m.destino_objetivo_id)) : null,
        donde_tipo: m ? (enViaje ? m.origen_tipo : m.destino_tipo) : null,
        hacia: enViaje ? lugar(m.destino_tipo, m.destino_objetivo_id) : null,
        desde_at: m ? (m.llegada_at || m.salida_at) : null,
        dias: m ? dias_de(m.llegada_at || m.salida_at) : null,
        estado_maquina: m ? (m.llegada_estado || m.salida_estado) : null,
        quien: m ? (enViaje ? m.salida_por : (m.llegada_por || m.salida_por)) : null,
        retira: m ? m.retira : null,
        obs: m ? (m.llegada_obs || m.salida_obs) : null,
        movimientos: h.length,
      };
    });

    // Lo accionable: salió y nadie marcó la llegada
    const sin_recibir = flota.filter(f => f.situacion === 'en_transito')
      .sort((a, b) => (b.dias || 0) - (a.dias || 0));

    // Cruce por objetivo (ventana de ?dias): qué entró, qué salió y cuántas
    // de las que llegaron venían con falla — el dato que nadie carga aparte.
    const recientes = movs.filter(m => (m.llegada_at || m.salida_at) >= desde);
    const porObj = {};
    const fila = nombre => porObj[nombre] || (porObj[nombre] = { objetivo: nombre, hoy: 0, entraron: 0, salieron: 0, llegaron_falla: 0 });
    for (const m of recientes) {
      if (m.estado === 'recibida') {
        const f = fila(lugar(m.destino_tipo, m.destino_objetivo_id));
        f.entraron++;
        if (m.llegada_estado === 'con_falla') f.llegaron_falla++;
      }
      if (m.origen_tipo === 'taller' || m.origen_objetivo_id) fila(lugar(m.origen_tipo, m.origen_objetivo_id)).salieron++;
    }
    for (const f of flota) if (f.situacion === 'ubicada' && f.donde) fila(f.donde).hoy++;

    res.json({
      dias,
      resumen: {
        ubicadas: flota.filter(f => f.situacion === 'ubicada').length,
        en_viaje: sin_recibir.length,
        demoradas: sin_recibir.filter(f => (f.dias || 0) > 2).length,
        sin_registrar: flota.filter(f => f.situacion === 'sin_registrar').length,
        con_falla: flota.filter(f => f.estado_maquina === 'con_falla' && f.situacion !== 'sin_registrar').length,
      },
      flota, sin_recibir,
      por_objetivo: Object.values(porObj).sort((a, b) => b.hoy - a.hoy || b.entraron - a.entraron),
      movimientos: recientes.map(m => {
        const u = porUnidad.get(m.unidad_id);
        return {
          id: m.id, unidad_id: m.unidad_id, unidad: u ? rotulo(u) : ('Unidad ' + m.unidad_id),
          desde: lugar(m.origen_tipo, m.origen_objetivo_id), hasta: lugar(m.destino_tipo, m.destino_objetivo_id),
          salida_at: m.salida_at, salida_por: m.salida_por, salida_estado: m.salida_estado, salida_obs: m.salida_obs,
          llegada_at: m.llegada_at, llegada_por: m.llegada_por, llegada_estado: m.llegada_estado, llegada_obs: m.llegada_obs,
          retira: m.retira, estado: m.estado,
        };
      }),
    });
  } catch (err) {
    console.error('movimientos:', err.message);
    res.status(500).json({ error: /movimientos_unidades/.test(err.message || '')
      ? 'Falta correr movimientos_maquinaria.sql en Supabase (base del bot).'
      : (err.message || 'Error cargando movimientos') });
  }
});

// Historial completo de UNA máquina (la ficha con la línea de tiempo)
router.get('/api/movimientos/unidad/:id', auth, async (req, res) => {
  try {
    const [uR, mR, oR] = await Promise.all([
      supabase.from('unidades').select('id, codigo, patente, marca_modelo, tipo_activo').eq('id', req.params.id).single(),
      supabase.from('movimientos_unidades').select('*').eq('unidad_id', req.params.id)
        .neq('estado', 'anulado').order('salida_at', { ascending: false }).limit(100),
      supabase.from('objetivos').select('id, nombre'),
    ]);
    if (!uR.data) return res.status(404).json({ error: 'Unidad inexistente' });
    const nombreObj = new Map((oR.data || []).map(o => [String(o.id), o.nombre]));
    const lugar = (t, oid) => t === 'taller' ? 'Taller' : (nombreObj.get(String(oid)) || '—');
    const movs = mR.data || [];
    // Días en taller dentro de los viajes cerrados que TERMINARON en el taller
    let diasTaller = 0, objetivos = new Set();
    movs.forEach((m, i) => {
      if (m.destino_tipo === 'objetivo' && m.destino_objetivo_id) objetivos.add(String(m.destino_objetivo_id));
      if (m.destino_tipo === 'taller' && m.llegada_at) {
        const sig = movs[i - 1];   // el viaje siguiente (la lista viene al revés) es la salida del taller
        const fin = sig ? new Date(sig.salida_at).getTime() : Date.now();
        diasTaller += Math.max(0, Math.ceil((fin - new Date(m.llegada_at).getTime()) / 864e5));
      }
    });
    res.json({
      unidad: { id: uR.data.id, rotulo: [uR.data.codigo, uR.data.patente].filter(Boolean).join(' · '), detalle: uR.data.marca_modelo || uR.data.tipo_activo || '' },
      totales: { movimientos: movs.length, objetivos: objetivos.size, dias_taller: diasTaller },
      historial: movs.map(m => ({
        id: m.id, desde: lugar(m.origen_tipo, m.origen_objetivo_id), hasta: lugar(m.destino_tipo, m.destino_objetivo_id),
        salida_at: m.salida_at, salida_por: m.salida_por, salida_estado: m.salida_estado, salida_obs: m.salida_obs,
        llegada_at: m.llegada_at, llegada_por: m.llegada_por, llegada_estado: m.llegada_estado, llegada_obs: m.llegada_obs,
        retira: m.retira, estado: m.estado,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error cargando el historial' });
  }
});

// Marcar la llegada desde el PANEL (para cuando el supervisor no la marcó)
router.post('/api/movimientos/:id/recibir', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const { data: m } = await supabase.from('movimientos_unidades')
      .select('id, estado').eq('id', req.params.id).maybeSingle();
    if (!m) return res.status(404).json({ error: 'Movimiento inexistente' });
    if (m.estado !== 'en_transito') return res.status(409).json({ error: 'Ese viaje ya está cerrado.' });
    const { error } = await supabase.from('movimientos_unidades').update({
      llegada_at: new Date().toISOString(),
      llegada_por: (req.usuario || 'panel') + ' (panel)', llegada_rol: 'panel',
      llegada_estado: b.estado === 'con_falla' ? 'con_falla' : 'anda',
      llegada_obs: String(b.observaciones || '').trim() || null,
      estado: 'recibida',
    }).eq('id', m.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'No pude marcar la llegada' });
  }
});

// Cargar/editar a mano el stock de un objetivo desde el panel, sin esperar la
// respuesta del capataz por WhatsApp. Reemplaza los ítems del censo del
// período y lo marca respondido.
// Columnas reales de censos_stock_items: censo_id, tipo_equipo, cantidad,
// numeros (array), observacion. NO se toca `origen` (parece acotado a los
// valores que escribe el bot) ni se siembra el inventario: para eso está el
// botón "Sembrar desde el censo" de la solapa Inventario.
router.post('/api/stock/censo/:id/items', auth, async (req, res) => {
  try {
    const entrada = Array.isArray(req.body && req.body.items) ? req.body.items : null;
    if (!entrada) return res.status(422).json({ error: 'Faltan los equipos' });

    const items = [];
    for (const i of entrada) {
      const tipo = String((i && i.tipo) || '').trim();
      if (!tipo) continue;                       // fila vacía: se ignora
      const numeros = Array.isArray(i.numeros)
        ? i.numeros.map(n => String(n).trim()).filter(Boolean)
        : String(i.numeros || '').split(/[,;\s]+/).map(n => n.trim()).filter(Boolean);
      let cantidad = parseInt(i.cantidad) || 0;
      // Si enumeró máquinas, mandan los números: es lo verificable.
      if (numeros.length && cantidad < numeros.length) cantidad = numeros.length;
      if (!cantidad) cantidad = numeros.length || 1;
      items.push({ tipo_equipo: tipo, cantidad, numeros, observacion: (i.observacion || '').trim() || null });
    }
    if (!items.length) return res.status(422).json({ error: 'Cargá al menos un equipo' });

    const { data: censo, error: eC } = await supabase
      .from('censos_stock').select('id, periodo, objetivo_id, objetivos(nombre)')
      .eq('id', req.params.id).maybeSingle();
    if (eC) throw eC;
    if (!censo) return res.status(404).json({ error: 'No encontré ese censo' });

    const { error: eD } = await supabase
      .from('censos_stock_items').delete().eq('censo_id', censo.id);
    if (eD) throw eD;

    const { error: eI } = await supabase.from('censos_stock_items')
      .insert(items.map(i => Object.assign({ censo_id: censo.id }, i)));
    if (eI) throw eI;

    const { error: eU } = await supabase.from('censos_stock')
      .update({ estado: 'respondido', respondido_at: new Date().toISOString() })
      .eq('id', censo.id);
    if (eU) throw eU;

    const total = items.reduce((s2, i) => s2 + i.cantidad, 0);
    console.log(`[stock] carga manual desde panel · ${censo.objetivos ? censo.objetivos.nombre : censo.objetivo_id} · ` +
      `${censo.periodo} · ${items.length} tipos, ${total} equipos · por ${req.usuario || '?'}`);
    res.json({ ok: true, tipos: items.length, equipos: total });
  } catch (err) {
    console.error('cargar stock manual:', err);
    res.status(500).json({ error: 'No pude guardar el stock' });
  }
});

// ── Padrón de máquinas ────────────────────────────────────────
// Una fila por máquina física. La llave es codigo_interno, normalizado en
// codigo_norm para poder cruzarlo con incidencias.numero_unidad, que es
// texto libre cargado por capataces ("h13", "H 13", "13").
function normCodigo(v) {
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Fechas de la planilla: 1/03/2024, 30/9/2025, 2024-03-01, oct-21.
// Devuelve YYYY-MM-DD o null. Nunca inventa: si no la entiende, null.
function fechaPlanilla(v) {
  const t = String(v || '').trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return t;
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const d = m[1].padStart(2, '0'), mes = m[2].padStart(2, '0');
    let a = m[3]; if (a.length === 2) a = (Number(a) > 70 ? '19' : '20') + a;
    return `${a}-${mes}-${d}`;
  }
  // "oct-21" / "abr-20": mes abreviado + año de dos dígitos
  const MESES = { ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
                  jul: '07', ago: '08', sep: '09', set: '09', oct: '10', nov: '11', dic: '12' };
  m = t.toLowerCase().match(/^([a-záéíóú]{3})[\-\/ ](\d{1,4})$/);
  if (m && MESES[m[1]]) {
    const a = m[2];
    // Solo año de 2 o 4 dígitos. "oct-3" es ambiguo (¿2003? ¿3 de octubre?
    // ¿2023 cortado por Excel?) y no se adivina: vuelve null y se reporta
    // como error para que se corrija en la planilla.
    if (a.length === 4) return `${a}-${MESES[m[1]]}-01`;
    if (a.length === 2) return `${(Number(a) > 70 ? '19' : '20') + a}-${MESES[m[1]]}-01`;
    return null;
  }
  return null;
}

const CAMPOS_MAQUINA = ['codigo_interno', 'tipo_equipo', 'maquina', 'marca', 'modelo',
  'alimentacion', 'numero_serie', 'fecha_compra', 'precio_compra', 'proveedor',
  'objetivo_id', 'objetivo_texto', 'estado', 'rectificaciones', 'fecha_rectificacion',
  'motivo_baja', 'fecha_baja', 'notas'];

function limpiarMaquina(body) {
  const out = {};
  for (const k of CAMPOS_MAQUINA) {
    if (body[k] === undefined) continue;
    let v = body[k];
    if (['fecha_compra', 'fecha_baja', 'fecha_rectificacion'].includes(k)) v = fechaPlanilla(v);
    else if (k === 'precio_compra') v = v === '' || v == null ? null : Number(String(v).replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(',', '.')) || null;
    else if (k === 'objetivo_id') v = v || null;
    else if (typeof v === 'string') v = v.trim() || null;
    out[k] = v;
  }
  if (out.codigo_interno) out.codigo_norm = normCodigo(out.codigo_interno);
  // Coherencia: si hay fecha de baja o motivo, la máquina está de baja.
  if (out.fecha_baja || (out.motivo_baja && out.estado !== 'activa')) out.estado = out.estado === 'activa' ? 'baja' : (out.estado || 'baja');
  return out;
}

// Listado del padrón, con la vida útil ya calculada por la vista.
router.get('/api/maquinas', auth, async (req, res) => {
  try {
    let q = supabase.from('maquinas_vida').select('*').order('tipo_equipo').order('codigo_interno');
    if (req.query.tipo) q = q.eq('tipo_equipo', req.query.tipo);
    if (req.query.estado) q = q.eq('estado', req.query.estado);
    const { data, error } = await q;
    if (error) throw error;

    // Objetivos para el selector y para mostrar el nombre.
    const { data: objs } = await supabase.from('objetivos').select('id, nombre').eq('activo', true).order('nombre');
    res.json({ maquinas: data || [], objetivos: objs || [] });
  } catch (err) {
    console.error('maquinas:', err);
    res.status(500).json({ error: 'No pude cargar el padrón (¿corriste maquinas.sql?)' });
  }
});

// Ficha: la máquina + TODAS sus reparaciones, cruzadas por número interno.
// Esto es lo que hoy no existe: stock y taller no se hablaban.
router.get('/api/maquinas/:id', auth, async (req, res) => {
  try {
    const { data: maq, error } = await supabase.from('maquinas_vida').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!maq) return res.status(404).json({ error: 'No encontré esa máquina' });

    // numero_unidad es texto libre: se compara normalizado, no por igualdad.
    const { data: incs } = await supabase.from('incidencias')
      .select('id, numero_unidad, tipo_equipo, tipo_falla, descripcion, prioridad, estado, created_at, fecha_finalizado, puntos_ia, puntos_ia_horas, mecanicos(nombre), repuestos_taller(items,nota_precio,estado)')
      .order('created_at', { ascending: false }).limit(500);
    const suyas = (incs || []).filter(i => normCodigo(i.numero_unidad) === maq.codigo_norm
      && (!maq.tipo_equipo || !i.tipo_equipo || normCodigo(i.tipo_equipo) === normCodigo(maq.tipo_equipo)));

    // Plata: solo lo que tiene precio cargado en la nota de pedido.
    let gastoRepuestos = 0, conPrecio = 0;
    suyas.forEach(i => (i.repuestos_taller || []).forEach(r => {
      if (r.nota_precio != null) { gastoRepuestos += Number(r.nota_precio) || 0; conPrecio++; }
    }));
    const horas = suyas.reduce((a, i) => a + (Number(i.puntos_ia_horas) || 0), 0);

    res.json({ maquina: maq, reparaciones: suyas,
      resumen: { total: suyas.length, gasto_repuestos: gastoRepuestos, repuestos_con_precio: conPrecio,
                 horas_taller: Math.round(horas * 10) / 10 } });
  } catch (err) {
    console.error('maquina ficha:', err);
    res.status(500).json({ error: 'No pude cargar la ficha' });
  }
});

router.post('/api/maquinas', auth, async (req, res) => {
  try {
    const fila = limpiarMaquina(req.body || {});
    if (!fila.codigo_interno) return res.status(422).json({ error: 'Falta el número interno' });
    const { data, error } = await supabase.from('maquinas').insert(fila).select().single();
    if (error) {
      if (String(error.message || '').includes('duplicate')) return res.status(422).json({ error: `Ya existe una máquina con el número ${fila.codigo_interno}` });
      throw error;
    }
    console.log(`[maquinas] alta ${fila.codigo_interno} (${fila.tipo_equipo || '?'}) por ${req.usuario || '?'}`);
    res.json(data);
  } catch (err) {
    console.error('alta maquina:', err);
    res.status(500).json({ error: 'No pude dar de alta la máquina' });
  }
});

router.patch('/api/maquinas/:id', auth, async (req, res) => {
  try {
    const fila = limpiarMaquina(req.body || {});
    fila.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('maquinas').update(fila).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('editar maquina:', err);
    res.status(500).json({ error: 'No pude guardar los cambios' });
  }
});

router.delete('/api/maquinas/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('maquinas').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No pude borrar la máquina' });
  }
});

// Importar la planilla pegada desde Excel (TSV o CSV con ;).
// Modo previsualizar: no escribe nada, devuelve lo que haría.
router.post('/api/maquinas/importar', auth, async (req, res) => {
  try {
    const texto = String((req.body && req.body.texto) || '');
    const previsualizar = !!(req.body && req.body.previsualizar);
    const tipoDefault = String((req.body && req.body.tipo_equipo) || '').trim() || null;
    const lineas = texto.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lineas.length) return res.status(422).json({ error: 'No pegaste nada' });

    const partir = l => l.includes('\t') ? l.split('\t') : l.split(';');
    // Cabecera: se busca por nombre, no por posición — el orden de columnas
    // de la planilla puede cambiar.
    const cab = partir(lineas[0]).map(h => normCodigo(h));
    const col = (...nombres) => {
      for (const n of nombres) { const i = cab.indexOf(normCodigo(n)); if (i >= 0) return i; }
      return -1;
    };
    const iMaq = col('maquina'), iNum = col('nint', 'n int', 'numero interno', 'interno'),
          iObj = col('objetivo'), iCom = col('compra', 'fecha compra'),
          iRec = col('rectificaciones'), iFRep = col('fecha rep', 'fecha rep.'),
          iMot = col('motivo de baja', 'motivo baja'), iFBaja = col('fecha baja'),
          iEst = col('estado'), iTipo = col('tipo', 'tipo equipo');
    if (iNum < 0) return res.status(422).json({ error: 'No encontré la columna del número interno (N° INT). Pegá también la fila de títulos.' });

    const { data: objs } = await supabase.from('objetivos').select('id, nombre').eq('activo', true);
    const buscarObj = txt => {
      const n = normCodigo(txt); if (!n) return null;
      const ex = (objs || []).find(o => normCodigo(o.nombre) === n);
      if (ex) return ex.id;
      const parcial = (objs || []).filter(o => normCodigo(o.nombre).includes(n) || n.includes(normCodigo(o.nombre)));
      return parcial.length === 1 ? parcial[0].id : null;   // ambiguo → texto libre
    };

    const filas = [], errores = [];
    for (let i = 1; i < lineas.length; i++) {
      const c = partir(lineas[i]);
      const val = ix => ix >= 0 && c[ix] != null ? String(c[ix]).trim() : '';
      const codigo = val(iNum);
      if (!codigo) continue;                       // fila de totales o vacía
      if (/^total/i.test(codigo)) continue;
      const estadoTxt = val(iEst).toLowerCase();
      const fechaBaja = fechaPlanilla(val(iFBaja));
      const motivo = val(iMot);
      const estado = estadoTxt.startsWith('baja') || fechaBaja || (motivo && !estadoTxt.startsWith('activ')) ? 'baja' : 'activa';
      const objTxt = val(iObj);
      const fila = {
        codigo_interno: codigo, codigo_norm: normCodigo(codigo),
        tipo_equipo: val(iTipo) || tipoDefault,
        maquina: val(iMaq) || null,
        fecha_compra: fechaPlanilla(val(iCom)),
        objetivo_id: buscarObj(objTxt), objetivo_texto: objTxt || null,
        estado,
        rectificaciones: val(iRec) || null,
        fecha_rectificacion: fechaPlanilla(val(iFRep)),
        motivo_baja: motivo || null, fecha_baja: fechaBaja,
      };
      if (!fila.fecha_compra && val(iCom)) errores.push(`${codigo}: no entendí la fecha de compra "${val(iCom)}"`);
      if (!fila.fecha_baja && val(iFBaja)) errores.push(`${codigo}: no entendí la fecha de baja "${val(iFBaja)}" (queda de baja, sin fecha)`);
      // Una baja anterior a la compra no puede ser: rompe la vida útil.
      if (fila.fecha_compra && fila.fecha_baja && fila.fecha_baja < fila.fecha_compra)
        errores.push(`${codigo}: la baja (${fila.fecha_baja}) es ANTERIOR a la compra (${fila.fecha_compra}) — revisá la planilla`);
      filas.push(fila);
    }
    if (!filas.length) return res.status(422).json({ error: 'No encontré filas con número interno' });

    // Repetidos dentro de lo pegado
    const vistos = new Set(), dupes = [];
    filas.forEach(f => { if (vistos.has(f.codigo_norm)) dupes.push(f.codigo_interno); vistos.add(f.codigo_norm); });

    const { data: existentes } = await supabase.from('maquinas').select('codigo_norm');
    const yaEstan = new Set((existentes || []).map(m => m.codigo_norm));
    const nuevas = filas.filter(f => !yaEstan.has(f.codigo_norm));
    const repetidas = filas.filter(f => yaEstan.has(f.codigo_norm));

    if (previsualizar) {
      return res.json({ previsualizacion: true, leidas: filas.length, nuevas: nuevas.length,
        ya_estaban: repetidas.length, duplicadas_en_lo_pegado: dupes, errores,
        muestra: nuevas.slice(0, 5) });
    }

    let insertadas = 0;
    for (let i = 0; i < nuevas.length; i += 100) {
      const tanda = nuevas.slice(i, i + 100).filter((f, ix, arr) => arr.findIndex(x => x.codigo_norm === f.codigo_norm) === ix);
      const { error } = await supabase.from('maquinas').insert(tanda);
      if (error) throw error;
      insertadas += tanda.length;
    }
    console.log(`[maquinas] importadas ${insertadas} de ${filas.length} por ${req.usuario || '?'}`);
    res.json({ insertadas, leidas: filas.length, ya_estaban: repetidas.length, errores });
  } catch (err) {
    console.error('importar maquinas:', err);
    res.status(500).json({ error: 'No pude importar: ' + (err.message || err) });
  }
});

// ── Pañol ─────────────────────────────────────────────────────
// Lo que se guarda en el pañol y lo que sale a cada objetivo. El alta y la
// corrección se hacen desde el panel; las salidas y devoluciones las
// registra el pañolero desde la app.
router.get('/api/panol', auth, async (req, res) => {
  try {
    const [items, movs, hist] = await Promise.all([
      supabase.from('panol_disponible').select('*').order('nombre'),
      supabase.from('panol_movimientos').select('*, objetivos(nombre)')
        .eq('estado', 'afuera').order('retorno_previsto'),
      // Últimos movimientos de todo tipo: sin esto los ingresos que carga
      // el pañolero no se pueden auditar desde el panel.
      supabase.from('panol_movimientos').select('*, objetivos(nombre)')
        .order('created_at', { ascending: false }).limit(120),
    ]);
    if (items.error) throw items.error;
    res.json({ items: items.data || [], afuera: movs.data || [], movimientos: hist.data || [] });
  } catch (err) {
    console.error('panol:', err);
    res.status(500).json({ error: 'No pude cargar el pañol (¿corriste panol.sql?)' });
  }
});

// Alta y edición de un ítem del pañol
router.post('/api/panol/items', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const fila = {
      nombre: String(b.nombre || '').trim(),
      categoria: ['herramienta', 'insumo', 'repuesto', 'otro'].includes(b.categoria) ? b.categoria : 'herramienta',
      // Los insumos se consumen: no vuelven. Las herramientas sí.
      retornable: b.retornable != null ? !!b.retornable : b.categoria !== 'insumo',
      codigo: String(b.codigo || '').trim() || null,
      marca: String(b.marca || '').trim() || null,
      cantidad: Number(b.cantidad) || 0,
      unidad: String(b.unidad || 'u').trim() || 'u',
      ubicacion: String(b.ubicacion || '').trim() || null,
      minimo: Number(b.minimo) || 0,
      notas: String(b.notas || '').trim() || null,
      activo: b.activo !== false,
      // Niveles de reposición: null = no se controla (no es lo mismo que 0)
      punto_pedido: b.punto_pedido == null || b.punto_pedido === '' ? null : Number(b.punto_pedido),
      cantidad_compra: b.cantidad_compra == null || b.cantidad_compra === '' ? null : Number(b.cantidad_compra),
      proveedor: String(b.proveedor || '').trim() || null,
    };
    if (!fila.nombre) return res.status(422).json({ error: 'Falta el nombre' });
    if (fila.cantidad < 0) return res.status(422).json({ error: 'La cantidad no puede ser negativa' });

    if (b.id) {
      const { error } = await supabase.from('panol_items').update(fila).eq('id', b.id);
      if (error) throw error;
      return res.json({ ok: true, id: b.id });
    }
    const { data, error } = await supabase.from('panol_items').insert(fila).select().single();
    if (error) throw error;
    res.json({ ok: true, id: data.id });
  } catch (err) {
    console.error('panol item:', err);
    res.status(500).json({ error: 'No pude guardar el ítem' });
  }
});

// Borrar un ítem del pañol. Si tiene movimientos NO se borra: se archiva
// (activo=false), así no se pierde el historial de a dónde fue cada cosa.
router.delete('/api/panol/items/:id', auth, async (req, res) => {
  try {
    const { data: movs, error: e1 } = await supabase.from('panol_movimientos')
      .select('id, estado').eq('item_id', req.params.id);
    if (e1) throw e1;
    const afuera = (movs || []).filter(m => m.estado === 'afuera').length;
    if (afuera) {
      return res.status(422).json({ error: `No puedo borrarlo: hay ${afuera} afuera sin devolver` });
    }
    if ((movs || []).length) {
      const { error } = await supabase.from('panol_items').update({ activo: false }).eq('id', req.params.id);
      if (error) throw error;
      return res.json({ ok: true, archivado: true, movimientos: movs.length });
    }
    const { error } = await supabase.from('panol_items').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true, archivado: false });
  } catch (err) {
    console.error('panol borrar:', err);
    res.status(500).json({ error: 'No pude borrar el ítem' });
  }
});

// Historial de movimientos de un ítem
router.get('/api/panol/items/:id/movimientos', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('panol_movimientos')
      .select('*, objetivos(nombre)').eq('item_id', req.params.id)
      .order('fecha_salida', { ascending: false }).limit(60);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'No pude traer el historial' });
  }
});

// Devolución desde el panel (por si el pañolero no la registró)
router.post('/api/panol/movimientos/:id/devolver', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('panol_movimientos').update({
      estado: 'devuelto', fecha_devolucion: new Date().toISOString(),
      recibio: String((req.body && req.body.recibio) || 'panel').trim(),
      nota_devolucion: String((req.body && req.body.nota) || '').trim() || null,
    }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No pude registrar la devolución' });
  }
});

// ── Pañol · reposición (el 80/20) ─────────────────────────────
// Unas pocas cosas se llevan casi todo el movimiento (bolsas, tanza,
// carreteles, tapas). El ABC las separa solo, con los movimientos reales:
// A = las que acumulan el primer 80% del consumo, B hasta el 95%, C el
// resto. Sobre las A tiene sentido poner punto de pedido; sobre las C no.
router.get('/api/panol/reposicion', auth, async (req, res) => {
  try {
    const [cons, disp] = await Promise.all([
      supabase.from('panol_consumo').select('*'),
      supabase.from('panol_disponible').select('id, disponible, afuera, minimo, retornable, ubicacion, marca'),
    ]);
    if (cons.error) throw cons.error;
    const dispPorId = {};
    (disp.data || []).forEach(d => { dispPorId[d.id] = d; });

    const filas = (cons.data || []).map(c => ({ ...c, ...(dispPorId[c.id] || {}) }));
    // ABC por consumo acumulado
    const conConsumo = filas.filter(f => Number(f.consumo_90d) > 0)
      .sort((a, b) => Number(b.consumo_90d) - Number(a.consumo_90d));
    const total = conConsumo.reduce((a, f) => a + Number(f.consumo_90d), 0);
    let acum = 0;
    conConsumo.forEach(f => {
      acum += Number(f.consumo_90d);
      const pct = total ? acum / total : 0;
      f.clase = pct <= 0.8 ? 'A' : pct <= 0.95 ? 'B' : 'C';
      f.pct_acum = Math.round(pct * 1000) / 10;
    });
    filas.filter(f => !f.clase).forEach(f => { f.clase = 'sin movimiento'; });

    // Sugerencia de punto de pedido: consumo de un mes + medio mes de
    // colchón, redondeado para arriba. Es una propuesta, se edita a mano.
    filas.forEach(f => {
      const cm = Number(f.consumo_mes) || 0;
      f.sugerido = cm > 0 ? Math.ceil(cm * 1.5) : null;
      const d = Number(f.disponible);
      const pp = f.punto_pedido != null ? Number(f.punto_pedido) : null;
      f.hay_que_comprar = pp != null ? d <= pp : (Number(f.minimo) > 0 && d <= Number(f.minimo));
      f.cobertura_dias = cm > 0 ? Math.round((d / cm) * 30) : null;
    });
    res.json({
      filas,
      total_consumo: total,
      resumen: {
        A: filas.filter(f => f.clase === 'A').length,
        B: filas.filter(f => f.clase === 'B').length,
        C: filas.filter(f => f.clase === 'C').length,
        sin_movimiento: filas.filter(f => f.clase === 'sin movimiento').length,
        comprar: filas.filter(f => f.hay_que_comprar).length,
      },
    });
  } catch (err) {
    console.error('panol reposicion:', err);
    res.status(500).json({ error: 'No pude calcular la reposición (¿corriste panol_reposicion.sql?)' });
  }
});

// ── Reporte mensual para gerencia ─────────────────────────────
// Todo lo que necesita el informe en UNA llamada: reparaciones del mes,
// criticidad, tiempos de resolución, reingresos y estado del pañol.
router.get('/api/reportes/mensual', auth, async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? req.query.mes
      : new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Cordoba' }).slice(0, 7);
    const desde = `${mes}-01T00:00:00`;
    const [a, m] = mes.split('-').map(Number);
    const hasta = new Date(Date.UTC(a, m, 1)).toISOString();
    // Para reingresos se miran también los 60 días previos: una máquina
    // que volvió este mes pudo haberse reparado el mes pasado.
    const desdePrevio = new Date(Date.UTC(a, m - 3, 1)).toISOString();

    // Para el promedio mensual por camión se necesita el histórico entero,
    // no solo el mes: el promedio de un mes contra sí mismo no dice nada.
    const [inc, prev, panolItems, panolMovs, bateasHist, unidades, paradasHoy] = await Promise.all([
      supabase.from('incidencias')
        .select('*, objetivos(nombre), mecanicos(nombre), capataces(nombre)')
        .gte('created_at', desde).lt('created_at', hasta),
      supabase.from('incidencias')
        .select('id, tipo_equipo, numero_unidad, tipo_falla, fecha_finalizado, mecanico_id, mecanicos(nombre)')
        .gte('created_at', desdePrevio).lt('created_at', hasta),
      supabase.from('panol_disponible').select('*').then(r => r, () => ({ data: [] })),
      supabase.from('panol_movimientos').select('*').gte('fecha_salida', desde).lt('fecha_salida', hasta)
        .then(r => r, () => ({ data: [] })),
      supabase.from('viajes_bateas')
        .select('*, unidades(patente, marca_modelo), capataces(nombre)')
        .neq('estado', 'anulado').lt('fecha', hasta.slice(0, 10))
        .then(r => r, () => ({ data: [] })),
      supabase.from('unidades').select('id, patente, marca_modelo, tipo_rodado')
        .then(r => r, () => ({ data: [] })),
      // Paradas AHORA: todas las abiertas con equipo_parado, sin filtro de
      // mes — una máquina parada desde julio sigue parada hoy.
      supabase.from('incidencias')
        .select('id, tipo_equipo, numero_unidad, prioridad, created_at, objetivos(nombre)')
        .eq('equipo_parado', true).neq('estado', 'finalizado'),
    ]);
    if (inc.error) throw inc.error;
    const filas = inc.data || [];

    const dias = (ini, fin) => {
      if (!ini || !fin) return null;
      const d = (new Date(fin) - new Date(ini)) / 86400000;
      return d >= 0 ? d : null;
    };
    // Las cerradas SIN REPARAR (el equipo nunca llegó, se resolvió en el
    // objetivo, etc.) no son reparaciones: si contaran, inflarían las
    // "finalizadas" y arrastrarían el promedio de días hacia abajo.
    const sinReparar = filas.filter(r => r.motivo_cierre);
    const reparaciones = filas.filter(r => !r.motivo_cierre);
    const finalizadas = reparaciones.filter(r => r.estado === 'finalizado' && r.fecha_finalizado);
    const tiempos = finalizadas.map(r => dias(r.created_at, r.fecha_finalizado)).filter(x => x != null);
    const prom = tiempos.length ? tiempos.reduce((s, x) => s + x, 0) / tiempos.length : 0;
    const orden = tiempos.slice().sort((x, y) => x - y);
    const mediana = orden.length ? (orden.length % 2 ? orden[(orden.length - 1) / 2]
      : (orden[orden.length / 2 - 1] + orden[orden.length / 2]) / 2) : 0;

    // Por criticidad, de más a menos
    const ORDEN_PRIO = ['critico', 'alta', 'media', 'baja'];
    const porPrioridad = ORDEN_PRIO.map(p => {
      const del = reparaciones.filter(r => String(r.prioridad || '').toLowerCase() === p);
      const t = del.filter(r => r.estado === 'finalizado' && r.fecha_finalizado)
        .map(r => dias(r.created_at, r.fecha_finalizado)).filter(x => x != null);
      return {
        prioridad: p, cantidad: del.length,
        finalizadas: del.filter(r => r.estado === 'finalizado').length,
        parados: del.filter(r => r.equipo_parado).length,
        dias_prom: t.length ? Math.round((t.reduce((s, x) => s + x, 0) / t.length) * 10) / 10 : null,
      };
    }).filter(x => x.cantidad);

    // Tipos de falla, de más frecuente a menos, con su tiempo
    const porFalla = {};
    reparaciones.forEach(r => {
      const k = r.tipo_falla || 'Sin especificar';
      if (!porFalla[k]) porFalla[k] = { falla: k, cantidad: 0, criticas: 0, tiempos: [] };
      porFalla[k].cantidad++;
      if (['critico', 'alta'].includes(String(r.prioridad || '').toLowerCase())) porFalla[k].criticas++;
      const t = dias(r.created_at, r.fecha_finalizado);
      if (t != null) porFalla[k].tiempos.push(t);
    });
    const fallas = Object.values(porFalla).map(f => ({
      falla: f.falla, cantidad: f.cantidad, criticas: f.criticas,
      dias_prom: f.tiempos.length ? Math.round((f.tiempos.reduce((s, x) => s + x, 0) / f.tiempos.length) * 10) / 10 : null,
    })).sort((x, y) => y.criticas - x.criticas || y.cantidad - x.cantidad);

    // REINGRESOS: misma unidad que vuelve dentro de los 30 días de una
    // finalización anterior. Es el indicador de calidad de la reparación.
    const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const previas = (prev.data || []).filter(r => r.fecha_finalizado);
    const reingresos = [];
    reparaciones.forEach(r => {
      const u = norm(r.numero_unidad);
      if (!u || u === 'sn') return;
      const base = previas.filter(p => p.id !== r.id && norm(p.numero_unidad) === u
        && new Date(p.fecha_finalizado) < new Date(r.created_at)
        && (new Date(r.created_at) - new Date(p.fecha_finalizado)) / 86400000 <= 30);
      if (base.length) {
        const b = base.sort((x, y) => new Date(y.fecha_finalizado) - new Date(x.fecha_finalizado))[0];
        reingresos.push({
          unidad: r.numero_unidad, equipo: r.tipo_equipo,
          falla_previa: b.tipo_falla, falla_ahora: r.tipo_falla,
          dias: Math.round((new Date(r.created_at) - new Date(b.fecha_finalizado)) / 86400000),
          mecanico: b.mecanicos ? b.mecanicos.nombre : null,
          misma_falla: norm(b.tipo_falla) === norm(r.tipo_falla),
        });
      }
    });

    const cuenta = (arr, f) => {
      const m2 = {};
      arr.forEach(r => { const k = f(r) || '—'; m2[k] = (m2[k] || 0) + 1; });
      return Object.entries(m2).map(([k, v]) => ({ nombre: k, cantidad: v }))
        .sort((x, y) => y.cantidad - x.cantidad);
    };

    // ── BATEAS ────────────────────────────────────────────────
    // OJO: viajes_bateas NO tiene m3_total ni objetivo_id. Los m³ se
    // calculan con la constante de siempre y los objetivos viven en el
    // jsonb `paradas` (cada parada es {objetivo_nombre, bateas}).
    const M3_BATEA_REP = 14;
    const bateasPorObjetivo = (viajes) => {
      const m2 = {};
      viajes.forEach(v => {
        (Array.isArray(v.paradas) ? v.paradas : []).forEach(pr => {
          const k = pr.objetivo_nombre || '—';
          m2[k] = (m2[k] || 0) + (Number(pr.bateas) || 0);
        });
      });
      return Object.entries(m2).map(([k, v]) => ({ nombre: k, cantidad: v }))
        .sort((x, y) => y.cantidad - x.cantidad);
    };

    // Por camión: las del mes, el promedio mensual histórico y el
    // mantenimiento de ese mismo camión (las reparaciones se cruzan por
    // patente normalizada contra numero_unidad, que es texto libre).
    const bat = bateasHist.data || [];
    const delMes = bat.filter(v => String(v.fecha || '').slice(0, 7) === mes);
    const normPat = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const uni = {};
    (unidades.data || []).forEach(u => { uni[u.id] = u; });

    const porCamion = {};
    bat.forEach(v => {
      const k = v.unidad_id || 'sin-unidad';
      const u = v.unidades || uni[v.unidad_id] || {};
      if (!porCamion[k]) porCamion[k] = {
        unidad_id: v.unidad_id, patente: u.patente || 'sin patente',
        modelo: u.marca_modelo || null,
        bateas_mes: 0, viajes_mes: 0, m3_mes: 0,
        bateas_hist: 0, meses: {}, choferes: {},
      };
      const c = porCamion[k];
      const nb = Number(v.total_bateas) || 0;
      const mesV = String(v.fecha || '').slice(0, 7);
      c.bateas_hist += nb;
      c.meses[mesV] = (c.meses[mesV] || 0) + nb;
      if (mesV === mes) {
        c.bateas_mes += nb;
        c.viajes_mes++;
        c.m3_mes += (Number(v.total_bateas) || 0) * M3_BATEA_REP;
        const ch = v.capataces ? v.capataces.nombre : null;
        if (ch) c.choferes[ch] = (c.choferes[ch] || 0) + nb;
      }
    });

    // Mantenimiento de cada camión: incidencias del mes cuya numero_unidad
    // coincide con la patente (o con el código de la unidad)
    const camiones = Object.values(porCamion).map(c => {
      const mesesCon = Object.keys(c.meses).length;
      const repa = filas.filter(r => {
        const n = normPat(r.numero_unidad);
        return n && (n === normPat(c.patente) || (c.modelo && n === normPat(c.modelo)));
      });
      const tRepa = repa.filter(r => r.fecha_finalizado)
        .map(r => dias(r.created_at, r.fecha_finalizado)).filter(x => x != null);
      const chofer = Object.entries(c.choferes).sort((x, y) => y[1] - x[1])[0];
      return {
        patente: c.patente, modelo: c.modelo,
        bateas_mes: c.bateas_mes, viajes_mes: c.viajes_mes,
        m3_mes: Math.round(c.m3_mes * 10) / 10,
        prom_viaje: c.viajes_mes ? Math.round((c.bateas_mes / c.viajes_mes) * 10) / 10 : 0,
        // Promedio mensual histórico: solo cuentan los meses CON actividad,
        // si no un camión que arrancó hace poco queda castigado
        prom_mensual: mesesCon ? Math.round((c.bateas_hist / mesesCon) * 10) / 10 : 0,
        meses_activo: mesesCon,
        bateas_hist: c.bateas_hist,
        chofer: chofer ? chofer[0] : null,
        mant_cantidad: repa.length,
        mant_parado: repa.filter(r => r.equipo_parado).length,
        mant_dias: tRepa.length ? Math.round((tRepa.reduce((s, x) => s + x, 0) / tRepa.length) * 10) / 10 : null,
        mant_abiertas: repa.filter(r => r.estado !== 'finalizado').length,
      };
    }).sort((x, y) => y.bateas_mes - x.bateas_mes);

    const totalBateasMes = delMes.reduce((a, v) => a + (Number(v.total_bateas) || 0), 0);
    // Evolución de los últimos 6 meses, para el gráfico
    const evoMeses = {};
    bat.forEach(v => {
      const k = String(v.fecha || '').slice(0, 7);
      if (k) evoMeses[k] = (evoMeses[k] || 0) + (Number(v.total_bateas) || 0);
    });
    const evolucion = Object.entries(evoMeses).sort((a2, b2) => a2[0].localeCompare(b2[0]))
      .slice(-6).map(([k, v]) => ({ nombre: k, cantidad: v }));

    const items = panolItems.data || [];
    const movs = panolMovs.data || [];
    res.json({
      mes,
      bateas: {
        total_mes: totalBateasMes,
        viajes_mes: delMes.length,
        m3_mes: totalBateasMes * M3_BATEA_REP,
        camiones,
        evolucion,
        por_objetivo: bateasPorObjetivo(delMes),
      },
      reparaciones: {
        total: reparaciones.length,
        finalizadas: finalizadas.length,
        abiertas: reparaciones.filter(r => r.estado !== 'finalizado').length,
        // Cerradas sin pasar por el taller, contadas aparte
        sin_reparar: sinReparar.length,
        sin_reparar_por_motivo: Object.entries(sinReparar.reduce((a, r) => {
          const k = r.motivo_cierre || 'otro'; a[k] = (a[k] || 0) + 1; return a;
        }, {})).map(([k, v]) => ({ nombre: k.replace(/_/g, ' '), cantidad: v }))
          .sort((x, y) => y.cantidad - x.cantidad),
        no_ingreso: sinReparar.filter(r => r.motivo_cierre === 'no_ingreso').length,
        parados: reparaciones.filter(r => r.equipo_parado).length,   // del mes
        parados_ahora: (paradasHoy.data || []).length,        // a la fecha
        parados_detalle: (paradasHoy.data || []).map(r => ({
          equipo: r.tipo_equipo, unidad: r.numero_unidad, prioridad: r.prioridad,
          objetivo: r.objetivos ? r.objetivos.nombre : null,
          dias: Math.ceil((Date.now() - new Date(r.created_at)) / 86400000),
        })).sort((a2, b2) => b2.dias - a2.dias),
        preventivas: reparaciones.filter(r => r.tipo_mant === 'preventivo').length,
        dias_prom: Math.round(prom * 10) / 10,
        dias_mediana: Math.round(mediana * 10) / 10,
        dias_peor: tiempos.length ? Math.round(Math.max(...tiempos) * 10) / 10 : 0,
        por_prioridad: porPrioridad,
        por_falla: fallas,
        por_objetivo: cuenta(reparaciones, r => r.objetivos && r.objetivos.nombre),
        por_equipo: cuenta(reparaciones, r => r.tipo_equipo),
        por_mecanico: cuenta(finalizadas, r => r.mecanicos && r.mecanicos.nombre),
        reingresos: {
          cantidad: reingresos.length,
          porcentaje: reparaciones.length ? Math.round((reingresos.length / reparaciones.length) * 1000) / 10 : 0,
          misma_falla: reingresos.filter(r => r.misma_falla).length,
          detalle: reingresos.sort((x, y) => x.dias - y.dias).slice(0, 15),
        },
        detalle_tiempos: finalizadas.map(r => ({
          equipo: r.tipo_equipo, unidad: r.numero_unidad, falla: r.tipo_falla,
          prioridad: r.prioridad, objetivo: r.objetivos ? r.objetivos.nombre : null,
          mecanico: r.mecanicos ? r.mecanicos.nombre : null,
          dias: Math.round(dias(r.created_at, r.fecha_finalizado) * 10) / 10,
        })).sort((x, y) => y.dias - x.dias),
      },
      panol: {
        items: items.length,
        unidades: items.reduce((a, i) => a + (Number(i.cantidad) || 0), 0),
        afuera: items.reduce((a, i) => a + (Number(i.afuera) || 0), 0),
        bajo_minimo: items.filter(i => Number(i.minimo) > 0 && Number(i.disponible) <= Number(i.minimo)).length,
        agotados: items.filter(i => Number(i.disponible) <= 0).length,
        por_categoria: cuenta(items, i => i.categoria),
        salidas_mes: movs.length,
        salidas_por_objetivo: cuenta(movs, m2 => m2.objetivo_nombre),
        top_consumo: Object.values(movs.reduce((acc, m2) => {
          const it = items.find(i => i.id === m2.item_id);
          const k = it ? it.nombre : 'otro';
          if (!acc[k]) acc[k] = { nombre: k, cantidad: 0, salidas: 0 };
          acc[k].cantidad += Number(m2.cantidad) || 0;
          acc[k].salidas++;
          return acc;
        }, {})).sort((x, y) => y.cantidad - x.cantidad).slice(0, 12),
      },
    });
  } catch (err) {
    console.error('reporte mensual:', err);
    res.status(500).json({ error: 'No pude armar el reporte: ' + (err.message || '') });
  }
});

// ── Stock · General ───────────────────────────────────────────
// La pregunta "¿cuántas motoguadañas tenemos y dónde?" contestada en una
// sola llamada: el último censo respondido de CADA objetivo (sea del mes
// que sea), con su grupo, los números informados y los faltantes abiertos.
router.get('/api/stock/general', auth, async (req, res) => {
  try {
    const [objs, censos, faltantes] = await Promise.all([
      supabase.from('objetivos').select('id, nombre, grupo_stock').eq('activo', true),
      supabase.from('censos_stock')
        .select('id, periodo, objetivo_id, estado, respondido_at, capataces(nombre), censos_stock_items(tipo_equipo, cantidad, numeros, observacion)')
        .eq('estado', 'respondido').order('periodo', { ascending: false }),
      supabase.from('stock_faltantes').select('*').eq('estado', 'abierto')
        .then(r => r, () => ({ data: [] })),   // si la tabla no existe aún, sin faltantes
    ]);
    if (objs.error) throw objs.error;
    if (censos.error) throw censos.error;

    // Último censo respondido por objetivo (vienen ordenados desc)
    const ultimo = {};
    (censos.data || []).forEach(c => { if (!ultimo[c.objetivo_id]) ultimo[c.objetivo_id] = c; });

    const filas = [];
    (objs.data || []).forEach(o => {
      const c = ultimo[o.id];
      // Un objetivo NUEVO (o uno que nunca respondió el censo) no tiene
      // ítems, pero igual tiene que aparecer: si no, no hay dónde cargarle
      // el stock desde el panel.
      if (!c) {
        filas.push({
          objetivo_id: o.id, objetivo: o.nombre, grupo: o.grupo_stock || null,
          censo_id: null, capataz: null, periodo: null, respondido_at: null,
          tipo: null, cantidad: 0, numeros: [], observacion: null,
          sin_censo: true,
        });
        return;
      }
      (c.censos_stock_items || []).forEach(i => {
        filas.push({
          objetivo_id: o.id, objetivo: o.nombre, grupo: o.grupo_stock || null,
          censo_id: c.id,
          capataz: c.capataces ? c.capataces.nombre : null,
          periodo: c.periodo, respondido_at: c.respondido_at,
          tipo: i.tipo_equipo, cantidad: i.cantidad,
          numeros: i.numeros || [], observacion: i.observacion || null,
        });
      });
    });
    res.json({ filas, faltantes: faltantes.data || [] });
  } catch (err) {
    console.error('stock general:', err);
    res.status(500).json({ error: 'No pude armar el general (¿corriste grupos_stock.sql?)' });
  }
});

// Cargar el stock de un objetivo que todavía NO tiene censo. Crea el
// censo del período y le mete los ítems de una: es el camino para dar de
// alta el stock de un objetivo nuevo desde el panel, sin esperar a que el
// capataz responda por WhatsApp.
router.post('/api/stock/censos', auth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.objetivo_id) return res.status(422).json({ error: 'Falta el objetivo' });
    const periodo = /^\d{4}-\d{2}$/.test(String(b.periodo || '')) ? b.periodo
      : new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Cordoba' }).slice(0, 7);

    const items = (Array.isArray(b.items) ? b.items : [])
      .map(i => ({
        tipo_equipo: String(i.tipo || '').trim(),
        cantidad: Number(i.cantidad) || 0,
        numeros: (Array.isArray(i.numeros) ? i.numeros : []).map(n => String(n).trim()).filter(Boolean),
        observacion: String(i.observacion || '').trim() || null,
      }))
      .filter(i => i.tipo_equipo && i.cantidad > 0);
    if (!items.length) return res.status(422).json({ error: 'Cargá al menos un equipo' });

    // Si ya existe un censo de ese objetivo y período se reusa, para no
    // duplicar cuando el capataz respondió mientras tanto.
    const { data: existe } = await supabase.from('censos_stock')
      .select('id').eq('objetivo_id', b.objetivo_id).eq('periodo', periodo).maybeSingle();

    let censoId = existe ? existe.id : null;
    if (!censoId) {
      const { data: nuevo, error: e1 } = await supabase.from('censos_stock').insert({
        objetivo_id: b.objetivo_id, periodo,
        estado: 'respondido', respondido_at: new Date().toISOString(),
      }).select().single();
      if (e1) throw e1;
      censoId = nuevo.id;
    } else {
      await supabase.from('censos_stock').update({
        estado: 'respondido', respondido_at: new Date().toISOString(),
      }).eq('id', censoId);
      await supabase.from('censos_stock_items').delete().eq('censo_id', censoId);
    }

    const { error: e2 } = await supabase.from('censos_stock_items')
      .insert(items.map(i => ({ ...i, censo_id: censoId })));
    if (e2) throw e2;
    console.log(`[stock] censo cargado desde el panel: objetivo ${b.objetivo_id} · ${periodo} · ${items.length} tipos`);
    res.json({ ok: true, censo_id: censoId, items: items.length });
  } catch (err) {
    console.error('stock crear censo:', err);
    res.status(500).json({ error: 'No pude cargar el stock: ' + (err.message || '') });
  }
});

// Cerrar una incidencia SIN que el equipo haya pasado por el taller.
// Mismo cierre que hace el mecánico desde la app, pero desde el panel: el
// caso típico es que el capataz reportó y la máquina nunca bajó.
const MOTIVOS_SIN_REPARAR_PANEL = ['no_ingreso', 'resuelto_en_campo', 'sin_falla', 'duplicado', 'otro'];
router.post('/api/reparaciones/:id/cerrar-sin-reparar', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const motivo = MOTIVOS_SIN_REPARAR_PANEL.includes(b.motivo) ? b.motivo : 'no_ingreso';
    const nota = String(b.nota || '').trim();
    if (nota.length < 5) return res.status(422).json({ error: 'Escribí la nota para el capataz' });

    const { data: inc, error: e0 } = await supabase.from('incidencias')
      .select('*, equipos(nombre,tipo), capataces(nombre,telefono), mecanicos(nombre)')
      .eq('id', req.params.id).single();
    if (e0 || !inc) return res.status(404).json({ error: 'Incidencia inexistente' });
    if (inc.estado === 'finalizado') return res.status(422).json({ error: 'Esa incidencia ya está cerrada' });

    const quien = req.usuario || 'panel';
    const { data, error } = await supabase.from('incidencias').update({
      estado: 'finalizado',
      fecha_finalizado: new Date().toISOString(),
      cerrado_sin_ingreso: motivo === 'no_ingreso',
      motivo_cierre: motivo,
      nota_cierre: nota,
      cerrado_por: quien,
      equipo_parado: false,
    }).eq('id', req.params.id).select().single();
    if (error) throw error;

    try {
      await supabase.from('comentarios_incidencias').insert({
        incidencia_id: req.params.id,
        mecanico_nombre: quien,
        texto: `[Cerrada sin reparar · ${motivo.replace(/_/g, ' ')}] ${nota}`,
      });
    } catch (e) { /* el comentario es un extra */ }

    let notificado = false;
    if (inc.capataces && inc.capataces.telefono) {
      const msg = mensajeCierreSinReparar(motivo, {
        equipo: inc.equipos ? (inc.equipos.nombre || inc.equipos.tipo) : (inc.tipo_equipo || 'el equipo'),
        unidad: inc.numero_unidad,
        falla: inc.tipo_falla,
        mecanico: inc.mecanicos ? inc.mecanicos.nombre : quien,
        nota,
      });
      notificado = await notificarCapataz(inc.capataces.telefono, msg);
    }
    console.log(`[taller] cerrada sin reparar desde el panel (${motivo}): ${inc.tipo_equipo || ''} ${inc.numero_unidad || ''}${notificado ? ' · capataz avisado' : ''}`);
    res.json({ ...data, _notificado: notificado });
  } catch (err) {
    console.error('cerrar sin reparar (panel):', err);
    res.status(500).json({ error: 'No pude cerrar la incidencia' });
  }
});

// Editar los ítems de un censo desde el panel. Reemplaza TODO el listado
// del censo (mismo mecanismo que usa el bot al guardar): administración es
// la única que puede corregir o dar de baja — el capataz solo informa.
router.put('/api/stock/censos/:id/items', auth, async (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ error: 'Faltan los ítems' });
    const limpios = items
      .map(i => ({
        tipo_equipo: String(i.tipo || '').trim(),
        cantidad: Number(i.cantidad) || 0,
        numeros: (Array.isArray(i.numeros) ? i.numeros : [])
          .map(n => String(n).trim()).filter(Boolean),
        observacion: String(i.observacion || '').trim() || null,
      }))
      .filter(i => i.tipo_equipo && i.cantidad > 0);
    if (!limpios.length) return res.status(422).json({ error: 'El censo no puede quedar vacío: dejá al menos un equipo' });

    const { data: censo, error: e1 } = await supabase.from('censos_stock')
      .select('id, objetivo_id').eq('id', req.params.id).maybeSingle();
    if (e1) throw e1;
    if (!censo) return res.status(404).json({ error: 'No encontré ese censo' });

    const { error: e2 } = await supabase.from('censos_stock_items').delete().eq('censo_id', censo.id);
    if (e2) throw e2;
    const { error: e3 } = await supabase.from('censos_stock_items')
      .insert(limpios.map(i => ({ ...i, censo_id: censo.id })));
    if (e3) throw e3;
    console.log(`[stock] censo ${censo.id} editado desde el panel: ${limpios.length} tipos`);
    res.json({ ok: true, items: limpios.length });
  } catch (err) {
    console.error('stock editar censo:', err);
    res.status(500).json({ error: 'No pude guardar los cambios' });
  }
});

// Marcar un faltante como resuelto (apareció, se trasladó, se dio de baja…)
router.post('/api/stock/faltantes/:id/resolver', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('stock_faltantes')
      .update({ estado: 'resuelto', resuelto_nota: String((req.body && req.body.nota) || '').trim() || null,
                resuelto_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No pude marcarlo como resuelto' });
  }
});

// Borrar la respuesta de un censo (los equipos informados) y dejarlo
// pendiente otra vez. Pensado para limpiar pruebas sin tocar la base.
// No elimina la fila del censo: si se borrara, el objetivo desaparecería
// del listado del período y no se le podría reenviar el pedido.
router.delete('/api/stock/censo/:id', auth, async (req, res) => {
  try {
    const { data: censo, error: eC } = await supabase
      .from('censos_stock')
      .select('id, periodo, estado, objetivo_id, objetivos(nombre)')
      .eq('id', req.params.id).maybeSingle();
    if (eC) throw eC;
    if (!censo) return res.status(404).json({ error: 'No encontré ese censo' });

    const { error: eI } = await supabase
      .from('censos_stock_items').delete().eq('censo_id', censo.id);
    if (eI) throw eI;

    const { error: eU } = await supabase.from('censos_stock')
      .update({ estado: 'pendiente', respondido_at: null })
      .eq('id', censo.id);
    if (eU) throw eU;

    console.log(`[stock] respuesta borrada · censo ${censo.id} · ` +
      `${censo.objetivos ? censo.objetivos.nombre : censo.objetivo_id} · ${censo.periodo} · por ${req.usuario || '?'}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('borrar censo:', err);
    res.status(500).json({ error: 'No pude borrar la respuesta' });
  }
});

// ── Servir el panel (HTML + JS extraído en Fase 3) ────────────
// AUTO-ACTUALIZACIÓN (10-ago): el navegador cacheaba panel.js y había que
// hacer Ctrl+Shift+R en cada máquina después de cada subida. Dos piezas:
//  1) no-cache en /panel y /panel.js → un F5 común ya trae la versión nueva;
//  2) /api/panel-version devuelve la "huella" del build (mtime de panel.html
//     y panel.js congelado al arrancar) → el panel la consulta cada 60 s y,
//     si cambió (hubo redeploy), se recarga SOLO en cuanto no molesta.
//     Restart sin cambio de archivos = misma huella = nadie se recarga.
const PANEL_VERSION = (() => {
  try {
    const fs = require('fs');
    const a = fs.statSync(path.join(__dirname, 'panel.html')).mtimeMs;
    const b = fs.statSync(path.join(__dirname, 'panel.js')).mtimeMs;
    return String(Math.round(a)) + '-' + String(Math.round(b));
  } catch (e) { return 'v-' + Date.now(); }
})();
const sinCache = (res) => res.set({
  'Cache-Control': 'no-cache, must-revalidate',
  'Pragma': 'no-cache',
});
router.get('/panel', (req, res) => {
  sinCache(res);
  res.sendFile(path.join(__dirname, 'panel.html'));
});
router.get('/panel.js', (req, res) => {
  sinCache(res);
  res.sendFile(path.join(__dirname, 'panel.js'));
});
router.get('/api/panel-version', (req, res) => {
  res.json({ version: PANEL_VERSION });
});

// Al arrancar, calentar las cachés pesadas de Flexxus (plan de cuentas y
// centros de costo) en segundo plano: así el primer "Imputar" después de un
// redeploy no paga los sondeos. Best-effort: si Flexxus no responde, no pasa nada.
setTimeout(() => {
  try { require('./flexxus').precalentarFlexxus().catch(() => {}); } catch (e) { /* ignorar */ }
}, 1000).unref?.();

module.exports = router;
module.exports.pedirStockObjetivos = pedirStockObjetivos;
