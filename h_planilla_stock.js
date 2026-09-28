// Harness de la planilla de control físico (panel.js · imprimirPlanillaStock).
//
// 28-sep: la planilla imprimía una fila POR UNIDAD. TGN salía con 8 renglones
// seguidos de "lentes oscuros S/N" y 51 líneas repetidas, sin decir cuántos
// hay de cada cosa. Ahora es una fila por tipo, con la cantidad y un
// casillero por unidad — igual que se ve en el panel.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/panel.js', 'utf8');
const ini = src.indexOf('async function imprimirPlanillaStock');
const fin = src.indexOf('\n}\n', ini) + 3;
if (ini < 0) { console.error('✗ no encontré imprimirPlanillaStock'); process.exit(1); }
const fn = src.slice(ini, fin);

let html = null, HIST = [];
const ctx = {
  stkGen: null,
  window: { _maqPadron: [], open: () => ({ document: { write: h => { html = h; }, close() {} } }) },
  alert: m => { throw new Error(m); },
  api: async () => HIST,
  mesStk: p => p,
};
const f = new Function('stkGen', 'window', 'alert', 'api', 'mesStk', fn + '\nreturn imprimirPlanillaStock;');
async function correr(filas, periodo) {
  html = null;
  await f({ filas }, ctx.window, ctx.alert, ctx.api, ctx.mesStk)(filas[0].objetivo_id, periodo);
  return html;
}
const fila = (tipo, cantidad, numeros, obs) => ({ objetivo_id: 'o1', objetivo: 'TGN', grupo: null,
  periodo: '2026-09', tipo, cantidad, numeros: numeros || [], observacion: obs || null });

let ok = 0, mal = 0;
const eq = (n, c, d) => { if (c) { ok++; console.log('✓ ' + n); } else { mal++; console.log('✗ ' + n + (d ? ' — ' + d : '')); } };
const filasDe = h => (h.match(/<tr>/g) || []).length - (h.match(/<thead>/g) || []).length;

(async () => {
  console.log('— El caso de TGN (28-sep) —');
  // Lo que hoy imprime 8 renglones iguales.
  let h = await correr([fila('lentes oscuros', 8, [])]);
  eq('8 lentes oscuros son UNA fila, no ocho', filasDe(h) === 1, String(filasDe(h)));
  eq('y dice la cantidad', /class="cant">8</.test(h));
  eq('con UN casillero, no ocho', (h.match(/<span class="c">/g) || []).length === 1,
    String((h.match(/<span class="c">/g) || []).length));

  h = await correr([
    fila('guantes', 1, [], 'latex y moteados'),
    fila('mochila fumigadora', 1, ['giber']),
    fila('mamelucos ignifugos', 4, ['L', '2 XXL Y 1XXXL']),
    fila('Sthil 291', 4, []),
    fila('lentes oscuros', 8, []),
    fila('cascos', 3, [], 'con sordinas y cobertor'),
  ]);
  eq('seis tipos → seis filas', filasDe(h) === 6, String(filasDe(h)));
  eq('los números conocidos se ven', /giber/.test(h) && /2 XXL Y 1XXXL/.test(h));
  eq('las que no tienen número salen como s/n', /<i>s\/n<\/i>/.test(h));
  eq('los mamelucos: 2 números + 2 s/n', (h.match(/<i>s\/n<\/i>/g) || []).length >= 2);
  eq('la observación se mantiene', /latex y moteados/.test(h) && /con sordinas y cobertor/.test(h));
  eq('la columna se llama Cant.', /<th class="cant">Cant\.<\/th>/.test(h));
  eq('hay un casillero por fila', (h.match(/<span class="c">/g) || []).length === filasDe(h));
  eq('hay columna para anotar lo que falta', /Falta → ¿dónde\?/.test(h));

  console.log('— Muchas unidades del mismo tipo —');
  h = await correr([fila('conos', 30, [])]);
  eq('30 conos siguen siendo una fila', filasDe(h) === 1);
  eq('sigue con un solo casillero', (h.match(/<span class="c">/g) || []).length === 1);

  console.log('— La hoja se adapta —');
  const muchas = n => Array.from({ length: n }, (_, i) => fila('Equipo ' + i, 1, []));
  h = await correr(muchas(10));
  eq('10 tipos: letra normal', /font-size:12px/.test(h));
  h = await correr(muchas(40));
  eq('40 tipos: letra compacta', /font-size:10.5px/.test(h));
  h = await correr(muchas(70));
  eq('70 tipos: dos columnas', /class="dos"/.test(h));

  console.log('— Planilla de un mes anterior —');
  HIST = [
    { periodo: '2026-09', total: 3, items: [{ tipo_equipo: 'Motoguadaña', cantidad: 3, numeros: ['50', '51', '45'] }] },
    { periodo: '2026-08', total: 5, items: [{ tipo_equipo: 'Motoguadaña', cantidad: 4, numeros: ['50', '51', '45', '12'] },
                                            { tipo_equipo: 'Tractor', cantidad: 1, numeros: ['T1'], observacion: 'Pauny' }] },
  ];
  h = await correr([fila('Motoguadaña', 3, ['50', '51', '45'])], '2026-08');
  eq('usa el censo de ese mes', /class="cant">4</.test(h) && /Tractor/.test(h));
  eq('con su marca', /Pauny/.test(h));
  let fallo = null;
  try { await correr([fila('Motoguadaña', 3, [])], '2026-01'); } catch (e) { fallo = e.message; }
  eq('un mes sin censo avisa', /No hay censo/.test(fallo || ''), fallo);

  console.log('— Bordes —');
  h = await correr([fila('Pala', 0, []), fila('Machete', 1, [])]);
  eq('un tipo en cero no imprime fila', filasDe(h) === 1);
  h = await correr([fila('Motosierra', 1, ['11', '14'])]);
  eq('más números que cantidad: manda la cantidad de números', /class="cant">2</.test(h));

  console.log(`\n${ok} ok · ${mal} mal`);
  process.exit(mal ? 1 : 0);
})().catch(e => { console.error('✗ explotó:', e); process.exit(1); });
