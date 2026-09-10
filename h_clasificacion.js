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
eq('la Hilux aparece individual, con marca en la etiqueta', d.some(x => /Camioneta Toyota 40/.test(x.label)), JSON.stringify(d.map(x => x.label)));
eq('y guarda tipo y marca separados',        d.some(x => x.tipo_equipo === 'Camioneta' && x.marca === 'Toyota'));
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

console.log('\n— Marca separada del tipo (decisión 10-sep) —');
const sm = t => E.separarMarca(t);
// El caso que motivó todo: la misma motoguadaña escrita de 5 formas.
['Motoguadaña','motoguadañas echo','motoguadañ Sthil 291','motoguadaña husqvarna','Motoguadañas'].forEach(t => {
  eq(`"${t}" → tipo Motoguadaña`, sm(t).tipo === 'Motoguadaña', sm(t).tipo);
});
eq('"motoguadañas echo" trae marca Echo',        sm('motoguadañas echo').marca === 'Echo');
eq('"motoguadañ Sthil 291" trae Stihl y modelo 291', sm('motoguadañ Sthil 291').marca === 'Stihl' && sm('motoguadañ Sthil 291').modelo === '291');
eq('"Motoguadaña" sola no inventa marca',        sm('Motoguadaña').marca === null);
eq('"husvarna" mal escrito igual matchea',       sm('motoguadaña husvarna').marca === 'Husqvarna');

console.log('\n— Combinaciones que NO se pueden colapsar —');
eq('"Motosierra extensible" NO es "Motosierra"', sm('Motosierra extensible').tipo === 'Motosierra extensible', sm('Motosierra extensible').tipo);
eq('"Motosierra 250" sí es Motosierra',          sm('Motosierra 250').tipo === 'Motosierra' && sm('Motosierra 250').modelo === '250');
eq('"Sopladora mochila" no es "Sopladora"',      sm('Sopladora mochila').tipo === 'Sopladora mochila');
eq('"sopladora mochila Sthil" es la misma, marca Stihl', sm('sopladora mochila Sthil').tipo === 'Sopladora mochila' && sm('sopladora mochila Sthil').marca === 'Stihl');
eq('"Mochila Fumigar" y "mochila pulverizadora" son lo mismo',
  sm('Mochila Fumigar').tipo === sm('mochila pulverizadora').tipo, sm('Mochila Fumigar').tipo + ' vs ' + sm('mochila pulverizadora').tipo);

console.log('\n— Tractores y vehículos —');
eq('"tractor MF 1175" → Tractor, Massey',        sm('tractor MF 1175').tipo === 'Tractor' && sm('tractor MF 1175').marca === 'Massey');
eq('"Tractor new holland TT45" → Tractor',       sm('Tractor new holland TT45').tipo === 'Tractor' && sm('Tractor new holland TT45').marca === 'New Holland');
eq('"mini tractor John Deere" → Mini tractor',   sm('mini tractor John Deere').tipo === 'Mini tractor' && sm('mini tractor John Deere').marca === 'John Deere');
eq('"giro cero" también es Mini tractor',        sm('giro cero husqvarna').tipo === 'Mini tractor');
eq('"Toyot Hilux" → Camioneta, Toyota',          sm('Toyot Hilux').tipo === 'Camioneta' && sm('Toyot Hilux').marca === 'Toyota');
eq('"fiat strada U12" → Camioneta, Fiat',        sm('fiat strada U12').tipo === 'Camioneta' && sm('fiat strada U12').marca === 'Fiat');

console.log('\n— El tipo canónico no rompe lo que no conoce —');
eq('"Pala de punta" queda igual',                sm('Pala de punta').tipo === 'Pala de punta');
eq('"carro para tanque de 3000lts con bomba" no se convierte en modelo',
  /carro para tanque/i.test(sm('carro para tanque de 3000lts con bomba').tipo), sm('carro para tanque de 3000lts con bomba').tipo);
eq('un nombre que es solo números no se vacía',  sm('500').tipo === '500', sm('500').tipo);
eq('vacío no rompe',                             sm('').tipo === '');
eq('null no rompe',                              sm(null).tipo === '');

console.log('\n— Los destinos: el capataz ve la marca, el consumo suma por tipo —');
let dm = E.armarDestinos([
  { tipo_equipo: 'motoguadañas echo', cantidad: 5, numeros: [] },
  { tipo_equipo: 'motoguadañ Sthil 291', cantidad: 4, numeros: [] },
], [], []);
eq('el capataz ve las dos por separado, con marca',
  dm.some(x => /Motoguadaña Echo \(5\)/.test(x.label)) && dm.some(x => /Motoguadaña Stihl 291 \(4\)/.test(x.label)), JSON.stringify(dm.map(x => x.label)));
eq('pero las dos son tipo "Motoguadaña"', dm.every(x => x.tipo_equipo === 'Motoguadaña'), JSON.stringify(dm.map(x => x.tipo_equipo)));
eq('cada una trae su marca', dm.map(x => x.marca).sort().join(',') === 'Echo,Stihl');
eq('las dos son dos tiempos', dm.every(x => x.familia === 'dos_tiempos'));

console.log('\n— Confirmar el tipo vale para todas sus marcas —');
dm = E.armarDestinos([{ tipo_equipo: 'motoguadañas echo', cantidad: 5, numeros: [] }],
  [{ tipo_equipo: 'Motoguadaña', clasificacion_confirmada: true, es_maquinaria: true, consume_combustible: true,
     familia_consumo: 'dos_tiempos', combustible_habitual: 'super', modo_asignacion_combustible: 'grupo' }], []);
eq('confirmar "Motoguadaña" alcanza para "motoguadañas echo"', dm.length === 1 && dm[0].familia === 'dos_tiempos', JSON.stringify(dm));
dm = E.armarDestinos([{ tipo_equipo: 'motoguadañ Sthil 291', cantidad: 4, numeros: [] }],
  [{ tipo_equipo: 'Motoguadaña', clasificacion_confirmada: true, es_maquinaria: false, consume_combustible: false }], []);
eq('y si se manda el tipo a pañol, sus marcas también salen', dm.length === 0, JSON.stringify(dm));

console.log('\n— La familia se resuelve igual con marca adentro —');
eq('"motoguadañas echo" sigue siendo dos tiempos', s('motoguadañas echo').familia_consumo === 'dos_tiempos');
eq('"tractor MF 1175" sigue siendo tractor',       s('tractor MF 1175').familia_consumo === 'tractor');
eq('"fiat strada U12" sigue siendo vehículo',      s('fiat strada U12').familia_consumo === 'vehiculo');

console.log('\n— Bordes —');
eq('censo vacío no rompe',                   E.armarDestinos([], [], []).length === 0);
eq('censo null no rompe',                    E.armarDestinos(null, null, null).length === 0);
eq('tipo vacío se ignora',                   E.armarDestinos([{ tipo_equipo: '', cantidad: 1 }], [], []).length === 0);
eq('agrupar sin destinos no rompe',          E.agruparDestinos([]).length === 0);

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
