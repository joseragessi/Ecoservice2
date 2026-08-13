const supabase = require('./supabase');
const { interpretarStock } = require('./stock_ia');
const ses = require('./sesion');

// Sesiones de stock EN MEMORIA.
// telefono -> { paso, capataz, items, textoOriginal }
//   paso: 'esperando_listado' | 'confirmando'
const sesiones = {};

const CONFIRMACIONES = [
  'si', 'sí', 'ok', 'oka', 'okey', 'dale', 'listo', 'confirmo', 'confirmar',
  'perfecto', 'correcto', 'esta bien', 'está bien', 'esta perfecto', 'de una', 'va',
];
const CANCELACIONES = ['cancelar', 'cancela', 'no', 'nada', 'dejalo', 'olvidalo'];

// ── Helpers ───────────────────────────────────────────────────

// Período actual en horario de Córdoba: '2026-07'
function periodoActual() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Cordoba' }).slice(0, 7);
}

async function resolverCapataz(tel) {
  const { data } = await supabase
    .from('capataces')
    .select('id, nombre, objetivo_id, objetivos(nombre)')
    .eq('telefono', tel).eq('activo', true).single();
  if (data) data.objetivo_nombre = data.objetivos ? data.objetivos.nombre : null;
  return data;
}

function listado(items) {
  if (!items || !items.length) return '  (sin equipos todavía)';
  return items.map(i => {
    const nums = i.numeros && i.numeros.length ? ` — N° ${i.numeros.join(', ')}` : '';
    const obs  = i.observacion ? ` _(${i.observacion})_` : '';
    return `  • ${i.tipo} ×${i.cantidad}${nums}${obs}`;
  }).join('\n');
}

function totalEquipos(items) {
  return (items || []).reduce((s, i) => s + (Number(i.cantidad) || 0), 0);
}

function resumenCenso(sesion) {
  const obj = sesion.capataz.objetivo_nombre || 'sin especificar';
  const tot = totalEquipos(sesion.items);
  const tipos = new Set((sesion.items || []).map(i => i.tipo)).size;
  return `📍 Objetivo: ${obj}\n📋 Stock:\n${listado(sesion.items)}\n` +
         `\n*Total: ${tot} equipo${tot === 1 ? '' : 's'} · ${tipos} tipo${tipos === 1 ? '' : 's'}*`;
}

function pedirConfirmacion(sesion) {
  // Los avisos del intérprete (cantidades que no cerraban) se muestran acá:
  // el capataz confirma con el número corregido a la vista, no a ciegas.
  const av = (sesion.avisos && sesion.avisos.length)
    ? `\n\n⚠️ ${sesion.avisos.join('\n⚠️ ')}` : '';
  return `${resumenCenso(sesion)}${av}\n\n` +
         `¿Confirmás? Respondé *sí* para guardar, o decime qué *agregar* o *corregir*.`;
}

// ── Guardado ──────────────────────────────────────────────────

// Busca el censo del período para el objetivo (lo pudo crear el panel al
// pedir stock); si no existe, lo crea como espontáneo. Reemplaza los items.
async function guardarCenso(sesion) {
  const periodo = periodoActual();
  const objetivoId = sesion.capataz.objetivo_id;

  let { data: censo } = await supabase
    .from('censos_stock')
    .select('id')
    .eq('periodo', periodo)
    .eq('objetivo_id', objetivoId)
    .maybeSingle();

  if (censo) {
    const { error } = await supabase
      .from('censos_stock')
      .update({ estado: 'respondido', capataz_id: sesion.capataz.id, respondido_at: new Date().toISOString() })
      .eq('id', censo.id);
    if (error) { console.error('Error actualizando censo:', error); return null; }
    // Si vuelve a mandar el stock en el mismo período, pisa lo anterior.
    await supabase.from('censos_stock_items').delete().eq('censo_id', censo.id);
  } else {
    const { data: nuevo, error } = await supabase
      .from('censos_stock')
      .insert({
        periodo,
        objetivo_id:   objetivoId,
        capataz_id:    sesion.capataz.id,
        estado:        'respondido',
        origen:        'espontaneo',
        respondido_at: new Date().toISOString(),
      })
      .select('id').single();
    if (error || !nuevo) { console.error('Error creando censo:', error); return null; }
    censo = nuevo;
  }

  if (sesion.items && sesion.items.length) {
    const items = sesion.items.map(i => ({
      censo_id:    censo.id,
      tipo_equipo: i.tipo,
      cantidad:    i.cantidad,
      numeros:     i.numeros || [],
      observacion: i.observacion || null,
    }));
    const { error } = await supabase.from('censos_stock_items').insert(items);
    if (error) { console.error('Error insertando items del censo:', error); return null; }
    console.log(`[stock] censo ${censo.id} · ${sesion.capataz.nombre} · ` +
      `${items.length} tipos, ${totalEquipos(sesion.items)} equipos: ` +
      items.map(i => `${i.tipo_equipo} x${i.cantidad}`).join(' · '));
    await sembrarInventario(objetivoId, sesion.items);
  }
  return censo;
}

/**
 * Semilla del inventario oficial: si el objetivo NO tiene inventario cargado,
 * el primer censo lo crea. Si ya tiene, no se toca — los censos siguientes solo
 * se comparan contra él (el desvío se calcula en el panel).
 */
async function sembrarInventario(objetivoId, items) {
  try {
    const { data: yaHay } = await supabase
      .from('stock_objetivo').select('id').eq('objetivo_id', objetivoId).limit(1);
    if (yaHay && yaHay.length) return;   // ya tiene inventario: no pisar nunca

    const filas = items.map(i => ({
      objetivo_id: objetivoId,
      tipo_equipo: i.tipo,
      cantidad:    i.cantidad,
      numeros:     i.numeros || [],
      observacion: i.observacion || null,
      origen:      'censo',
    }));
    const { error } = await supabase.from('stock_objetivo').insert(filas);
    if (error) { console.error('[stock] error sembrando inventario:', error); return; }
    console.log(`[stock] inventario sembrado para objetivo ${objetivoId}: ${filas.length} tipos`);
  } catch (err) {
    console.error('[stock] error sembrando inventario:', err.message || err);
  }
}

// ── Entrada: el capataz arranca el envío de stock ─────────────

async function tieneSesionActiva(telefono) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');
  if (sesiones[tel]) return true;
  const rec = await ses.restaurar('stock', tel);
  if (rec) { sesiones[tel] = rec; return true; }
  return false;
}

/**
 * Arranca el flujo de stock. `resto` es lo que el capataz escribió
 * después de la palabra "stock" (puede venir vacío).
 */
async function iniciarStock(telefono, resto) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');

  const capataz = await resolverCapataz(tel);
  if (!capataz) {
    return '❌ Tu número no está registrado en el sistema EcoService. Contactá a administración.';
  }
  if (!capataz.objetivo_id) {
    return '⚠️ Tu número no tiene un objetivo asignado, así que no puedo registrar el stock. Avisá a administración.';
  }
  const nombre = capataz.nombre.split(' ')[0];

  if (!resto || !resto.trim()) {
    sesiones[tel] = { paso: 'esperando_listado', capataz };
    return `Dale *${nombre}*, mandame el listado de maquinaria de tu objetivo ` +
           `con cantidades y números de máquina, por ejemplo:\n\n` +
           `_3 motoguadañas N° 12, 15 y 21, 1 tractor N° 4, 2 hidrolavadoras_`;
  }

  return await procesarListadoTexto(tel, capataz, resto.trim());
}

/** Interpreta el listado y pasa a confirmación. */
async function procesarListadoTexto(tel, capataz, texto) {
  let interpretado;
  try {
    interpretado = await interpretarStock(texto, null);
  } catch (err) {
    console.error('Error interpretando stock:', err);
    return '⚠️ No pude interpretar el listado. ¿Podés escribirlo de nuevo?';
  }

  if (!interpretado.items.length) {
    return '⚠️ No encontré equipos en el mensaje.\n\n' +
           'Si querés informar el stock, escribí el listado, por ejemplo: _3 motoguadañas N° 12, 15 y 21, 1 tractor N° 4_\n\n' +
           'Si necesitabas otra cosa, escribí *menu*.';
  }

  sesiones[tel] = {
    paso: 'confirmando',
    capataz,
    items: interpretado.items,
    avisos: interpretado.avisos || [],
    textoOriginal: texto,
  };

  const nombre = capataz.nombre.split(' ')[0];
  return `Entendí esto, *${nombre}*:\n\n${pedirConfirmacion(sesiones[tel])}`;
}

// ── Continuación de la conversación ───────────────────────────

async function continuarStock(telefono, mensaje) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');
  const sesion = sesiones[tel];
  if (!sesion) return null;

  const texto = (mensaje || '').trim();
  const t = texto.toLowerCase();
  const nombre = sesion.capataz.nombre.split(' ')[0];

  if (sesion.paso === 'esperando_listado') {
    return await procesarListadoTexto(tel, sesion.capataz, texto);
  }

  if (sesion.paso === 'confirmando') {
    if (CANCELACIONES.includes(t)) {
      delete sesiones[tel];
      return `Listo *${nombre}*, cancelé el envío. Cuando quieras escribí *stock* de nuevo.`;
    }

    if (CONFIRMACIONES.includes(t)) {
      if (!sesion.items || !sesion.items.length) {
        return `El listado está vacío. Decime qué maquinaria tenés, o *cancelar* para salir.`;
      }
      const censo = await guardarCenso(sesion);
      delete sesiones[tel];
      if (!censo) return '⚠️ No pude guardar el stock. Avisá a administración.';
      return `✅ Stock registrado, *${nombre}*. Gracias.\n\n${resumenCenso(sesion)}`;
    }

    // Cualquier otra cosa -> es un ajuste: reinterpretar con la IA
    let actualizado;
    try {
      actualizado = await interpretarStock(texto, { items: sesion.items });
    } catch (err) {
      console.error('Error ajustando stock:', err);
      return '⚠️ No entendí el cambio. Probá de nuevo, o respondé *sí* para guardar como está.';
    }
    sesion.items = actualizado.items;
    sesion.avisos = actualizado.avisos || [];

    return `Actualicé el listado:\n\n${pedirConfirmacion(sesion)}`;
  }

  return null;
}

/**
 * ¿Este teléfono tiene un pedido de stock PENDIENTE en el período actual?
 * Se consulta en base (no en memoria) así sobrevive a los redeploys: el capataz
 * puede contestar horas o días después de recibir el pedido, sin palabra clave.
 */
async function tienePedidoPendiente(telefono) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');
  try {
    const capataz = await resolverCapataz(tel);
    if (!capataz || !capataz.objetivo_id) return false;
    const { data } = await supabase
      .from('censos_stock')
      .select('id')
      .eq('periodo', periodoActual())
      .eq('objetivo_id', capataz.objetivo_id)
      .eq('estado', 'pendiente')
      .maybeSingle();
    return !!data;
  } catch (err) {
    console.error('[stock] error chequeando pedido pendiente:', err.message || err);
    return false;
  }
}

module.exports = {
  iniciarStock: ses.conPersistencia('stock', sesiones, iniciarStock),
  continuarStock: ses.conPersistencia('stock', sesiones, continuarStock),
  tieneSesionActiva, periodoActual, tienePedidoPendiente,
};
