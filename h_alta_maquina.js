// Harness del alta de máquinas en la app (app.html).
//
// Extrae las funciones REALES del archivo y las corre. Lo que se prueba es
// lo que decide qué queda cargado: sumar a una máquina existente, no
// duplicar números, y que la cantidad siga a los números cuando el capataz
// carga más de los que declaró.
//
// Importa porque de acá sale el censo, y del censo salen los destinos de
// combustible y los desvíos semanales.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/app.html', 'utf8');
function saca(desde, hasta) {
  const i = src.indexOf(desde);
  if (i < 0) { console.error('✗ No encontré en app.html: ' + desde); process.exit(1); }
  const j = src.indexOf(hasta, i);
  return src.slice(i, j < 0 ? undefined : j);
}
// El catálogo y los helpers que deciden qué se guarda.
const cuerpo =
  saca('const CAT_MAQ=[', 'let agrPaso=1') +
  'let agrPaso=1, agrTipo=null, agrCant=1, agrNums=[], agrMarca="", agrQ="";\n' +
  saca('function agrAddNum(v){', 'function agrGuardar(sumar){') +
  saca('function agrGuardar(sumar){', 'async function capStockGuardar');

const ctx = `
  let capStockEdit=[];
  const toast=()=>{}; const render=()=>{}; const agrCerrar=()=>{};
  const renderAgregar=()=>{};
`;
const api = new Function(ctx + cuerpo + `
  return {
    CAT_MAQ, normTipoApp, agrAddNum, agrGuardar,
    set(st,tipo,fam,cant,nums,marca){ capStockEdit=st; agrTipo={tipo,familia:fam};
      agrCant=cant; agrNums=nums.slice(); agrMarca=marca||''; },
    estado:()=>capStockEdit, nums:()=>agrNums, cant:()=>agrCant,
    setNums(n,c){agrNums=n.slice();agrCant=c;},
  };`)();

let ok = 0, mal = 0;
function eq(n, c, d) { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } }

console.log('— El catálogo —');
const todos = api.CAT_MAQ.flatMap(([, ms]) => ms);
eq('la motoguadaña está primera (335 de 471 equipos son 2T)', api.CAT_MAQ[0][1][0][0] === 'Motoguadaña', JSON.stringify(api.CAT_MAQ[0][1][0]));
eq('están las que más se usan', ['Motoguadaña','Motosierra','Sopladora','Tractor','Mini tractor','Camioneta'].every(t => todos.some(([x]) => x === t)));
eq('mini tractor va separado de tractor', todos.find(([t]) => t === 'Mini tractor')[2] === 'mini_tractor' && todos.find(([t]) => t === 'Tractor')[2] === 'tractor');
eq('cada opción trae su familia', todos.every(([, , f]) => !!f), JSON.stringify(todos.filter(([, , f]) => !f)));
eq('ninguna opción es de pañol', !todos.some(([, , f]) => f === 'panol'));
eq('no hay tipos repetidos', new Set(todos.map(([t]) => t)).size === todos.length);

console.log('\n— Normalizar el tipo (para detectar duplicados) —');
eq('"Motosierra" y "motosierra" son lo mismo', api.normTipoApp('Motosierra') === api.normTipoApp('motosierra'));
eq('los acentos no importan', api.normTipoApp('Motoguadaña') === api.normTipoApp('MOTOGUADAÑA'));
eq('"Mini tractor" y "mini  tractor" son lo mismo', api.normTipoApp('Mini tractor') === api.normTipoApp('mini  tractor'));
eq('"Motosierra" y "Motosierra extensible" NO son lo mismo', api.normTipoApp('Motosierra') !== api.normTipoApp('Motosierra extensible'));

console.log('\n— Agregar una máquina nueva —');
let st = [];
api.set(st, 'Motosierra', 'dos_tiempos', 2, ['11', '14'], 'Stihl');
api.agrGuardar(false);
eq('se agrega', st.length === 1 && st[0].tipo_equipo === 'Motosierra');
eq('con su cantidad y números', st[0].cantidad === 2 && st[0].numeros.join(',') === '11,14');
eq('la marca va a observación', st[0].observacion === 'Stihl');
eq('queda marcada como maquinaria con su familia', st[0].clasificacion.es_maquinaria === true && st[0].clasificacion.familia_consumo === 'dos_tiempos');

console.log('\n— Sumar a una que ya tenía (decisión 11-sep: avisar y sumar) —');
st = [{ tipo_equipo: 'Motosierra', cantidad: 2, numeros: ['11', '14'], observacion: null, clasificacion: {} }];
api.set(st, 'Motosierra', 'dos_tiempos', 3, ['20'], '');
api.agrGuardar(true);
eq('sigue habiendo UNA fila', st.length === 1, JSON.stringify(st.map(x => x.tipo_equipo)));
eq('la cantidad se suma: 2 + 3 = 5', st[0].cantidad === 5, String(st[0].cantidad));
eq('los números se juntan', st[0].numeros.join(',') === '11,14,20', st[0].numeros.join(','));

console.log('\n— Sumar sin pisar lo que ya estaba —');
st = [{ tipo_equipo: 'Motosierra', cantidad: 2, numeros: ['11'], observacion: 'Husqvarna', clasificacion: {} }];
api.set(st, 'Motosierra', 'dos_tiempos', 1, ['11', '14'], 'Stihl');
api.agrGuardar(true);
eq('un número repetido no se duplica', st[0].numeros.join(',') === '11,14', st[0].numeros.join(','));
eq('la marca que ya estaba NO se pisa', st[0].observacion === 'Husqvarna');

console.log('\n— Dejarlas separadas si el capataz lo elige —');
st = [{ tipo_equipo: 'Motosierra', cantidad: 2, numeros: ['11'], observacion: null, clasificacion: {} }];
api.set(st, 'Motosierra', 'dos_tiempos', 1, ['99'], '');
api.agrGuardar(false);
eq('quedan dos filas', st.length === 2, String(st.length));
eq('la vieja no se toca', st[0].cantidad === 2 && st[0].numeros.join(',') === '11');

console.log('\n— Cargar números —');
api.setNums([], 3);
api.agrAddNum('50');
eq('agrega uno', api.nums().join(',') === '50');
api.agrAddNum('51, 45');
eq('acepta varios separados por coma', api.nums().join(',') === '50,51,45');
api.agrAddNum('50');
eq('no repite el mismo número', api.nums().join(',') === '50,51,45');
api.agrAddNum('  ');
eq('ignora vacíos', api.nums().length === 3);
api.agrAddNum('SN');
eq('acepta "SN" como número escrito (después se limpia al guardar)', api.nums().length === 4);

console.log('\n— Si carga más números que la cantidad, sube la cantidad —');
api.setNums([], 2);
api.agrAddNum('1, 2, 3, 4');
eq('4 números con cantidad 2 → la cantidad pasa a 4', api.cant() === 4, String(api.cant()));
api.setNums([], 5);
api.agrAddNum('1, 2');
eq('2 números con cantidad 5 → la cantidad NO baja (faltan por cargar)', api.cant() === 5, String(api.cant()));

console.log('\n— Bordes —');
st = [];
api.set(st, 'Desmalezadora', 'otro_motor', 1, [], '');
api.agrGuardar(false);
eq('una máquina que no está en el catálogo se agrega igual', st.length === 1 && st[0].tipo_equipo === 'Desmalezadora');
eq('y cae en "otro motor", no en pañol', st[0].clasificacion.familia_consumo === 'otro_motor');
st = [{ tipo_equipo: 'Tractor', cantidad: 1, numeros: [], observacion: null, clasificacion: {} }];
api.set(st, 'Motosierra', 'dos_tiempos', 1, [], '');
api.agrGuardar(true);
eq('pedir sumar a algo que no existe, la agrega igual', st.length === 2, JSON.stringify(st.map(x => x.tipo_equipo)));
api.set([], 'Motoguadaña', 'dos_tiempos', 1, [], '');
eq('sin marca, observación queda null', (() => { const s2 = []; api.set(s2, 'X', 'otro_motor', 1, [], ''); api.agrGuardar(false); return s2[0].observacion === null; })());

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
