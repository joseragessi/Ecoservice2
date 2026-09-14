// Harness de la detección de duplicados de combustible (combustible.js).
//
// Reescrita el 14-sep. Antes alcanzaba con que coincidiera UN número suelto,
// y frenaba cargas reales:
//   · Claudio mandó una carga NUEVA de 146 lt y el bot le dijo "ya cargado",
//     mostrándole una de 39 lt de Lalo.
//   · El comprobante 2951 aparece 3 veces en 10 días, de 3 capataces y 3
//     proveedores distintos: los surtidores reinician la numeración.
//   · El OCR cruza los campos: el 10-sep una carga de Ezequiel quedó con
//     remito 20260498 y lote 1404, y otra con remito 1406 y lote 20260498.
//
// La regla ahora: un número solo no alcanza, tiene que venir respaldado.
// Es preferible dejar pasar un duplicado —se ve en el panel y se anula— antes
// que frenar una carga real en la estación de servicio.

process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'x';
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32);

// Cargas REALES de la base al 14-sep.
const BASE = [
  { id: 'lalo',  fecha: '2026-09-09', numero_remito: '2951',  lote: '0120240230', tarjeta: null,               litros_total: '39.0020', patente_raw: 'KCG906', capataz_id: 'lalo',  capataces: { nombre: 'Lalo 4Hojas' } },
  { id: 'diego', fecha: '2026-09-07', numero_remito: '2951',  lote: '20261446',   tarjeta: null,               litros_total: '65.2800', patente_raw: null,     capataz_id: 'diego', capataces: { nombre: 'Diego Gonzalez' } },
  { id: 'gus',   fecha: '2026-09-01', numero_remito: '2951',  lote: null,         tarjeta: null,               litros_total: '39.0000', patente_raw: null,     capataz_id: 'gus',   capataces: { nombre: 'Gustavo Velez' } },
  { id: 'eze1',  fecha: '2026-09-10', numero_remito: '20260498', lote: '1404',    tarjeta: '3084620215150341', litros_total: '62.7160', patente_raw: null,     capataz_id: 'eze',   capataces: { nombre: 'Ezequiel' } },
  { id: 'eze2',  fecha: '2026-09-10', numero_remito: '1406',  lote: '20260498',   tarjeta: '3084620215150341', litros_total: '50.0000', patente_raw: null,     capataz_id: 'eze',   capataces: { nombre: 'Ezequiel' } },
  { id: 'clau',  fecha: '2026-09-10', numero_remito: '2989',  lote: '20251760',   tarjeta: '8062120460002',    litros_total: '55.5140', patente_raw: null,     capataz_id: 'clau',  capataces: { nombre: 'Claudio Cahvez' } },
];
function cliente() {
  return { from: () => { const q = { select() { return q; }, eq() { return q; }, neq() { return q; }, gte() { return q; },
    order() { return q; }, limit() { return q; },
    then(r) { return Promise.resolve({ data: BASE, error: null }).then(r); } }; return q; } };
}
require.cache[require.resolve('./supabase.js')] = { id: 'sb', filename: 'sb', loaded: true, exports: cliente() };

// Se extrae la función REAL del archivo.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/combustible.js', 'utf8');
const iNum = src.indexOf('function numNorm(n)');
const iFin = src.indexOf('\nfunction resumenProductos', iNum);
const supabase = require('./supabase.js');
const buscarDuplicado = new Function('supabase', 'normalizarPatente', 'console',
  src.slice(iNum, iFin) + '\nreturn buscarDuplicado;')(
  supabase, p => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), console);

let ok = 0, mal = 0;
function eq(n, c, d) { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } }

(async () => {
  console.log('— EL CASO DE CLAUDIO (14-sep): carga NUEVA de 146 lt —');
  let r = await buscarDuplicado({ numero: '1428193', lote: '1428193', fecha: '2026-09-14', tarjeta: '5075' }, 'clau', 146);
  eq('no la marca como duplicada', r === null, r && `la confundió con ${r.carga.id} (${r.motivo})`);

  console.log('\n— El comprobante 2951 se repite entre estaciones —');
  // Tres cargas distintas comparten ese número. Una cuarta, nueva, no puede
  // frenarse solo porque el surtidor reinició la numeración.
  r = await buscarDuplicado({ numero: '2951', fecha: '2026-09-14' }, 'otro', 77.5);
  eq('un 2951 nuevo, con otros litros y otro capataz, pasa', r === null, r && r.motivo);
  r = await buscarDuplicado({ numero: '2951', fecha: '2026-09-13' }, 'nadie', 100);
  eq('tampoco frena a un capataz distinto', r === null, r && r.motivo);

  console.log('\n— EL SEGUNDO CASO DE CLAUDIO (14-sep 13:06): dos cargas el mismo día —');
  // Claudio ya cargó hoy 43,771 lt en el surtidor del depósito (ticket con
  // "2951"), y ahora carga 33,994 lt en el mismo surtidor (otro ticket, mismo
  // "2951" porque es el número de la terminal). Son dos cargas distintas.
  BASE.push({ id: 'clau-hoy', fecha: '2026-09-14', numero_remito: '2951', lote: '2951', tarjeta: '8407',
    litros_total: '43.7710', patente_raw: null, capataz_id: 'clau', capataces: { nombre: 'Claudio Cahvez' } });
  r = await buscarDuplicado({ numero: '2951', lote: '2951', tarjeta: '8407', fecha: '2026-09-14' }, 'clau', 33.994);
  eq('la segunda carga del día, con otros litros, NO es duplicada', r === null, r && `la confundió con ${r.carga.id} (${r.motivo})`);
  r = await buscarDuplicado({ numero: '2951', lote: '2951', tarjeta: '8407', fecha: '2026-09-14' }, 'clau', 43.771);
  eq('pero reenviar la MISMA (mismos litros) sí se detecta', r !== null && r.carga.id === 'clau-hoy', JSON.stringify(r && r.motivo));
  BASE.pop();

  console.log('\n— Lo que SÍ es duplicado —');
  r = await buscarDuplicado({ numero: '2951', fecha: '2026-09-09' }, 'lalo', 39.002);
  eq('mismo número + mismos litros → duplicado', r !== null && r.carga.id === 'lalo', JSON.stringify(r && r.motivo));
  eq('y dice por qué', /litros/.test((r || {}).motivo || ''), (r || {}).motivo);
  r = await buscarDuplicado({ numero: '2951', fecha: '2026-09-09' }, 'lalo', 41);
  eq('mismo número, mismo día, mismo capataz pero OTROS litros → NO es duplicado (regla sacada el 14-sep)',
    r === null, JSON.stringify(r && r.motivo));
  r = await buscarDuplicado({ numero: '2989', lote: '20251760', tarjeta: '8062120460002', fecha: '2026-09-14' }, 'otro', 999);
  eq('misma tarjeta + mismo comprobante pero OTROS litros → NO es duplicado (los litros mandan)', r === null, JSON.stringify(r && r.motivo));
  r = await buscarDuplicado({ numero: '9999', tarjeta: '8062120460002', fecha: '2026-09-14' }, 'otro', 55.514);
  eq('misma tarjeta + mismos litros → duplicado', r !== null && r.carga.id === 'clau', JSON.stringify(r && r.motivo));

  console.log('\n— El OCR cruza remito y lote —');
  // eze1 tiene remito 20260498 y lote 1404; eze2 al revés. Reenviar el mismo
  // ticket con los campos cruzados tiene que detectarse igual.
  r = await buscarDuplicado({ numero: '1404', lote: '20260498', fecha: '2026-09-10' }, 'eze', 62.716);
  eq('reenviar con los campos cruzados se detecta igual', r !== null, JSON.stringify(r && r.motivo));

  console.log('\n— Sin número que coincida —');
  r = await buscarDuplicado({ numero: '9999', fecha: '2026-09-09' }, 'lalo', 39.002);
  eq('misma fecha + mismos litros + mismo capataz → duplicado', r !== null && r.carga.id === 'lalo');
  r = await buscarDuplicado({ numero: '9999', fecha: '2026-09-09', patente: 'KCG906' }, 'otro', 39.002);
  eq('o la misma patente', r !== null && r.carga.id === 'lalo');
  r = await buscarDuplicado({ numero: '9999', fecha: '2026-09-14' }, 'otro', 123.45);
  eq('nada en común → pasa', r === null);

  console.log('\n— Bordes —');
  r = await buscarDuplicado({}, null, null);
  eq('sin datos no explota', r === null || typeof r === 'object');
  r = await buscarDuplicado({ numero: null, lote: null, fecha: '2026-09-14' }, 'otro', 50);
  eq('sin número no inventa duplicados', r === null);
  r = await buscarDuplicado({ numero: '0002951', fecha: '2026-09-09' }, 'lalo', 39.002);
  eq('los ceros de adelante no importan', r !== null && r.carga.id === 'lalo');
  r = await buscarDuplicado({ numero: '2951', fecha: '2026-09-09' }, 'lalo', 39.0025);
  eq('medio centilitro de diferencia cuenta como mismos litros (tolerancia 0,01) → duplicado', r !== null);
  r = await buscarDuplicado({ numero: '2951', fecha: '2026-09-09' }, 'lalo', 39.05);
  eq('cinco centilitros de diferencia ya NO → pasa', r === null, r && r.motivo);

  console.log(`\n${ok} ok · ${mal} mal`);
  process.exit(mal ? 1 : 0);
})().catch(e => { console.error('✗ explotó:', e); process.exit(1); });
