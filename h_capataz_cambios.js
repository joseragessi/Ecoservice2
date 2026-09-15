// Harness de /api/app/capataz/cambios (app_api.js).
//
// Es lo que el capataz ve al entrar a "Mis máquinas": qué le falta, qué tiene
// en el taller y qué apareció. Misma información que ve José en el panel, de
// SU objetivo solo (pedido del 14-sep).
//
// Lo crítico es la misma regla del panel: una máquina en el TALLER nunca se
// muestra como faltante. Si eso falla, el capataz sale a buscar una máquina
// que está en reparación.

process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'x';
process.env.SUPABASE_COMPRAS_URL = 'https://y.supabase.co'; process.env.SUPABASE_COMPRAS_KEY = 'x';
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32); process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32);

let CENSOS = [], INCID = [];
function cliente() {
  return { from: t => { const q = { _t: t, select() { return q; }, eq() { return q; }, neq() { return q; }, not() { return q; },
    order() { return q; }, limit() { return q; },
    then(res, rej) { return Promise.resolve({ data: t === 'censos_stock' ? CENSOS : t === 'incidencias' ? INCID : [], error: null }).then(res, rej); },
    async single() { return { data: null }; }, async maybeSingle() { return { data: null }; },
    insert() { return { select: () => ({ single: async () => ({ data: {}, error: null }) }) }; },
    update() { return { eq: async () => ({ error: null }) }; },
    delete() { return { eq: async () => ({ error: null }) }; } }; return q; } };
}
require.cache[require.resolve('./supabase.js')] = { id: 'sb', filename: 'sb', loaded: true, exports: cliente() };
require.cache[require.resolve('./notificar.js')] = { id: 'n', filename: 'n', loaded: true, exports: {
  notificarCapataz: async () => false, notificarCapatazTemplate: async () => false, notificarConFallback: async () => ({ ok: false }),
  mensajeEstadoIncidencia: () => '', mensajeCierreSinReparar: () => '' } };
require.cache[require.resolve('./stock.js')] = { id: 'st', filename: 'st', loaded: true, exports: {
  guardarFotoSemanal: async () => {}, iniciarStock: async () => '', continuarStock: async () => '',
  tieneSesionActiva: () => false, periodoActual: () => '2026-09', tienePedidoPendiente: async () => false, _esListadoCompleto: () => false } };

const router = require('./app_api.js').router;
const capa = router.stack.find(l => l.route && l.route.path === '/api/app/capataz/cambios');
if (!capa) { console.error('✗ no encontré /api/app/capataz/cambios'); process.exit(1); }
const handler = capa.route.stack[capa.route.stack.length - 1].handle;

const it = (tipo, cant, nums, obs) => ({ tipo_equipo: tipo, cantidad: cant, numeros: nums || [], observacion: obs || null });
const censo = (periodo, items) => ({ periodo, respondido_at: periodo + '-08T10:00:00Z', censos_stock_items: items });
const inc = (num, tipo, ingreso, falla) => ({ id: 'i' + num, numero_unidad: num, tipo_equipo: tipo,
  tipo_falla: falla || 'no arranca', estado: 'en_reparacion', fecha_ingreso_taller: ingreso });

async function pedir(objetivoId) {
  let out = { code: 200, json: null };
  const res = { status(c) { out.code = c; return res; }, json(j) { out.json = j; return res; } };
  await handler({ query: {}, params: {}, body: {}, app_user: { cid: 'c1', nombre: 'Leo Giraudo', objetivo_id: objetivoId === undefined ? 'ucc' : objetivoId } }, res);
  return out;
}
let ok = 0, mal = 0;
function eq(n, c, d) { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } }
const nums = arr => (arr || []).map(x => String(x.numero)).sort().join(',');

(async () => {
  console.log('— LA REGLA: lo que está en el taller no se muestra como faltante —');
  CENSOS = [censo('2026-09', [it('Motoguadaña', 2, ['6', '48'])]),
            censo('2026-08', [it('Motoguadaña', 3, ['6', '31', '48'])])];
  INCID = [inc('31', 'motoguadaña', '2026-09-05')];
  let r = await pedir();
  eq('responde 200', r.code === 200);
  eq('la 31 NO aparece como faltante', nums(r.json.faltan) === '', nums(r.json.faltan));
  eq('aparece en el taller, con su fecha', (r.json.en_taller || []).length === 1 && r.json.en_taller[0].ingreso === '2026-09-05', JSON.stringify(r.json.en_taller));
  eq('y trae la falla, para que el capataz sepa por qué', r.json.en_taller[0].falla === 'no arranca');

  console.log('\n— Faltante real: no declarada y NO está en el taller —');
  INCID = [];
  r = await pedir();
  eq('sin nada en el taller, la 31 sí falta', nums(r.json.faltan) === '31', nums(r.json.faltan));
  eq('y dice de qué tipo es', r.json.faltan[0].tipo === 'Motoguadaña');

  console.log('\n— Máquina nueva —');
  CENSOS = [censo('2026-09', [it('Motoguadaña', 3, ['6', '48', '77'])]),
            censo('2026-08', [it('Motoguadaña', 2, ['6', '48'])])];
  r = await pedir();
  eq('la 77 aparece como nueva', nums(r.json.nuevas) === '77');
  eq('y no hay faltantes', (r.json.faltan || []).length === 0);

  console.log('\n— El tipo escrito distinto no inventa faltantes —');
  // El caso de Cosquin: "Motoguadaña 291" en agosto, "Motoguadaña" en septiembre.
  CENSOS = [censo('2026-09', [it('Motoguadaña', 3, ['213', '211', '235'])]),
            censo('2026-08', [it('Motoguadaña 291', 3, ['213', '211', '235'], 'Stihl 291')])];
  r = await pedir();
  eq('mismo tipo escrito distinto → sin faltantes ni nuevas',
    (r.json.faltan || []).length === 0 && (r.json.nuevas || []).length === 0,
    `faltan ${nums(r.json.faltan)} / nuevas ${nums(r.json.nuevas)}`);

  console.log('\n— "E10" y "10" son la misma máquina —');
  CENSOS = [censo('2026-09', [it('Motoguadaña', 4, ['10', '11', '12', '13'])]),
            censo('2026-08', [it('Motoguadaña', 4, ['E10', 'E11', 'E12', 'E13'])])];
  r = await pedir();
  eq('el prefijo de una letra no genera faltantes',
    (r.json.faltan || []).length === 0 && (r.json.nuevas || []).length === 0,
    `faltan ${nums(r.json.faltan)} / nuevas ${nums(r.json.nuevas)}`);

  console.log('\n— Los "sn" no pueden faltar —');
  CENSOS = [censo('2026-09', [it('Motoguadaña', 1, ['12'])]),
            censo('2026-08', [it('Motoguadaña', 3, ['sn', 'SN', '12'])])];
  r = await pedir();
  eq('un "sn" no se reporta como faltante', (r.json.faltan || []).length === 0, nums(r.json.faltan));
  eq('pero los totales muestran la diferencia', r.json.total_previo === 3 && r.json.total === 1);

  console.log('\n— Primer censo del objetivo —');
  CENSOS = [censo('2026-09', [it('Motoguadaña', 2, ['6', '48'])])];
  INCID = [];
  r = await pedir();
  eq('sin mes anterior, no inventa faltantes', (r.json.faltan || []).length === 0 && r.json.previo === null);
  eq('pero avisa que hay censo', r.json.hay === true && r.json.periodo === '2026-09');

  console.log('\n— El taller se muestra aunque no haya comparación —');
  CENSOS = [censo('2026-09', [it('Motoguadaña', 2, ['6', '48'])])];
  INCID = [inc('6', 'motoguadaña', '2026-09-10', 'trinquete')];
  r = await pedir();
  eq('con un solo censo, el taller igual se lista', (r.json.en_taller || []).length === 1);

  console.log('\n— Bordes —');
  CENSOS = []; INCID = [];
  r = await pedir();
  eq('sin censos no rompe', r.code === 200 && r.json.hay === false);
  r = await pedir(null);
  eq('un capataz sin objetivo no rompe', r.code === 200 && r.json.hay === false);
  CENSOS = [censo('2026-09', []), censo('2026-08', [])];
  r = await pedir();
  eq('censos vacíos no rompen', r.code === 200 && (r.json.faltan || []).length === 0);

  console.log(`\n${ok} ok · ${mal} mal`);
  process.exit(mal ? 1 : 0);
})().catch(e => { console.error('✗ explotó:', e); process.exit(1); });
