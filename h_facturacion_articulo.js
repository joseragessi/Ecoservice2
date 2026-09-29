// Harness 29-sep: artículo de Flexxus por cliente + control de punto de venta.
// Caso real: la FB de AYRES salió 0006-00001081 con artículo FADEA (000001).
const assert = require('assert'); const fs = require('fs');
const FV = require('./facturacion_ventas');
let ok = 0; const t = (n, f) => { f(); ok++; console.log('✓', n); };
const tAsync = async (n, f) => { await f(); ok++; console.log('✓', n); };

const cli = { id: 'c1', nombre: 'AYRES', codigo_cliente: '13', tipo_comprobante: 'FB', codigo_multiplazo: 6, porcentaje_iva: 21, clase_comprobante: 2 };
const conc = { id: 'k1', nombre: 'Mantenimiento espacio verde', plantilla: 'MANTENIMIENTO ESPACIO VERDE {mes} {anio}', codigo_articulo: '000001' };

t('sin artículo del cliente no se factura aunque el concepto tenga (el FADEA viejo)', () => {
  assert.deepStrictEqual(FV.problemasCliente(cli, conc, null), ['sin artículo de Flexxus (Clientes → Editar → paso 4)']);
  assert.deepStrictEqual(FV.problemasCliente(cli, conc, '000015'), []);
});
t('armarComprobante manda el artículo del item, no el del concepto', () => {
  const b = FV.armarComprobante({ neto: 1, cantidad: 1, descripcion: 'X', codigo_articulo: '000015' }, cli, conc, '2026-09-29', { puntoVenta: 3 });
  assert.strictEqual(b.carrito.productos[0].codigoarticulo, '000015');
  assert.strictEqual(b.carrito.numeracionpuntoventa, 3);
});
t('armarFilas usa el artículo del concepto DEL CLIENTE', () => {
  const base = { clientes: [cli], conceptos: [conc], periodo: '2026-09', leidos: [{ nombre: 'AYRES', importe: 100 }] };
  const sin = FV.armarFilas({ ...base, clienteConceptos: [{ id: 'cc1', cliente_id: 'c1', concepto_id: 'k1', modo: 'planilla' }] });
  assert.strictEqual(sin.filas[0].sel, false); assert.ok(sin.filas[0].problemas[0].includes('artículo'));
  const con = FV.armarFilas({ ...base, clienteConceptos: [{ id: 'cc1', cliente_id: 'c1', concepto_id: 'k1', modo: 'planilla', codigo_articulo: '000015', articulo_particular: 'AYRES M' }] });
  assert.strictEqual(con.filas[0].sel, true); assert.strictEqual(con.filas[0].codigo_articulo, '000015');
});

// ── panel_api: articuloDelItem / armarEnvio / crearConNumero con mocks ──
const api = fs.readFileSync('panel_api.js', 'utf8');
const src = api.slice(api.indexOf('async function articuloDelItem'), api.indexOf('}   // facturas por llamada')) + '}';
function mkSupa(tablas, updates) {
  return { from(tb) {
    const q = { _f: [], select() { return q; }, eq(k, v) { q._f.push(r => r[k] === v); return q; }, not() { return q; },
      gte(k, v) { q._f.push(r => Number(r[k]) >= v); return q; }, lt(k, v) { q._f.push(r => Number(r[k]) < v); return q; },
      order() { return q; }, limit(n) { q._n = n; return q; },
      update(v) { return { eq: (k, id) => { updates.push({ tb, v, id }); return Promise.resolve({}); } }; },
      then(res) { let d = (tablas[tb] || []).filter(r => q._f.every(f => f(r))); if (q._n) d = d.slice(0, q._n); res({ data: d }); } };
    return q; } };
}
function cargar(tablas, flx) {
  const updates = [];
  const supabase = mkSupa(tablas, updates);
  const cfgVentas = () => ({ puntoVenta: 3, usuario: '', deposito: '001' });
  const require = n => (n === './flexxus' ? flx : FV);
  const m = new Function('supabase', 'cfgVentas', 'FV', 'require', src + '\nreturn { articuloDelItem, armarEnvio, crearConNumero, puntoDeNumero };');
  return { ...m(supabase, cfgVentas, FV, require), updates };
}
const datos = { razonsocial: 'URBANIZACION', direccion: 'AV VALPARAISO 4300', codigoprovincia: '003', codigolocalidad: '1', codigozona: 1 };
const item = { id: 'i1', cliente_id: 'c1', concepto_id: 'k1', cliente_concepto_id: 'cc1', tipo_comprobante: 'FB', neto: 1, cantidad: 1, descripcion: 'MANT',
  fact_clientes: { ...cli, datos_flexxus: datos }, fact_conceptos: conc, fact_lotes: { fecha_comprobante: '2026-09-29' } };
const tablas = { fact_cliente_conceptos: [{ id: 'cc1', cliente_id: 'c1', concepto_id: 'k1', codigo_articulo: '000015', articulo_particular: 'AYRES M' }],
  fact_items: [{ tipo_comprobante: 'FB', numero_comprobante: 600001081 }] };
const flxBase = (resp, log) => ({ leerClienteVenta: async () => datos, numeroVentaUsado: () => log.push('usado'), numeroVentaOlvidar: () => log.push('olvidar'),
  proximoNumeroVenta: async (tipo, pv, piso) => { log.push(['piso', piso]); return 300001081; },
  crearFacturaVenta: async b => { log.push(['enviado', b]); return resp; } });

(async () => {
  await tAsync('item viejo sin foto → toma el artículo del cliente (AYRES M), nunca FADEA', async () => {
    const m = cargar(tablas, {}); const a = await m.articuloDelItem(item);
    assert.deepStrictEqual(a, { codigo: '000015', particular: 'AYRES M' });
  });
  await tAsync('ver envío: arma el cuerpo sin crear nada; el piso ignora la 0006-1081', async () => {
    const log = []; const m = cargar(tablas, flxBase({}, log));
    const r = await m.armarEnvio(item);
    assert.strictEqual(r.body.carrito.productos[0].codigoarticulo, '000015');
    assert.strictEqual(r.body.carrito.numerocomprobante, 300001081);
    assert.deepStrictEqual(log, [['piso', null]]);   // 600001081 no cuenta como piso del punto 3
  });
  await tAsync('Flexxus devuelve el mismo punto → ok, guarda respuesta + _enviado', async () => {
    const log = []; const m = cargar(tablas, flxBase({ numerocomprobante: 300001081, tipocomprobante: 'FB' }, log));
    const r = await m.crearConNumero(item);
    assert.strictEqual(r.nro, 300001081); assert.ok(r.d._enviado); assert.ok(log.includes('usado'));
    assert.ok(m.updates.some(u => u.v.codigo_articulo === '000015'));
  });
  await tAsync('Flexxus la crea en el punto 6 → queda "anular", frena, no se pide CAE', async () => {
    const log = []; const m = cargar(tablas, flxBase({ numerocomprobante: 600001081, tipocomprobante: 'FB' }, log));
    await assert.rejects(m.crearConNumero(item), e => !!(e.frenar && /0006/.test(e.message) && e.data._enviado));
    const u = m.updates.find(x => x.v.estado === 'anular'); assert.ok(u); assert.strictEqual(u.v.numero_comprobante, 600001081);
    assert.ok(log.includes('olvidar')); assert.ok(!log.includes('usado'));
  });
  await tAsync('cliente sin artículo → 422 antes de llamar a Flexxus', async () => {
    const log = []; const m = cargar({ ...tablas, fact_cliente_conceptos: [] }, flxBase({}, log));
    await assert.rejects(m.armarEnvio(item), e => e.status === 422 && /artículo/.test(e.message));
    assert.strictEqual(log.length, 0);
  });

  // ── flexxus.js: búsqueda por código particular primero ──
  const fx = fs.readFileSync('flexxus.js', 'utf8');
  const fsrc = fx.slice(fx.indexOf('async function buscarArticulosFlexxus'), fx.indexOf('/** La ficha completa del cliente'));
  const mk = flxV => new Function('flxV', 'ventasUrl', '_artCache', 'PROV_TTL', fsrc + '\nreturn buscarArticulosFlexxus;')(flxV, () => 'u', new Map(), 1);
  await tAsync('buscar "AYRES": primero los de código particular, sin duplicados', async () => {
    const f = mk(async url => url.includes('codigoparticular') ? { data: [{ codigoarticulo: '000015', codigoparticular: 'AYRES M', descripcion: 'MANTENIMIENTO' }] }
      : { data: [{ codigoarticulo: '00999', codigoparticular: '1', descripcion: 'MS 170 AYRES' }, { codigoarticulo: '000015', codigoparticular: 'AYRES M', descripcion: 'MANTENIMIENTO' }] });
    const r = await f('AYRES');
    assert.deepStrictEqual(r.map(x => x.codigo), ['000015', '00999']);
  });
  await tAsync('API vieja sin /articulos/search → prueba el filtro de /articulos', async () => {
    const urls = [];
    const f = mk(async url => { urls.push(url); if (url.includes('/search')) throw new Error('la ruta no existe'); return { data: [] }; });
    await f('OSDE'); assert.ok(urls.some(u => u.startsWith('/articulos?codigoparticular=OSDE')));
  });

  // ── panel.js: número y punto de venta en pantalla ──
  const pj = fs.readFileSync('panel.js', 'utf8');
  const psrc = pj.slice(pj.indexOf('function admPV()'), pj.indexOf('function admCondVta'));
  const P = new Function('escStk', 'admCfg', psrc + '\nreturn { admNro, admMalPunto, admArtItem };')(x => String(x), { cfg: { puntoVenta: 3 },
    clienteConceptos: [{ id: 'cc1', cliente_id: 'c1', concepto_id: 'k1', codigo_articulo: '000015', articulo_particular: 'AYRES M' }] });
  t('la 1081 se ve como 0006-00001081 y marcada para anular', () => {
    const x = { estado: 'generada', numero_comprobante: 600001081 };
    assert.ok(P.admNro(x).includes('0006-00001081')); assert.ok(P.admMalPunto(x));
    assert.ok(P.admNro({ numero_comprobante: 300001082 }).includes('0003-00001082'));
    assert.ok(!P.admMalPunto({ estado: 'generada', numero_comprobante: 300001082 }));
  });
  t('tarjeta: artículo del cliente para pendientes; ninguno inventado para las ya creadas', () => {
    assert.strictEqual(P.admArtItem({ cliente_id: 'c1', concepto_id: 'k1' }).particular, 'AYRES M');
    assert.strictEqual(P.admArtItem({ cliente_id: 'c1', concepto_id: 'k1', numero_comprobante: 600001081 }), null);
  });
  console.log(`\n${ok} OK`);
})().catch(e => { console.error('✗', e); process.exit(1); });
