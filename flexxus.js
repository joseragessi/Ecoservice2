// ── Integración Flexxus ERP ─────────────────────────────────────────────────
// Imputa facturas del módulo Compras como comprobantes de compra en Flexxus.
// Entorno y credenciales por variables de Railway:
//   FLEXXUS_URL        p.ej. https://prueba-ecoservice.procomisp.com.ar
//   FLEXXUS_USER       usuario de la API (p.ej. SOLEDAD)
//   FLEXXUS_PASS       clave
//   FLEXXUS_CODIGO_USUARIO   usuario Flexxus que "carga" el comprobante (default = FLEXXUS_USER)
//   FLEXXUS_MULTIPLAZO       código de condición de pago (ver "Probar conexión")
//   FLEXXUS_DEPOSITO         código de depósito (ver "Probar conexión")
//   FLEXXUS_CODIGO_PERCEPCION  código de percepción para otros_conceptos (opcional
//                              si las facturas no traen percepciones)
// El deviceinfo es el valor fijo que indica la doc de Flexxus.

const DEVICEINFO = process.env.FLEXXUS_DEVICEINFO ||
  '{"model":"0","platform":"0","uuid":"4953457348957348975","version":"0","manufacturer":"0"}';

function base() {
  const u = process.env.FLEXXUS_URL;
  if (!u) throw new Error('Falta FLEXXUS_URL en Railway');
  return u.replace(/\/$/, '') + '/v5';
}

// ── Login con cache de token ─────────────────────────────────
let _tok = null;   // { token, vence (epoch ms) }

async function login() {
  const body = new URLSearchParams({
    username: process.env.FLEXXUS_USER || '',
    password: process.env.FLEXXUS_PASS || '',
    deviceinfo: DEVICEINFO,
  });
  const r = await fetch(base() + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.token) {
    throw new Error('Login Flexxus falló (' + r.status + '): ' + (d.message || d.error || 'revisá FLEXXUS_USER/PASS'));
  }
  // expireIn viene en epoch seconds; renovamos 5 min antes
  _tok = { token: d.token, vence: (Number(d.expireIn) || (Date.now() / 1000 + 3600)) * 1000 - 5 * 60 * 1000 };
  console.log('[flexxus] login OK');
  return _tok.token;
}

async function token() {
  if (_tok && Date.now() < _tok.vence) return _tok.token;
  return login();
}

// fetch autenticado con un reintento si el token se venció
async function flx(path, opts = {}, reint = true) {
  const t = await token();
  const r = await fetch(base() + path, {
    ...opts,
    headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (r.status === 401 && reint) { _tok = null; return flx(path, opts, false); }
  const texto = await r.text();
  let d; try { d = JSON.parse(texto); } catch (e) { d = { raw: texto }; }
  if (!r.ok) {
    const msg = (d && (d.message || d.error)) || texto.slice(0, 200) || ('HTTP ' + r.status);
    const err = new Error(msg); err.status = r.status; err.data = d;
    throw err;
  }
  return d;
}

// ── Proveedores ──────────────────────────────────────────────
function cuitLimpio(c) { return String(c || '').replace(/\D/g, ''); }

async function buscarProveedorPorCuit(cuit) {
  const c = cuitLimpio(cuit);
  if (!c) return null;
  try {
    const d = await flx('/proveedores?cuit=' + encodeURIComponent(c));
    const lista = d.data || d || [];
    return Array.isArray(lista) && lista.length ? lista[0] : null;
  } catch (e) { return null; }
}

// ── Imputar factura de Compras como comprobante de compra ────
// f = el jsonb `data` de la factura del panel. letra = 'A'|'B'|'C'.
async function imputarFactura(f, letra) {
  for (const env of ['FLEXXUS_CODIGO_USUARIO', 'FLEXXUS_MULTIPLAZO', 'FLEXXUS_DEPOSITO']) {
    if (!process.env[env] && !(env === 'FLEXXUS_CODIGO_USUARIO' && process.env.FLEXXUS_USER)) {
      throw new Error('Falta configurar ' + env + ' en Railway (usá "Probar conexión" para ver los códigos disponibles)');
    }
  }
  const neto = Number(f.total_sin_iva) || 0;
  const iva  = Number(f.total_iva) || 0;
  const otros = f.otros_conceptos || [];
  const percepciones = otros.filter(o => !o.exento && (Number(o.monto) || 0) > 0);
  const exento = otros.filter(o => o.exento).reduce((s, o) => s + (Number(o.monto) || 0), 0);
  const totPerc = percepciones.reduce((s, o) => s + (Number(o.monto) || 0), 0);

  if (percepciones.length && !process.env.FLEXXUS_CODIGO_PERCEPCION) {
    throw new Error('La factura tiene percepciones: configurá FLEXXUS_CODIGO_PERCEPCION en Railway (usá "Probar conexión" para ver los códigos)');
  }

  // Proveedor: si existe por CUIT, mandamos SOLO su código (así Flexxus no pisa
  // sus datos); si no existe, mandamos lo mínimo y Flexxus lo crea.
  const provExistente = await buscarProveedorPorCuit(f.cuit);
  const proveedor = provExistente
    ? { codigoproveedor: provExistente.codigoproveedor }
    : { razonsocial: (f.proveedor || 'PROVEEDOR SIN NOMBRE').slice(0, 100), cuit: cuitLimpio(f.cuit) || undefined };

  // Productos: ítems reales como concepto libre (sin catálogo de artículos)
  const items = (f.items || []).filter(i => i.descripcion);
  const productos = items.length
    ? items.map(i => ({
        codigoarticulo: '*',
        descripcion: String(i.descripcion).slice(0, 200),
        cantidad: Number(i.cantidad) || 1,
        preciototal: Math.round(((Number(i.monto_sin_iva) || 0)) * 100) / 100,
      }))
    : [{ codigoarticulo: '*', descripcion: ('Factura ' + (f.numero_factura || 's/n') + ' — ' + (f.proveedor || '')).slice(0, 200), cantidad: 1, preciototal: Math.round(neto * 100) / 100 }];

  // Ajuste por redondeo: que la suma de productos cierre exacto con el neto
  const sumaProd = productos.reduce((s, p) => s + p.preciototal, 0);
  const ajuste = Math.round((neto - sumaProd) * 100) / 100;
  if (Math.abs(ajuste) >= 0.01 && Math.abs(ajuste) < 1) productos[productos.length - 1].preciototal += ajuste;

  const fecha = f.fecha_factura || new Date().toISOString().slice(0, 10);
  const venc = f.fecha_vencimiento ||
    new Date(new Date(fecha).getTime() + 30 * 86400000).toISOString().slice(0, 10);

  const body = {
    tipocomprobante: 'F' + (letra || 'A'),
    numerocomprobante: Number(String(f.numero_factura || '').replace(/\D/g, '')) || Date.now() % 1e9,
    fechacomprobante: fecha,
    fechaimputable: fecha,
    fechavencimiento: venc,
    codigousuario: process.env.FLEXXUS_CODIGO_USUARIO || process.env.FLEXXUS_USER,
    codigomultiplazo: Number(process.env.FLEXXUS_MULTIPLAZO),
    codigodeposito: process.env.FLEXXUS_DEPOSITO,
    tipofactura: 1,                       // 1 = cuenta corriente (se paga después)
    facturaporconcepto: true,
    proveedor,
    productos,
    exento: Math.round(exento * 100) / 100,
    observaciones: 'Imputada desde Panel EcoService',
    total: Math.round((neto + iva + totPerc + exento) * 100) / 100,
  };
  if (iva > 0) {
    body.calculaiva = true;
    body.iva = [{ monto: Math.round(iva * 100) / 100, porcentaje: 21 }];
  }
  if (percepciones.length) {
    body.percepciones = percepciones.map(o => ({
      codigopercepcion: process.env.FLEXXUS_CODIGO_PERCEPCION,
      monto: Math.round((Number(o.monto) || 0) * 100) / 100,
    }));
  }

  const resp = await flx('/comprobantescompras', { method: 'POST', body: JSON.stringify(body) });
  console.log(`[flexxus] factura ${f.numero_factura} imputada (${body.tipocomprobante} ${body.numerocomprobante}, prov ${provExistente ? provExistente.codigoproveedor : 'NUEVO'})`);
  return {
    ok: true,
    tipocomprobante: body.tipocomprobante,
    numerocomprobante: body.numerocomprobante,
    proveedor_codigo: provExistente ? provExistente.codigoproveedor : null,
    proveedor_creado: !provExistente,
    respuesta: resp,
  };
}

// ── Diagnóstico: probar conexión y listar códigos configurables ──
async function probarConexion() {
  await login();
  const out = { ok: true, url: process.env.FLEXXUS_URL, usuario: process.env.FLEXXUS_USER };
  const trae = async (path, mapa) => {
    try { const d = await flx(path); const l = d.data || d || []; return (Array.isArray(l) ? l : []).slice(0, 40).map(mapa); }
    catch (e) { return [{ error: e.message }]; }
  };
  out.depositos    = await trae('/depositos',   x => ({ codigo: x.codigodeposito, descripcion: x.descripcion }));
  out.multiplazos  = await trae('/multiplazos', x => ({ codigo: x.codigomultiplazo, descripcion: x.descripcion }));
  out.percepciones = await trae('/percepciones', x => ({ codigo: x.codigopercepcion, descripcion: x.descripcion }));
  out.config = {
    FLEXXUS_CODIGO_USUARIO: process.env.FLEXXUS_CODIGO_USUARIO || process.env.FLEXXUS_USER || '(falta)',
    FLEXXUS_MULTIPLAZO: process.env.FLEXXUS_MULTIPLAZO || '(falta)',
    FLEXXUS_DEPOSITO: process.env.FLEXXUS_DEPOSITO || '(falta)',
    FLEXXUS_CODIGO_PERCEPCION: process.env.FLEXXUS_CODIGO_PERCEPCION || '(falta — solo necesario si hay percepciones)',
  };
  return out;
}

module.exports = { imputarFactura, probarConexion, buscarProveedorPorCuit };
