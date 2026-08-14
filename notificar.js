const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

/**
 * Manda un WhatsApp al capataz desde el número de capataces.
 * "Best effort": si la ventana de 24hs de WhatsApp está cerrada, Twilio
 * puede rechazarlo (haría falta una plantilla aprobada). En ese caso
 * logueamos el error y devolvemos false, pero NO rompemos la operación.
 *
 * @param {string} telefono - teléfono del capataz (como está en la DB, ej "5493512665495")
 * @param {string} texto    - cuerpo del mensaje
 * @returns {Promise<boolean>} true si Twilio aceptó el envío
 */
async function notificarCapataz(telefono, texto) {
  if (!telefono) return false;
  const limpio = String(telefono).replace(/\D/g, '');
  if (!limpio) return false;
  try {
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to:   'whatsapp:+' + limpio,
      body: texto,
    });
    console.log(`[NOTIF] enviada a ${limpio}`);
    return true;
  } catch (e) {
    // 63016 = fuera de la ventana de 24hs sin plantilla. No es un error fatal.
    console.error(`[NOTIF] no se pudo enviar a ${limpio}: ${e.code || ''} ${e.message}`);
    return false;
  }
}

/**
 * Igual que notificarCapataz, pero para el PRIMER contacto de una conversación
 * (ej. el pedido mensual de stock): como el capataz no le escribió nada al bot
 * en las últimas 24hs, WhatsApp/Meta rechaza el texto libre (error 63016) y
 * ese rechazo llega ASÍNCRONO — el create() ya devolvió éxito antes de saberlo.
 * Por eso acá no hay fallback posible: se manda directo con el Content Template
 * aprobado por Meta (contentSid), que si es genérico no necesita variables.
 *
 * @param {string} telefono   - teléfono del capataz
 * @param {string} contentSid - SID del template aprobado (ej. "HXc8e60d...")
 * @param {object} [variables] - variables del template, si las tiene (ej. {'1':'Juan'})
 * @returns {Promise<boolean>}
 */
/**
 * Manda un mensaje usando un template de WhatsApp aprobado por Meta (contentSid).
 * Detecta solo si el template declara variables ({{1}}, {{2}}...) consultando la
 * Content API de Twilio, y en ese caso manda valores (los defaults del template,
 * o "-" si no hay default). Evita el error 21656 "Content Variables invalid"
 * cuando el template tiene variables y no se proveen.
 * @param {string} telefono   - número del capataz (con o sin whatsapp:)
 * @param {string} contentSid - SID del template aprobado (ej. "HXc8e60d...")
 * @param {object} [variables] - opcional: {"1":"valor",...} para pisar los defaults
 */
const _cacheTemplates = {};   // contentSid -> {variables:{...}} (definición)

async function definicionTemplate(contentSid) {
  if (_cacheTemplates[contentSid]) return _cacheTemplates[contentSid];
  try {
    const sid  = process.env.TWILIO_ACCOUNT_SID;
    const tok  = process.env.TWILIO_AUTH_TOKEN;
    const resp = await fetch(`https://content.twilio.com/v1/Content/${contentSid}`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') },
    });
    if (!resp.ok) throw new Error(`Content API ${resp.status}`);
    const j = await resp.json();
    _cacheTemplates[contentSid] = { variables: j.variables || {} };
  } catch (e) {
    console.error(`[NOTIF] no pude leer definición del template ${contentSid}:`, e.message);
    _cacheTemplates[contentSid] = { variables: {} };   // asumir sin variables
  }
  return _cacheTemplates[contentSid];
}

async function notificarCapatazTemplate(telefono, contentSid, variables) {
  if (!telefono || !contentSid) return false;
  const limpio = String(telefono).replace(/\D/g, '');
  if (!limpio) return false;
  try {
    // ¿El template declara variables? Si sí, hay que mandarlas sí o sí.
    const def = await definicionTemplate(contentSid);
    const claves = Object.keys(def.variables || {});
    let contentVariables;
    if (claves.length) {
      const vals = {};
      for (const k of claves) vals[k] = (variables && variables[k]) || def.variables[k] || '-';
      contentVariables = JSON.stringify(vals);
    } else if (variables && Object.keys(variables).length) {
      contentVariables = JSON.stringify(variables);
    }
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to:   'whatsapp:+' + limpio,
      contentSid,
      ...(contentVariables ? { contentVariables } : {}),
    });
    console.log(`[NOTIF] template ${contentSid} enviada a ${limpio}`);
    return true;
  } catch (e) {
    console.error(`[NOTIF] no se pudo enviar template a ${limpio}: ${e.code || ''} ${e.message}`);
    return false;
  }
}

// ── Mensajes de avance de estado para el capataz ─────────────
// Cada estado tiene su mensaje propio; si el mecánico dejó un comentario,
// se incluye textual para que el capataz sepa el detalle real.
// `comentario` acepta un texto o una LISTA de observaciones. Al finalizar se
// mandan todas las que dejó el taller, no solo la última: es lo que el capataz
// necesita para saber qué se le hizo al equipo.
function mensajeEstadoIncidencia(estado, { equipo, unidad, mecanico, comentario }) {
  const cab = `🔧 Equipo: ${equipo || '—'}\n` +
              (unidad ? `🔢 Unidad: ${unidad}\n` : '') +
              (mecanico ? `👨‍🔧 Mecánico: ${mecanico}\n` : '');
  const lista = Array.isArray(comentario) ? comentario.filter(Boolean) : (comentario ? [comentario] : []);
  const nota = !lista.length ? ''
    : lista.length === 1
      ? `\n💬 Nota del mecánico:\n_"${lista[0]}"_\n`
      : `\n💬 Lo que hizo el taller:\n${lista.map(t => `• _${t}_`).join('\n')}\n`;
  const pie = `\n_EcoService · Taller_`;
  switch (estado) {
    case 'diagnostico':
      return `🔍 *Tu reporte está en diagnóstico*\n\n${cab}` +
             `\nEl mecánico está revisando el equipo para determinar la falla.${nota}${pie}`;
    case 'esperando_repuestos':
      return `⏳ *Esperando repuestos*\n\n${cab}` +
             `\nSe identificó la falla y hacen falta repuestos. La reparación sigue apenas lleguen.${nota}${pie}`;
    case 'en_reparacion':
      return `🛠 *En reparación*\n\n${cab}` +
             `\nYa se está trabajando en el equipo.${nota}${pie}`;
    case 'finalizado':
      return `✅ *Reparación finalizada*\n\n${cab}` +
             `\nTu incidencia fue resuelta. El equipo está listo para retirar/usar.${nota}${pie}`;
    default:
      return null;
  }
}

module.exports = { notificarCapataz, notificarCapatazTemplate, mensajeEstadoIncidencia };
