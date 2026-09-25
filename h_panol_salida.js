// Harness de la salida de pañol (app_api.js + panol_reglas.js).
//
// 25-sep: quien entrega decide si la herramienta vuelve o no. El maestro dice
// lo habitual, pero un carretel de tanza figura retornable y no vuelve nunca.
//
// Lo crítico: marcar "no vuelve" NO puede hacer desaparecer una máquina del
// pañol. La validación tiene que mirar lo elegido, no el maestro.
const { validarSalidaPanol } = require('./panol_reglas.js');
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/app_api.js', 'utf8');
let ok = 0, mal = 0;
const eq = (n, c, d) => { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } };

console.log('— La validación mira lo ELEGIDO, no el maestro —');
eq('el endpoint valida con el flag elegido', /validarSalidaPanol\(\{ \.\.\.item, retornable: vuelve \}\)/.test(src));
eq('"vuelve" sale del body, con el maestro como respaldo', /b\.vuelve === undefined \? !!item\.retornable : b\.vuelve === true/.test(src));
eq('la fecha se exige según lo elegido', /if \(vuelve && !b\.retorno_previsto\)/.test(src));
eq('el estado sale de lo elegido', /estado: vuelve \? 'afuera' : 'consumido'/.test(src));
eq('la fecha de retorno también', /retorno_previsto: vuelve \? b\.retorno_previsto : null/.test(src));

console.log('\n— Qué se frena y qué no —');
const v = (nombre, categoria, vuelve) => !!validarSalidaPanol({ nombre, categoria, retornable: vuelve });
eq('un carretel marcado "no vuelve" pasa', !v('carretel de tanza', 'consumible', false));
eq('una pala marcada "no vuelve" pasa', !v('pala ancha', 'consumible', false));
eq('una motosierra marcada "no vuelve" SE FRENA', v('Motosierra MS250', 'herramienta', false));
eq('una motoguadaña marcada "no vuelve" SE FRENA', v('Motoguadaña 48', 'herramienta', false));
eq('cualquier cosa que vuelve pasa', !v('Motosierra MS250', 'herramienta', true) && !v('pala', 'consumible', true));

console.log('\n— El formulario —');
const app = fs.readFileSync(__dirname + '/app.html', 'utf8');
eq('hay botones Vuelve / No vuelve', /🔄 Vuelve/.test(app) && /✓ No vuelve/.test(app));
eq('arranca con lo que dice el maestro', /vuelve:!!it\.retornable/.test(app));
eq('la fecha solo aparece si vuelve', /\$\{s\.vuelve\?`/.test(app));
eq('hay atajos de fecha', /Mañana/.test(app) && /En 1 semana/.test(app));
eq('la cantidad tiene botones + y −', /function pnCant\(d\)/.test(app));
eq('la cantidad no se pasa del disponible', /Math\.min\(Number\(s\.item\.disponible\)\|\|1/.test(app));
eq('el objetivo se resalta mientras falta', /s\.objetivo_id\?'':'border-color:#D98A1F/.test(app));
eq('se manda "vuelve" al guardar', /vuelve:s\.vuelve,/.test(app));
eq('sin fecha no deja guardar si vuelve', /if\(s\.vuelve&&!body\.retorno_previsto\)/.test(app));

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
