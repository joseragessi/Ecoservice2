// Harness de sanearTarjeta (extraccion.js).
// Extrae la función REAL del archivo, no una copia: si se reescribiera acá,
// se estaría probando la memoria de quien escribió el test y no el código.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/extraccion.js', 'utf8');

const ini = src.indexOf('function sanearTarjeta');
const fin = src.indexOf('/**\n * @param {Buffer} imagenBuffer');
if (ini < 0 || fin < 0 || fin < ini) {
  console.error('✗ No encontré sanearTarjeta en extraccion.js — cambió el archivo, revisá el harness');
  process.exit(1);
}
const cuerpo = src.slice(ini, fin);
const sanearTarjeta = new Function(cuerpo + '\nreturn sanearTarjeta;')();

let ok = 0, mal = 0;
function chequear(nombre, entrada, esperado) {
  const r = sanearTarjeta(JSON.parse(JSON.stringify(entrada)));
  const fallas = Object.keys(esperado).filter(k => {
    const a = r[k], b = esperado[k];
    return !(a === b || (a == null && b == null));
  });
  if (fallas.length) {
    mal++;
    console.log(`✗ ${nombre}`);
    fallas.forEach(k => console.log(`    ${k}: esperaba ${JSON.stringify(esperado[k])}, dio ${JSON.stringify(r[k])}`));
  } else { ok++; console.log(`✓ ${nombre}`); }
}

// ── El ticket real: Edenred, PUMA O HIGGINS, 01/09/26 ─────────
chequear('ticket real Edenred 01/09', {
  tipo_doc: 'remito', es_tarjeta: true,
  proveedor: 'PUMA O HIGGINS CO DUAL',
  numero: '2951', lote: '20261369',
  tarjeta: '3084 6202 1402 7102',
  km_anterior: '0', km_actual: '219.625',
  saldo_tarjeta: '203.860,07',
  neto: null, iva: null, otros_tributos: null, total: 96139.93,
}, {
  es_tarjeta: true, numero: '2951', lote: '20261369',
  tarjeta: '3084620214027102',
  km_anterior: 0, km_actual: 219625,
  saldo_tarjeta: 203860.07,
  neto: null, iva: null, otros_tributos: null,
});

// ── El caso que motivó el campo lote ──────────────────────────
chequear('lote copiado en numero → numero se descarta', {
  es_tarjeta: true, numero: '20261369', lote: '20261369',
}, { numero: null, lote: '20261369' });

chequear('lote y numero distintos → se respetan los dos', {
  es_tarjeta: true, numero: '2951', lote: '20261369',
}, { numero: '2951', lote: '20261369' });

// ── Odómetro ──────────────────────────────────────────────────
chequear('km anterior en 0 es dato, no ausencia', {
  es_tarjeta: true, km_anterior: 0, km_actual: 219625,
}, { km_anterior: 0, km_actual: 219625 });

chequear('km invertido → se descartan los dos', {
  es_tarjeta: true, km_anterior: 219625, km_actual: 5000,
}, { km_anterior: null, km_actual: null, _km_dudoso: true });

chequear('km fuera de rango → null (lectura mala del térmico)', {
  es_tarjeta: true, km_anterior: 0, km_actual: '21962500',
}, { km_actual: null });

chequear('km con separador de miles y sin él dan lo mismo', {
  es_tarjeta: true, km_actual: '219.625',
}, { km_actual: 219625 });

// ── Números argentinos ────────────────────────────────────────
chequear('saldo con miles y decimales', {
  es_tarjeta: true, saldo_tarjeta: '203.860,07',
}, { saldo_tarjeta: 203860.07 });

chequear('saldo con signo pesos', {
  es_tarjeta: true, saldo_tarjeta: '$ 96.139,93',
}, { saldo_tarjeta: 96139.93 });

chequear('saldo en 0 se conserva', {
  es_tarjeta: true, saldo_tarjeta: '0,00',
}, { saldo_tarjeta: 0 });

// ── IVA inventado ─────────────────────────────────────────────
chequear('tarjeta con IVA inventado por el modelo → se borra', {
  es_tarjeta: true, neto: 79454.49, iva: 16685.44, otros_tributos: 0, total: 96139.93,
}, { neto: null, iva: null, otros_tributos: null, total: 96139.93 });

chequear('factura común conserva el IVA', {
  es_tarjeta: false, neto: 79454.49, iva: 16685.44, total: 96139.93,
}, { neto: 79454.49, iva: 16685.44, total: 96139.93 });

// ── Remito de surtidor de siempre: no se toca nada ────────────
chequear('remito de surtidor queda igual', {
  tipo_doc: 'remito', proveedor: 'SERVI SUD SA', numero: '0033-00000586',
  neto: null, iva: null, total: null,
}, {
  es_tarjeta: false, lote: null, tarjeta: null,
  km_anterior: null, km_actual: null, saldo_tarjeta: null,
  numero: '0033-00000586',
});

chequear('tarjeta con basura no numérica → null, no NaN', {
  es_tarjeta: true, km_actual: '---', saldo_tarjeta: 'ilegible', tarjeta: '****',
}, { km_actual: null, saldo_tarjeta: null, tarjeta: null });

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
