// Harness del endpoint PUT /api/combustible/:id.
//
// Monta el router REAL de panel_api.js con un Supabase simulado y le manda
// pedidos como los que manda el modal. No reimplementa el endpoint: lo carga
// del archivo que se sube a producción y le mira lo que le pasa a la base.
//
// Qué cubre: las validaciones (litros fuera de rango, destino inválido, km
// invertido, carga sin productos), el recálculo de litros_total y del destino
// resumen, y la imputación de los ítems (que es lo que después lee el informe
// de combustible por objetivo).

process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'x';
process.env.SUPABASE_COMPRAS_URL = 'https://y.supabase.co';
process.env.SUPABASE_COMPRAS_KEY = 'x';
process.env.PANEL_SECRET = 'test';
// panel_api arrastra notificar.js, que instancia el cliente de Twilio al
// requerirse y explota sin credenciales. No se manda ningún mensaje: el
// endpoint que se prueba acá no notifica a nadie.
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32);
process.env.TWILIO_AUTH_TOKEN  = '0'.repeat(32);

const path = require('path');

// ── Supabase simulado ─────────────────────────────────────────
// Guarda lo que le mandan para poder revisarlo después.
let registro;
function nuevoRegistro() {
  registro = { update: null, borrados: [], insertados: null, cargaExiste: true };
}
function clienteFalso() {
  const consulta = tabla => {
    const q = {
      _filtros: {},
      select() { return q; },
      eq(col, val) { q._filtros[col] = val; return q; },
      order() { return q; },
      async single() {
        if (tabla === 'cargas_combustible') {
          return registro.cargaExiste
            ? { data: { id: q._filtros.id, estado: 'sin_facturar' }, error: null }
            : { data: null, error: { message: 'no rows' } };
        }
        return { data: null, error: null };
      },
      update(patch) { registro.update = patch; return { eq: async () => ({ error: null }) }; },
      delete() { return { eq: async (c, v) => { registro.borrados.push(v); return { error: null }; } }; },
      async insert(filas) { registro.insertados = filas; return { error: null }; },
      then(res) { return Promise.resolve({ data: [], error: null }).then(res); },
    };
    return q;
  };
  return { from: consulta };
}

const falso = clienteFalso();
require.cache[require.resolve('./supabase.js')] = { id: 'sb', filename: 'sb', loaded: true, exports: falso };
require.cache[require.resolve('./supabase_compras.js')] = { id: 'sbc', filename: 'sbc', loaded: true, exports: falso };

const router = require('./panel_api.js');

// Saca el handler real del router (el último de la cadena, después de auth).
const capa = router.stack.find(l => l.route && l.route.path === '/api/combustible/:id'
  && l.route.methods && l.route.methods.put);
if (!capa) {
  console.error('✗ No encontré PUT /api/combustible/:id en el router — revisá el harness');
  process.exit(1);
}
const handler = capa.route.stack[capa.route.stack.length - 1].handle;

async function llamar(body, params) {
  nuevoRegistro();
  const req = { body, params: params || { id: 'c1' }, usuario: 'jose' };
  let salida = { code: 200, json: null };
  const res = {
    status(c) { salida.code = c; return res; },
    json(j) { salida.json = j; return res; },
  };
  await handler(req, res);
  return salida;
}

let ok = 0, mal = 0;
function afirmar(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { mal++; console.log(`✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

(async () => {

// ── El caso real: corregir la carga del 01/09 ─────────────────
// El ticket decía KCG906 y quedó imputada a otra unidad.
let r = await llamar({
  fecha: '2026-09-01', estado: 'sin_facturar',
  proveedor_id: 'p1', unidad_id: 'u-kcg906', objetivo_id: 'o-muni', capataz_id: 'cap1',
  numero_remito: '2951', lote: '20261369', tarjeta: '3084 6202 1402 7102',
  km_anterior: '0', km_actual: '219.625', saldo_tarjeta: '203.860,07',
  total: '96.139,93', iva: '', neto: '', otros_tributos: '',
  items: [{ producto: 'ION DIESEL', litros: '39,002', precio_unit: '2.465,0000',
            subtotal: '96.139,93', destino: 'unidad' }],
});
afirmar('la carga real se guarda', r.code === 200, JSON.stringify(r.json));
afirmar('litros_total recalculado', Math.abs(registro.update.litros_total - 39.002) < 1e-9,
  `dio ${registro.update.litros_total}`);
afirmar('la tarjeta se guarda sin espacios', registro.update.tarjeta === '3084620214027102',
  `dio ${registro.update.tarjeta}`);
afirmar('km actual parseado', registro.update.km_actual === 219625, `dio ${registro.update.km_actual}`);
afirmar('km anterior en 0 se guarda como 0', registro.update.km_anterior === 0,
  `dio ${JSON.stringify(registro.update.km_anterior)}`);
afirmar('saldo parseado', registro.update.saldo_tarjeta === 203860.07, `dio ${registro.update.saldo_tarjeta}`);
afirmar('total parseado', registro.update.total === 96139.93, `dio ${registro.update.total}`);
afirmar('IVA vacío queda null, no 0', registro.update.iva === null, `dio ${JSON.stringify(registro.update.iva)}`);
afirmar('destino resumen = unidad', registro.update.destino === 'unidad', `dio ${registro.update.destino}`);
afirmar('queda la auditoría de quién editó', registro.update.editado_por === 'jose' && !!registro.update.editado_at);
afirmar('el ítem hereda la unidad de la cabecera',
  registro.insertados[0].unidad_id === 'u-kcg906', `dio ${registro.insertados[0].unidad_id}`);
afirmar('se borran los ítems viejos antes de insertar', registro.borrados.length === 1);

// ── Destino resumen ───────────────────────────────────────────
await llamar({ items: [
  { producto: 'SUPER', litros: '15', destino: 'bidon', objetivo_id: 'o-tablada' },
  { producto: 'SUPER', litros: '10', destino: 'bidon', objetivo_id: 'o-jordin' },
]});
afirmar('todo a bidones → destino bidon', registro.update.destino === 'bidon', `dio ${registro.update.destino}`);
afirmar('cada bidón mantiene SU objetivo, no el de la carga',
  registro.insertados[0].objetivo_id === 'o-tablada' && registro.insertados[1].objetivo_id === 'o-jordin');

await llamar({ objetivo_id: 'o-carga', items: [
  { producto: 'GASOIL', litros: '30', destino: 'unidad' },
  { producto: 'SUPER',  litros: '20', destino: 'bidon' },
]});
afirmar('mezcla → destino mixto', registro.update.destino === 'mixto', `dio ${registro.update.destino}`);
afirmar('bidón sin objetivo propio cae al de la carga',
  registro.insertados[1].objetivo_id === 'o-carga', `dio ${registro.insertados[1].objetivo_id}`);
afirmar('litros suman entre productos', Math.abs(registro.update.litros_total - 50) < 1e-9,
  `dio ${registro.update.litros_total}`);

// ── Validaciones ──────────────────────────────────────────────
r = await llamar({ items: [] });
afirmar('carga sin productos se rechaza', r.code === 400, `dio ${r.code}`);

r = await llamar({ items: [{ producto: '', litros: '10', destino: 'unidad' }] });
afirmar('producto sin nombre se rechaza', r.code === 400, `dio ${r.code}`);

r = await llamar({ items: [{ producto: 'GASOIL', litros: '9999', destino: 'unidad' }] });
afirmar('litros absurdos se rechazan', r.code === 400, `dio ${r.code}`);

r = await llamar({ items: [{ producto: 'GASOIL', litros: '-5', destino: 'unidad' }] });
afirmar('litros negativos se rechazan', r.code === 400, `dio ${r.code}`);

r = await llamar({ items: [{ producto: 'GASOIL', litros: '10', destino: 'tanque' }] });
afirmar('destino inventado se rechaza', r.code === 400, `dio ${r.code}`);

r = await llamar({ km_anterior: '219.625', km_actual: '5.000',
  items: [{ producto: 'GASOIL', litros: '10', destino: 'unidad' }] });
afirmar('km invertido se rechaza', r.code === 400, `dio ${r.code}`);

r = await llamar({ estado: 'pagada', items: [{ producto: 'GASOIL', litros: '10', destino: 'unidad' }] });
afirmar('estado inventado cae al actual, no se guarda',
  r.code === 200 && registro.update.estado === 'sin_facturar', `dio ${registro.update.estado}`);

registro = { update: null, borrados: [], insertados: null, cargaExiste: false };
const req2 = { body: { items: [{ producto: 'X', litros: '1', destino: 'unidad' }] }, params: { id: 'nope' }, usuario: 'jose' };
let cod = 200;
await handler(req2, { status(c) { cod = c; return this; }, json() { return this; } });
afirmar('carga inexistente da 404', cod === 404, `dio ${cod}`);

// ── Un litro sin leer no bloquea la edición ───────────────────
r = await llamar({ items: [{ producto: 'GASOIL', litros: '', destino: 'unidad' }] });
afirmar('producto con litros vacíos se acepta (el dato falta, no es cero)',
  r.code === 200 && registro.insertados[0].litros === null,
  `código ${r.code}, litros ${JSON.stringify(registro.insertados && registro.insertados[0].litros)}`);

console.log(`\n${ok} ok · ${mal} mal`);
process.exit(mal ? 1 : 0);

})().catch(e => { console.error('✗ el harness explotó:', e); process.exit(1); });
