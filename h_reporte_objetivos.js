// Harness de /api/combustible/reporte-objetivos (panel_api.js).
//
// Monta el router REAL con un Supabase simulado y pide el reporte. Cubre lo
// que va impreso en el PDF que se reparte por objetivo: que una carga
// repartida en tres objetivos ponga en cada hoja SOLO sus litros, que el
// importe se prorratee por litros, que los alias unifiquen nombres, y que un
// objetivo sin censo salga sin cruce en vez de con un porcentaje inventado.

process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'x';
process.env.SUPABASE_COMPRAS_URL = 'https://y.supabase.co';
process.env.SUPABASE_COMPRAS_KEY = 'x';
process.env.PANEL_SECRET = 'test';
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32);

// ── Datos: septiembre 2026, cargas reales del panel ────────────
const OBJETIVOS = [
  { id: 'o-chacras', nombre: 'Chacras', grupo_stock: 'privado' },
  { id: 'o-sup', nombre: 'SUPERVISORES', grupo_stock: null },
  { id: 'o-tablada', nombre: 'Tablada Lasalle', grupo_stock: null },
  { id: 'o-jordin', nombre: 'Saint Jordin', grupo_stock: null },
  { id: 'o-calandria', nombre: 'LA CALANDRIA', grupo_stock: null },
  { id: 'o-muni', nombre: 'Municipalidad Luis', grupo_stock: 'deposito' },
];
const ALIAS = [{ alias: 'chacra', objetivos: { nombre: 'Chacras' } }];
const CENSOS = [
  { objetivo_id: 'o-chacras', periodo: '2026-08', censos_stock_items: [
    { tipo_equipo: 'Motoguadaña', cantidad: 5, numeros: ['50', '51', '45', '49', '47'] },
    { tipo_equipo: 'motosierra 250', cantidad: 1, numeros: [] },
    { tipo_equipo: 'tractor MF 1175', cantidad: 1, numeros: [] },
    { tipo_equipo: 'Tractor new holland TT45', cantidad: 1, numeros: [] },
    { tipo_equipo: 'sopladora mochila sthil', cantidad: 1, numeros: [] },
    { tipo_equipo: '2 carros', cantidad: 1, numeros: [] },
    { tipo_equipo: 'palas', cantidad: 8, numeros: [] },
  ] },
  // Chacras tiene un censo más viejo también: tiene que ganar el de agosto.
  { objetivo_id: 'o-chacras', periodo: '2026-06', censos_stock_items: [{ tipo_equipo: 'Motoguadaña', cantidad: 99, numeros: [] }] },
];
const CARGAS = [
  // Diego, 55 lt de bidones a Chacras, ticket de tarjeta con importe.
  { id: 'c1', fecha: '2026-09-01', estado: 'sin_facturar', total: 135000, litros_total: 55, tarjeta: '3084', patente_raw: null,
    objetivos: { nombre: 'Chacras' }, capataces: { nombre: 'Diego Gonzalez' }, proveedores: { nombre: 'ECOSERVICE SRL' }, unidades: null,
    cargas_combustible_items: [{ producto: 'SHELL BYOLLUM DIESEL', litros: 55, destino: 'bidon', destino_detalle: 'Chacras' }] },
  // Ivan, 45 lt repartidos en tres objetivos. Sin importe.
  { id: 'c2', fecha: '2026-09-01', estado: 'sin_facturar', total: null, litros_total: 45, patente_raw: null,
    objetivos: { nombre: 'SUPERVISORES' }, capataces: { nombre: 'Ivan Palacios' }, proveedores: null, unidades: null,
    cargas_combustible_items: [
      { producto: 'SUPER', litros: 15, destino: 'bidon', destino_detalle: 'Tablada Lasalle' },
      { producto: 'SUPER', litros: 10, destino: 'bidon', destino_detalle: 'Saint Jordin' },
      { producto: 'SUPER', litros: 20, destino: 'bidon', destino_detalle: 'LA CALANDRIA' },
    ] },
  // Al tanque de AC770AY, objetivo Chacras, con alias "chacra" en un bidón + tanque. Facturada.
  { id: 'c3', fecha: '2026-09-05', estado: 'facturada', total: 100000, litros_total: 50, patente_raw: 'AC770AY',
    objetivos: { nombre: 'Chacras' }, capataces: { nombre: 'Diego Gonzalez' }, proveedores: { nombre: 'SERVI SUD SA' }, unidades: { patente: 'AC770AY' },
    cargas_combustible_items: [
      { producto: 'EVOLUX DIESEL', litros: 30, destino: 'unidad', destino_detalle: null },
      { producto: 'PUMA SUPER', litros: 20, destino: 'bidon', destino_detalle: 'chacra' },
    ] },
  // Municipalidad Luis: carga vieja sin ítems.
  { id: 'c4', fecha: '2026-09-09', estado: 'sin_facturar', total: null, litros_total: 61.6549, patente_raw: 'KCG906',
    objetivos: { nombre: 'Municipalidad Luis' }, capataces: { nombre: 'Luis Ponferrada' }, proveedores: { nombre: 'ELUSSERVICE S.R.L.' }, unidades: { patente: 'KCG906' },
    cargas_combustible_items: [] },
  // Anulada: no cuenta.
  { id: 'c5', fecha: '2026-09-02', estado: 'anulada', total: null, litros_total: 999, objetivos: { nombre: 'Chacras' },
    cargas_combustible_items: [{ producto: 'X', litros: 999, destino: 'bidon', destino_detalle: 'Chacras' }] },
];

function clienteFalso() {
  return { from: tabla => {
    const q = { select() { return q; }, eq() { return q; }, neq() { return q; }, gte() { return q; }, lt() { return q; }, order() { return q; }, limit() { return q; }, in() { return q; },
      then(res, rej) {
        const data = tabla === 'cargas_combustible' ? CARGAS.filter(c => c.estado !== 'anulada')
          : tabla === 'objetivos_alias' ? ALIAS : tabla === 'censos_stock' ? CENSOS : tabla === 'objetivos' ? OBJETIVOS : [];
        return Promise.resolve({ data, error: null }).then(res, rej);
      } };
    return q;
  } };
}
require.cache[require.resolve('./supabase.js')] = { id: 'sb', filename: 'sb', loaded: true, exports: clienteFalso() };
require.cache[require.resolve('./supabase_compras.js')] = { id: 'sbc', filename: 'sbc', loaded: true, exports: clienteFalso() };

const router = require('./panel_api.js');
const capa = router.stack.find(l => l.route && l.route.path === '/api/combustible/reporte-objetivos');
if (!capa) { console.error('✗ No encontré /api/combustible/reporte-objetivos'); process.exit(1); }
const handler = capa.route.stack[capa.route.stack.length - 1].handle;

async function pedir(objetivos) {
  let out = { code: 200, json: null };
  const res = { status(c) { out.code = c; return res; }, json(j) { out.json = j; return res; } };
  await handler({ query: { mes: '2026-09', objetivos: objetivos.join('|') }, usuario: 'jose' }, res);
  return out;
}

let ok = 0, mal = 0;
function eq(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

(async () => {
  const r = await pedir(['Chacras', 'Tablada Lasalle', 'Municipalidad Luis', 'SUPERVISORES']);
  eq('responde 200', r.code === 200, JSON.stringify(r.json).slice(0, 200));
  const H = {}; (r.json.hojas || []).forEach(h => { H[h.objetivo] = h; });
  eq('una hoja por objetivo pedido', r.json.hojas.length === 4);

  console.log('\n— Chacras: bidones + tanque + alias —');
  const ch = H['Chacras'];
  eq('litros: 55 + 30 + 20 = 105', Math.abs(ch.litros - 105) < 0.01, String(ch.litros));
  eq('en bidones: 55 + 20 = 75', Math.abs(ch.litros_bidon - 75) < 0.01, String(ch.litros_bidon));
  eq('al tanque: 30', Math.abs(ch.litros_unidad - 30) < 0.01, String(ch.litros_unidad));
  eq('el alias "chacra" se unificó en Chacras', ch.detalle.some(d => d.producto === 'PUMA SUPER'));
  eq('cuenta 2 cargas (la anulada no)', ch.cargas === 2, String(ch.cargas));
  eq('por unidad: Bidones 75 y AC770AY 30', ch.por_unidad['Bidones'] === 75 && ch.por_unidad['AC770AY'] === 30, JSON.stringify(ch.por_unidad));
  eq('por tipo tiene los tres productos', Object.keys(ch.por_tipo).length === 3, JSON.stringify(ch.por_tipo));
  eq('importe: c1 entera (135.000) + c3 entera (100.000) = 235.000', ch.importe === 235000, String(ch.importe));
  eq('2 cargas con importe, 0 sin', ch.cargas_con_importe === 2 && ch.cargas_sin_importe === 0);
  eq('detalle ordenado por fecha', ch.detalle[0].fecha <= ch.detalle[ch.detalle.length - 1].fecha);

  console.log('\n— Chacras: máquinas del censo —');
  const M = ch.maquinas;
  eq('usa el censo más reciente (08, no 06)', M && M.censo_periodo === '2026-08', M && M.censo_periodo);
  eq('5 motoguadañas + 1 motosierra + 1 sopladora = 7 de 2 tiempos', M.familias.dos_tiempos === 7, JSON.stringify(M.familias));
  eq('2 tractores', M.familias.tractor === 2, String(M.familias.tractor));
  eq('carros y palas van a sin motor', M.familias.sin_motor === 9, String(M.familias.sin_motor));
  eq('con motor = 9', M.con_motor === 9, String(M.con_motor));
  eq('capacidad de máquinas > 0', M.capacidad_maquinas > 0, String(M.capacidad_maquinas));
  eq('uso de máquinas = bidones / capacidad', M.uso_maquinas_pct === Math.round(75 / M.capacidad_maquinas * 100), `${M.uso_maquinas_pct} vs ${75 / M.capacidad_maquinas * 100}`);
  eq('sin vehículos censados, uso de vehículos es null', M.uso_vehiculos_pct === null, String(M.uso_vehiculos_pct));
  eq('litros por máquina = 75 / 9', M.litros_por_maquina === Math.round(75 / 9), String(M.litros_por_maquina));
  eq('el detalle del censo lista los tipos', Object.keys(M.tipos).length >= 5, JSON.stringify(M.tipos));

  console.log('\n— Tablada Lasalle: su parte de una carga repartida —');
  const tb = H['Tablada Lasalle'];
  eq('solo sus 15 litros, no los 45', Math.abs(tb.litros - 15) < 0.01, String(tb.litros));
  eq('marcada como parcial en el detalle', tb.detalle[0].parcial === true);
  eq('sin importe (la carga no tiene precio)', tb.importe === 0 && tb.cargas_sin_importe === 1);
  eq('sin censo → maquinas null', tb.maquinas === null);

  console.log('\n— SUPERVISORES: objetivo de cabecera cuyos bidones fueron a otros —');
  const sp = H['SUPERVISORES'];
  eq('no se lleva ningún litro (todo fue a otros objetivos)', sp.litros === 0, String(sp.litros));
  eq('0 cargas', sp.cargas === 0, String(sp.cargas));

  console.log('\n— Municipalidad Luis: carga vieja sin ítems —');
  const ml = H['Municipalidad Luis'];
  eq('se imputa entera al tanque', Math.abs(ml.litros - 61.6549) < 0.01 && Math.abs(ml.litros_unidad - 61.6549) < 0.01, String(ml.litros));
  eq('la unidad es KCG906', ml.por_unidad['KCG906'] != null, JSON.stringify(ml.por_unidad));

  console.log('\n— Cierre: las hojas no pisan litros entre sí —');
  const r2 = await pedir(['Tablada Lasalle', 'Saint Jordin', 'LA CALANDRIA']);
  const suma = r2.json.hojas.reduce((s, h) => s + h.litros, 0);
  eq('las tres partes de la carga de Ivan suman 45', Math.abs(suma - 45) < 0.01, String(suma));

  console.log('\n— Bordes —');
  let r3 = await pedir([]);
  eq('sin objetivos → 400', r3.code === 400);
  r3 = await pedir(['No Existe']);
  eq('objetivo desconocido → hoja vacía, no error', r3.code === 200 && r3.json.hojas[0].litros === 0 && r3.json.hojas[0].maquinas === null);
  eq('trae días hábiles del período', r.json.dias_habiles > 0);

  console.log(`\n${ok} ok · ${mal} mal`);
  process.exit(mal ? 1 : 0);
})().catch(e => { console.error('✗ el harness explotó:', e); process.exit(1); });
