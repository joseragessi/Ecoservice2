// ══════════════════════════════════════════════════════════════
// Mail de las facturas de venta (29-sep-2026)
// Lo manda el PANEL (no Flexxus) para poder adjuntar el PDF que se sube y
// concilia en Administración. Sale por el SMTP de Ferozo (Railway Pro permite
// SMTP saliente). Variables en Railway:
//   SMTP_HOST   ej. c1234567.ferozo.com (Ferozo → Email → Cuentas → ícono de info)
//   SMTP_PORT   465 (SSL) o 587
//   SMTP_USER   la casilla completa, ej. administracion@ecoservicesrl.com.ar
//   SMTP_PASS   la contraseña de esa casilla
//   SMTP_FROM   opcional: "EcoService <administracion@ecoservicesrl.com.ar>"
//   SMTP_BCC    opcional: copia oculta para que quede registro (por defecto, la misma casilla)
// Solo lo usa facturación de ventas. Compras no lo toca.
// ══════════════════════════════════════════════════════════════

const EMPRESA = {
  nombre: 'EcoService S.R.L.',
  direccion: 'Gral. M. Savio 6150 · Córdoba',
  cuit: '30-70793029-9',
  email: 'administracion@ecoservicesrl.com.ar',
  web: 'www.ecoservicesrl.com.ar',
};

function configurado() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let _tx = null;
function transporte() {
  if (!configurado()) {
    const e = new Error('Falta configurar el correo: cargá SMTP_HOST, SMTP_USER y SMTP_PASS en Railway (datos de la casilla de Ferozo).');
    e.status = 503; throw e;
  }
  if (_tx) return _tx;
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (e) { const x = new Error('Falta instalar nodemailer (está en package.json: hacé un deploy nuevo).'); x.status = 503; throw x; }
  const port = Number(process.env.SMTP_PORT || 465);
  _tx = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 20000,
  });
  return _tx;
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plata = n => '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nroTxt = n => { n = Number(n); return n >= 1e8 ? String(Math.floor(n / 1e8)).padStart(4, '0') + '-' + String(n % 1e8).padStart(8, '0') : String(n); };
const fecha = f => (f ? new Date(String(f).slice(0, 10) + 'T12:00').toLocaleDateString('es-AR') : '');

/** Asunto + HTML del mail, a partir de la factura (fact_items con fact_clientes). */
function armarMail(it, cliente) {
  const letra = it.tipo_comprobante === 'FB' ? 'B' : 'A';
  const numero = nroTxt(it.numero_comprobante);
  const asunto = `Factura ${letra} ${numero} · ${EMPRESA.nombre}`;
  const nombre = (cliente && cliente.nombre) || '';
  const fila = (l, v) => `<tr><td style="padding:7px 0;color:#586B60;font-size:13px">${l}</td><td style="padding:7px 0;text-align:right;font-size:13px;font-weight:600;color:#16221C">${v}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#F4F6F2;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F2;padding:24px 0"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:14px;overflow:hidden">
  <tr><td style="background:#159B51;padding:22px 28px;color:#fff">
    <div style="font-size:20px;font-weight:bold">EcoService</div>
    <div style="font-size:12px;opacity:.85;margin-top:2px">Mantenimiento de espacios verdes</div></td></tr>
  <tr><td style="padding:26px 28px 6px;color:#16221C">
    <div style="font-size:15px">Hola${nombre ? ' <b>' + esc(nombre) + '</b>' : ''},</div>
    <div style="font-size:14px;color:#586B60;margin-top:10px;line-height:1.5">Te enviamos la factura del servicio. La vas a encontrar adjunta en PDF.</div></td></tr>
  <tr><td style="padding:14px 28px">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E6EBE4;border-bottom:1px solid #E6EBE4">
      ${fila('Factura', `${letra} ${numero}`)}
      ${fila('Fecha', esc(fecha(it._fecha)))}
      ${fila('Concepto', esc(it.descripcion || ''))}
      ${it.cae ? fila('CAE', esc(it.cae)) : ''}
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;background:#16221C;border-radius:10px">
      <tr><td style="padding:14px 16px;color:rgba(255,255,255,.7);font-size:12px">TOTAL</td>
      <td style="padding:14px 16px;text-align:right;color:#fff;font-size:20px;font-weight:bold">${plata(it.total)}</td></tr></table>
  </td></tr>
  <tr><td style="padding:8px 28px 24px;font-size:13px;color:#586B60;line-height:1.5">Ante cualquier consulta, respondé este mail.<br>Gracias.</td></tr>
  <tr><td style="background:#16221C;padding:18px 28px;color:rgba(255,255,255,.75);font-size:11.5px;line-height:1.6">
    <b style="color:#fff">${EMPRESA.nombre}</b> · CUIT ${EMPRESA.cuit}<br>${EMPRESA.direccion}<br>${EMPRESA.email} · ${EMPRESA.web}</td></tr>
</table></td></tr></table></body></html>`;
  return { asunto, html };
}

/** Manda el mail con el PDF adjunto. `pdf` = Buffer. */
async function enviarFactura({ it, cliente, para, cc, pdf, nombrePdf }) {
  const tx = transporte();
  const { asunto, html } = armarMail(it, cliente);
  const desde = process.env.SMTP_FROM || `EcoService <${process.env.SMTP_USER}>`;
  const bcc = process.env.SMTP_BCC || process.env.SMTP_USER;
  const info = await tx.sendMail({
    from: desde, to: para, cc: cc || undefined, bcc, replyTo: process.env.SMTP_USER,
    subject: asunto, html,
    attachments: [{ filename: nombrePdf || `Factura ${it.tipo_comprobante === 'FB' ? 'B' : 'A'} ${nroTxt(it.numero_comprobante)}.pdf`, content: pdf, contentType: 'application/pdf' }],
  });
  return { id: info && info.messageId };
}

module.exports = { configurado, armarMail, enviarFactura, nroTxt };
