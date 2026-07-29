const supabase = require('./supabase');
const { extraerComprobante } = require('./extraccion');

// Sesiones de combustible EN MEMORIA.
// telefono -> { paso, datos, mediaUrl, capataz, unidad, itemsComb, indice, imputaciones }
//   paso: 'destino_item' | 'objetivo_item'
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

// ── Detección de doble carga ─────────────────────────────────
// Un remito puede llegar dos veces (el capataz reenvía la foto, o dos fotos
// del mismo papel con lecturas de OCR apenas distintas). Antes de guardar se
// busca: (a) mismo número de comprobante, o (b) misma fecha + mismos litros +
// mismo capataz o misma patente. Si aparece, se le pregunta al capataz.
function numNorm(n) {
  const d = String(n || '').replace(/\D/g, '').replace(/^0+/, '');
  return d || null;
}
async function buscarDuplicado(datos, capatazId, litrosTotal) {
  try {
    const desde = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const { data: recientes } = await supabase.from('cargas_combustible')
      .select('id, fecha, numero_remito, numero_factura, litros_total, patente_raw, capataz_id, capataces(nombre), proveedores(nombre)')
      .neq('estado', 'anulada').gte('fecha', desde)
      .order('fecha', { ascending: false }).limit(300);
    const num = numNorm(datos.numero);
    const pat = normalizarPatente(datos.patente || '');
    for (const c of (recientes || [])) {
      // (a) Mismo número de comprobante
      if (num && (numNorm(c.numero_remito) === num || numNorm(c.numero_factura) === num)) {
        return { carga: c, motivo: 'mismo número de comprobante' };
      }
      // (b) Misma fecha + mismos litros + mismo capataz o misma patente
      const litOk = litrosTotal && c.litros_total &&
        Math.abs(Number(c.litros_total) - Number(litrosTotal)) < 0.01;
      const patOk = pat && normalizarPatente(c.patente_raw || '') === pat;
      const capOk = capatazId && String(c.capataz_id) === String(capatazId);
      if (c.fecha === datos.fecha && litOk && (capOk || patOk)) {
        return { carga: c, motivo: 'misma fecha, mismos litros' };
      }
    }
  } catch (e) { console.error('buscarDuplicado:', e); }
  return null;
}

function resumenProductos(datos) {
  return (datos.items || [])
    .map(i => `  • ${i.producto}: ${i.litros ?? '—'} lt`)
    .join('\n');
}

/** Pregunta el destino del producto actual de la sesión. */
function preguntarItem(sesion) {
  const it  = sesion.itemsComb[sesion.indice];
  const total = sesion.itemsComb.length;
  const pos = total > 1 ? ` (${sesion.indice + 1}/${total})` : '';
  // Si la IA no leyó los litros, se los pedimos al capataz antes del destino.
  if (it.litros == null || it.litros === 0) {
    sesion.paso = 'litros_item';
    return `⛽ *${it.producto}*${pos}\n\n` +
           `No pude leer los litros en el ticket. ¿Cuántos litros cargaste?\n` +
           `Respondé solo el número (por ejemplo: 61,65).`;
  }
  sesion.paso = 'destino_item';
  const pat = sesion.datos.patente;
  const op1 = pat ? `A la unidad ${pat}` : 'A la unidad';
  return `⛽ *${it.producto}* — ${it.litros} lt${pos}\n` +
         `¿A dónde va?\n1️⃣ ${op1}\n2️⃣ A bidones\n\nRespondé 1 o 2.`;
}

/** Inserta la carga + items con la imputación por producto ya resuelta. */
async function guardarCarga(sesion) {
  const { datos, mediaUrl, capataz, itemsComb, imputaciones } = sesion;
  const esFactura = datos.tipo_doc === 'factura';
  const proveedorId = await resolverProveedor(datos.proveedor, datos.cuit);
  const litros = itemsComb.reduce((s, i) => s + (i.litros || 0), 0);

  // Resumen de destino de la carga
  const dests = imputaciones.map(x => x.destino);
  const resumen = dests.length && dests.every(d => d === 'unidad') ? 'unidad'
                : dests.length && dests.every(d => d === 'bidon')  ? 'bidon'
                : 'mixto';

  const unidadCargaId = resumen === 'unidad' && sesion.unidad ? sesion.unidad.id : null;
  const impObj = imputaciones.find(x => x.objetivo_id);
  const objCargaId = (impObj && impObj.objetivo_id)
                   || (sesion.unidad && sesion.unidad.objetivo_id)
                   || capataz.objetivo_id || null;

  const { data: carga, error } = await supabase
    .from('cargas_combustible')
    .insert({
      origen:         esFactura ? 'factura_capataz' : 'remito_capataz',
      tipo_doc:       datos.tipo_doc,
      estado:         esFactura ? 'facturada' : 'sin_facturar',
      destino:        resumen,
      unidad_id:      unidadCargaId,
      objetivo_id:    objCargaId,
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

  const items = (datos.items || []).map(it => {
    const idx = itemsComb.indexOf(it);
    const imp = idx >= 0 ? imputaciones[idx] : null;
    return {
      carga_id:       carga.id,
      producto:       it.producto,
      es_combustible: it.es_combustible !== false,
      litros:         it.litros ?? null,
      precio_unit:    it.precio_unit ?? null,
      subtotal:       it.subtotal ?? null,
      destino:        imp ? imp.destino : 'unidad',
      unidad_id:      imp ? imp.unidad_id : (sesion.unidad ? sesion.unidad.id : null),
      objetivo_id:    imp ? imp.objetivo_id : null,
    };
  });
  await supabase.from('cargas_combustible_items').insert(items);
  return carga;
}

/** Arma el resumen final que se le manda al capataz. */
function resumenFinal(sesion, nombre) {
  const lineas = sesion.itemsComb.map((it, idx) => {
    const imp = sesion.imputaciones[idx];
    const dest = imp.destino === 'bidon'
      ? `bidones → ${imp.objetivo_nombre || 'objetivo'}`
      : `unidad ${sesion.datos.patente || ''}`.trim();
    return `  • ${it.producto} (${it.litros ?? '—'} lt) → ${dest}`;
  }).join('\n');
  return `✅ Carga registrada, *${nombre}*:\n${lineas}`;
}

/** Avanza al siguiente producto, o guarda si ya no quedan. */
async function avanzar(tel, sesion, nombre) {
  sesion.indice++;
  if (sesion.indice < sesion.itemsComb.length) {
    sesion.paso = 'destino_item';
    return preguntarItem(sesion);
  }
  const carga = await guardarCarga(sesion);
  delete sesiones[tel];
  if (!carga) return '⚠️ No pude guardar la carga. Avisá a administración.';
  return resumenFinal(sesion, nombre);
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
  const itemsComb = (datos.items || []).filter(i => i.es_combustible !== false);

  const lineaDoc = datos.tipo_doc === 'factura'
    ? `📄 Factura ${datos.numero} — ${pesos(datos.total)}`
    : `📄 Remito ${datos.numero} — sin facturar`;
  const encabezado = `📸 Leí tu comprobante, *${nombre}*:\n\n⛽ ${datos.proveedor}\n${lineaDoc}\n${resumenProductos(datos)}\n\n`;

  // ¿Ya está cargado? (reenvío de la misma foto o dos fotos del mismo remito)
  const litrosTot = itemsComb.reduce((s, i) => s + (Number(i.litros) || 0), 0) || Number(datos.litros) || null;
  const dup = await buscarDuplicado(datos, capataz.id, litrosTot);
  if (dup) {
    sesiones[tel] = {
      paso: 'confirmar_dup', datos, mediaUrl, capataz, unidad,
      itemsComb, indice: 0, imputaciones: [],
    };
    const c = dup.carga;
    const quien = c.capataces ? c.capataces.nombre.split(' ')[0] : 'alguien';
    return `${encabezado}⚠️ *Ojo: esto parece estar cargado ya* (${dup.motivo}).\n\n` +
           `Registrado antes: ${c.proveedores ? c.proveedores.nombre : ''} · ` +
           `${c.numero_remito || c.numero_factura || 's/n'} · ${c.litros_total || '—'} lt · ` +
           `lo cargó ${quien}.\n\n` +
           `¿Qué hago?\n*1.* Es una carga NUEVA, registrala igual\n*2.* Es la misma, descartala`;
  }

  // Si no hay productos de combustible que discriminar, guardo directo.
  if (itemsComb.length === 0) {
    const sesion = { datos, mediaUrl, capataz, unidad, itemsComb: [], imputaciones: [] };
    const carga = await guardarCarga(sesion);
    if (!carga) return '⚠️ No pude guardar la carga. Avisá a administración.';
    return `${encabezado}✅ Registrada.`;
  }

  sesiones[tel] = {
    paso: 'destino_item', datos, mediaUrl, capataz, unidad,
    itemsComb, indice: 0, imputaciones: [],
  };

  const intro = itemsComb.length > 1
    ? `Tenés ${itemsComb.length} productos. Te pregunto uno por uno.\n\n`
    : '';
  return encabezado + intro + preguntarItem(sesiones[tel]);
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
  const it = sesion.itemsComb[sesion.indice];

  // Confirmación de posible doble carga
  if (sesion.paso === 'confirmar_dup') {
    if (texto === '1') {
      // Es una carga distinta: sigue el flujo normal
      if (sesion.itemsComb.length === 0) {
        const carga = await guardarCarga(sesion);
        delete sesiones[tel];
        if (!carga) return '⚠️ No pude guardar la carga. Avisá a administración.';
        return `✅ Registrada, *${nombre}*.`;
      }
      sesion.paso = 'destino_item';
      const intro = sesion.itemsComb.length > 1
        ? `Tenés ${sesion.itemsComb.length} productos. Te pregunto uno por uno.\n\n` : '';
      return intro + preguntarItem(sesion);
    }
    if (texto === '2') {
      delete sesiones[tel];
      return `👍 Listo, *${nombre}*, la descarté. No se registró nada.`;
    }
    return `Respondé *1* (es una carga nueva) o *2* (es la misma, descartar).`;
  }

  // El capataz responde los litros que la IA no pudo leer
  if (sesion.paso === 'litros_item') {
    // Acepta "61,65" y "61.65": si hay coma, el punto es separador de miles;
    // si no hay coma, el punto es decimal (como lo escribiría cualquiera).
    const limpio = texto.includes(',')
      ? texto.replace(/\./g, '').replace(',', '.')
      : texto.trim();
    const n = parseFloat(limpio);
    if (!isFinite(n) || n <= 0) {
      return `No entendí el número. ¿Cuántos litros cargaste de ${it.producto}?\nRespondé solo el número (por ejemplo: 61,65).`;
    }
    if (n > 2000) {
      return `${n} litros parece demasiado para una carga. Revisá el ticket y respondé solo los litros (por ejemplo: 61,65).`;
    }
    it.litros = n;
    // Ya tenemos los litros: seguimos con el destino de este mismo producto.
    return preguntarItem(sesion);
  }

  if (sesion.paso === 'destino_item') {
    if (texto === '1') {
      sesion.imputaciones[sesion.indice] = {
        destino: 'unidad',
        unidad_id: sesion.unidad ? sesion.unidad.id : null,
        objetivo_id: null,
      };
      return avanzar(tel, sesion, nombre);
    }
    if (texto === '2') {
      sesion.paso = 'objetivo_item';
      const miObj = sesion.capataz.objetivo_nombre || 'tu objetivo';
      return `¿A qué objetivo van los bidones de *${it.producto}*?\n\n` +
             `Respondé *mío* para ${miObj}, o escribí el nombre de otro objetivo.`;
    }
    const pat = sesion.datos.patente ? ' ' + sesion.datos.patente : '';
    return `Respondé *1* (unidad${pat}) o *2* (bidones).`;
  }

  if (sesion.paso === 'objetivo_item') {
    const obj = await resolverObjetivo(texto, sesion.capataz);
    if (!obj || !obj.id) {
      return `No encontré ese objetivo. Escribí el nombre de nuevo, o *mío* para tu objetivo.`;
    }
    sesion.imputaciones[sesion.indice] = {
      destino: 'bidon', unidad_id: null,
      objetivo_id: obj.id, objetivo_nombre: obj.nombre,
    };
    return avanzar(tel, sesion, nombre);
  }

  return null;
}

module.exports = { procesarComprobante, tieneSesionActiva, continuarConversacion };
