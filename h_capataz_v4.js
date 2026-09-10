// Harness de los endpoints V4 del capataz (app_api.js).
//
// Monta el router REAL con Supabase simulado. Cubre lo que decidió José el
// 09-sep: sin censo del mes el capataz NO puede cargar combustible, pero
// puede cargar el stock desde la misma app y ahí se desbloquea.
//
// Si el bloqueo falla, entra combustible que no se puede imputar a nada.
// Si bloquea de más, el capataz queda varado en la estación de servicio.

process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'x';
process.env.SUPABASE_COMPRAS_URL = 'https://y.supabase.co'; process.env.SUPABASE_COMPRAS_KEY = 'x';
process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32); process.env.TWILIO_AUTH_TOKEN = '0'.repeat(32);

const OBJ = 'obj-canuelas';
// Censo de COUNTRY CAÑUELAS, con máquinas y herramientas mezcladas.
const ITEMS_CENSO = [
  { tipo_equipo: 'Motoguadaña', cantidad: 4, numeros: ['11', '12', 'K', 'HE1'] },
  { tipo_equipo: 'Tractor', cantidad: 1, numeros: ['5002A'] },
  { tipo_equipo: 'Mini tractor', cantidad: 1, numeros: ['MT03'] },
  { tipo_equipo: 'Pala de punta', cantidad: 2, numeros: [] },
  { tipo_equipo: 'Machete', cantidad: 1, numeros: [] },
];
let CENSOS = [];      // se arma en cada caso
let INVENTARIO = [];
const UNIDADES = [{ id: 'u1', codigo: 'U22', patente: 'KCG906', marca_modelo: 'Toyota Hilux 3.0', objetivo_id: OBJ, activo: true }];
let insertados = [], updates = [], borrados = [];

function cliente() {
  return { from: t => { const q = { _t: t,
    select() { return q; }, eq() { return q; }, neq() { return q; }, not() { return q; }, order() { return q; }, limit() { return q; }, in() { return q; }, ilike() { return q; },
    async single() { return { data: t === 'censos_stock' ? (CENSOS[0] || null) : null, error: null }; },
    async maybeSingle() { return { data: t === 'censos_stock' ? (CENSOS.find(c => c.periodo === periodoHoy()) || null) : null, error: null }; },
    insert(f) { insertados.push({ tabla: t, filas: Array.isArray(f) ? f : [f] });
      return { select: () => ({ single: async () => ({ data: { id: 'nuevo-' + t }, error: null }) }), then(r) { return Promise.resolve({ error: null }).then(r); } }; },
    update(p) { updates.push({ tabla: t, patch: p }); return { eq: async () => ({ error: null }), in: async () => ({ error: null }) }; },
    delete() { return { eq: async (c, v) => { borrados.push({ tabla: t, valor: v }); return { error: null }; } }; },
    then(res, rej) { const data = t === 'censos_stock' ? CENSOS : t === 'stock_objetivo' ? INVENTARIO : t === 'unidades' ? UNIDADES : [];
      return Promise.resolve({ data, error: null }).then(res, rej); } }; return q; } };
}
function periodoHoy() {
  const h = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Cordoba' }));
  return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}`;
}
require.cache[require.resolve('./supabase.js')] = { id: 'sb', filename: 'sb', loaded: true, exports: cliente() };
require.cache[require.resolve('./supabase_compras.js')] = { id: 'sbc', filename: 'sbc', loaded: true, exports: cliente() };
require.cache[require.resolve('./notificar.js')] = { id: 'n', filename: 'n', loaded: true, exports: {
  notificarCapataz: async () => false, notificarCapatazTemplate: async () => false, notificarConFallback: async () => ({ ok: false }),
  mensajeEstadoIncidencia: () => '', mensajeCierreSinReparar: () => '' } };
require.cache[require.resolve('./stock.js')] = { id: 'st', filename: 'st', loaded: true, exports: {
  guardarFotoSemanal: async (...a) => { insertados.push({ tabla: 'stock_fotos', filas: [a[2]] }); },
  iniciarStock: async () => '', continuarStock: async () => '', tieneSesionActiva: () => false,
  periodoActual: periodoHoy, tienePedidoPendiente: async () => false, _esListadoCompleto: () => false } };

const router = require('./app_api.js').router;
function h(path, method) { const c = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  if (!c) { console.error('✗ no encontré ' + method.toUpperCase() + ' ' + path); process.exit(1); } return c.route.stack[c.route.stack.length - 1].handle; }
const getDestinos = h('/api/app/capataz/combustible/destinos', 'get');
const getStock = h('/api/app/capataz/stock', 'get');
const postStock = h('/api/app/capataz/stock', 'post');
const postComb = h('/api/app/capataz/combustible', 'post');

const USER = { app_user: { cid: 'c1', nombre: 'Eduardo Islas', objetivo_id: OBJ, objetivo_nombre: 'COUNTRY CAÑUELAS', unidad_id: null, patente: null } };
async function call(handler, extra) {
  insertados = []; updates = []; borrados = [];
  let out = { code: 200, json: null };
  const res = { status(c) { out.code = c; return res; }, json(j) { out.json = j; return res; } };
  await handler({ query: {}, params: {}, body: {}, ...USER, ...(extra || {}) }, res);
  return out;
}
const conCenso = () => { CENSOS = [{ id: 'cen1', periodo: periodoHoy(), estado: 'respondido', respondido_at: new Date().toISOString(), censos_stock_items: ITEMS_CENSO }]; };
const sinCenso = () => { CENSOS = []; };
const censoViejo = () => { CENSOS = [{ id: 'cen0', periodo: '2026-08', estado: 'respondido', respondido_at: '2026-08-05', censos_stock_items: ITEMS_CENSO }]; };

let ok = 0, mal = 0;
function eq(n, c, d) { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } }

(async () => {
  console.log('— Destinos con censo del mes —');
  conCenso(); INVENTARIO = [];
  let r = await call(getDestinos);
  eq('responde 200 y dice que hay censo', r.code === 200 && r.json.censo.hay === true, JSON.stringify(r.json && r.json.censo));
  const labels = (r.json.destinos || []).map(x => x.label);
  eq('el tractor sale individual con su número', labels.includes('Tractor 5002A'), JSON.stringify(labels));
  eq('el mini tractor sale aparte del tractor', (r.json.destinos || []).some(x => x.familia === 'mini_tractor'), JSON.stringify(labels));
  eq('las motoguadañas salen como grupo de 4', labels.includes('Motoguadaña (4)'));
  eq('las palas y machetes NO salen', !labels.some(l => /pala|machete/i.test(l)), JSON.stringify(labels));
  eq('la camioneta de la flota sale', labels.some(l => /KCG906/.test(l)));
  eq('vienen agrupados por familia', (r.json.grupos || []).length >= 3);

  console.log('\n— Filtro por producto —');
  r = await call(getDestinos, { query: { producto: 'GASOIL' } });
  eq('con gasoil aparece el tractor', (r.json.destinos || []).some(x => /Tractor 5002A/.test(x.label)));
  eq('con gasoil NO aparecen las motoguadañas', !(r.json.destinos || []).some(x => /Motoguadaña/.test(x.label)));
  r = await call(getDestinos, { query: { producto: 'PUMA SUPER' } });
  eq('con súper aparecen las motoguadañas', (r.json.destinos || []).some(x => /Motoguadaña/.test(x.label)));
  eq('con súper NO aparece la camioneta', !(r.json.destinos || []).some(x => /KCG906/.test(x.label)));

  console.log('\n— Sin censo del mes —');
  sinCenso();
  r = await call(getDestinos);
  eq('avisa que no hay censo', r.json.censo.hay === false);
  eq('y no ofrece máquinas del censo', !(r.json.destinos || []).some(x => x.ref_tipo === 'censo'), JSON.stringify((r.json.destinos || []).map(x => x.label)));

  console.log('\n— EL BLOQUEO —');
  sinCenso();
  r = await call(postComb, { body: { repartos: [{ tipo: 'gasoil', litros: 50, destino_tipo: 'maquina_individual' }] } });
  eq('sin censo, guardar combustible se frena con 409', r.code === 409, `dio ${r.code}`);
  eq('y dice que falta el censo', r.json && r.json.sin_censo === true, JSON.stringify(r.json));
  eq('no se guardó ninguna carga', !insertados.some(i => i.tabla === 'cargas_combustible'));

  conCenso();
  r = await call(postComb, { body: { repartos: [{ tipo: 'gasoil', litros: 50, destino_tipo: 'maquina_individual', destino_codigo: '1:5002A', destino_nombre: 'Tractor 5002A', familia: 'tractor' }] } });
  eq('con censo, guarda', r.code === 200 && r.json.ok, JSON.stringify(r.json));
  const its = (insertados.find(i => i.tabla === 'cargas_combustible_items') || {}).filas || [];
  eq('el ítem guarda el destino declarado', its[0] && its[0].destino_nombre === 'Tractor 5002A' && its[0].destino_tipo === 'maquina_individual', JSON.stringify(its[0]));
  eq('guarda la familia', its[0] && its[0].familia_consumo === 'tractor');
  eq('marca de dónde salió la asignación', its[0] && its[0].asignacion_origen === 'capataz_app' && its[0].asignacion_estado === 'completa');
  eq('mantiene las columnas viejas para compatibilidad', its[0] && its[0].destino === 'bidon' && its[0].objetivo_id === OBJ, JSON.stringify(its[0]));

  console.log('\n— El destino de una camioneta va como "unidad" —');
  conCenso();
  r = await call(postComb, { body: { repartos: [{ tipo: 'gasoil', litros: 40, destino_tipo: 'unidad', unidad_id: 'u1', destino_nombre: 'U22 — Toyota Hilux — KCG906', familia: 'vehiculo' }] } });
  const its2 = (insertados.find(i => i.tabla === 'cargas_combustible_items') || {}).filas || [];
  eq('destino=unidad y unidad_id puesto', its2[0] && its2[0].destino === 'unidad' && its2[0].unidad_id === 'u1', JSON.stringify(its2[0]));
  eq('sin objetivo_id (va al tanque, no al objetivo)', its2[0] && its2[0].objetivo_id === null);

  console.log('\n— Se puede apagar el bloqueo sin desplegar —');
  sinCenso(); process.env.BLOQUEO_STOCK_COMBUSTIBLE = 'off';
  r = await call(postComb, { body: { repartos: [{ tipo: 'gasoil', litros: 10, destino_tipo: 'grupo_maquinas' }] } });
  eq('con BLOQUEO_STOCK_COMBUSTIBLE=off deja pasar', r.code === 200, `dio ${r.code}`);
  delete process.env.BLOQUEO_STOCK_COMBUSTIBLE;
  r = await call(postComb, { body: { repartos: [{ tipo: 'gasoil', litros: 10 }] } });
  eq('sin la variable, vuelve a bloquear', r.code === 409);

  console.log('\n— Pantalla "Mis máquinas" —');
  censoViejo();
  r = await call(getStock);
  eq('sin censo del mes, precarga el último', r.code === 200 && r.json.confirmado === false && r.json.base_periodo === '2026-08', JSON.stringify(r.json && { c: r.json.confirmado, b: r.json.base_periodo }));
  eq('trae los ítems para confirmar', (r.json.items || []).length === ITEMS_CENSO.length);
  eq('cada ítem viene clasificado', (r.json.items || []).every(i => i.clasificacion && typeof i.clasificacion.es_maquinaria === 'boolean'));
  eq('la pala viene marcada como NO maquinaria', (r.json.items || []).find(i => /Pala/.test(i.tipo_equipo)).clasificacion.es_maquinaria === false);
  conCenso();
  r = await call(getStock);
  eq('con censo del mes, dice confirmado', r.json.confirmado === true && r.json.es_del_periodo === true);

  console.log('\n— Guardar el stock desde la app —');
  sinCenso();
  r = await call(postStock, { body: { items: [
    { tipo_equipo: 'Motoguadaña', cantidad: 4, numeros: ['11', '12', 'K', 'HE1'] },
    { tipo_equipo: 'Tractor', cantidad: 1, numeros: ['5002A'] },
    { tipo_equipo: 'Pala', cantidad: 0, numeros: [] },
  ] } });
  eq('guarda', r.code === 200 && r.json.ok, JSON.stringify(r.json));
  eq('descarta los de cantidad 0', r.json.tipos === 2 && r.json.equipos === 5, JSON.stringify(r.json));
  eq('crea el censo del período', insertados.some(i => i.tabla === 'censos_stock' && i.filas[0].estado === 'respondido' && i.filas[0].periodo === periodoHoy()));
  eq('marca que vino de la app', insertados.some(i => i.tabla === 'censos_stock' && i.filas[0].origen === 'app_capataz'));
  eq('inserta los ítems', insertados.some(i => i.tabla === 'censos_stock_items' && i.filas.length === 2));
  eq('guarda la foto semanal (para los desvíos)', insertados.some(i => i.tabla === 'stock_fotos'));

  conCenso();
  r = await call(postStock, { body: { items: [{ tipo_equipo: 'Motoguadaña', cantidad: 5, numeros: [] }] } });
  eq('si ya había censo del mes, lo pisa en vez de duplicar', updates.some(u => u.tabla === 'censos_stock' && u.patch.estado === 'respondido') && borrados.some(b => b.tabla === 'censos_stock_items'), JSON.stringify(updates));

  r = await call(postStock, { body: { items: [] } });
  eq('sin ítems, 400', r.code === 400);

  console.log('\n— Un capataz sin objetivo asignado —');
  r = await call(getDestinos, { app_user: { ...USER.app_user, objetivo_id: null } });
  eq('no explota, avisa', r.code === 200 && r.json.ok === false && r.json.motivo === 'sin_objetivo');

  console.log(`\n${ok} ok · ${mal} mal`);
  process.exit(mal ? 1 : 0);
})().catch(e => { console.error('✗ explotó:', e); process.exit(1); });
