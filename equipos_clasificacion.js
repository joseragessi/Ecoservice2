// Clasificación de equipos y destinos de combustible (Cost Intelligence V4).
//
// La idea de fondo, del handoff V4: el sistema NO adivina a dónde fue el
// combustible. El capataz lo declara eligiendo una máquina real de su
// objetivo. Para poder ofrecerle esa lista hay que saber antes:
//   1. qué equipos tienen motor y cuáles son de pañol (palas, machetes);
//   2. de qué familia es cada uno (2 tiempos, tractor, mini tractor, vehículo);
//   3. qué combustible usa y si se asigna individual o por grupo.
//
// La clasificación automática (familias_consumo.js) queda como SUGERENCIA:
// se muestra ya marcada en el panel, José confirma o corrige, y lo confirmado
// gana siempre sobre lo sugerido.

const { familiaConsumo, FAMILIAS_CON_MOTOR } = require('./familias_consumo');

// Familias que ve el negocio. mini_tractor se separa de tractor a propósito:
// consumen muy distinto y mezclarlos daba desvíos falsos.
const FAMILIAS = ['dos_tiempos', 'cortadora', 'mini_tractor', 'tractor', 'vehiculo', 'fijo', 'otro_motor', 'panol'];
const LABEL_FAMILIA_V4 = {
  dos_tiempos:  'Dos tiempos',
  cortadora:    'Cortadoras',
  mini_tractor: 'Mini tractores',
  tractor:      'Tractores',
  vehiculo:     'Vehículos',
  fijo:         'Equipos fijos',
  otro_motor:   'Otras con motor',
  panol:        'Pañol (sin motor)',
};
const EMOJI_FAMILIA = {
  dos_tiempos: '🌾', cortadora: '✂️', mini_tractor: '🚜', tractor: '🚜',
  vehiculo: '🚛', fijo: '⚙️', otro_motor: '🔧', panol: '🧰',
};
// Qué combustible usa cada familia, por defecto.
const COMBUSTIBLE_FAMILIA = {
  dos_tiempos: 'super', cortadora: 'super', mini_tractor: 'gasoil',
  tractor: 'gasoil', vehiculo: 'gasoil', fijo: 'gasoil', otro_motor: 'super', panol: null,
};
// Individual = se identifica la máquina exacta. Grupo = el combustible va a
// un bidón que abastece varias (motoguadañas, motosierras).
const MODO_FAMILIA = {
  dos_tiempos: 'grupo', cortadora: 'grupo', mini_tractor: 'individual',
  tractor: 'individual', vehiculo: 'individual', fijo: 'individual', otro_motor: 'grupo', panol: null,
};

// ── Marcas ────────────────────────────────────────────────────
// En los censos la marca viene pegada al tipo: "motoguadañas echo",
// "motoguadañ Sthil 291", "sopladora mochila Sthil". Son la misma máquina
// con distinta marca, pero el sistema las trata como tipos distintos y eso
// parte el consumo en cinco filas.
//
// Decisión de José (10-sep): la marca es una ETIQUETA, no una categoría.
// Se separa del tipo: el capataz sigue viéndolas por marca al repartir
// (para saber cuál agarra) y los consumos suman por tipo.
//
// Las variantes mal escritas están a propósito: así las escriben los
// capataces y así llegan al censo.
const MARCAS = [
  ['Stihl',      /\bs?th?ihl?\b|\bsthill?\b|\bstihl\b/i],
  ['Husqvarna',  /\bhusq?varn?a?s?\b|\bhusvarna?s?\b|\bhusqvar\b/i],
  ['Echo',       /\becho?s?\b/i],
  ['Shindaiwa',  /\bshind?aiwa\b/i],
  ['Kawasaki',   /\bkawasaki\b/i],
  ['Honda',      /\bhonda\b/i],
  ['John Deere', /\bjohn\s*deere?\b|\bjhon\s*deere?\b|\bdeere\b/i],
  ['New Holland',/\bnew\s*holland\b/i],
  ['Massey',     /\bmassey\b|\bmf\s*\d/i],
  ['Pauny',      /\bpauny\b|\bpouny\b/i],
  ['Toyota',     /\btoyot?a?\b/i],
  ['Fiat',       /\bfiat\b/i],
  ['Ford',       /\bford\b/i],
  ['Chevrolet',  /\bchevrolet\b|\bs-?10\b/i],
  ['Volkswagen', /\bvolkswagen\b|\bvw\b|\bamarok\b|\bsaveiro\b/i],
  ['Renault',    /\brenault\b|\bkangoo\b/i],
  ['Bobcat',     /\bbobcat\b/i],
  ['Fema',       /\bfema\b/i],
  ['Funes',      /\bfunes\b/i],
];

/**
 * Separa marca y tipo de un nombre de equipo del censo.
 * "motoguadañ Sthil 291" → { tipo: 'Motoguadaña', marca: 'Stihl', modelo: '291' }
 * "Motoguadaña"          → { tipo: 'Motoguadaña', marca: null,    modelo: null }
 *
 * El tipo se devuelve NORMALIZADO al singular y con la primera en mayúscula,
 * para que "motoguadañas echo" y "Motoguadaña" caigan en el mismo tipo.
 */
function separarMarca(nombre) {
  const original = String(nombre == null ? '' : nombre).trim();
  if (!original) return { tipo: '', marca: null, modelo: null, original };
  let resto = original, marca = null;
  for (const [nom, re] of MARCAS) {
    if (re.test(resto)) { marca = nom; resto = resto.replace(re, ' '); break; }
  }
  // Lo que queda después de la marca: se le saca el modelo (números sueltos
  // al final) y se normaliza. "291" en "Motoguadaña Stihl 291" es modelo.
  // El modelo es el número del final ("Stihl 291", "MF 1175"). Se saca del
  // tipo pero se conserva aparte: sirve para identificar la máquina y no
  // tiene por qué partir el consumo.
  let modelo = null;
  const mm = resto.match(/\b(\d{2,4}[a-z]?)\b\s*$/i);
  if (mm) { modelo = mm[1]; resto = resto.slice(0, mm.index); }
  // Si al sacar el modelo no queda nada reconocible, se vuelve atrás: el
  // número era parte del nombre, no un modelo suelto.
  if (!resto.replace(/[^a-záéíóúñ]/gi, '').trim()) { resto = original; modelo = null; }
  const tipo = tipoCanonico(resto);
  return { tipo: tipo || tipoCanonico(original) || original, marca, modelo, original };
}

// Lleva un nombre de equipo a su forma canónica: sin plural, sin espacios de
// más, con la primera en mayúscula. "motoguadañas" y "Motoguadaña" → "Motoguadaña".
// El ORDEN importa: la primera regla que matchea gana. Las combinaciones
// van antes que las simples, porque "Motosierra extensible" es un equipo
// distinto de una motosierra y no se puede colapsar a "Motosierra".
const CANONICOS = [
  [/(motosierra|pod[oa]dora).*extensible|extensible.*(motosierra|pod)/i, 'Motosierra extensible'],
  [/sopladoras?\s*(de\s*)?mochila|mochila\s*sopladora/i, 'Sopladora mochila'],
  [/mochila\s*(pulverizadora|fumigadora|de\s*fumigar|fumigar)|pulverizadora\s*(de\s*)?mochila/i, 'Mochila pulverizadora'],
  [/motoguada[nñ]a?s?/i, 'Motoguadaña'],
  [/motosierras?/i,      'Motosierra'],
  [/sopladoras?/i,       'Sopladora'],
  [/extensibles?/i,      'Extensible'],
  [/cortacercos?/i,      'Cortacerco'],
  [/desmalezadoras?/i,   'Desmalezadora'],
  [/mini\s*tractor(es)?|minitractor(es)?|giro\s*cero/i, 'Mini tractor'],
  [/tractor(es)?/i,      'Tractor'],
  [/camionetas?|hilux|pick\s*up|strada|saveiro|amarok|ranger|s-?10|kangoo|partner|montana|utilitari?o?/i, 'Camioneta'],
  [/cami[oó]n(es)?/i,    'Camión'],
  [/pulverizadoras?|fumigadoras?/i, 'Pulverizadora'],
  [/compresor(es)?/i,    'Compresor'],
  [/hidrolavadoras?/i,   'Hidrolavadora'],
  [/generador(es)?|grupo\s*electr/i, 'Generador'],
  [/cortadoras?\s*(de\s*)?c[eé]sped|corta\s*c[eé]sped/i, 'Cortadora de césped'],
];
function tipoCanonico(txt) {
  const t = String(txt || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  for (const [re, canon] of CANONICOS) if (re.test(t)) return canon;
  // Sin regla: se limpia el plural simple y se capitaliza.
  const limpio = t.replace(/\bde\s+mano\b/i, '').replace(/\s+/g, ' ').trim();
  return limpio.charAt(0).toUpperCase() + limpio.slice(1).toLowerCase();
}

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Clasificación SUGERIDA de un tipo de equipo. Es lo que el panel muestra
 * ya marcado para que José confirme; nunca pisa una confirmación manual.
 */
function sugerirClasificacion(tipoEquipo) {
  const t = norm(tipoEquipo);
  const fam0 = familiaConsumo(tipoEquipo);
  let familia;
  // Mini tractor primero: familias_consumo lo mete en 'tractor' y acá tiene
  // que quedar separado. "giro cero" y "cortadora de césped autopropulsada"
  // son mini tractores en la práctica de EcoService.
  if (/\bmini\s*tractor|minitractor|giro\s*cero|mini\s*trac/.test(t)) familia = 'mini_tractor';
  else if (fam0 === 'sin_motor') familia = 'panol';
  else if (fam0 === 'otro') familia = 'panol';   // sin clasificar → pañol hasta que se confirme
  else if (fam0 === 'dos_tiempos') familia = 'dos_tiempos';
  else if (fam0 === 'cortadora') familia = 'cortadora';
  else if (fam0 === 'tractor') familia = 'tractor';
  else if (fam0 === 'vehiculo') familia = 'vehiculo';
  else if (fam0 === 'fijo') familia = 'fijo';
  else familia = 'panol';

  const conMotor = familia !== 'panol';
  return {
    es_maquinaria: conMotor,
    consume_combustible: conMotor,
    familia_consumo: familia,
    combustible_habitual: COMBUSTIBLE_FAMILIA[familia] || null,
    modo_asignacion_combustible: MODO_FAMILIA[familia] || null,
    // Nunca true: la sugerencia no confirma. Lo confirma una persona.
    clasificacion_confirmada: false,
    // Cuando familias_consumo no supo qué era, se avisa: son las que más
    // conviene que alguien mire.
    dudosa: fam0 === 'otro',
  };
}

/**
 * La clasificación EFECTIVA de una fila del inventario: lo confirmado si
 * existe, la sugerencia si no. Devuelve además de dónde salió, para que la
 * pantalla pueda mostrar qué falta revisar.
 */
function clasificacionEfectiva(fila) {
  const sug = sugerirClasificacion(fila && fila.tipo_equipo);
  if (fila && fila.clasificacion_confirmada) {
    return {
      es_maquinaria: fila.es_maquinaria !== false,
      consume_combustible: !!fila.consume_combustible,
      familia_consumo: fila.familia_consumo || sug.familia_consumo,
      combustible_habitual: fila.combustible_habitual || null,
      modo_asignacion_combustible: fila.modo_asignacion_combustible || sug.modo_asignacion_combustible,
      origen: 'confirmada', dudosa: false,
    };
  }
  return { ...sug, origen: 'sugerida' };
}

// ¿Este destino sirve para este combustible? Un tractor no aparece en el
// bloque de súper. 'mixto' vale para los dos.
function aceptaCombustible(comb, producto) {
  const c = norm(comb), p = norm(producto);
  if (!c || c === 'mixto' || c === 'otro') return true;
  if (!p) return true;
  // El producto que lee el OCR es el nombre comercial: "V-POWER DIESEL",
  // "PUMA SUPER", "ION DIESEL", "Nafta super".
  const esGasoil = /diesel|gasoil|gas oil|evolux|infinia d|d\b/.test(p) && !/super|nafta/.test(p);
  const esSuper  = /super|nafta|premium|infinia(?!\s*d)/.test(p);
  if (c === 'gasoil') return esGasoil || (!esGasoil && !esSuper);
  if (c === 'super')  return esSuper  || (!esGasoil && !esSuper);
  return true;
}

/**
 * Arma la lista de destinos que se le ofrece al capataz.
 *
 * @param censoItems  ítems del censo del período: [{tipo_equipo, cantidad, numeros}]
 * @param inventario  filas de stock_objetivo del objetivo (para la clasificación confirmada)
 * @param unidades    unidades de la flota asignadas al objetivo [{id, patente, codigo, marca_modelo}]
 * @param opts        { producto } para filtrar por combustible
 *
 * Regla: el censo manda sobre el inventario. El inventario aporta la
 * clasificación; el censo aporta qué hay realmente este mes.
 */
function armarDestinos(censoItems, inventario, unidades, opts) {
  const o = opts || {};
  // La clasificación se busca por tipo CANÓNICO: si José confirmó
  // "Motoguadaña", vale también para "motoguadañas echo".
  const clasePorTipo = {};
  (inventario || []).forEach(f => {
    const k = norm(separarMarca(f.tipo_equipo).tipo);
    // Gana la confirmada: puede haber varias filas del mismo tipo.
    if (!clasePorTipo[k] || f.clasificacion_confirmada) clasePorTipo[k] = clasificacionEfectiva(f);
  });

  const destinos = [];
  (censoItems || []).forEach((it, ix) => {
    const tipo = it.tipo_equipo || it.tipo;
    const sep = separarMarca(tipo);
    const k = norm(sep.tipo);
    if (!k) return;
    const cl = clasePorTipo[k] || clasificacionEfectiva({ tipo_equipo: sep.tipo });
    // La etiqueta que ve el capataz conserva la marca: al repartir tiene que
    // saber CUÁL agarra ("Motoguadaña Echo"), aunque el consumo sume por tipo.
    const etiqueta = [sep.tipo, sep.marca, sep.modelo].filter(Boolean).join(' ');
    if (!cl.es_maquinaria || !cl.consume_combustible) return;   // pañol no entra
    const nums = (it.numeros || []).map(n => String(n).trim()).filter(n => n && !/^(sn|s\/n|sin|-|0)$/i.test(n));
    const cant = Number(it.cantidad) || 0;

    if (cl.modo_asignacion_combustible === 'individual' && nums.length) {
      // Una entrada por máquina numerada: el capataz elige cuál.
      nums.forEach(n => destinos.push({
        ref_tipo: 'censo', ref_id: `${ix}:${n}`, tipo_equipo: sep.tipo, marca: sep.marca, modelo: sep.modelo,
        familia: cl.familia_consumo, combustible: cl.combustible_habitual,
        modo: 'individual', cantidad: 1, numeros: [n],
        label: `${etiqueta} ${n}`, emoji: EMOJI_FAMILIA[cl.familia_consumo] || '🔧',
      }));
      // Las que no tienen número van juntas, si sobran.
      const sinNum = Math.max(0, cant - nums.length);
      if (sinNum > 0) destinos.push({
        ref_tipo: 'censo', ref_id: `${ix}:sn`, tipo_equipo: sep.tipo, marca: sep.marca, modelo: sep.modelo,
        familia: cl.familia_consumo, combustible: cl.combustible_habitual,
        modo: 'grupo', cantidad: sinNum, numeros: [],
        label: `${etiqueta} sin número (${sinNum})`, emoji: EMOJI_FAMILIA[cl.familia_consumo] || '🔧',
        sin_identificar: true,
      });
    } else {
      // Grupo: el combustible va al bidón que abastece a todas.
      destinos.push({
        ref_tipo: 'censo', ref_id: String(ix), tipo_equipo: sep.tipo, marca: sep.marca, modelo: sep.modelo,
        familia: cl.familia_consumo, combustible: cl.combustible_habitual,
        modo: 'grupo', cantidad: cant, numeros: nums,
        label: cant > 1 ? `${etiqueta} (${cant})` : etiqueta,
        emoji: EMOJI_FAMILIA[cl.familia_consumo] || '🔧',
      });
    }
  });

  // Unidades de la flota (camionetas, camiones): salen del maestro, no del
  // censo — las camionetas no se censan.
  (unidades || []).forEach(u => {
    const etiqueta = [u.codigo, u.marca_modelo, u.patente].filter(Boolean).join(' — ');
    destinos.push({
      ref_tipo: 'unidad', ref_id: u.id, tipo_equipo: u.marca_modelo || 'Unidad',
      familia: 'vehiculo', combustible: 'gasoil', modo: 'individual', cantidad: 1,
      numeros: [u.patente].filter(Boolean),
      label: etiqueta || u.patente || 'Unidad', emoji: '🚛',
    });
  });

  const filtrados = o.producto ? destinos.filter(d => aceptaCombustible(d.combustible, o.producto)) : destinos;
  // Ordenados por familia, para que en la app queden agrupados como en el censo.
  const orden = FAMILIAS.indexOf.bind(FAMILIAS);
  return filtrados.sort((a, b) => (orden(a.familia) - orden(b.familia)) || String(a.label).localeCompare(String(b.label)));
}

// Agrupa los destinos por familia, para pintarlos con encabezado.
function agruparDestinos(destinos) {
  const g = {};
  (destinos || []).forEach(d => { (g[d.familia] = g[d.familia] || []).push(d); });
  return FAMILIAS.filter(f => g[f]).map(f => ({
    familia: f, label: LABEL_FAMILIA_V4[f] || f, emoji: EMOJI_FAMILIA[f] || '🔧',
    total: g[f].reduce((s, d) => s + (Number(d.cantidad) || 0), 0), destinos: g[f],
  }));
}

/**
 * Valida que el reparto de un producto cierre contra los litros del ticket.
 * Tolerancia 0,01 lt (definida en el handoff V4).
 */
function validarReparto(litrosTicket, repartos) {
  const tot = Math.round((Number(litrosTicket) || 0) * 100) / 100;
  const sum = Math.round((repartos || []).reduce((s, r) => s + (Number(r.litros) || 0), 0) * 100) / 100;
  const dif = Math.round((tot - sum) * 100) / 100;
  return { total: tot, asignado: sum, resta: dif, cierra: Math.abs(dif) <= 0.01,
    estado: Math.abs(dif) <= 0.01 ? 'completa' : (sum === 0 ? 'pendiente' : 'parcial') };
}

module.exports = {
  FAMILIAS, LABEL_FAMILIA_V4, EMOJI_FAMILIA, COMBUSTIBLE_FAMILIA, MODO_FAMILIA,
  MARCAS, separarMarca, tipoCanonico,
  norm, sugerirClasificacion, clasificacionEfectiva, aceptaCombustible,
  armarDestinos, agruparDestinos, validarReparto,
};
