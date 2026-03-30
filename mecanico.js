const supabase = require('./supabase');

/**
 * Asigna el mecánico más adecuado según el tipo de falla.
 * La habilidad específica de la falla tiene peso FIJO alto (100 puntos)
 * para garantizar que el especialista siempre gane sobre generalistas.
 * El desempate es por menor carga activa.
 */
async function asignarMecanico(tipoFalla) {

  // Habilidad principal que debe tener el mecánico para este tipo de falla
  const HABILIDAD_PRINCIPAL = {
    electrico:   'electrico',
    hidraulica:  'hidraulica',
    neumatico:   'neumatico',
    motor_2t:    'cortadora',
    motor_4t:    'motor_4t',
    soldadura:   'soldadura',
    giro_cero:   'giro_cero',
    unidades:    'unidades',
    tractores:   'tractores',
    cortadora:   'cortadora',
  liviana:     'cortadora',
    motoguadana: 'cortadora',
    motosierra:  'cortadora',
    maquina:     'motor_4t',
    unidad:      'motor_4t',
    general:     'general',
  };

  const habPrincipal = HABILIDAD_PRINCIPAL[tipoFalla] || 'general';

  const { data: mecanicos, error } = await supabase
    .from('mecanicos')
    .select('id, nombre, habilidades')
    .eq('activo', true);

  if (error || !mecanicos?.length) return null;

  // Score: 100 si tiene la habilidad principal, +1 por cada habilidad extra
  // Esto garantiza que el especialista SIEMPRE gana sobre el generalista
  const scored = mecanicos.map(m => {
    const habs = m.habilidades || [];
    const tienePrincipal = habs.includes(habPrincipal);
    const score = (tienePrincipal ? 100 : 0) + habs.length;
    return { ...m, score, tienePrincipal };
  });

  // Si nadie tiene la habilidad principal, usar todos
  const candidatos = scored.filter(m => m.tienePrincipal).length
    ? scored.filter(m => m.tienePrincipal)
    : scored;

  candidatos.sort((a, b) => b.score - a.score);

  const topScore = candidatos[0].score;
  const top = candidatos.filter(m => m.score === topScore);

  if (top.length === 1) return top[0].id;

  // Desempate por menor carga activa
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
