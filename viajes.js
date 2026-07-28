// ── Viajes / bateas (roll off) ──────────────────────────────────────────────
// El chofer, al terminar la jornada, carga por WhatsApp:
//   1) odómetro de inicio, 2) odómetro de fin,
//   3) por cada objetivo donde retiró bateas: objetivo + cantidad.
// De ahí salen los indicadores: km (fin−inicio), bateas trasladadas,
// puntos de bajada (objetivos distintos), y a futuro costo por km.

const supabase = require('./supabase');

const sesiones = {};   // telefono -> { paso, datos }

const CONFIRMA = ['si', 'sí', 'ok', 'dale', 'listo', 'confirmo', 'confirmar', 'va', 'de una', 'perfecto', 'correcto'];
const CANCELA  = ['cancelar', 'cancela', 'no', 'nada', 'dejalo', 'olvidalo'];
const FIN_PARADAS = ['listo', 'fin', 'terminar', 'terminado', 'no', 'nada', 'ya', 'eso es todo', 'ninguno', 'ninguna'];

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

async function resolverObjetivo(texto) {
  if (!texto) return { id: null, nombre: null };
  const { data: objetivos } = await supabase.from('objetivos').select('id, nombre').eq('activo', true);
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const nt = norm(texto);
  const match = (objetivos || []).find(o => { const no = norm(o.nombre); return no.includes(nt) || nt.includes(no); });
  return match ? { id: match.id, nombre: match.nombre } : { id: null, nombre: texto.trim() };
}

const num = t => {
  const n = parseFloat(String(t).replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
};

function resumenParadas(paradas) {
  if (!paradas.length) return '  (sin paradas todavía)';
  return paradas.map(p => `  • ${p.objetivo_nombre} — ${p.bateas} batea${p.bateas === 1 ? '' : 's'}`).join('\n');
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
    paso: 'odo_inicio',
    datos: { chofer, paradas: [] },
  };
  const uni = chofer.unidades ? ` (${chofer.unidades.patente})` : '';
  return `🚛 *Carga de viajes del día*, ${chofer.nombre.split(' ')[0]}${uni}.\n\n` +
    `¿Cuál es el *odómetro de INICIO* de la jornada? (los km que marcaba al arrancar)`;
}

function tieneSesionViajes(telefono) {
  return !!sesiones[telefono.replace('whatsapp:', '').replace('+', '')];
}

// ── Continuación ─────────────────────────────────────────────
async function continuarViajes(telefono, mensaje) {
  const tel = telefono.replace('whatsapp:', '').replace('+', '');
  const s = sesiones[tel];
  if (!s) return null;
  const texto = (mensaje || '').trim();
  const bajo = texto.toLowerCase();
  const nombre = s.datos.chofer.nombre.split(' ')[0];

  if (CANCELA.includes(bajo) && s.paso !== 'paradas_objetivo') {
    delete sesiones[tel];
    return `👍 Listo ${nombre}, cancelé la carga. No se guardó nada.`;
  }

  // 1) Odómetro inicio
  if (s.paso === 'odo_inicio') {
    const v = num(texto);
    if (v == null) return `No entendí el número. ¿Cuánto marcaba el odómetro al *arrancar* la jornada? (solo el número)`;
    s.datos.odometro_inicio = v;
    s.paso = 'odo_fin';
    return `👍 Inicio: ${v.toLocaleString('es-AR')} km.\n\n¿Y el *odómetro de FIN* de jornada? (los km al terminar)`;
  }

  // 2) Odómetro fin
  if (s.paso === 'odo_fin') {
    const v = num(texto);
    if (v == null) return `No entendí. ¿Cuánto marcaba el odómetro al *terminar*? (solo el número)`;
    if (v < s.datos.odometro_inicio) {
      return `⚠️ El odómetro de fin (${v.toLocaleString('es-AR')}) no puede ser menor al de inicio (${s.datos.odometro_inicio.toLocaleString('es-AR')}). Reenviá el de fin.`;
    }
    s.datos.odometro_fin = v;
    s.datos.km = Math.round((v - s.datos.odometro_inicio) * 10) / 10;
    s.paso = 'paradas_objetivo';
    return `📏 Recorriste *${s.datos.km.toLocaleString('es-AR')} km* hoy.\n\n` +
      `Ahora las *bateas*. Decime el *primer objetivo* donde retiraste bateas.\n` +
      `_(cuando termines con todos, escribí *listo*)_`;
  }

  // 3a) Nombre del objetivo de una parada
  if (s.paso === 'paradas_objetivo') {
    if (FIN_PARADAS.includes(bajo)) {
      if (!s.datos.paradas.length) return `Todavía no cargaste ninguna parada. Decime un objetivo, o escribí *cancelar* si no hiciste viajes.`;
      return cerrarResumen(s);
    }
    const obj = await resolverObjetivo(texto);
    s.tmpObjetivo = obj;
    s.paso = 'paradas_cantidad';
    return `¿Cuántas *bateas* retiraste en *${obj.nombre}*? (solo el número)`;
  }

  // 3b) Cantidad de bateas de esa parada
  if (s.paso === 'paradas_cantidad') {
    const v = num(texto);
    if (v == null || v <= 0) return `¿Cuántas bateas? Mandame solo el número (ej. 2).`;
    s.datos.paradas.push({
      objetivo_id: s.tmpObjetivo.id, objetivo_nombre: s.tmpObjetivo.nombre, bateas: Math.round(v),
    });
    s.tmpObjetivo = null;
    s.paso = 'paradas_objetivo';
    return `👍 Anotado: ${Math.round(v)} en ${s.datos.paradas[s.datos.paradas.length - 1].objetivo_nombre}.\n\n` +
      `¿*Otro objetivo*? Decime el nombre, o *listo* si terminaste.`;
  }

  // 4) Confirmación final
  if (s.paso === 'confirmar') {
    if (CONFIRMA.includes(bajo)) {
      const ok = await guardarViaje(s.datos);
      delete sesiones[tel];
      return ok
        ? `✅ Guardado, ${nombre}. ${s.datos.km.toLocaleString('es-AR')} km · ${totalBateas(s.datos)} bateas · ${s.datos.paradas.length} punto(s). ¡Gracias!`
        : `⚠️ No pude guardar. Avisá a administración.`;
    }
    if (CANCELA.includes(bajo)) { delete sesiones[tel]; return `👍 Cancelado, no se guardó.`; }
    // Si escribe otro objetivo en la confirmación, lo agregamos
    s.paso = 'paradas_objetivo';
    return continuarViajes(telefono, mensaje);
  }

  return `No entendí. Escribí *cancelar* para empezar de nuevo.`;
}

function totalBateas(d) { return d.paradas.reduce((s, p) => s + p.bateas, 0); }

function cerrarResumen(s) {
  s.paso = 'confirmar';
  const d = s.datos;
  return `📋 *Resumen del día*\n\n` +
    `🚛 ${d.chofer.nombre}\n` +
    `📏 ${d.km.toLocaleString('es-AR')} km (${d.odometro_inicio.toLocaleString('es-AR')} → ${d.odometro_fin.toLocaleString('es-AR')})\n` +
    `📦 ${totalBateas(d)} bateas · ${d.paradas.length} punto(s) de bajada\n\n` +
    `${resumenParadas(d.paradas)}\n\n` +
    `¿Confirmás? (*sí* / *cancelar*)`;
}

async function guardarViaje(d) {
  try {
    const { error } = await supabase.from('viajes_bateas').insert({
      chofer_id: d.chofer.id,
      unidad_id: d.chofer.unidad_id || null,
      patente_raw: d.chofer.unidades ? d.chofer.unidades.patente : null,
      fecha: new Date().toISOString().slice(0, 10),
      odometro_inicio: d.odometro_inicio,
      odometro_fin: d.odometro_fin,
      km: d.km,
      paradas: d.paradas,
      total_bateas: totalBateas(d),
      puntos_bajada: d.paradas.length,
    });
    if (error) throw error;
    console.log(`[viajes] ${d.chofer.nombre}: ${d.km}km, ${totalBateas(d)} bateas, ${d.paradas.length} puntos`);
    return true;
  } catch (e) { console.error('guardarViaje:', e); return false; }
}

module.exports = { iniciarViajes, continuarViajes, tieneSesionViajes };
