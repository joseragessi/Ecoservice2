// ── Recordatorio automático de stock ────────────────────────────────────────
// La empresa tiene dos realidades y no se controlan igual:
//
//   PRIVADO   → la máquina vive en el objetivo (countries, clientes fijos).
//   DEPÓSITO  → la máquina sale de la empresa cada día y vuelve. Es donde se
//               pierden: se perdieron 10 motoguadañas (~$10.000.000).
//   Desde el 04-sep se pide a los dos TODOS LOS LUNES: el capataz recibe el
//   listado que tiene el sistema (con lo que está en el taller marcado) y
//   solo confirma o dice qué cambió.
//
// El pedido va al capataz de cada objetivo, uno por uno, con la plantilla
// aprobada de Twilio (los mensajes libres no atraviesan la ventana de 24 hs).

const supabase = require('./supabase');

// Decisión 04-sep: se pide TODOS LOS LUNES, a todos los grupos. Antes era
// cada 15 días depósito y cada 30 privado; con el listado precargado (el
// capataz solo confirma o dice qué cambió) el costo de preguntar bajó tanto
// que conviene preguntar seguido. DIAS queda por si se quiere volver atrás.
const DIAS = { deposito: 7, privado: 7 };
const HORA_ENVIO = 8;      // 8 de la mañana, hora de Córdoba
const DIA_ENVIO = 1;       // lunes (0 domingo … 6 sábado)

function ahoraCordoba() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Cordoba' }));
}

function periodoActual() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Cordoba' }).slice(0, 7);
}

/**
 * Devuelve los objetivos de un grupo a los que YA les toca que se les pida
 * el stock: nunca se les pidió, o pasaron los días de su frecuencia.
 */
async function objetivosQueTocan(grupo) {
  const { data, error } = await supabase.from('objetivos')
    .select('id, nombre, stock_ultimo_pedido')
    .eq('activo', true).eq('grupo_stock', grupo);
  if (error) throw error;
  // Se resta medio día para que un pedido del lunes pasado a las 8:03 no
  // deje afuera al de este lunes a las 8:00.
  const dias = DIAS[grupo] || 7;
  const corte = Date.now() - (dias - 0.5) * 86400000;
  return (data || []).filter(o =>
    !o.stock_ultimo_pedido || new Date(o.stock_ultimo_pedido).getTime() <= corte);
}

/**
 * Corre una vez por hora. Solo hace algo a la hora de envío y en días
 * hábiles: mandar un pedido de stock un domingo a la madrugada no sirve.
 * `pedirStock` es la función del panel que arma el censo y manda la
 * plantilla — se pasa por parámetro para no duplicar esa lógica.
 */
async function chequearRecordatoriosStock(pedirStock) {
  try {
    const hoy = ahoraCordoba();
    const dow = hoy.getDay();                 // 0 domingo, 6 sábado
    if (hoy.getHours() !== HORA_ENVIO) return;
    if (dow !== DIA_ENVIO) return;            // solo lunes

    for (const grupo of ['deposito', 'privado']) {
      const objs = await objetivosQueTocan(grupo);
      if (!objs.length) continue;
      console.log(`[stock-auto] ${grupo}: le toca a ${objs.length} objetivo(s) — ${objs.map(o => o.nombre).join(', ')}`);
      const r = await pedirStock({
        periodo: periodoActual(),
        objetivo_ids: objs.map(o => o.id),
      });
      console.log(`[stock-auto] ${grupo}: ${JSON.stringify(r)}`);
    }
  } catch (err) {
    console.error('[stock-auto] error:', err.message || err);
  }
}

module.exports = { chequearRecordatoriosStock, objetivosQueTocan, DIAS, HORA_ENVIO, DIA_ENVIO };
