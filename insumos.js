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
async function iniciarInsumos(telefono, resto) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');

  const capataz = await resolverCapataz(tel);
  if (!capataz) {
    return '❌ Tu número no está registrado en el sistema EcoService. Contactá a administración.';
  }
  const nombre = capataz.nombre.split(' ')[0];

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
      return `✅ Pedido registrado, *${nombre}*. Compras lo va a gestionar.\n\n${resumenPedido(sesion)}`;
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
  iniciarInsumos: ses.conPersistencia('insumos', sesiones, iniciarInsumos),
  continuarInsumos: ses.conPersistencia('insumos', sesiones, continuarInsumos),
  tieneSesionActiva,
};
