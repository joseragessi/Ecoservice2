// Harness del ticket en la app del capataz (app_api.js + app.html).
//
// Dos cosas del 14-sep:
//   1. Que la ficha del comprobante traiga lote, tarjeta, km y productos,
//      para que el capataz confirme antes de repartir.
//   2. Que el COMBUSTIBLE se detecte bien y se pueda corregir. José: "el
//      ticket dice gasoil y lo carga como súper nafta". No es cosmético: el
//      capataz reparte por combustible, y a un tractor no le aparece el
//      bloque de súper. Si el producto está mal, se traba.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/app_api.js', 'utf8');
// La función REAL que clasifica el combustible.
const ini = src.indexOf('const tipoDe = (producto) => {');
const fin = src.indexOf('};', src.indexOf('return \'desconocido\';', ini)) + 2;
if (ini < 0) { console.error('✗ No encontré tipoDe en app_api.js'); process.exit(1); }
const tipoDe = new Function('const norm = s => String(s || "").toUpperCase();\n' + src.slice(ini, fin) + '\nreturn tipoDe;')();

let ok = 0, mal = 0;
function eq(n, c, d) { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } }

console.log('— Gasoil: todos los nombres comerciales que aparecen en los tickets —');
['GASOIL', 'GAS OIL GRADO 2', 'V-POWER DIESEL', 'ION PUMA DIESEL', 'EVOLUX DIESEL',
 'UPOWER DIESEL', 'INFINIA DIESEL', 'SHELL BYOLLUM DIESEL', 'ION DIESEL', 'ULTRA DIESEL',
 'Diesel 500', 'gasoil grado 3'].forEach(p => {
  eq(`"${p}" → gasoil`, tipoDe(p) === 'gasoil', tipoDe(p));
});

console.log('\n— Súper —');
['SUPER', 'PUMA SUPER', 'Nafta super', 'NAFTA SUPER', 'INFINIA', 'V-POWER NAFTA',
 'PREMIUM', 'nafta premium'].forEach(p => {
  eq(`"${p}" → súper`, tipoDe(p) === 'super', tipoDe(p));
});

console.log('\n— EL BUG: no confundir uno con otro —');
// La regla vieja era "si dice SUPER o NAFTA es súper, si no gasoil", y
// mandaba a gasoil cualquier cosa rara.
eq('"V-POWER DIESEL" NO es súper (tiene V-POWER, que también es nafta)', tipoDe('V-POWER DIESEL') === 'gasoil');
eq('"INFINIA DIESEL" NO es súper', tipoDe('INFINIA DIESEL') === 'gasoil');
eq('"ION DIESEL" NO es súper', tipoDe('ION DIESEL') === 'gasoil');
eq('"V-POWER NAFTA" sí es súper', tipoDe('V-POWER NAFTA') === 'super');
eq('"INFINIA" sola es súper', tipoDe('INFINIA') === 'super');

console.log('\n— Lo que no se reconoce queda para preguntar —');
['BIDON X 10 LTS', 'ACEITE 2T', 'ADITIVO', 'lubricante', ''].forEach(p => {
  eq(`"${p}" → desconocido (lo elige el capataz)`, tipoDe(p) === 'desconocido', tipoDe(p));
});
eq('null no rompe', tipoDe(null) === 'desconocido');

console.log('\n— El endpoint devuelve lo que la ficha necesita —');
const iL = src.indexOf("router.post('/api/app/capataz/combustible/leer'");
const bloque = src.slice(iL, src.indexOf('router.post', iL + 10));
['es_tarjeta', 'lote', 'tarjeta', 'km_actual', 'productos', 'hay_dudas'].forEach(c => {
  eq(`devuelve ${c}`, new RegExp('\\b' + c + '\\b').test(bloque), 'falta');
});
eq('NO devuelve el saldo (es info de administración)', !/saldo/.test(bloque));
eq('cada producto trae su tipo de combustible', /tipo: t/.test(bloque));
eq('lo desconocido suma a gasoil para que los totales cierren', /tipos\.gasoil \+ tipos\.desconocido/.test(bloque));

console.log('\n— La app: confirmar antes de repartir —');
const app = fs.readFileSync(__dirname + '/app.html', 'utf8');
eq('existe el paso de confirmación', /function renderCapConfirmar\(\)/.test(app));
eq('después de leer la foto va a confirmar, no a repartir', /capPaso='confirmar';render\(\)/.test(app));
eq('se puede corregir el combustible de cada producto', /function capTipoProd\(/.test(app));
eq('corregirlo recalcula los totales por tipo', /capData\.litros=\{gasoil:/.test(app));
eq('no deja repartir con un combustible sin definir', /some\(p=>p\.tipo==='desconocido'\)\)\{toast/.test(app));
eq('muestra el kilometraje sin la diferencia', /Kilometraje/.test(app) && !/km desde la anterior/.test(app));
eq('NO muestra el saldo', !/Saldo/.test(app));
eq('la tarjeta muestra a qué unidad corresponde', /function capUnidadDeTarjeta\(\)/.test(app));
eq('avisa si la tarjeta no está asignada', /no está cargada/.test(app));
eq('los renglones se arman DESPUÉS de confirmar', /function capIrRepartir\(\)/.test(app) && /capUnidad=\{gasoil:capData\.litros\.gasoil>0/.test(app));

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
