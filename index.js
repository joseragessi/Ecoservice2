require('dotenv').config();
const express  = require('express');
const twilio   = require('twilio');
const { procesarMensaje } = require('./conversacion');
const { procesarComprobante, tieneSesionActiva: tieneSesionCombustible,
        continuarConversacion } = require('./combustible');
const { iniciarInsumos, tieneSesionActiva: tieneSesionInsumos,
        continuarInsumos } = require('./insumos');
const { iniciarStock, tieneSesionActiva: tieneSesionStock,
        continuarStock, tienePedidoPendiente } = require('./stock');
const { procesarFactura } = require('./facturas_bot');
const panelApi = require('./panel_api');
const { router: appApi } = require('./app_api');

const app  = express();
app.use(express.urlencoded({ extended: false, limit: '25mb' }));
app.use(express.json({ limit: '25mb' }));

// Panel de gestión (login + API + HTML), servido desde el mismo Express.
app.use('/', appApi);     // PWA del taller y pañol (/app + /api/app/*)
app.use('/', panelApi);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Número dedicado a facturas de proveedor (formato: whatsapp:+549...).
const NUMERO_PROVEEDORES = process.env.TWILIO_NUMERO_PROVEEDORES;

// Disparador de pedidos de insumos: el capataz arranca con "insumos" o "pedido".
const RE_INSUMOS = /^(insumos|pedido)\b[\s:,\-]*/i;
// Disparador de stock de maquinaria: el capataz arranca con "stock".
const RE_STOCK = /^stock\b[\s:,\-]*/i;

// ── Webhook de Twilio WhatsApp ────────────────────────────────
app.post('/webhook', async (req, res) => {
  const telefono   = req.body.From;
  const paraNumero = req.body.To;
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
      // ── Flujo CAPATACES (combustible / insumos / incidencias) ──
      if (numMedia > 0) {
        // Una imagen es un comprobante de combustible
        respuesta = await procesarComprobante(telefono, req.body.MediaUrl0, req.body.MediaContentType0);
      } else if (tieneSesionCombustible(telefono)) {
        respuesta = await continuarConversacion(telefono, mensaje);
      } else if (tieneSesionInsumos(telefono)) {
        respuesta = await continuarInsumos(telefono, mensaje);
      } else if (tieneSesionStock(telefono)) {
        respuesta = await continuarStock(telefono, mensaje);
      } else if (RE_INSUMOS.test(mensaje.trim())) {
        // Arranca un pedido de insumos; le pasamos lo que escribió después de la palabra
        const resto = mensaje.trim().replace(RE_INSUMOS, '');
        respuesta = await iniciarInsumos(telefono, resto);
      } else if (RE_STOCK.test(mensaje.trim())) {
        // Arranca el envío de stock; le pasamos lo que escribió después de "stock"
        const resto = mensaje.trim().replace(RE_STOCK, '');
        respuesta = await iniciarStock(telefono, resto);
      } else if (!/^(menu|menú)$/i.test(mensaje.trim()) && !/^[1-4]$/.test(mensaje.trim())
                 && await tienePedidoPendiente(telefono)) {
        // Le pedimos el stock y todavía no respondió: cualquier texto libre que
        // mande es su listado. No hace falta que escriba la palabra "stock".
        // ("menu" o un dígito 1-4 siguen yendo al menú, para no encerrarlo.)
        respuesta = await iniciarStock(telefono, mensaje.trim());
      } else {
        // Menú principal / flujo de incidencias (conversacion.js)
        respuesta = await procesarMensaje(telefono, mensaje);
        // Si el capataz eligió "insumos" o "stock" en el menú, arrancamos ese flujo
        if (respuesta && respuesta.__derivar === 'insumos') {
          respuesta = await iniciarInsumos(telefono, '');
        } else if (respuesta && respuesta.__derivar === 'stock') {
          respuesta = await iniciarStock(telefono, '');
        }
      }
    }

    console.log(`[OUT] ${telefono}: ${(respuesta || '').slice(0, 80)}...`);

    await twilioClient.messages.create({
      from: paraNumero || process.env.TWILIO_WHATSAPP_NUMBER,
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
