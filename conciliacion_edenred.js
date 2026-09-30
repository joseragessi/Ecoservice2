// ══════════════════════════════════════════════════════════════
// Conciliación Edenred ↔ cargas de los capataces (30-sep-2026)
// El Excel de Edenred (Raw / Reporte de consumo) NO trae el remito ni el lote
// del ticket: esos son números de la estación. Por eso no se cruza por número
// sino por lo que sí coincide en los dos lados:
//   · litros (exactos, con decimales)   · fecha ±1 día (cargas de madrugada)
//   · chofer ≈ capataz                   · tarjeta (la del maestro de unidades)
//   · patente (cuando el OCR la leyó)    · importe
// Probado el 30-sep con 40 cargas de septiembre: 36 con pareja.
// Solo lo usa /api/combustible/analisis para los listados de Edenred.
// Compras no lo toca.
// ══════════════════════════════════════════════════════════════

const DIA = 86400000;
const normP = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const dig = s => String(s || '').replace(/\D/g, '');
const dias = (a, b) => (a && b) ? Math.round((new Date(a + 'T12:00') - new Date(b + 'T12:00')) / DIA) : 99;

const VACIAS = new Set(['DE', 'LA', 'EL', 'DEL', 'LOS', 'LAS', 'Y']);
function tokens(n) {
  return String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(t => t.length >= 3 && !VACIAS.has(t));
}
// Cuántas palabras del nombre coinciden (Chaves ≈ Chavez: mismas 5 primeras letras)
function parecidoNombre(a, b) {
  const A = tokens(a), B = tokens(b);
  let n = 0;
  A.forEach(x => { if (B.some(y => x === y || (x.length >= 5 && y.length >= 5 && x.slice(0, 5) === y.slice(0, 5)))) n++; });
  return n;
}

function patenteDe(c) { return normP((c.unidades && c.unidades.patente) || c.patente_raw); }
function nombreDe(c) { return [c.capataces && c.capataces.nombre, c.chofer_raw].filter(Boolean).join(' '); }

// Qué tan parecida es la carga del panel a la línea de Edenred (sin mirar litros).
function identidad(g, c, tarjetaDePatente) {
  let pts = 0; const por = [];
  const pg = normP(g.patente), pc = patenteDe(c);
  if (pg && pc && pg === pc) { pts += 5; por.push('patente'); }
  const tg = dig(g.tarjeta || tarjetaDePatente[pg]), tc = dig(c.tarjeta);
  if (tg && tc) {
    if (tg === tc) { pts += 5; por.push('tarjeta'); }
    else if (tc.length >= 4 && tg.endsWith(tc.slice(-4))) { pts += 2; por.push('tarjeta (últimos 4)'); }
  }
  const nom = parecidoNombre(g.chofer, nombreDe(c));
  if (nom) { pts += 2 * nom; por.push('chofer'); }
  return { pts, por };
}

/**
 * grupos: líneas de Edenred ({key, fecha, patente, chofer, litros, total, tarjeta…})
 * cargas: cargas_combustible con unidades/capataces
 * Devuelve { pares: [{g, c, dif, via}], sueltas: [g] }
 */
function emparejar(grupos, cargas, tarjetaDePatente = {}, usadas = new Set()) {
  const libres = () => (cargas || []).filter(c => !usadas.has(c.id));
  const pares = [];
  const hechos = new Set();

  // Vuelta 1 · mismos litros (±0,02) y fecha ±1. Se puntúan TODAS las parejas
  // posibles y se asignan de la mejor a la peor, así una carga de 40 lt redonda
  // no se la lleva la primera línea de 40 lt que aparece.
  const cand = [];
  grupos.forEach(g => libres().forEach(c => {
    const lt = Number(c.litros_total) || 0;
    if (!lt || Math.abs(lt - g.litros) > 0.02) return;
    const d = Math.abs(dias(g.fecha, c.fecha));
    if (d > 1) return;
    const id = identidad(g, c, tarjetaDePatente);
    const conDecimales = Math.abs(g.litros - Math.round(g.litros)) > 0.001;
    // Litros redondos (40, 60, 80) se repiten todo el tiempo: sin chofer,
    // tarjeta o patente no alcanza. Con decimales (19,237) ya es una huella.
    if (!id.pts && !conDecimales) return;
    let pts = id.pts + (d === 0 ? 3 : 1) + (conDecimales ? 4 : 0);
    if (g.total && c.total && Math.abs(Number(c.total) - g.total) < 1) { pts += 3; id.por.push('importe'); }
    cand.push({ g, c, pts, via: ['litros', ...id.por].join(' + ') });
  }));
  cand.sort((a, b) => b.pts - a.pts);
  cand.forEach(x => {
    if (hechos.has(x.g.key) || usadas.has(x.c.id)) return;
    hechos.add(x.g.key); usadas.add(x.c.id);
    pares.push({ g: x.g, c: x.c, dif: Math.round((x.g.litros - (Number(x.c.litros_total) || 0)) * 100) / 100, via: x.via });
  });

  // Vuelta 2 · los litros NO coinciden pero es claramente la misma carga
  // (misma tarjeta o patente, o el mismo chofer ese día): eso es un DESVÍO.
  const cand2 = [];
  grupos.filter(g => !hechos.has(g.key)).forEach(g => libres().forEach(c => {
    const d = Math.abs(dias(g.fecha, c.fecha));
    if (d > 1) return;
    const id = identidad(g, c, tarjetaDePatente);
    const fuerte = id.por.includes('tarjeta') || id.por.includes('patente') || id.pts >= 4;
    if (!fuerte || d !== 0) return;
    const lt = Number(c.litros_total) || 0;
    cand2.push({ g, c, pts: id.pts - Math.abs(g.litros - lt) / 10, via: id.por.join(' + ') });
  }));
  cand2.sort((a, b) => b.pts - a.pts);
  cand2.forEach(x => {
    if (hechos.has(x.g.key) || usadas.has(x.c.id)) return;
    hechos.add(x.g.key); usadas.add(x.c.id);
    pares.push({ g: x.g, c: x.c, dif: Math.round((x.g.litros - (Number(x.c.litros_total) || 0)) * 100) / 100, via: x.via });
  });

  return { pares, sueltas: grupos.filter(g => !hechos.has(g.key)) };
}

// Alertas de la línea de Edenred por sí sola (no dependen del panel).
function alertas(g, mismoDia) {
  const a = [];
  const h = Number(String(g.hora || '').slice(0, 2));
  if (g.hora && (h >= 22 || h < 5)) a.push('🌙 carga nocturna');
  if (mismoDia >= 3) a.push(`🔁 ${mismoDia} cargas el mismo día`);
  if (g.tanque && g.litros > Number(g.tanque) * 1.05) a.push('⛽ supera el tanque');
  return a;
}

module.exports = { emparejar, alertas, parecidoNombre, dias };
