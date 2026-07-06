require('dotenv').config();
const express  = require('express');
const twilio   = require('twilio');
const { procesarMensaje } = require('./conversacion');
const { procesarComprobante, tieneSesionActiva, continuarConversacion } = require('./combustible');
const { procesarFactura } = require('./facturas_bot');

const app  = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Número dedicado a facturas de proveedor (formato: whatsapp:+549...).
// Si un mensaje llega a ESTE número → flujo de facturas. Si llega a cualquier
// otro → flujo de capataces (incidencias / combustible).
const NUMERO_PROVEEDORES = process.env.TWILIO_NUMERO_PROVEEDORES;

// ── Webhook de Twilio WhatsApp ────────────────────────────────
app.post('/webhook', async (req, res) => {
  const telefono   = req.body.From;              // quién escribió
  const paraNumero = req.body.To;                // a qué número escribió
  const mensaje    = req.body.Body || '';
  const numMedia   = parseInt(req.body.NumMedia || '0', 10);

  const esProveedores = NUMERO_PROVEEDORES && paraNumero === NUMERO_PROVEEDORES;

  console.log(`[IN] ${telefono} -> ${paraNumero} ${esProveedores ? '(proveedores)' : '(capataces)'}: ` +
              `${numMedia > 0 ? `[${numMedia} archivo(s)]` : mensaje}`);

  try {
    let respuesta;

    if (esProveedores) {
      // ── Flujo FACTURAS DE PROVEEDOR ──
      if (numMedia > 0) {
        respuesta = await procesarFactura(telefono, req.body.MediaUrl0, req.body.MediaContentType0);
      } else {
        respuesta = 'Hola 👋 Mandá la *factura* como foto o PDF y la registramos automáticamente.';
      }
    } else {
      // ── Flujo CAPATACES (incidencias / combustible) ──
      if (numMedia > 0) {
        respuesta = await procesarComprobante(telefono, req.body.MediaUrl0, req.body.MediaContentType0);
      } else if (tieneSesionActiva(telefono)) {
        respuesta = await continuarConversacion(telefono, mensaje);
      } else {
        respuesta = await procesarMensaje(telefono, mensaje);
      }
    }

    console.log(`[OUT] ${telefono}: ${(respuesta || '').slice(0, 80)}...`);

    await twilioClient.messages.create({
      from: paraNumero || process.env.TWILIO_WHATSAPP_NUMBER,  // responde desde el número correcto
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
