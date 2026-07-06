const supabase = require('./supabase');
const { extraerComprobante } = require('./extraccion');

// Sesiones de combustible EN MEMORIA (igual criterio que incidencias).
// telefono -> { paso, datos, mediaUrl, capataz, destino }
//   paso: 'esperando_destino' | 'esperando_objetivo'
const sesiones = {};

// ── Helpers ───────────────────────────────────────────────────

async function descargarImagen(mediaUrl) {
  const auth = Buffer
    .from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`)
    .toString('base64');
  const resp = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!resp.ok) throw new Error(`No se pudo descargar la imagen (HTTP ${resp.status})`);
  return Buffer.from(await resp.arrayBuffer());
}

function normalizarPatente(p) {
  if (!p) return null;
  return p.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function pesos(n) {
  if (n == null) return '—';
  return '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function resolverUnidad(patenteRaw) {
  const norm = normalizarPatente(patenteRaw);
  if (!norm) return null;
  const { data: unidades } = await supabase
    .from('unidades').select('id, patente, objetivo_id').eq('activo', true);
  if (!unidades) return null;
  return unidades.find(u => normalizarPatente(u.patente) === norm) || null;
}

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

/** Resuelve el objetivo de los bidones: 'mío' -> el del capataz; texto -> match por nombre. */
async function resolverObjetivo(texto, capataz) {
  const t = texto.trim().toLowerCase();
  if (['mio', 'mío', 'el mio', 'el mío', 'mi objetivo'].includes(t)) {
    return { id: capataz.objetivo_id, nombre: capataz.objetivo_nombre || 'tu objetivo' };
  }
  const { data: objetivos } = await supabase
    .from('objetivos').select('id, nombre').eq('activo', true);
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const nt = norm(texto);
  const match = (objetivos || []).find(o => {
    const no = norm(o.nombre);
    return no.includes(nt) || nt.includes(no);
  });
  return match ? { id: match.id, nombre: match.nombre } : null;
}

/** Inserta la carga + items con el destino y el objetivo ya resueltos. */
async function guardarCarga({ datos, mediaUrl, capataz, unidad }, destino, objetivoId) {
  const esFactura = datos.tipo_doc === 'factura';
  const proveedorId = await resolverProveedor(datos.proveedor, datos.cuit);
  const litros = (datos.items || [])
    .filter(i => i.es_combustible !== false)
    .reduce((s, i) => s + (i.litros || 0), 0);

  // Para bidón no se imputa unidad (aunque el remito traiga patente).
  const unidadId = destino === 'bidon' ? null : (unidad ? unidad.id : null);

  const { data: carga, error } = await supabase
    .from('cargas_combustible')
    .insert({
      origen:         esFactura ? 'factura_capataz' : 'remito_capataz',
      tipo_doc:       datos.tipo_doc,
      estado:         esFactura ? 'facturada' : 'sin_facturar',
      destino,
      unidad_id:      unidadId,
      objetivo_id:    objetivoId || (unidad && unidad.objetivo_id) || capataz.objetivo_id || null,
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
    .select('id').single();

  if (error || !carga) {
    console.error('Error insertando carga:', error);
    return null;
  }

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
  return carga;
}

/** Resumen de productos para los mensajes. */
function resumenProductos(datos) {
  return (datos.items || [])
    .map(i => `  • ${i.producto}: ${i.litros ?? '—'} lt`)
    .join('\n');
}

// ── Entrada 1: llega la FOTO ──────────────────────────────────

async function procesarComprobante(telefono, mediaUrl, mediaType) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');

  const { data: capataz } = await supabase
    .from('capataces')
    .select('id, nombre, objetivo_id, objetivos(nombre)')
    .eq('telefono', tel).eq('activo', true).single();

  if (!capataz) {
    return '❌ Tu número no está registrado en el sistema EcoService. Contactá a administración.';
  }
  capataz.objetivo_nombre = capataz.objetivos ? capataz.objetivos.nombre : null;
  const nombre = capataz.nombre.split(' ')[0];

  if (!mediaType || !mediaType.startsWith('image/')) {
    return `Recibí un archivo, pero no es una imagen. Mandame la *foto* del remito o la factura, ${nombre}.`;
  }

  let imagen;
  try {
    imagen = await descargarImagen(mediaUrl);
  } catch (err) {
    console.error('Error descargando imagen:', err);
    return '⚠️ No pude descargar la foto. Probá mandarla de nuevo en un momento.';
  }

  console.log(`[COMBUSTIBLE] ${capataz.nombre}: imagen de ${imagen.length} bytes (${mediaType})`);

  let datos;
  try {
    datos = await extraerComprobante(imagen, mediaType);
  } catch (err) {
    console.error('Error extrayendo comprobante:', err);
    return '⚠️ Recibí la foto pero no pude leer bien los datos. ¿Podés sacarla más nítida y mandarla de nuevo?';
  }
  console.log('[COMBUSTIBLE] extraído:', JSON.stringify(datos));

  const unidad = await resolverUnidad(datos.patente);

  // Guardar la sesión y preguntar el destino
  sesiones[tel] = { paso: 'esperando_destino', datos, mediaUrl, capataz, unidad };

  const lineaDoc = datos.tipo_doc === 'factura'
    ? `📄 Factura ${datos.numero} — ${pesos(datos.total)}`
    : `📄 Remito ${datos.numero} — sin facturar`;
  const opcionUnidad = datos.patente ? `A la unidad ${datos.patente}` : 'A la unidad';

  return `📸 Leí tu comprobante, *${nombre}*:\n\n` +
         `⛽ ${datos.proveedor}\n${lineaDoc}\n${resumenProductos(datos)}\n\n` +
         `¿A dónde va esta carga?\n` +
         `1️⃣ ${opcionUnidad}\n` +
         `2️⃣ A bidones (máquinas)\n` +
         `3️⃣ Mixto (unidad + bidones)\n\n` +
         `Respondé 1, 2 o 3.`;
}

// ── Entrada 2: llega TEXTO con sesión activa ──────────────────

function tieneSesionActiva(telefono) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');
  return !!sesiones[tel];
}

async function continuarConversacion(telefono, mensaje) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');
  const sesion = sesiones[tel];
  if (!sesion) return null;

  const texto = (mensaje || '').trim();
  const nombre = sesion.capataz.nombre.split(' ')[0];

  // Paso A: eligió el destino (1/2/3)
  if (sesion.paso === 'esperando_destino') {
    if (texto === '1') {
      const carga = await guardarCarga(sesion, 'unidad', null);
      delete sesiones[tel];
      if (!carga) return '⚠️ No pude guardar la carga. Avisá a administración.';
      const imput = sesion.unidad
        ? `unidad ${sesion.datos.patente} ✓`
        : `patente ${sesion.datos.patente || '—'} (sin imputar todavía)`;
      return `✅ Carga registrada a ${imput}, *${nombre}*.`;
    }
    if (texto === '2' || texto === '3') {
      sesion.destino = texto === '2' ? 'bidon' : 'mixto';
      sesion.paso = 'esperando_objetivo';
      const miObj = sesion.capataz.objetivo_nombre || 'tu objetivo';
      return `¿A qué objetivo van los bidones?\n\n` +
             `Respondé *mío* para ${miObj}, o escribí el nombre de otro objetivo.`;
    }
    return 'Respondé *1* (unidad), *2* (bidones) o *3* (mixto).';
  }

  // Paso B: eligió el objetivo de los bidones
  if (sesion.paso === 'esperando_objetivo') {
    const obj = await resolverObjetivo(texto, sesion.capataz);
    if (!obj || !obj.id) {
      return `No encontré ese objetivo. Escribí el nombre de nuevo, o respondé *mío* para tu objetivo.`;
    }
    const carga = await guardarCarga(sesion, sesion.destino, obj.id);
    delete sesiones[tel];
    if (!carga) return '⚠️ No pude guardar la carga. Avisá a administración.';
    const tipo = sesion.destino === 'mixto' ? 'Carga mixta' : 'Bidones';
    return `✅ ${tipo} registrada para *${obj.nombre}*, ${nombre}.`;
  }

  return null;
}

module.exports = { procesarComprobante, tieneSesionActiva, continuarConversacion };
