const supabase = require('./supabase');
const { extraerFactura } = require('./facturas');   // el extractor que subiste como facturas.js

// ── Helpers ───────────────────────────────────────────────────

/** Descarga el archivo (foto o PDF) desde Twilio (MediaUrl privada, auth básica). */
async function descargarArchivo(mediaUrl) {
  const auth = Buffer
    .from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`)
    .toString('base64');
  const resp = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!resp.ok) throw new Error(`No se pudo descargar el archivo (HTTP ${resp.status})`);
  return Buffer.from(await resp.arrayBuffer());
}

function pesos(n) {
  if (n == null) return '—';
  return '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Busca el proveedor por CUIT; si no existe lo crea. Devuelve su id (o null). */
async function resolverProveedor(nombre, cuit) {
  if (cuit) {
    const { data: existente } = await supabase
      .from('proveedores').select('id').eq('cuit', cuit).maybeSingle();
    if (existente) return existente.id;
  }
  const { data: nuevo } = await supabase
    .from('proveedores')
    .insert({ nombre: nombre || 'Sin nombre', cuit: cuit || null })
    .select('id').single();
  return nuevo ? nuevo.id : null;
}

// ── Flujo principal ───────────────────────────────────────────

/**
 * El proveedor mandó su factura (foto o PDF) al número de facturas.
 * Lee con Claude, resuelve el proveedor por CUIT, y guarda la factura
 * como 'pendiente' para que Owen/José la imputen en el panel.
 *
 * @param {string} telefono   - whatsapp:+549...  (del proveedor)
 * @param {string} mediaUrl   - URL del archivo en Twilio
 * @param {string} mediaType  - "image/jpeg" | "image/png" | "application/pdf"
 * @returns {Promise<string>} respuesta a enviar al proveedor
 */
async function procesarFactura(telefono, mediaUrl, mediaType) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');

  // Aceptamos imagen o PDF
  const esImagen = mediaType && mediaType.startsWith('image/');
  const esPdf    = mediaType === 'application/pdf';
  if (!esImagen && !esPdf) {
    return 'Recibí un archivo, pero necesito la *factura* como foto o PDF. ¿Podés reenviarla?';
  }

  let archivo;
  try {
    archivo = await descargarArchivo(mediaUrl);
  } catch (err) {
    console.error('Error descargando archivo:', err);
    return '⚠️ No pude descargar el archivo. Probá reenviarlo en un momento.';
  }

  console.log(`[FACTURA] de ${tel}: ${archivo.length} bytes (${mediaType})`);

  let datos;
  try {
    datos = await extraerFactura(archivo, mediaType);
  } catch (err) {
    console.error('Error extrayendo factura:', err);
    return '⚠️ Recibí el archivo pero no pude leer bien la factura. ¿Podés reenviarla más nítida?';
  }
  console.log('[FACTURA] extraída:', JSON.stringify(datos));

  const proveedorId = await resolverProveedor(datos.proveedor, datos.cuit);

  // Guardar la factura como 'pendiente'
  const { data: factura, error } = await supabase
    .from('facturas_proveedor')
    .insert({
      estado:            'pendiente',
      proveedor_id:      proveedorId,
      proveedor_nombre:  datos.proveedor,
      cuit:              datos.cuit,
      tipo_comprobante:  datos.tipo_comprobante,
      numero:            datos.numero,
      fecha:             datos.fecha,
      vencimiento:       datos.vencimiento,
      vendedor:          datos.vendedor,
      cond_venta:        datos.cond_venta,
      subtotal:          datos.subtotal,
      bonificacion:      datos.bonificacion,
      iva:               datos.iva,
      otros_tributos:    datos.otros_tributos,
      total:             datos.total,
      cae:               datos.cae,
      telefono_remitente: tel,
      archivo_url:       mediaUrl,
      archivo_tipo:      mediaType,
      datos_ia:          datos,
    })
    .select('id').single();

  if (error || !factura) {
    console.error('Error insertando factura:', error);
    return '⚠️ Recibí la factura pero no pude registrarla. Vamos a revisarlo, gracias.';
  }

  // Items de la factura
  if (datos.items && datos.items.length) {
    const items = datos.items.map(i => ({
      factura_id:  factura.id,
      codigo:      i.codigo ?? null,
      descripcion: i.descripcion || '(sin descripción)',
      cantidad:    i.cantidad ?? null,
      precio_unit: i.precio_unit ?? null,
      bonif:       i.bonif ?? null,
      importe:     i.importe ?? null,
    }));
    await supabase.from('facturas_proveedor_items').insert(items);
  }

  // Confirmación al proveedor
  return `✅ Recibimos tu factura, gracias.\n\n` +
         `🏢 ${datos.proveedor}\n` +
         `📄 ${datos.tipo_comprobante || ''} ${datos.numero || ''}\n` +
         `💰 Total: ${pesos(datos.total)}\n` +
         `${datos.vencimiento ? `📅 Vence: ${datos.vencimiento}\n` : ''}` +
         `\nLa vamos a procesar. ¡Gracias!`;
}

module.exports = { procesarFactura };
