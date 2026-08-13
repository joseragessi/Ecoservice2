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
const { iniciarViajes, continuarViajes, tieneSesionViajes } = require('./viajes');
const panelApi = require('./panel_api');
const { router: appApi } = require('./app_api');
const control = require('./control');
const { notificarCapataz } = require('./notificar');
const seg = require('./seguridad');

const app  = express();
app.use(express.urlencoded({ extended: false, limit: '25mb' }));
app.use(express.json({ limit: '25mb' }));
app.use(seg.headersSeguridad);

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
const RE_VIAJES = /^(viaje|viajes|bateas?|odometro|od[oó]metro)\b[\s:,\-]*/i;

// ¿El texto parece un LISTADO de stock (equipos + números) y no un saludo?
// Se usa para no confundir un "hola" con la respuesta al censo de stock.
const SALUDOS = /^(hola|holaa+|buenas|buen d[ií]a|buenos d[ií]as|buenas tardes|buenas noches|hey|ola|q onda|que onda|menu|men[uú]|gracias|ok|dale|listo|si|s[ií]|no|test|prueba)\b/i;
const RE_EQUIPO = /motoguada|guadaña|motosierra|extensible|soplad|tractor|giro cero|plana|toyota|camioneta|cami[oó]n|atego|hidrogr[uú]a|hidro gr[uú]a|carro|remolque|m[aá]quina|maquina|unidad/i;
function pareceListadoStock(texto) {
  const t = (texto || '').trim();
  if (!t || t.length < 3) return false;
  // Un saludo/comando corto NUNCA es un listado
  if (SALUDOS.test(t) && t.length < 25) return false;
  // Parece listado si menciona un tipo de equipo, o si tiene números de máquina
  // (patrón "N° 12", "nro 4", o varios números sueltos como "12, 15 y 21").
  const mencionaEquipo = RE_EQUIPO.test(t);
  const tieneNumeros = /n[°º]\s*\d+|nro\.?\s*\d+|\b\d+\b.*\b\d+\b/i.test(t);
  return mencionaEquipo || tieneNumeros;
}

// ── Webhook de Twilio WhatsApp ────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Firma de Twilio: rechaza requests que no vengan realmente de Twilio
  // (nadie puede simular mensajes de capataces posteando al webhook).
  if (!seg.validarTwilio(req)) {
    console.warn('[seguridad] webhook rechazado: firma de Twilio inválida');
    return res.sendStatus(403);
  }
  const telefono   = req.body.From;
  const paraNumero = req.body.To;
  const mensaje    = req.body.Body || '';
  const numMedia   = parseInt(req.body.NumMedia || '0', 10);

  const esProveedores = NUMERO_PROVEEDORES && paraNumero === NUMERO_PROVEEDORES;

  // Kill switch: si el PIN venció, el bot no responde nada (salvo a tu propio
  // número, para no dejarte a ciegas — ese aviso lo maneja el job de abajo).
  if (!(await control.estaOperativo())) {
    console.warn('[control] bot bloqueado (PIN vencido) — mensaje ignorado de', telefono);
    return res.sendStatus(200);   // 200 para que Twilio no reintente
  }

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
      } else if (await tieneSesionCombustible(telefono)) {
        respuesta = await continuarConversacion(telefono, mensaje);
      } else if (await tieneSesionInsumos(telefono)) {
        respuesta = await continuarInsumos(telefono, mensaje);
      } else if (await tieneSesionStock(telefono)) {
        respuesta = await continuarStock(telefono, mensaje);
        // El capataz escribió "menu"/"salir" estando en el flujo de stock:
        // la sesión ya se borró, lo mandamos al menú de verdad.
        if (respuesta && respuesta.__derivar === 'menu') {
          respuesta = await procesarMensaje(telefono, mensaje);
        }
      } else if (await tieneSesionViajes(telefono)) {
        respuesta = await continuarViajes(telefono, mensaje);
      } else if (RE_VIAJES.test(mensaje.trim())) {
        const resto = mensaje.trim().replace(RE_VIAJES, '');
        respuesta = await iniciarViajes(telefono, resto);
      } else if (RE_INSUMOS.test(mensaje.trim())) {
        // Arranca un pedido de insumos; le pasamos lo que escribió después de la palabra
        const resto = mensaje.trim().replace(RE_INSUMOS, '');
        respuesta = await iniciarInsumos(telefono, resto);
      } else if (RE_STOCK.test(mensaje.trim())) {
        // Arranca el envío de stock; le pasamos lo que escribió después de "stock"
        const resto = mensaje.trim().replace(RE_STOCK, '');
        respuesta = await iniciarStock(telefono, resto);
      } else if (pareceListadoStock(mensaje.trim())
                 && await tienePedidoPendiente(telefono)) {
        // Le pedimos el stock y todavía no respondió. Solo tratamos el texto como
        // listado si REALMENTE parece uno (menciona equipos o números de máquina).
        // Un "hola" o cualquier saludo NO se toma como listado: va al menú, así el
        // capataz no queda encerrado en el flujo de stock.
        respuesta = await iniciarStock(telefono, mensaje.trim());
      } else {
        // Menú principal / flujo de incidencias (conversacion.js)
        respuesta = await procesarMensaje(telefono, mensaje);
        // Si el capataz eligió "insumos" o "stock" en el menú, arrancamos ese flujo
        if (respuesta && respuesta.__derivar === 'insumos') {
          respuesta = await iniciarInsumos(telefono, '');
        } else if (respuesta && respuesta.__derivar === 'stock') {
          respuesta = await iniciarStock(telefono, '');
        } else if (respuesta && respuesta.__derivar === 'viajes') {
          respuesta = await iniciarViajes(telefono, '');
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

// ── Kill switch: chequeo al arrancar + aviso periódico por WhatsApp ──────────
// Tu número (para el aviso de renovación). Formato: 549351... (sin whatsapp:)
const ADMIN_TEL = process.env.SYSTEM_ADMIN_TEL;

async function chequearControl() {
  try {
    const st = await control.estado(true);
    if (!st.activo) return;   // kill switch desactivado (sin SYSTEM_PIN)
    if (st.bloqueado) {
      console.warn(`[control] ⛔ SISTEMA BLOQUEADO — PIN vencido. Renová SYSTEM_PIN en Railway.`);
    } else {
      console.log(`[control] PIN vigente — faltan ${st.dias_restantes} día(s) para el vencimiento.`);
    }
    // Aviso por WhatsApp cuando entra en la ventana de aviso (una vez por día)
    if (ADMIN_TEL && await control.debeAvisar()) {
      const ok = await notificarCapataz(ADMIN_TEL,
        `⚠️ *EcoService — renovación de PIN*\n\n` +
        `Faltan *${st.dias_restantes} día(s)* para que el sistema se bloquee.\n\n` +
        `Renová el PIN cambiando la variable *SYSTEM_PIN* en Railway por un valor nuevo y redeployá. ` +
        `Si no lo hacés, el bot y el panel dejan de funcionar.`);
      if (ok) await control.marcarAvisoEnviado();
    }
  } catch (e) {
    console.error('[control] error en chequeo:', e.message || e);
  }
}

// ── Alerta 48hs del circuito de repuestos ────────────────────────────────
// Pedidos que llevan más de 48hs HÁBILES (lun–vie) sin cambio de estado en
// las etapas del Referente (pedido / en_cotizacion / cotizado) → un WhatsApp
// resumen al Referente y a José. Se marca alerta_48_enviada para no repetir
// hasta el próximo cambio de estado. Teléfonos en la env
// ALERTA_REPUESTOS_TELEFONOS (coma-separados); sin ella solo loguea.
function horasHabilesDesde(iso) {
  let desde = new Date(iso).getTime();
  const ahora = Date.now();
  if (!(desde > 0) || desde >= ahora) return 0;
  let horas = 0;
  const paso = 60 * 60 * 1000;
  for (let t = desde; t < ahora; t += paso) {
    const dia = new Date(t).getUTCDay();          // aprox UTC: alcanza para un umbral de 48hs
    if (dia !== 0 && dia !== 6) horas++;
  }
  return horas;
}
async function chequearRepuestos48() {
  try {
    const supabase = require('./supabase');
    const { data: pends } = await supabase.from('repuestos_taller')
      .select('id, estado, estado_desde, created_at, alerta_48_enviada, items, incidencias(numero_unidad, tipo_equipo)')
      .in('estado', ['pedido', 'en_cotizacion', 'cotizado']);
    const vencidos = (pends || []).filter(p => {
      const desde = p.estado_desde || p.created_at;
      if (!desde || horasHabilesDesde(desde) < 48) return false;
      // Ya avisada para ESTE estado (la alerta es posterior al último cambio)
      return !(p.alerta_48_enviada && new Date(p.alerta_48_enviada) >= new Date(desde));
    });
    if (!vencidos.length) return;
    const lineas = vencidos.slice(0, 8).map(p => {
      const inc = p.incidencias || {};
      const it = (p.items || [])[0] || {};
      return `• ${it.descripcion || 'Repuesto'} — ${inc.tipo_equipo || ''} ${inc.numero_unidad || ''} · ${p.estado.replace('_', ' ')}`;
    }).join('\n');
    const texto = `⏰ *Repuestos sin movimiento (48hs hábiles)*\n${lineas}${vencidos.length > 8 ? `\n…y ${vencidos.length - 8} más` : ''}\n\nRevisá la cola en la app / panel.`;
    const tels = String(process.env.ALERTA_REPUESTOS_TELEFONOS || '').split(',').map(t => t.trim()).filter(Boolean);
    if (tels.length) {
      const { notificarCapataz } = require('./notificar');
      for (const t of tels) await notificarCapataz(t, texto);
    } else {
      console.log('[repuestos48] ' + vencidos.length + ' pedidos vencidos (sin ALERTA_REPUESTOS_TELEFONOS, solo log)');
    }
    const ahora = new Date().toISOString();
    for (const p of vencidos) {
      await supabase.from('repuestos_taller').update({ alerta_48_enviada: ahora }).eq('id', p.id);
    }
  } catch (e) {
    console.error('[repuestos48] error:', e.message || e);
  }
}
setTimeout(chequearRepuestos48, 90 * 1000);            // al arrancar (con margen)
setInterval(chequearRepuestos48, 60 * 60 * 1000);      // cada hora

chequearControl();                          // al arrancar
setInterval(chequearControl, 6 * 60 * 60 * 1000);  // cada 6 horas
