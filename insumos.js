const supabase = require('./supabase');
const { interpretarInsumos } = require('./insumos_ia');
const ses = require('./sesion');

// Sesiones de insumos EN MEMORIA.
// telefono -> { paso, capataz, objetivo, items, textoOriginal }
//   paso: 'confirmando'
const sesiones = {};

const CONFIRMACIONES = [
  'si', 'sí', 'ok', 'oka', 'okey', 'dale', 'listo', 'confirmo', 'confirmar',
  'perfecto', 'correcto', 'esta bien', 'está bien', 'esta perfecto', 'de una', 'va',
];
const CANCELACIONES = ['cancelar', 'cancela', 'no', 'nada', 'dejalo', 'olvidalo'];

// ── Helpers ───────────────────────────────────────────────────

async function resolverCapataz(tel) {
  const { data } = await supabase
    .from('capataces')
    .select('id, nombre, objetivo_id, objetivos(nombre)')
    .eq('telefono', tel).eq('activo', true).single();
  if (data) data.objetivo_nombre = data.objetivos ? data.objetivos.nombre : null;
  return data;
}

async function resolverObjetivo(texto, capataz) {
  if (!texto) {
    return capataz.objetivo_id
      ? { id: capataz.objetivo_id, nombre: capataz.objetivo_nombre }
      : { id: null, nombre: null };
  }
  const { data: objetivos } = await supabase
    .from('objetivos').select('id, nombre').eq('activo', true);
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const nt = norm(texto);
  const match = (objetivos || []).find(o => {
    const no = norm(o.nombre);
    return no.includes(nt) || nt.includes(no);
  });
  // Si no matchea, devolvemos el texto igual (se guarda en objetivo_texto)
  return match ? { id: match.id, nombre: match.nombre } : { id: null, nombre: texto };
}

function listado(items) {
  if (!items || !items.length) return '  (sin ítems todavía)';
  return items.map(i => `  • ${i.item}${i.cantidad ? ` — ${i.cantidad}` : ''}`).join('\n');
}

function resumenPedido(sesion) {
  const obj = sesion.objetivo && sesion.objetivo.nombre ? sesion.objetivo.nombre : 'sin especificar';
  return `📍 Objetivo: ${obj}\n📦 Pedido:\n${listado(sesion.items)}`;
}

function pedirConfirmacion(sesion) {
  return `${resumenPedido(sesion)}\n\n` +
         `¿Confirmás? Respondé *sí* para guardar, o decime qué *agregar* o *sacar*.`;
}

// ── Guardado ──────────────────────────────────────────────────

async function guardarPedido(sesion) {
  const { data: pedido, error } = await supabase
    .from('pedidos_insumos')
    .insert({
      estado:         'pendiente',
      capataz_id:     sesion.capataz.id,
      objetivo_id:    sesion.objetivo ? sesion.objetivo.id : null,
      objetivo_texto: sesion.objetivo ? sesion.objetivo.nombre : null,
      texto_original: sesion.textoOriginal,
    })
    .select('id').single();

  if (error || !pedido) {
    console.error('Error insertando pedido de insumos:', error);
    return null;
  }

  if (sesion.items && sesion.items.length) {
    const items = sesion.items.map(i => ({
      pedido_id: pedido.id,
      item:      i.item,
      cantidad:  i.cantidad ?? null,
    }));
    await supabase.from('pedidos_insumos_items').insert(items);
  }
  return pedido;
}

// ── Entrada: el capataz arranca un pedido ─────────────────────

async function tieneSesionActiva(telefono) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');
  if (sesiones[tel]) return true;
  const rec = await ses.restaurar('insumos', tel);
  if (rec) { sesiones[tel] = rec; return true; }
  return false;
}

/**
 * Arranca el flujo de insumos. `resto` es lo que el capataz escribió
 * después de la palabra "insumos" (puede venir vacío).
 */
/* ── Ventana de pedidos ──────────────────────────────────────────
   Los pedidos se toman de VIERNES a MIÉRCOLES hasta las 23:00. El
   jueves está cerrado: es el día en que el pañol arma y compra lo
   pedido en la semana. Si no hay corte, los pedidos entran mientras se
   está comprando y nunca se cierra la lista. */
const DIAS_NOMBRE = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const CIERRA_DIA = 3;    // miércoles
const CIERRA_HORA = 23;  // a las 23:00
const REABRE_DIA = 5;    // viernes

function ahoraCba() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Cordoba' }));
}

/** ¿Se puede pedir ahora? Devuelve {abierto, motivo, reabre}. */
function ventanaPedidos(fecha) {
  const f = fecha || ahoraCba();
  const dia = f.getDay(), hora = f.getHours();
  // Jueves entero cerrado
  if (dia === 4) return { abierto: false, motivo: 'jueves', reabre: 'mañana viernes' };
  // Miércoles después de las 23
  if (dia === CIERRA_DIA && hora >= CIERRA_HORA) {
    return { abierto: false, motivo: 'cerro_miercoles', reabre: 'el viernes' };
  }
  return { abierto: true };
}

/** Cuánto falta para que cierre, para avisar cuando está por terminar. */
function horasParaCierre(fecha) {
  const f = fecha || ahoraCba();
  const dia = f.getDay();
  // Días hasta el próximo miércoles (0 si hoy es miércoles)
  let faltan = (CIERRA_DIA - dia + 7) % 7;
  const cierre = new Date(f);
  cierre.setDate(cierre.getDate() + faltan);
  cierre.setHours(CIERRA_HORA, 0, 0, 0);
  return (cierre - f) / 3600000;
}

function mensajeCerrado(nombre, v) {
  const quien = nombre ? ` *${nombre}*` : '';
  return `🚫 Los pedidos de insumos están cerrados${quien}.\n\n` +
    (v.motivo === 'jueves'
      ? `Los jueves no se toman pedidos: es el día en que el pañol prepara y compra lo de la semana.`
      : `La semana cerró el miércoles a las 23:00.`) +
    `\n\n📅 Se piden de *viernes a miércoles hasta las 23:00*.\n` +
    `Volvé a escribir ${v.reabre} y te lo tomo.\n\n` +
    `_Si es urgente, hablá con administración._`;
}

async function iniciarInsumos(telefono, resto) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');

  const capataz = await resolverCapataz(tel);
  if (!capataz) {
    return '❌ Tu número no está registrado en el sistema EcoService. Contactá a administración.';
  }
  const nombre = capataz.nombre.split(' ')[0];

  // Candado de la ventana: se chequea ANTES de pedirle que escriba, para
  // no hacerlo tipear un pedido que después se le va a rechazar.
  const v = ventanaPedidos();
  if (!v.abierto) {
    console.log(`[insumos] pedido rechazado (${v.motivo}) — ${capataz.nombre}`);
    return mensajeCerrado(nombre, v);
  }

  // Si no escribió el pedido junto, lo pedimos
  if (!resto || !resto.trim()) {
    sesiones[tel] = { paso: 'esperando_pedido', capataz };
    return `Dale *${nombre}*, escribime qué necesitás. ` +
           `Poné el objetivo y los materiales como quieras, por ejemplo:\n\n` +
           `_Casonas del Sur: guantes, 10 lts pintura, alambre_`;
  }

  return await procesarPedidoTexto(tel, capataz, resto.trim());
}

/** Interpreta el texto del pedido y pasa a confirmación. */
async function procesarPedidoTexto(tel, capataz, texto) {
  let interpretado;
  try {
    interpretado = await interpretarInsumos(texto, null);
  } catch (err) {
    console.error('Error interpretando insumos:', err);
    return '⚠️ No pude interpretar el pedido. ¿Podés escribirlo de nuevo?';
  }

  const objetivo = await resolverObjetivo(interpretado.objetivo, capataz);

  sesiones[tel] = {
    paso: 'confirmando',
    capataz,
    objetivo,
    items: interpretado.items,
    textoOriginal: texto,
  };

  const nombre = capataz.nombre.split(' ')[0];
  return `Entendí esto, *${nombre}*:\n\n${pedirConfirmacion(sesiones[tel])}`;
}

// ── Continuación de la conversación ───────────────────────────

async function continuarInsumos(telefono, mensaje) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');
  const sesion = sesiones[tel];
  if (!sesion) return null;

  const texto = (mensaje || '').trim();
  const t = texto.toLowerCase();
  const nombre = sesion.capataz.nombre.split(' ')[0];

  // La ventana también se chequea acá: alguien pudo empezar el pedido a
  // las 22:55 del miércoles y confirmar a las 23:05. Sin esto, el corte
  // se esquiva dejando la conversación abierta.
  const v = ventanaPedidos();
  if (!v.abierto) {
    delete sesiones[tel];
    console.log(`[insumos] pedido cortado por la ventana (${v.motivo}) — ${sesion.capataz.nombre}`);
    return mensajeCerrado(nombre, v);
  }

  // Estaba esperando que escriba el pedido
  if (sesion.paso === 'esperando_pedido') {
    return await procesarPedidoTexto(tel, sesion.capataz, texto);
  }

  // Estaba confirmando
  if (sesion.paso === 'confirmando') {
    // Cancelar
    if (CANCELACIONES.includes(t)) {
      delete sesiones[tel];
      return `Listo *${nombre}*, cancelé el pedido. Cuando quieras escribí *insumos* de nuevo.`;
    }

    // Confirmar -> guardar
    if (CONFIRMACIONES.includes(t)) {
      if (!sesion.items || !sesion.items.length) {
        return `El pedido está vacío. Decime qué necesitás, o *cancelar* para salir.`;
      }
      const pedido = await guardarPedido(sesion);
      delete sesiones[tel];
      if (!pedido) return '⚠️ No pude guardar el pedido. Avisá a administración.';
      const faltan = horasParaCierre();
      const aviso = faltan <= 24
        ? `\n\n⏰ _Ojo: los pedidos cierran ${faltan <= 1 ? 'en menos de una hora' : 'hoy a las 23:00'}. Después reabren el viernes._`
        : '';
      return `✅ Pedido registrado, *${nombre}*. Compras lo va a gestionar.\n\n${resumenPedido(sesion)}${aviso}`;
    }

    // Cualquier otra cosa -> es un ajuste: reinterpretar con la IA
    let actualizado;
    try {
      actualizado = await interpretarInsumos(
        texto,
        { objetivo: sesion.objetivo ? sesion.objetivo.nombre : null, items: sesion.items }
      );
    } catch (err) {
      console.error('Error ajustando insumos:', err);
      return '⚠️ No entendí el cambio. Probá de nuevo, o respondé *sí* para guardar como está.';
    }

    // Si cambió el objetivo, re-resolvemos
    if (actualizado.objetivo && (!sesion.objetivo || actualizado.objetivo !== sesion.objetivo.nombre)) {
      sesion.objetivo = await resolverObjetivo(actualizado.objetivo, sesion.capataz);
    }
    sesion.items = actualizado.items;

    return `Actualicé el pedido:\n\n${pedirConfirmacion(sesion)}`;
  }

  return null;
}

module.exports = {
  ventanaPedidos, horasParaCierre, mensajeCerrado,
  iniciarInsumos: ses.conPersistencia('insumos', sesiones, iniciarInsumos),
  continuarInsumos: ses.conPersistencia('insumos', sesiones, continuarInsumos),
  tieneSesionActiva,
};
