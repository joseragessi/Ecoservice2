// Harness del ruteo del bot (index.js + conversacion.js).
//
// Recorre TODAS las opciones del menú y todos los pasos del submenú de
// reparaciones, con un pedido de stock pendiente activo — que es la
// situación real: hoy la mayoría de los capataces lo tienen.
//
// Los dos bugs que motivaron esto:
//   11-sep · Claudio eligió "1" (combustible) y el bot le pidió el censo.
//   12-sep · Agustín estaba reportando una reparación, eligió el equipo "10"
//            de la lista de tipos (que tiene 13) y el bot le pidió el censo.
//            El parche anterior solo cubría del 1 al 6.

process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'x';
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32);

const CAP = { id: 'c1', nombre: 'Agustin Nobrega', objetivo_id: 'o1', objetivo_nombre: 'Viarava', usuario: 'agustin.nobrega' };
function cliente() {
  return { from: () => { const q = {
    select() { return q; }, eq() { return q; }, neq() { return q; }, not() { return q; },
    order() { return q; }, limit() { return q; }, in() { return q; }, ilike() { return q; },
    insert() { return { select: () => ({ single: async () => ({ data: { id: 'x' }, error: null }) }) }; },
    update() { return { eq: async () => ({ error: null }) }; },
    async single() { return { data: CAP, error: null }; },
    async maybeSingle() { return { data: CAP, error: null }; },
    then(r) { return Promise.resolve({ data: [CAP], error: null }).then(r); } }; return q; } };
}
require.cache[require.resolve('./supabase.js')] = { id: 'sb', filename: 'sb', loaded: true, exports: cliente() };
require.cache[require.resolve('./sesion.js')] = { id: 'ses', filename: 'ses', loaded: true,
  exports: { conPersistencia: (n, s, f) => f, restaurar: async () => null, eliminar: () => {}, guardar: () => {} } };

const CONV = require('./conversacion.js');
const { procesarMensaje, enConversacion } = CONV;
const TEL = '5493518024213';

// "hola" no reinicia una sesión abierta (el bot no te saca de un flujo por
// saludar, y está bien). Para empezar de cero en cada caso se limpia igual
// que cuando vence el timeout.
const mecanico = require('./mecanico.js');
mecanico.asignarMecanico = async () => null;   // no hace falta para el ruteo
async function alMenu() {
  CONV._limpiar(TEL);                 // empezar de cero, como un capataz nuevo
  return procesarMensaje(TEL, 'hola');
}

let ok = 0, mal = 0;
function eq(n, c, d) { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } }
const txt = r => (r && r.__derivar) ? `[derivar:${r.__derivar}]` : String(r || '');

(async () => {
  console.log('— El menú responde las 6 opciones —');
  const esperado = [
    ['1', /foto.*remito|remito.*foto/i,      'combustible: pide la foto'],
    ['2', /\[derivar:insumos\]/,              'insumos'],
    ['3', /tipo de equipo|qué equipo|1\./i,   'reparación: abre la lista de equipos'],
    ['4', /\[derivar:stock\]/,                'stock'],
    ['5', /\[derivar:viajes\]/,               'viajes'],
    ['6', /\[derivar:estaciones\]/,           'estaciones'],
  ];
  for (const [op, re, nombre] of esperado) {
    await alMenu();          // abre el menú, salga de donde salga
    const r = await procesarMensaje(TEL, op);
    eq(`opción ${op} → ${nombre}`, re.test(txt(r)), txt(r).slice(0, 90));
  }

  console.log('\n— Una opción inválida vuelve a mostrar el menú —');
  await procesarMensaje(TEL, 'hola');
  let r = await procesarMensaje(TEL, 'K');
  eq('muestra las 6 opciones, no un recordatorio corto', /Cargar combustible[\s\S]*Buscar estaci/i.test(txt(r)), txt(r).slice(0, 80));
  r = await procesarMensaje(TEL, '9');
  eq('un número fuera de rango también', /Cargar combustible/i.test(txt(r)));

  console.log('\n— El submenú de reparaciones, paso por paso —');
  await alMenu();
  r = await procesarMensaje(TEL, '3');
  const nTipos = (txt(r).match(/^\s*\d+\./gm) || []).length;
  eq(`lista ${nTipos} tipos de equipo`, nTipos >= 10, String(nTipos));
  eq('estando en el submenú, enConversacion() da true', enConversacion(TEL) === true);

  // ⚠️ EL BUG DE AGUSTÍN: el "10" de una lista de 13.
  r = await procesarMensaje(TEL, '10');
  eq('elegir el equipo 10 avanza (NO cae en stock)', !/listado de maquinaria/i.test(txt(r)), txt(r).slice(0, 90));
  eq('y pide el número de unidad', /número o código de la unidad/i.test(txt(r)), txt(r).slice(0, 90));
  eq('sigue en conversación', enConversacion(TEL) === true);

  r = await procesarMensaje(TEL, 'MG-045');
  eq('acepta el número de unidad', !/listado de maquinaria/i.test(txt(r)));
  const nFallas = (txt(r).match(/^\s*\d+\./gm) || []).length;
  eq(`y ofrece ${nFallas} fallas`, nFallas >= 3, String(nFallas));

  r = await procesarMensaje(TEL, '2');
  eq('elegir la falla avanza', !/listado de maquinaria/i.test(txt(r)), txt(r).slice(0, 90));

  console.log('\n— Todos los números del submenú de equipos —');
  for (const n of ['1', '5', '9', '10', '12', '13']) {
    await alMenu();
    await procesarMensaje(TEL, '3');
    const rr = await procesarMensaje(TEL, n);
    eq(`equipo "${n}" no cae en stock`, !/listado de maquinaria/i.test(txt(rr)), txt(rr).slice(0, 60));
  }

  console.log('\n— enConversacion: el estado que usa index.js —');
  await alMenu();
  eq('en el menú, NO está en conversación (puede irse a cualquier lado)', enConversacion(TEL) === false);
  await procesarMensaje(TEL, '3');
  eq('adentro de reparaciones, sí', enConversacion(TEL) === true);
  eq('un teléfono sin sesión, no', enConversacion('5490000000000') === false);
  eq('con el prefijo whatsapp: también funciona', enConversacion('whatsapp:+' + TEL) === true);

  console.log('\n— El ruteo de index.js —');
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/index.js', 'utf8');
  const plano = src.replace(/\s+/g, ' ');
  eq('el pedido de stock respeta la conversación abierta',
    /!enConversacion\( ?telefono ?\) && await tienePedidoPendiente/.test(plano), 'falta el chequeo');
  eq('ya no depende del rango 1-6 (que dejaba afuera el 10)',
    !/\[1-6\]\$\/\.test\( ?mensaje/.test(plano), 'sigue el parche viejo');
  // Las demás sesiones se siguen chequeando antes que el pedido de stock.
  const iPend = plano.indexOf('tienePedidoPendiente( telefono )');
  for (const ses of ['tieneSesionCombustible', 'tieneSesionInsumos', 'tieneSesionStock',
                     'tieneSesionEstaciones', 'tieneSesionViajes']) {
    eq(`${ses} se chequea ANTES del pedido de stock`, plano.indexOf(ses) < iPend && plano.indexOf(ses) > 0);
  }

  console.log(`\n${ok} ok · ${mal} mal`);
  process.exit(mal ? 1 : 0);
})().catch(e => { console.error('✗ explotó:', e); process.exit(1); });
