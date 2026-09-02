// Harness de ida y vuelta del editor de cargas.
//
// El riesgo que cubre: el modal muestra los importes formateados a la
// argentina ("203.860,07") y al guardar los manda como texto, que el backend
// vuelve a parsear. Si el formateo y el parseo no son inversos exactos, abrir
// una carga y guardarla SIN TOCAR NADA le cambia los números. Es el tipo de
// bug que no se ve: no falla, guarda otra cosa.
//
// Las dos funciones se extraen de los archivos reales (fmtNumEdit de panel.js,
// numCampo de panel_api.js). Nunca reescribirlas acá.

const fs = require('fs');

const srcPanel = fs.readFileSync(__dirname + '/panel.js', 'utf8');
const iniF = srcPanel.indexOf('function fmtNumEdit');
const finF = srcPanel.indexOf('function valEdit');
if (iniF < 0 || finF < 0 || finF < iniF) {
  console.error('✗ No encontré fmtNumEdit en panel.js — cambió el archivo, revisá el harness');
  process.exit(1);
}
const fmtNumEdit = new Function(srcPanel.slice(iniF, finF) + '\nreturn fmtNumEdit;')();

const srcApi = fs.readFileSync(__dirname + '/panel_api.js', 'utf8');
const iniN = srcApi.indexOf('function numCampo');
const finN = srcApi.indexOf("router.put('/api/combustible/:id'");
if (iniN < 0 || finN < 0 || finN < iniN) {
  console.error('✗ No encontré numCampo en panel_api.js — cambió el archivo, revisá el harness');
  process.exit(1);
}
const numCampo = new Function(srcApi.slice(iniN, finN) + '\nreturn numCampo;')();

let ok = 0, mal = 0;

// Abrir el modal y guardar sin tocar: valor → input → backend → valor.
function ida_y_vuelta(nombre, valor, dec) {
  const enPantalla = fmtNumEdit(valor, dec);
  const vuelto = numCampo(enPantalla);
  const igual = (valor == null && vuelto == null) || Math.abs(vuelto - valor) < 1e-9;
  if (igual) { ok++; console.log(`✓ ${nombre.padEnd(34)} ${String(valor).padStart(12)} → "${enPantalla}" → ${vuelto}`); }
  else { mal++; console.log(`✗ ${nombre.padEnd(34)} ${valor} → "${enPantalla}" → ${vuelto}   ⚠ CAMBIÓ`); }
}

console.log('— Los valores del ticket real (Edenred 01/09) —');
ida_y_vuelta('litros ION DIESEL',      39.002,    null);
ida_y_vuelta('precio por litro',       2465,      null);
ida_y_vuelta('subtotal de la línea',   96139.93,  2);
ida_y_vuelta('total del comprobante',  96139.93,  2);
ida_y_vuelta('saldo de la tarjeta',    203860.07, 2);
ida_y_vuelta('kilometraje actual',     219625,    0);
ida_y_vuelta('kilometraje anterior',   0,         0);

console.log('\n— Importes de otras cargas del mes —');
ida_y_vuelta('litros con 4 decimales',  61.6549,  null);
ida_y_vuelta('litros redondos',         55,       null);
ida_y_vuelta('litros con media unidad', 46.007,   null);
ida_y_vuelta('importe chico',           1250.5,   2);
ida_y_vuelta('importe de siete cifras', 1234567.89, 2);
ida_y_vuelta('neto gravado',            79454.49, 2);
ida_y_vuelta('IVA 21%',                 16685.44, 2);

console.log('\n— Bordes —');
ida_y_vuelta('cero',                    0,        2);
ida_y_vuelta('menos de un peso',        0.07,     2);
ida_y_vuelta('un solo decimal',         12.5,     2);
ida_y_vuelta('km de seis cifras',       999999,   0);
ida_y_vuelta('vacío queda vacío',       null,     2);

// El campo se muestra vacío y el usuario no lo toca: tiene que seguir siendo
// "no sé", no convertirse en cero.
const vacio = numCampo(fmtNumEdit(null, 2));
if (vacio === null) { ok++; console.log('✓ campo vacío no se vuelve cero'); }
else { mal++; console.log(`✗ campo vacío se volvió ${JSON.stringify(vacio)} — un saldo ausente pasaría a "$0"`); }

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
