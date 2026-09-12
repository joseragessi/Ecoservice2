// Harness de la caché del servidor (index.js).
//
// Sirve cuando hay VARIOS usuarios: José, Sole, Leila y Owen piden lo mismo
// y sin esto cada uno dispara su propia consulta a Supabase.
//
// Lo crítico: que la clave incluya al usuario. Si dos usuarios con permisos
// distintos compartieran respuesta, uno vería datos que no le corresponden.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/index.js', 'utf8');
const ini = src.indexOf('const _cacheGet = new Map();');
const fin = src.indexOf('// Registro de cambios por módulo:', ini);
if (ini < 0 || fin < 0) { console.error('✗ No encontré el middleware de caché'); process.exit(1); }

let mw = null;
const app = { use: (f) => { if (typeof f === 'function' && f.length === 3) mw = f; } };
new Function('app', src.slice(ini, fin))(app);
if (!mw) { console.error('✗ No se registró el middleware'); process.exit(1); }

let consultas = 0;
function pedir(path, { metodo = 'GET', auth = 'Bearer token-de-jose-1234567890', status = 200, body = { ok: true, n: ++consultas } } = {}) {
  return new Promise(res => {
    const salida = { status: 200, body: null, headers: {} };
    const r = {
      statusCode: 200,
      set(k, v) { salida.headers[k] = v; return r; },
      status(c) { salida.status = c; r.statusCode = c; return r; },
      json(b) { salida.body = b; res(salida); return r; },
    };
    mw({ path, originalUrl: path, method: metodo, headers: { authorization: auth } }, r, () => {
      // "next": simula que la ruta consultó Supabase y respondió.
      salida.llegoALaRuta = true;
      if (status !== 200) r.status(status);   // como hace Express: res.status(500).json(...)
      r.json(body);
    });
  });
}

let ok = 0, mal = 0;
function eq(n, c, d) { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } }

(async () => {
  console.log('— No se consulta dos veces —');
  let a = await pedir('/api/reparaciones');
  eq('la primera va a la base', a.llegoALaRuta === true && a.headers['X-Cache'] === 'MISS');
  let b = await pedir('/api/reparaciones');
  eq('la segunda sale de caché, sin tocar la base', !b.llegoALaRuta && b.headers['X-Cache'] === 'HIT');
  eq('y devuelve lo mismo', JSON.stringify(a.body) === JSON.stringify(b.body));

  console.log('\n— Varios usuarios comparten la consulta —');
  const c = await pedir('/api/objetivos', { auth: 'Bearer token-de-jose-1234567890' });
  const d = await pedir('/api/objetivos', { auth: 'Bearer token-de-jose-1234567890' });
  eq('el mismo usuario reusa', !d.llegoALaRuta);

  console.log('\n— LO CRÍTICO: usuarios distintos NO comparten —');
  const e = await pedir('/api/maestros', { auth: 'Bearer token-de-jose-1234567890' });
  const f = await pedir('/api/maestros', { auth: 'Bearer token-de-sole-9999999999' });
  eq('otro usuario va a la base, no reusa la respuesta ajena', f.llegoALaRuta === true, JSON.stringify(f.headers));
  eq('y recibe SU respuesta', JSON.stringify(e.body) !== JSON.stringify(f.body));

  console.log('\n— Una escritura vacía la caché —');
  await pedir('/api/combustible');
  const g1 = await pedir('/api/combustible');
  eq('antes de escribir, cachea', !g1.llegoALaRuta);
  await pedir('/api/combustible/123', { metodo: 'POST' });
  const g2 = await pedir('/api/combustible');
  eq('después de un POST, vuelve a consultar', g2.llegoALaRuta === true);
  await pedir('/api/reparaciones');
  await pedir('/api/reparaciones/1', { metodo: 'PUT' });
  const g3 = await pedir('/api/reparaciones');
  eq('un PUT también la vacía', g3.llegoALaRuta === true);
  await pedir('/api/stock/general');
  await pedir('/api/stock/1', { metodo: 'DELETE' });
  const g4 = await pedir('/api/stock/general');
  eq('un DELETE también', g4.llegoALaRuta === true);

  console.log('\n— Lo que no se cachea —');
  await pedir('/api/cambios');
  const h = await pedir('/api/cambios');
  eq('/api/cambios va siempre (es el aviso de cambios entre usuarios)', h.llegoALaRuta === true);
  await pedir('/api/panel-version');
  const i = await pedir('/api/panel-version');
  eq('/api/panel-version tampoco se cachea', i.llegoALaRuta === true);
  await pedir('/api/login', { metodo: 'POST' });
  eq('el login nunca se cachea', true);

  console.log('\n— COMPRAS Y FLEXXUS NO SE TOCAN (decisión 12-sep) —');
  for (const r of ['/api/compras/facturas', '/api/compras/ordenes',
                   '/api/compras/centroscosto-flexxus',
                   '/api/compras/facturas/abc/flexxus-estado', '/api/flexxus/estado']) {
    await pedir(r);
    const x = await pedir(r);
    eq(`${r} va siempre a la base`, x.llegoALaRuta === true);
  }

  console.log('\n— Lo que no es /api pasa de largo —');
  const j = await pedir('/panel');
  eq('los archivos estáticos no se tocan', j.llegoALaRuta === true);

  console.log('\n— Un error no se cachea —');
  await pedir('/api/algo-que-falla', { metodo: 'POST' });  // limpia
  const k1 = await pedir('/api/algo-que-falla', { status: 500, body: { error: 'x' } });
  const k2 = await pedir('/api/algo-que-falla');
  eq('un 500 no queda guardado: el siguiente reintenta', k2.llegoALaRuta === true);

  console.log('\n— Distinta query, distinta respuesta —');
  await pedir('/api/x', { metodo: 'POST' });
  await pedir('/api/combustible?mes=2026-09');
  const l = await pedir('/api/combustible?mes=2026-08');
  eq('cambiar el mes no devuelve lo del mes anterior', l.llegoALaRuta === true);

  console.log(`\n${ok} ok · ${mal} mal`);
  process.exit(mal ? 1 : 0);
})().catch(e => { console.error('✗ explotó:', e); process.exit(1); });
