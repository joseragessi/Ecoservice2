// Harness de codigoPercepcion (flexxus.js) — a qué código de Flexxus va cada
// percepción de una factura.
//
// Extrae la función REAL del archivo. Si una percepción mapea al código
// equivocado, la factura entra a Flexxus con la percepción imputada mal y
// nadie se entera hasta que Sole concilia. Si no mapea a ninguno, la factura
// no entra (caso Acerco 00020-00092539 del 02/09/2026: "Percep. Mun. Cba").

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/flexxus.js', 'utf8');

const ini = src.indexOf('const codigoPercepcion = (concepto)');
const fin = src.indexOf('for (const o of percepciones)', ini);
if (ini < 0 || fin < 0) { console.error('✗ No encontré codigoPercepcion en flexxus.js'); process.exit(1); }
const codigoPercepcion = new Function('process', src.slice(ini, fin) + '\nreturn codigoPercepcion;')({ env: {} });
// Con fallback configurado, para probar el otro camino.
const conFallback = new Function('process', src.slice(ini, fin) + '\nreturn codigoPercepcion;')({ env: { FLEXXUS_CODIGO_PERCEPCION: 'PER OTRO' } });

let ok = 0, mal = 0;
function eq(nombre, dio, esperado) {
  if (dio === esperado) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre} — esperaba ${JSON.stringify(esperado)}, dio ${JSON.stringify(dio)}`); }
}

console.log('— La factura de Acerco (02/09/2026) —');
eq('"Percep. IIBB. Cba" → PER IIBB',   codigoPercepcion('Percep. IIBB. Cba'), 'PER IIBB');
eq('"Percep. Mun. Cba" → PER MUNICIPA', codigoPercepcion('Percep. Mun. Cba'), 'PER MUNICIPA');

console.log('\n— El orden importa: IIBB antes que municipal —');
// "Percep. IIBB. Cba" contiene "cba"; si la regla municipal fuera primero y
// matcheara "cba", la percepción de ingresos brutos iría al código municipal.
eq('"Percep. IIBB. Cba" NO cae en municipal', codigoPercepcion('Percep. IIBB. Cba'), 'PER IIBB');
eq('"Percepcion Ingresos Brutos Cordoba"',    codigoPercepcion('Percepcion Ingresos Brutos Cordoba'), 'PER IIBB');

console.log('\n— Cómo lo escriben otros proveedores —');
eq('"Percepción Municipal"',              codigoPercepcion('Percepción Municipal'), 'PER MUNICIPA');
eq('"PERCEP MUNICIPALIDAD DE CORDOBA"',   codigoPercepcion('PERCEP MUNICIPALIDAD DE CORDOBA'), 'PER MUNICIPA');
eq('"Tasa Comercio e Industria"',         codigoPercepcion('Tasa Comercio e Industria'), 'PER MUNICIPA');
eq('"Perc. Mun."',                        codigoPercepcion('Perc. Mun.'), 'PER MUNICIPA');
eq('"Percep IIBB"',                       codigoPercepcion('Percep IIBB'), 'PER IIBB');
eq('"Percepción Ing. Brutos"',            codigoPercepcion('Percepción Ing. Brutos'), 'PER IIBB');
eq('"Percepcion Rentas Cordoba"',         codigoPercepcion('Percepcion Rentas Cordoba'), 'PER IIBB');
eq('"Percepción IVA RG 3337"',            codigoPercepcion('Percepción IVA RG 3337'), 'PER IVA');
eq('"Percepcion Ganancias"',              codigoPercepcion('Percepcion Ganancias'), 'PER GAN');
eq('"Percep. SUSS"',                      codigoPercepcion('Percep. SUSS'), 'PER SUSS');
eq('"Percepción Seguridad Social"',       codigoPercepcion('Percepción Seguridad Social'), 'PER SUSS');

console.log('\n— Lo que no se puede mapear —');
eq('un concepto desconocido, sin fallback, da null', codigoPercepcion('Percepcion provincial de Santa Fe'), null);
eq('con fallback configurado, usa el fallback',      conFallback('Percepcion provincial de Santa Fe'), 'PER OTRO');
eq('vacío da null',                                  codigoPercepcion(''), null);
eq('null da null',                                   codigoPercepcion(null), null);

console.log('\n— No confundir "municipalidad" como CLIENTE con la percepción —');
// Ojo: esta función solo recibe el concepto de un "otro tributo", nunca el
// nombre del objetivo. Pero si algún día se le pasara, conviene saber qué hace.
eq('"MUNICIPALIDAD DE CORDOBA" (nombre de objetivo) mapearía a municipal', codigoPercepcion('MUNICIPALIDAD DE CORDOBA'), 'PER MUNICIPA');

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
