// Harness de ck() (flexxus.js) — la clave de caché namespaceada por entorno.
//
// Por qué importa: el plan de cuentas y los centros de costo son distintos en
// cada instancia de Flexxus. Si dos entornos comparten clave de caché, al
// cambiar FLEXXUS_URL el sistema sigue imputando con los códigos del entorno
// viejo hasta 6 horas, sin fallar y sin avisar.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/flexxus.js', 'utf8');

const ini = src.indexOf('function ck(clave)');
const fin = src.indexOf('async function cacheLeer');
if (ini < 0 || fin < 0 || fin < ini) {
  console.error('✗ No encontré ck() en flexxus.js — cambió el archivo, revisá el harness');
  process.exit(1);
}
const ck = new Function(src.slice(ini, fin) + '\nreturn ck;')();

let ok = 0, mal = 0;
function eq(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

const PRUEBA = 'https://prueba-ecoservice.procomisp.com.ar';
const PROD   = 'https://ecoservice.procomisp.com.ar';

process.env.FLEXXUS_URL = PRUEBA;
const planPrueba   = ck('plan_cuentas');
const centrosPrueba = ck('centros_costo');
const tokenPrueba  = ck('token');

process.env.FLEXXUS_URL = PROD;
const planProd   = ck('plan_cuentas');
const centrosProd = ck('centros_costo');
const tokenProd  = ck('token');

console.log(`  prueba → ${planPrueba}`);
console.log(`  prod   → ${planProd}`);

eq('el plan de cuentas no se comparte entre entornos', planPrueba !== planProd);
eq('los centros de costo no se comparten',             centrosPrueba !== centrosProd);
eq('el token no se comparte',                          tokenPrueba !== tokenProd);
eq('la clave lleva el host de producción', planProd.startsWith('ecoservice.procomisp.com.ar::'), planProd);
eq('la clave lleva el host de prueba',     planPrueba.startsWith('prueba-ecoservice.procomisp.com.ar::'), planPrueba);

// Dentro de un mismo entorno, cada dato mantiene su propia clave.
eq('plan y centros no se pisan entre sí', planProd !== centrosProd);

// El mismo entorno da siempre la misma clave (si no, la caché nunca acierta).
process.env.FLEXXUS_URL = PROD;
eq('la clave es estable para el mismo entorno', ck('plan_cuentas') === planProd);

// Una barra al final no debería cambiar el entorno: es la misma instancia.
process.env.FLEXXUS_URL = PROD + '/';
eq('una barra final no crea un entorno nuevo', ck('plan_cuentas') === planProd, ck('plan_cuentas'));

// Sin URL configurada no puede explotar ni colisionar con un host real.
delete process.env.FLEXXUS_URL;
const sinUrl = ck('plan_cuentas');
eq('sin FLEXXUS_URL no explota', typeof sinUrl === 'string' && sinUrl.length > 0);
eq('sin FLEXXUS_URL no colisiona con un host real', sinUrl !== planProd && sinUrl !== planPrueba, sinUrl);

process.env.FLEXXUS_URL = 'no-es-una-url';
eq('una URL mal escrita no explota', typeof ck('token') === 'string');

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
