// Harness de las dormidas del puntaje (panel.js).
//
// Extrae el bloque REAL y lo corre con los datos del 11-sep, cuando José
// pidió la corrección: de 49 reparaciones abiertas, 18 contaban como dormidas
// y 14 de esas NUNCA habían entrado al taller. Carlos Gonzalez perdía 12
// puntos sobre un objetivo de 30 por máquinas que seguían en el objetivo.
//
// La regla nueva: el reloj arranca en el INGRESO AL TALLER. Lo que sigue en
// el objetivo no resta — el mecánico no lo puede tocar.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/panel.js', 'utf8');
const ini = src.indexOf('  // Dormidas AL CORTE:');
const fin = src.indexOf('  // Puntaje del mes,', ini);
if (ini < 0 || fin < 0) { console.error('✗ No encontré el bloque de dormidas'); process.exit(1); }

function calcular(todas, corte) {
  const ctx = `
    const PERF_DORMIDA_DIAS = 7;
    const nomMec = r => r.mecanico || null;
    const diasEntre = (a, b) => (!a || !b) ? null : (new Date(b) - new Date(a)) / 86400000;
  `;
  return new Function('todas', 'corte', ctx + src.slice(ini, fin) + '\nreturn {dormidas, sinIngresar};')(todas, corte);
}

let ok = 0, mal = 0;
function eq(n, c, d) { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } }
const hoy = new Date('2026-09-11T20:00:00Z').getTime();
const hace = d => new Date(hoy - d * 86400000).toISOString();
const inc = (o) => ({ estado: 'pendiente', mecanico: 'Carlos Gonzalez', created_at: hace(20),
  fecha_ingreso_taller: null, tipo_equipo: 'Tractor', numero_unidad: 'T1', ...o });

console.log('— El caso que motivó el cambio —');
// La U21: reportada hace 18 días, nunca entró al taller.
let r = calcular([inc({ tipo_equipo: 'Toyota / Camioneta', numero_unidad: 'U21', created_at: hace(18), fecha_ingreso_taller: null })], hoy);
eq('una máquina que nunca llegó al taller NO resta', !(r.dormidas['Carlos Gonzalez'] || []).length, JSON.stringify(r.dormidas));
eq('pero se anota aparte para reclamarle al capataz', (r.sinIngresar['Carlos Gonzalez'] || []).length === 1, JSON.stringify(r.sinIngresar));
eq('con los días desde que se reportó', r.sinIngresar['Carlos Gonzalez'][0].dias >= 17.9);

console.log('\n— Lo que sí resta —');
r = calcular([inc({ created_at: hace(20), fecha_ingreso_taller: hace(15) })], hoy);
eq('15 días en el taller → dormida', (r.dormidas['Carlos Gonzalez'] || []).length === 1);
eq('cuenta los días DESDE EL INGRESO, no desde el reporte', Math.round(r.dormidas['Carlos Gonzalez'][0].dias) === 15, String(r.dormidas['Carlos Gonzalez'][0].dias));
eq('y guarda aparte los días desde el reporte', Math.round(r.dormidas['Carlos Gonzalez'][0].desde_reporte) === 20);

console.log('\n— El borde de los 7 días —');
r = calcular([inc({ created_at: hace(30), fecha_ingreso_taller: hace(5) })], hoy);
eq('5 días en el taller NO resta, aunque lleve 30 reportada', !(r.dormidas['Carlos Gonzalez'] || []).length, JSON.stringify(r.dormidas));
r = calcular([inc({ created_at: hace(30), fecha_ingreso_taller: hace(8) })], hoy);
eq('8 días en el taller sí resta', (r.dormidas['Carlos Gonzalez'] || []).length === 1);
r = calcular([inc({ created_at: hace(30), fecha_ingreso_taller: hace(7) })], hoy);
eq('exactamente 7 días no resta (tiene que ser MÁS de 7)', !(r.dormidas['Carlos Gonzalez'] || []).length);

console.log('\n— Lo que ya estaba y no cambia —');
r = calcular([inc({ estado: 'esperando_repuestos', fecha_ingreso_taller: hace(20) })], hoy);
eq('esperando repuestos nunca resta', !(r.dormidas['Carlos Gonzalez'] || []).length);
r = calcular([inc({ motivo_cierre: 'nunca llegó', fecha_ingreso_taller: hace(20) })], hoy);
eq('cerrada sin reparar no resta', !(r.dormidas['Carlos Gonzalez'] || []).length);
r = calcular([inc({ estado: 'finalizado', fecha_finalizado: hace(10), fecha_ingreso_taller: hace(25) })], hoy);
eq('finalizada antes del corte no resta', !(r.dormidas['Carlos Gonzalez'] || []).length);
r = calcular([inc({ estado: 'finalizado', fecha_finalizado: hace(-2), fecha_ingreso_taller: hace(25) })], hoy);
eq('finalizada DESPUÉS del corte sí resta (ese día estaba abierta)', (r.dormidas['Carlos Gonzalez'] || []).length === 1);
r = calcular([inc({ created_at: hace(-3), fecha_ingreso_taller: hace(-2) })], hoy);
eq('una reportada después del corte no cuenta', !(r.dormidas['Carlos Gonzalez'] || []).length && !(r.sinIngresar['Carlos Gonzalez'] || []).length);

console.log('\n— Un ingreso posterior al corte no vale —');
r = calcular([inc({ created_at: hace(20), fecha_ingreso_taller: hace(-1) })], hoy);
eq('si entró al taller DESPUÉS del corte, ese día no estaba', !(r.dormidas['Carlos Gonzalez'] || []).length);
eq('y figura como no ingresada', (r.sinIngresar['Carlos Gonzalez'] || []).length === 1);

console.log('\n— Sin mecánico asignado —');
r = calcular([inc({ mecanico: null, fecha_ingreso_taller: hace(15) })], hoy);
eq('cae en "Sin asignar"', (r.dormidas['Sin asignar'] || []).length === 1, JSON.stringify(Object.keys(r.dormidas)));

console.log('\n— Los datos reales del 11-sep —');
const reales = [
  // Carlos Gonzalez: 6 dormidas viejas, 5 sin ingreso
  inc({ mecanico: 'Carlos Gonzalez', numero_unidad: 'u26',  created_at: hace(21), fecha_ingreso_taller: null }),
  inc({ mecanico: 'Carlos Gonzalez', numero_unidad: 'U21',  created_at: hace(18), fecha_ingreso_taller: null }),
  inc({ mecanico: 'Carlos Gonzalez', numero_unidad: 'Moto', created_at: hace(16), fecha_ingreso_taller: null }),
  inc({ mecanico: 'Carlos Gonzalez', numero_unidad: 'U19',  created_at: hace(15), fecha_ingreso_taller: null }),
  inc({ mecanico: 'Carlos Gonzalez', numero_unidad: 'Desm', created_at: hace(8),  fecha_ingreso_taller: null }),
  inc({ mecanico: 'Carlos Gonzalez', numero_unidad: 'T99',  created_at: hace(20), fecha_ingreso_taller: hace(12) }),
];
r = calcular(reales, hoy);
eq('Carlos pasa de 6 dormidas a 1', (r.dormidas['Carlos Gonzalez'] || []).length === 1, String((r.dormidas['Carlos Gonzalez'] || []).length));
eq('de −12 puntos a −2', (r.dormidas['Carlos Gonzalez'] || []).length * -2 === -2);
eq('y quedan 5 para reclamarle al capataz', (r.sinIngresar['Carlos Gonzalez'] || []).length === 5, String((r.sinIngresar['Carlos Gonzalez'] || []).length));

console.log('\n— Bordes —');
r = calcular([], hoy);
eq('sin datos no rompe', Object.keys(r.dormidas).length === 0 && Object.keys(r.sinIngresar).length === 0);
r = calcular([inc({ created_at: null, fecha_ingreso_taller: null })], hoy);
eq('sin fecha de reporte no rompe', typeof r.dormidas === 'object');

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
