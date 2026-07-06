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

module.exports = { notificarCapataz };
