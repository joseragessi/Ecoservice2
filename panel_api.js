const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const supabase = require('./supabase');
const supabaseCompras = require('./supabase_compras');
const { notificarCapataz, notificarCapatazTemplate } = require('./notificar');
const { hashClave } = require('./app_api');
const control = require('./control');

const router = express.Router();

// ── Auth: token firmado con HMAC (sin dependencias externas) ──
const SECRET = process.env.PANEL_SECRET || 'cambiar-este-secret-en-railway';

/** PANEL_USERS = "jose:clave123,owen:clave456" */
function usuarios() {
  const raw = process.env.PANEL_USERS || '';
  const map = {};
  raw.split(',').forEach(par => {
    const i = par.indexOf(':');
    if (i > 0) map[par.slice(0, i).trim()] = par.slice(i + 1);
  });
  return map;
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
  req.usuario = payload.usuario;
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
  const users = usuarios();
  if (!usuario || !clave || users[usuario] !== clave) {
    return res.status(401).json({ error: 'Usuario o clave incorrectos' });
  }
  const token = firmar({ usuario, exp: Date.now() + 12 * 60 * 60 * 1000 }); // 12h
  res.json({ token, usuario });
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
      supabase.from('cargas_combustible').select('estado, litros_total, fecha'),
      supabase.from('incidencias').select('estado, prioridad, created_at, fecha_finalizado, mecanicos(nombre), equipos(nombre,tipo), objetivos(nombre)'),
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
      .select('*, cargas_combustible_items(*), proveedores(nombre), unidades(patente), objetivos(nombre)')
      .order('fecha', { ascending: false })
      .limit(200);
    if (req.query.estado) q = q.eq('estado', req.query.estado);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('combustible:', err);
    res.status(500).json({ error: 'Error cargando combustible' });
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
      .select('*, equipos(nombre,tipo,codigo), capataces(nombre), objetivos(nombre), mecanicos(nombre,habilidades), comentarios_incidencias(mecanico_nombre,texto,created_at)')
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
    const { data, error } = await supabase
      .from('incidencias').update(patch).eq('id', req.params.id)
      .select('*, capataces(nombre,telefono), equipos(nombre), mecanicos(nombre)').single();
    if (error) throw error;

    // Aviso al capataz cuando la reparación se finaliza
    let notificado = false;
    if (req.body.estado === 'finalizado' && data.capataces && data.capataces.telefono) {
      const equipo   = data.equipos ? data.equipos.nombre : '—';
      const unidad   = data.numero_unidad || '—';
      const mecanico = data.mecanicos ? data.mecanicos.nombre : null;
      notificado = await notificarCapataz(
        data.capataces.telefono,
        `✅ *Reparación finalizada*\n\n` +
        `🔧 Equipo: ${equipo}\n` +
        `🔢 Unidad: ${unidad}\n` +
        (mecanico ? `👨‍🔧 Mecánico: ${mecanico}\n` : '') +
        `\nTu incidencia fue resuelta. ✅\n\n_EcoService · Taller_`
      );
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
  mecanicos: ['nombre', 'habilidades', 'activo', 'usuario', 'rol_app'],
  objetivos: ['nombre', 'ubicacion', 'tipo', 'activo'],
  capataces: ['nombre', 'telefono', 'objetivo_id', 'rol', 'activo'],
  centros_costo: ['nombre', 'activo'],
  unidades: ['codigo', 'marca_modelo', 'patente', 'responsable', 'objetivo_id', 'activo'],
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
    if (!fila.nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
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
      '- El IVA de cada ítem va en "monto_iva" (NO en "iva").\n' +
      '- Si la factura NO desglosa el IVA por ítem y solo lo trae en el total, ' +
      'prorrateá el IVA total entre los ítems proporcional a su monto_sin_iva, ' +
      'de modo que la suma de los monto_iva dé exactamente total_iva.\n' +
      '- La suma de monto_sin_iva de los ítems tiene que dar total_sin_iva.\n' +
      '- "otros_conceptos": TODO monto extra que NO sea neto ni IVA. Incluí: percepciones ' +
      '(IIBB/Ingresos Brutos de cualquier provincia, percepción IVA, ganancias), impuestos ' +
      '(sellados, tasa SSN, servicios sociales, gastos notariales, impuestos internos, tasa municipal). ' +
      'Poné el nombre tal como figura en "concepto". ' +
      'tipo="percepcion" para percepciones, tipo="impuesto" para sellados/tasas/servicios, tipo="otro" para el resto. ' +
      'Si no hay ninguno, devolvé otros_conceptos como lista vacía [].';
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      MODEL_EXTRACT,
        max_tokens: 4000,   // una factura rara vez pasa de 30 ítems
        messages:   [{ role: 'user', content: [part, { type: 'text', text: prompt }] }],
      }),
    });
    const data = await resp.json();
    const txt = (data.content || []).map(c => c.text || '').join('');
    console.log(`[factura] extraída en ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `(${MODEL_EXTRACT}, ${(data.usage && data.usage.output_tokens) || '?'} tokens)`);
    try {
      const parsed = JSON.parse(txt.replace(/```json|```/g, '').trim());
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
      .select('*, cargas_combustible_items(*), unidades(patente,codigo,marca), capataces(nombre), proveedores(nombre)')
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
        capataz: c.capataces ? c.capataces.nombre : null };
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
        capataz: c.capataces ? c.capataces.nombre : null, proveedor: c.proveedores ? c.proveedores.nombre : null })),
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

// ── Servir el panel (HTML estático) ───────────────────────────
router.get('/panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel.html'));
});

module.exports = router;
