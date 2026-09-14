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

  console.log('\n— enConversacion: lo que decide si el pedido de stock puede intervenir —');
  // Simula EXACTAMENTE la condición de index.js con un pedido de stock
  // pendiente: `!enConversacion(tel, msg) && pendiente`. Si da true, el
  // mensaje se lo lleva el stock y el capataz ve "mandame el listado".
  const seLoLlevaStock = (msg) => !enConversacion(TEL, msg) && true /* pendiente */;

  await alMenu();
  for (const op of ['1', '2', '3', '4', '5', '6']) {
    eq(`en el menú, la opción ${op} NO se la lleva el stock (bug de Ivar, 14-sep)`, !seLoLlevaStock(op));
  }
  eq('en el menú, un texto que no es opción SÍ puede ir al stock (ej: un listado)', seLoLlevaStock('3 motoguadañas N° 12, 15 y 21'));
  eq('en el menú, "hola" también puede ir al stock', seLoLlevaStock('hola'));

  await procesarMensaje(TEL, '3');                       // entra a reparaciones
  for (const msg of ['1', '10', '13', 'MG-045', 'se rompió el cable', 'hola', '3 motoguadañas']) {
    eq(`adentro de reparaciones, "${msg}" NO se lo lleva el stock (bug de Agustín, 12-sep)`, !seLoLlevaStock(msg), msg);
  }

  CONV._limpiar(TEL);
  eq('sin sesión, cualquier cosa puede ir al stock', seLoLlevaStock('3') && seLoLlevaStock('hola'));
  eq('un teléfono sin sesión, no está en conversación', enConversacion('5490000000000', '3') === false);
  await alMenu(); await procesarMensaje(TEL, '3');
  eq('con el prefijo whatsapp: también funciona', enConversacion('whatsapp:+' + TEL, 'x') === true);

  console.log('\n— EL LUNES: todos tienen pedido de stock pendiente (14-sep) —');
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/index.js', 'utf8');
  const plano = src.replace(/\s+/g, ' ');
  // Se extrae PIDE_MENU real y se simula la condición completa del ruteo:
  //   !enConversacion(tel, msg) && !PIDE_MENU.test(msg) && pendiente
  const mPM = src.match(/const PIDE_MENU =\s*(\/[^\n]+\/i);/);
  eq('existe PIDE_MENU', !!mPM);
  const PIDE_MENU = mPM ? new Function('return ' + mPM[1])() : /$^/;
  const lunes = (msg) => !enConversacion(TEL, msg) && !PIDE_MENU.test(msg.trim()) && true;
  CONV._limpiar(TEL);
  for (const m of ['hola', 'Hola', 'buenas', 'menu', 'Menu', 'MENU', 'buen dia', 'hey', 'hola!']) {
    eq(`"${m}" un lunes va al MENÚ, no al listado de stock`, !lunes(m), m);
  }
  eq('"sí" un lunes SÍ va al stock (es la confirmación del pedido)', lunes('sí'));
  eq('"si" también', lunes('si'));
  eq('"ok" también (es una respuesta, no un pedido de menú)', lunes('ok'));
  eq('un listado un lunes va al stock', lunes('3 motoguadañas N° 12, 15 y 21'));
  eq('"hola que tal como andas" NO es pedir el menú (frase larga): va al stock', lunes('hola que tal como andas'));

  await alMenu();
  const menu = await procesarMensaje(TEL, 'hola');
  eq('el menú se muestra con las 6 opciones', /Cargar combustible[\s\S]*Buscar estaci/i.test(txt(menu)));
  eq('index.js le agrega el aviso de stock pendiente al pie',
    /Tenés pendiente informar tu stock/.test(src) && /Respondé con el número/.test(src));

  console.log('\n— El ruteo de index.js —');
  eq('el pedido de stock respeta la conversación abierta Y los saludos',
    /!enConversacion\( ?telefono, ?mensaje ?\) &&[^&]*!PIDE_MENU\.test\( ?mensaje\.trim\(\) ?\) && await tienePedidoPendiente/.test(plano), 'falta alguno de los dos chequeos');
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
