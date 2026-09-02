// Harness de itemsDeObjetivo (panel.js) — qué parte de una carga fue a un objetivo.
// Extrae la función REAL del archivo; no reescribirla acá.
//
// Por qué importa: de esto salen los litros que muestra la tabla cuando hay un
// objetivo filtrado. Si reparte mal, el panel muestra un número que parece
// bien y no lo es. Los casos usan cargas reales del mes.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/panel.js', 'utf8');

const ini = src.indexOf('function itemsDeObjetivo');
const fin = src.indexOf('let combMesAnterior=null;');
if (ini < 0 || fin < 0 || fin < ini) {
  console.error('✗ No encontré itemsDeObjetivo en panel.js — cambió el archivo, revisá el harness');
  process.exit(1);
}
const itemsDeObjetivo = new Function(src.slice(ini, fin) + '\nreturn itemsDeObjetivo;')();

// Los resolvedores reales dependen de combAlias; acá se usan las versiones
// simples equivalentes (sin alias), que es el caso de todos los objetivos ya
// unificados.
const objDe = c => c.objetivos ? c.objetivos.nombre : 'Sin objetivo';
const destinoDe = (i, c) => i.destino === 'bidon' ? (i.destino_detalle || objDe(c)) : objDe(c);

let ok = 0, mal = 0;
function chequear(nombre, carga, obj, esp) {
  const r = itemsDeObjetivo(carga, obj, destinoDe, objDe);
  const fallas = [];
  if (Math.abs(r.litros - esp.litros) > 1e-9) fallas.push(`litros: esperaba ${esp.litros}, dio ${r.litros}`);
  if (esp.nItems != null && r.items.length !== esp.nItems) fallas.push(`ítems: esperaba ${esp.nItems}, dio ${r.items.length}`);
  if (esp.parcial != null && r.parcial !== esp.parcial) fallas.push(`parcial: esperaba ${esp.parcial}, dio ${r.parcial}`);
  if (fallas.length) { mal++; console.log(`✗ ${nombre}`); fallas.forEach(f => console.log('    ' + f)); }
  else { ok++; console.log(`✓ ${nombre}`); }
}

// ── La carga de Ivan Palacios del 01/09 ───────────────────────
// 45 lt de SUPER repartidos en bidones a tres objetivos distintos.
const ivan = {
  litros_total: 45,
  objetivos: { nombre: 'SUPERVISORES' },
  cargas_combustible_items: [
    { producto: 'SUPER', litros: 15, destino: 'bidon', destino_detalle: 'Tablada Lasalle' },
    { producto: 'SUPER', litros: 10, destino: 'bidon', destino_detalle: 'Saint Jordin' },
    { producto: 'SUPER', litros: 20, destino: 'bidon', destino_detalle: 'LA CALANDRIA' },
  ],
};
chequear('reparto en 3 → Tablada son 15, no 45', ivan, 'Tablada Lasalle', { litros: 15, nItems: 1, parcial: true });
chequear('reparto en 3 → Saint Jordin son 10',   ivan, 'Saint Jordin',   { litros: 10, nItems: 1, parcial: true });
chequear('reparto en 3 → LA CALANDRIA son 20',   ivan, 'LA CALANDRIA',   { litros: 20, nItems: 1, parcial: true });
chequear('objetivo de la cabecera sin ítems propios da 0', ivan, 'SUPERVISORES', { litros: 0, nItems: 0, parcial: false });
chequear('objetivo ajeno da 0',                  ivan, 'Chacras',        { litros: 0, nItems: 0, parcial: false });
chequear('sin filtro devuelve la carga entera',  ivan, '',               { litros: 45, nItems: 3, parcial: false });

// ── La carga del ticket Edenred: un solo ítem a bidones ───────
const promedon = {
  litros_total: 39,
  objetivos: { nombre: 'SUPERVISORES' },
  cargas_combustible_items: [
    { producto: 'GASOIL', litros: 39.002, destino: 'bidon', destino_detalle: 'PROMEDON SA' },
  ],
};
chequear('carga de un solo ítem: no es parcial', promedon, 'PROMEDON SA', { litros: 39.002, nItems: 1, parcial: false });
chequear('el objetivo de cabecera no se lleva los litros del bidón', promedon, 'SUPERVISORES', { litros: 0, nItems: 0 });

// ── Ítem al tanque: va al objetivo de la cabecera ─────────────
const alTanque = {
  litros_total: 40,
  objetivos: { nombre: '4 Hojas' },
  cargas_combustible_items: [
    { producto: 'V POWER DIESEL', litros: 40, destino: 'unidad', destino_detalle: null },
  ],
};
chequear('al tanque se imputa al objetivo de la carga', alTanque, '4 Hojas', { litros: 40, nItems: 1, parcial: false });

// ── Mezcla tanque + bidón ─────────────────────────────────────
const mixta = {
  litros_total: 50,
  objetivos: { nombre: 'Chacras' },
  cargas_combustible_items: [
    { producto: 'GASOIL', litros: 30, destino: 'unidad', destino_detalle: null },
    { producto: 'SUPER',  litros: 20, destino: 'bidon',  destino_detalle: 'FINCAS DEL SUR' },
  ],
};
chequear('mixta → Chacras se lleva solo el tanque', mixta, 'Chacras',        { litros: 30, nItems: 1, parcial: true });
chequear('mixta → FINCAS se lleva solo el bidón',   mixta, 'FINCAS DEL SUR', { litros: 20, nItems: 1, parcial: true });

// ── Bidón sin destino_detalle: cae al objetivo de la carga ────
const sinDetalle = {
  litros_total: 25,
  objetivos: { nombre: 'DEPOSITO' },
  cargas_combustible_items: [
    { producto: 'GASOIL', litros: 25, destino: 'bidon', destino_detalle: null },
  ],
};
chequear('bidón sin detalle se imputa a la cabecera', sinDetalle, 'DEPOSITO', { litros: 25, nItems: 1, parcial: false });

// ── Carga vieja sin ítems detallados ──────────────────────────
const vieja = { litros_total: 61.6549, objetivos: { nombre: 'Municipalidad Luis' }, cargas_combustible_items: [] };
chequear('carga vieja sin ítems se imputa entera', vieja, 'Municipalidad Luis', { litros: 61.6549, nItems: 0, parcial: false });
chequear('carga vieja no aparece en otro objetivo', vieja, 'Chacras', { litros: 0, nItems: 0, parcial: false });
chequear('carga vieja sin filtro usa litros_total', vieja, '', { litros: 61.6549, parcial: false });

// ── Dos ítems al MISMO objetivo: no es parcial ────────────────
const dosMismo = {
  litros_total: 50,
  objetivos: { nombre: 'FINCAS DEL SUR' },
  cargas_combustible_items: [
    { producto: 'PUMA SUPER', litros: 30, destino: 'bidon', destino_detalle: 'FINCAS DEL SUR' },
    { producto: 'PUMA SUPER', litros: 20, destino: 'bidon', destino_detalle: 'FINCAS DEL SUR' },
  ],
};
chequear('dos ítems al mismo objetivo suman y no son parcial', dosMismo, 'FINCAS DEL SUR', { litros: 50, nItems: 2, parcial: false });

// ── Litros nulos no rompen la suma ────────────────────────────
const conNulo = {
  litros_total: 20,
  objetivos: { nombre: 'Chacras' },
  cargas_combustible_items: [
    { producto: 'GASOIL', litros: null, destino: 'bidon', destino_detalle: 'Chacras' },
    { producto: 'SUPER',  litros: 20,   destino: 'bidon', destino_detalle: 'Chacras' },
  ],
};
chequear('un litro sin leer no rompe la suma', conNulo, 'Chacras', { litros: 20, nItems: 2, parcial: false });

// ── Los litros de una carga cierran entre todos sus objetivos ─
const suma = ['Tablada Lasalle', 'Saint Jordin', 'LA CALANDRIA']
  .reduce((s, o) => s + itemsDeObjetivo(ivan, o, destinoDe, objDe).litros, 0);
if (Math.abs(suma - 45) < 1e-9) { ok++; console.log('✓ los tres objetivos suman los 45 lt de la carga'); }
else { mal++; console.log(`✗ los tres objetivos suman ${suma}, la carga tiene 45 — se pierden o duplican litros`); }

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
