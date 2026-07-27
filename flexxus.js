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
    // Flexxus a veces devuelve message/errors como array de objetos: desarmarlos
    const plano = (x) => typeof x === 'string' ? x
      : (x && (x.message || x.msg || x.descripcion)) || JSON.stringify(x);
    let m = d && (d.message ?? d.error ?? d.errors ?? (Array.isArray(d) ? d : null));
    if (Array.isArray(m)) m = m.map(plano).join('\n· ');
    else if (m && typeof m === 'object') m = plano(m);
    const msg = m || texto.slice(0, 300) || ('HTTP ' + r.status);
    const err = new Error(String(msg)); err.status = r.status; err.data = d;
    throw err;
  }
  return d;
}

// ── Proveedores ──────────────────────────────────────────────
function cuitLimpio(c) { return String(c || '').replace(/\D/g, ''); }

async function buscarProveedorPorCuit(cuit, razonSocial) {
  const c = cuitLimpio(cuit);
  // 1) Por CUIT: probamos sin guiones y con el formato AR con guiones, porque
  // Flexxus puede tenerlo guardado de cualquiera de las dos formas.
  const variantes = [];
  if (c) {
    variantes.push(c);
    if (c.length === 11) variantes.push(c.slice(0, 2) + '-' + c.slice(2, 10) + '-' + c.slice(10));
  }
  for (const v of variantes) {
    try {
      const d = await flx('/proveedores?cuit=' + encodeURIComponent(v));
      const lista = d.data || d || [];
      if (Array.isArray(lista) && lista.length) {
        const match = lista.find(p => cuitLimpio(p.cuit) === c) || lista[0];
        if (match) return match;
      }
    } catch (e) { /* probamos la siguiente variante */ }
  }
  // 2) Respaldo por razón social EXACTA (útil si el CUIT vino mal en la factura)
  if (razonSocial) {
    try {
      const d = await flx('/proveedores?razonsocial=' + encodeURIComponent(razonSocial.trim()));
      const lista = d.data || d || [];
      const rs = razonSocial.trim().toLowerCase();
      const match = (Array.isArray(lista) ? lista : []).find(p => String(p.razonsocial || '').trim().toLowerCase() === rs);
      if (match) return match;
    } catch (e) { /* sin match por nombre */ }
  }
  return null;
}

// Un proveedor cualquiera existente, como plantilla de códigos válidos
// (condición IVA, clase, provincia, localidad) para las altas nuevas.
let _plantillaProv = null;
async function plantillaProveedor() {
  if (_plantillaProv) return _plantillaProv;
  try {
    const d = await flx('/proveedores?limit=1');
    const l = d.data || d || [];
    _plantillaProv = (Array.isArray(l) && l[0]) || {};
  } catch (e) { _plantillaProv = {}; }
  return _plantillaProv;
}
const codDe = (obj, ...claves) => {
  for (const k of claves) {
    if (obj == null) break;
    const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), obj);
    if (v != null && v !== '') return String(v);
  }
  return null;
};

// Resuelve los códigos requeridos para dar de alta un proveedor:
// env → campo del proveedor plantilla (nombres REALES del GET /proveedores:
// condicioniva plano, localidades.codigolocalidad) → consulta a la tabla
// correspondiente de Flexxus. Nunca inventa un código.
async function datosAltaProveedor() {
  const pl = await plantillaProveedor();
  const out = {
    codigocondicioniva: process.env.FLEXXUS_CONDICION_IVA ||
      codDe(pl, 'condicioniva', 'tipoivacompra.codigotipo'),
    codigoclaseproveedor: process.env.FLEXXUS_CLASE_PROVEEDOR ||
      codDe(pl, 'codigoclaseproveedor'),
    codigoprovincia: codDe(pl, 'codigoprovincia', 'provincia.codigoprovincia'),
    codigolocalidad: codDe(pl, 'codigolocalidad', 'localidades.codigolocalidad'),
    plantilla: pl.razonsocial || null,
  };
  // Faltantes: buscarlos en las tablas de Flexxus (preferimos "inscripto")
  if (!out.codigocondicioniva) {
    try {
      const d = await flx('/tiposivacompras');
      const l = d.data || d || [];
      const ri = l.find(x => /inscri/i.test(x.descripcion || '')) || l[0];
      if (ri) out.codigocondicioniva = String(ri.codigotipo);
    } catch (e) { /* sigue null */ }
  }
  if (!out.codigoclaseproveedor) {
    try {
      const d = await flx('/clasesproveedores');
      const l = d.data || d || [];
      if (l[0]) out.codigoclaseproveedor = String(l[0].codigoclaseproveedor);
    } catch (e) { /* sigue null */ }
  }
  for (const k of ['codigocondicioniva', 'codigoclaseproveedor', 'codigoprovincia', 'codigolocalidad']) {
    if (!out[k]) throw new Error('No pude resolver ' + k + ' para dar de alta el proveedor. ' +
      'Configurá FLEXXUS_CONDICION_IVA / FLEXXUS_CLASE_PROVEEDOR en Railway (mirá "Probar conexión").');
  }
  return out;
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
  // Percepción de verdad: por el tipo que clasificó la IA, o si el texto lo dice.
  // Lo demás no exento (bonificaciones, redondeos, "otro") NO va a percepciones:
  // entra como línea de concepto libre para que el total cierre igual.
  const esPerc = o => o.tipo === 'percepcion' || /percep/i.test(String(o.concepto || ''));
  const percepciones = otros.filter(o => !o.exento && esPerc(o) && (Number(o.monto) || 0) !== 0);
  const otrosLibres  = otros.filter(o => !o.exento && !esPerc(o) && (Number(o.monto) || 0) !== 0);
  const exento = otros.filter(o => o.exento).reduce((s, o) => s + (Number(o.monto) || 0), 0);
  const totPerc  = percepciones.reduce((s, o) => s + (Number(o.monto) || 0), 0);
  const totOtros = otrosLibres.reduce((s, o) => s + (Number(o.monto) || 0), 0);

  if (percepciones.length && !process.env.FLEXXUS_CODIGO_PERCEPCION) {
    // Sin fallback configurado igual intentamos mapear por tipo (ver abajo);
    // solo falla si alguna percepción no matchea ningún tipo conocido.
  }

  // Mapear cada percepción a su código de Flexxus según el texto del concepto.
  // Códigos reales de la instalación EcoService: PER IVA / PER IIBB / PER SUSS / PER GAN.
  // Fallback: FLEXXUS_CODIGO_PERCEPCION (env). Si no hay match ni fallback → error claro.
  const codigoPercepcion = (concepto) => {
    const t = String(concepto || '').toLowerCase();
    if (/suss|seguridad social/.test(t)) return 'PER SUSS';
    if (/iibb|ingresos brutos|ing\.?\s*brutos|rentas/.test(t)) return 'PER IIBB';
    if (/ganancia/.test(t)) return 'PER GAN';
    if (/iva/.test(t)) return 'PER IVA';
    return process.env.FLEXXUS_CODIGO_PERCEPCION || null;
  };
  for (const o of percepciones) {
    if (!codigoPercepcion(o.concepto)) {
      throw new Error(`No sé a qué código de percepción de Flexxus mapear "${o.concepto}". ` +
        'Configurá FLEXXUS_CODIGO_PERCEPCION en Railway como fallback, o corregí el concepto en la factura.');
    }
  }

  // Proveedor: si existe por CUIT, mandamos SOLO su código (así Flexxus no pisa
  // sus datos); si no existe, mandamos lo mínimo y Flexxus lo crea.
  const provExistente = await buscarProveedorPorCuit(f.cuit, f.proveedor);
  let proveedor;
  if (provExistente) {
    proveedor = { codigoproveedor: provExistente.codigoproveedor };
  } else {
    // Alta: el schema exige codigoproveedor + direccion + telefono + condición
    // IVA + clase + provincia + localidad. Los códigos salen de un proveedor
    // existente (plantilla) para garantizar valores válidos de SU instalación;
    // se pueden pisar con envs FLEXXUS_CONDICION_IVA / FLEXXUS_CLASE_PROVEEDOR.
    const alta = await datosAltaProveedor();
    const razon = String(f.proveedor || '').trim() || ('PROVEEDOR ' + (cuitLimpio(f.cuit) || 'S/D'));
    proveedor = {
      codigoproveedor: (cuitLimpio(f.cuit) || ('ECO' + String(Date.now()).slice(-8))).slice(0, 15),
      razonsocial: razon.slice(0, 50),
      direccion: (String(f.direccion || '').trim() || 'S/D').slice(0, 50),
      telefono: (String(f.telefono || '').trim() || '0').slice(0, 50),
      cuit: cuitLimpio(f.cuit) || undefined,
      ingresosbrutos: cuitLimpio(f.cuit) || '0',
      codigocondicioniva: String(alta.codigocondicioniva),
      codigoclaseproveedor: String(alta.codigoclaseproveedor),
      codigoprovincia: String(alta.codigoprovincia),
      codigolocalidad: String(alta.codigolocalidad),
    };
    // Guarda de seguridad: si algún requerido quedó vacío, no mandamos basura
    const faltan = ['codigoproveedor', 'razonsocial', 'direccion', 'telefono', 'codigocondicioniva', 'codigoclaseproveedor', 'codigoprovincia', 'codigolocalidad']
      .filter(k => proveedor[k] == null || proveedor[k] === '');
    if (faltan.length) {
      throw new Error('No puedo dar de alta el proveedor: faltan ' + faltan.join(', ') +
        '. Datos que resolví: ' + JSON.stringify(alta) + '. Cargá el proveedor manualmente en Flexxus o configurá las envs FLEXXUS_CONDICION_IVA / FLEXXUS_CLASE_PROVEEDOR.');
    }
  }

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
  // Bonificaciones y otros conceptos no-percepción: líneas de concepto libre
  otrosLibres.forEach(o => productos.push({
    codigoarticulo: '*',
    descripcion: String(o.concepto || 'Otro concepto').slice(0, 200),
    cantidad: 1,
    preciototal: Math.round((Number(o.monto) || 0) * 100) / 100,
  }));

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
    total: Math.round((neto + iva + totPerc + totOtros + exento) * 100) / 100,
  };
  if (iva > 0) {
    body.calculaiva = true;
    body.iva = [{ monto: Math.round(iva * 100) / 100, porcentaje: 21 }];
  }
  if (percepciones.length) {
    body.percepciones = percepciones.map(o => ({
      codigopercepcion: codigoPercepcion(o.concepto),
      monto: Math.round((Number(o.monto) || 0) * 100) / 100,
    }));
  }

  const resp = await flx('/comprobantescompras', { method: 'POST', body: JSON.stringify(body) }).catch(e => {
    // Adjuntamos qué proveedor se mandó, para diagnosticar rechazos del alta
    e.message = e.message + '\n\n[proveedor enviado: ' + JSON.stringify(proveedor) + ']';
    throw e;
  });
  console.log(`[flexxus] factura ${f.numero_factura} imputada (${body.tipocomprobante} ${body.numerocomprobante}, prov ${provExistente ? provExistente.codigoproveedor : 'NUEVO'})`);
  return {
    ok: true,
    tipocomprobante: body.tipocomprobante,
    numerocomprobante: body.numerocomprobante,
    proveedor_codigo: provExistente ? provExistente.codigoproveedor : null,
    proveedor_nombre: provExistente ? provExistente.razonsocial : null,
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
  out.clases_proveedor = await trae('/clasesproveedores', x => ({ codigo: x.codigoclaseproveedor, descripcion: x.descripcion }));
  out.condiciones_iva = await trae('/tiposivacompras', x => ({ codigo: x.codigotipo, descripcion: x.descripcion }));
  // Códigos que usaría el alta de un proveedor nuevo (misma lógica que imputar)
  try {
    _plantillaProv = null;
    out.alta_proveedor_usaria = await datosAltaProveedor();
  } catch (e) { out.alta_proveedor_usaria = { error: e.message }; }
  out.config = {
    FLEXXUS_CODIGO_USUARIO: process.env.FLEXXUS_CODIGO_USUARIO || process.env.FLEXXUS_USER || '(falta)',
    FLEXXUS_MULTIPLAZO: process.env.FLEXXUS_MULTIPLAZO || '(falta)',
    FLEXXUS_DEPOSITO: process.env.FLEXXUS_DEPOSITO || '(falta)',
    FLEXXUS_CODIGO_PERCEPCION: process.env.FLEXXUS_CODIGO_PERCEPCION || '(falta — solo necesario si hay percepciones)',
  };
  return out;
}

module.exports = { imputarFactura, probarConexion, buscarProveedorPorCuit };
