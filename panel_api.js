const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const supabase = require('./supabase');
const supabaseCompras = require('./supabase_compras');
const { notificarCapataz } = require('./notificar');
const { hashClave } = require('./app_api');

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
const CAMPOS_MAESTRO = {
  mecanicos: ['nombre', 'habilidades', 'activo', 'usuario', 'rol_app'],
  objetivos: ['nombre', 'ubicacion', 'tipo', 'activo'],
  capataces: ['nombre', 'telefono', 'objetivo_id', 'rol', 'activo'],
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

// Extraer datos de una factura con IA (proxy a Claude, key server-side)
router.post('/api/compras/extract', auth, async (req, res) => {
  try {
    const { fileData, fileType } = req.body || {};
    if (!fileData) return res.status(400).json({ error: 'Falta el archivo' });
    const isImg = fileType && fileType.startsWith('image/');
    const part = isImg
      ? { type: 'image',    source: { type: 'base64', media_type: fileType, data: fileData } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } };
    const prompt = 'Analizá esta factura argentina y devolvé ÚNICAMENTE JSON sin backticks:\n' +
      '{"fecha_factura":"YYYY-MM-DD","numero_factura":"string","proveedor":"string","cuit":"string",' +
      '"items":[{"descripcion":"string","cantidad":1,"monto_sin_iva":0.00,"iva":0.00}],' +
      '"total_sin_iva":0.00,"total_iva":0.00}\n' +
      'Montos como números. Campos ilegibles: null.';
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 8000,
        messages:   [{ role: 'user', content: [part, { type: 'text', text: prompt }] }],
      }),
    });
    const data = await resp.json();
    const txt = (data.content || []).map(c => c.text || '').join('');
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
router.post('/api/compras/factura', auth, async (req, res) => {
  try {
    const inv = req.body || {};
    const { data, error } = await supabaseCompras
      .from('facturas').insert({ numero_factura: inv.numero_factura || null, data: inv })
      .select().single();
    if (error) throw error;
    res.json(aplanar(data));
  } catch (err) {
    console.error('compras crear factura:', err);
    res.status(500).json({ error: 'Error guardando la factura' });
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
    const prompt = 'Esto es un LISTADO CONSOLIDADO de remitos de combustible de un proveedor argentino ' +
      '(una fila por entrega, con fecha, número de comprobante/remito, chofer, patente, artículo, cantidad en litros, precio y total). ' +
      'Devolvé ÚNICAMENTE JSON sin backticks:\n' +
      '{"proveedor":"string","periodo_desde":"YYYY-MM-DD","periodo_hasta":"YYYY-MM-DD",' +
      '"filas":[{"fecha":"YYYY-MM-DD","numero_remito":"string","patente":"string","chofer":"string o null",' +
      '"producto":"string","litros":0.0,"precio_unit":0.0,"total":0.0,"numero_factura":"string o null"}],' +
      '"total_general":0.0}\n' +
      'Reglas: el año de las fechas sacalo del encabezado del período. Una fila del JSON por cada línea producto ' +
      '(si un remito tiene 2 productos, son 2 filas con el mismo numero_remito). Patente tal como figura. ' +
      'Montos como números sin separador de miles. Campos ilegibles: null.';
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 32000,
        messages:   [{ role: 'user', content: [part, { type: 'text', text: prompt }] }],
      }),
    });
    const data = await resp.json();
    console.log(`[listado] anthropic status=${resp.status} stop=${data.stop_reason || '?'} en ${Math.round((Date.now() - t0) / 1000)}s`);
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
      const parsed = JSON.parse(raw);
      console.log(`[listado] extraídas ${(parsed.filas || []).length} filas de ${parsed.proveedor || '?'}`);
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
function mensajeStock(periodo) {
  return `📋 *Stock de maquinaria — ${mesLindo(periodo)}*\n\n` +
         `Necesitamos el listado de maquinaria de tu objetivo. ` +
         `Respondé este mensaje con el listado, poniendo cantidades y números de máquina.\n\n` +
         `Ejemplo:\n_3 motoguadañas N° 12, 15 y 21, 1 tractor N° 4, 2 hidrolavadoras_\n\n` +
         `_EcoService · Logística_`;
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

    const msg = mensajeStock(periodo);
    let enviados = 0, sinCapataz = 0, yaRespondidos = 0;

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
      for (const c of capsObj) await notificarCapataz(c.telefono, msg);
      enviados++;
    }
    console.log(`[stock] pedido ${periodo}: enviados=${enviados} sin_capataz=${sinCapataz} ya_respondidos=${yaRespondidos}`);
    res.json({ enviados, sin_capataz: sinCapataz, ya_respondidos: yaRespondidos });
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

    const msg = mensajeStock(censo.periodo);
    let enviados = 0;
    for (const c of conTel) { if (await notificarCapataz(c.telefono, msg)) enviados++; }
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
