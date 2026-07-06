const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const supabase = require('./supabase');
const { notificarCapataz } = require('./notificar');

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

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const payload = verificar(token);
  if (!payload) return res.status(401).json({ error: 'No autorizado' });
  req.usuario = payload.usuario;
  next();
}

// ── Login ─────────────────────────────────────────────────────
router.post('/api/login', (req, res) => {
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
    const [fact, ins, carg] = await Promise.all([
      supabase.from('facturas_proveedor').select('estado, total'),
      supabase.from('pedidos_insumos').select('estado'),
      supabase.from('cargas_combustible').select('estado, litros_total, total, fecha'),
    ]);

    const facturas = fact.data || [];
    const insumos  = ins.data  || [];
    const cargas   = carg.data || [];

    const cuenta = (arr, campo, val) => arr.filter(x => x[campo] === val).length;
    const suma   = (arr, campo) => arr.reduce((s, x) => s + (Number(x[campo]) || 0), 0);

    // combustible del mes en curso
    const ahora = new Date();
    const mesActual = cargas.filter(c => {
      if (!c.fecha) return false;
      const d = new Date(c.fecha);
      return d.getMonth() === ahora.getMonth() && d.getFullYear() === ahora.getFullYear();
    });

    res.json({
      facturas: {
        pendientes: cuenta(facturas, 'estado', 'pendiente'),
        aprobadas:  cuenta(facturas, 'estado', 'aprobada'),
        total_pendiente: suma(facturas.filter(f => f.estado === 'pendiente'), 'total'),
      },
      insumos: {
        pendientes: cuenta(insumos, 'estado', 'pendiente'),
        en_compra:  cuenta(insumos, 'estado', 'en_compra'),
      },
      combustible: {
        cargas_mes: mesActual.length,
        litros_mes: suma(mesActual, 'litros_total'),
        sin_facturar: cuenta(cargas, 'estado', 'sin_facturar'),
      },
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
    const patch = {};
    if (req.body.estado !== undefined) patch.estado = req.body.estado;
    const { data, error } = await supabase
      .from('pedidos_insumos').update(patch).eq('id', req.params.id)
      .select('*, capataces(nombre,telefono), objetivos(nombre)').single();
    if (error) throw error;

    // Aviso al capataz cuando el pedido se entrega
    let notificado = false;
    if (req.body.estado === 'entregado' && data.capataces && data.capataces.telefono) {
      const obj = data.objetivos ? data.objetivos.nombre : (data.objetivo_texto || '');
      notificado = await notificarCapataz(
        data.capataces.telefono,
        `📦 *Pedido entregado*\n\nTu pedido de insumos${obj ? ' para ' + obj : ''} ya fue entregado en depósito.\n\nGracias.`
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
      .select('*, capataces(nombre,telefono), equipos(nombre)').single();
    if (error) throw error;

    // Aviso al capataz cuando la reparación se finaliza
    let notificado = false;
    if (req.body.estado === 'finalizado' && data.capataces && data.capataces.telefono) {
      const equipo = data.equipos ? data.equipos.nombre : 'tu equipo';
      notificado = await notificarCapataz(
        data.capataces.telefono,
        `✅ *Reparación finalizada*\n\n${equipo} ya está reparado y listo para usar.\n\nGracias por reportarlo.`
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
      .from('mecanicos').select('id, nombre, habilidades').eq('activo', true).order('nombre');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('mecanicos:', err);
    res.status(500).json({ error: 'Error cargando mecánicos' });
  }
});

// ── MAESTROS · ABM de mecánicos, objetivos y capataces ────────
// Lista blanca de campos editables por tabla (protege columnas críticas)
const CAMPOS_MAESTRO = {
  mecanicos: ['nombre', 'habilidades', 'activo'],
  objetivos: ['nombre', 'ubicacion', 'tipo', 'activo'],
  capataces: ['nombre', 'telefono', 'objetivo_id', 'rol', 'activo'],
};

function filtrarCampos(tipo, body) {
  const permitidos = CAMPOS_MAESTRO[tipo] || [];
  const out = {};
  for (const k of permitidos) if (body[k] !== undefined) out[k] = body[k] === '' ? null : body[k];
  return out;
}

// Listar (incluye inactivos, para poder reactivar)
router.get('/api/maestros/:tipo', auth, async (req, res) => {
  const tipo = req.params.tipo;
  if (!CAMPOS_MAESTRO[tipo]) return res.status(400).json({ error: 'Tipo inválido' });
  try {
    const sel = tipo === 'capataces' ? '*, objetivos(nombre)' : '*';
    const { data, error } = await supabase.from(tipo).select(sel).order('nombre');
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

// ── Servir el panel (HTML estático) ───────────────────────────
router.get('/panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel.html'));
});

module.exports = router;
