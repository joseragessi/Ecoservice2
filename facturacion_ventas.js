// Facturación de ventas por Flexxus — lógica pura, sin base ni red.
//
// Circuito (pedido de José, 28-sep): la planilla de incrementos → revisar →
// generar las facturas en Flexxus (POST /ordenmanual) → pedir el CAE
// (POST /facturacionelectronica) → mandar el PDF por mail (el propio Flexxus
// lo envía con GET /ventas/{tipo}/{nro}/pdf?email=).
//
// Todo lo que decide importes y textos está acá para poder probarlo: una
// factura mal armada sale con CAE ante ARCA y solo se arregla con nota de
// crédito.

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

/** Una celda de encabezado de mes → 'YYYY-MM', o null.
 *  La planilla trae "jul-26", "sept-26", fechas de Excel (número) o Date. */
function mesDeCelda(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`;
  if (typeof v === 'number' && v > 40000 && v < 60000) {        // serial de Excel
    const d = new Date(Math.round((v - 25569) * 86400000));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const m = norm(v).match(/^([a-z]{3,4})\w*\s*(\d{2,4})$/);
  if (!m) return null;
  const ix = MESES.indexOf(m[1].slice(0, 3));
  if (ix < 0) return null;
  const anio = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return `${anio}-${String(ix + 1).padStart(2, '0')}`;
}

/** Un número de celda, aceptando "$ 19.742.301,1" o 19742301.1. */
function numero(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).replace(/[^\d,.-]/g, '');
  if (!s) return NaN;
  // Formato argentino: puntos de miles, coma decimal.
  if (/,\d{1,2}$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  return Number(s.replace(/,/g, ''));
}

/**
 * Lee la planilla de incrementos (como matriz de filas, la que devuelve
 * SheetJS con header:1) y devuelve, por cliente, el importe del mes pedido.
 *
 * Cómo está armada: cada cliente es un bloque. La fila de encabezado tiene el
 * nombre a la izquierda y los meses a la derecha. Abajo vienen Mano de Obra,
 * Insumos, a veces Descuento, y el TOTAL (la fila en negrita, sin etiqueta).
 * El total es el número más grande de la columna del mes dentro del bloque:
 * mano de obra, insumos y descuento siempre son menores.
 */
function leerPlanilla(filas, periodo) {
  const out = [];
  const rows = (filas || []).map(f => Array.isArray(f) ? f : []);
  for (let i = 0; i < rows.length; i++) {
    const fila = rows[i];
    // ¿Es un encabezado de bloque? Tiene al menos dos meses reconocibles.
    const colsMes = fila.map((v, j) => [j, mesDeCelda(v)]).filter(([, m]) => m);
    if (colsMes.length < 2) continue;
    const col = (colsMes.find(([, m]) => m === periodo) || [])[0];
    // El nombre: la primera celda de texto de la fila que no sea un mes.
    const nombre = fila.slice(0, colsMes[0][0]).map(v => String(v == null ? '' : v).trim())
      .filter(v => v && !mesDeCelda(v)).pop() || '';
    if (!nombre) continue;
    if (col == null) { out.push({ nombre, importe: null, detalle: [], aviso: 'el mes no está en la planilla' }); continue; }
    // El bloque sigue hasta el próximo encabezado.
    let fin = i + 1;
    while (fin < rows.length && rows[fin].filter(v => mesDeCelda(v)).length < 2) fin++;
    const detalle = [];
    let mayor = null;
    for (let k = i + 1; k < fin; k++) {
      const n = numero(rows[k][col]);
      if (!isFinite(n) || n < 1) continue;             // porcentajes (0,021) y vacíos afuera
      // La etiqueta es la celda de TEXTO de la izquierda, no los importes de
      // los meses anteriores.
      const etiqueta = rows[k].slice(0, col).filter(v => typeof v === 'string' && /[a-záéíóúñ]/i.test(v))
        .map(v => v.trim()).shift() || '';
      detalle.push({ etiqueta, importe: r2(n) });
      if (mayor == null || n > mayor) mayor = n;
    }
    out.push({ nombre, importe: mayor == null ? null : r2(mayor), detalle,
      aviso: mayor == null ? 'no encontré el importe del mes' : null });
    i = fin - 1;
  }
  return out;
}

/** Busca el cliente configurado que corresponde a un nombre de la planilla. */
function reconocerCliente(nombrePlanilla, clientes) {
  const n = norm(nombrePlanilla);
  if (!n) return null;
  const lista = (clientes || []).filter(c => c.activo !== false);
  // 1) Alias exacto (lo que José cargó como "cómo aparece en el Excel").
  let c = lista.find(x => x.alias_planilla && norm(x.alias_planilla) === n);
  if (c) return c;
  // 2) Nombre exacto.
  c = lista.find(x => norm(x.nombre) === n);
  if (c) return c;
  // 3) Uno contiene al otro ("4 HOJAS" dentro de "ASOCIACION CIVIL CUATRO HOJAS" no,
  //    pero "PRITTY" dentro de "PRITTY SA" sí).
  const cands = lista.filter(x => {
    const a = norm(x.alias_planilla || ''), b = norm(x.nombre);
    return (a && (a.includes(n) || n.includes(a))) || b.includes(n) || n.includes(b);
  });
  return cands.length === 1 ? cands[0] : null;       // ambiguo → no adivina
}

/** El texto del renglón, a partir de la plantilla del concepto. */
function textoConcepto(plantilla, periodo, cantidad) {
  const [anio, mes] = String(periodo || '').split('-');
  return String(plantilla || '')
    .replace(/\{mes\}/gi, mes || '')
    .replace(/\{anio\}|\{año\}/gi, anio || '')
    .replace(/\{cantidad\}/gi, cantidad != null ? String(cantidad) : '')
    .replace(/\s+/g, ' ').trim()
    .toUpperCase();
}

/** Neto → IVA y total, redondeados como los calcula Flexxus. */
function calcularIva(neto, porcentaje) {
  const n = r2(neto);
  const iva = r2(n * (Number(porcentaje) || 0) / 100);
  return { neto: n, iva, total: r2(n + iva) };
}

/**
 * Hasta dónde se puede retroceder la fecha. ARCA admite servicios hasta 10
 * días antes de la fecha de emisión, y es la regla que dio Administración.
 */
function validarFecha(fecha, hoy) {
  const h = hoy ? new Date(hoy) : new Date();
  const f = new Date(String(fecha) + 'T12:00:00');
  if (isNaN(f)) return 'Fecha inválida';
  const d = Math.round((new Date(h.toISOString().slice(0, 10) + 'T12:00:00') - f) / 86400000);
  if (d < 0) return 'La fecha no puede ser futura';
  if (d > 10) return 'La fecha no puede ser de más de 10 días atrás';
  return null;
}

/**
 * Factura A o B según la condición de IVA del cliente en Flexxus.
 * A: responsable inscripto. B: consumidor final, exento, monotributo, no
 * categorizado. Si no se reconoce, null: que lo elija una persona.
 */
function tipoPorCondicionIva(cond) {
  const c = norm(cond);
  if (!c) return null;
  if (/^ri$|inscrip/.test(c)) return 'FA';
  if (/^(cf|ex|mt|m|nc)$|consumidor|exent|monotrib|no categ|no resp/.test(c)) return 'FB';
  return null;
}

/**
 * PASO 1 · Armar (29-sep). Una fila por concepto de cada cliente; cada fila es
 * UNA factura. El importe sale según el modo del concepto:
 *   planilla → de la planilla de incrementos (si el cliente está)
 *   cantidad → cantidad × precio unitario (bateas; los dos se pueden editar)
 *   fijo     → el importe fijo guardado (el del último mes)
 * Los clientes con el concepto único viejo (sin lista) se tratan como
 * "planilla", para no romper lo que ya estaba cargado.
 */
function armarFilas({ clientes, clienteConceptos, conceptos, leidos, periodo }) {
  const activos = (clientes || []).filter(c => c.activo !== false && c.codigo_cliente);
  const porPlanilla = {};                 // cliente_id → importe de la planilla
  const sinCliente = [];
  (leidos || []).forEach(l => {
    const cli = reconocerCliente(l.nombre, activos);
    if (cli) porPlanilla[cli.id] = l;
    else sinCliente.push(l);
  });
  const filas = [];
  activos.forEach(cli => {
    let lista = (clienteConceptos || []).filter(x => x.cliente_id === cli.id && x.activo !== false)
      .sort((a, b) => (a.orden || 0) - (b.orden || 0));
    if (!lista.length && cli.concepto_id) lista = [{ id: null, concepto_id: cli.concepto_id, modo: 'planilla' }];
    lista.forEach(cc => {
      const conc = (conceptos || []).find(k => k.id === cc.concepto_id);
      if (!conc || conc.activo === false) return;
      let cantidad = 1, precio = null, neto = null, origen = cc.modo, aviso = null;
      if (cc.modo === 'cantidad') {
        precio = cc.precio_unitario != null ? r2(cc.precio_unitario) : null;
        cantidad = 0;                                   // la cantidad del mes la pone quien factura
        neto = 0;
        if (precio == null) aviso = 'sin precio unitario';
      } else if (cc.modo === 'fijo') {
        neto = cc.importe_fijo != null ? r2(cc.importe_fijo) : null;
        if (neto == null) aviso = 'sin importe';
      } else {
        const l = porPlanilla[cli.id];
        neto = l && l.importe != null ? l.importe : null;
        if (neto == null) aviso = l ? (l.aviso || 'sin importe en la planilla') : 'no está en la planilla';
      }
      const problemas = problemasCliente(cli, conc, cc.codigo_articulo);
      filas.push({
        cliente_id: cli.id, cliente: cli.nombre, tipo: cli.tipo_comprobante, iva_pct: Number(cli.porcentaje_iva) || 0,
        email: cli.email || null, cliente_concepto_id: cc.id || null, concepto_id: conc.id, concepto: conc.nombre,
        codigo_articulo: cc.codigo_articulo || null, articulo_particular: cc.articulo_particular || null,
        plantilla: conc.plantilla, modo: cc.modo, origen, cantidad, precio_unitario: precio, neto,
        precio_habitual: cc.modo === 'cantidad' ? precio : null,     // para avisar si se cambia
        descripcion: textoConcepto(conc.plantilla, periodo, cc.modo === 'cantidad' ? cantidad : 1),
        // Tildada por defecto solo si tiene todo y un importe > 0.
        sel: !problemas.length && !aviso && Number(neto) > 0,
        aviso, problemas,
      });
    });
  });
  return { filas, sinCliente };
}

/** El neto de una fila según su modo (cantidad × precio o el importe cargado). */
function netoDeFila(f) {
  if (f.modo === 'cantidad') return r2((Number(f.cantidad) || 0) * (Number(f.precio_unitario) || 0));
  return r2(f.neto);
}

/**
 * Número de factura ESTIMADO para la vista previa. Flexxus lo asigna al crear
 * y la API no tiene cómo pedirlo antes: se parte del último que conocemos por
 * tipo (A y B numeran aparte) y se suma de a uno. Es aproximado.
 */
function numerosEstimados(items, ultimos) {
  const sig = { ...(ultimos || {}) };
  return (items || []).map(it => {
    const t = it.tipo_comprobante || it.tipo;
    if (sig[t] == null) return null;
    sig[t] = Number(sig[t]) + 1;
    return sig[t];
  });
}

/**
 * El bloque "cliente" que exige /ordenmanual (29-sep): Flexxus rechaza la
 * factura si falta razón social, dirección, provincia, localidad, teléfono,
 * condición de IVA o zona. Sale de la ficha del cliente en Flexxus.
 * Los campos obligatorios vacíos van con "-" (Flexxus pide que no estén
 * vacíos, no que tengan un valor en particular) y se recortan al largo máximo.
 */
function clienteParaFlexxus(f, cliente) {
  const d = f || {};
  const txt = (v, max, def) => { const x = String(v == null ? '' : v).trim(); return (x || def || '-').slice(0, max); };
  const prov = d.codigoprovincia ?? (d.provincia && d.provincia.codigoprovincia);
  const zona = d.codigozona ?? (d.zona && d.zona.codigozona);
  const loc = d.codigolocalidad ?? (d.localidades && d.localidades.codigolocalidad) ?? (d.localidad && d.localidad.codigolocalidad);
  const o = {
    codigocliente: String(d.codigocliente || cliente.codigo_cliente),
    razonsocial: txt(d.razonsocial || cliente.nombre, 50),
    direccion: txt(d.direccion, 50),
    codigoprovincia: txt(prov, 15),
    // Flexxus la pide como TEXTO de hasta 15 caracteres ("753", no 753).
    codigolocalidad: loc != null && loc !== '' ? String(loc).slice(0, 15) : undefined,
    telefono: txt(d.telefono || d.telefonolaboral || d.telefonoempresa1, 50),
    condicioniva: txt(d.condicioniva || cliente.condicion_iva, 15),
    codigozona: Number(zona) || 0,
    cuit: d.cuit || cliente.cuit || undefined,
    email: d.email || cliente.email || undefined,
    cp: d.cp || undefined,
    localidad: typeof d.localidad === 'string' ? d.localidad.slice(0, 50) : undefined,
    codigomultiplazo: cliente.codigo_multiplazo != null ? Number(cliente.codigo_multiplazo) : (d.codigomultiplazo ?? undefined),
    cuentacorriente: true,
  };
  Object.keys(o).forEach(k => o[k] === undefined && delete o[k]);
  return o;
}

/** Qué le falta a un cliente para poder facturarse.
 *  `articulo` = código INTERNO del artículo de Flexxus de ESE cliente (29-sep):
 *  en Flexxus cada cliente tiene el suyo (FADEA 000001, AYRES M 000015…). El
 *  del concepto ya no vale: por él salió la factura de AYRES como FADEA. */
function problemasCliente(c, concepto, articulo) {
  const p = [];
  if (!c) return ['no está configurado'];
  if (!c.codigo_cliente) p.push('sin código de cliente de Flexxus');
  if (!['FA', 'FB'].includes(c.tipo_comprobante)) p.push('sin tipo de factura');
  // Cuenta corriente exige una condición de venta válida: 0 o vacío Flexxus
  // lo rechaza ("el multiplazo no existe o no está habilitado", 29-sep).
  if (!(Number(c.codigo_multiplazo) > 0)) p.push('sin condición de venta');
  if (!concepto) p.push('sin concepto');
  else if (!articulo) p.push('sin artículo de Flexxus (Clientes → Editar → paso 4)');
  return p;
}

/**
 * El cuerpo para POST /ordenmanual.
 * `cfg` trae lo que depende de la instalación y todavía hay que confirmar en
 * prueba: punto de venta, usuario, depósito, vendedor.
 */
function armarComprobante(item, cliente, concepto, fecha, cfg) {
  const c = cfg || {};
  const { neto, total } = calcularIva(item.neto, cliente.porcentaje_iva);
  const cant = Number(item.cantidad) || 1;
  // Con precio unitario cargado (bateas) va ese; si no, el neto repartido.
  const unit = item.precio_unitario != null && Number(item.precio_unitario) > 0 ? r2(item.precio_unitario) : r2(neto / cant);
  return {
    carrito: {
      numeracionpuntoventa: Number(c.puntoVenta) || 3,
      tipocomprobante: cliente.tipo_comprobante,
      numerocomprobante: 0,                          // lo asigna Flexxus
      total,
      codigousuario: c.usuario || '',
      codigovendedor: cliente.codigo_vendedor || c.vendedor || undefined,
      descuentoporcentaje: 0,
      codigodeposito: c.deposito || '001',
      clasecomprobante: cliente.clase_comprobante === 0 ? 0 : 2,   // 2 servicios · 0 bienes de cambio
      tipofactura: 1,                                // cuenta corriente
      validacuentacorriente: false,
      calculaiva: true,
      fechacomprobante: fecha,
      codigomultiplazo: cliente.codigo_multiplazo != null ? Number(cliente.codigo_multiplazo) : undefined,
      cliente: { codigocliente: cliente.codigo_cliente },
      productos: [{
        codigoarticulo: item.codigo_articulo,          // el del cliente (fact_cliente_conceptos), nunca el del concepto
        cantidad: cant,
        preciounitario: unit,
        preciototal: neto,
        descuento: 0,
        producto_descripcion: {
          sobrescribir_descripcion: 1,
          descripciones: [{ descripcion: item.descripcion }],
        },
      }],
    },
  };
}

/* ── Facturar clonando el mes anterior (29-sep, mockup_clonar_mes v2) ──
   Una fila por concepto de cada cliente activo (cada una es una factura
   distinta: CAÑUELAS mantenimiento, lotes y bateas van separadas). Trae lo
   que se facturó el mes anterior; el aumento lo calcula el navegador:
   aumento del mes (paritaria) × % de mano de obra del concepto. */
function mesAnterior(periodo) {
  const [a, m] = String(periodo).split('-').map(Number);
  const d = new Date(a, m - 2, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function armarClon({ clientes, clienteConceptos, conceptos, itemsPrev, itemsDest, periodo }) {
  const activos = (clientes || []).filter(c => c.activo !== false && c.codigo_cliente);
  const vivos = x => !['anular'].includes(x.estado);
  const prev = (itemsPrev || []).filter(vivos), dest = (itemsDest || []).filter(vivos);
  const filas = [];
  activos.forEach(cli => {
    let lista = (clienteConceptos || []).filter(x => x.cliente_id === cli.id && x.activo !== false)
      .sort((a, b) => (a.orden || 0) - (b.orden || 0));
    lista.forEach(cc => {
      const conc = (conceptos || []).find(k => k.id === cc.concepto_id);
      if (!conc || conc.activo === false) return;
      const deEste = x => x.cliente_id === cli.id && (x.cliente_concepto_id ? x.cliente_concepto_id === cc.id : x.concepto_id === cc.concepto_id);
      const ant = prev.filter(deEste).pop() || null;
      const ya = dest.filter(deEste).length;
      const problemas = problemasCliente(cli, conc, cc.codigo_articulo);
      const esCant = cc.modo === 'cantidad';
      filas.push({
        cliente_id: cli.id, cliente: cli.nombre, tipo: cli.tipo_comprobante, iva_pct: Number(cli.porcentaje_iva) || 0,
        cliente_concepto_id: cc.id, concepto_id: conc.id, concepto: conc.nombre, plantilla: conc.plantilla, modo: cc.modo || 'planilla',
        pct_mano_obra: cc.pct_mano_obra != null ? Number(cc.pct_mano_obra) : null,
        prev_neto: ant ? Number(ant.neto) : null,
        prev_cantidad: ant ? Number(ant.cantidad) || 1 : null,
        // Bateas: el precio por viaje es lo que sube; si no hubo mes anterior, el habitual del cliente.
        prev_precio: esCant ? (ant && ant.precio_unitario != null ? Number(ant.precio_unitario) : (cc.precio_unitario != null ? Number(cc.precio_unitario) : null)) : null,
        ya_facturada: ya, problemas,
        sel: !problemas.length && !ya && !!ant,
      });
    });
  });
  return filas;
}

module.exports = { MESES, mesAnterior, armarClon, norm, mesDeCelda, numero, leerPlanilla, reconocerCliente,
  textoConcepto, calcularIva, validarFecha, problemasCliente, armarComprobante, tipoPorCondicionIva,
  armarFilas, netoDeFila, numerosEstimados, clienteParaFlexxus };
