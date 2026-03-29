require('dotenv').config();
const express  = require('express');
const twilio   = require('twilio');
const { procesarMensaje } = require('./conversacion');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Webhook de Twilio WhatsApp ────────────────────────────────
app.post('/webhook', async (req, res) => {
  const telefono = req.body.From;
  const mensaje  = req.body.Body || '';

  if (telefono === process.env.TWILIO_WHATSAPP_NUMBER) return res.sendStatus(200);
  if (!mensaje.trim()) return res.sendStatus(200);

  console.log(`[IN] ${telefono}: ${mensaje}`);

  try {
    const respuesta = await procesarMensaje(telefono, mensaje);
    console.log(`[OUT] ${telefono}: ${respuesta.slice(0, 80)}...`);

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to:   telefono,
      body: respuesta,
    });

    res.sendStatus(200);
  } catch (err) {
    console.error('Error en webhook:', err);
    res.sendStatus(500);
  }
});

// ── Notificación de finalizado ────────────────────────────────
app.post('/notificar-finalizado', async (req, res) => {
  const { telefono, equipo, unidad, mecanico } = req.body;

  if (!telefono || !equipo) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  const numero = telefono.startsWith('+') ? telefono : `+${telefono}`;

  const mensaje =
    `✅ *Reparación finalizada*\n\n` +
    `🔧 Equipo: ${equipo}\n` +
    `${unidad ? `🔢 Unidad: ${unidad}\n` : ''}` +
    `👨‍🔧 Mecánico: ${mecanico || 'Taller'}\n\n` +
    `Tu incidencia fue resuelta. ✅\n\n` +
    `_EcoService · Taller_`;

  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to:   `whatsapp:${numero}`,
      body: mensaje,
    });
    console.log(`[NOTIF] Finalizado enviado a ${numero}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error notificando:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EcoService Bot corriendo en puerto ${PORT}`);
});
