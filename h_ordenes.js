// Harness de ordenes.js — la lógica pura de las órdenes de compra.
// Usa el módulo REAL (require), no una copia.
//
// Por qué importa: de acá sale a qué centro de costo va cada ítem de una
// factura. Un emparejamiento mal hecho imputa plata al objetivo equivocado en
// Flexxus, sin fallar y sin avisar. Los casos usan compras reales del mes.

const O = require('./ordenes');
let ok = 0, mal = 0;
function eq(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

console.log('— Tramos (decisión 02-sep: directa ≤500k, comparativos ≥800k, total con IVA) —');
eq('$0 es directa',                O.tramoDeMonto(0) === 'directa');
eq('$500.000 es directa (tope inclusive)', O.tramoDeMonto(500000) === 'directa');
eq('$500.001 pide presupuesto',    O.tramoDeMonto(500001) === 'presupuesto');
eq('$799.999 pide presupuesto',    O.tramoDeMonto(799999) === 'presupuesto');
eq('$800.000 pide comparativos',   O.tramoDeMonto(800000) === 'comparativos');
eq('directa no exige cotizaciones', O.cotizacionesRequeridas('directa') === 0);
eq('presupuesto exige 1',           O.cotizacionesRequeridas('presupuesto') === 1);
eq('comparativos exige 2',          O.cotizacionesRequeridas('comparativos') === 2);

console.log('\n— Numeración —');
eq('primera del año',              O.siguienteNumero(null, 2026) === 'OC-2026-0001', O.siguienteNumero(null, 2026));
eq('sigue el correlativo',         O.siguienteNumero('OC-2026-0041', 2026) === 'OC-2026-0042');
eq('cambio de año reinicia',       O.siguienteNumero('OC-2025-0388', 2026) === 'OC-2026-0001');
eq('un número corrupto no rompe',  O.siguienteNumero('basura', 2026) === 'OC-2026-0001');

console.log('\n— Centro de costo: objetivos vs centros_costo —');
const CC = ['CHACRAS DE LA VILLA', 'UCC', 'JOCKEY', 'CAÑUELAS', 'MUNICIPALIDAD DE CORDOBA',
  'CAMINOS DE LAS SIERRAS COSQUIN', 'CAMINOS DE LAS SIERRAS CIRCUNVALACION', 'DEPOSITO', 'PRITTY'];
eq('exacto sin importar mayúsculas',  (O.resolverCentroCosto('deposito', CC) || {}).nombre === 'DEPOSITO');
eq('"Chacras" cae en CHACRAS DE LA VILLA', (O.resolverCentroCosto('Chacras', CC) || {}).nombre === 'CHACRAS DE LA VILLA');
eq('"Municipalidad de Córdoba" con acento resuelve', (O.resolverCentroCosto('Municipalidad de Córdoba', CC) || {}).nombre === 'MUNICIPALIDAD DE CORDOBA');
eq('"Caminos de las Sierras" es ambiguo → null (hay dos)', O.resolverCentroCosto('Caminos de las Sierras', CC) === null);
eq('"Caminos las sierras Cosquin" resuelve al de Cosquin',
  (O.resolverCentroCosto('Caminos las sierras Cosquin', CC) || {}).nombre === 'CAMINOS DE LAS SIERRAS COSQUIN');
eq('un objetivo que no existe → null', O.resolverCentroCosto('parque sarmiento', CC) === null);
eq('vacío → null', O.resolverCentroCosto('', CC) === null);
eq('alias declarado en el maestro', (O.resolverCentroCosto('jcc', [{ nombre: 'JOCKEY', aliases: ['jcc'] }]) || {}).nombre === 'JOCKEY');

console.log('\n— Emparejamiento: la factura de Ragaglia contra la OC-0041 —');
const ORDEN = { numero: 'OC-2026-0041', total_estimado: 48500, items: [
  { descripcion: 'Bujía NGK BPMR7A', cantidad: 2, codigo: 'BPMR7A', objetivo: 'MUNICIPALIDAD DE CORDOBA', unidad: 'U22 — Toyota Hilux — KCG906', comentario: 'Reparación #312 · KCG906 · no arranca' },
  { descripcion: 'Filtro de aire',   cantidad: 1, codigo: null,     objetivo: 'MUNICIPALIDAD DE CORDOBA', unidad: 'U22 — Toyota Hilux — KCG906', comentario: 'Reparación #312 · KCG906 · no arranca' },
  { descripcion: 'Aceite 2T 1 lt',   cantidad: 3, codigo: null,     objetivo: 'MUNICIPALIDAD DE CORDOBA', unidad: 'U22 — Toyota Hilux — KCG906', comentario: 'Reparación #312 · KCG906 · no arranca' },
]};
const FACT = [
  { descripcion: 'BUJIA NGK BPMR7A',       cantidad: 2, codigo: 'BPMR7A', monto_sin_iva: 8099 },
  { descripcion: 'FILTRO AIRE STIHL 291',  cantidad: 1, codigo: null,     monto_sin_iva: 10248 },
  { descripcion: 'ACEITE 2T STIHL HP 1L',  cantidad: 3, codigo: null,     monto_sin_iva: 22562 },
  { descripcion: 'CADENA 3/8 .050 56E',    cantidad: 1, codigo: null,     monto_sin_iva: 14876 },
];
const { matches, orden_sin_factura } = O.emparejarItems(FACT, ORDEN.items);
eq('la bujía matchea por código',            matches[0].ix_orden === 0 && matches[0].metodo === 'codigo', JSON.stringify(matches[0]));
eq('el filtro matchea por descripción',      matches[1].ix_orden === 1 && /descripcion/.test(matches[1].metodo), JSON.stringify(matches[1]));
eq('el aceite matchea por descripción',      matches[2].ix_orden === 2 && /descripcion/.test(matches[2].metodo), JSON.stringify(matches[2]));
eq('la cadena NO matchea con nada',          matches[3].ix_orden === null, JSON.stringify(matches[3]));
eq('ningún ítem de la orden quedó sin factura', orden_sin_factura.length === 0, JSON.stringify(orden_sin_factura));
eq('cada ítem de la orden se usa una sola vez',
  new Set(matches.filter(m => m.ix_orden != null).map(m => m.ix_orden)).size === 3);

console.log('\n— Emparejamiento: casos que tienen que fallar bien —');
let r = O.emparejarItems([{ descripcion: 'GUANTES DESCARNE', cantidad: 10 }], [{ descripcion: 'Casco de seguridad', cantidad: 5 }]);
eq('cosas distintas no se emparejan',        r.matches[0].ix_orden === null);
r = O.emparejarItems(
  [{ descripcion: 'FILTRO AIRE', cantidad: 1 }, { descripcion: 'FILTRO ACEITE', cantidad: 1 }],
  [{ descripcion: 'Filtro de aceite', cantidad: 1 }, { descripcion: 'Filtro de aire', cantidad: 1 }]);
eq('dos filtros distintos van cada uno con el suyo',
  r.matches[0].ix_orden === 1 && r.matches[1].ix_orden === 0, JSON.stringify(r.matches));
r = O.emparejarItems(
  [{ descripcion: 'BUJIA NGK', cantidad: 2, codigo: 'BPMR7A' }],
  [{ descripcion: 'Bujía', cantidad: 2, codigo: 'bpmr-7a' }]);
eq('el código matchea aunque venga con guión y minúsculas', r.matches[0].metodo === 'codigo');
r = O.emparejarItems([{ descripcion: 'X', cantidad: 1 }], []);
eq('orden sin ítems no rompe',               r.matches[0].ix_orden === null);
r = O.emparejarItems([], ORDEN.items);
eq('factura sin ítems deja toda la orden sin factura', r.orden_sin_factura.length === 3);

console.log('\n— Imputación que hereda la factura —');
const imp = O.imputacionDesdeOrden(ORDEN, matches, FACT);
eq('modo per-item',                          imp.assignmentMode === 'per-item');
eq('la bujía hereda objetivo y unidad',
  imp.assignments[0].objetivo === 'MUNICIPALIDAD DE CORDOBA' && /KCG906/.test(imp.assignments[0].unidad));
eq('la bujía hereda el comentario de la reparación', /Reparación #312/.test(imp.assignments[0].comentario));
eq('los 3 emparejados vienen marcados desde_orden',
  [0, 1, 2].every(i => imp.assignments[i].desde_orden === true));
eq('la cadena queda sin asignar',            imp.sin_asignar.length === 1 && imp.sin_asignar[0] === 3);
eq('la cadena trae el objetivo de la orden como SUGERENCIA, no como dato',
  imp.assignments[3].objetivo === 'MUNICIPALIDAD DE CORDOBA' && imp.assignments[3].sugerido === true && imp.assignments[3].desde_orden === false);
eq('la cadena NO hereda comentario (lo escribe quien carga)', imp.assignments[3].comentario === '');

console.log('\n— Diferencia contra cotizado —');
let d = O.diferenciaVsCotizado(ORDEN, 67500);
eq('$48.500 cotizado → $67.500 facturado = +$19.000', d.diferencia === 19000, JSON.stringify(d));
eq('el porcentaje es +39,2%',                d.pct === 39.2, String(d.pct));
d = O.diferenciaVsCotizado({ total_estimado: 0 }, 10000);
eq('sin cotización no inventa porcentaje',   d.pct === null && d.sin_cotizacion === true);
d = O.diferenciaVsCotizado({ total_estimado: 50000 }, 48000);
eq('más barato da diferencia negativa',      d.diferencia === -2000 && d.pct === -4);

console.log('\n— Fraccionamiento —');
const hoy = '2026-09-02';
const ab = [
  { numero: 'OC-2026-0040', fecha: '2026-08-30', proveedor: 'RAGAGLIA FERRETERIA', total_estimado: 450000, items: [{ objetivo: 'CHACRAS DE LA VILLA' }] },
];
let fr = O.detectarFraccionamiento({ fecha: hoy, proveedor: 'Ragaglia Ferreteria', total_estimado: 450000, items: [{ objetivo: 'CHACRAS DE LA VILLA' }] }, ab);
eq('dos de $450k en 3 días al mismo proveedor y objetivo → AVISA', fr.aviso === true && fr.suma === 900000, JSON.stringify(fr));
eq('la suma cruza a comparativos',           fr.tramo_suma === 'comparativos' && fr.tramo_sola === 'directa');
fr = O.detectarFraccionamiento({ fecha: hoy, proveedor: 'Ragaglia Ferreteria', total_estimado: 450000, items: [{ objetivo: 'UCC' }] }, ab);
eq('otro objetivo no suma',                  fr.aviso === false);
fr = O.detectarFraccionamiento({ fecha: hoy, proveedor: 'Acerco', total_estimado: 450000, items: [{ objetivo: 'CHACRAS DE LA VILLA' }] }, ab);
eq('otro proveedor no suma',                 fr.aviso === false);
fr = O.detectarFraccionamiento({ fecha: '2026-09-15', proveedor: 'Ragaglia Ferreteria', total_estimado: 450000, items: [{ objetivo: 'CHACRAS DE LA VILLA' }] }, ab);
eq('fuera de la ventana de 7 días no suma',  fr.aviso === false);
fr = O.detectarFraccionamiento({ fecha: hoy, proveedor: 'Ragaglia Ferreteria', total_estimado: 20000, items: [{ objetivo: 'CHACRAS DE LA VILLA' }] }, ab);
eq('si la suma sigue en directa no avisa',   fr.aviso === false && fr.suma === 470000);
fr = O.detectarFraccionamiento({ fecha: hoy, cuit: '30-70790443-3', total_estimado: 450000, items: [{ objetivo: 'CHACRAS DE LA VILLA' }] },
  [{ numero: 'OC-2026-0040', fecha: '2026-08-30', cuit: '30707904433', total_estimado: 450000, items: [{ objetivo: 'CHACRAS DE LA VILLA' }] }]);
eq('matchea por CUIT aunque el nombre difiera', fr.aviso === true);
fr = O.detectarFraccionamiento({ fecha: hoy, proveedor: 'X', total_estimado: 100, items: [] }, []);
eq('sin órdenes abiertas no rompe',          fr.aviso === false);

console.log('\n— Orden que nace de un repuesto aprobado —');
const PED = { id: 'ped-1', items: [{ descripcion: 'Bujía NGK BPMR7A', cantidad: 2, codigo: 'BPMR7A' }, { descripcion: 'Filtro de aire', cantidad: 1 }],
  nota_proveedor: 'Ragaglia Ferreteria', nota_precio: 48500, nota_plazo: '3 días', marca_modelo: 'Stihl 291' };
const INC = { id: 'a1b2c3d4-...', numero_unidad: 'KCG906', tipo_equipo: 'camioneta', tipo_falla: 'no arranca', objetivos: { nombre: 'Municipalidad de Córdoba' } };
const UNIS = ['U22 — Toyota Hilux 3.0 4x2 Mod.2011 — KCG906 — Luis Ponferrada', 'U14 — Fiat Strada — AC770AY'];
const od = O.ordenDesdeRepuesto(PED, INC, CC, UNIS);
eq('hereda proveedor y precio de la nota',   od.proveedor === 'Ragaglia Ferreteria' && od.total_estimado === 48500);
eq('el objetivo se tradujo a centro de costo', od.items[0].objetivo === 'MUNICIPALIDAD DE CORDOBA' && od.objetivo_pendiente === false);
eq('la unidad se resolvió al texto de Compras', /KCG906/.test(od.items[0].unidad) && /U22/.test(od.items[0].unidad));
eq('el comentario dice de qué reparación viene', /Reparación #a1b2c3/.test(od.items[0].comentario) && /no arranca/.test(od.items[0].comentario));
eq('conserva el código del repuesto',        od.items[0].codigo === 'BPMR7A');
eq('la nota de pedido queda como cotización elegida', od.cotizaciones.length === 1 && od.cotizaciones[0].elegida === true);
eq('$48.500 cae en directa',                 od.tramo === 'directa');
eq('nace abierta',                           od.estado === 'abierta');

const od2 = O.ordenDesdeRepuesto(PED, { ...INC, objetivos: { nombre: 'parque sarmiento' } }, CC, UNIS);
eq('objetivo que no existe en Compras → queda PENDIENTE, no inventa',
  od2.objetivo_pendiente === true && od2.objetivo_original === 'parque sarmiento');
const od3 = O.ordenDesdeRepuesto({ ...PED, nota_precio: null }, INC, CC, UNIS);
eq('sin precio en la nota → sin_cotizacion', od3.sin_cotizacion === true && od3.cotizaciones.length === 0);

console.log('\n— Orden que nace de un pedido de insumos —');
const oi = O.ordenDesdeInsumo({ id: 'ins-88', objetivos: { nombre: 'Chacras' }, capataz_nombre: 'Diego' },
  [{ item: 'guantes', cantidad: '10 pares' }, { item: 'escobas', cantidad: '3' }], CC);
eq('nace como borrador (falta proveedor y precio)', oi.estado === 'borrador' && oi.proveedor === null);
eq('la imputación ya está resuelta',         oi.items.every(i => i.objetivo === 'CHACRAS DE LA VILLA'));
eq('la cantidad se lee del texto libre',     oi.items[0].cantidad === 10 && oi.items[1].cantidad === 3);
eq('es directa y sin cotización',            oi.tramo === 'directa' && oi.sin_cotizacion === true);

console.log('\n— Total de ítems —');
eq('suma precio × cantidad',                 O.totalDeItems([{ precio: 32000, cantidad: 1 }, { precio: 30200, cantidad: 1 }, { precio: 1500, cantidad: 4 }]) === 68200);
eq('ítems sin precio suman 0',               O.totalDeItems([{ cantidad: 3 }]) === 0);

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);
