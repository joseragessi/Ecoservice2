// Harness de la reincidencia de Performance (panel.js).
//
// Extrae el bloque REAL que calcula base90 / rebotes / anteriores / descartes
// y lo corre con los helpers mínimos que usa. Cubre la decisión del 03-sep:
// un rebote cuenta solo en el mes en que la máquina volvió; al mes siguiente
// se muestra pero no bloquea el bono.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/panel.js', 'utf8');

const ini = src.indexOf('  // REINCIDENCIA DEL MES');
const fin = src.indexOf('  const base90PorMec={};');
if (ini < 0 || fin < 0 || fin < ini) { console.error('✗ No encontré el bloque de reincidencia en panel.js'); process.exit(1); }
const bloque = src.slice(ini, fin);

// Helpers tal como los usa el bloque (versiones mínimas equivalentes).
function calcular(perfPer, corte, fin, todas) {
  const ctx = `
    const MS30=30*86400000;
    const esPrev=r=>r.tipo_mant==='preventivo';
    const tieneNumero=v=>!!String(v||'').replace(/\\D/g,'');
    const normU=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    const normTipo=v=>String(v||'').toLowerCase().trim();
    const nomMec=r=>r.mecanico||null;
  `;
  const f = new Function('perfPer', 'corte', 'fin', 'todas', ctx + bloque + '\nreturn {base90, rebotes, anteriores, descartes};');
  return f(perfPer, corte, fin, todas);
}

let ok = 0, mal = 0;
function eq(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}
const d = s => new Date(s).getTime();
const corteSep = d('2026-09-03T15:00:00Z');   // mes en curso: hoy
const corteAgo = d('2026-09-01T02:59:59Z');   // último instante de agosto en Córdoba

// ── El caso de Diego: tres rebotes de agosto que en septiembre siguen bloqueando ──
const T13base  = { id: 'b1', mecanico: 'Diego Allende', tipo_equipo: 'Tractor', numero_unidad: 'T13', tipo_falla: 'Otro', estado: 'finalizado', fecha_finalizado: '2026-08-05T12:00:00Z', created_at: '2026-08-01T10:00:00Z' };
const T13vuelta= { id: 'v1', mecanico: 'Sebastián Layus', tipo_equipo: 'Tractor', numero_unidad: 'T13', tipo_falla: 'Otro', estado: 'en_reparacion', created_at: '2026-08-14T10:00:00Z' };
const P3base   = { id: 'b2', mecanico: 'Diego Allende', tipo_equipo: 'Extensible', numero_unidad: 'P3', tipo_falla: 'Ingreso taller', estado: 'finalizado', fecha_finalizado: '2026-08-20T12:00:00Z', created_at: '2026-08-18T10:00:00Z' };
const P3vuelta = { id: 'v2', mecanico: 'Leo Godoy', tipo_equipo: 'Extensible', numero_unidad: 'P3', tipo_falla: 'Ingreso taller', estado: 'pendiente', created_at: '2026-08-20T18:00:00Z' };
const t12base  = { id: 'b3', mecanico: 'Diego Allende', tipo_equipo: 'Tractor', numero_unidad: 't12', tipo_falla: 'No arranca', estado: 'finalizado', fecha_finalizado: '2026-08-10T12:00:00Z', created_at: '2026-08-08T10:00:00Z' };
const t12vuelta= { id: 'v3', mecanico: 'Diego Allende', tipo_equipo: 'Tractor', numero_unidad: 't12', tipo_falla: 'No arranca', estado: 'finalizado', fecha_finalizado: '2026-08-30T12:00:00Z', created_at: '2026-08-24T10:00:00Z' };
// Otras finalizadas de agosto sin rebote (para el denominador)
const otras = Array.from({ length: 14 }, (_, i) => ({ id: 'o' + i, mecanico: 'Diego Allende', tipo_equipo: 'Motoguadaña', numero_unidad: String(100 + i),
  tipo_falla: 'Otro', estado: 'finalizado', fecha_finalizado: `2026-08-${String(3 + i).padStart(2, '0')}T12:00:00Z`, created_at: `2026-08-0${1 + (i % 2)}T10:00:00Z` }));

const todasAgo = [T13base, T13vuelta, P3base, P3vuelta, t12base, t12vuelta, ...otras];
const finAgo = todasAgo.filter(r => r.estado === 'finalizado' && r.fecha_finalizado);

console.log('— AGOSTO: los tres rebotes cuentan en su mes —');
let r = calcular('2026-08', corteAgo, finAgo, todasAgo);
eq('3 rebotes en agosto', (r.rebotes['Diego Allende'] || []).length === 3, JSON.stringify(Object.keys(r.rebotes)));
eq('ninguno como "anterior" en agosto', !r.anteriores['Diego Allende']);
eq('denominador: 18 reparaciones (3 base + 14 otras + la vuelta del t12, que también se cerró)', r.base90.length === 18, String(r.base90.length));
eq('reincidencia agosto = 17% (3 de 18)', Math.round(3 * 100 / r.base90.length) === 17);

console.log('\n— SEPTIEMBRE: los mismos tres NO vuelven a contar —');
r = calcular('2026-09', corteSep, finAgo, todasAgo);
eq('0 rebotes que cuenten en septiembre', !(r.rebotes['Diego Allende'] || []).length, JSON.stringify(r.rebotes));
eq('los 3 aparecen como "de meses anteriores"', (r.anteriores['Diego Allende'] || []).length === 3, String((r.anteriores['Diego Allende'] || []).length));
eq('llevan la fecha de la vuelta para mostrar en qué mes impactaron', (r.anteriores['Diego Allende'] || []).every(x => x.fechaVuelta));
// Denominador de septiembre: cerradas desde el 2/8 (30 días antes del 1/9) hasta hoy.
eq('el denominador de septiembre son las que podían volver este mes (cerradas desde 30 d antes del 1/9)',
  r.base90.every(f => d(f.fecha_finalizado) >= d('2026-09-01T03:00:00Z') - 30 * 86400000), String(r.base90.length));
eq('una cerrada el 5/8 SÍ está en el de septiembre (podía volver hasta el 4/9)', r.base90.some(f => f.id === 'b1'));
eq('una cerrada el 20/8 SÍ está (todavía podía volver en septiembre)', r.base90.some(f => f.id === 'b2'));
const viejaJul = { id: 'bv', mecanico: 'Diego Allende', tipo_equipo: 'Tractor', numero_unidad: 'T99', tipo_falla: 'Otro', estado: 'finalizado', fecha_finalizado: '2026-08-01T12:00:00Z', created_at: '2026-07-28T10:00:00Z' };
const rv = calcular('2026-09', corteSep, [...finAgo, viejaJul], [...todasAgo, viejaJul]);
eq('una cerrada el 1/8 NO está en el de septiembre (su plazo de rebote venció el 31/8)', !rv.base90.some(f => f.id === 'bv'));

console.log('\n— Un rebote NUEVO en septiembre sí cuenta —');
const M50base   = { id: 'b9', mecanico: 'Diego Allende', tipo_equipo: 'Motoguadaña', numero_unidad: '50', tipo_falla: 'Otro', estado: 'finalizado', fecha_finalizado: '2026-08-28T12:00:00Z', created_at: '2026-08-26T10:00:00Z' };
const M50vuelta = { id: 'v9', mecanico: 'Leo Godoy', tipo_equipo: 'Motoguadaña', numero_unidad: '50', tipo_falla: 'Otro', estado: 'pendiente', created_at: '2026-09-02T10:00:00Z' };
let todasSep = [...todasAgo, M50base, M50vuelta];
r = calcular('2026-09', corteSep, todasSep.filter(x => x.estado === 'finalizado' && x.fecha_finalizado), todasSep);
eq('la motoguadaña 50 que volvió el 2/9 cuenta en septiembre', (r.rebotes['Diego Allende'] || []).some(x => x.uni === '50'));
eq('y es el ÚNICO rebote de septiembre', (r.rebotes['Diego Allende'] || []).length === 1, String((r.rebotes['Diego Allende'] || []).length));
eq('los tres de agosto siguen como anteriores', (r.anteriores['Diego Allende'] || []).length === 3);

console.log('\n— Segunda vuelta dentro del mes después de una en el mes anterior —');
// La T13 volvió el 14/8 (contó en agosto). Si vuelve OTRA vez el 3/9 con la misma
// falla y dentro de los 30 d de la base... la base cerró el 5/8, 3/9 son 29 días: sí.
const T13vuelta2 = { id: 'v1b', mecanico: 'Diego Allende', tipo_equipo: 'Tractor', numero_unidad: 'T13', tipo_falla: 'Otro', estado: 'pendiente', created_at: '2026-09-03T10:00:00Z' };
todasSep = [...todasAgo, T13vuelta2];
r = calcular('2026-09', corteSep, finAgo, todasSep);
// Es una reincidencia NUEVA: la de agosto ya contó en agosto; esta es otra vuelta,
// dentro del mes, con la misma falla. Es exactamente "si la reincidencia es nueva, sí".
eq('la SEGUNDA vuelta de T13, en septiembre, cuenta como rebote nuevo', (r.rebotes['Diego Allende'] || []).some(x => x.uni === 'T13' && x.idVuelta === 'v1b'));
eq('la primera (de agosto) sigue como anterior', (r.anteriores['Diego Allende'] || []).some(x => x.idVuelta === 'v1'));

console.log('\n— Descartes siguen funcionando —');
const descartada = { ...T13vuelta, id: 'v1d', rebote_descartado: true, rebote_motivo: 'se reprograma' };
r = calcular('2026-08', corteAgo, finAgo, [T13base, descartada, ...otras]);
eq('un rebote descartado a mano no cuenta y va a descartes', !(r.rebotes['Diego Allende'] || []).length && (r.descartes['Diego Allende'] || []).length === 1);
const otraFalla = { ...t12vuelta, id: 'v3f', tipo_falla: 'Pistón' };
r = calcular('2026-08', corteAgo, finAgo, [t12base, otraFalla, ...otras]);
eq('fallas específicas distintas se descartan solas', (r.descartes['Diego Allende'] || []).some(x => x.por === 'auto'));

console.log('\n— Bordes —');
r = calcular('2026-09', corteSep, [], []);
eq('sin datos no rompe', r.base90.length === 0 && !Object.keys(r.rebotes).length);
const sinNum = { ...T13base, id: 'sn', numero_unidad: 'sn' };
r = calcular('2026-08', corteAgo, [sinNum], [sinNum, T13vuelta]);
eq('una reparación sin número de máquina no entra al denominador', r.base90.length === 0);

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
