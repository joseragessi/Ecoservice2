// Harness de la caché del panel (panel.js).
//
// Medido el 03-sep: cada llamada tarda 330-920 ms aunque devuelva 0.1 kB, y
// un recorrido de 4 módulos disparaba 18 llamadas con /api/reparaciones
// repetida 4 veces. La caché ataca eso.
//
// Lo crítico que se verifica: que una escritura borre la caché entera. Si eso
// falla, José guarda algo y sigue viendo el dato viejo — que es mucho peor
// que la lentitud.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/panel.js', 'utf8');
const ini = src.indexOf('let CACHE_OFF=false;');
const fin = src.indexOf('async function _fetchApi(ruta, opts={}) {');
if (ini < 0 || fin < 0) { console.error('✗ No encontré el bloque de caché'); process.exit(1); }

let llamadas = [];              // lo que efectivamente salió al servidor
let demora = 0;                 // para probar la deduplicación
function montar() {
  llamadas = [];
  const ctx = `
    let token='x';
    const salir=()=>{}; const mostrarBloqueo=()=>{};
    async function _fetchApi(ruta, opts={}){
      __llamadas.push(ruta);
      if(__demora) await new Promise(r=>setTimeout(r,__demora));
      return {ruta, n:__llamadas.length};
    }
  `;
  return new Function('__llamadas', '__demora', ctx + src.slice(ini, fin) +
    '\nreturn {api, apiC, invalidarCacheApi, cacheStats, setOff:v=>{CACHE_OFF=v}, TTL:CACHE_TTL_MS, TTL_LARGO:CACHE_TTL_LARGO};')(llamadas, demora);
}

let ok = 0, mal = 0;
function eq(n, c, d) { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } }

(async () => {
  console.log('— No se pregunta dos veces lo mismo —');
  let A = montar();
  await A.api('/api/reparaciones');
  await A.api('/api/reparaciones');
  await A.api('/api/reparaciones');
  eq('3 pedidos = 1 sola llamada al servidor', llamadas.length === 1, `fueron ${llamadas.length}`);
  await A.api('/api/facturas');
  eq('una ruta distinta sí va al servidor', llamadas.length === 2);

  console.log('\n— El recorrido real del 03-sep —');
  A = montar();
  // Compras → Reparaciones → Stock → Compras, con lo que pide cada módulo.
  for (const r of ['/api/reparaciones', '/api/maestros',
                   '/api/stock/general', '/api/maquinas',
                   '/api/combustible', '/api/objetivos',
                   '/api/reparaciones', '/api/stock/general',
                   '/api/maestros', '/api/reparaciones']) await A.api(r);
  eq('10 pedidos → 6 llamadas (las repetidas salen de caché)', llamadas.length === 6, `fueron ${llamadas.length}: ${llamadas.join(' ')}`);
  const st = A.cacheStats();
  eq('las estadísticas lo reflejan', st.hits === 4 && st.miss === 6, JSON.stringify(st));

  console.log('\n— LO CRÍTICO: una escritura borra la caché —');
  A = montar();
  await A.api('/api/reparaciones');
  await A.api('/api/reparaciones/abc', { method: 'POST', body: '{}' });
  await A.api('/api/reparaciones');
  eq('después de guardar, se vuelve a pedir', llamadas.length === 3, `fueron ${llamadas.length}`);
  A = montar();
  await A.api('/api/objetivos');
  await A.api('/api/maestros/objetivos', { method: 'PUT', body: '{}' });
  await A.api('/api/objetivos');
  eq('vale para cualquier ruta, no solo la que se escribió', llamadas.length === 3);
  A = montar();
  await A.api('/api/stock/general');
  await A.api('/api/stock/1', { method: 'DELETE' });
  await A.api('/api/stock/general');
  eq('DELETE también invalida', llamadas.length === 3);

  console.log('\n— Deduplicación: dos pedidos a la vez —');
  demora = 30; A = montar();
  await Promise.all([A.api('/api/reparaciones'), A.api('/api/reparaciones'), A.api('/api/reparaciones')]);
  eq('3 pedidos simultáneos = 1 sola llamada', llamadas.length === 1, `fueron ${llamadas.length}`);
  eq('y los tres reciben la respuesta', true);
  demora = 0;

  console.log('\n— Lo que NO se cachea —');
  A = montar();
  await A.api('/api/cambios'); await A.api('/api/cambios');
  eq('/api/cambios va siempre al servidor (es el aviso de cambios)', llamadas.length === 2);
  A = montar();
  await A.api('/api/panel-version'); await A.api('/api/panel-version');
  eq('/api/panel-version tampoco se cachea', llamadas.length === 2);
  A = montar();
  await A.api('/api/combustible/exportar'); await A.api('/api/combustible/exportar');
  eq('las exportaciones tampoco', llamadas.length === 2);

  console.log('\n— COMPRAS Y FLEXXUS NO SE TOCAN (decisión 12-sep) —');
  // El módulo funciona en producción con la integración contable. No se
  // cachea NADA de ahí: ni la lista de facturas, ni las órdenes, ni los
  // centros de costo. Se prefiere que siga lento y seguro.
  for (const r of ['/api/compras/facturas', '/api/compras/ordenes',
                   '/api/compras/listas', '/api/compras/centroscosto-flexxus',
                   '/api/compras/facturas/abc/flexxus-estado', '/api/flexxus/estado']) {
    A = montar();
    await A.api(r); await A.api(r);
    eq(`${r} va siempre al servidor`, llamadas.length === 2, `fueron ${llamadas.length}`);
  }
  A = montar();
  // flxVigilar() pregunta cada 2,5 s durante hasta 3 minutos mientras imputa.
  for (let i = 0; i < 5; i++) await A.api('/api/compras/facturas/abc/flexxus-estado');
  eq('las 5 consultas de "¿ya terminó?" salen las 5 veces', llamadas.length === 5, `fueron ${llamadas.length}`);

  console.log('\n— Los POST nunca se cachean —');
  A = montar();
  await A.api('/api/stock/pedir', { method: 'POST', body: '{}' });
  await A.api('/api/stock/pedir', { method: 'POST', body: '{}' });
  eq('dos POST iguales salen las dos veces', llamadas.length === 2);

  console.log('\n— TTL según el dato —');
  A = montar();
  eq('los maestros duran más que los operativos', A.TTL_LARGO > A.TTL);
  eq('el TTL operativo es de menos de un minuto', A.TTL <= 60000, String(A.TTL));

  console.log('\n— Se puede apagar desde la consola —');
  A = montar(); A.setOff(true);
  await A.api('/api/reparaciones'); await A.api('/api/reparaciones');
  eq('con CACHE_OFF=true vuelve a preguntar siempre', llamadas.length === 2);

  console.log('\n— apiC sigue funcionando (compatibilidad) —');
  A = montar();
  await A.apiC('/api/objetivos'); await A.apiC('/api/objetivos');
  eq('apiC cachea igual que api', llamadas.length === 1);

  console.log('\n— Un error no queda cacheado —');
  A = montar();
  const B = new Function('__llamadas', `
    let token='x'; const salir=()=>{}; const mostrarBloqueo=()=>{};
    let __n=0;
    async function _fetchApi(ruta){ __llamadas.push(ruta); __n++; if(__n===1) throw new Error('falló'); return {ok:true}; }
    ` + src.slice(ini, fin) + '\nreturn {api};')(llamadas);
  llamadas.length = 0;
  let fallo = false;
  try { await B.api('/api/reparaciones'); } catch (e) { fallo = true; }
  eq('el primer intento falla', fallo);
  const r2 = await B.api('/api/reparaciones');
  eq('el segundo vuelve a intentar (no quedó cacheado el error)', r2 && r2.ok === true, JSON.stringify(r2));

  console.log(`\n${ok} ok · ${mal} mal`);
  process.exit(mal ? 1 : 0);
})().catch(e => { console.error('✗ explotó:', e); process.exit(1); });
