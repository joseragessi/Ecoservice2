// Sesiones del bot persistidas en Supabase (tabla sesiones_bot).
//
// Problema que resuelve: las sesiones vivían solo en memoria, y cada deploy
// de Railway cortaba las conversaciones a medias (un capataz a mitad de una
// carga quedaba hablando solo). Ahora cada módulo mantiene su cache en
// memoria como siempre, pero después de cada turno se persiste una foto en
// la base, y si el proceso arranca de cero la sesión se restaura desde ahí.
//
// Claves con guión bajo (_timer, etc.) no se serializan: son runtime puro.

const supabase = require('./supabase');

const TTL_MS = 30 * 60 * 1000;   // una sesión abandonada muere a los 30 min

function limpiarTel(telefono) {
  return String(telefono || '').replace('whatsapp:', '').replace('+', '');
}

/** Trae la sesión guardada (o null si no hay o venció). */
async function restaurar(modulo, telefono) {
  const tel = limpiarTel(telefono);
  try {
    const { data } = await supabase.from('sesiones_bot')
      .select('datos, actualizada')
      .eq('modulo', modulo).eq('telefono', tel).maybeSingle();
    if (!data) return null;
    if (Date.now() - new Date(data.actualizada).getTime() > TTL_MS) {
      supabase.from('sesiones_bot').delete()
        .eq('modulo', modulo).eq('telefono', tel).then(() => {});
      return null;
    }
    return data.datos;
  } catch (e) {
    console.error(`[sesion] restaurar ${modulo}:`, e.message);
    return null;
  }
}

/** Guarda una foto de la sesión. Best-effort: nunca frena la respuesta. */
function persistir(modulo, telefono, datos) {
  const tel = limpiarTel(telefono);
  try {
    const limpio = JSON.parse(JSON.stringify(datos,
      (k, v) => (k && k[0] === '_' && k !== '_capataz') ? undefined : v));
    supabase.from('sesiones_bot')
      .upsert({ modulo, telefono: tel, datos: limpio, actualizada: new Date().toISOString() },
              { onConflict: 'modulo,telefono' })
      .then(({ error }) => { if (error) console.error(`[sesion] persistir ${modulo}:`, error.message); });
  } catch (e) {
    console.error(`[sesion] persistir ${modulo}:`, e.message);
  }
}

/** Borra la sesión guardada (cuando el flujo termina o se descarta). */
function eliminar(modulo, telefono) {
  const tel = limpiarTel(telefono);
  supabase.from('sesiones_bot').delete()
    .eq('modulo', modulo).eq('telefono', tel)
    .then(({ error }) => { if (error) console.error(`[sesion] eliminar ${modulo}:`, error.message); });
}

/**
 * Envuelve un handler de mensaje para que persista solo la sesión al final
 * de cada turno: si sigue existiendo se guarda, si el flujo la borró se
 * elimina de la base también.
 */
function conPersistencia(modulo, sesiones, fn) {
  return async (telefono, ...args) => {
    const tel = limpiarTel(telefono);
    const tenia = !!sesiones[tel];
    const respuesta = await fn(telefono, ...args);
    if (sesiones[tel]) persistir(modulo, tel, sesiones[tel]);
    else if (tenia) eliminar(modulo, tel);
    return respuesta;
  };
}

module.exports = { restaurar, persistir, eliminar, conPersistencia, limpiarTel, TTL_MS };
