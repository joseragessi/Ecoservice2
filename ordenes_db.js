// Órdenes de compra — lo que toca la base. Compartido por panel_api.js (los
// endpoints) y ordenes_bot.js (WhatsApp), para que crear una orden sea lo
// mismo venga de donde venga. La lógica pura está en ordenes.js.

const supabase = require('./supabase');
const supabaseCompras = require('./supabase_compras');
const ORD = require('./ordenes');

function aplanar(row) {
  const { data, ...duros } = row;
  const out = { ...(data || {}) };
  for (const [k, v] of Object.entries(duros)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

async function proximoNumeroOrden() {
  const anio = new Date().getFullYear();
  const { data } = await supabaseCompras.from('ordenes_compra')
    .select('numero').like('numero', `OC-${anio}-%`)
    .order('numero', { ascending: false }).limit(1);
  return ORD.siguienteNumero(data && data[0] ? data[0].numero : null, anio);
}

async function centrosDeCosto() {
  const { data } = await supabase.from('centros_costo').select('nombre, codigo_flexxus').eq('activo', true);
  return data || [];
}

async function unidadesTextoCompras() {
  const { data } = await supabase.from('unidades').select('codigo, marca_modelo, patente, responsable').eq('activo', true);
  return (data || []).map(u => [u.codigo, u.marca_modelo, u.patente, u.responsable].filter(Boolean).join(' — ')).filter(Boolean);
}

// Crea una orden. `datos` viene de ordenes.js (ordenDesdeRepuesto,
// ordenDesdeInsumo), del formulario o del bot. Reintenta el número si chocó
// con otra creada al mismo tiempo: el unique de la columna lo garantiza.
async function crearOrden(datos, usuario) {
  const abiertasRes = await supabaseCompras.from('ordenes_compra')
    .select('id, numero, estado, proveedor, cuit, total_estimado, fecha, data')
    .in('estado', ['abierta', 'borrador']).order('created_at', { ascending: false }).limit(200);
  const abiertas = (abiertasRes.data || []).map(o => ({ ...o, items: (o.data || {}).items || [] }));
  const fracc = ORD.detectarFraccionamiento(datos, abiertas);

  for (let intento = 0; intento < 3; intento++) {
    const numero = await proximoNumeroOrden();
    const fila = {
      numero,
      estado: datos.estado || 'abierta',
      proveedor: datos.proveedor || null,
      cuit: datos.cuit ? String(datos.cuit).replace(/\D/g, '') || null : null,
      total_estimado: Number(datos.total_estimado) || 0,
      fecha: datos.fecha || new Date().toISOString().slice(0, 10),
      origen_tipo: datos.origen_tipo || 'manual',
      origen_id: datos.origen_id ? String(datos.origen_id) : null,
      data: {
        descripcion: datos.descripcion || null,
        items: datos.items || [],
        tramo: datos.tramo || ORD.tramoDeMonto(datos.total_estimado),
        sin_cotizacion: !!datos.sin_cotizacion,
        cotizaciones: datos.cotizaciones || [],
        objetivo_pendiente: !!datos.objetivo_pendiente,
        objetivo_original: datos.objetivo_original || null,
        fraccionamiento: fracc.aviso ? fracc : null,
        remito_numero: datos.remito_numero || null,
        creado_por: usuario || 'sistema',
        creado_via: datos.creado_via || 'panel',
      },
    };
    const { data, error } = await supabaseCompras.from('ordenes_compra').insert(fila).select().single();
    if (!error) return { orden: aplanar(data), fraccionamiento: fracc };
    if (!/duplicate|unique/i.test(error.message || '')) throw error;
  }
  throw new Error('No pude asignar número a la orden (3 intentos)');
}

module.exports = { crearOrden, proximoNumeroOrden, centrosDeCosto, unidadesTextoCompras, aplanar };
