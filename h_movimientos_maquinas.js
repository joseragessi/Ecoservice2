// Harness · movimientos de máquinas simples (09-oct)
const M = require('./movimientos_maquinas');
let ok = 0, mal = 0;
const eq = (n, c, x) => { if (c) ok++; else { mal++; console.log('MAL', n, x === undefined ? '' : JSON.stringify(x)); } };
const hoy = M.hoyISO();
const dia = d => { const t = new Date(hoy + 'T12:00'); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); };
const N = { A: 'Chacras', B: 'EPEC', C: 'Taller' };
const base = () => [
  { objetivo_id: 'A', objetivo: 'Chacras', tipo: 'Tractor', cantidad: 2, numeros: ['16', '19'], respondido_at: '2026-10-01T10:00:00Z' },
  { objetivo_id: 'A', objetivo: 'Chacras', tipo: 'Motoguadaña', cantidad: 3, numeros: ['E10', '11', 'sn'], respondido_at: '2026-10-01T10:00:00Z' },
  { objetivo_id: 'B', objetivo: 'EPEC', tipo: 'Tractor', cantidad: 1, numeros: ['7'], respondido_at: '2026-10-02T10:00:00Z' },
  { objetivo_id: 'B', objetivo: 'EPEC', tipo: 'Motoguadaña 291', cantidad: 1, numeros: ['16'], respondido_at: '2026-10-02T10:00:00Z' },
];
// mismoNumero
eq('E10 = 10', M.mismoNumero('E10', '10'));
eq('16 ≠ 160', !M.mismoNumero('16', '160'));
// ubicar
let u = M.ubicarNumero('16', base(), [], N);
eq('16 aparece en 2 lugares (tractor y motoguadaña)', u.length === 2, u);
u = M.ubicarNumero('10', base(), [], N);
eq('10 encuentra E10 de Chacras', u.length === 1 && u[0].objetivo_id === 'A' && u[0].tipo === 'Motoguadaña', u);
const prest = { id: 'm1', numero: '16', tipo: 'Tractor', origen_objetivo_id: 'A', destino_objetivo_id: 'B', estado: 'afuera', vuelve: true, vuelve_fecha: dia(5), created_at: '2026-10-08T10:00:00Z' };
u = M.ubicarNumero('16', base(), [prest], N);
const tr = u.find(x => x.tipo === 'Tractor');
eq('tractor 16 prestado figura en EPEC', tr && tr.objetivo_id === 'B' && tr.prestada, u);
eq('motoguadaña 16 sigue en EPEC sin prestar', u.some(x => /Motogua/.test(x.tipo) && !x.prestada));
// aplicar prestadas
let f = base(); f.forEach(x => { x.disponibles = x.cantidad; });
M.aplicarPrestadas(f, [prest], N);
const oA = f.find(x => x.objetivo_id === 'A' && x.tipo === 'Tractor');
const oB = f.find(x => x.objetivo_id === 'B' && x.tipo === 'Tractor');
eq('origen: 1 disponible', oA.disponibles === 1, oA);
eq('origen: 16 marcada prestada', oA.numeros_prestados.length === 1 && oA.numeros_prestados[0].hacia === 'EPEC');
eq('destino: suma 1 disponible', oB.disponibles === 2, oB);
eq('destino: recibido de Chacras', oB.numeros_recibidos[0].desde === 'Chacras');
eq('motoguadaña 16 de EPEC no se toca', !f.find(x => x.objetivo_id === 'B' && /Moto/.test(x.tipo)).numeros_prestados);
const tot = l => l.reduce((s, x) => s + (x.disponibles || 0), 0);
eq('el total del parque no cambia', tot(f) === base().reduce((s, x) => s + x.cantidad, 0));
// vencida
eq('vencida si la fecha pasó', M.vencida({ estado: 'afuera', vuelve_fecha: dia(-2) }));
eq('no vencida hoy', !M.vencida({ estado: 'afuera', vuelve_fecha: hoy }));
eq('armarFila cuenta días vencida', M.armarFila({ estado: 'afuera', vuelve: true, vuelve_fecha: dia(-3) }, N).dias_vencida === 3);
// destino sin ese tipo → fila nueva
f = base(); f.forEach(x => { x.disponibles = x.cantidad; });
f.push({ objetivo_id: 'C', objetivo: 'Taller', sin_censo: true, tipo: null, cantidad: 0, numeros: [] });
M.aplicarPrestadas(f, [Object.assign({}, prest, { destino_objetivo_id: 'C' })], N);
const nC = f.filter(x => x.objetivo_id === 'C');
eq('destino sin censo: una sola fila nueva con el tractor', nC.length === 1 && nC[0].tipo === 'Tractor' && nC[0].disponibles === 1 && !nC[0].sin_censo, nC);
// se quedó después del censo
f = base();
const queda = { id: 'm2', numero: '11', tipo: 'Motoguadaña', origen_objetivo_id: 'A', destino_objetivo_id: 'B', estado: 'se_quedo', created_at: '2026-10-05T10:00:00Z' };
M.aplicarSeQuedo(f, [queda], N);
const mA = f.find(x => x.objetivo_id === 'A' && x.tipo === 'Motoguadaña'), mB = f.find(x => x.objetivo_id === 'B' && /Moto/.test(x.tipo));
eq('se quedó: sale del origen', mA.cantidad === 2 && !mA.numeros.includes('11'), mA);
eq('se quedó: entra al destino (misma familia)', mB.cantidad === 2 && mB.numeros.includes('11'), mB);
// se quedó ANTES del censo → ya reflejado, no se aplica
f = base();
M.aplicarSeQuedo(f, [Object.assign({}, queda, { created_at: '2026-09-20T10:00:00Z' })], N);
eq('se quedó antes del censo: no se toca', f.find(x => x.objetivo_id === 'A' && x.tipo === 'Motoguadaña').cantidad === 3);
// ubicar tras se quedó
u = M.ubicarNumero('11', base(), [queda], N);
eq('ubicar: 11 ahora en EPEC', u.length === 1 && u[0].objetivo_id === 'B' && !u[0].prestada, u);
// número que no está en censo, sólo en un movimiento
u = M.ubicarNumero('99', base(), [Object.assign({}, prest, { numero: '99' })], N);
eq('número sin censo pero movido: figura en destino', u.length === 1 && u[0].objetivo_id === 'B', u);
console.log(`${ok} ok · ${mal} mal`);
