// Harness de ordenes_bot.js — foto + "oc ..." → orden de compra.
//
// Simula lo que no se puede correr acá (descarga de Twilio, OCR, IA, base) y
// prueba lo que sí: que el reparto de la IA se sanee, que la orden salga con
// los ítems y objetivos correctos, que un ítem sin objetivo la deje en
// borrador, y que alguien que no es de compras no pueda crear órdenes.

process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'x';
process.env.SUPABASE_COMPRAS_URL = 'https://y.supabase.co';
process.env.SUPABASE_COMPRAS_KEY = 'x';
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32);

// ── Supabase simulado ─────────────────────────────────────────
const USUARIOS = [
  { id: 'u1', usuario: 'owen', nombre: 'Owen', modulos: ['compras'], admin: false, activo: true, telefono: '5493511111111' },
  { id: 'u2', usuario: 'jose', nombre: 'José', modulos: [], admin: true, activo: true, telefono: '5493512222222' },
  { id: 'u3', usuario: 'leo',  nombre: 'Leo',  modulos: ['stock'], admin: false, activo: true, telefono: '5493513333333' },
];
const CENTROS = [{ nombre: 'CHACRAS DE LA VILLA' }, { nombre: 'UCC' }, { nombre: 'DEPOSITO' }, { nombre: 'JOCKEY' }];
function clienteFalso() {
  return { from: tabla => {
    const q = { select() { return q; }, eq() { return q; }, order() { return q; },
      then(res) {
        const data = tabla === 'usuarios_panel' ? USUARIOS : tabla === 'centros_costo' ? CENTROS : [];
        return Promise.resolve({ data, error: null }).then(res);
      } };
    return q;
  } };
}
require.cache[require.resolve('./supabase.js')] = { id: 'sb', filename: 'sb', loaded: true, exports: clienteFalso() };
require.cache[require.resolve('./supabase_compras.js')] = { id: 'sbc', filename: 'sbc', loaded: true, exports: clienteFalso() };

const BOT = require('./ordenes_bot');
const ORD = require('./ordenes');

let ok = 0, mal = 0;
function eq(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

// Lo que "leyó" el OCR del remito de Papa.
const LEIDO = { proveedor: 'MIGUEL ANGEL PAPA SRL', cuit: '30-66231129-4', fecha_factura: '2026-09-02', numero_factura: 'R-0019-00037178',
  total_sin_iva: 77851, total_iva: 16349,
  items: [
    { descripcion: 'GUANTES DESCARNE REFORZADO', cantidad: 20, monto_sin_iva: 52893 },
    { descripcion: 'CASCO SEGURIDAD C/BARBIJO',  cantidad: 5,  monto_sin_iva: 24958 },
  ] };

// Lo que "respondió" la IA para "guantes 10 chacras 10 ucc, cascos deposito".
const IA_OK = { filas: [
  { ix: 0, objetivo: 'CHACRAS DE LA VILLA', cantidad: 10 },
  { ix: 0, objetivo: 'UCC', cantidad: 10 },
  { ix: 1, objetivo: 'DEPOSITO', cantidad: 5 },
], no_entendi: [] };

let creada = null;
const deps = (ia) => ({
  descargar: async () => Buffer.from('foto'),
  extraerFactura: async () => LEIDO,
  repartirConIA: async (items, linea, centros) => BOT.sanearReparto(ia, items, centros),
  crearOrden: async (datos, usuario) => { creada = { datos, usuario }; return { orden: { ...datos, id: 'oc-1', numero: 'OC-2026-0042' }, fraccionamiento: { aviso: false } }; },
});

console.log('— Reconocer el pedido —');
eq('"oc guantes..." es pedido de orden',     BOT.esPedidoDeOrden('oc guantes 10 chacras'));
eq('"OC:" con mayúscula y dos puntos también', BOT.esPedidoDeOrden('OC: todo para deposito'));
eq('"orden ..." también',                     BOT.esPedidoDeOrden('orden cascos jockey'));
eq('"ocupado" NO es pedido de orden',         !BOT.esPedidoDeOrden('ocupado, después te mando'));
eq('foto sin texto NO es pedido de orden',    !BOT.esPedidoDeOrden(''));

(async () => {

console.log('\n— Quién puede —');
eq('Owen (módulo compras) puede',     (await BOT.usuarioComprasPorTelefono('whatsapp:+5493511111111') || {}).usuario === 'owen');
eq('José (admin) puede',              (await BOT.usuarioComprasPorTelefono('whatsapp:+5493512222222') || {}).usuario === 'jose');
eq('Leo (stock, no compras) NO puede', await BOT.usuarioComprasPorTelefono('whatsapp:+5493513333333') === null);
eq('un número desconocido NO puede',  await BOT.usuarioComprasPorTelefono('whatsapp:+5493519999999') === null);

console.log('\n— El caso del mockup: remito de Papa repartido en tres objetivos —');
creada = null;
let out = await BOT.procesarOrdenFoto('whatsapp:+5493511111111', 'http://x', 'image/jpeg', 'oc guantes 10 chacras 10 ucc, cascos deposito', deps(IA_OK));
eq('se creó la orden',                    creada !== null);
eq('la creó Owen',                        creada && creada.usuario === 'owen');
eq('proveedor y CUIT del OCR',            creada && creada.datos.proveedor === 'MIGUEL ANGEL PAPA SRL' && creada.datos.cuit === '30-66231129-4');
eq('los guantes se partieron en dos ítems (Chacras y UCC)',
  creada && creada.datos.items.filter(i => /GUANTES/.test(i.descripcion)).length === 2);
eq('10 guantes a CHACRAS DE LA VILLA',    creada && creada.datos.items.some(i => /GUANTES/.test(i.descripcion) && i.objetivo === 'CHACRAS DE LA VILLA' && i.cantidad === 10));
eq('10 guantes a UCC',                    creada && creada.datos.items.some(i => /GUANTES/.test(i.descripcion) && i.objetivo === 'UCC' && i.cantidad === 10));
eq('5 cascos a DEPOSITO',                 creada && creada.datos.items.some(i => /CASCO/.test(i.descripcion) && i.objetivo === 'DEPOSITO' && i.cantidad === 5));
eq('el precio unitario sale del OCR',     creada && Math.abs(creada.datos.items[0].precio - 52893 / 20) < 0.01, creada && String(creada.datos.items[0].precio));
eq('el total es el del comprobante con IVA', creada && creada.datos.total_estimado === 94200, creada && String(creada.datos.total_estimado));
eq('$94.200 es directa',                  creada && creada.datos.tramo === 'directa');
eq('nace abierta (todo tiene objetivo)',  creada && creada.datos.estado === 'abierta');
eq('viene marcada como creada por WhatsApp', creada && creada.datos.creado_via === 'whatsapp');
eq('guarda el N° del remito',             creada && creada.datos.remito_numero === 'R-0019-00037178');
eq('la respuesta nombra la orden',        /OC-2026-0042/.test(out));
eq('la respuesta lista los tres destinos', /CHACRAS DE LA VILLA/.test(out) && /UCC/.test(out) && /DEPOSITO/.test(out));

console.log('\n— La IA no ubicó un ítem —');
creada = null;
out = await BOT.procesarOrdenFoto('whatsapp:+5493511111111', 'http://x', 'image/jpeg', 'oc guantes chacras',
  deps({ filas: [{ ix: 0, objetivo: 'CHACRAS DE LA VILLA', cantidad: 20 }], no_entendi: [] }));
eq('el ítem no nombrado queda sin objetivo', creada && creada.datos.items.some(i => /CASCO/.test(i.descripcion) && i.objetivo === ''));
eq('la orden nace en BORRADOR',           creada && creada.datos.estado === 'borrador');
eq('queda objetivo_pendiente',            creada && creada.datos.objetivo_pendiente === true);
eq('la respuesta avisa que falta',        /sin objetivo/.test(out) && /borrador/.test(out));

console.log('\n— Saneamiento de lo que devuelve la IA —');
let s = BOT.sanearReparto({ filas: [{ ix: 0, objetivo: 'CHACRAS', cantidad: 10 }] }, LEIDO.items, CENTROS.map(c => c.nombre));
eq('un objetivo inventado por la IA ("CHACRAS" solo) → null', s.filas[0].objetivo === null);
s = BOT.sanearReparto({ filas: [{ ix: 0, objetivo: 'chacras de la villa', cantidad: 10 }] }, LEIDO.items, CENTROS.map(c => c.nombre));
eq('minúsculas se normalizan al nombre real', s.filas[0].objetivo === 'CHACRAS DE LA VILLA');
s = BOT.sanearReparto({ filas: [{ ix: 7, objetivo: 'UCC', cantidad: 1 }] }, LEIDO.items, CENTROS.map(c => c.nombre));
eq('un índice fuera de rango se descarta', !s.filas.some(f => f.ix === 7));
eq('y los ítems reales igual aparecen (sin objetivo)', s.filas.length === 2 && s.filas.every(f => f.objetivo === null));
s = BOT.sanearReparto({ filas: [{ ix: 0, objetivo: 'UCC', cantidad: 999 }] }, LEIDO.items, CENTROS.map(c => c.nombre));
eq('una cantidad mayor a la del ítem se recorta', s.filas[0].cantidad === 20);
s = BOT.sanearReparto(null, LEIDO.items, CENTROS.map(c => c.nombre));
eq('respuesta vacía de la IA no rompe',   s.filas.length === 2);

console.log('\n— Sin línea de texto —');
creada = null;
out = await BOT.procesarOrdenFoto('whatsapp:+5493511111111', 'http://x', 'image/jpeg', 'oc', deps(IA_OK));
eq('sin línea, todos los ítems quedan sin objetivo', creada && creada.datos.items.every(i => i.objetivo === ''));
eq('y la orden queda en borrador',        creada && creada.datos.estado === 'borrador');

console.log('\n— Quien no es de compras —');
creada = null;
out = await BOT.procesarOrdenFoto('whatsapp:+5493513333333', 'http://x', 'image/jpeg', 'oc guantes chacras', deps(IA_OK));
eq('devuelve null para que siga el flujo de combustible', out === null);
eq('no creó nada',                        creada === null);

console.log('\n— OCR sin ítems —');
creada = null;
out = await BOT.procesarOrdenFoto('whatsapp:+5493511111111', 'http://x', 'image/jpeg', 'oc x', { ...deps(IA_OK), extraerFactura: async () => ({ items: [] }) });
eq('foto ilegible: avisa y no crea',      /No pude leer/.test(out) && creada === null);

console.log('\n— Tramo alto por foto —');
creada = null;
out = await BOT.procesarOrdenFoto('whatsapp:+5493511111111', 'http://x', 'image/jpeg', 'oc todo jockey',
  { ...deps({ filas: [{ ix: 0, objetivo: 'JOCKEY', cantidad: 20 }, { ix: 1, objetivo: 'JOCKEY', cantidad: 5 }] }),
    extraerFactura: async () => ({ ...LEIDO, total_sin_iva: 700000, total_iva: 147000 }) });
eq('$847.000 cae en comparativos',        creada && creada.datos.tramo === 'comparativos');
eq('queda en borrador aunque todo tenga objetivo', creada && creada.datos.estado === 'borrador');
eq('la respuesta avisa que pide comparativos', /comparativos/.test(out));

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);

})().catch(e => { console.error('✗ el harness explotó:', e); process.exit(1); });
