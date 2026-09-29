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
// Diseño del mail: mockup_email_factura_v2.html (29-sep).
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

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const mesTxt = p => { const m = String(p || '').match(/^(\d{4})-(\d{2})/); return m ? `${MESES[+m[2] - 1]} ${m[1]}` : ''; };
const capital = t => { t = String(t || '').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };

// El logo va INCRUSTADO en el mail (cid), no como link: se ve aunque el cliente
// bloquee las imágenes externas. Sale del PDF de las facturas (29-sep).
const path = require('path'); const fs = require('fs');
let _logo = null;
function logo() { if (_logo === null) { try { _logo = fs.readFileSync(path.join(__dirname, 'email-logo.png')); } catch (e) { _logo = false; } } return _logo; }

/**
 * Asunto + HTML del mail (mockup_email_factura_v2, aprobado 29-sep).
 * it: fact_items + _fecha (emisión), _periodo, _concepto, _vence, _condicion (estos dos, de Flexxus; si no hay, no se muestran).
 */
function armarMail(it, cliente) {
  const letra = it.tipo_comprobante === 'FB' ? 'B' : 'A';
  const numero = nroTxt(it.numero_comprobante);
  const periodo = mesTxt(it._periodo || it._fecha);
  const concepto = capital(it._concepto || 'Servicio');
  const asunto = `Factura ${letra} ${numero} · ${concepto}${periodo ? ' ' + periodo : ''}`;
  const nombre = (cliente && cliente.nombre) || '';
  const conLogo = !!logo();
  const img = (w, h) => conLogo ? `<img src="cid:logo-ecoservice" width="${w}" height="${h}" alt="EcoService" style="display:block;border-radius:${w > 40 ? 8 : 6}px;background:#fff">` : '';
  const fila = (l, v, ult) => `<tr><td style="padding:9px 0;color:#8C9B92;${ult ? '' : 'border-bottom:1px solid #EEF1EC'}">${l}</td><td align="right" style="padding:9px 0;${ult ? '' : 'border-bottom:1px solid #EEF1EC;'}font-weight:bold;color:#16221C">${v}</td></tr>`;
  const filas = [['Comprobante', `Factura ${letra} ${numero}`], ['Fecha de emisión', esc(fecha(it._fecha))], ['Concepto', esc(capital(it.descripcion || ''))]];
  if (it._condicion) filas.push(['Condición', esc(it._condicion)]);
  const html = `<!doctype html><html><body style="margin:0;background:#EEF2EC;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#EEF2EC;padding:26px 12px"><tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#fff;border-radius:16px;overflow:hidden">
 <tr><td style="background:#159B51;padding:20px 26px">
   <table width="100%" cellpadding="0" cellspacing="0"><tr>
    ${conLogo ? `<td width="62">${img(54, 55)}</td>` : ''}
    <td style="color:#fff;padding-left:${conLogo ? 12 : 0}px"><div style="font-size:19px;font-weight:bold">EcoService</div><div style="font-size:12px;color:#DDF3E6">Servicios integrales · Espacios verdes</div></td>
    <td align="right" style="color:#DDF3E6;font-size:11px">FACTURA<br><b style="font-size:15px;color:#fff">${letra} ${numero}</b></td>
   </tr></table></td></tr>
 <tr><td style="padding:26px 26px 4px;color:#16221C">
   <div style="font-size:17px;font-weight:bold">Hola${nombre ? ', equipo de ' + esc(nombre) : ''}</div>
   <div style="font-size:14px;color:#586B60;margin-top:10px;line-height:1.55">Te enviamos la factura por <b style="color:#16221C">${esc(concepto.toLowerCase())}${periodo ? ' de ' + periodo : ''}</b>. La encontrás adjunta en PDF.</div></td></tr>
 <tr><td style="padding:18px 26px 6px">
   <table width="100%" cellpadding="0" cellspacing="0" style="background:#16221C;border-radius:12px"><tr>
    <td style="padding:16px 18px;color:#AEB9B3;font-size:11px;letter-spacing:.8px">TOTAL A PAGAR<div style="color:#fff;font-size:26px;font-weight:bold;letter-spacing:0;margin-top:3px">${plata(it.total)}</div></td>
    ${it._vence ? `<td align="right" style="padding:16px 18px;color:#AEB9B3;font-size:11px;letter-spacing:.8px">VENCE<div style="color:#8EE0B0;font-size:18px;font-weight:bold;letter-spacing:0;margin-top:3px">${esc(fecha(it._vence))}</div></td>` : ''}
   </tr></table></td></tr>
 <tr><td style="padding:10px 26px 4px">
   <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">${filas.map((f, i) => fila(f[0], f[1], i === filas.length - 1)).join('')}</table></td></tr>
 <tr><td style="padding:14px 26px 4px">
   <table width="100%" cellpadding="0" cellspacing="0" style="background:#E5F5EC;border-radius:12px"><tr><td style="padding:14px 16px;font-size:13px;color:#0F5C33;line-height:1.55">
    <b>Factura adjunta</b> · ${esc(it.pdf_nombre || `Factura ${letra} ${numero}.pdf`)}${it.cae ? `<br><span style="color:#3C6B50">Factura electrónica · CAE ${esc(it.cae)}</span>` : ''}</td></tr></table></td></tr>
 <tr><td style="padding:18px 26px 24px;font-size:13.5px;color:#586B60;line-height:1.6">
   ¿Tenés alguna consulta sobre la factura? <b style="color:#16221C">Respondé este mail</b> y te contestamos a la brevedad.<br><br>
   Saludos,<br><b style="color:#16221C">Administración · EcoService</b></td></tr>
 <tr><td style="background:#16221C;padding:20px 26px">
   <table width="100%" cellpadding="0" cellspacing="0"><tr>
    ${conLogo ? `<td width="46" valign="top">${img(38, 39)}</td>` : ''}
    <td style="padding-left:${conLogo ? 12 : 0}px;color:#B8C2BC;font-size:11.5px;line-height:1.65">
     <b style="color:#fff">${EMPRESA.nombre}</b> · CUIT ${EMPRESA.cuit}<br>${EMPRESA.direccion}<br>
     <span style="color:#8EE0B0">${esc(process.env.SMTP_USER || EMPRESA.email)}</span> · <span style="color:#8EE0B0">${EMPRESA.web}</span></td>
   </tr></table></td></tr>
</table>
<div style="font-size:10.5px;color:#8C9B92;margin-top:10px">Este mail se generó automáticamente con la factura adjunta.</div>
</td></tr></table></body></html>`;
  return { asunto, html };
}

/** Manda el mail con el PDF adjunto. `pdf` = Buffer. */
async function enviarFactura({ it, cliente, para, cc, pdf, nombrePdf }) {
  const tx = transporte();
  const { asunto, html } = armarMail({ ...it, pdf_nombre: nombrePdf || it.pdf_nombre }, cliente);
  const desde = process.env.SMTP_FROM || `EcoService <${process.env.SMTP_USER}>`;
  const bcc = process.env.SMTP_BCC || process.env.SMTP_USER;
  const attachments = [{ filename: nombrePdf || `Factura ${it.tipo_comprobante === 'FB' ? 'B' : 'A'} ${nroTxt(it.numero_comprobante)}.pdf`, content: pdf, contentType: 'application/pdf' }];
  if (logo()) attachments.push({ filename: 'ecoservice.png', content: logo(), cid: 'logo-ecoservice', contentType: 'image/png' });
  const info = await tx.sendMail({ from: desde, to: para, cc: cc || undefined, bcc, replyTo: process.env.SMTP_USER, subject: asunto, html, attachments });
  return { id: info && info.messageId };
}

module.exports = { configurado, armarMail, enviarFactura, nroTxt };
