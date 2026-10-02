// Harness informe de combustible para gerencia (30-sep). Con datos reales si
// están (export de cargas + Raw de Edenred); si no, con un caso armado.
const fs = require('fs');
const { armarInforme, resolverObj } = require('./informe_combustible');
let ok = 0, mal = 0;
const t = (n, c) => { if (c) { ok++; console.log('OK ', n); } else { mal++; console.log('MAL', n); } };

// Caso armado: un ticket de 153 lt repartido en 4 bidones (Gustavo, 29-sep)
const alias = { objetivos: [{ nombre: 'PRITTY SA' }, { nombre: 'PARQUE AZUL SRL' }, { nombre: 'DEPOSITO' }, { nombre: 'SUPERVISORES' }], alias: [{ alias: 'u14', nombre: 'UCC' }] };
const carga = { id: 'c1', fecha: '2026-09-29', litros_total: 153, total: 2113000, capataces: { nombre: 'Gustavo Velez' }, objetivos: { nombre: 'SUPERVISORES' }, proveedores: { nombre: 'ECOSERVICE SRL' },
  cargas_combustible_items: [
    { litros: 48, destino: 'bidon', destino_detalle: 'u14', producto: 'SUPER' },
    { litros: 40, destino: 'bidon', destino_detalle: 'Pritty SA', producto: 'SUPER' },
    { litros: 45, destino: 'bidon', destino_detalle: 'parque azul srl', producto: 'SUPER' },
    { litros: 20, destino: 'bidon', destino_detalle: 'Depósito', producto: 'SUPER' }] };
const cc = { id: 'c2', fecha: '2026-09-29', numero_remito: '0033-00000839', litros_total: 50, total: 110000, capataces: { nombre: 'Gallerano' }, objetivos: { nombre: 'FINCAS DEL SUR' }, proveedores: { nombre: 'GWG' },
  cargas_combustible_items: [{ litros: 50, destino: 'unidad', producto: 'PUMA SUPER' }] };
const eden = [{ fecha: '2026-09-29', hora: '08:07', patente: 'AE872LM', chofer: 'Gustavo Velez', litros: 153.005, total: 329878.78, numero_remito: '1' },
  { fecha: '2026-09-29', hora: '09:00', patente: 'AB892GU', chofer: 'Carlos Gonzalez', litros: 60, total: 150000, numero_remito: '2' }];
const inf = armarInforme({ cargas: [carga, cc], edenred: eden, alias, unidades: [], mes: '2026-09' });
t('153 lt van a 4 objetivos declarados', inf.objetivos.length === 5 && inf.objetivos.some(o => o.nombre === 'UCC' && o.litros === 48));
t('importe de Edenred, no el total mal leído del ticket', Math.abs(inf.objetivos.find(o => o.nombre === 'PRITTY SA').importe - 329878.78 * 40 / 153) < 5);
t('remito formal de cuenta corriente no se cruza con Edenred', inf.sin_ticket.cargas === 1 && inf.sin_ticket.por_chofer[0].chofer === 'Carlos Gonzalez');
t('destinos: bidones 153 / tanque 50', inf.destinos.find(d => d.nombre === 'Bidones').litros === 153 && inf.destinos.find(d => d.nombre === 'Tanque de unidad').litros === 50);
t('Edenred por destino: bidones 329.879 + sin ticket 150.000', inf.edenred.importe === 479879 && inf.edenred.sin_ticket === 150000 && inf.edenred.por_destino[0].nombre === 'Bidones' && inf.edenred.por_destino[0].importe === 329879);
t('resolver: patente escrita → objetivo de la carga', resolverObj('Ah122jo', alias, 'SUPERVISORES') === 'SUPERVISORES');

const CAR = '/root/.claude/uploads/07864286-8b72-5194-a950-7d40e9f6eee3/fb31af76-cargas_combustible.json', RAW = '/tmp/claude-0/raw.json';
if (fs.existsSync(CAR) && fs.existsSync(RAW)) {
  const d = JSON.parse(fs.readFileSync(CAR));
  const src = fs.readFileSync(__dirname + '/panel.js', 'utf8');
  const edenredFilas = new Function(src.slice(src.indexOf('function edenredFilas('), src.indexOf('async function combRemExcel(')) + ';return edenredFilas')();
  const ed = edenredFilas(JSON.parse(fs.readFileSync(RAW))).filas;
  const r = armarInforme({ cargas: d.cargas, edenred: ed, alias: d.alias, unidades: d.unidades, mes: '2026-09' });
  console.log('   sep:', r.total, '| sin ticket', r.sin_ticket.cargas, r.sin_ticket.litros, '| desvíos', r.desvios.length, '| objetivos', r.objetivos.length);
  console.log('   top:', r.objetivos.slice(0, 5).map(o => o.nombre + ' ' + o.litros).join(' · '));
  t('real: sep ~8.700 lt declarados', r.total.litros > 8500 && r.total.litros < 8900);
  t('real: bidones es el destino principal', r.destinos[0].nombre === 'Bidones');
  t('real: desvío de Carlos González 231 vs 39', r.desvios.some(x => /Carlos/.test(x.chofer) && x.dif > 190));
  t('real: ninguna carga de SERVI SUD cruzada', !r.desvios.some(x => /^\d{4}-\d{8}$/.test(x.ticket || '')));
  console.log('   edenred sep:', JSON.stringify(r.edenred));
  const cuadra = r.edenred.por_destino.reduce((a, x) => a + x.importe, 0) + r.edenred.sin_ticket + r.edenred.otros;
  t('real: el gasto Edenred por destino suma el total', Math.abs(cuadra - r.edenred.importe) <= 3);
  t('real: sin ticket entre 60 y 90', r.sin_ticket.cargas >= 60 && r.sin_ticket.cargas <= 90);
}
// Consumo vs. máquinas, nafta y gasoil (2-oct)
{
  const { claseMaquina, combustibleDe } = require('./informe_combustible');
  t('clase: mini tractor → nafta, Tractor → gasoil, desmalezadora → nada', claseMaquina('tractor', 'Mini tractor / Giro cero') === 'nmini' && claseMaquina('tractor', 'Tractor') === 'gtrac' && claseMaquina(require('./familias_consumo').familiaConsumo('Desmalezadora'), 'Desmalezadora') === null);
  t('combustible: Evolux / Evo.ux / Ion diesel son gasoil; Super es nafta', ['SHELL EVOLUX DIESEL', 'SHELL EVO.UX DIESEL', 'ION PUMA DIESEL', 'GASOIL', 'UPOWER DIESEL'].every(p => combustibleDe(p) === 'gasoil') && combustibleDe('PUMA SUPER') === 'nafta');
  const al = { objetivos: [{ id: 'o1', nombre: 'Chacras' }, { id: 'o2', nombre: 'Caminos las sierras' }], alias: [] };
  const cg = [{ id: 'k1', fecha: '2026-09-10', litros_total: 100, capataces: { nombre: 'X' }, objetivo_id: 'o2', objetivos: { nombre: 'Caminos las sierras' },
      cargas_combustible_items: [{ litros: 60, destino: 'bidon', objetivo_id: 'o2', producto: 'GASOIL' }, { litros: 40, destino: 'bidon', objetivo_id: 'o2', producto: 'SUPER' }] },
    { id: 'k2', fecha: '2026-09-11', litros_total: 80, capataces: { nombre: 'X' }, objetivo_id: 'o1', objetivos: { nombre: 'Chacras' },
      cargas_combustible_items: [{ litros: 80, destino: 'bidon', objetivo_id: 'o1', producto: 'SHELL EVOLUX DIESEL' }] }];
  const mq = { o1: { nombre: 'Chacras', n2t: 10, gtrac: 2 }, o2: { nombre: 'Caminos las sierras', n2t: 20 } };
  const C = armarInforme({ cargas: cg, alias: al, mes: '2026-09', maquinas: mq, diasHabiles: 22 }).consumo_maquinas;
  const cs = C.objetivos.find(x => x.objetivo_id === 'o2'), ch = C.objetivos.find(x => x.objetivo_id === 'o1');
  t('separa: Caminos 40 nafta / 60 gasoil', cs.litros_nafta === 40 && cs.litros_gasoil === 60);
  t('gasoil sin tractor: Caminos', C.gasoil_sin_tractor.length === 1 && C.gasoil_sin_tractor[0].objetivo_id === 'o2');
  t('Chacras: 40 lt por tractor, % = 80/(2×40×22)', ch.gasoil_por_tractor === 40 && ch.uso_gasoil_pct === Math.round(80 * 100 / (2 * 40 * 22)));
}
const ST = '/root/.claude/uploads/07864286-8b72-5194-a950-7d40e9f6eee3/07b4737f-stock_general.json';
if (fs.existsSync(CAR) && fs.existsSync(RAW) && fs.existsSync(ST)) {
  const { claseMaquina } = require('./informe_combustible');
  const { familiaConsumo } = require('./familias_consumo');
  const d = JSON.parse(fs.readFileSync(CAR)), st = JSON.parse(fs.readFileSync(ST));
  const src = fs.readFileSync(__dirname + '/panel.js', 'utf8');
  const edenredFilas = new Function(src.slice(src.indexOf('function edenredFilas('), src.indexOf('async function combRemExcel(')) + ';return edenredFilas')();
  const mq = {};
  st.filas.forEach(f => { const m = mq[f.objetivo_id] || (mq[f.objetivo_id] = { nombre: f.objetivo, sin_censo: !!f.sin_censo, en_taller: 0 });
    if (f.sin_censo) return; const cl = claseMaquina(familiaConsumo(f.tipo), f.tipo); if (cl) m[cl] = (m[cl] || 0) + (f.disponibles == null ? f.cantidad : f.disponibles); m.en_taller += f.en_taller || 0; });
  const r = armarInforme({ cargas: d.cargas, edenred: edenredFilas(JSON.parse(fs.readFileSync(RAW))).filas, alias: d.alias, unidades: d.unidades, mes: '2026-09', maquinas: mq, diasHabiles: 22 });
  const C = r.consumo_maquinas;
  console.log('   nafta', C.nafta, '· gasoil', C.gasoil, '· gasoil sin tractor', C.litros_gasoil_sin_tractor);
  t('real: nafta + gasoil = bidones + equipos', Math.abs(C.nafta.litros + C.gasoil.litros - r.destinos.filter(x => x.nombre !== 'Tanque de unidad').reduce((a, x) => a + x.litros, 0)) < 1);
  t('real: Caminos las sierras cargó gasoil sin tractor', C.gasoil_sin_tractor.some(x => x.objetivo === 'Caminos las sierras' && x.litros_gasoil > 400));
  fs.writeFileSync('/tmp/claude-0/inf_sep.json', JSON.stringify(r));
}
console.log(`\n${ok} OK · ${mal} MAL`); process.exit(mal ? 1 : 0);
