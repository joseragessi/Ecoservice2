// Harness del stock por WhatsApp (stock.js, stock_recordatorio.js, index.js).
//
// Cubre lo decidido el 04-sep: el pedido sale todos los lunes, el listado
// que recibe el capataz marca lo que está en el taller, un listado largo (el
// de UCC) se toma como listado nuevo y no como "ajuste", y un mensaje que se
// pasa del tope de WhatsApp se manda en partes sin cortar un renglón.

process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'x';
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32);

function clienteFalso() {
  return { from: () => { const q = { select() { return q; }, eq() { return q; }, neq() { return q; }, not() { return q; }, order() { return q; }, limit() { return q; },
    then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); }, async single() { return { data: null }; }, async maybeSingle() { return { data: null }; } }; return q; } };
}
require.cache[require.resolve('./supabase.js')] = { id: 'sb', filename: 'sb', loaded: true, exports: clienteFalso() };
require.cache[require.resolve('./sesion.js')] = { id: 'ses', filename: 'ses', loaded: true, exports: { conPersistencia: (n, s, f) => f, restaurar: async () => null } };

const S = require('./stock.js');
const R = require('./stock_recordatorio.js');
const fs = require('fs');

let ok = 0, mal = 0;
function eq(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

console.log('— Cadencia —');
eq('se pide los lunes', R.DIA_ENVIO === 1);
eq('a las 8 de la mañana', R.HORA_ENVIO === 8);
eq('cada 7 días para los dos grupos', R.DIAS.deposito === 7 && R.DIAS.privado === 7);

console.log('\n— El listado marca lo que está en el taller —');
const items = [
  { tipo: 'Motoguadaña', cantidad: 3, numeros: ['6', '31', '48'], numeros_taller: ['31'], en_taller_sin_numero: 0 },
  { tipo: 'Motosierra 250', cantidad: 1, numeros: ['11'], numeros_taller: [], en_taller_sin_numero: 0 },
  { tipo: 'Tractor', cantidad: 1, numeros: [], observacion: 'Pauny 125P', numeros_taller: [], en_taller_sin_numero: 1 },
  { tipo: 'Pala', cantidad: 2, numeros: [] },
];
const txt = S._listado(items);
eq('la 31 lleva el 🔧', /31 🔧/.test(txt), txt);
eq('la 6 y la 48 no', /N° 6, 31 🔧, 48/.test(txt), txt);
eq('el tractor sin número dice "1 en el taller"', /Tractor ×1 _\(1 en el taller\)_/.test(txt), txt);
eq('la observación se conserva', /Pauny 125P/.test(txt));
eq('un ítem sin campos de taller no rompe', /Pala ×2/.test(txt));
eq('contarTaller suma número + sin número', S._contarTaller(items) === 2, String(S._contarTaller(items)));

console.log('\n— Listado completo vs ajuste —');
const UCC = fs.readFileSync(__filename, 'utf8').includes('LISTADO_UCC') ? `3 motoguadañas N 6,31,48
1 sopladora mochila N 9
1 motosierra 250 N 11
1 motosierra extensible husvarnas
1 cargador de batería husvarnas con 2 baterías
1 compresor fema
1 mochila pulverizadora N sh-16
1 minitractor johh Deere N T22
1 tractor pouny 125p
1 carro N 101cyg755` : '';
eq('el listado de UCC (10+ renglones) es listado completo', S._esListadoCompleto(UCC));
eq('"la 21 no está" es un ajuste', !S._esListadoCompleto('la 21 no está'));
eq('"agregá 2 motosierras la 12 y la 15" es un ajuste', !S._esListadoCompleto('agregá 2 motosierras la 12 y la 15'));
eq('"sí" es un ajuste (confirmación)', !S._esListadoCompleto('sí'));
eq('5 renglones con cantidad es listado completo', S._esListadoCompleto('3 motoguadañas\n1 tractor\n2 palas\n1 pico\n1 rastrillo'));
eq('4 renglones cortos es ajuste', !S._esListadoCompleto('3 motoguadañas\n1 tractor\n2 palas\n1 pico'));
eq('un mensaje largo sin renglones también cuenta como completo', S._esListadoCompleto('tengo 3 motoguadañas la 6 la 31 y la 48, una sopladora la 9, una motosierra 250 la 11, una motosierra extensible husqvarna, un cargador de bateria con dos baterias, un compresor fema, una mochila pulverizadora sh-16, un minitractor john deere t22, un tractor pauny, un carro, una desmalezadora funes, una cisterna'));

console.log('\n— Faltantes al mandar el listado completo de nuevo —');
const previos = [{ tipo: 'Motoguadaña', cantidad: 3, numeros: ['6', '31', '48'] }, { tipo: 'Tractor', cantidad: 1, numeros: [] }];
const nuevos = [{ tipo: 'Motoguadaña', cantidad: 2, numeros: ['6', '48'] }, { tipo: 'Tractor', cantidad: 1, numeros: [] }];
const f = S._detectarFaltantes(previos, nuevos);
eq('detecta que falta la 31', f.some(x => String(x.numero) === '31'), JSON.stringify(f));
eq('no marca el tractor', !f.some(x => /tractor/i.test(x.tipo)));

console.log('\n— Partir mensajes largos (index.js) —');
const src = fs.readFileSync(__dirname + '/index.js', 'utf8');
const ini = src.indexOf('function partirMensaje');
const fin = src.indexOf('\n}\n', ini) + 3;
const partirMensaje = new Function(src.slice(ini, fin) + '\nreturn partirMensaje;')();
eq('un mensaje corto va entero', partirMensaje('hola').length === 1 && partirMensaje('hola')[0] === 'hola');
const largo = Array.from({ length: 200 }, (_, i) => `  • Motoguadaña ×1 — N° ${100 + i}`).join('\n');
const partes = partirMensaje(largo);
eq('un listado de 200 renglones se parte', partes.length > 1, String(partes.length));
eq('ninguna parte pasa de 3.600 caracteres', partes.every(p => p.length <= 3600), partes.map(p => p.length).join(','));
eq('no se corta un renglón a la mitad', partes.every(p => !/N° \d{1,2}$/.test(p.replace(/\n_\(\d+\/\d+\)_$/, ''))));
eq('cada parte lleva su número (1/2, 2/2)', partes.every((p, i) => new RegExp(`\\(${i + 1}/${partes.length}\\)`).test(p)));
eq('todos los renglones llegan', partes.join('\n').split('N° ').length - 1 === 200);
eq('vacío no rompe', partirMensaje('').length === 1);

console.log('\n— El webhook responde 200 antes de procesar —');
const posIn = src.indexOf('[IN]');
const pos200 = src.indexOf('res.sendStatus(200);', posIn);
const posResp = src.indexOf('let respuesta;', posIn);
eq('el 200 está antes de empezar a procesar', pos200 > 0 && pos200 < posResp);
eq('ya no hay sendStatus después de messages.create', src.indexOf('res.sendStatus', src.indexOf('partirMensaje(respuesta)')) === -1);

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
// LISTADO_UCC
