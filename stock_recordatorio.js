// ── Recordatorio automático de stock ────────────────────────────────────────
// La empresa tiene dos realidades y no se controlan igual:
//
//   PRIVADO   → la máquina vive en el objetivo (countries, clientes fijos).
//               Se pide el stock 1 vez por mes.
//   DEPÓSITO  → la máquina sale de la empresa cada día y vuelve. Es donde se
//               pierden: se perdieron 10 motoguadañas (~$10.000.000).
//               Se pide cada 15 días.
//
// El pedido va al capataz de cada objetivo, uno por uno, con la plantilla
// aprobada de Twilio (los mensajes libres no atraviesan la ventana de 24 hs).

const supabase = require('./supabase');

const DIAS = { deposito: 15, privado: 30 };
const HORA_ENVIO = 8;      // 8 de la mañana, hora de Córdoba

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
  const dias = DIAS[grupo] || 30;
  const corte = Date.now() - dias * 86400000;
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
    if (dow === 0 || dow === 6) return;

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

module.exports = { chequearRecordatoriosStock, objetivosQueTocan, DIAS, HORA_ENVIO };
