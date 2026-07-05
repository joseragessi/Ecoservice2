const supabase = require('./supabase');
const { extraerComprobante } = require('./extraccion');

// ── Helpers ───────────────────────────────────────────────────

/**
 * Descarga la imagen del comprobante desde Twilio (MediaUrl privada,
 * requiere auth básica con Account SID + Auth Token).
 */
async function descargarImagen(mediaUrl) {
  const auth = Buffer
    .from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`)
    .toString('base64');

  const resp = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!resp.ok) throw new Error(`No se pudo descargar la imagen (HTTP ${resp.status})`);
  return Buffer.from(await resp.arrayBuffer());
}

/** Normaliza una patente para comparar: mayúsculas, sin espacios ni guiones. */
function normalizarPatente(p) {
  if (!p) return null;
  return p.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Formatea un número al estilo argentino ($ 147.141,40). */
function pesos(n) {
  if (n == null) return '—';
  return '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Busca en unidades la que matchee la patente (comparando normalizado).
 * Trae las unidades activas y compara en memoria: son pocas y así
 * toleramos diferencias de formato (espacios, guiones).
 */
async function resolverUnidad(patenteRaw) {
  const norm = normalizarPatente(patenteRaw);
  if (!norm) return null;

  const { data: unidades } = await supabase
    .from('unidades')
    .select('id, patente, objetivo_id')
    .eq('activo', true);

  if (!unidades) return null;
  return unidades.find(u => normalizarPatente(u.patente) === norm) || null;
}

/**
 * Devuelve el id del proveedor: lo busca por CUIT y, si no existe, lo crea.
 * Así el maestro de proveedores se va poblando solo desde las cargas.
 */
async function resolverProveedor(nombre, cuit) {
  if (cuit) {
    const { data: existente } = await supabase
      .from('proveedores').select('id').eq('cuit', cuit).maybeSingle();
    if (existente) return existente.id;
  }
  const { data: nuevo } = await supabase
    .from('proveedores')
    .insert({ nombre: nombre || 'Sin nombre', cuit: cuit || null, rubro: 'combustible' })
    .select('id').single();
  return nuevo ? nuevo.id : null;
}

// ── Flujo principal ───────────────────────────────────────────

/**
 * El capataz mandó una foto de un remito o factura de carga.
 * PASO 3 (este archivo): extrae con Claude, resuelve unidad + proveedor,
 * e inserta la carga en cargas_combustible + sus items.
 */
async function procesarComprobante(telefono, mediaUrl, mediaType) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');

  const { data: capataz } = await supabase
    .from('capataces')
    .select('id, nombre, objetivo_id')
    .eq('telefono', tel)
    .eq('activo', true)
    .single();

  if (!capataz) {
    return '❌ Tu número no está registrado en el sistema EcoService. Contactá a administración.';
  }

  const nombre = capataz.nombre.split(' ')[0];

  if (!mediaType || !mediaType.startsWith('image/')) {
    return `Recibí un archivo, pero no es una imagen. Mandame la *foto* del remito o la factura, ${nombre}.`;
  }

  // 1) Descargar la imagen
  let imagen;
  try {
    imagen = await descargarImagen(mediaUrl);
  } catch (err) {
    console.error('Error descargando imagen:', err);
    return '⚠️ No pude descargar la foto. Probá mandarla de nuevo en un momento.';
  }

  console.log(`[COMBUSTIBLE] ${capataz.nombre}: imagen de ${imagen.length} bytes (${mediaType})`);

  // 2) Extraer los datos con Claude
  let datos;
  try {
    datos = await extraerComprobante(imagen, mediaType);
  } catch (err) {
    console.error('Error extrayendo comprobante:', err);
    return '⚠️ Recibí la foto pero no pude leer bien los datos. ¿Podés sacarla más nítida y mandarla de nuevo?';
  }

  console.log('[COMBUSTIBLE] extraído:', JSON.stringify(datos));

  // 3) Resolver unidad (por patente) y proveedor (por CUIT)
  const esFactura  = datos.tipo_doc === 'factura';
  const unidad     = await resolverUnidad(datos.patente);
  const proveedorId = await resolverProveedor(datos.proveedor, datos.cuit);

  const litros = (datos.items || [])
    .filter(i => i.es_combustible !== false)
    .reduce((s, i) => s + (i.litros || 0), 0);

  // 4) Insertar la carga
  const { data: carga, error } = await supabase
    .from('cargas_combustible')
    .insert({
      origen:         esFactura ? 'factura_capataz' : 'remito_capataz',
      tipo_doc:       datos.tipo_doc,
      estado:         esFactura ? 'facturada' : 'sin_facturar',
      unidad_id:      unidad ? unidad.id : null,
      objetivo_id:    (unidad && unidad.objetivo_id) || capataz.objetivo_id || null,
      capataz_id:     capataz.id,
      proveedor_id:   proveedorId,
      fecha:          datos.fecha,
      numero_remito:  esFactura ? null : datos.numero,
      numero_factura: esFactura ? datos.numero : null,
      patente_raw:    datos.patente,
      chofer_raw:     datos.chofer,
      litros_total:   litros || null,
      neto:           datos.neto,
      iva:            datos.iva,
      otros_tributos: datos.otros_tributos,
      total:          datos.total,
      imagen_url:     mediaUrl,
      datos_ia:       datos,
    })
    .select('id')
    .single();

  if (error || !carga) {
    console.error('Error insertando carga:', error);
    return '⚠️ Leí el comprobante pero no pude guardarlo. Avisá a administración así lo revisan.';
  }

  // 5) Insertar los items
  if (datos.items && datos.items.length) {
    const items = datos.items.map(i => ({
      carga_id:       carga.id,
      producto:       i.producto,
      es_combustible: i.es_combustible !== false,
      litros:         i.litros ?? null,
      precio_unit:    i.precio_unit ?? null,
      subtotal:       i.subtotal ?? null,
    }));
    await supabase.from('cargas_combustible_items').insert(items);
  }

  // 6) Confirmar al capataz
  const detalleProductos = (datos.items || [])
    .map(i => `  • ${i.producto}: ${i.litros ?? '—'} lt`)
    .join('\n');

  const lineaUnidad = unidad
    ? `🚗 Unidad: ${datos.patente} ✓`
    : `🚗 Patente ${datos.patente || '—'} — _sin imputar todavía_`;

  const lineaDoc = esFactura
    ? `📄 Factura ${datos.numero} — ${pesos(datos.total)}`
    : `📄 Remito ${datos.numero} — sin facturar`;

  return `✅ Carga registrada, *${nombre}*:\n\n` +
         `⛽ ${datos.proveedor}\n` +
         `${lineaUnidad}\n` +
         `${lineaDoc}\n` +
         `${detalleProductos}\n` +
         `Total combustible: ${litros.toFixed(2)} lt`;
}

module.exports = { procesarComprobante };
