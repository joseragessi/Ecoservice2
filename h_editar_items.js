// Harness de la edición de ítems de una factura (panel.js).
//
// 16-sep: el OCR metió los 10 nombres de una factura de exámenes
// preocupacionales en una sola descripción. El campo para corregirla existía,
// pero era un input de una línea: la descripción entraba pero no se veía.
// Ahora es un textarea que crece.
//
// También se verifica que el bloque de orden de compra quede oculto SIN
// romper el guardado: si se oculta el recuadro pero se deja la validación que
// lo exige, la factura no se puede guardar y nadie entiende por qué.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/panel.js', 'utf8');
let ok = 0, mal = 0;
function eq(n, c, d) { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } }

console.log('— La descripción se edita en un campo que crece —');
eq('es un textarea, no un input de una línea', /<textarea id="ei-desc-\$\{ix\}"/.test(src));
eq('ya no queda el input viejo', !/<input id="ei-desc-\$\{ix\}"/.test(src));
eq('el contenido va escapado', /<\/textarea>/.test(src) && /escStk\(i\.descripcion\|\|''\)\}<\/textarea>/.test(src));
eq('crece solo al escribir', /this\.style\.height='auto'/.test(src));
eq('arranca con el alto que necesita el texto', /Math\.ceil\(String\(i\.descripcion\|\|''\)\.length\/48\)/.test(src));
eq('tiene un tope para no comerse la pantalla', /Math\.min\(6,/.test(src) && /Math\.min\(this\.scrollHeight,150\)/.test(src));
eq('se puede agrandar a mano', /resize:vertical/.test(src));
eq('la columna tiene ancho mínimo', /min-width:240px/.test(src));

// El alto inicial, con las descripciones reales.
const filas = t => Math.min(6, Math.max(1, Math.ceil(String(t || '').length / 48)));
const larga = 'EXAMENES PSICOFUNCIONAL GARCIA SANTIAGO GONZALEZ NATHANAEL NAHUM NORIEGA AGUSTIN GUTIERREZ RODRIGO DAVID SALGUERO LEZCEMA PEDRO EZEQUIEL MARQUEZ FABRIZIO AGUSTIN ALMIRON ADRIAN ALBERTO ESTABRI LEANDRO BICOLLAS HEREDIA REQUENA PEDRO JOAQUIN DURAN BRATAN EMMANUEL';
eq('la descripción larga arranca con varios renglones', filas(larga) === 6, String(filas(larga)));
eq('una corta arranca con uno', filas('Gasoil') === 1);
eq('una vacía no rompe', filas('') === 1 && filas(null) === 1);
eq('una de dos renglones arranca con dos', filas('x'.repeat(60)) === 2);

console.log('\n— El guardado sigue leyendo la descripción —');
// Los dos puntos donde se capturan los ítems.
eq('se captura al guardar la factura', /const d=g\('ei-desc-'\+ix\)/.test(src));
eq('y en el envío al backend', (src.match(/g\('ei-desc-'\+ix\)/g) || []).length >= 2,
  `${(src.match(/g\('ei-desc-'\+ix\)/g) || []).length} lugares`);
eq('lee .value (funciona igual en textarea)', /d\.value\.trim\(\)/.test(src));
eq('si queda vacía, conserva la anterior', /d\?\(d\.value\.trim\(\)\|\|it\.descripcion\):it\.descripcion/.test(src));

console.log('\n— La orden de compra queda oculta —');
eq('existe el interruptor', /const MOSTRAR_ORDEN_FACTURA=false/.test(src));
eq('el bloque no se pinta', /if\(!MOSTRAR_ORDEN_FACTURA\)return ''/.test(src));
eq('y NO se exige confirmarla para guardar', /if\(MOSTRAR_ORDEN_FACTURA&&!comprasOrden&&!comprasSinOrdenOk\)/.test(src),
  'si se oculta el recuadro pero queda la validación, la factura no se puede guardar');
eq('el código del bloque queda entero, para volver a mostrarlo', /function bloqueOrdenFactura\(\)/.test(src));

console.log('\n— Lo que NO se tocó de Compras —');
eq('imputar a Flexxus sigue igual', /flexxus/i.test(src));
eq('el submódulo Órdenes sigue', /comprasVincularOrden/.test(src));
eq('la vinculación automática por número sigue', /comprasOrdenMatch/.test(src));

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
