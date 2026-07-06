const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const supabase = require('./supabase');

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
      .from('pedidos_insumos').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
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

// ── Servir el panel (HTML estático) ───────────────────────────
router.get('/panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel.html'));
});

module.exports = router;
