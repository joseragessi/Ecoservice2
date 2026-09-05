// Desvíos semanales de stock — la lógica pura.
//
// Cada respuesta del capataz se guarda como una FOTO (tabla stock_fotos, una
// por objetivo y semana, sin pisar la anterior). El desvío de una semana es
// la comparación entre su foto y la foto anterior del mismo objetivo, cruzada
// con lo que está en el taller con ingreso dado. No se guarda: se calcula
// cada vez, así una corrección del censo corrige el desvío sola.
//
// Los cuatro resultados por máquina:
//   faltante  estaba, no está, y el taller no la tiene
//   taller    no está en el objetivo, pero tiene ingreso dado en el taller
//   nuevo     no estaba y ahora está
//   (nada)    estaba y sigue
// Sin número de máquina solo se compara cantidad por tipo.

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function normNum(v) { return String(v == null ? '' : v).trim().toUpperCase().replace(/[\s.\-_/]/g, ''); }
function numVago(v) { const n = normNum(v); return !n || n === 'SN' || n === 'SIN' || n === '0' || /^[-–—]+$/.test(n); }

// Lunes (00:00) de la semana a la que pertenece una fecha. Semana ISO: lunes
// a domingo. Devuelve 'YYYY-MM-DD'.
function lunesDe(fecha) {
  const d = fecha instanceof Date ? new Date(fecha) : new Date(fecha);
  if (isNaN(d)) return null;
  // Córdoba: la fecha que importa es la local, no la UTC.
  const loc = new Date(d.toLocaleString('en-US', { timeZone: 'America/Argentina/Cordoba' }));
  const dow = loc.getDay();                  // 0 domingo … 6 sábado
  const diff = dow === 0 ? -6 : 1 - dow;
  loc.setDate(loc.getDate() + diff);
  const y = loc.getFullYear(), m = String(loc.getMonth() + 1).padStart(2, '0'), dd = String(loc.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function sumarDias(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

// Aplana una foto a un mapa de máquinas: { tipoNorm: { tipo, cant, nums:Set } }
function aplanar(items) {
  const m = {};
  (items || []).forEach(i => {
    const k = norm(i.tipo || i.tipo_equipo);
    if (!k) return;
    const e = m[k] || (m[k] = { tipo: i.tipo || i.tipo_equipo, cant: 0, nums: new Set(), vagos: 0, escritos: 0 });
    e.cant += Number(i.cantidad) || 0;
    // `escritos` cuenta los números no vagos CON repetidos: el 218 dos veces
    // en Cosquin son dos máquinas escritas, aunque en el Set sea una.
    (i.numeros || []).forEach(n => { if (numVago(n)) e.vagos++; else { e.nums.add(normNum(n)); e.escritos++; } });
  });
  return m;
}

// El taller: incidencias con ingreso dado, del objetivo. Se indexan por
// número (exacto) y por tipo (para los sin número).
function indexarTaller(incidencias) {
  const porNum = {}, porTipo = {};
  (incidencias || []).forEach(inc => {
    const n = normNum(inc.numero_unidad);
    if (n && !numVago(inc.numero_unidad)) { if (!porNum[n]) porNum[n] = inc; }
    else { const t = norm(inc.tipo_equipo); if (t) (porTipo[t] = porTipo[t] || []).push(inc); }
  });
  return { porNum, porTipo };
}
function tipoCompatible(a, b) { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); }

// Cuántas semanas hacia atrás se mira para saber qué máquinas "debería"
// tener un objetivo. Con una sola (la anterior) un faltante desaparecía del
// desvío a la segunda semana, porque ya no estaba en ninguna de las dos.
const VENTANA_SEMANAS = 8;

/**
 * Compara la foto actual de un objetivo contra las anteriores.
 * @param anteriores  foto | [fotos] más reciente primero (se usan hasta VENTANA_SEMANAS)
 * @param actual      {items:[...]} | null
 * @param taller      incidencias abiertas CON ingreso, del objetivo
 * @returns { faltantes, taller, nuevos, cantidad, resumen }
 *
 * Universo "esperado" = toda máquina numerada que apareció en alguna de las
 * anteriores. Para lo sin número se compara cantidad contra la inmediata.
 */
function compararFotos(anteriores, actual, taller) {
  const lista = Array.isArray(anteriores) ? anteriores.filter(Boolean).slice(0, VENTANA_SEMANAS) : (anteriores ? [anteriores] : []);
  const inmediata = lista[0] || null;
  // A0 = la inmediata (para comparar cantidades sin número).
  // A  = unión de las anteriores (para saber qué números "debería" tener).
  const A0 = aplanar(inmediata && inmediata.items);
  const A = aplanar(inmediata && inmediata.items);
  lista.slice(1).forEach(f => {
    const m = aplanar(f.items);
    Object.keys(m).forEach(k => {
      const e = A[k] || (A[k] = { tipo: m[k].tipo, cant: 0, nums: new Set(), vagos: 0, escritos: 0 });
      m[k].nums.forEach(n => e.nums.add(n));
    });
  });
  const B = aplanar(actual && actual.items);
  const T = indexarTaller(taller);
  const faltantes = [], enTaller = [], nuevos = [], cantidad = [];
  const tallerUsado = new Set();

  // Por número: en A y no en B.
  Object.keys(A).forEach(k => {
    const a = A[k], b = B[k];
    a.nums.forEach(n => {
      if (b && b.nums.has(n)) return;
      // ¿está en otro tipo de B? (el capataz lo escribió con otro nombre)
      const enOtro = Object.values(B).some(x => x !== b && x.nums.has(n));
      if (enOtro) return;
      const inc = T.porNum[n];
      if (inc) { tallerUsado.add(inc.id); enTaller.push({ tipo: a.tipo, numero: n, incidencia: inc, motivo: 'con ingreso en el taller' }); }
      else faltantes.push({ tipo: a.tipo, numero: n, detalle: null });
    });
  });
  // Por número: en B y no en A → nuevo.
  Object.keys(B).forEach(k => {
    const b = B[k], a = A[k];
    b.nums.forEach(n => {
      if (a && a.nums.has(n)) return;
      const enOtro = Object.values(A).some(x => x !== a && x.nums.has(n));
      if (!enOtro) nuevos.push({ tipo: b.tipo, numero: n });
    });
  });
  // Por cantidad, para lo que no tiene número: sin-número de la INMEDIATA
  // vs sin-número de la actual. "Sin número" = cantidad − números escritos
  // (con repetidos), así un número duplicado no inventa una máquina sin número.
  const tipos = new Set([...Object.keys(A0), ...Object.keys(B)]);
  tipos.forEach(k => {
    const a = A0[k] || { tipo: (B[k] || {}).tipo, cant: 0, nums: new Set(), vagos: 0, escritos: 0 };
    const b = B[k] || { tipo: a.tipo, cant: 0, nums: new Set(), vagos: 0, escritos: 0 };
    const sinNumA = Math.max(0, a.cant - a.escritos), sinNumB = Math.max(0, b.cant - b.escritos);
    if (sinNumA === sinNumB) return;
    if (sinNumA > sinNumB) {
      let dif = sinNumA - sinNumB;
      // ¿hay en el taller, sin número, de ese tipo?
      const cands = Object.keys(T.porTipo).filter(t => tipoCompatible(t, a.tipo)).flatMap(t => T.porTipo[t]).filter(i => !tallerUsado.has(i.id));
      const absorbidas = Math.min(dif, cands.length);
      cands.slice(0, absorbidas).forEach(inc => { tallerUsado.add(inc.id); enTaller.push({ tipo: a.tipo, numero: null, incidencia: inc, motivo: 'con ingreso en el taller (sin número)' }); });
      dif -= absorbidas;
      if (dif > 0) { faltantes.push({ tipo: a.tipo, numero: null, detalle: `había ${sinNumA} sin número, ahora ${sinNumB}`, cantidad: dif }); cantidad.push({ tipo: a.tipo, antes: a.cant, ahora: b.cant }); }
    } else {
      nuevos.push({ tipo: b.tipo, numero: null, detalle: `había ${sinNumA} sin número, ahora ${sinNumB}`, cantidad: sinNumB - sinNumA });
      cantidad.push({ tipo: b.tipo, antes: a.cant, ahora: b.cant });
    }
  });

  const totA = Object.values(A).reduce((s, x) => s + x.cant, 0), totB = Object.values(B).reduce((s, x) => s + x.cant, 0);
  return { faltantes, taller: enTaller, nuevos, cantidad,
    resumen: { antes: totA, ahora: totB, faltantes: faltantes.reduce((s, f) => s + (f.cantidad || 1), 0), taller: enTaller.length, nuevos: nuevos.reduce((s, f) => s + (f.cantidad || 1), 0) } };
}

// ¿Cuántas semanas seguidas viene faltando esta máquina? Mira las fotos
// hacia atrás desde la actual: cuenta mientras la máquina no aparezca. La
// primera foto donde sí está corta la cuenta. Cuenta la actual.
function semanasFaltando(fotosDesc, tipo, numero) {
  const n = normNum(numero);
  if (!n) return 1;
  let semanas = 0;
  for (const f of fotosDesc) {
    const tiene = (f.items || []).some(i => (i.numeros || []).some(x => normNum(x) === n));
    if (tiene) break;
    semanas++;
  }
  return Math.max(1, semanas);
}

// Historial de una máquina por número, a través de todas las fotos de todos
// los objetivos: dónde y cuándo apareció. Para la trazabilidad.
function historialMaquina(fotos, numero) {
  const n = normNum(numero);
  if (!n) return [];
  return (fotos || []).filter(f => (f.items || []).some(i => (i.numeros || []).some(x => normNum(x) === n)))
    .map(f => {
      const it = (f.items || []).find(i => (i.numeros || []).some(x => normNum(x) === n));
      return { semana: f.semana, objetivo: f.objetivo, objetivo_id: f.objetivo_id, tipo: it ? (it.tipo || it.tipo_equipo) : null, respondido_at: f.respondido_at, capataz: f.capataz_nombre };
    })
    .sort((a, b) => String(b.semana).localeCompare(String(a.semana)));
}

// Clave estable de un desvío, para poder cerrarlo con motivo y que el cierre
// se reconozca la semana siguiente aunque el desvío se recalcule.
function claveDesvio(objetivoId, tipo, numero) {
  return [objetivoId || '', norm(tipo), numVago(numero) ? '' : normNum(numero)].join('|');
}

// ¿Este número aparece esa misma semana en la foto de OTRO objetivo? Entonces
// no falta: se movió. Devuelve el nombre del objetivo destino o null.
function movidaA(numero, semana, fotosTodas, objetivoIdOrigen) {
  const n = normNum(numero);
  if (!n) return null;
  const f = (fotosTodas || []).find(x => x.semana === semana && x.objetivo_id !== objetivoIdOrigen
    && (x.items || []).some(i => (i.numeros || []).some(y => normNum(y) === n)));
  return f ? (f.objetivo || f.objetivo_id) : null;
}

module.exports = { norm, normNum, numVago, lunesDe, sumarDias, aplanar, compararFotos, semanasFaltando, historialMaquina, claveDesvio, movidaA, VENTANA_SEMANAS };
