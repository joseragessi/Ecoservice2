// ── Viajes / bateas (roll off) ──────────────────────────────────────────────
// El chofer, al terminar la jornada, carga por WhatsApp una sola línea con
// las bateas del día (objetivo + cantidad). El odómetro se eliminó del flujo
// (30-jul-2026) porque a los choferes les resultaba engorroso y frenaba la
// adopción: mejor todos los viajes sin km, que ningún viaje.

const supabase = require('./supabase');
const ses = require('./sesion');

const sesiones = {};   // telefono -> { paso, datos }

const CONFIRMA = ['si', 'sí', 'ok', 'dale', 'listo', 'confirmo', 'confirmar', 'va', 'de una', 'perfecto', 'correcto'];
const CANCELA  = ['cancelar', 'cancela', 'no', 'nada', 'dejalo', 'olvidalo'];

function normalizarPatente(p) { return String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

async function resolverChofer(tel) {
  // Intento con unidad + flag chofer (si la tabla tiene esas columnas)
  let { data } = await supabase.from('capataces')
    .select('id, nombre, objetivo_id, unidad_id, es_chofer, unidades(patente)')
    .eq('telefono', tel).eq('activo', true).maybeSingle();
  if (!data) {
    const r = await supabase.from('capataces')
      .select('id, nombre, objetivo_id')
      .eq('telefono', tel).eq('activo', true).maybeSingle();
    data = r.data || null;
  }
  return data;
}

const num = t => {
  const n = parseFloat(String(t).replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
};

function resumenParadas(paradas) {
  if (!paradas.length) return '  (sin paradas todavía)';
  return paradas.map(p => `  • ${p.objetivo_nombre} — ${p.bateas} batea${p.bateas === 1 ? '' : 's'}`).join('\n');
}

// Normaliza un nombre para comparar: minúsculas, sin acentos, solo letras y
// números. Tiene que dar EXACTAMENTE lo mismo que normObjetivo() en
// panel_api.js — los alias se guardan con este formato.
function normObjetivo(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Resuelve el texto que escribió el chofer contra un objetivo real.
// Orden: alias exacto → nombre exacto → una sola candidata parcial.
// Si hay VARIAS candidatas no elige ninguna: antes se quedaba con la primera
// sin avisar (escribir "caminos" caía en cualquiera de los tres Caminos de
// las Sierras). Sin match, la parada se guarda como texto libre y se corrige
// desde el panel de Bateas.
function resolverObjetivo(nombreTxt, objetivos, aliasMap) {
  const nt = normObjetivo(nombreTxt);
  if (!nt) return null;

  const porAlias = aliasMap[nt];
  if (porAlias) return porAlias;

  const exacto = (objetivos || []).find(o => normObjetivo(o.nombre) === nt);
  if (exacto) return exacto;

  const parciales = (objetivos || []).filter(o => {
    const no = normObjetivo(o.nombre);
    return no.includes(nt) || nt.includes(no);
  });
  return parciales.length === 1 ? parciales[0] : null;
}

// Parsea una línea tipo "chacras 2, deposito 1, cañuelas 2" → paradas.
// Separa por comas o saltos de línea; en cada tramo, el número final es la
// cantidad y el resto es el objetivo. Devuelve { paradas, noReconocidos }.
async function parsearBateas(texto) {
  const { data: objetivos } = await supabase.from('objetivos').select('id, nombre').eq('activo', true);

  // Alias aprendidos desde el panel ("ucc" → UNIVERSIDAD CATOLICA DE CORDOBA).
  // Si la tabla todavía no existe, se sigue sin alias: nunca frena una carga.
  const aliasMap = {};
  try {
    const { data: alias } = await supabase
      .from('objetivos_alias').select('alias, objetivo_id, objetivos(nombre)');
    (alias || []).forEach(a => {
      if (a.objetivo_id && a.objetivos) {
        aliasMap[a.alias] = { id: a.objetivo_id, nombre: a.objetivos.nombre };
      }
    });
  } catch (e) {
    console.log('[bateas] sin tabla objetivos_alias todavía:', e.message);
  }

  const tramos = String(texto).split(/[,\n;]+/).map(t => t.trim()).filter(Boolean);
  const paradas = [], noReconocidos = [];
  for (const tramo of tramos) {
    // último número del tramo = cantidad; lo de antes = nombre del objetivo
    const m = tramo.match(/^(.*?)[\s:=x-]*(\d+)\s*$/);
    if (!m || !m[1].trim()) { noReconocidos.push(tramo); continue; }
    const nombreTxt = m[1].trim();
    const cant = parseInt(m[2], 10);
    if (!cant || cant <= 0) { noReconocidos.push(tramo); continue; }
    const match = resolverObjetivo(nombreTxt, objetivos, aliasMap);
    paradas.push({
      objetivo_id: match ? match.id : null,
      objetivo_nombre: match ? match.nombre : nombreTxt,
      // Lo que escribió el chofer, tal cual. Es lo que después se convierte
      // en alias cuando José corrige la parada desde el panel.
      texto_original: nombreTxt,
      bateas: cant,
      reconocido: !!match,
    });
  }
  return { paradas, noReconocidos };
}

// ── Inicio del flujo ─────────────────────────────────────────
async function iniciarViajes(telefono, resto) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');
  const chofer = await resolverChofer(tel);
  if (!chofer) return '🚛 No te tengo registrado. Avisá a administración para que te den de alta.';
  // Si la columna es_chofer existe y está en false explícito, no es chofer.
  if (chofer.es_chofer === false) {
    return '🚛 Esta opción es para los choferes de los camiones roll off. Si tenés que cargar viajes, pedí que te marquen como chofer en administración.';
  }
  sesiones[tel] = {
    paso: 'bateas',
    datos: { chofer, paradas: [] },
  };
  const uni = chofer.unidades ? ` (${chofer.unidades.patente})` : '';
  return `🚛 *Carga de viajes del día*, ${chofer.nombre.split(' ')[0]}${uni}.\n\n` +
    `Escribí las *bateas del día* en una sola línea, objetivo y cantidad separados por coma.\n\n` +
    `_Por ejemplo:_\n*Chacras 2, Deposito 1, Cañuelas 2*`;
}

async function tieneSesionViajes(telefono) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');
  if (sesiones[tel]) return true;
  const rec = await ses.restaurar('viajes', tel);
  if (rec) { sesiones[tel] = rec; return true; }
  return false;
}

// ── Continuación ─────────────────────────────────────────────
async function continuarViajes(telefono, mensaje) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');
  const s = sesiones[tel];
  if (!s) return null;
  const texto = (mensaje || '').trim();
  const bajo = texto.toLowerCase();
  const nombre = s.datos.chofer.nombre.split(' ')[0];

  if (CANCELA.includes(bajo) && s.paso !== 'confirmar') {
    delete sesiones[tel];
    return `👍 Listo ${nombre}, cancelé la carga. No se guardó nada.`;
  }

  // 1) Bateas: una línea con todas las paradas
  if (s.paso === 'bateas') {
    const { paradas, noReconocidos } = await parsearBateas(texto);
    if (!paradas.length) {
      return `No pude leer ninguna parada. Escribilas así:\n*Chacras 2, Deposito 1, Cañuelas 2*\n(objetivo y número, separados por coma)`;
    }
    s.datos.paradas = paradas;
    s.paso = 'confirmar';
    let aviso = '';
    const dudosos = paradas.filter(p => !p.reconocido);
    if (dudosos.length) aviso = `\n⚠️ No encontré en el sistema: ${dudosos.map(p => '*' + p.objetivo_nombre + '*').join(', ')}. Los cargo con ese nombre igual.\n`;
    if (noReconocidos.length) aviso += `\n⚠️ No entendí: "${noReconocidos.join('", "')}". Si faltó alguno, reescribí la línea completa.\n`;
    return cerrarResumen(s, aviso);
  }

  // 2) Confirmación final
  if (s.paso === 'confirmar') {
    if (CONFIRMA.includes(bajo)) {
      const ok = await guardarViaje(s.datos);
      delete sesiones[tel];
      return ok
        ? `✅ Guardado, ${nombre}. ${totalBateas(s.datos)} bateas · ${s.datos.paradas.length} punto(s). ¡Gracias!`
        : `⚠️ No pude guardar. Avisá a administración.`;
    }
    if (CANCELA.includes(bajo)) { delete sesiones[tel]; return `👍 Cancelado, no se guardó.`; }
    // Cualquier otra cosa: la tomamos como corrección de la línea de bateas
    s.paso = 'bateas';
    return continuarViajes(telefono, mensaje);
  }

  return `No entendí. Escribí *cancelar* para empezar de nuevo.`;
}

function totalBateas(d) { return d.paradas.reduce((s, p) => s + p.bateas, 0); }

function cerrarResumen(s, aviso) {
  s.paso = 'confirmar';
  const d = s.datos;
  return `📋 *Resumen del día*\n\n` +
    `🚛 ${d.chofer.nombre}\n` +
    `📦 ${totalBateas(d)} bateas · ${d.paradas.length} punto(s) de bajada\n\n` +
    `${resumenParadas(d.paradas)}\n` +
    (aviso || '') +
    `\n¿Confirmás? (*sí* para guardar / *cancelar*)\n` +
    `_Si algo está mal, reescribí la línea de bateas y la corrijo._`;
}

async function guardarViaje(d) {
  try {
    const { error } = await supabase.from('viajes_bateas').insert({
      chofer_id: d.chofer.id,
      unidad_id: d.chofer.unidad_id || null,
      patente_raw: d.chofer.unidades ? d.chofer.unidades.patente : null,
      fecha: new Date().toISOString().slice(0, 10),
      odometro_inicio: null,
      odometro_fin: null,
      km: null,
      paradas: d.paradas,
      total_bateas: totalBateas(d),
      puntos_bajada: d.paradas.length,
    });
    if (error) throw error;
    console.log(`[viajes] ${d.chofer.nombre}: ${totalBateas(d)} bateas, ${d.paradas.length} puntos`);
    return true;
  } catch (e) { console.error('guardarViaje:', e); return false; }
}

module.exports = {
  normObjetivo,
  resolverObjetivo,
  iniciarViajes: ses.conPersistencia('viajes', sesiones, iniciarViajes),
  continuarViajes: ses.conPersistencia('viajes', sesiones, continuarViajes),
  tieneSesionViajes,
};
