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

// Número de comprobante para Flexxus: PV-NUMERO → pv*1e8 + numero (así lo
// muestra Flexxus como 00002-00006696). Si no hay número parseable devuelve
// null: NUNCA se inventa un número.
function numeroFlexxus(nf) {
  const s = String(nf || '').trim();
  const m = s.match(/(\d{1,5})\s*-\s*(\d{1,8})\s*$/);
  if (m) return Number(m[1]) * 1e8 + Number(m[2]);
  const d = s.replace(/\D/g, '');
  if (d.length >= 3 && d.length <= 13) return Number(d);
  return null;
}
function formatearNumeroFlexxus(n) {
  if (n == null) return null;
  const pv = Math.floor(n / 1e8), num = n % 1e8;
  return String(pv).padStart(5, '0') + '-' + String(num).padStart(8, '0');
}

// Normaliza razón social para comparar: sin tipo societario ni puntuación.
function razonNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(s\.?\s*a\.?\s*s?|s\.?\s*r\.?\s*l|s\.?\s*a|sociedad an[oó]nima|srl|sas|sa)\b\.?/g, '')
    .replace(/[^a-z0-9ñ]/g, '');
}

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
  // 2) Respaldo por razón social NORMALIZADA (sin S.A./S.A.S./SRL ni puntuación),
  // útil si el CUIT vino mal leído del comprobante y el nombre se corrigió a mano.
  if (razonSocial) {
    try {
      const d = await flx('/proveedores?razonsocial=' + encodeURIComponent(razonSocial.trim()));
      const lista = Array.isArray(d.data || d) ? (d.data || d) : [];
      const rn = razonNorm(razonSocial);
      const match = lista.find(p => razonNorm(p.razonsocial) === rn)
        || (lista.length === 1 && rn && (razonNorm(lista[0].razonsocial).includes(rn) || rn.includes(razonNorm(lista[0].razonsocial))) ? lista[0] : null);
      if (match) return match;
    } catch (e) { /* sin match por nombre */ }
  }
  return null;
}

// Verificación previa a imputar: a qué proveedor de Flexxus iría esta factura
// y con qué número de comprobante — sin crear ni imputar nada.
async function verificarImputacion(f, letra) {
  const provExistente = await buscarProveedorPorCuit(f.cuit, f.proveedor);
  if (!provExistente && !opts.permitirAlta) {
    const e = new Error('No existe en Flexxus un proveedor con CUIT ' + (f.cuit || 's/d') +
      " ni razón social parecida a '" + (f.proveedor || 's/d') + "'.");
    e.code = 'PROV_NO_EXISTE';
    throw e;
  }
  const num = numeroFlexxus(f.numero_factura);
  return {
    tipocomprobante: 'F' + (letra || 'A'),
    numero: num,
    numero_formateado: formatearNumeroFlexxus(num),
    proveedor: provExistente ? {
      codigo: provExistente.codigoproveedor,
      razonsocial: provExistente.razonsocial,
      cuit: provExistente.cuit || null,
    } : null,
  };
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
async function imputarFactura(f, letra, opts = {}) {
  // El número tiene que ser real: sin número parseable no se imputa nada.
  const numComp = numeroFlexxus(f.numero_factura);
  if (numComp == null) {
    const e = new Error('La factura no tiene un número válido (formato PV-NUMERO, ej 0002-00006696). Corregilo en el editor antes de imputar.');
    e.code = 'NUMERO_INVALIDO';
    throw e;
  }
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
    // Flexxus revalida el objeto proveedor completo aunque exista, así que
    // reenviamos SUS PROPIOS datos (los del GET) tal cual, solo garantizando
    // que los requeridos no vayan vacíos. No inventamos nada del proveedor.
    const p = provExistente;
    proveedor = {
      codigoproveedor: String(p.codigoproveedor),
      razonsocial: String(p.razonsocial || f.proveedor || 'PROVEEDOR').slice(0, 50),
      direccion: (String(p.direccion || '').trim() || 'S/D').slice(0, 50),
      telefono: (String(p.telefono || '').trim() || '0').slice(0, 50),
      cuit: cuitLimpio(p.cuit || f.cuit) || undefined,
      ingresosbrutos: String(p.ingresosbrutos || cuitLimpio(p.cuit) || '0'),
      codigocondicioniva: String(p.condicioniva || codDe(p, 'tipoivacompra.codigotipo') || ''),
      codigoclaseproveedor: String(p.codigoclaseproveedor || ''),
      codigoprovincia: String(p.codigoprovincia || codDe(p, 'provincia.codigoprovincia') || ''),
      codigolocalidad: String(p.codigolocalidad || codDe(p, 'localidades.codigolocalidad') || ''),
    };
    // Si al proveedor existente le faltara algún requerido, lo completamos con
    // la plantilla/tablas (mismo mecanismo que el alta), sin inventar.
    const faltan0 = ['codigocondicioniva', 'codigoclaseproveedor', 'codigoprovincia', 'codigolocalidad']
      .filter(k => !proveedor[k]);
    if (faltan0.length) {
      const alta = await datosAltaProveedor();
      for (const k of faltan0) proveedor[k] = String(alta[k]);
    }
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

  // Multiplazo: si el proveedor tiene condición de pago fija, hay que usar la
  // suya (Flexxus la exige). El código real está en el objeto multiplazo anidado
  // (multiplazo.codigomultiplazo). El listado no siempre lo expande, así que si
  // el proveedor tiene multiplazofijo consultamos su detalle individual.
  let multiplazo = Number(process.env.FLEXXUS_MULTIPLAZO);
  let multiplazoOrigen = 'default env';
  if (provExistente) {
    const tieneFijo = provExistente.multiplazofijo === true || Number(provExistente.multiplazofijo) === 1;
    let cod = codDe(provExistente, 'multiplazo.codigomultiplazo', 'codigomultiplazo');
    // Si tiene fijo pero el listado no trajo el código, pedir el detalle
    if (tieneFijo && (cod == null || Number(cod) <= 0)) {
      try {
        const d = await flx('/proveedores/' + encodeURIComponent(provExistente.codigoproveedor));
        const det = (d.data && (Array.isArray(d.data) ? d.data[0] : d.data)) || d;
        cod = codDe(det, 'multiplazo.codigomultiplazo', 'codigomultiplazo') || cod;
        if (det && det.plazopordefecto != null && (cod == null || Number(cod) <= 0)) cod = det.plazopordefecto;
      } catch (e) { /* sin detalle */ }
    }
    if (cod != null && Number(cod) > 0) { multiplazo = Number(cod); multiplazoOrigen = tieneFijo ? 'proveedor (fijo)' : 'proveedor'; }
    else if (Number(provExistente.plazopordefecto) > 0) { multiplazo = Number(provExistente.plazopordefecto); multiplazoOrigen = 'proveedor.plazopordefecto'; }
  }

  const body = {
    tipocomprobante: 'F' + (letra || 'A'),
    numerocomprobante: numComp,
    fechacomprobante: fecha,
    fechaimputable: fecha,
    fechavencimiento: venc,
    codigousuario: process.env.FLEXXUS_CODIGO_USUARIO || process.env.FLEXXUS_USER,
    codigomultiplazo: multiplazo,
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
    e.message = e.message + '\n\n[proveedor enviado: ' + JSON.stringify(proveedor) + ']' +
      '\n[multiplazo enviado: ' + multiplazo + ' (origen: ' + multiplazoOrigen + ')]' +
      (provExistente ? '\n[proveedor tiene: multiplazo=' + JSON.stringify(provExistente.multiplazo) +
        ', codigomultiplazo=' + provExistente.codigomultiplazo +
        ', multiplazofijo=' + provExistente.multiplazofijo + ', plazopordefecto=' + provExistente.plazopordefecto + ']' : '');
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

// ── Apropiación de centro de costo sobre el asiento del comprobante ──
// Usa la imputación que la factura YA tiene cargada en el panel (por ítem o
// total): nadie carga porcentajes — salen solos del peso de cada ítem.
// Best-effort: si algo falla, la factura queda imputada igual y el motivo
// se guarda para reintentarlo o resolverlo a mano.
async function apropiarCentroCosto(f, resPost, objetivos) {
  // 1) Reparto por objetivo desde lo ya imputado
  const pesos = {};
  if (f.assignmentMode === 'per-item' && f.assignments && Object.keys(f.assignments).length) {
    const items = f.items || [];
    for (const [ix, a] of Object.entries(f.assignments)) {
      const obj = a && a.objetivo; if (!obj) continue;
      const peso = Math.abs(Number((items[+ix] || {}).monto_sin_iva)) || 1;
      pesos[obj] = (pesos[obj] || 0) + peso;
    }
  } else if (f.totalAssign && f.totalAssign.objetivo) {
    pesos[f.totalAssign.objetivo] = 1;
  }
  // El asiento se extrae primero: aunque el mapeo falle, queda guardado
  // para poder reintentar la apropiación sin reimputar.
  const raw0 = (resPost && (resPost.respuesta || resPost)) || {};
  const d0 = raw0.data || raw0;
  const asientoDetectado = d0.numeroasiento ?? d0.numeroAsiento ?? d0.asiento ?? null;
  const conAsiento = o => Object.assign(o, asientoDetectado != null ? { numeroasiento: asientoDetectado } : {});

  const nombres = Object.keys(pesos);
  if (!nombres.length) return conAsiento({ ok: false, motivo: 'La factura no tiene imputación por objetivo en el panel.' });

  // 2) nombre del objetivo → código de centro de costo (Maestros → Objetivos)
  const norm = s => String(s || '').trim().toLowerCase();
  const mapa = {};
  (objetivos || []).forEach(o => {
    if (o.codigo_flexxus) mapa[norm(o.nombre)] = String(o.codigo_flexxus).trim().replace(/^0+(?=\d)/, '');
  });
  const sinCodigo = nombres.filter(n => !mapa[norm(n)]);
  if (sinCodigo.length) {
    return conAsiento({ ok: false, motivo: 'Sin código de Flexxus en Maestros → Centros de costo: ' + sinCodigo.join(', ') });
  }

  // 3) Porcentajes proporcionales al neto, cerrando EXACTO en 100.00.
  // Método de mayor resto sobre centésimas (enteros) para no arrastrar
  // errores de redondeo con 3+ objetivos: Flexxus exige suma === 100.
  const total = nombres.reduce((s, n) => s + pesos[n], 0) || 1;
  const centesimas = nombres.map(n => {
    const exacto = pesos[n] * 10000 / total;   // porcentaje ×100 (centésimas)
    const base = Math.floor(exacto);
    return { objetivo: n, codigocentrocosto: Number(mapa[norm(n)]), base, resto: exacto - base };
  });
  let sobran = 10000 - centesimas.reduce((s, c) => s + c.base, 0);   // centésimas a repartir
  centesimas.sort((a, b) => b.resto - a.resto);
  for (let i = 0; i < centesimas.length && sobran > 0; i++, sobran--) centesimas[i].base++;
  const reparto = centesimas.map(c => ({
    objetivo: c.objetivo,
    codigocentrocosto: c.codigocentrocosto,
    porcentaje: c.base / 100,
  }));

  // 4) Asiento generado por el comprobante (viene en el response del POST)
  const raw = (resPost && (resPost.respuesta || resPost)) || {};
  const d = raw.data || raw;
  const numeroasiento = d.numeroasiento ?? d.numeroAsiento ?? d.asiento ?? null;
  if (numeroasiento == null) {
    return { ok: false, motivo: 'Flexxus no devolvió número de asiento. Respuesta: ' + JSON.stringify(d).slice(0, 300) };
  }
  let codigoejercicio = d.codigoejercicio ?? d.ejercicio ?? null;
  let codigoasiento = d.codigoasiento ?? null;

  // 5) Leer el asiento para conocer sus líneas (probando ejercicios si no vino)
  const anio = Number(String(f.fecha_factura || '').slice(0, 4)) || new Date().getFullYear();
  // El código de ejercicio de Flexxus puede no ser el año calendario: si está
  // fijado en Railway (FLEXXUS_CODIGO_EJERCICIO) ese manda.
  const ejEnv = process.env.FLEXXUS_CODIGO_EJERCICIO ? Number(process.env.FLEXXUS_CODIGO_EJERCICIO) : null;
  const candidatos = ejEnv != null ? [ejEnv]
    : codigoejercicio != null ? [codigoejercicio]
    : [anio, anio - 1, anio + 1];
  let asiento = null;
  const getErrores = [];
  for (const ej of candidatos) {
    try {
      const g = await flx('/apropiacioncentrocosto/' + numeroasiento + '/' + ej);
      asiento = g.data || g; codigoejercicio = ej; break;
    } catch (e) { getErrores.push('ejercicio ' + ej + ': ' + String(e.message || e).slice(0, 160)); }
  }
  const valor = reparto.map(r => ({ codigocentrocosto: r.codigocentrocosto, porcentaje: r.porcentaje }));
  if (codigoejercicio == null) codigoejercicio = ejEnv != null ? ejEnv : anio;
  const codUsuario = process.env.FLEXXUS_CODIGO_USUARIO || process.env.FLEXXUS_USER;
  const envAsiento = process.env.FLEXXUS_CODIGO_ASIENTO ? Number(process.env.FLEXXUS_CODIGO_ASIENTO) : null;

  // El GET del asiento devuelve directamente la LISTA de líneas:
  // [{linea, descripcion, codigoasiento, monto, utilizacentrocosto, esdebe,
  //   centrocosto: [{codigocentrocosto, centro, porcentaje, monto}, ...]}]
  const lineasAsiento = Array.isArray(asiento) ? asiento
    : (asiento && (asiento.apropiacion || asiento.lineas || asiento.detalle)) || null;

  if (Array.isArray(lineasAsiento) && lineasAsiento.length) {
    // Solo se apropian las líneas que usan centro de costo (la del gasto;
    // proveedores/IVA vienen con utilizacentrocosto=false).
    const apropiables = lineasAsiento.filter(l => l && l.utilizacentrocosto === true);
    if (!apropiables.length) {
      return conAsiento({ ok: false, motivo: 'Ninguna línea del asiento admite centro de costo. Líneas: ' +
        JSON.stringify(lineasAsiento.map(l => ({ linea: l.linea, desc: l.descripcion, usa_cc: l.utilizacentrocosto }))).slice(0, 300) });
    }
    // Un PUT por línea apropiable, cada una con SU codigoasiento (viene por línea).
    for (const l of apropiables) {
      const ca = l.codigoasiento ?? envAsiento;
      if (ca == null) {
        return conAsiento({ ok: false, motivo: 'La línea ' + (l.linea ?? '?') + ' (' + (l.descripcion || '') +
          ') no trae codigoasiento y no hay FLEXXUS_CODIGO_ASIENTO de respaldo.' });
      }
      const put = {
        numeroasiento, codigoejercicio, codigoasiento: Number(ca),
        codigousuario: codUsuario,
        apropiacion: [{ linea: l.linea ?? 1, valor }],
      };
      await flx('/apropiacioncentrocosto', { method: 'PUT', body: JSON.stringify(put) });
    }
  } else {
    // No se pudo leer el asiento: camino a ciegas, solo con la variable fijada.
    const ca = codigoasiento ?? envAsiento;
    if (ca == null) {
      return conAsiento({ ok: false, motivo: 'No pude leer el asiento para conocer sus líneas. ' +
        (getErrores.length ? 'Errores de lectura: ' + getErrores.join(' · ') : '') });
    }
    const put = { numeroasiento, codigoejercicio, codigoasiento: Number(ca),
      codigousuario: codUsuario, apropiacion: [{ linea: 1, valor }] };
    await flx('/apropiacioncentrocosto', { method: 'PUT', body: JSON.stringify(put) });
  }

  // Verificación REAL: releer el asiento y confirmar que cada centro del
  // reparto quedó con porcentaje > 0 en las líneas apropiables.
  let verificado = null;
  try {
    const g2 = await flx('/apropiacioncentrocosto/' + numeroasiento + '/' + codigoejercicio);
    const arr2 = Array.isArray(g2.data || g2) ? (g2.data || g2) : [];
    const apro2 = arr2.filter(l => l && l.utilizacentrocosto === true);
    if (apro2.length) {
      verificado = reparto.every(r => apro2.every(l =>
        (l.centrocosto || []).some(c => Number(c.codigocentrocosto) === r.codigocentrocosto && Number(c.porcentaje) > 0)));
    }
  } catch (e) { verificado = null; }
  console.log('[flexxus] centro de costo (asiento ' + numeroasiento + '/' + codigoejercicio +
    ', verificado=' + verificado + '): ' + reparto.map(r => r.objetivo + '=' + r.porcentaje + '%').join(', '));
  if (verificado === false) {
    return conAsiento({ ok: false, motivo: 'Flexxus aceptó la apropiación pero al releer el asiento los porcentajes NO quedaron aplicados. ' +
      'Asiento ' + numeroasiento + ', ejercicio ' + codigoejercicio + '. Avisame con este texto y lo miro.' });
  }
  return { ok: true, numeroasiento, codigoejercicio, reparto,
           verificado, get_diagnostico: getErrores.length ? getErrores : undefined };
}

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
  // ¿Cómo imputa esta instalación el centro de costo? Sondeamos las dos tablas:
  // si "centros de costo" tiene datos → apropiación contable (mecanismo B);
  // si "proyectos" tiene datos → gastos por proyecto por renglón (mecanismo A).
  out.centros_costo = await trae('/centrodecosto', x => ({ codigo: x.codigocentrocosto, descripcion: x.descripcion }));
  // Tipos de asiento y ejercicios: necesarios para la apropiación de centros
  // de costo (FLEXXUS_CODIGO_ASIENTO / FLEXXUS_CODIGO_EJERCICIO). El nombre de
  // la ruta varía entre instalaciones: se prueban candidatos hasta que alguna responda.
  const traePrimera = async (rutas, map) => {
    for (const ruta of rutas) {
      const r = await trae(ruta, map);
      if (Array.isArray(r) && r.length && !r[0].error) return r;
    }
    return [{ error: 'ninguna ruta respondió: ' + rutas.join(', ') }];
  };
  out.tipos_asiento = await traePrimera(
    ['/tiposasiento', '/tiposasientos', '/tipoasiento', '/contabilidad/tiposasiento', '/asientos/tipos'],
    x => ({ codigo: x.codigoasiento ?? x.codigotipoasiento ?? x.codigo, descripcion: x.descripcion ?? x.nombre }));
  out.ejercicios = await traePrimera(
    ['/ejercicios', '/ejercicio', '/contabilidad/ejercicios', '/codigoejercicio'],
    x => ({ codigo: x.codigoejercicio ?? x.codigo, descripcion: (x.descripcion ?? x.nombre ?? '') + (x.fechadesde ? ' (' + x.fechadesde + ' → ' + (x.fechahasta || '') + ')' : '') }));
  out.proyectos     = await trae('/compras/gastosporproyecto/proyectos', x => ({ codigo: x.codigoproyecto, descripcion: x.descripcion }));
  out.centro_costo_via = (Array.isArray(out.centros_costo) && out.centros_costo.length && !out.centros_costo[0].error)
    ? 'centros de costo (apropiación contable sobre el asiento)'
    : (Array.isArray(out.proyectos) && out.proyectos.length && !out.proyectos[0].error)
      ? 'gastos por proyecto (por renglón, en el mismo comprobante)'
      : 'no detectado — revisar con administración';
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

module.exports = { imputarFactura, verificarImputacion, apropiarCentroCosto, probarConexion, buscarProveedorPorCuit, formatearNumeroFlexxus };
