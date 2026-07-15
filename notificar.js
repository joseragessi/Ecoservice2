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
async function notificarCapatazTemplate(telefono, contentSid, variables) {
  if (!telefono || !contentSid) return false;
  const limpio = String(telefono).replace(/\D/g, '');
  if (!limpio) return false;
  try {
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to:   'whatsapp:+' + limpio,
      contentSid,
      ...(variables ? { contentVariables: JSON.stringify(variables) } : {}),
    });
    console.log(`[NOTIF] template ${contentSid} enviada a ${limpio}`);
    return true;
  } catch (e) {
    console.error(`[NOTIF] no se pudo enviar template a ${limpio}: ${e.code || ''} ${e.message}`);
    return false;
  }
}

module.exports = { notificarCapataz, notificarCapatazTemplate };
