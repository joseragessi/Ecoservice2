/**
 * Prioridad de la incidencia FIJADA POR LA FALLA, no por el capataz.
 *
 * Motivo: si el capataz elige la urgencia, todos marcan "urgente" y se tapa el
 * taller. Acá la prioridad la determina la falla que eligió (de una lista cerrada
 * que controla la empresa) + el tipo de equipo. El capataz no tiene ninguna
 * palanca para inflarla.
 *
 * Reglas clave (definidas con José sobre datos reales del grupo de reparaciones):
 *  - UNIDADES (camioneta/camión) nunca bajan de ALTA: llevan personas y su parada
 *    frena un objetivo entero. Frenos/eléctrico/hidráulico/embrague/batería =
 *    CRÍTICO; service/cubiertas = ALTA.
 *  - CRÍTICO se reserva para lo que para la máquina o es peligroso.
 *  - "Otro" hereda el PISO del tipo de equipo (unidad→alta, carro→baja, resto→media).
 *  - CARRO/REMOLQUE: todo BAJA (sin motor, no frena producción).
 *
 * La prioridad calculada se puede ajustar a mano después desde el panel.
 */

const norm = s => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

// Piso de prioridad por tipo de equipo (para "Otro" y fallbacks).
const PISO_POR_TIPO = {
  unidad:      'alta',
  maquina:     'media',
  motoguadana: 'media',
  motosierra:  'media',
  carro:       'baja',
  general:     'media',
};

const TABLA = {
  motoguadana: {
    'se calienta y se apaga':        'critico',
    'piston o motor roto':           'critico',
    'no arranca o cuesta arrancar':  'alta',
    'embrague o trinquete':          'alta',
    'escape roto':                   'alta',
    'tanque pinchado':               'alta',
    'no tiene fuerza o no modera':   'media',
    'cable del acelerador':          'media',
    'carburacion o regulacion':      'media',
    'bujia':                         'media',
    'piola o soga cortada':          'baja',
    'service / mantenimiento':       'baja',
    'otro':                          'media',
  },
  maquina: {
    'perdida hidraulica':            'critico',
    'perdida hidraulica (toma de fuerza, mangueras)': 'critico',
    'no levanta / sin fuerza':       'alta',
    'problema electrico':            'alta',
    'no arranca':                    'alta',
    'enganche roto':                 'alta',
    'patin roto':                    'alta',
    'escape cortado':                'alta',
    'correa cortada':                'baja',
    'cuchillas — cambio o desgaste': 'baja',
    'cuchillas - cambio o desgaste': 'baja',
    'service / mantenimiento':       'baja',
    'otro':                          'media',
  },
  unidad: {
    'frenos (pastillas, discos)':          'critico',
    'electrico / alternador / luces':      'critico',
    'hidraulico (direccion, perdida)':     'critico',
    'embrague':                            'critico',
    'bateria agotada':                     'critico',
    'service (filtros, aceite)':           'alta',
    'cambio de cubiertas':                 'alta',
    'otro':                                'alta',
  },
  carro: {
    'compuerta rota':          'baja',
    'llanta / cubierta':       'baja',
    'luces / cable electrico': 'baja',
    'enganche / bulones':      'baja',
    'soldadura / estructura':  'baja',
    'otro':                    'baja',
  },
};

const ORDEN = { critico: 3, alta: 2, media: 1, baja: 0 };

/**
 * @param {string} tipoDb   - motoguadana|maquina|unidad|carro|general
 * @param {string} falla    - texto de la falla (de la lista del bot)
 * @param {boolean} [equipoParado] - si true, nunca devuelve menos que 'alta'
 * @returns {'critico'|'alta'|'media'|'baja'}
 */
function calcularPrioridad(tipoDb, falla, equipoParado) {
  const piso = PISO_POR_TIPO[tipoDb] || 'media';
  const tabla = TABLA[tipoDb] || {};
  const match = tabla[norm(falla)];
  // Si la falla está en la tabla, se respeta su valor (incluso si es < piso:
  // ej. "correa cortada" es baja aunque el piso del tipo sea media).
  // Si NO está (falla desconocida), cae al piso del tipo.
  let prio = match || piso;

  // Excepción: UNIDADES nunca bajan de ALTA, ni siquiera con un valor bajo en
  // tabla — llevan personas y su parada frena el objetivo.
  if (tipoDb === 'unidad' && ORDEN[prio] < ORDEN.alta) prio = 'alta';

  // Si el equipo está fisicamente parado, nunca menos que 'alta'.
  if (equipoParado && ORDEN[prio] < ORDEN.alta) prio = 'alta';

  return prio;
}

module.exports = { calcularPrioridad };
