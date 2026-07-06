require('dotenv').config();
const express  = require('express');
const twilio   = require('twilio');
const { procesarMensaje } = require('./conversacion');
const { procesarComprobante, tieneSesionActiva, continuarConversacion } = require('./combustible');

const app  = express();
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
  const numMedia = parseInt(req.body.NumMedia || '0', 10);

  console.log(`[IN] ${telefono}: ${numMedia > 0 ? `[${numMedia} imagen(es)]` : mensaje}`);

  try {
    let respuesta;

    if (numMedia > 0) {
      // Llegó una foto → arranca el flujo de combustible (lee y pregunta destino)
      const mediaUrl  = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;
      respuesta = await procesarComprobante(telefono, mediaUrl, mediaType);
    } else if (tieneSesionActiva(telefono)) {
      // Hay una carga de combustible esperando respuesta → el texto es esa respuesta,
      // NO una incidencia nueva.
      respuesta = await continuarConversacion(telefono, mensaje);
    } else {
      // Texto sin sesión de combustible → flujo de incidencias (el de siempre)
      respuesta = await procesarMensaje(telefono, mensaje);
    }

    console.log(`[OUT] ${telefono}: ${(respuesta || '').slice(0, 80)}...`);

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EcoService Bot corriendo en puerto ${PORT}`);
});
