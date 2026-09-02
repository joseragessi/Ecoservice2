// Harness de numCampo (panel_api.js) — el parser de importes del editor.
// Extrae la función REAL del archivo: si se copiara acá, el test probaría la
// copia y no lo que corre en producción.
//
// Por qué importa: los importes se escriben a mano copiando el ticket, en
// formato argentino ("2.465,0000"). Un parseo mal hecho no rompe nada visible
// — guarda un número plausible y equivocado.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/panel_api.js', 'utf8');

const ini = src.indexOf('function numCampo');
const fin = src.indexOf("router.put('/api/combustible/:id'");
if (ini < 0 || fin < 0 || fin < ini) {
  console.error('✗ No encontré numCampo en panel_api.js — cambió el archivo, revisá el harness');
  process.exit(1);
}
const numCampo = new Function(src.slice(ini, fin) + '\nreturn numCampo;')();

let ok = 0, mal = 0;
function eq(nombre, entrada, esperado) {
  const r = numCampo(entrada);
  if (r === esperado || (Number.isNaN(r) && Number.isNaN(esperado))) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre}: esperaba ${JSON.stringify(esperado)}, dio ${JSON.stringify(r)}`); }
}

// ── Los números del ticket real ───────────────────────────────
eq('precio del ticket "2.465,0000"', '2.465,0000', 2465);
eq('total del ticket "96.139,93"',   '96.139,93',  96139.93);
eq('saldo del ticket "203.860,07"',  '203.860,07', 203860.07);
eq('litros del ticket "39,002"',     '39,002',     39.002);
eq('km del ticket "219.625"',        '219.625',    219625);

// ── Distinguir vacío de cero ──────────────────────────────────
// Esto es lo importante: borrar un campo tiene que dar null, no 0. Un saldo
// que quedó en 0 dice "la tarjeta está sin plata"; uno en null dice "no lo sé".
eq('cadena vacía = borrar el dato',  '',    null);
eq('null sigue null',                null,  null);
eq('undefined sigue null',           undefined, null);
eq('espacios en blanco = null',      '   ', null);
eq('cero escrito a mano SÍ es cero', '0',   0);
eq('cero con decimales es cero',     '0,00', 0);

// ── Basura que no se puede sostener ───────────────────────────
eq('texto sin dígitos = null',       'ilegible', null);
eq('guiones = null',                 '---',      null);

// ── Formatos que puede tipear una persona ─────────────────────
eq('con signo pesos',                '$ 96.139,93', 96139.93);
eq('sin separador de miles',          '96139,93',   96139.93);
eq('entero pelado',                   '39',         39);
eq('número ya parseado pasa igual',   2465,         2465);
eq('cero numérico es cero',           0,            0);
eq('negativo se conserva',            '-150,50',    -150.5);
eq('NaN no pasa',                     NaN,          null);
eq('Infinity no pasa',                Infinity,     null);

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
