const supabase = require('./supabase');

// Mapa: tipo de equipo → habilidades requeridas (en orden de preferencia)
const HABILIDADES_POR_TIPO = {
  motoguadana: ['motor_2t', 'general'],
  motosierra:  ['motor_2t', 'general'],
  unidad:      ['motor_4t', 'electrico', 'general'],
  carro:       ['hidraulica', 'neumatico', 'soldadura', 'general'],
  maquina:     ['motor_4t', 'hidraulica', 'general'],
};

/**
 * Busca el mecánico más adecuado para el tipo de equipo.
 * Prioriza coincidencia de habilidades; si hay empate, elige el que
 * tiene menos incidencias activas (pendiente / en_reparacion).
 *
 * @param {string} tipoEquipo
 * @returns {string|null} uuid del mecánico o null si no hay disponibles
 */
async function asignarMecanico(tipoEquipo) {
  const habilidadesRequeridas = HABILIDADES_POR_TIPO[tipoEquipo] || ['general'];

  // Traer todos los mecánicos activos
  const { data: mecanicos, error } = await supabase
    .from('mecanicos')
    .select('id, nombre, habilidades')
    .eq('activo', true);

  if (error || !mecanicos?.length) return null;

  // Calcular score de cada mecánico
  const scored = mecanicos.map(m => {
    const habs = m.habilidades || [];
    // Suma puntos según posición en la lista de preferencia
    let score = 0;
    habilidadesRequeridas.forEach((hab, idx) => {
      if (habs.includes(hab)) score += (habilidadesRequeridas.length - idx);
    });
    return { ...m, score };
  });

  // Filtrar los que tienen alguna habilidad relevante; si ninguno, usar todos
  const candidatos = scored.filter(m => m.score > 0).length
    ? scored.filter(m => m.score > 0)
    : scored;

  // Ordenar por score desc
  candidatos.sort((a, b) => b.score - a.score);

  // Entre los de mayor score, elegir el que tiene menos incidencias activas
  const topScore = candidatos[0].score;
  const top = candidatos.filter(m => m.score === topScore);

  if (top.length === 1) return top[0].id;

  // Contar incidencias activas por mecánico
  const { data: activas } = await supabase
    .from('incidencias')
    .select('mecanico_id')
    .in('estado', ['pendiente', 'diagnostico', 'esperando_repuestos', 'en_reparacion'])
    .in('mecanico_id', top.map(m => m.id));

  const carga = {};
  top.forEach(m => { carga[m.id] = 0; });
  (activas || []).forEach(i => {
    if (i.mecanico_id) carga[i.mecanico_id] = (carga[i.mecanico_id] || 0) + 1;
  });

  top.sort((a, b) => carga[a.id] - carga[b.id]);
  return top[0].id;
}

module.exports = { asignarMecanico };
