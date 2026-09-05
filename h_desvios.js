// Harness de stock_desvios.js — la comparación semanal de stock.
// Usa el módulo REAL. Los casos son los del mockup aprobado el 04-sep, con
// los objetivos y números reales.

const D = require('./stock_desvios');
let ok = 0, mal = 0;
function eq(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

console.log('— Semana ISO (lunes) —');
eq('viernes 4/9/2026 → lunes 31/8', D.lunesDe('2026-09-04T15:00:00-03:00') === '2026-08-31', D.lunesDe('2026-09-04T15:00:00-03:00'));
eq('lunes 7/9 → lunes 7/9', D.lunesDe('2026-09-07T10:00:00-03:00') === '2026-09-07');
eq('domingo 6/9 → lunes 31/8 (la semana termina el domingo)', D.lunesDe('2026-09-06T23:00:00-03:00') === '2026-08-31', D.lunesDe('2026-09-06T23:00:00-03:00'));
eq('lunes 7/9 a las 01:00 UTC (domingo 22:00 en Córdoba) → 31/8', D.lunesDe('2026-09-07T01:00:00Z') === '2026-08-31', D.lunesDe('2026-09-07T01:00:00Z'));
eq('sumar 7 días', D.sumarDias('2026-08-31', 7) === '2026-09-07');
eq('fecha inválida → null', D.lunesDe('basura') === null);

// ── Cosquin: la 234 falta, la 212 está en el taller ────────────
const COS_ANT = { items: [{ tipo: 'Motoguadaña 291', cantidad: 17, numeros: ['213','211','235','212','210','224','239','234','221','22','220','218','227','sn','sn','218','236'] },
  { tipo: 'Motoguadaña', cantidad: 4, numeros: ['215','237','222','223'] }, { tipo: 'Extensible', cantidad: 1, numeros: [] }, { tipo: 'Motosierra', cantidad: 1, numeros: [] }] };
const COS_ACT = { items: [{ tipo: 'Motoguadaña 291', cantidad: 15, numeros: ['213','211','235','210','224','239','221','22','220','218','227','sn','sn','218','236'] },
  { tipo: 'Motoguadaña', cantidad: 4, numeros: ['215','237','222','223'] }, { tipo: 'Extensible', cantidad: 1, numeros: [] }, { tipo: 'Motosierra', cantidad: 1, numeros: [] }] };
const TALLER_COS = [{ id: 'i1', numero_unidad: '212', tipo_equipo: 'motoguadaña', fecha_ingreso_taller: '2026-09-03' }];

console.log('\n— Cosquin: 23 → 21 —');
let r = D.compararFotos(COS_ANT, COS_ACT, TALLER_COS);
eq('la 234 es FALTANTE', r.faltantes.some(f => f.numero === '234'), JSON.stringify(r.faltantes));
eq('la 212 está EN TALLER, no es faltante', r.taller.some(t => t.numero === '212') && !r.faltantes.some(f => f.numero === '212'));
eq('solo un faltante', r.faltantes.length === 1, String(r.faltantes.length));
eq('ningún nuevo', r.nuevos.length === 0);
eq('resumen: 23 → 21, 1 faltante, 1 taller', r.resumen.antes === 23 && r.resumen.ahora === 21 && r.resumen.faltantes === 1 && r.resumen.taller === 1, JSON.stringify(r.resumen));
eq('los "sn" y el 218 repetido no generan desvíos falsos', !r.faltantes.some(f => /sn|218/i.test(String(f.numero))) && !r.nuevos.length);

// ── UCC: la 31 al taller, T22 sin ingreso no aparece ───────────
const UCC_ANT = { items: [{ tipo: 'Motoguadaña', cantidad: 3, numeros: ['6','31','48'] }, { tipo: 'Minitractor', cantidad: 1, numeros: ['T22'] }, { tipo: 'Pala', cantidad: 2, numeros: [] }] };
const UCC_ACT = { items: [{ tipo: 'Motoguadaña', cantidad: 2, numeros: ['6','48'] }, { tipo: 'Minitractor', cantidad: 1, numeros: ['T22'] }, { tipo: 'Pala', cantidad: 2, numeros: [] }] };
console.log('\n— UCC: 6 → 5 —');
r = D.compararFotos(UCC_ANT, UCC_ACT, [{ id: 'i2', numero_unidad: '31', tipo_equipo: 'motoguadaña' }]);
eq('la 31 en taller', r.taller.length === 1 && r.taller[0].numero === '31');
eq('sin faltantes', r.faltantes.length === 0, JSON.stringify(r.faltantes));
r = D.compararFotos(UCC_ANT, UCC_ACT, []);
eq('sin ingreso en el taller, la 31 es FALTANTE', r.faltantes.length === 1 && r.faltantes[0].numero === '31');

// ── Fincas: sin número, solo cantidad ─────────────────────────
console.log('\n— Fincas del Sur: motosierra sin número, 2 → 1 —');
r = D.compararFotos({ items: [{ tipo: 'Motosierra', cantidad: 2, numeros: [] }] }, { items: [{ tipo: 'Motosierra', cantidad: 1, numeros: [] }] }, []);
eq('faltante por cantidad, sin número', r.faltantes.length === 1 && r.faltantes[0].numero === null && r.faltantes[0].cantidad === 1, JSON.stringify(r.faltantes));
eq('dice había 2, ahora 1', /había 2/.test(r.faltantes[0].detalle));
r = D.compararFotos({ items: [{ tipo: 'Motosierra', cantidad: 2, numeros: [] }] }, { items: [{ tipo: 'Motosierra', cantidad: 1, numeros: [] }] },
  [{ id: 'i3', numero_unidad: null, tipo_equipo: 'motosierra' }]);
eq('si hay una motosierra sin número en el taller, la absorbe', r.faltantes.length === 0 && r.taller.length === 1, JSON.stringify(r));

// ── Circunvalación: nueva ─────────────────────────────────────
console.log('\n— Circunvalación: aparece la 240 —');
r = D.compararFotos({ items: [{ tipo: 'Motoguadaña', cantidad: 2, numeros: ['233','222'] }] }, { items: [{ tipo: 'Motoguadaña', cantidad: 3, numeros: ['233','222','240'] }] }, []);
eq('la 240 es NUEVA', r.nuevos.length === 1 && r.nuevos[0].numero === '240');
eq('sin faltantes', r.faltantes.length === 0);

// ── Mismo número, otro nombre de tipo ─────────────────────────
console.log('\n— El capataz escribió el tipo distinto —');
r = D.compararFotos({ items: [{ tipo: 'Motoguadaña', cantidad: 1, numeros: ['50'] }] }, { items: [{ tipo: 'Motoguadaña Husqvarna', cantidad: 1, numeros: ['50'] }] }, []);
eq('la 50 no es faltante ni nueva (mismo número, otro nombre)', r.faltantes.length === 0 && r.nuevos.length === 0, JSON.stringify(r));

// ── Sin foto anterior ─────────────────────────────────────────
console.log('\n— Bordes —');
r = D.compararFotos(null, UCC_ACT, []);
eq('sin foto anterior: todo es nuevo, nada falta', r.faltantes.length === 0 && r.nuevos.length >= 3);
r = D.compararFotos(UCC_ANT, null, []);
eq('sin foto actual: nada se compara como faltante (no hay respuesta)', r.resumen.ahora === 0);
r = D.compararFotos(UCC_ANT, UCC_ANT, []);
eq('fotos iguales: sin desvíos', r.faltantes.length === 0 && r.nuevos.length === 0 && r.taller.length === 0);
r = D.compararFotos({ items: [{ tipo: 'X', cantidad: 1, numeros: ['A-1'] }] }, { items: [{ tipo: 'X', cantidad: 1, numeros: ['a1'] }] }, []);
eq('"A-1" y "a1" son el mismo número', r.faltantes.length === 0);

// ── Semanas seguidas faltando ─────────────────────────────────
console.log('\n— Cuántas semanas viene faltando —');
const fotosCos = [   // más reciente primero
  { semana: '2026-09-14', items: COS_ACT.items },
  { semana: '2026-09-07', items: COS_ACT.items },
  { semana: '2026-08-31', items: COS_ANT.items },
];
eq('la 234 lleva 2 semanas (14/9 y 7/9; el 31/8 estaba)', D.semanasFaltando(fotosCos, 'Motoguadaña 291', '234') === 2, String(D.semanasFaltando(fotosCos, 'Motoguadaña 291', '234')));
eq('una que nunca apareció cuenta desde la actual', D.semanasFaltando(fotosCos, 'X', '999') === 3);
eq('sin número → 1', D.semanasFaltando(fotosCos, 'Motosierra', null) === 1);

// ── Historial de una máquina ──────────────────────────────────
console.log('\n— Trazabilidad —');
const todas = [
  { semana: '2026-09-07', objetivo: 'Cosquin', objetivo_id: 'o1', items: COS_ACT.items, capataz_nombre: 'Leo' },
  { semana: '2026-08-31', objetivo: 'Cosquin', objetivo_id: 'o1', items: COS_ANT.items, capataz_nombre: 'Leo' },
  { semana: '2026-08-24', objetivo: 'Circunvalación', objetivo_id: 'o2', items: [{ tipo: 'Motoguadaña', cantidad: 1, numeros: ['234'] }], capataz_nombre: 'Leo' },
];
const h = D.historialMaquina(todas, '234');
eq('la 234 tiene 2 apariciones', h.length === 2, JSON.stringify(h));
eq('ordenadas de la más reciente a la más vieja', h[0].semana === '2026-08-31' && h[1].semana === '2026-08-24');
eq('muestra que antes estaba en OTRO objetivo', h[1].objetivo === 'Circunvalación');

console.log('\n— Los casos del primer reporte real (PDF del 04-sep) —');
// Fincas del Sur: 34 → 7. Gastón listó hasta el alicate en agosto y solo las máquinas en septiembre.
const FIN_AGO = { items: [
  { tipo: 'Motoguadaña', cantidad: 4, numeros: ['E10','E11','E12','E13'] }, { tipo: 'Motosierra', cantidad: 1, numeros: ['52YSN'] },
  { tipo: 'Extensible', cantidad: 1, numeros: ['STHILSNYECHOS2'] }, { tipo: 'fiat strada U12', cantidad: 1, numeros: ['U12'] },
  { tipo: 'Machete', cantidad: 2, numeros: [] }, { tipo: 'Pala de punta', cantidad: 2, numeros: [] }, { tipo: 'Pala ancha', cantidad: 2, numeros: [] },
  { tipo: 'Tijera de podar', cantidad: 1, numeros: [] }, { tipo: 'Podón', cantidad: 1, numeros: [] }, { tipo: 'Horquilla', cantidad: 2, numeros: [] },
  { tipo: 'Pinza', cantidad: 1, numeros: [] }, { tipo: 'Alicate', cantidad: 1, numeros: [] }, { tipo: 'Escalera', cantidad: 1, numeros: ['UNA'] },
] };
const FIN_SEP = { items: [{ tipo: 'Motoguadaña', cantidad: 4, numeros: ['10','11','12','13'] }, { tipo: 'Motosierra', cantidad: 1, numeros: ['52YSN'] }, { tipo: 'Extensible', cantidad: 1, numeros: [] }] };
r = D.compararFotos(FIN_AGO, FIN_SEP, []);
eq('Fincas: E10..E13 son 10..13 → NINGUNA motoguadaña falta', !r.faltantes.some(f => /^E?1[0-3]$/.test(String(f.numero))), JSON.stringify(r.faltantes));
eq('Fincas: ni son "nuevas"', !r.nuevos.some(f => /^1[0-3]$/.test(String(f.numero))), JSON.stringify(r.nuevos));
eq('Fincas: palas, machetes, pinzas NO son faltantes', !r.faltantes.some(f => /pala|machete|pinza|alicate|horquilla|tijera|podon|escalera/i.test(f.tipo)), JSON.stringify(r.faltantes.map(f => f.tipo)));
eq('Fincas: las herramientas se cuentan aparte (13 → 0: 12 de mano + la escalera)', r.herramientas.antes === 13 && r.herramientas.ahora === 0, JSON.stringify(r.herramientas));
eq('Fincas: la Strada U12 sí falta (vehículo con número que no volvió a listar)', r.faltantes.some(f => f.numero === 'U12'));

// Ayres: "extensible sthil Nº26" → "Extensible 26"
r = D.compararFotos({ items: [{ tipo: 'extensible sthil', cantidad: 1, numeros: ['Nº26'] }] }, { items: [{ tipo: 'Extensible', cantidad: 1, numeros: ['26'] }] }, []);
eq('Ayres: Nº26 es 26, no falta ni es nueva', r.faltantes.length === 0 && r.nuevos.length === 0, JSON.stringify(r));

// UCC: "Extensible ×1 s/n" → "Motosierra extensible ×1 s/n"
r = D.compararFotos({ items: [{ tipo: 'Extensible', cantidad: 1, numeros: [] }] }, { items: [{ tipo: 'Motosierra extensible', cantidad: 1, numeros: [] }] }, []);
eq('UCC: "Extensible" y "Motosierra extensible" son la misma familia → sin desvío', r.faltantes.length === 0 && r.nuevos.length === 0, JSON.stringify(r));

// Cañuelas: "Toyot Hilux 40" → "Toyota / Camioneta ×1 s/n"
r = D.compararFotos({ items: [{ tipo: 'Toyot Hilux', cantidad: 1, numeros: ['40'] }] }, { items: [{ tipo: 'Toyota / Camioneta', cantidad: 1, numeros: [] }] }, []);
eq('Cañuelas: la Hilux 40 pasa a "sin número": la numerada falta y aparece una sin número de la misma familia', r.faltantes.length === 1 && r.faltantes[0].numero === '40' && r.nuevos.length === 1 && r.nuevos[0].numero === null, JSON.stringify(r));

// Códigos de más de una letra se respetan
eq('"NM6" NO se reduce a "6" (dos letras: es código)', D.normNum('NM6') === 'NM6');
eq('"T22" queda "T22"', D.normNum('T22') === 'T22');
eq('"SH-16" tampoco', D.normNum('SH-16') === 'SH16');
eq('"E10" queda "E10" en normNum: la equivalencia con "10" se resuelve al comparar, dentro de la familia', D.normNum('E10') === 'E10');
r = D.compararFotos({ items: [{ tipo: 'Minitractor', cantidad: 1, numeros: ['T22'] }, { tipo: 'Motoguadaña', cantidad: 1, numeros: ['22'] }] },
  { items: [{ tipo: 'Minitractor', cantidad: 1, numeros: ['T22'] }] }, []);
eq('T22 (tractor) y 22 (motoguadaña): la 22 falta, el T22 no la cubre', r.faltantes.length === 1 && r.faltantes[0].numero === '22', JSON.stringify(r.faltantes));

console.log('\n— Clave de cierre —');
eq('misma máquina, misma clave', D.claveDesvio('o1', 'Motoguadaña 291', '234') === D.claveDesvio('o1', 'motoguadaña 291', ' 234 '));
eq('sin número, la clave es por tipo', D.claveDesvio('o1', 'Motosierra', null) === 'o1|motosierra|');

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
