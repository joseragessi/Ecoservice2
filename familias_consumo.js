// Clasificación de equipos POR CONSUMO DE COMBUSTIBLE.
//
// Distinto del clasificador de reparaciones (FAMILIAS_EQUIPO en panel_api):
// ahí interesa quién arregla qué; acá, cuánto combustible gasta cada cosa.
// Una pala y una motoguadaña van al mismo taller pero solo una consume.
//
// Por qué hace falta: el censo de cada objetivo cuenta TODO lo que hay —
// palas, machetes, horquillas, carros — y meterlos en el denominador hunde
// el promedio por máquina. FINCAS DEL SUR daba 5% de uso con 34 "máquinas",
// de las cuales machetes y palas no consumen una gota.
//
// Los nombres vienen del censo, escritos a mano por el capataz:
// "motoguadañas echo", "cortacerco sthil", "Pala de punta", "extensible
// husqvarna 1". Por eso todo se compara sin acentos y por palabra suelta.

const FAMILIAS_CONSUMO = [
  // Sin motor PRIMERO: una "pala cargadora" es tractor, pero una "pala de
  // punta" es una herramienta. El orden de las reglas resuelve el empate.
  [/pala\s*(cargador|mecanic)/i, 'tractor'],
  // Sin \b al final: el capataz escribe en plural ("Palas de mano", "Conos",
  // "Machetes") y con \b esos nombres caían en "sin clasificar".
  [/\b(pala|machete|horquilla|orquilla|escobilla|escobillon|rastrillo|azada|tijera|podon|gancho|gacho|maza|pison|carretilla|balde|manguera|cono|linga|arnes|casco|protector|soga|carro|remolque|acoplad|trailer|zorra|tanque|cisterna|sisterna|bidon|jardinera|barrendero|kit|llave|vaso)/i, 'sin_motor'],

  // Vehículos: van por kilómetros, no por horas de uso
  [/camioneta|toyota|hilux|amarok|ranger|utilitar|furgon/i, 'vehiculo'],
  [/camion(?!eta)|volcador|chasis/i, 'vehiculo'],
  [/hidro\s*gr|hidrogr/i, 'vehiculo'],

  // Tractores y máquinas grandes: consumo alto por hora
  [/mini\s*tractor|giro\s*cero|tractor|desmalez|retro|bobcat|minicargad/i, 'tractor'],

  // Cortadoras: motor de 4 tiempos, consumo medio
  [/cortadora|corta\s*pasto|plana|hanomag/i, 'cortadora'],

  // 2 tiempos: el grueso del parque, 6 lt por jornada según José
  [/motoguada|guadana|motosierra|sopladora|bordead|extensible|pertiga|cortacerco|fumigador|motopulveriz|motobomb|hidrolavad|desbrozad/i, 'dos_tiempos'],

  // Equipos fijos a motor
  [/generador|compresor|grupo\s*electrog/i, 'fijo'],
];

const LABEL_FAMILIA = {
  dos_tiempos: '2 tiempos',
  cortadora: 'Cortadoras',
  tractor: 'Tractores',
  vehiculo: 'Vehículos',
  fijo: 'Equipos fijos',
  sin_motor: 'Sin motor',
  otro: 'Sin clasificar',
};

// Familias que consumen combustible. `sin_motor` queda afuera de todo
// promedio: no gasta y solo diluiría el resultado.
const FAMILIAS_CON_MOTOR = ['dos_tiempos', 'cortadora', 'tractor', 'vehiculo', 'fijo'];

/** Clasifica un tipo de equipo del censo. Devuelve la clave de la familia. */
function familiaConsumo(tipo) {
  const raw = String(tipo || '').trim();
  if (!raw) return 'otro';
  const t = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [re, fam] of FAMILIAS_CONSUMO) if (re.test(t)) return fam;
  return 'otro';
}

/**
 * Agrupa los ítems de un censo por familia de consumo.
 * items: [{ tipo_equipo, cantidad }]
 * Devuelve { dos_tiempos: n, tractor: n, ..., con_motor: n, total: n, detalle: {} }
 */
function agruparPorFamilia(items) {
  const out = { total: 0, con_motor: 0, detalle: {} };
  FAMILIAS_CON_MOTOR.concat(['sin_motor', 'otro']).forEach(f => { out[f] = 0; });
  (items || []).forEach(i => {
    const n = Number(i.cantidad) || 0;
    if (!n) return;
    const f = familiaConsumo(i.tipo_equipo);
    out[f] += n;
    out.total += n;
    if (FAMILIAS_CON_MOTOR.includes(f)) out.con_motor += n;
    out.detalle[f] = out.detalle[f] || {};
    out.detalle[f][i.tipo_equipo] = (out.detalle[f][i.tipo_equipo] || 0) + n;
  });
  return out;
}

// ── Consumo de referencia ────────────────────────────────────
// Litros que gasta cada familia en una JORNADA COMPLETA de trabajo.
// Los dos primeros son datos que dio José (agosto 2026); los vehículos son
// una estimación y por eso están marcados aparte.
const CONSUMO_JORNADA = {
  dos_tiempos: 6,     // motoguadaña, motosierra, extensible, sopladora
  tractor: 40,        // gasoil, jornada completa
  cortadora: 12,      // estimado: motor de 4 tiempos, entre una 2T y un tractor
  fijo: 5,            // generador/compresor, uso intermitente
};

// Los vehículos no van por jornada sino por kilómetros, y el kilometraje
// depende de dónde estén: los de grupo "privado" se mueven dentro del barrio;
// los de "depósito" salen de la base a recorrer objetivos. Litros por MES.
const CONSUMO_VEHICULO_MES = {
  privado: 130,       // ~un tanque cada dos semanas (dato de José)
  deposito: 280,      // salen a los objetivos: más del doble de recorrido
  default: 180,
};

/**
 * Litros que consumiría el parque de un objetivo si TODO trabajara a jornada
 * completa todos los días hábiles. Es un techo, no una expectativa: sirve para
 * medir qué porción de su capacidad usó cada objetivo y compararlos entre sí,
 * sin tener que suponer cuántas máquinas se usan a diario.
 */
function capacidadTeorica(familias, diasHabiles, grupo) {
  if (!familias) return null;
  const g = String(grupo || '').toLowerCase();
  const porMesVeh = CONSUMO_VEHICULO_MES[g === 'deposito' || g === 'depósito' ? 'deposito'
    : g === 'privado' ? 'privado' : 'default'];
  let lt = 0;
  Object.entries(CONSUMO_JORNADA).forEach(([fam, porJornada]) => {
    lt += (familias[fam] || 0) * porJornada * diasHabiles;
  });
  lt += (familias.vehiculo || 0) * porMesVeh;
  return Math.round(lt);
}

module.exports = { familiaConsumo, agruparPorFamilia, LABEL_FAMILIA, FAMILIAS_CON_MOTOR,
  CONSUMO_JORNADA, CONSUMO_VEHICULO_MES, capacidadTeorica };
