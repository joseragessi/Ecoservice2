require('dotenv').config();
const express  = require('express');
const twilio   = require('twilio');
const { procesarMensaje } = require('./conversacion');

const app  = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Webhook de Twilio WhatsApp ────────────────────────────────
app.post('/webhook', async (req, res) => {
  const telefono = req.body.From;   // ej: whatsapp:+5493516111111
  const mensaje  = req.body.Body || '';

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

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EcoService Bot corriendo en puerto ${PORT}`);
});
