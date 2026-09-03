// Harness de cruzarTaller (panel_api.js) — qué máquinas del censo están en el taller.
// Extrae la función REAL del archivo; no reescribirla acá.
//
// Por qué importa: de esto sale el "disponibles" que José va a usar para saber
// con qué máquinas cuenta cada objetivo. Un match de más deja stock fantasma;
// uno de menos esconde una máquina parada. Los casos usan el censo real de
// 08/2026, incluidos sus números repetidos y sin numerar.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/panel_api.js', 'utf8');

const ini = src.indexOf('function normNum(v)');
const fin = src.indexOf("router.get('/api/stock/general'");
if (ini < 0 || fin < 0 || fin < ini) {
  console.error('✗ No encontré cruzarTaller en panel_api.js — cambió el archivo, revisá el harness');
  process.exit(1);
}
const { familiaConsumo } = require('./familias_consumo');
const cruzarTaller = new Function('familiaConsumo',
  src.slice(ini, fin) + '\nreturn cruzarTaller;')(familiaConsumo);

let ok = 0, mal = 0;
function chequear(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

const COSQUIN = 'obj-cosquin', CIRCUN = 'obj-circun', CHACRAS = 'obj-chacras';
const fila = (o, tipo, cant, numeros) => ({ objetivo_id: o, tipo, cantidad: cant, numeros: numeros || [] });
const inc = (id, o, num, tipo, extra) => Object.assign(
  { id, objetivo_id: o, numero_unidad: num, tipo_equipo: tipo, estado: 'en_reparacion', created_at: '2026-08-28' }, extra || {});

// ── Caso base: una máquina numerada entra al taller ───────────
let filas = [fila(CHACRAS, 'Motoguadaña', 5, ['50','51','45','49','47'])];
cruzarTaller(filas, [inc('i1', CHACRAS, '45', 'motoguadaña')]);
chequear('la 45 se marca en el taller', filas[0].en_taller === 1, `dio ${filas[0].en_taller}`);
chequear('quedan 4 disponibles', filas[0].disponibles === 4, `dio ${filas[0].disponibles}`);
chequear('se señala cuál es', filas[0].numeros_taller[0] === '45', JSON.stringify(filas[0].numeros_taller));

// ── El caso que obliga a cruzar por objetivo ──────────────────
// El 237 existe en Cosquin Y en Circunvalación. Una reparación de uno no
// puede descontar stock del otro.
filas = [
  fila(COSQUIN, 'Motoguadaña', 4, ['215','237','222','223']),
  fila(CIRCUN,  'Motoguadaña', 15, ['233','222','230','229','214','237','209','217','221','228','232','208','181','198','151']),
];
cruzarTaller(filas, [inc('i1', COSQUIN, '237', 'motoguadaña')]);
chequear('la 237 de Cosquin se descuenta en Cosquin', filas[0].en_taller === 1, `dio ${filas[0].en_taller}`);
chequear('la 237 de Circunvalación NO se toca',      filas[1].en_taller === 0, `dio ${filas[1].en_taller}`);
chequear('Circunvalación conserva sus 15',           filas[1].disponibles === 15, `dio ${filas[1].disponibles}`);

// ── Número repetido dentro del mismo objetivo ─────────────────
// El 218 figura dos veces en el censo de Cosquin: no se puede decir cuál es.
filas = [fila(COSQUIN, 'Motoguadaña 291', 17,
  ['213','211','235','212','210','224','239','234','221','22','220','218','227','sn','sn','218','236'])];
cruzarTaller(filas, [inc('i1', COSQUIN, '218', 'motoguadaña')]);
chequear('el 218 repetido igual se descuenta del total', filas[0].en_taller === 1, `dio ${filas[0].en_taller}`);
chequear('el 218 repetido NO se señala como unidad',     filas[0].numeros_taller.length === 0,
  JSON.stringify(filas[0].numeros_taller));
chequear('el 218 aparece listado como ambiguo', filas[0].numeros_ambiguos.includes('218'),
  JSON.stringify(filas[0].numeros_ambiguos));
chequear('los "sn" figuran como ambiguos',
  filas[0].numeros_ambiguos.filter(n => String(n).toLowerCase() === 'sn').length === 2,
  JSON.stringify(filas[0].numeros_ambiguos));

// ── Máquina censada sin número ────────────────────────────────
filas = [fila(CHACRAS, 'motosierra 250', 1, [])];
cruzarTaller(filas, [inc('i1', CHACRAS, null, 'motosierra')]);
chequear('sin número se descuenta por tipo', filas[0].en_taller === 1, `dio ${filas[0].en_taller}`);
chequear('sin número quedan 0 disponibles',  filas[0].disponibles === 0, `dio ${filas[0].disponibles}`);
chequear('se marca que no se sabe cuál es',  filas[0].taller_detalle[0].sin_identificar === true);

// ── La familia acota el match sin número ──────────────────────
// Un tractor roto no puede descontar una motosierra.
filas = [fila(CHACRAS, 'motosierra 250', 1, []), fila(CHACRAS, 'tractor MF 1175', 1, [])];
cruzarTaller(filas, [inc('i1', CHACRAS, null, 'tractor new holland')]);
chequear('el tractor roto no descuenta la motosierra', filas[0].en_taller === 0, `dio ${filas[0].en_taller}`);
chequear('el tractor roto descuenta el tractor',       filas[1].en_taller === 1, `dio ${filas[1].en_taller}`);

// ── No descontar más de lo que hay ────────────────────────────
filas = [fila(CHACRAS, 'motosierra 250', 1, [])];
let r = cruzarTaller(filas, [inc('i1', CHACRAS, null, 'motosierra'), inc('i2', CHACRAS, null, 'motosierra')]);
chequear('no descuenta más máquinas de las censadas', filas[0].en_taller === 1, `dio ${filas[0].en_taller}`);
chequear('disponibles nunca es negativo', filas[0].disponibles === 0, `dio ${filas[0].disponibles}`);
chequear('la reparación sobrante queda sin ubicar', r.sin_ubicar.length === 1, `dio ${r.sin_ubicar.length}`);

// ── Una reparación no se cuenta dos veces ─────────────────────
filas = [
  fila(CHACRAS, 'Motoguadaña', 5, ['50','51','45','49','47']),
  fila(CHACRAS, 'cortacerco sthil', 1, []),
];
cruzarTaller(filas, [inc('i1', CHACRAS, '45', 'motoguadaña')]);
chequear('una reparación afecta una sola fila',
  filas[0].en_taller + filas[1].en_taller === 1, `dio ${filas[0].en_taller} y ${filas[1].en_taller}`);

// ── Reparación de un objetivo sin censo ───────────────────────
filas = [fila(CHACRAS, 'Motoguadaña', 5, ['50','51','45','49','47'])];
r = cruzarTaller(filas, [inc('i9', 'obj-sin-censo', '99', 'motoguadaña')]);
chequear('reparación de objetivo sin censo queda sin ubicar', r.sin_ubicar.length === 1);
chequear('y no ensucia el conteo de otro objetivo', filas[0].en_taller === 0, `dio ${filas[0].en_taller}`);

// ── Sin reparaciones: todo disponible ─────────────────────────
filas = [fila(CHACRAS, 'Motoguadaña', 5, ['50','51','45','49','47'])];
cruzarTaller(filas, []);
chequear('sin reparaciones, todo disponible', filas[0].disponibles === 5 && filas[0].en_taller === 0);

// ── Formatos del número ───────────────────────────────────────
filas = [fila(CHACRAS, 'Motoguadaña', 5, ['50','51','45','49','47'])];
cruzarTaller(filas, [inc('i1', CHACRAS, ' 45 ', 'motoguadaña')]);
chequear('el número con espacios matchea igual', filas[0].en_taller === 1, `dio ${filas[0].en_taller}`);

filas = [fila(CHACRAS, 'extensible husqvarna', 1, ['02'])];
cruzarTaller(filas, [inc('i1', CHACRAS, '02', 'extensible')]);
chequear('el cero a la izquierda matchea', filas[0].en_taller === 1, `dio ${filas[0].en_taller}`);

// ── Fila de objetivo sin censo no rompe ───────────────────────
filas = [{ objetivo_id: CHACRAS, tipo: null, cantidad: 0, numeros: [], sin_censo: true }];
cruzarTaller(filas, [inc('i1', CHACRAS, '45', 'motoguadaña')]);
chequear('una fila sin censo no explota', filas[0].en_taller === 0);

// ── El total de una máquina numerada sigue cerrando ───────────
filas = [fila(COSQUIN, 'Motoguadaña 291', 17,
  ['213','211','235','212','210','224','239','234','221','22','220','218','227','sn','sn','218','236'])];
cruzarTaller(filas, [inc('i1', COSQUIN, '212', 'motoguadaña'), inc('i2', COSQUIN, '234', 'motoguadaña')]);
chequear('dos numeradas dan 15 disponibles de 17', filas[0].disponibles === 15, `dio ${filas[0].disponibles}`);
chequear('se señalan las dos', filas[0].numeros_taller.length === 2, JSON.stringify(filas[0].numeros_taller));

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
