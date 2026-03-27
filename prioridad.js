/**
 * Determina la prioridad de la incidencia según las respuestas del capataz.
 *
 * @param {boolean} equipoParado  - true si el equipo está completamente parado
 * @param {string}  descripcion   - descripción libre de la falla
 * @returns {'critico'|'alta'|'media'|'baja'}
 */
function calcularPrioridad(equipoParado, descripcion) {
  const desc = descripcion.toLowerCase();

  // Palabras clave que elevan la prioridad
  const keywordsCritico = ['incendio', 'explosión', 'accidente', 'choque', 'no arranca', 'no enciende'];
  const keywordsAlta    = ['humo', 'pérdida de aceite', 'fuga', 'freno', 'dirección', 'no corta', 'recalenta'];

  if (equipoParado) {
    // Parado total → mínimo Crítico, puede bajar a Alta si la descripción es leve
    const esCritico = keywordsCritico.some(k => desc.includes(k));
    return esCritico ? 'critico' : 'critico'; // parado = siempre crítico
  }

  // Equipo operativo pero con falla
  const tieneKeywordAlta    = keywordsAlta.some(k => desc.includes(k));
  const tieneKeywordCritico = keywordsCritico.some(k => desc.includes(k));

  if (tieneKeywordCritico) return 'alta';   // descripción grave pero equipo corre → Alta
  if (tieneKeywordAlta)    return 'alta';
  if (desc.length > 80)    return 'media';  // descripción larga = problema complejo
  return 'baja';
}

module.exports = { calcularPrioridad };
