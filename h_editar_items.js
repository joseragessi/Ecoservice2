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

console.log('\n— IVA por ítem (facturas con 21% y 10,5% mezclados) —');
eq('cada ítem tiene su campo de IVA', /<input id="ei-iva-\$\{ix\}"/.test(src));
eq('muestra el porcentaje debajo', /Math\.round\(v\/n\*1000\)\/10/.test(src));
eq('recalcula al escribir, no al salir del campo', /id="ei-iva-\$\{ix\}"[\s\S]{0,220}oninput="comprasItemCambio\(\)"/.test(src));
eq('el neto también recalcula al escribir', /id="ei-neto-\$\{ix\}"[\s\S]{0,180}oninput="comprasItemCambio\(\)"/.test(src));

console.log('\n— Los ítems mandan: el total es su suma —');
eq('al guardar, el total sale de los ítems', /body\.total_sin_iva=Math\.round\(sNeto\*100\)\/100/.test(src));
eq('el IVA total también', /body\.total_iva\s*=Math\.round\(sIva\*100\)\/100/.test(src));
eq('el IVA de cada ítem se guarda', /monto_iva:iva/.test(src));
eq('con ítems, los totales no se editan a mano', /id="ec-neto"[^>]*readonly/.test(src));
eq('sin ítems, los totales se siguen editando', /campo\('ec-neto',inv\.total_sin_iva,'num'\)/.test(src));
eq('los totales de la tabla se actualizan en vivo', /id="ei-tot-neto"/.test(src) && /id="ei-tot-iva"/.test(src) && /id="ei-tot-total"/.test(src));
eq('y el total de cada línea también', /id="ei-lin-tot-\$\{ix\}"/.test(src));

// La aritmética real: se extrae la función y se corre.
const ini = src.indexOf('function comprasItemCambio(){');
const fin = src.indexOf('\n}', src.indexOf("av.innerHTML=`", ini)) + 2;
const campos = {};
const gMock = id => campos[id];
const inp = (id, v) => { campos[id] = { value: String(v), textContent: '' }; };
const out = (id) => { campos[id] = { textContent: '' }; };
function correr(items) {
  Object.keys(campos).forEach(k => delete campos[k]);
  items.forEach((it, ix) => { inp('ei-neto-' + ix, it.neto); inp('ei-iva-' + ix, it.iva); out('ei-lin-tot-' + ix); });
  inp('ec-neto', 0); inp('ec-iva', 0);
  out('ei-tot-neto'); out('ei-tot-iva'); out('ei-tot-total'); out('ec-aviso-items');
  const f = new Function('comprasVer', 'document', 'money',
    src.slice(ini, fin) + '\nreturn comprasItemCambio;')(
    { items: items.map(() => ({})) }, { getElementById: gMock }, n => '$' + n);
  f();
  return { neto: Number(campos['ec-neto'].value), iva: Number(campos['ec-iva'].value) };
}

console.log('\n— La cuenta que termina en el asiento de Flexxus —');
let r = correr([{ neto: 1350000, iva: 283500 }]);
eq('la factura de exámenes: 1.350.000 + 283.500', r.neto === 1350000 && r.iva === 283500, JSON.stringify(r));
r = correr([{ neto: 100, iva: 21 }, { neto: 200, iva: 21 }]);
eq('dos ítems se suman', r.neto === 300 && r.iva === 42, JSON.stringify(r));
r = correr([{ neto: 1000, iva: 210 }, { neto: 1000, iva: 105 }]);
eq('21% y 10,5% mezclados en la misma factura', r.neto === 2000 && r.iva === 315, JSON.stringify(r));
r = correr([{ neto: 33.33, iva: 7 }, { neto: 33.33, iva: 7 }, { neto: 33.34, iva: 7 }]);
eq('los centavos no se pierden', r.neto === 100 && r.iva === 21, JSON.stringify(r));
r = correr([{ neto: 0, iva: 0 }]);
eq('en cero no rompe', r.neto === 0 && r.iva === 0);
r = correr([{ neto: 500, iva: 0 }]);
eq('un ítem exento suma al neto y no al IVA', r.neto === 500 && r.iva === 0);

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
