// Harness de equipos_clasificacion.js — la base de Cost Intelligence V4.
// Usa el módulo REAL. Los casos salen de censos reales de EcoService.
//
// Por qué importa: de acá sale la lista que el capataz ve al repartir el
// combustible. Si una máquina no aparece, el capataz no la puede elegir y
// va a poner los litros en cualquier otro lado. Si aparece una pala, el
// consumo por máquina queda mal.

const E = require('./equipos_clasificacion');
let ok = 0, mal = 0;
function eq(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

console.log('— Clasificación sugerida —');
const s = t => E.sugerirClasificacion(t);
eq('Motoguadaña → dos tiempos, súper, grupo',
  s('Motoguadaña').familia_consumo === 'dos_tiempos' && s('Motoguadaña').combustible_habitual === 'super' && s('Motoguadaña').modo_asignacion_combustible === 'grupo');
eq('Motosierra → dos tiempos',      s('Motosierra 250').familia_consumo === 'dos_tiempos');
eq('Sopladora → dos tiempos',       s('sopladora mochila sthil').familia_consumo === 'dos_tiempos');
eq('Extensible → dos tiempos',      s('Motosierra extensible').familia_consumo === 'dos_tiempos');
eq('Tractor → tractor, gasoil, individual',
  s('Tractor new holland TT45').familia_consumo === 'tractor' && s('Tractor').combustible_habitual === 'gasoil' && s('Tractor').modo_asignacion_combustible === 'individual');
eq('Toyota Hilux → vehículo',       s('Toyota Hilux 3.0').familia_consumo === 'vehiculo');
eq('Fiat Strada → vehículo',        s('fiat strada U12').familia_consumo === 'vehiculo');

console.log('\n— mini_tractor se separa de tractor (pedido explícito del V4) —');
eq('"Mini tractor" → mini_tractor',       s('Mini tractor').familia_consumo === 'mini_tractor', s('Mini tractor').familia_consumo);
eq('"minitractor John Deere" → mini_tractor', s('minitractor John Deere').familia_consumo === 'mini_tractor');
eq('"Mini tractor / Giro cero" → mini_tractor', s('Mini tractor / Giro cero').familia_consumo === 'mini_tractor');
eq('"giro cero husqvarna" → mini_tractor', s('giro cero husqvarna').familia_consumo === 'mini_tractor');
eq('un tractor común NO cae en mini',      s('Tractor MF 1175').familia_consumo === 'tractor');
eq('el mini tractor es individual y gasoil', s('Minitractor').modo_asignacion_combustible === 'individual' && s('Minitractor').combustible_habitual === 'gasoil');

console.log('\n— Pañol: lo que no tiene motor —');
['Pala de punta','Pala ancha','Machete','Podón','Tijera de podar','Rastrillo','Carretilla','Pico',
 'Grasera','Maza','Destornillador Philips','Conos de marcación','Escalera','Manguera de riego','Horquilla'].forEach(t => {
  const c = s(t);
  eq(`"${t}" → pañol, no consume`, c.familia_consumo === 'panol' && c.es_maquinaria === false && c.consume_combustible === false, c.familia_consumo);
});

console.log('\n— La sugerencia nunca se confirma sola —');
eq('sugerir no marca confirmada', s('Motoguadaña').clasificacion_confirmada === false);
eq('lo que el clasificador no supo queda marcado como dudoso', s('aparato raro xyz').dudosa === true);
eq('lo que sí supo, no es dudoso', s('Motoguadaña').dudosa === false);

console.log('\n— Lo confirmado gana sobre lo sugerido —');
let c = E.clasificacionEfectiva({ tipo_equipo: 'Pala de punta', clasificacion_confirmada: true,
  es_maquinaria: true, consume_combustible: true, familia_consumo: 'otro_motor', combustible_habitual: 'super', modo_asignacion_combustible: 'grupo' });
eq('una pala confirmada como con motor, se respeta', c.es_maquinaria === true && c.familia_consumo === 'otro_motor' && c.origen === 'confirmada');
c = E.clasificacionEfectiva({ tipo_equipo: 'Motoguadaña' });
eq('sin confirmar, usa la sugerencia', c.familia_consumo === 'dos_tiempos' && c.origen === 'sugerida');
c = E.clasificacionEfectiva({ tipo_equipo: 'Motoguadaña', clasificacion_confirmada: true, es_maquinaria: false, consume_combustible: false });
eq('una motoguadaña confirmada como pañol, se respeta', c.es_maquinaria === false && c.consume_combustible === false);

console.log('\n— Compatibilidad de combustible —');
eq('gasoil acepta "V-POWER DIESEL"',      E.aceptaCombustible('gasoil', 'V-POWER DIESEL'));
eq('gasoil acepta "ION PUMA DIESEL"',     E.aceptaCombustible('gasoil', 'ION PUMA DIESEL'));
eq('gasoil acepta "EVOLUX DIESEL"',       E.aceptaCombustible('gasoil', 'EVOLUX DIESEL'));
eq('gasoil NO acepta "PUMA SUPER"',      !E.aceptaCombustible('gasoil', 'PUMA SUPER'));
eq('gasoil NO acepta "Nafta super"',     !E.aceptaCombustible('gasoil', 'Nafta super'));
eq('súper acepta "PUMA SUPER"',           E.aceptaCombustible('super', 'PUMA SUPER'));
eq('súper acepta "SUPER"',                E.aceptaCombustible('super', 'SUPER'));
eq('súper NO acepta "GASOIL"',           !E.aceptaCombustible('super', 'GASOIL'));
eq('mixto acepta cualquiera',             E.aceptaCombustible('mixto', 'GASOIL') && E.aceptaCombustible('mixto', 'SUPER'));
eq('sin combustible definido, acepta',    E.aceptaCombustible(null, 'GASOIL'));
eq('producto raro no bloquea',            E.aceptaCombustible('gasoil', 'BIDON X 10 LTS'));

console.log('\n— Destinos: el censo de COUNTRY CAÑUELAS —');
const CENSO_CANUELAS = [
  { tipo_equipo: 'Motoguadaña', cantidad: 4, numeros: ['11','12','K','HE1'] },
  { tipo_equipo: 'Tractor', cantidad: 1, numeros: ['5002A'] },
  { tipo_equipo: 'Toyot Hilux', cantidad: 1, numeros: ['40'] },
  { tipo_equipo: 'Cortacerco Echo', cantidad: 1, numeros: [] },
  { tipo_equipo: 'Mochila Fumigar', cantidad: 1, numeros: [] },
  { tipo_equipo: 'Pala de punta', cantidad: 2, numeros: [] },
  { tipo_equipo: 'Machete', cantidad: 1, numeros: [] },
];
let d = E.armarDestinos(CENSO_CANUELAS, [], []);
eq('las palas y machetes NO son destinos',   !d.some(x => /pala|machete/i.test(x.tipo_equipo)), JSON.stringify(d.map(x => x.label)));
eq('el tractor aparece individual, con su número', d.some(x => x.label === 'Tractor 5002A' && x.modo === 'individual'));
eq('la Hilux aparece individual',            d.some(x => /Hilux 40/.test(x.label)));
eq('las motoguadañas aparecen como GRUPO de 4', d.some(x => x.label === 'Motoguadaña (4)' && x.modo === 'grupo' && x.cantidad === 4), JSON.stringify(d.map(x => x.label)));
eq('el cortacerco aparece',                  d.some(x => /Cortacerco/i.test(x.label)));

console.log('\n— Filtro por producto —');
d = E.armarDestinos(CENSO_CANUELAS, [], [], { producto: 'GASOIL' });
eq('con gasoil aparece el tractor',          d.some(x => /Tractor/.test(x.label)));
eq('con gasoil NO aparecen las motoguadañas', !d.some(x => /Motoguadaña/.test(x.label)), JSON.stringify(d.map(x => x.label)));
d = E.armarDestinos(CENSO_CANUELAS, [], [], { producto: 'PUMA SUPER' });
eq('con súper aparecen las motoguadañas',    d.some(x => /Motoguadaña/.test(x.label)));
eq('con súper NO aparece el tractor',        !d.some(x => /Tractor/.test(x.label)), JSON.stringify(d.map(x => x.label)));

console.log('\n— Unidades de la flota (no se censan) —');
d = E.armarDestinos(CENSO_CANUELAS, [], [{ id: 'u1', codigo: 'U22', marca_modelo: 'Toyota Hilux 3.0', patente: 'KCG906' }], { producto: 'GASOIL' });
eq('la unidad de flota aparece',             d.some(x => x.ref_tipo === 'unidad' && /KCG906/.test(x.label)));
eq('y trae su id para guardar unidad_id',    d.some(x => x.ref_tipo === 'unidad' && x.ref_id === 'u1'));

console.log('\n— Máquinas individuales sin número —');
d = E.armarDestinos([{ tipo_equipo: 'Tractor', cantidad: 3, numeros: ['T1'] }], [], []);
eq('el T1 aparece solo',                     d.some(x => x.label === 'Tractor T1'));
eq('los otros 2 aparecen como "sin número (2)"', d.some(x => /sin n[úu]mero \(2\)/.test(x.label) && x.sin_identificar), JSON.stringify(d.map(x => x.label)));
d = E.armarDestinos([{ tipo_equipo: 'Motoguadaña', cantidad: 3, numeros: ['sn','sn','12'] }], [], []);
eq('los "sn" no se toman como número',       d[0].numeros.length === 1 && d[0].numeros[0] === '12', JSON.stringify(d[0]));

console.log('\n— Agrupado por familia —');
const g = E.agruparDestinos(E.armarDestinos(CENSO_CANUELAS, [], []));
eq('agrupa en familias',                     g.length >= 3, JSON.stringify(g.map(x => x.familia)));
eq('dos tiempos primero, vehículos después', g.findIndex(x => x.familia === 'dos_tiempos') < g.findIndex(x => x.familia === 'vehiculo'));
eq('cada grupo trae su total',               g.find(x => x.familia === 'dos_tiempos').total >= 4);
eq('ningún grupo es pañol',                  !g.some(x => x.familia === 'panol'));

console.log('\n— La clasificación confirmada cambia los destinos —');
d = E.armarDestinos(CENSO_CANUELAS,
  [{ tipo_equipo: 'Mochila Fumigar', clasificacion_confirmada: true, es_maquinaria: false, consume_combustible: false }], []);
eq('confirmar la mochila como pañol la saca de los destinos', !d.some(x => /Mochila/i.test(x.label)));
d = E.armarDestinos([{ tipo_equipo: 'Pala de punta', cantidad: 1, numeros: [] }],
  [{ tipo_equipo: 'Pala de punta', clasificacion_confirmada: true, es_maquinaria: true, consume_combustible: true, familia_consumo: 'dos_tiempos', combustible_habitual: 'super', modo_asignacion_combustible: 'grupo' }], []);
eq('confirmar una pala como máquina la mete en los destinos', d.length === 1 && d[0].familia === 'dos_tiempos');

console.log('\n— Validación del reparto (tolerancia 0,01) —');
let v = E.validarReparto(100, [{ litros: 60 }, { litros: 40 }]);
eq('60 + 40 de 100 cierra',                  v.cierra && v.estado === 'completa' && v.resta === 0);
v = E.validarReparto(36, [{ litros: 26 }]);
eq('26 de 36 no cierra, faltan 10',          !v.cierra && v.resta === 10 && v.estado === 'parcial');
v = E.validarReparto(100, [{ litros: 110 }]);
eq('pasarse da resta negativa',              !v.cierra && v.resta === -10);
v = E.validarReparto(39.002, [{ litros: 39.002 }]);
eq('decimales del ticket cierran',           v.cierra, JSON.stringify(v));
v = E.validarReparto(100, [{ litros: 99.995 }]);
eq('diferencia menor a 0,01 cierra',         v.cierra, JSON.stringify(v));
v = E.validarReparto(100, [{ litros: 99.9 }]);
eq('diferencia de 0,1 NO cierra',            !v.cierra);
v = E.validarReparto(100, []);
eq('sin reparto queda pendiente',            v.estado === 'pendiente' && !v.cierra);

console.log('\n— Bordes —');
eq('censo vacío no rompe',                   E.armarDestinos([], [], []).length === 0);
eq('censo null no rompe',                    E.armarDestinos(null, null, null).length === 0);
eq('tipo vacío se ignora',                   E.armarDestinos([{ tipo_equipo: '', cantidad: 1 }], [], []).length === 0);
eq('agrupar sin destinos no rompe',          E.agruparDestinos([]).length === 0);

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
