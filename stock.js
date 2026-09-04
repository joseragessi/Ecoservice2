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
    // Los números que están en el taller (con ingreso dado) van marcados:
    // el capataz tiene que saber que esa máquina NO está en su objetivo y
    // que no es un faltante, está en reparación.
    const enT = new Set((i.numeros_taller || []).map(String));
    const nums = i.numeros && i.numeros.length
      ? ` — N° ${i.numeros.map(n => enT.has(String(n)) ? `${n} 🔧` : n).join(', ')}` : '';
    const sinNumT = (i.en_taller_sin_numero || 0) > 0 ? ` _(${i.en_taller_sin_numero} en el taller)_` : '';
    const obs  = i.observacion ? ` _(${i.observacion})_` : '';
    return `  • ${i.tipo} ×${i.cantidad}${nums}${sinNumT}${obs}`;
  }).join('\n');
}

// Cuántas máquinas del listado están en el taller, para el pie del mensaje.
function contarTaller(items) {
  return (items || []).reduce((s, i) => s + (i.numeros_taller || []).length + (i.en_taller_sin_numero || 0), 0);
}

// ── Lo que está en el taller, por objetivo ────────────────────
// Incidencias abiertas CON INGRESO DADO (fecha_ingreso_taller). Se cruza por
// número de máquina; si no hay número, por familia de equipo (misma lógica
// que Stock → General en el panel). Devuelve los items con numeros_taller y
// en_taller_sin_numero completados.
async function marcarTaller(objetivoId, items) {
  try {
    const { data: incs } = await supabase.from('incidencias')
      .select('id, numero_unidad, tipo_equipo')
      .eq('objetivo_id', objetivoId).neq('estado', 'finalizado').not('fecha_ingreso_taller', 'is', null);
    if (!incs || !incs.length) return items;
    const normN = v => String(v == null ? '' : v).trim().toUpperCase().replace(/[\s.\-_/]/g, '');
    const normT = v => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
    const usadas = new Set();
    const out = (items || []).map(i => ({ ...i, numeros_taller: [], en_taller_sin_numero: 0 }));
    // Por número, una sola vez por máquina.
    out.forEach(it => {
      const nums = new Set((it.numeros || []).map(normN));
      const vistos = new Set();
      incs.forEach(inc => {
        const n = normN(inc.numero_unidad);
        if (!n || usadas.has(inc.id) || !nums.has(n) || vistos.has(n)) return;
        usadas.add(inc.id); vistos.add(n);
        it.numeros_taller.push((it.numeros || []).find(x => normN(x) === n));
      });
    });
    // Sin número: por tipo, si el nombre del equipo cabe en el tipo censado.
    incs.forEach(inc => {
      if (usadas.has(inc.id)) return;
      const t = normT(inc.tipo_equipo);
      if (!t) return;
      const it = out.find(x => { const tt = normT(x.tipo); return tt && (tt.includes(t) || t.includes(tt)) && x.en_taller_sin_numero + x.numeros_taller.length < (Number(x.cantidad) || 0); });
      if (it) { usadas.add(inc.id); it.en_taller_sin_numero++; }
    });
    return out;
  } catch (e) {
    console.error('[stock] no pude cruzar con el taller:', e.message || e);
    return items;
  }
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
    const items = await marcarTaller(objetivoId, censo.censos_stock_items.map(i => ({
      tipo: i.tipo_equipo, cantidad: i.cantidad,
      numeros: i.numeros || [], observacion: i.observacion || null,
    })));
    return { periodo: censo.periodo, mismo_mes: censo.periodo === periodoActualStr, items };
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
        periodoPrevio: previo.periodo,
      };
      const total = previo.items.reduce((a, i) => a + (Number(i.cantidad) || 0), 0);
      const nTaller = contarTaller(previo.items);
      const cuando = previo.mismo_mes
        ? 'Esto es lo que ya cargaste este mes'
        : `Esto es lo último que informaste (${mesLegible(previo.periodo)})`;
      return `Dale *${nombre}*. ${cuando} en *${capataz.objetivo_nombre || 'tu objetivo'}*:\n\n` +
             `${listado(previo.items)}\n\n*Total: ${total} equipo${total === 1 ? '' : 's'}*` +
             (nTaller ? `\n🔧 ${nTaller} en el taller: no ${nTaller === 1 ? 'la' : 'las'} cuentes como faltante.` : '') +
             `\n\n¿Está bien? Respondé *sí* para confirmarlo.\n` +
             `Si algo cambió, decímelo en criollo:\n` +
             `_agregá 2 motosierras la 12 y la 15_\n` +
             `_la 21 no está_ (queda registrada como faltante)`;
    }
    sesiones[tel] = { paso: 'esperando_listado', capataz };
    return `Dale *${nombre}*, mandame el listado de maquinaria de tu objetivo ` +
           `con cantidades y números de máquina, por ejemplo:\n\n` +
           `_3 motoguadañas N° 12, 15 y 21, 1 tractor N° 4, 2 hidrolavadoras_`;
  }

  return await procesarListadoTexto(tel, capataz, resto.trim());
}

/**
 * El capataz informa LO QUE TIENE. Si informa menos que la vez anterior,
 * no se bloquea ni se repone en silencio: se registra como POSIBLE
 * FALTANTE y se avisa a administración. Con máquinas que se pierden de
 * verdad (10 motoguadañas, ~$10M), tapar la diferencia era esconder el
 * problema — lo que hace falta es verla en el momento.
 *
 * Compara lo nuevo contra lo anterior y devuelve la lista de faltantes:
 * números que estaban y ya no, y bajas de cantidad por tipo.
 */
// ¿Es un listado completo o un ajuste chico? Cinco o más renglones con
// cantidad, o más de 250 caracteres, es alguien mandando todo de nuevo.
function esListadoCompleto(texto) {
  const t = String(texto || '');
  const renglones = t.split(/\n/).filter(l => /\d/.test(l) && l.trim().length > 3).length;
  return renglones >= 5 || t.length > 250;
}

function detectarFaltantes(previos, nuevos) {
  const clave = i => String(i.tipo || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const normN = n => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const acum = lista => {
    const m = {};
    (lista || []).forEach(i => {
      const k = clave(i);
      if (!m[k]) m[k] = { tipo: i.tipo, cantidad: 0, numeros: [] };
      m[k].cantidad += Number(i.cantidad) || 0;
      (i.numeros || []).forEach(n => { const s = String(n); if (!m[k].numeros.includes(s)) m[k].numeros.push(s); });
    });
    return m;
  };
  const antes = acum(previos), despues = acum(nuevos);
  const faltantes = [];
  for (const [k, v] of Object.entries(antes)) {
    const d = despues[k];
    if (!d) {
      // Todo el tipo desapareció: cada número que estaba es un faltante
      if (v.numeros.length) v.numeros.forEach(n => faltantes.push({ tipo: v.tipo, numero: n, detalle: null }));
      else faltantes.push({ tipo: v.tipo, numero: null, detalle: `${v.cantidad} → 0` });
      continue;
    }
    const numsDesp = d.numeros.map(normN);
    v.numeros.forEach(n => {
      if (normN(n) !== 'sn' && !numsDesp.includes(normN(n))) faltantes.push({ tipo: v.tipo, numero: n, detalle: null });
    });
    // Baja de cantidad no explicada por números (equipos sin numerar)
    const sinNumAntes = v.cantidad - v.numeros.length;
    const sinNumDesp = d.cantidad - d.numeros.length;
    if (d.cantidad < v.cantidad && sinNumDesp < sinNumAntes) {
      const yaPorNumeros = faltantes.filter(f => f.tipo === v.tipo && f.numero).length;
      const resto = (v.cantidad - d.cantidad) - yaPorNumeros;
      if (resto > 0) faltantes.push({ tipo: v.tipo, numero: null, detalle: `${v.cantidad} → ${d.cantidad}` });
    }
  }
  return faltantes;
}

/** Guarda los faltantes y avisa a administración. Best-effort: si algo
 *  falla, el censo igual se guarda — el aviso no puede frenar la carga. */
async function registrarFaltantes(sesion, censoId, faltantes) {
  if (!faltantes.length) return;
  const obj = sesion.capataz.objetivo_nombre || 'sin objetivo';
  try {
    await supabase.from('stock_faltantes').insert(faltantes.map(f => ({
      objetivo_id: sesion.capataz.objetivo_id || null,
      censo_id: censoId || null,
      tipo_equipo: f.tipo, numero: f.numero, detalle: f.detalle,
      visto_en: sesion.periodoPrevio || null,
    })));
  } catch (e) { console.error('[stock] no pude guardar faltantes:', e.message); }
  console.log(`[stock] ⚠ FALTANTES en ${obj} (${sesion.capataz.nombre}): ` +
    faltantes.map(f => f.numero ? `${f.tipo} N° ${f.numero}` : `${f.tipo} ${f.detalle}`).join(' · '));
  // Aviso por WhatsApp a administración (env STOCK_ADMIN_TEL). Sujeto a la
  // ventana de 24 hs de WhatsApp: si José no le escribió al bot ese día,
  // puede no entregarse — el registro en la tabla queda igual.
  const admin = process.env.STOCK_ADMIN_TEL;
  if (admin) {
    try {
      const { notificarCapataz } = require('./notificar');
      await notificarCapataz(admin,
        `🔔 *Posible faltante de stock*\n\n📍 ${obj} · ${sesion.capataz.nombre}\nEl censo de hoy no incluye:\n` +
        faltantes.map(f => f.numero ? `  • ${f.tipo} *N° ${f.numero}*` : `  • ${f.tipo} (${f.detalle})`).join('\n') +
        (sesion.periodoPrevio ? `\n_(estaban en el censo de ${mesLegible(sesion.periodoPrevio)})_` : '') +
        `\n\nRevisá si se trasladó, está en el taller o falta de verdad. Detalle en el panel → Stock → General.`);
    } catch (e) { console.error('[stock] no pude avisar el faltante:', e.message); }
  }
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
      if (censo && sesion.faltantesPend && sesion.faltantesPend.length) {
        await registrarFaltantes(sesion, censo.id, sesion.faltantesPend);
      }
      delete sesiones[tel];
      if (!censo) return '⚠️ No pude guardar el stock. Avisá a administración.';
      return `✅ Stock registrado, *${nombre}*. Gracias.` +
             (veniaDePrevio ? ' (confirmaste el listado anterior)' : '') +
             `\n\n${resumenCenso(sesion)}`;
    }

    // Un mensaje LARGO con varios equipos no es un ajuste: es el listado
    // completo de nuevo (el caso de UCC: 30 líneas). Pedirle a la IA que
    // "corrija" lo previo con 30 líneas es pedirle que adivine; mejor tomarlo
    // como listado nuevo y comparar contra lo anterior para los faltantes.
    if (esListadoCompleto(texto)) {
      const previos = sesion.items;
      const r = await procesarListadoTexto(tel, sesion.capataz, texto);
      const nueva = sesiones[tel];
      if (nueva && nueva.items && previos) {
        nueva.faltantesPend = detectarFaltantes(previos, nueva.items);
        if (nueva.faltantesPend.length) {
          const lista = nueva.faltantesPend.map(f => f.numero ? `${f.tipo} *N° ${f.numero}*` : `${f.tipo} (${f.detalle})`).join(', ');
          return `${r}\n\n⚠️ Respecto de la vez pasada falta: ${lista}. Queda registrado como faltante.`;
        }
      }
      return r;
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
    // Si informa menos que antes NO se bloquea: se marca el faltante para
    // registrarlo al confirmar, y se le dice en el momento qué falta.
    const faltantes = detectarFaltantes(sesion.items, actualizado.items);
    sesion.items = actualizado.items;
    sesion.faltantesPend = faltantes;

    if (faltantes.length) {
      const lista = faltantes.map(f => f.numero ? `${f.tipo} *N° ${f.numero}*` : `${f.tipo} (${f.detalle})`).join(', ');
      return `Actualicé el listado.\n\n⚠️ Respecto de la vez pasada falta: ${lista}. ` +
             `Queda registrado como faltante y le aviso a administración.\n\n${pedirConfirmacion(sesion)}`;
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
  // Para el harness: lógica pura, sin sesión.
  _listado: listado, _contarTaller: contarTaller, _esListadoCompleto: esListadoCompleto, _detectarFaltantes: detectarFaltantes,
};
