// Harness de /api/stock/desvios (panel_api.js) — la integración completa:
// fotos + taller + cierres + filtros. Monta el router REAL con Supabase
// simulado. Los casos son los del mockup aprobado.

process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'x';
process.env.SUPABASE_COMPRAS_URL = 'https://y.supabase.co'; process.env.SUPABASE_COMPRAS_KEY = 'x';
process.env.PANEL_SECRET = 'test';
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32); process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32);

const OBJ = [
  { id: 'cos', nombre: 'Caminos las sierras Cosquin', grupo_stock: 'deposito', tipo: 'operativo' },
  { id: 'ucc', nombre: 'UNIVERSIDAD CATOLICA DE CORDOBA', grupo_stock: 'privado', tipo: 'operativo' },
  { id: 'fin', nombre: 'FINCAS DEL SUR', grupo_stock: 'privado', tipo: 'operativo' },
  { id: 'cir', nombre: 'Caminos de la Sierras Circunvalacion', grupo_stock: 'deposito', tipo: 'operativo' },
  { id: 'joc', nombre: 'COUNTRY JOCKEY CLUB CORDOBA', grupo_stock: 'privado', tipo: 'operativo' },
  { id: 'cha', nombre: 'Chacras', grupo_stock: 'privado', tipo: 'operativo' },
  { id: 'nun', nombre: 'Nunca informó', grupo_stock: null, tipo: 'operativo' },
];
const objN = {}; OBJ.forEach(o => { objN[o.id] = { nombre: o.nombre, grupo_stock: o.grupo_stock }; });
const F = (oid, semana, items, extra) => ({ id: oid + semana, objetivo_id: oid, semana, respondido_at: semana + 'T11:00:00Z', capataz_nombre: 'Cap', origen: 'bot',
  items, total: items.reduce((s, i) => s + i.cantidad, 0), objetivos: objN[oid], ...(extra || {}) });
const FOTOS = [
  F('cos', '2026-09-07', [{ tipo: 'Motoguadaña 291', cantidad: 15, numeros: ['213','211','235','210','224','239','221','220','218','227','236','sn','sn','218','22'] }]),
  F('cos', '2026-08-31', [{ tipo: 'Motoguadaña 291', cantidad: 16, numeros: ['213','211','235','212','210','224','239','221','220','218','227','236','sn','sn','218','22'] }]),
  F('cos', '2026-08-24', [{ tipo: 'Motoguadaña 291', cantidad: 17, numeros: ['213','211','235','212','210','224','239','234','221','220','218','227','236','sn','sn','218','22'] }]),
  F('ucc', '2026-09-07', [{ tipo: 'Motoguadaña', cantidad: 2, numeros: ['6','48'] }, { tipo: 'Minitractor', cantidad: 1, numeros: ['T22'] }]),
  F('ucc', '2026-08-31', [{ tipo: 'Motoguadaña', cantidad: 3, numeros: ['6','31','48'] }, { tipo: 'Minitractor', cantidad: 1, numeros: ['T22'] }]),
  F('fin', '2026-09-07', [{ tipo: 'Motosierra', cantidad: 1, numeros: [] }]),
  F('fin', '2026-08-31', [{ tipo: 'Motosierra', cantidad: 2, numeros: [] }]),
  F('cir', '2026-09-07', [{ tipo: 'Motoguadaña', cantidad: 3, numeros: ['233','222','240'] }]),
  F('cir', '2026-08-31', [{ tipo: 'Motoguadaña', cantidad: 2, numeros: ['233','222'] }]),
  F('joc', '2026-08-31', [{ tipo: 'Motoguadaña', cantidad: 5, numeros: ['1','2','3','4','5'] }]),     // no respondió el 7/9
  F('cha', '2026-09-07', [{ tipo: 'Motoguadaña', cantidad: 5, numeros: ['50','51','45','49','47'] }]),
  F('cha', '2026-08-31', [{ tipo: 'Motoguadaña', cantidad: 5, numeros: ['50','51','45','49','47'] }]),
];
const INC = [
  { id: 'i1', objetivo_id: 'cos', numero_unidad: '212', tipo_equipo: 'motoguadaña', tipo_falla: 'trinquete', estado: 'en_reparacion', fecha_ingreso_taller: '2026-09-03', created_at: '2026-09-01' },
  { id: 'i2', objetivo_id: 'ucc', numero_unidad: '31', tipo_equipo: 'motoguadaña', tipo_falla: 'no arranca', estado: 'diagnostico', fecha_ingreso_taller: '2026-09-05', created_at: '2026-09-02' },
  { id: 'i3', objetivo_id: 'ucc', numero_unidad: 'T22', tipo_equipo: 'minitractor', tipo_falla: 'giro cero', estado: 'pendiente', fecha_ingreso_taller: null, created_at: '2026-09-01' },
];
let CIERRES = [];
function cliente() { return { from: t => { const q = { _t: t, select() { return q; }, eq() { return q; }, neq() { return q; }, not() { return q; }, order() { return q; }, limit() { return q; }, in() { return q; },
  upsert(f) { if (t === 'stock_desvios_cierres') { CIERRES = CIERRES.filter(c => c.clave !== f.clave).concat([f]); } return { then(r) { return Promise.resolve({ error: null }).then(r); } }; },
  delete() { return { eq: async (c, v) => { if (t === 'stock_desvios_cierres') CIERRES = CIERRES.filter(x => x.clave !== v); return { error: null }; } }; },
  then(res, rej) { const data = t === 'stock_fotos' ? FOTOS : t === 'objetivos' ? OBJ : t === 'incidencias' ? INC.filter(i => i.fecha_ingreso_taller) : t === 'stock_desvios_cierres' ? CIERRES : [];
    return Promise.resolve({ data, error: null }).then(res, rej); } }; return q; } }; }
require.cache[require.resolve('./supabase.js')] = { id: 'sb', filename: 'sb', loaded: true, exports: cliente() };
require.cache[require.resolve('./supabase_compras.js')] = { id: 'sbc', filename: 'sbc', loaded: true, exports: cliente() };
require.cache[require.resolve('./notificar.js')] = { id: 'n', filename: 'n', loaded: true, exports: { notificarCapataz: async () => false, notificarCapatazTemplate: async () => false, notificarConFallback: async () => ({ ok: false }), mensajeEstadoIncidencia: () => '', mensajeCierreSinReparar: () => '' } };

const router = require('./panel_api.js');
function h(path, method) { const c = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]); if (!c) { console.error('✗ no encontré ' + path); process.exit(1); } return c.route.stack[c.route.stack.length - 1].handle; }
const desvios = h('/api/stock/desvios', 'get'), cerrar = h('/api/stock/desvios/cerrar', 'post'), historial = h('/api/stock/maquina/:numero/historial', 'get');
async function call(handler, query, params, body) { let out = { code: 200, json: null }; const res = { status(c) { out.code = c; return res; }, json(j) { out.json = j; return res; } }; await handler({ query: query || {}, params: params || {}, body: body || {}, usuario: 'jose' }, res); return out; }

let ok = 0, mal = 0;
function eq(n, c, d) { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } }
const por = (r, id) => (r.json.filas || []).find(f => f.objetivo_id === id);

(async () => {
  console.log('— Semana del 7/9 —');
  let r = await call(desvios, { semana: '2026-09-07' });
  eq('responde 200', r.code === 200, JSON.stringify(r.json).slice(0, 200));
  const cos = por(r, 'cos'), ucc = por(r, 'ucc'), fin = por(r, 'fin'), cir = por(r, 'cir'), joc = por(r, 'joc'), cha = por(r, 'cha'), nun = por(r, 'nun');
  eq('Cosquin: con_faltantes', cos.estado === 'con_faltantes', cos.estado);
  eq('Cosquin: la 234 falta, 2ª semana', cos.faltantes.some(f => f.numero === '234' && f.semanas === 2), JSON.stringify(cos.faltantes));
  eq('Cosquin: la 212 en taller con su incidencia', cos.taller.some(t => t.numero === '212' && t.incidencia && t.incidencia.tipo_falla === 'trinquete'));
  eq('UCC: sin faltantes, 31 en taller', ucc.estado === 'con_cambios' && ucc.taller.length === 1 && ucc.faltantes.length === 0, ucc.estado);
  eq('UCC: el T22 (sin ingreso) no aparece como nada', !ucc.taller.some(t => t.numero === 'T22') && !ucc.faltantes.some(t => t.numero === 'T22'));
  eq('Fincas: faltante por cantidad sin número', fin.faltantes.length === 1 && fin.faltantes[0].numero === null);
  eq('Circunvalación: la 240 nueva', cir.nuevos.some(n => n.numero === '240') && cir.estado === 'con_cambios');
  eq('Jockey: sin respuesta (tiene foto anterior, no de esta semana)', joc.estado === 'sin_respuesta', joc.estado);
  eq('Chacras: sin cambios', cha.estado === 'sin_cambios', cha.estado);
  eq('Nunca informó: sin_fotos', nun.estado === 'sin_fotos', nun.estado);
  const T = r.json.totales;
  eq('totales: 2 faltantes (234 + motosierra), 1 repite', T.faltantes === 2 && T.repiten === 1, JSON.stringify(T));
  eq('totales: 2 en taller, 1 nuevo, 1 sin respuesta', T.taller === 2 && T.nuevos === 1 && T.sin_respuesta === 1, JSON.stringify(T));
  eq('semana anterior calculada', r.json.semana_anterior === '2026-08-31');

  console.log('\n— Semana del 31/8 (la anterior): la 234 todavía estaba —');
  r = await call(desvios, { semana: '2026-08-31' });
  eq('Cosquin 31/8: la 234 ya faltaba, 1ª semana', por(r, 'cos').faltantes.some(f => f.numero === '234' && f.semanas === 1), JSON.stringify(por(r, 'cos').faltantes));
  eq('Cosquin 31/8: la 212 todavía estaba', !por(r, 'cos').faltantes.some(f => f.numero === '212') && !por(r, 'cos').taller.some(t => t.numero === '212'));

  console.log('\n— Filtros —');
  r = await call(desvios, { semana: '2026-09-07', tipo: 'faltante' });
  eq('tipo=faltante deja solo Cosquin y Fincas', r.json.filas.length === 2 && r.json.filas.every(f => f.faltantes.length));
  r = await call(desvios, { semana: '2026-09-07', grupo: 'deposito' });
  eq('grupo=deposito: Cosquin y Circunvalación', r.json.filas.every(f => f.grupo === 'deposito') && r.json.filas.length === 2);
  r = await call(desvios, { semana: '2026-09-07', repetidos: '1' });
  eq('repetidos: solo Cosquin', r.json.filas.length === 1 && r.json.filas[0].objetivo_id === 'cos');
  r = await call(desvios, { semana: '2026-09-07', q: '240' });
  eq('buscar 240 encuentra Circunvalación', r.json.filas.length === 1 && r.json.filas[0].objetivo_id === 'cir');
  r = await call(desvios, { semana: '2026-09-07', equipo: 'motosierra' });
  eq('equipo=motosierra: solo Fincas', r.json.filas.length === 1 && r.json.filas[0].objetivo_id === 'fin');
  r = await call(desvios, { semana: '2026-09-07', objetivo: 'ucc' });
  eq('objetivo=ucc', r.json.filas.length === 1 && r.json.filas[0].objetivo_id === 'ucc');
  r = await call(desvios, { semana: '2026-09-07', tipo: 'sin_respuesta' });
  eq('tipo=sin_respuesta: Jockey', r.json.filas.length === 1 && r.json.filas[0].objetivo_id === 'joc');
  eq('los totales no cambian con el filtro', r.json.totales.faltantes === 2);
  eq('lista de tipos de máquina para el selector', Array.isArray(r.json.equipos) && r.json.equipos.length >= 3);

  console.log('\n— Cierre con motivo —');
  r = await call(cerrar, {}, {}, { objetivo_id: 'cos', tipo: 'Motoguadaña 291', numero: '234', motivo: 'Estaba en otro objetivo' });
  eq('cierra', r.code === 200 && r.json.ok);
  r = await call(desvios, { semana: '2026-09-07' });
  const f234 = por(r, 'cos').faltantes.find(f => f.numero === '234');
  eq('la 234 sigue apareciendo pero CERRADA', f234 && f234.cerrado && f234.cerrado.motivo === 'Estaba en otro objetivo', JSON.stringify(f234));
  eq('con quién y cuándo', f234.cerrado.por === 'jose' && f234.cerrado.at);
  eq('ya no cuenta en totales', r.json.totales.faltantes === 1 && r.json.totales.repiten === 0, JSON.stringify(r.json.totales));
  eq('Cosquin ya no está "con_faltantes"', por(r, 'cos').estado === 'con_cambios', por(r, 'cos').estado);
  r = await call(cerrar, {}, {}, { objetivo_id: 'cos', tipo: 'Motoguadaña 291', numero: '234', motivo: '' });
  eq('sin motivo → 400', r.code === 400);
  r = await call(cerrar, {}, {}, { objetivo_id: 'cos', tipo: 'Motoguadaña 291', numero: '234', reabrir: true });
  eq('reabre', r.code === 200 && r.json.reabierto);
  r = await call(desvios, { semana: '2026-09-07' });
  eq('vuelve a contar', r.json.totales.faltantes === 2);

  console.log('\n— Movida a otro objetivo —');
  FOTOS.push(F('cha', '2026-09-14', [{ tipo: 'Motoguadaña', cantidad: 6, numeros: ['50','51','45','49','47','234'] }]));
  FOTOS.push(F('cos', '2026-09-14', [{ tipo: 'Motoguadaña 291', cantidad: 15, numeros: ['213','211','235','210','224','239','221','220','218','227','236','sn','sn','218','22'] }]));
  r = await call(desvios, { semana: '2026-09-14' });
  eq('la 234 aparece en Chacras el 14/9 → en Cosquin es MOVIDA, no faltante', !por(r, 'cos').faltantes.some(f => f.numero === '234') && (por(r, 'cos').movidas || []).some(m => m.numero === '234' && /Chacras/.test(m.destino)), JSON.stringify(por(r, 'cos').movidas));
  eq('en Chacras la 234 es nueva y dice de dónde viene', por(r, 'cha').nuevos.some(n => n.numero === '234' && /Cosquin/.test(n.viene_de || '')), JSON.stringify(por(r, 'cha').nuevos));
  eq('los totales cuentan la movida', r.json.totales.movidas === 1);
  r = await call(desvios, { semana: '2026-09-14', tipo: 'movida' });
  eq('filtro tipo=movida', r.json.filas.length === 1 && r.json.filas[0].objetivo_id === 'cos');
  FOTOS.pop(); FOTOS.pop();

  console.log('\n— Trazabilidad —');
  r = await call(historial, {}, { numero: '234' });
  eq('la 234 aparece en 1 foto de Cosquin (24/8), después nunca más', r.json.apariciones.length === 1 && r.json.apariciones[0].semana === '2026-08-24', JSON.stringify(r.json.apariciones));
  eq('no cambió de objetivo', r.json.cambio_de_objetivo === false);
  r = await call(historial, {}, { numero: '212' });
  eq('la 212 trae su reparación', r.json.reparaciones.length === 1 && r.json.reparaciones[0].falla === 'trinquete');
  r = await call(historial, {}, { numero: '9999' });
  eq('un número que no existe no rompe', r.code === 200 && r.json.apariciones.length === 0);

  console.log(`\n${ok} ok · ${mal} mal`);
  process.exit(mal ? 1 : 0);
})().catch(e => { console.error('✗ explotó:', e); process.exit(1); });
