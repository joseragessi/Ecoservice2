const supabase = require('./supabase');
const ses = require('./sesion');
const { extraerComprobante, parsearDestinoCombustible } = require('./extraccion');

// Sesiones de combustible EN MEMORIA.
// telefono -> { paso, datos, mediaUrl, capataz, unidad, itemsComb, indice, repartos, textoLibre }
//   paso: 'confirmar_dup' | 'litros_item' | 'destino_libre' | 'objetivo_bidones' | 'confirmar_libre'
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

// La impresión térmica confunde caracteres (U/V, I/1, A/4…) y el OCR a veces
// lee mal la patente. Como la flota es un conjunto chico y cerrado, se corrige
// matcheando contra las patentes reales: si hay UNA sola unidad a distancia de
// edición ≤ 2, es esa. Si hay empate o nada cerca, no se adivina.
function distanciaEdicion(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
                         d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
async function resolverUnidadAprox(patenteRaw) {
  const norm = normalizarPatente(patenteRaw);
  if (!norm) return null;
  const { data: unidades } = await supabase
    .from('unidades').select('id, patente, objetivo_id').eq('activo', true);
  if (!unidades) return null;
  const exacta = unidades.find(u => normalizarPatente(u.patente) === norm);
  if (exacta) return { unidad: exacta, corregida: false };
  const cerca = unidades
    .filter(u => u.patente)
    .map(u => ({ u, d: distanciaEdicion(norm, normalizarPatente(u.patente)) }))
    .filter(x => x.d <= 2)
    .sort((a, b) => a.d - b.d);
  if (cerca.length === 1 || (cerca.length > 1 && cerca[0].d < cerca[1].d)) {
    return { unidad: cerca[0].u, corregida: true };
  }
  return null;
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

// Machea "bobcat", "tractor", etc. contra el maestro de activos. Busca primero
// en unidades (tipo_activo, código o marca/modelo); si no, cae al viejo maestro
// de equipos. Si no hay un match único, devuelve null y queda como texto.
async function resolverEquipo(texto) {
  if (!texto) return null;
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const nt = norm(texto);
  if (!nt) return null;

  // 1) Maestro de activos (unidades con tipo_activo)
  const { data: activos } = await supabase
    .from('unidades').select('id, codigo, marca_modelo, tipo_activo').eq('activo', true);
  const matchA = (activos || []).filter(u => {
    const campos = [u.tipo_activo, u.marca_modelo, u.codigo].map(norm).filter(Boolean);
    return campos.some(c => c.includes(nt) || nt.includes(c));
  });
  if (matchA.length === 1) {
    return { unidad_id: matchA[0].id, nombre: matchA[0].tipo_activo || matchA[0].marca_modelo || matchA[0].codigo };
  }

  return null;
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

/** Pide los litros que la IA no pudo leer; cuando están todos, pasa al destino. */
function preguntarLitros(sesion) {
  const idx = sesion.itemsComb.findIndex(i => i.litros == null || i.litros === 0);
  if (idx >= 0) {
    sesion.indice = idx;
    sesion.paso = 'litros_item';
    const it = sesion.itemsComb[idx];
    return `⛽ *${it.producto}*\n\n` +
           `No pude leer los litros en el ticket. ¿Cuántos litros cargaste?\n` +
           `Respondé solo el número (por ejemplo: 61,65).`;
  }
  return preguntarDestino(sesion);
}

/** Una sola pregunta abierta: a dónde va la carga. */
function preguntarDestino(sesion) {
  sesion.paso = 'destino_libre';
  const pat = sesion.datos.patente ? ` ${sesion.datos.patente}` : '';
  return `¿A dónde va la carga? Contame libre, podés repartir.\n` +
         `Por ejemplo: _"50 del gasoil a la bobcat y 50 a la unidad, la super a bidones para Ayres"_\n\n` +
         `Atajos: *1* todo a la unidad${pat} · *2* todo a bidones`;
}

/** Describe un reparto para los resúmenes. */
function descReparto(r, sesion) {
  if (r.destino === 'bidon')  return `bidones → ${r.objetivo_nombre || '¿objetivo?'}`;
  if (r.destino === 'equipo') return `${r.equipo_nombre || r.detalle || 'equipo'}${(r.equipo_id || r.unidad_id) ? '' : ' (sin machear)'}` +
                                     (r.objetivo_nombre ? ` → ${r.objetivo_nombre}` : '');
  return `unidad ${r.patente_txt || sesion.datos.patente || ''}`.trim();
}

function resumenRepartos(sesion) {
  return sesion.repartos
    .map(r => `  • ${(sesion.itemsComb[r.item_idx] || {}).producto || ''} ${r.litros} lt → ${descReparto(r, sesion)}`)
    .join('\n');
}

/** Convierte lo que devolvió la IA en repartos validados y resueltos contra maestros. */
async function construirRepartos(parseo, sesion) {
  if (!parseo || parseo.ok === false || !Array.isArray(parseo.repartos) || !parseo.repartos.length) {
    return { error: (parseo && parseo.motivo) || 'No entendí el reparto.' };
  }
  const repartos = [];
  for (const p of parseo.repartos) {
    const it = sesion.itemsComb[p.item];
    const litros = Number(p.litros);
    if (!it || !isFinite(litros) || litros <= 0) return { error: 'No entendí el reparto.' };
    if (!['unidad', 'bidon', 'equipo'].includes(p.destino)) return { error: 'No entendí el reparto.' };
    const r = { item_idx: p.item, litros: Math.round(litros * 100) / 100, destino: p.destino,
                detalle: p.detalle || null, objetivo_texto: p.objetivo || null,
                unidad_id: null, equipo_id: null, objetivo_id: null };
    if (p.destino === 'unidad') {
      if (p.patente) {
        // El capataz nombró la patente: manda la suya, no la lectura del ticket.
        const pn = normalizarPatente(p.patente);
        const aprox = await resolverUnidadAprox(pn);
        const u = aprox ? aprox.unidad : null;
        if (u) {
          r.unidad_id = u.id; r.patente_txt = u.patente;
          sesion.unidad = u; sesion.datos.patente = u.patente;
        } else {
          // No está en la flota: se acepta igual y queda visible como texto.
          r.unidad_id = null; r.patente_txt = pn; r.detalle = pn;
          sesion.unidad = null; sesion.datos.patente = pn;
        }
        sesion.patenteCorregida = true;
      } else {
        r.unidad_id = sesion.unidad ? sesion.unidad.id : null;
      }
    }
    if (p.destino === 'equipo') {
      const eq = await resolverEquipo(p.detalle);
      if (eq) {
        if (eq.unidad_id) r.unidad_id = eq.unidad_id;   // activo del maestro real
        else r.equipo_id = eq.id;                        // placeholder viejo
        r.equipo_nombre = eq.nombre;
      }
    }
    if (p.objetivo) {
      const obj = await resolverObjetivo(p.objetivo, sesion.capataz);
      if (!obj || !obj.id) return { error: `No encontré el objetivo "${p.objetivo}". Escribí el reparto de nuevo con el nombre como figura.` };
      r.objetivo_id = obj.id; r.objetivo_nombre = obj.nombre;
    }
    repartos.push(r);
  }
  // Los litros repartidos tienen que cerrar contra el ticket, producto por producto.
  for (let ix = 0; ix < sesion.itemsComb.length; ix++) {
    const it = sesion.itemsComb[ix];
    const suma = repartos.filter(r => r.item_idx === ix).reduce((s, r) => s + r.litros, 0);
    const dif = suma - (Number(it.litros) || 0);
    if (dif > 0.6)  return { error: `Asignaste ${suma} lt de ${it.producto}, pero el ticket dice ${it.litros} lt. Contame de nuevo cómo se reparte.` };
    if (dif < -0.6) return { error: `Te faltó asignar ${Math.round((-dif) * 100) / 100} lt de ${it.producto} (el ticket dice ${it.litros} lt). Contame de nuevo el reparto completo.` };
  }
  const faltanObjetivo = repartos.some(r => r.destino === 'bidon' && !r.objetivo_id);
  return { repartos, faltanObjetivo };
}

/** Inserta la carga + items con la imputación por producto ya resuelta. */
async function guardarCarga(sesion) {
  const { datos, mediaUrl, capataz, itemsComb } = sesion;
  const repartos = sesion.repartos || [];
  const esFactura = datos.tipo_doc === 'factura';
  const proveedorId = await resolverProveedor(datos.proveedor, datos.cuit);
  const litros = itemsComb.reduce((s, i) => s + (i.litros || 0), 0);

  // Resumen de destino de la carga
  const dests = repartos.map(x => x.destino);
  const resumen = dests.length && dests.every(d => d === 'unidad') ? 'unidad'
                : dests.length && dests.every(d => d === 'bidon')  ? 'bidon'
                : dests.length ? 'mixto' : 'unidad';

  const unidadCargaId = resumen === 'unidad' && sesion.unidad ? sesion.unidad.id : null;
  const impObj = repartos.find(x => x.objetivo_id);
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
      respuesta_capataz: sesion.textoLibre || null,
    })
    .select('id').single();

  if (error || !carga) {
    console.error('Error insertando carga:', error);
    return null;
  }

  // Una fila por reparto. Los productos que no son combustible (o sin reparto)
  // van en una fila única como siempre.
  const items = [];
  let ci = -1;
  (datos.items || []).forEach(it => {
    const esFuel = it.es_combustible !== false;
    if (esFuel) ci++;
    const reps = esFuel ? repartos.filter(r => r.item_idx === ci) : [];
    if (!reps.length) {
      items.push({
        carga_id: carga.id, producto: it.producto,
        es_combustible: it.es_combustible !== false,
        litros: it.litros ?? null, precio_unit: it.precio_unit ?? null,
        subtotal: it.subtotal ?? null,
        destino: 'unidad', unidad_id: sesion.unidad ? sesion.unidad.id : null,
        objetivo_id: null,
      });
      return;
    }
    reps.forEach(r => items.push({
      carga_id: carga.id, producto: it.producto,
      es_combustible: it.es_combustible !== false,
      litros: r.litros, precio_unit: it.precio_unit ?? null,
      subtotal: reps.length === 1 ? (it.subtotal ?? null) : null,
      destino: r.destino,
      unidad_id: r.unidad_id, equipo_id: r.equipo_id, objetivo_id: r.objetivo_id,
      destino_detalle: r.destino === 'bidon' ? (r.objetivo_nombre || null)
                     : (r.equipo_nombre || r.detalle || null),
    }));
  });
  await supabase.from('cargas_combustible_items').insert(items);
  return carga;
}

/** Arma el resumen final que se le manda al capataz. */
function resumenFinal(sesion, nombre) {
  const lineas = sesion.repartos.length
    ? resumenRepartos(sesion)
    : '  • registrada sin reparto';
  return `✅ Carga registrada, *${nombre}*:\n${lineas}`;
}

// ── Entrada 1: llega la FOTO ──────────────────────────────────

// Fecha de la carga saneada: si el OCR no leyó fecha, o leyó una futura o de
// hace más de 90 días (tickets viejos / lecturas 2024), va la de hoy.
function fechaCargaValida(f) {
  const hoy = new Date();
  try {
    const d = new Date(String(f || ''));
    if (!isNaN(d)) {
      const dif = (hoy - d) / 86400000;
      if (dif >= -1 && dif <= 90) return String(f).slice(0, 10);
    }
  } catch (e) {}
  return hoy.toISOString().slice(0, 10);
}

// Una foto a la vez por teléfono: si el capataz manda dos seguidas (pasa),
// la segunda no pisa la sesión de la primera a mitad de lectura.
const _fotoEnProceso = new Set();

async function procesarComprobante(telefono, mediaUrl, mediaType) {
  if (_fotoEnProceso.has(telefono)) {
    return '📸 Estoy leyendo la foto anterior — esperá mi respuesta antes de mandar otra.';
  }
  _fotoEnProceso.add(telefono);
  try {
    return await _procesarComprobante(telefono, mediaUrl, mediaType);
  } finally {
    _fotoEnProceso.delete(telefono);
  }
}

async function _procesarComprobante(telefono, mediaUrl, mediaType) {
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

  // Foto ilegible: si no se pudo leer ni el proveedor/número ni ningún litro,
  // no hay nada que cargar — se pide otra foto en vez de seguir con nulls
  // (caso real 10-ago: extracción toda null → insert rechazado por fecha null).
  const algoLegible = datos && (datos.proveedor || datos.numero)
    && (datos.items || []).some(i => Number(i.litros) > 0);
  if (!algoLegible) {
    return `⚠️ No pude leer el comprobante, *${nombre}*. Sacale la foto de nuevo: ` +
           `más de cerca, derecha y con buena luz (que se vean proveedor, número y litros).`;
  }
  // Fecha ausente o disparatada (OCR leyó 2024, o nada): se usa la de hoy.
  datos.fecha = fechaCargaValida(datos.fecha);

  const resUni = await resolverUnidadAprox(datos.patente);
  const unidad = resUni ? resUni.unidad : null;
  let notaPatente = '';
  if (resUni && resUni.corregida) {
    // La lectura del ticket no existe en la flota, pero hay una única patente
    // real muy parecida: se usa esa y se avisa.
    notaPatente = `🅿️ Patente: leí "${datos.patente}", la tomo como *${unidad.patente}* (es la de tu flota).\n`;
    datos.patente = unidad.patente;
  }
  const itemsComb = (datos.items || []).filter(i => i.es_combustible !== false);

  const lineaDoc = datos.tipo_doc === 'factura'
    ? `📄 Factura ${datos.numero} — ${pesos(datos.total)}`
    : `📄 Remito ${datos.numero} — sin facturar`;
  const encabezado = `📸 Leí tu comprobante, *${nombre}*:\n\n⛽ ${datos.proveedor}\n${lineaDoc}\n${resumenProductos(datos)}\n${notaPatente}\n`;

  // ¿Ya está cargado? (reenvío de la misma foto o dos fotos del mismo remito)
  const litrosTot = itemsComb.reduce((s, i) => s + (Number(i.litros) || 0), 0) || Number(datos.litros) || null;
  const dup = await buscarDuplicado(datos, capataz.id, litrosTot);
  if (dup) {
    sesiones[tel] = {
      paso: 'confirmar_dup', datos, mediaUrl, capataz, unidad,
      itemsComb, indice: 0, repartos: [],
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
    const sesion = { datos, mediaUrl, capataz, unidad, itemsComb: [], repartos: [] };
    const carga = await guardarCarga(sesion);
    if (!carga) return '⚠️ No pude guardar la carga. Avisá a administración.';
    return `${encabezado}✅ Registrada.`;
  }

  sesiones[tel] = {
    paso: 'destino_libre', datos, mediaUrl, capataz, unidad,
    itemsComb, indice: 0, repartos: [],
  };
  return encabezado + preguntarLitros(sesiones[tel]);
}

// ── Entrada 2: llega TEXTO con sesión activa ──────────────────

async function tieneSesionActiva(telefono) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');
  if (sesiones[tel]) return true;
  const rec = await ses.restaurar('combustible', tel);
  if (!rec) return false;
  // Hidratar: itemsComb debe volver a apuntar a los objetos de datos.items
  // (la serialización rompe la identidad de referencias).
  rec.itemsComb = (rec.datos && rec.datos.items || []).filter(i => i.es_combustible !== false);
  sesiones[tel] = rec;
  return true;
}

async function continuarConversacion(telefono, mensaje) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');
  const sesion = sesiones[tel];
  if (!sesion) return null;

  const texto = (mensaje || '').trim();
  const nombre = sesion.capataz.nombre.split(' ')[0];

  // Confirmación de posible doble carga
  if (sesion.paso === 'confirmar_dup') {
    if (texto === '1') {
      if (sesion.itemsComb.length === 0) {
        const carga = await guardarCarga(sesion);
        delete sesiones[tel];
        if (!carga) return '⚠️ No pude guardar la carga. Avisá a administración.';
        return `✅ Registrada, *${nombre}*.`;
      }
      return preguntarLitros(sesion);
    }
    if (texto === '2') {
      delete sesiones[tel];
      return `👍 Listo, *${nombre}*, la descarté. No se registró nada.`;
    }
    return `Respondé *1* (es una carga nueva) o *2* (es la misma, descartar).`;
  }

  // El capataz responde los litros que la IA no pudo leer
  if (sesion.paso === 'litros_item') {
    const it = sesion.itemsComb[sesion.indice];
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
    return preguntarLitros(sesion);   // siguiente faltante, o el destino
  }

  // Destino en texto libre (o atajos 1/2). También se usa para corregir
  // desde la confirmación: escribir de nuevo pisa la interpretación anterior.
  if (sesion.paso === 'destino_libre' || sesion.paso === 'confirmar_libre') {

    // Confirmación
    if (sesion.paso === 'confirmar_libre' && texto === '1') {
      const carga = await guardarCarga(sesion);
      const resumen = resumenFinal(sesion, nombre);
      delete sesiones[tel];
      if (!carga) return '⚠️ No pude guardar la carga. Avisá a administración.';
      return resumen;
    }

    // Atajo 1: todo a la unidad → guarda directo, sin vueltas
    if (texto === '1') {
      sesion.textoLibre = 'todo a la unidad';
      sesion.repartos = sesion.itemsComb.map((it, ix) => ({
        item_idx: ix, litros: it.litros, destino: 'unidad',
        unidad_id: sesion.unidad ? sesion.unidad.id : null,
        equipo_id: null, objetivo_id: null, detalle: null,
      }));
      const carga = await guardarCarga(sesion);
      const resumen = resumenFinal(sesion, nombre);
      delete sesiones[tel];
      if (!carga) return '⚠️ No pude guardar la carga. Avisá a administración.';
      return resumen;
    }

    // Atajo 2: todo a bidones → falta el objetivo
    if (texto === '2') {
      sesion.textoLibre = 'todo a bidones';
      sesion.repartos = sesion.itemsComb.map((it, ix) => ({
        item_idx: ix, litros: it.litros, destino: 'bidon',
        unidad_id: null, equipo_id: null, objetivo_id: null, detalle: null,
      }));
      sesion.atajoBidones = true;
      sesion.paso = 'objetivo_bidones';
      const miObj = sesion.capataz.objetivo_nombre || 'tu objetivo';
      return `¿A qué objetivo van los bidones?\n\nRespondé *mío* para ${miObj}, o escribí el nombre de otro objetivo.`;
    }

    // Texto libre → lo interpreta la IA
    let parseo;
    try {
      parseo = await parsearDestinoCombustible({
        texto,
        items: sesion.itemsComb.map((it, i) => ({ i, producto: it.producto, litros: it.litros })),
        patente: sesion.datos.patente,
        objetivo_capataz: sesion.capataz.objetivo_nombre,
      });
    } catch (err) {
      console.error('parsearDestinoCombustible:', err);
      return `⚠️ No pude interpretar el mensaje recién. Probá de nuevo en un momento, o respondé *1* (todo a la unidad) o *2* (todo a bidones).`;
    }
    const res = await construirRepartos(parseo, sesion);
    if (res.error) {
      sesion.paso = 'destino_libre';
      return `🤔 ${res.error}`;
    }
    sesion.textoLibre = texto;
    sesion.repartos = res.repartos;
    if (res.faltanObjetivo) {
      sesion.atajoBidones = false;
      sesion.paso = 'objetivo_bidones';
      const miObj = sesion.capataz.objetivo_nombre || 'tu objetivo';
      return `¿A qué objetivo van los bidones?\n\nRespondé *mío* para ${miObj}, o escribí el nombre de otro objetivo.`;
    }
    sesion.paso = 'confirmar_libre';
    return `Entendí:\n${resumenRepartos(sesion)}\n\n¿Confirmás? *1* sí · o escribí de nuevo cómo se reparte`;
  }

  // Objetivo para los bidones que quedaron sin objetivo
  if (sesion.paso === 'objetivo_bidones') {
    const obj = await resolverObjetivo(texto, sesion.capataz);
    if (!obj || !obj.id) {
      return `No encontré ese objetivo. Escribí el nombre de nuevo, o *mío* para tu objetivo.`;
    }
    sesion.repartos.forEach(r => {
      if (r.destino === 'bidon' && !r.objetivo_id) {
        r.objetivo_id = obj.id; r.objetivo_nombre = obj.nombre;
      }
    });
    if (sesion.atajoBidones) {
      // Con el atajo no hay nada más que confirmar: se guarda directo.
      const carga = await guardarCarga(sesion);
      const resumen = resumenFinal(sesion, nombre);
      delete sesiones[tel];
      if (!carga) return '⚠️ No pude guardar la carga. Avisá a administración.';
      return resumen;
    }
    sesion.paso = 'confirmar_libre';
    return `Entendí:\n${resumenRepartos(sesion)}\n\n¿Confirmás? *1* sí · o escribí de nuevo cómo se reparte`;
  }

  return null;
}

module.exports = {
  procesarComprobante: ses.conPersistencia('combustible', sesiones, procesarComprobante),
  continuarConversacion: ses.conPersistencia('combustible', sesiones, continuarConversacion),
  tieneSesionActiva,
  // exportados para tests.js
  distanciaEdicion, normalizarPatente, numNorm,
};
