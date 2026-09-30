// Harness conciliación Edenred (30-sep). Usa el parser de panel.js y el
// emparejador con datos reales (Raw de Edenred + 40 cargas de septiembre).
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/panel.js', 'utf8');
const i0 = src.indexOf('function edenredFilas('), i1 = src.indexOf('async function combRemExcel(');
const edenredFilas = new Function(src.slice(i0, i1) + '; return edenredFilas;')();
const CE = require('./conciliacion_edenred');
let ok = 0, mal = 0;
const t = (n, c) => { if (c) { ok++; console.log('OK ', n); } else { mal++; console.log('MAL', n); } };

// 1) Parser con matriz tipo Raw (fechas texto, transacción repetida)
const H = ['Unidad', 'Placa', 'Producto / Servicio', 'Fecha', 'hora', 'M.N.', 'Litros', 'Conductor', 'No. Transacción', 'Capacidad de tanque', 'Estación de servicio'];
const raw = [H,
  ['PFE923', 'PFE923', 'NAFTA SUPER', '29/09/2026', '02:18:46', 66990, 30, 'Diego Gonzalez', '55635565', 60, 'SHELL'],
  ['PFE923', 'PFE923', 'NAFTA SUPER', '29/09/2026', '02:18:46', 66990, 30, 'Diego Gonzalez', '55635565', 60, 'SHELL'],
  ['PFE923', 'PFE923', 'NAFTA SUPER', '19/09/2026', '10:00:00', 44996.35, 20.65, 'Diego Gonzalez', '54980644', 60, 'SHELL'],
  ['', '', '', '', '', 999, '', '', '', '', '']];
const d = edenredFilas(raw);
t('parser Raw: 2 filas (dedup + ignora totales)', d && d.filas.length === 2);
t('parser: fecha ISO y hora', d.filas[0].fecha === '2026-09-29' && d.filas[0].hora === '02:18');
t('parser: período', d.periodo_desde === '2026-09-19' && d.periodo_hasta === '2026-09-29');
t('parser: origen edenred', d.origen === 'edenred_xlsx');

// 2) Parser formato "Reporte de consumo" (encabezado en fila 1, tarjeta)
const rep = [['FECHA', 'HORA', 'UNIDAD', 'PLACA / IDENTIFICACIÓN', 'TARJETA', 'MONEDERO', 'PRODUCTO/SERVICIO', 'TRANSACCIÓN', 'PRECIO LTS CON DESCUENTO', 'LITROS', 'M.N.', 'NETO', 'ESTACIÓN DE SERVICIO'],
  ['ECOSERVICE SRL  (34108.1)', '', '', '', '', '', '', '', '', 3110.52, 7259001.29, 5047758.55, ''],
  ['21/8/2026', '11:28:51', 'AB312SQ', 'AB312SQ', '3084620213404880', 'COMBUSTIBLE EDENRED', 'DIESEL PREMIUM', 'CONSUMO', 2465, 20.77, 51190.66, 37245.17, 'PUMA']];
const d2 = edenredFilas(rep);
t('parser Reporte: 1 fila con tarjeta', d2 && d2.filas.length === 1 && d2.filas[0].tarjeta === '3084620213404880' && d2.filas[0].fecha === '2026-08-21');
t('parser: Excel que no es Edenred → null', edenredFilas([['a', 'b'], [1, 2]]) === null);

// 3) Datos reales si están
const RAW = '/tmp/claude-0/raw.json', PAN = '/tmp/claude-0/panel.json';
if (fs.existsSync(RAW) && fs.existsSync(PAN)) {
  const de = edenredFilas(JSON.parse(fs.readFileSync(RAW)));
  t('real: 207 líneas (el Raw repite una transacción)', de.filas.length === 207);
  const grupos = de.filas.map(f => ({ ...f, key: 'ED|' + f.numero_remito, eden: true }));
  const cargas = JSON.parse(fs.readFileSync(PAN)).map((c, i) => ({ id: i + 1, fecha: c.fecha, litros_total: c.litros_total,
    numero_remito: c.numero_remito, tarjeta: c.tarjeta, patente_raw: c.patente === 'null' ? null : c.patente,
    capataces: { nombre: c.capataz } }));
  const { pares } = CE.emparejar(grupos, cargas, {});
  const okPar = pares.filter(p => Math.abs(p.dif) <= 1);
  console.log('   emparejadas', pares.length, '/', cargas.length, '· desvíos', pares.length - okPar.length);
  t('real: al menos 30 de 40 con pareja', pares.length >= 30);
  const diego = pares.find(p => p.c.litros_total === '19.2370');
  t('real: Diego 19,237 → PFE923 19/09', diego && diego.g.patente === 'PFE923' && diego.g.fecha === '2026-09-19');
  const noct = pares.find(p => p.c.fecha === '2026-09-30' && p.c.capataces.nombre === 'Diego Gonzalez');
  t('real: carga 30/09 de Diego ↔ Edenred 29/09 02:18', noct && noct.g.fecha === '2026-09-29');
  const malChofer = pares.filter(p => Math.abs(p.dif) <= 1 && !/chofer|tarjeta|patente/.test(p.via) && Number.isInteger(Number(p.g.litros)));
  t('real: ninguna carga redonda emparejada sin chofer/tarjeta/patente', malChofer.length === 0);
  const unaVez = new Set(pares.map(p => p.c.id)).size === pares.length && new Set(pares.map(p => p.g.key)).size === pares.length;
  t('real: cada carga y cada línea se usan una sola vez', unaVez);
}
t('alertas: nocturna + 3 el mismo día', CE.alertas({ hora: '02:18', litros: 30, tanque: 60 }, 3).length === 2);
t('alertas: hora ambigua (Raw 12 h) no marca nocturna', CE.alertas({ hora: '02:10 / 14:10', hora12: true, litros: 30 }, 1).length === 0);
t('CC: SERVI SUD no es Edenred', !CE.puedeSerEdenred({ proveedores: { nombre: 'SERVI SUD SA' } }) && !CE.puedeSerEdenred({ proveedores: { nombre: 'SEROT SUD SA' } }) && !CE.puedeSerEdenred({ proveedores: { nombre: 'ESTACION FERREYRA SRL' } }));
t('ECOSERVICE SRL sin tarjeta sí puede ser Edenred', CE.puedeSerEdenred({ proveedores: { nombre: 'ECOSERVICE SRL' } }) && CE.puedeSerEdenred({ proveedores: null }));
t('remito formal 0033-… no es Edenred aunque diga GWG', !CE.puedeSerEdenred({ numero_remito: '0033-00000519', proveedores: { nombre: 'GWG' } }));
t('nombre: Chaves ≈ Chavez', CE.parecidoNombre('Claudio Chaves', 'Claudio Chavez') === 2);
console.log(`\n${ok} OK · ${mal} MAL`); process.exit(mal ? 1 : 0);
