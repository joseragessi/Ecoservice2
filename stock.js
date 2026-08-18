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
// Salidas del flujo: valen en CUALQUIER paso. Sin esto el capataz quedaba
// encerrado — el bot le decía "escribí menu" y "menu" se interpretaba como
// listado de maquinaria.
const SALIDAS = ['menu', 'menú', 'salir', 'volver', 'atras', 'atrás', 'chau', 'cancelar', 'cancela'];

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

function resumenCenso(sesion) {
  const obj = sesion.capataz.objetivo_nombre || 'sin especificar';
  return `📍 Objetivo: ${obj}\n📋 Stock:\n${listado(sesion.items)}`;
}

function pedirConfirmacion(sesion) {
  return `${resumenCenso(sesion)}\n\n` +
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
 * Trae lo último que se informó en ese objetivo (censo respondido más
 * reciente, de cualquier período). Es la base sobre la que el capataz
 * corrige, en vez de tener que escribir todo de nuevo cada mes.
 */
async function ultimoStockDelObjetivo(objetivoId, periodoActualStr) {
  try {
    const { data, error } = await supabase.from('censos_stock')
      .select('periodo, respondido_at, censos_stock_items(tipo_equipo, cantidad, numeros, observacion)')
      .eq('objetivo_id', objetivoId).eq('estado', 'respondido')
      .order('periodo', { ascending: false }).limit(1);
    if (error) throw error;
    const censo = (data || [])[0];
    if (!censo || !(censo.censos_stock_items || []).length) {
      // Log explícito: sin esto, "no encontró nada" y "el código no está
      // corriendo" se ven igual desde afuera.
      console.log(`[stock] sin censo previo para objetivo ${objetivoId} ` +
        `(censos respondidos: ${(data || []).length})`);
      return null;
    }
    console.log(`[stock] precargando ${censo.censos_stock_items.length} tipos del censo de ${censo.periodo}`);
    return {
      periodo: censo.periodo,
      mismo_mes: censo.periodo === periodoActualStr,
      items: censo.censos_stock_items.map(i => ({
        tipo: i.tipo_equipo, cantidad: i.cantidad,
        numeros: i.numeros || [], observacion: i.observacion || null,
      })),
    };
  } catch (e) {
    console.error('[stock] no pude traer el último censo:', e.message);
    return null;   // sin historial se sigue con el flujo de siempre
  }
}

function mesLegible(periodo) {
  const M = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const [a, m] = String(periodo || '').split('-').map(Number);
  // Si el período no tiene la forma YYYY-MM se devuelve tal cual: mejor que
  // inventar un "enero de NaN".
  if (!a || !m || m < 1 || m > 12) return String(periodo || '');
  return `${M[m - 1]} de ${a}`;
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
    // Si el objetivo ya tiene stock informado, se arranca DESDE AHÍ: el
    // capataz solo dice qué cambió en vez de escribir todo de nuevo.
    const previo = await ultimoStockDelObjetivo(capataz.objetivo_id, periodoActual());
    if (previo) {
      sesiones[tel] = {
        paso: 'confirmando', capataz,
        items: previo.items, avisos: [], desdePrevio: true,
      };
      const total = previo.items.reduce((a, i) => a + (Number(i.cantidad) || 0), 0);
      const cuando = previo.mismo_mes
        ? 'Esto es lo que ya cargaste este mes'
        : `Esto es lo último que informaste (${mesLegible(previo.periodo)})`;
      return `Dale *${nombre}*. ${cuando} en *${capataz.objetivo_nombre || 'tu objetivo'}*:\n\n` +
             `${listado(previo.items)}\n\n*Total: ${total} equipo${total === 1 ? '' : 's'}*\n\n` +
             `¿Está completo? Respondé *sí* para confirmarlo.\n` +
             `Si sumaste equipos, decímelo en criollo:\n` +
             `_agregá 2 motosierras la 12 y la 15_\n\n` +
             `_Si falta alguna máquina no la saques vos: avisá a administración._`;
    }
    sesiones[tel] = { paso: 'esperando_listado', capataz };
    return `Dale *${nombre}*, mandame el listado de maquinaria de tu objetivo ` +
           `con cantidades y números de máquina, por ejemplo:\n\n` +
           `_3 motoguadañas N° 12, 15 y 21, 1 tractor N° 4, 2 hidrolavadoras_`;
  }

  return await procesarListadoTexto(tel, capataz, resto.trim());
}

/**
 * El capataz SOLO PUEDE SUMAR. Una máquina que falta no se borra del
 * listado desde WhatsApp: si se pudiera, una unidad perdida o robada
 * desaparecería del sistema sin que nadie se entere. Las bajas las
 * registra administración desde el panel.
 *
 * Compara lo que devolvió la IA contra lo que ya estaba y repone todo lo
 * que se haya intentado quitar o reducir. Devuelve los items corregidos y
 * la lista de lo que se bloqueó, para avisárselo al capataz.
 */
function soloAgregar(previos, nuevos) {
  const clave = i => String(i.tipo || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const acum = lista => {
    const m = {};
    (lista || []).forEach(i => {
      const k = clave(i);
      if (!m[k]) m[k] = { tipo: i.tipo, cantidad: 0, numeros: [], observacion: i.observacion || null };
      m[k].cantidad += Number(i.cantidad) || 0;
      (i.numeros || []).forEach(n => { if (!m[k].numeros.includes(String(n))) m[k].numeros.push(String(n)); });
    });
    return m;
  };
  const antes = acum(previos), despues = acum(nuevos);
  const bloqueados = [];

  for (const [k, v] of Object.entries(antes)) {
    const d = despues[k];
    if (!d) {                          // se quiso borrar el tipo entero
      bloqueados.push(`${v.tipo} (${v.cantidad})`);
      despues[k] = v;
      continue;
    }
    if (d.cantidad < v.cantidad) {     // se quiso bajar la cantidad
      bloqueados.push(`${v.tipo}: ${v.cantidad} → ${d.cantidad}`);
      d.cantidad = v.cantidad;
    }
    // los números que estaban tienen que seguir estando
    const faltan = v.numeros.filter(n => !d.numeros.includes(n));
    if (faltan.length) {
      bloqueados.push(`${v.tipo} N° ${faltan.join(', ')}`);
      d.numeros = d.numeros.concat(faltan);
    }
    if (!d.observacion && v.observacion) d.observacion = v.observacion;
  }
  return { items: Object.values(despues), bloqueados };
}

/** Interpreta el listado y pasa a confirmación. */
async function procesarListadoTexto(tel, capataz, texto) {
  let interpretado;
  try {
    interpretado = await interpretarStock(texto, null);
  } catch (err) {
    console.error('Error interpretando stock:', err);
    const motivo = String(err && err.message || err).slice(0, 160);
    return `⚠️ No pude interpretar el listado. ¿Podés escribirlo de nuevo?\n\n_[${motivo}]_`;
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

  // Salida en cualquier paso, ANTES de mandar el texto a la IA como si fuera
  // un listado: el bot le dice "escribí menu" y tiene que funcionar.
  if (SALIDAS.includes(t)) {
    delete sesiones[tel];
    console.log(`[stock] ${sesion.capataz.nombre} salió del flujo con "${t}"`);
    return { __derivar: 'menu' };
  }

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
      const veniaDePrevio = sesion.desdePrevio;
      delete sesiones[tel];
      if (!censo) return '⚠️ No pude guardar el stock. Avisá a administración.';
      return `✅ Stock registrado, *${nombre}*. Gracias.` +
             (veniaDePrevio ? ' (confirmaste el listado anterior)' : '') +
             `\n\n${resumenCenso(sesion)}`;
    }

    // Cualquier otra cosa -> es un ajuste: reinterpretar con la IA
    let actualizado;
    try {
      actualizado = await interpretarStock(texto, { items: sesion.items });
    } catch (err) {
      console.error('Error ajustando stock:', err);
      const motivo = String(err && err.message || err).slice(0, 160);
      return `⚠️ No entendí el cambio. Probá de nuevo, o respondé *sí* para guardar como está.\n\n_[${motivo}]_`;
    }
    // El capataz solo suma: lo que haya intentado sacar se repone.
    const { items, bloqueados } = soloAgregar(sesion.items, actualizado.items);
    sesion.items = items;

    if (bloqueados.length) {
      console.log(`[stock] ⚠ ${sesion.capataz.nombre} intentó dar de baja: ${bloqueados.join(' · ')}`);
      return `⚠️ No puedo sacar máquinas del listado, *${nombre}* — eso lo registra administración.\n\n` +
             `Quedó todo como estaba en: _${bloqueados.join(', ')}_.\n` +
             `Si esas máquinas ya no están en el objetivo, avisá a administración para que las den de baja.\n\n` +
             `${pedirConfirmacion(sesion)}`;
    }

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
