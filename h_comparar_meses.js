// Harness de la comparación de stock entre dos meses (panel_api.js).
//
// Reemplaza a la pestaña Desvíos (sacada el 14-sep). Lo que se verifica es la
// regla que dio José:
//   "el protocolo dice que tienen que colocar todo el stock que tienen en ese
//    momento; si una máquina está en el taller, o sale en el panel o si el
//    capataz lo declaró debería tacharse y mostrar que está en el taller"
//
// O sea: una máquina que está en el taller NUNCA es faltante, la haya
// declarado el capataz o no. Faltante es solo lo que no está declarado NI en
// el taller. Si eso falla, se le reclama a un capataz por una máquina que
// está en reparación.

process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'x';
process.env.SUPABASE_COMPRAS_URL = 'https://y.supabase.co'; process.env.SUPABASE_COMPRAS_KEY = 'x';
process.env.PANEL_SECRET = 'test';
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32); process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32);

const OBJ = [
  { id: 'ayres', nombre: 'AYRES DEL SUR', grupo_stock: 'privado', activo: true, tipo: 'operativo' },
  { id: 'ucc',   nombre: 'UNIVERSIDAD CATOLICA', grupo_stock: 'privado', activo: true, tipo: 'operativo' },
  { id: 'caso',  nombre: 'CASONAS DEL SUR', grupo_stock: 'privado', activo: true, tipo: 'operativo' },
  { id: 'circ',  nombre: 'Caminos Circunvalacion', grupo_stock: 'deposito', activo: true, tipo: 'operativo' },
  { id: 'joc',   nombre: 'COUNTRY JOCKEY CLUB', grupo_stock: 'privado', activo: true, tipo: 'operativo' },
];
const it = (tipo, cantidad, numeros, observacion) => ({ tipo_equipo: tipo, cantidad, numeros: numeros || [], observacion: observacion || null });
const censo = (oid, periodo, items) => ({ id: oid + periodo, objetivo_id: oid, periodo, estado: 'respondido',
  respondido_at: periodo + '-08T10:00:00Z', capataces: { nombre: 'Cap' }, censos_stock_items: items });
const CENSOS = [
  // septiembre
  censo('ayres', '2026-09', [it('Motoguadaña', 2, ['2', '20'])]),
  censo('ucc',   '2026-09', [it('Motoguadaña', 3, ['6', '31', '48'])]),   // declaró la 31 aunque está en taller
  censo('caso',  '2026-09', [it('Motoguadaña', 2, ['30', '28'])]),
  censo('circ',  '2026-09', [it('Motoguadaña', 3, ['233', '222', '240'])]),
  // agosto
  censo('ayres', '2026-08', [it('Motoguadaña', 3, ['2', '20', '1'])]),    // la 1 está en el taller
  censo('ucc',   '2026-08', [it('Motoguadaña', 3, ['6', '31', '48'])]),
  censo('caso',  '2026-08', [it('Motoguadaña', 4, ['30', '28', '19', '41'])]),
  censo('circ',  '2026-08', [it('Motoguadaña', 2, ['233', '222'])]),
  censo('joc',   '2026-08', [it('Motoguadaña', 10, [])]),                 // no declaró en septiembre
];
// El taller de HOY: la 1 de Ayres y la 31 de UCC.
const INCID = [
  { id: 'i1', objetivo_id: 'ayres', numero_unidad: '1',  tipo_equipo: 'motoguadaña', estado: 'en_reparacion', fecha_ingreso_taller: '2026-09-05', created_at: '2026-09-03' },
  { id: 'i2', objetivo_id: 'ucc',   numero_unidad: '31', tipo_equipo: 'motoguadaña', estado: 'diagnostico',   fecha_ingreso_taller: '2026-09-05', created_at: '2026-09-02' },
];
function cliente() {
  return { from: t => { const q = { _t: t, select() { return q; }, eq() { return q; }, neq() { return q; }, not() { return q; },
    order() { return q; }, limit() { return q; }, in() { return q; },
    then(res, rej) {
      const data = t === 'objetivos' ? OBJ : t === 'censos_stock' ? CENSOS.slice().sort((a, b) => b.periodo.localeCompare(a.periodo))
        : t === 'incidencias' ? INCID : [];
      return Promise.resolve({ data, error: null }).then(res, rej);
    },
    async single() { return { data: null }; }, async maybeSingle() { return { data: null }; } }; return q; } };
}
require.cache[require.resolve('./supabase.js')] = { id: 'sb', filename: 'sb', loaded: true, exports: cliente() };
require.cache[require.resolve('./supabase_compras.js')] = { id: 'sbc', filename: 'sbc', loaded: true, exports: cliente() };
require.cache[require.resolve('./notificar.js')] = { id: 'n', filename: 'n', loaded: true, exports: {
  notificarCapataz: async () => false, notificarCapatazTemplate: async () => false, notificarConFallback: async () => ({ ok: false }),
  mensajeEstadoIncidencia: () => '', mensajeCierreSinReparar: () => '' } };

const router = require('./panel_api.js');
const capa = router.stack.find(l => l.route && l.route.path === '/api/stock/general');
if (!capa) { console.error('✗ no encontré /api/stock/general'); process.exit(1); }
const handler = capa.route.stack[capa.route.stack.length - 1].handle;
async function pedir(query) {
  let out = { code: 200, json: null };
  const res = { status(c) { out.code = c; return res; }, json(j) { out.json = j; return res; } };
  await handler({ query: query || {}, params: {}, usuario: 'jose' }, res);
  return out;
}
let ok = 0, mal = 0;
function eq(n, c, d) { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } }
const objDe = (r, id) => (r.json.comparacion.objetivos || []).find(o => o.objetivo_id === id);
const numsDe = (o, tipo) => { const t = (o.tipos || []).find(x => x.tipo === tipo); return t ? t.numeros : []; };
const est = (o, tipo, n) => { const x = numsDe(o, tipo).find(y => String(y.n) === String(n)); return x ? x.estado : null; };

(async () => {
  console.log('— Ver un mes puntual —');
  let r = await pedir({ periodo: '2026-08' });
  eq('responde 200', r.code === 200);
  eq('devuelve los meses para el selector', Array.isArray(r.json.periodos) && r.json.periodos.includes('2026-08') && r.json.periodos.includes('2026-09'));
  eq('los meses vienen del más nuevo al más viejo', r.json.periodos[0] === '2026-09');
  const ayrAgo = (r.json.filas || []).filter(f => f.objetivo_id === 'ayres' && f.tipo);
  eq('muestra lo declarado en AGOSTO (3 motoguadañas, no 2)', ayrAgo[0] && ayrAgo[0].cantidad === 3, JSON.stringify(ayrAgo.map(f => f.cantidad)));
  eq('y el período pedido vuelve en la respuesta', r.json.periodo === '2026-08');
  r = await pedir({});
  const ayrUlt = (r.json.filas || []).filter(f => f.objetivo_id === 'ayres' && f.tipo);
  eq('sin período, sigue mostrando el último censo (2)', ayrUlt[0] && ayrUlt[0].cantidad === 2, JSON.stringify(ayrUlt.map(f => f.cantidad)));
  eq('sin comparar, no viene comparación', r.json.comparacion === null);

  console.log('\n— LA REGLA: en el taller NUNCA es faltante —');
  r = await pedir({ periodo: '2026-08', comparar: '2026-09' });
  eq('viene la comparación', !!r.json.comparacion && r.json.comparacion.desde === '2026-08' && r.json.comparacion.hasta === '2026-09');

  const ay = objDe(r, 'ayres');
  eq('AYRES · la 1 no se declaró en septiembre pero está en el taller → "taller", no "falta"',
    est(ay, 'Motoguadaña', '1') === 'taller', est(ay, 'Motoguadaña', '1'));
  eq('AYRES · no tiene faltantes', ay.faltan === 0, String(ay.faltan));
  eq('AYRES · cuenta 1 en el taller', ay.en_taller === 1);
  eq('AYRES · la 2 y la 20 siguen normales', est(ay, 'Motoguadaña', '2') === 'ok' && est(ay, 'Motoguadaña', '20') === 'ok');
  const t1 = numsDe(ay, 'Motoguadaña').find(x => String(x.n) === '1');
  eq('AYRES · trae la fecha de ingreso al taller', t1 && t1.ingreso === '2026-09-05', JSON.stringify(t1));

  const uc = objDe(r, 'ucc');
  eq('UCC · la 31 SÍ se declaró y está en el taller → igual se tacha',
    est(uc, 'Motoguadaña', '31') === 'taller', est(uc, 'Motoguadaña', '31'));
  eq('UCC · sin faltantes', uc.faltan === 0);
  eq('UCC · la diferencia es cero (declaró las 3)', uc.total_a === 3 && uc.total_b === 3);

  console.log('\n— Faltante real: no declarada y NO está en el taller —');
  const ca = objDe(r, 'caso');
  eq('CASONAS · la 19 falta', est(ca, 'Motoguadaña', '19') === 'falta');
  eq('CASONAS · la 41 falta', est(ca, 'Motoguadaña', '41') === 'falta');
  eq('CASONAS · cuenta 2 faltantes', ca.faltan === 2, String(ca.faltan));
  eq('CASONAS · la diferencia es −2', ca.total_b - ca.total_a === -2);

  console.log('\n— Máquina nueva —');
  const ci = objDe(r, 'circ');
  eq('CIRCUNVALACIÓN · la 240 es nueva', est(ci, 'Motoguadaña', '240') === 'nuevo');
  eq('y no genera faltantes', ci.faltan === 0);
  eq('la diferencia es +1', ci.total_b - ci.total_a === 1);

  console.log('\n— Sin declarar en el mes nuevo —');
  const jo = objDe(r, 'joc');
  eq('JOCKEY · marcado como que no declaró', jo.declaro_a === true && jo.declaro_b === false);
  eq('y NO se cuentan sus 10 máquinas como faltantes', jo.faltan === 0, String(jo.faltan));

  console.log('\n— Totales —');
  const T = r.json.comparacion.totales;
  eq('2 faltantes en total (las de Casonas)', T.faltan === 2, JSON.stringify(T));
  eq('2 en el taller (Ayres y UCC)', T.en_taller === 2);
  eq('1 nueva', T.nuevos === 1);
  eq('1 objetivo sin declarar', T.sin_declarar === 1);

  console.log('\n— Orden: lo que falta arriba —');
  eq('el primero es el que tiene faltantes', r.json.comparacion.objetivos[0].objetivo_id === 'caso', r.json.comparacion.objetivos[0].objetivo);

  console.log('\n— Bordes —');
  r = await pedir({ periodo: '2026-01', comparar: '2026-02' });
  eq('dos meses sin censos no rompen', r.code === 200 && (r.json.comparacion.objetivos || []).length === 0, JSON.stringify(r.json.comparacion && r.json.comparacion.totales));
  r = await pedir({ periodo: 'basura', comparar: 'x' });
  eq('parámetros inválidos se ignoran', r.code === 200 && r.json.periodo === null && r.json.comparacion === null);
  r = await pedir({ periodo: '2026-08', comparar: '2026-08' });
  eq('comparar un mes contra sí mismo no da faltantes', r.code === 200 && r.json.comparacion.totales.faltan === 0);

  console.log(`\n${ok} ok · ${mal} mal`);
  process.exit(mal ? 1 : 0);
})().catch(e => { console.error('✗ explotó:', e); process.exit(1); });
