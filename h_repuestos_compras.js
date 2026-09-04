// Harness de la clasificación de pedidos en Compras → Repuestos (panel.js).
//
// Extrae los tres filtros REALES del archivo (sin cotizar / en curso /
// aprobados) y verifica que TODO pedido caiga en exactamente uno. El bug del
// 04-sep fue justamente ese: un pedido recién marcado por el mecánico no
// entraba en ninguna de las listas y desaparecía de Compras.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/panel.js', 'utf8');

function extraer(marca, nombre) {
  const i = src.indexOf(marca);
  if (i < 0) { console.error(`✗ No encontré ${nombre} en panel.js — cambió el archivo`); process.exit(1); }
  return src.slice(i, src.indexOf(';', i) + 1);
}
// Los tres filtros, tal cual están escritos en el código.
const fSin = new Function('rtData', extraer("const sin=(rtData||[]).filter(p=>", 'filtro sin cotizar') + '\nreturn sin;');
const fCur = new Function('rtData', extraer("const enCurso=(rtData||[]).filter(p=>", 'filtro en curso') + '\nreturn enCurso;');
const fAll = new Function('rtData', extraer("const all=(rtData||[]).filter(p=>", 'filtro lista clásica') + '\nreturn all;');
const fCot = new Function('rtData', extraer("const cots=(rtData||[]).filter(p=>", 'filtro aprobación') + '\nreturn cots;');

let ok = 0, mal = 0;
function eq(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}
// ¿En cuántas de las cuatro listas cae este pedido?
function donde(p) {
  const d = [];
  if (fSin([p]).length) d.push('sin_cotizar');
  if (fCur([p]).length) d.push('en_curso');
  if (fCot([p]).length) d.push('aprobacion');
  if (fAll([p]).length) d.push('lista');
  return d;
}

// ── El pedido real de la U21 (captura del 04-sep) ─────────────
const U21 = { id: 'p-u21', estado: 'pedido', created_at: '2026-08-26T10:00:00Z', pedido_por: 'Carlos Gonzalez',
  incidencias: { numero_unidad: 'U21', tipo_equipo: 'Toyota / Camioneta', objetivos: { nombre: 'Logistica Jose Ragessi' } },
  items: [
    { descripcion: 'Cubierta 195/70/15', cantidad: 2 }, { descripcion: 'Válvula de aire (vástago)', cantidad: 2 },
    { descripcion: 'Sellador de llantas', cantidad: 1 }, { descripcion: 'caja auxiliar de direccion', cantidad: 1 },
    { descripcion: 'barra cntral de extremos', cantidad: 1 }, { descripcion: 'juego de pastillas de freno', cantidad: 1 },
    { descripcion: 'faro de giro lado derecho delatero', cantidad: 1 },
  ] };

console.log('— El pedido que desapareció —');
eq('la U21 aparece en Compras', donde(U21).length > 0, 'no cae en ninguna lista');
eq('y cae en "sin cotizar"', donde(U21).includes('sin_cotizar'), donde(U21).join(','));
eq('en una sola lista, no duplicada', donde(U21).length === 1, donde(U21).join(','));

console.log('\n— Cada estado cae en exactamente una lista —');
const casos = [
  ['pedido sin precio', { estado: 'pedido', items: [{ descripcion: 'x', cantidad: 1 }] }, 'sin_cotizar'],
  ['en cotización sin precio', { estado: 'en_cotizacion', items: [{ descripcion: 'x' }] }, 'sin_cotizar'],
  ['en cotización con UN precio', { estado: 'en_cotizacion', items: [{ descripcion: 'x', precio: 100, proveedor: 'A' }, { descripcion: 'y' }] }, 'en_curso'],
  ['pedido con un precio suelto', { estado: 'pedido', items: [{ descripcion: 'x', precio: 100, proveedor: 'A' }, { descripcion: 'y' }] }, 'en_curso'],
  ['cotizado (nota cargada)', { estado: 'cotizado', nota_precio: 48500, items: [{ descripcion: 'x' }] }, 'aprobacion'],
  ['a comprar (aprobado)', { estado: 'a_comprar', items: [{ descripcion: 'x' }] }, 'lista'],
  ['comprado', { estado: 'comprado', items: [{ descripcion: 'x' }] }, 'lista'],
  ['entregado', { estado: 'entregado', items: [{ descripcion: 'x' }] }, 'lista'],
];
casos.forEach(([nombre, p, esperado]) => {
  const d = donde({ created_at: '2026-09-01T10:00:00Z', items: [], ...p });
  eq(`${nombre} → ${esperado}`, d.length === 1 && d[0] === esperado, d.join(',') || 'ninguna');
});

console.log('\n— Un pedido con nota cargada no vuelve a "sin cotizar" —');
const conNota = { estado: 'pedido', nota_precio: 12000, nota_proveedor: 'X', created_at: '2026-09-01T10:00:00Z', items: [{ descripcion: 'x' }] };
eq('un pedido con nota_precio no figura como sin cotizar', !fSin([conNota]).length, donde(conNota).join(','));

console.log('\n— Ningún pedido queda invisible —');
const todos = casos.map(([, p]) => ({ created_at: '2026-09-01T10:00:00Z', items: [], ...p })).concat([U21, conNota]);
const huerfanos = todos.filter(p => donde(p).length === 0);
eq('ningún estado queda fuera de todas las listas', huerfanos.length === 0, JSON.stringify(huerfanos.map(p => p.estado)));
const duplicados = todos.filter(p => donde(p).length > 1);
eq('ningún pedido aparece en dos listas a la vez', duplicados.length === 0, JSON.stringify(duplicados.map(p => [p.estado, donde(p)])));

console.log('\n— Bordes —');
eq('sin datos no rompe', fSin([]).length === 0 && fCur([]).length === 0 && fAll([]).length === 0);
eq('un pedido sin items no rompe', donde({ estado: 'pedido', created_at: '2026-09-01T10:00:00Z' }).includes('sin_cotizar'));
eq('items null no rompe', donde({ estado: 'pedido', items: null, created_at: '2026-09-01T10:00:00Z' }).includes('sin_cotizar'));

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
