// Harness de "no se finaliza sin mecánico" (panel_api.js y app_api.js).
//
// Monta los routers REALES con un Supabase simulado y prueba las dos puertas
// por las que una reparación puede cerrarse: el panel (José) y la app (el
// mecánico). Cubre la decisión del 04-sep: los mecánicos no eligen mecánico
// —ni al crear ni al dar ingreso— y nada se cierra sin uno asignado.

process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'x';
process.env.SUPABASE_COMPRAS_URL = 'https://y.supabase.co';
process.env.SUPABASE_COMPRAS_KEY = 'x';
process.env.PANEL_SECRET = 'test';
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32);

let inc;          // la incidencia "en la base"
let ultimoPatch;  // lo último que se intentó guardar
function clienteFalso() {
  return { from: tabla => {
    const q = { _sel: null,
      select(s) { q._sel = s; return q; }, eq() { return q; }, neq() { return q; }, order() { return q; }, limit() { return q; }, not() { return q; },
      async single() { return { data: tabla === 'incidencias' ? inc : null, error: null }; },
      async maybeSingle() { return { data: tabla === 'incidencias' ? inc : null, error: null }; },
      update(patch) { ultimoPatch = patch; return { eq: () => ({ select: () => ({ single: async () => ({ data: { ...inc, ...patch }, error: null }) }) }) }; },
      insert() { const r = { select: () => ({ single: async () => ({ data: {}, error: null }) }), then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); } }; return r; },
      then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); },
    };
    return q;
  } };
}
require.cache[require.resolve('./supabase.js')] = { id: 'sb', filename: 'sb', loaded: true, exports: clienteFalso() };
require.cache[require.resolve('./supabase_compras.js')] = { id: 'sbc', filename: 'sbc', loaded: true, exports: clienteFalso() };
// notificar.js manda WhatsApp: se anula.
require.cache[require.resolve('./notificar.js')] = { id: 'n', filename: 'n', loaded: true, exports: {
  notificarCapataz: async () => false, notificarCapatazTemplate: async () => false,
  mensajeEstadoIncidencia: () => '', mensajeCierreSinReparar: () => '' } };

const panel = require('./panel_api.js');
const app = require('./app_api.js').router;

function handlerDe(router, path, method) {
  const capa = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  if (!capa) { console.error(`✗ No encontré ${method.toUpperCase()} ${path}`); process.exit(1); }
  return capa.route.stack[capa.route.stack.length - 1].handle;
}
const panelCambio = handlerDe(panel, '/api/reparaciones/:id', 'post');
const appEstado   = handlerDe(app, '/api/app/incidencia/:id/estado', 'post');
const appIngreso  = handlerDe(app, '/api/app/incidencia/:id/ingreso-taller', 'post');

async function llamar(handler, body, extra) {
  ultimoPatch = null;
  let out = { code: 200, json: null };
  const res = { status(c) { out.code = c; return res; }, json(j) { out.json = j; return res; }, locals: {} };
  await handler({ params: { id: 'i1' }, body, usuario: 'jose', ...(extra || {}) }, res);
  return out;
}

let ok = 0, mal = 0;
function eq(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}
const mecanico = { app_user: { mid: 'mec-carlos', nombre: 'Carlos Gonzalez' } };

(async () => {
  console.log('— Panel: finalizar —');
  inc = { id: 'i1', estado: 'en_reparacion', mecanico_id: null, tipo_mant: 'correctivo', created_at: '2026-09-01T10:00:00Z' };
  let r = await llamar(panelCambio, { estado: 'finalizado' });
  eq('sin mecánico → se frena (422)', r.code === 422, `dio ${r.code}`);
  eq('y no toca la base', ultimoPatch === null);
  eq('el mensaje dice qué falta', /mecánico/i.test((r.json || {}).error || ''));

  r = await llamar(panelCambio, { estado: 'finalizado', mecanico_id: 'mec-carlos' });
  eq('asignar y finalizar en el mismo pedido → pasa', r.code === 200, `dio ${r.code}`);
  eq('guarda mecánico y estado juntos', ultimoPatch && ultimoPatch.mecanico_id === 'mec-carlos' && ultimoPatch.estado === 'finalizado');

  inc = { ...inc, mecanico_id: 'mec-carlos' };
  r = await llamar(panelCambio, { estado: 'finalizado' });
  eq('con mecánico ya asignado → pasa', r.code === 200, `dio ${r.code}`);

  inc = { ...inc, mecanico_id: null };
  r = await llamar(panelCambio, { estado: 'en_reparacion' });
  eq('otros estados no exigen mecánico', r.code === 200, `dio ${r.code}`);

  r = await llamar(panelCambio, { mecanico_id: 'mec-carlos' });
  eq('asignar solo (sin estado) sigue funcionando', r.code === 200 && ultimoPatch.mecanico_id === 'mec-carlos');

  console.log('\n— App: el mecánico —');
  inc = { id: 'i1', estado: 'en_reparacion', mecanico_id: 'mec-carlos', numero_unidad: 'T22', tipo_equipo: 'minitractor' };
  r = await llamar(appEstado, { estado: 'finalizado' }, mecanico);
  eq('finaliza la suya → pasa', r.code === 200, `dio ${r.code}`);

  inc = { ...inc, mecanico_id: 'mec-otro' };
  r = await llamar(appEstado, { estado: 'finalizado' }, mecanico);
  eq('no puede finalizar la de otro (403)', r.code === 403, `dio ${r.code}`);

  inc = { ...inc, mecanico_id: null };
  r = await llamar(appEstado, { estado: 'finalizado' }, mecanico);
  eq('sin mecánico asignado → no puede (no es suya)', r.code !== 200 && ultimoPatch === null, `dio ${r.code}`);

  console.log('\n— App: el ingreso al taller ya no asigna mecánico —');
  inc = { id: 'i1', estado: 'pendiente', mecanico_id: null, tipo_equipo: 'minitractor', numero_unidad: 'T22', created_at: '2026-09-01T10:00:00Z', fecha_ingreso_taller: null };
  r = await llamar(appIngreso, {}, mecanico);
  eq('el ingreso se registra', r.code === 200 && ultimoPatch && ultimoPatch.fecha_ingreso_taller, `dio ${r.code}`);
  eq('pero NO asigna al que lo recibió', !('mecanico_id' in (ultimoPatch || {})), JSON.stringify(ultimoPatch));
  eq('pasa de pendiente a diagnóstico igual', ultimoPatch && ultimoPatch.estado === 'diagnostico');

  console.log(`\n${ok} ok · ${mal} mal`);
  process.exit(mal ? 1 : 0);
})().catch(e => { console.error('✗ el harness explotó:', e); process.exit(1); });
