const supabase = require('./supabase');

async function asignarMecanico(tipoFalla, tipoEquipo) {

  // Si la falla es eléctrica → Diego Allende (electrico) siempre
  const esElectrica = tipoFalla && tipoFalla.toLowerCase().includes('eléctr') || 
                      tipoFalla && tipoFalla.toLowerCase().includes('electr');

  // Equipos que van a Santiago (motor 2T / cortadora)
  const EQUIPOS_SANTIAGO = ['motoguadana', 'motosierra'];

  let habPrincipal;

  if (esElectrica) {
    // Eléctrica → Diego
    habPrincipal = 'electrico';
  } else if (EQUIPOS_SANTIAGO.includes(tipoEquipo)) {
    // Motoguadaña, Motosierra, Extensible, Sopladora → Santiago
    habPrincipal = 'cortadora';
  } else {
    // Todo lo demás por tipo de falla
    const MAPA = {
      hidraulica:  'hidraulica',
      neumatico:   'neumatico',
      neumatica:   'neumatico',
      motor_4t:    'motor_4t',
      mecanica:    'motor_4t',
      unidad:      'motor_4t',
      maquina:     'motor_4t',
      carro:       'motor_4t',
      general:     'motor_4t',
      otro:        'motor_4t',
    };
    habPrincipal = MAPA[tipoEquipo] || MAPA[tipoFalla] || 'motor_4t';
  }

  const { data: mecanicos, error } = await supabase
    .from('mecanicos')
    .select('id, nombre, habilidades')
    .eq('activo', true);

  if (error || !mecanicos?.length) return null;

  const scored = mecanicos.map(m => {
    const habs = m.habilidades || [];
    const tienePrincipal = habs.includes(habPrincipal);
    const score = (tienePrincipal ? 100 : 0) + habs.length;
    return { ...m, score, tienePrincipal };
  });

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
