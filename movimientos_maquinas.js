// ══════════════════════════════════════════════════════════════
// Movimientos de máquinas — versión simple (09-oct-2026, pedido de José)
// "Colocar el número de máquina, dónde está, dónde va y cuándo vuelve si
// vuelve o no; que figure en Movimientos y que salga de Stock General."
//
// Una fila por movimiento en movimientos_maquinas (base del bot):
//   vuelve = sí → estado 'afuera' hasta que alguien toca "Ya volvió" ('volvio')
//   vuelve = no → estado 'se_quedo' (la máquina pasa a ser del destino)
// La máquina se identifica por el NÚMERO que figura en el censo, no por un
// id: es lo que el supervisor sabe en el campo.
//
// En Stock General (solo la vista actual, igual que el taller):
//   · 'afuera'   → en el origen queda tachada ("prestada") y no cuenta como
//                  disponible; en el destino suma como disponible.
//   · 'se_quedo' → si es POSTERIOR al último censo del objetivo, se saca del
//                  origen y se suma al destino. El censo siguiente ya la trae
//                  donde corresponde, por eso después no se aplica más.
// Compras no lo toca.
// ══════════════════════════════════════════════════════════════
const { familiaConsumo } = require('./familias_consumo');

const normNum = v => String(v == null ? '' : v).trim().toUpperCase().replace(/[\s.\-_/º°]/g, '');
const sinPrefijo = n => { const m = String(n || '').match(/^[A-Z](\d+)$/); return m ? m[1] : null; };
const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// Mismo número: exacto, o salvo una letra adelante ("E10" = "10").
function mismoNumero(a, b) {
  const x = normNum(a), y = normNum(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const sx = sinPrefijo(x), sy = sinPrefijo(y);
  return (sx && sx === y) || (sy && sy === x) || (sx && sy && sx === sy);
}
function mismoTipo(a, b) {
  if (!a || !b) return true;                       // sin tipo: no descarta
  if (norm(a) === norm(b)) return true;
  const fa = familiaConsumo(a), fb = familiaConsumo(b);
  return fa !== 'otro' && fa === fb;
}
const hoyISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Cordoba' });
const vencida = m => m.estado === 'afuera' && m.vuelve_fecha && String(m.vuelve_fecha).slice(0, 10) < hoyISO();

/**
 * ¿Dónde está la máquina N? Arranca del último censo de cada objetivo y le
 * aplica los movimientos (del más viejo al más nuevo).
 * filas: [{objetivo_id, objetivo, tipo, numeros, respondido_at}]
 * movs:  movimientos 'afuera' y 'se_quedo'
 * Devuelve [{objetivo_id, objetivo, tipo, prestada, movimiento_id}]
 */
function ubicarNumero(numero, filas, movs, nombreObj = {}) {
  if (!normNum(numero)) return [];
  const cands = [];
  (filas || []).forEach(f => {
    if (!f.tipo || !(f.numeros || []).some(n => mismoNumero(n, numero))) return;
    if (cands.some(c => c.objetivo_id === f.objetivo_id && norm(c.tipo) === norm(f.tipo))) return;
    cands.push({ objetivo_id: f.objetivo_id, objetivo: f.objetivo, tipo: f.tipo, censo_at: f.respondido_at || null });
  });
  const propios = (movs || []).filter(m => mismoNumero(m.numero, numero) && (m.estado === 'afuera' || m.estado === 'se_quedo'))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  propios.forEach(m => {
    const c = cands.find(x => String(x.objetivo_id) === String(m.origen_objetivo_id) && mismoTipo(x.tipo, m.tipo));
    // Un 'se_quedo' anterior al censo del origen ya está reflejado en el censo.
    if (c && m.estado === 'se_quedo' && c.censo_at && m.created_at < c.censo_at) return;
    const destino = { objetivo_id: m.destino_objetivo_id, objetivo: nombreObj[m.destino_objetivo_id] || '—',
      tipo: m.tipo || (c && c.tipo) || null, prestada: m.estado === 'afuera', movimiento_id: m.id,
      origen: nombreObj[m.origen_objetivo_id] || (c && c.objetivo) || null, vuelve_fecha: m.vuelve_fecha || null };
    if (c) Object.assign(c, destino);
    else if (!cands.some(x => String(x.objetivo_id) === String(m.destino_objetivo_id) && mismoTipo(x.tipo, m.tipo))) cands.push(destino);
  });
  return cands;
}

// Fila del objetivo que tiene ese número (y el tipo, si vino).
function filaConNumero(filas, objetivoId, numero, tipo) {
  const de = filas.filter(f => String(f.objetivo_id) === String(objetivoId) && f.tipo);
  return de.find(f => (f.numeros || []).some(n => mismoNumero(n, numero)) && mismoTipo(f.tipo, tipo))
      || de.find(f => (f.numeros || []).some(n => mismoNumero(n, numero))) || null;
}
// Fila del destino donde sumar: mismo tipo, o misma familia, o una nueva.
function filaDestino(filas, m, nombreObj, base) {
  const de = filas.filter(f => String(f.objetivo_id) === String(m.destino_objetivo_id));
  let f = de.find(x => x.tipo && m.tipo && norm(x.tipo) === norm(m.tipo))
       || de.find(x => x.tipo && m.tipo && mismoTipo(x.tipo, m.tipo) && familiaConsumo(m.tipo) !== 'otro');
  if (f) return f;
  // El objetivo no tiene ese tipo (o no tiene censo): fila nueva.
  const sinCenso = de.find(x => x.sin_censo);
  const nueva = Object.assign({}, base || {}, {
    objetivo_id: m.destino_objetivo_id, objetivo: nombreObj[m.destino_objetivo_id] || (sinCenso && sinCenso.objetivo) || '—',
    grupo: (sinCenso && sinCenso.grupo) || (de[0] && de[0].grupo) || null,
    censo_id: null, periodo: (de[0] && de[0].periodo) || null, respondido_at: null,
    tipo: m.tipo || 'Sin tipo', cantidad: 0, numeros: [], observacion: null,
    solo_movimientos: true, en_taller: 0, numeros_taller: [], taller_detalle: [], numeros_ambiguos: [], disponibles: 0,
  });
  if (sinCenso) filas.splice(filas.indexOf(sinCenso), 1);   // ya no está "sin nada"
  filas.push(nueva);
  return nueva;
}

/**
 * Paso 1 (ANTES de cruzar con el taller): los que se quedaron en otro
 * objetivo después del último censo cambian de fila.
 */
function aplicarSeQuedo(filas, movs, nombreObj = {}, extra = {}) {
  (movs || []).filter(m => m.estado === 'se_quedo')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .forEach(m => {
      const o = filaConNumero(filas, m.origen_objetivo_id, m.numero, m.tipo);
      if (!o || (o.respondido_at && m.created_at < o.respondido_at)) return;   // el censo ya lo refleja
      const ix = (o.numeros || []).findIndex(n => mismoNumero(n, m.numero));
      o.numeros = o.numeros.slice(); o.numeros.splice(ix, 1);
      o.cantidad = Math.max(0, (Number(o.cantidad) || 0) - 1);
      (o.numeros_salieron = o.numeros_salieron || []).push({ numero: m.numero, hacia: nombreObj[m.destino_objetivo_id] || '—', fecha: m.created_at });
      const d = filaDestino(filas, Object.assign({}, m, { tipo: m.tipo || o.tipo }), nombreObj, extra);
      d.numeros = (d.numeros || []).concat([m.numero]);
      d.cantidad = (Number(d.cantidad) || 0) + 1;
      (d.numeros_llegaron = d.numeros_llegaron || []).push({ numero: m.numero, desde: o.objetivo, fecha: m.created_at });
    });
  return filas;
}

/**
 * Paso 2 (DESPUÉS del taller): las prestadas no cuentan como disponibles en
 * el origen y suman en el destino.
 */
function aplicarPrestadas(filas, movs, nombreObj = {}, extra = {}) {
  (movs || []).filter(m => m.estado === 'afuera').forEach(m => {
    const o = filaConNumero(filas, m.origen_objetivo_id, m.numero, m.tipo);
    const info = { numero: m.numero, id: m.id, vuelve_fecha: m.vuelve_fecha || null, vencida: vencida(m) };
    if (o) {
      (o.numeros_prestados = o.numeros_prestados || []).push(Object.assign({ hacia: nombreObj[m.destino_objetivo_id] || '—' }, info));
      o.disponibles = Math.max(0, (o.disponibles == null ? Number(o.cantidad) || 0 : o.disponibles) - 1);
    }
    const d = filaDestino(filas, Object.assign({}, m, { tipo: m.tipo || (o && o.tipo) }), nombreObj, extra);
    (d.numeros_recibidos = d.numeros_recibidos || []).push(Object.assign({ desde: nombreObj[m.origen_objetivo_id] || (o && o.objetivo) || '—' }, info));
    d.disponibles = (d.disponibles == null ? Number(d.cantidad) || 0 : d.disponibles) + 1;
  });
  return filas;
}

// Para mostrar: una línea legible del movimiento.
function armarFila(m, nombreObj = {}) {
  return {
    id: m.id, numero: m.numero, tipo: m.tipo || null,
    desde: nombreObj[m.origen_objetivo_id] || '—', hacia: nombreObj[m.destino_objetivo_id] || '—',
    origen_objetivo_id: m.origen_objetivo_id, destino_objetivo_id: m.destino_objetivo_id,
    vuelve: !!m.vuelve, vuelve_fecha: m.vuelve_fecha || null,
    estado: m.estado, vencida: vencida(m),
    dias_vencida: vencida(m) ? Math.round((new Date(hoyISO() + 'T12:00') - new Date(String(m.vuelve_fecha).slice(0, 10) + 'T12:00')) / 864e5) : 0,
    creado_por: m.creado_por || null, created_at: m.created_at,
    volvio_at: m.volvio_at || null, volvio_por: m.volvio_por || null, obs: m.obs || null,
  };
}

module.exports = { ubicarNumero, aplicarSeQuedo, aplicarPrestadas, armarFila, mismoNumero, mismoTipo, vencida, normNum, hoyISO };
