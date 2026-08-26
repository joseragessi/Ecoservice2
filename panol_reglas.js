// Reglas de coherencia del pañol, compartidas por el panel y la app.
//
// Por qué existe esto: un ítem que NO es retornable se descuenta del stock en
// cada salida y el movimiento nace cerrado como "consumido". Eso está bien
// para un filtro y es un desastre para una máquina, que desaparece del pañol
// sin dejar rastro. Pasó dos veces en agosto de 2026:
//   · "Motosierra T435" cargada como herramienta pero NO retornable → 4 al aire
//   · "M 250" (una Stihl MS 250) cargada como repuesto consumible → 3 al aire
// El segundo caso no lo frenaba la validación de categoría, porque la
// categoría también estaba mal. Lo único que quedaba era el nombre.

// Palabras que indican MÁQUINA. Van sin acento y en minúscula: el nombre se
// normaliza antes de comparar.
const MAQUINAS = [
  'motosierra', 'motoguadana', 'guadana', 'desmalezadora', 'bordeadora',
  'sopladora', 'hidrolavadora', 'cortadora', 'pertiga', 'extensible',
  'fumigadora', 'giro cero', 'minitractor', 'mini tractor', 'tractor',
  'moladora', 'amoladora', 'taladro', 'soldadora', 'generador', 'motobomba',
  'motocultivador', 'zanjadora', 'compactadora', 'hoyadora', 'motoguadaña',
];

// Palabras que indican REPUESTO o INSUMO. Ganan sobre las de arriba: un
// "Filtro giro cero" es un filtro, no un giro cero, y un "Carburador 250" es
// un carburador. Sin esta lista, la regla bloquearía salidas legítimas.
const REPUESTOS = [
  'filtro', 'carburador', 'embrague', 'piston', 'cilindro', 'espada',
  'cadena', 'pinon', 'correa', 'bujia', 'cable', 'puntera', 'carretel',
  'tanza', 'tapa', 'trinquete', 'torreta', 'rodillo', 'polea', 'cuchilla',
  'hoja', 'rueda', 'cubierta', 'camara', 'aceite', 'grasa', 'nafta',
  'combustible', 'silicona', 'tornillo', 'bulon', 'arandela', 'reten',
  'rodamiento', 'ruleman', 'manguera', 'abrazadera', 'resorte', 'buje',
  'kit', 'juego', 'repuesto', 'arranca motor', 'arrancador', 'tope',
  'protector', 'arnes', 'guante', 'bolsa', 'soga', 'linga', 'vaso',
];

const norm = (v) => String(v || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// Modelos sueltos tipo "M 250", "MS 250", "T435", "FS 220": nombre corto que
// es solo una o dos letras y un número. Así estaba cargada la MS 250.
function pareceModeloSuelto(n) {
  return /^[a-z]{1,3}\s*-?\s*\d{2,4}[a-z]?$/.test(n);
}

/**
 * ¿El nombre sugiere que esto es una máquina y no un consumible?
 * Devuelve null si no hay sospecha, o el motivo si la hay.
 */
function motivoSospechaMaquina(nombre) {
  const n = norm(nombre);
  if (!n) return null;
  // Un término de repuesto manda: corta antes de mirar nada más.
  if (REPUESTOS.some(p => n.includes(p))) return null;
  const maq = MAQUINAS.find(p => n.includes(p));
  if (maq) return `el nombre dice "${maq}"`;
  if (pareceModeloSuelto(n)) return 'el nombre parece un modelo de máquina (letra + número)';
  return null;
}

/**
 * Valida la coherencia de un ítem del pañol antes de guardarlo.
 * Devuelve null si está bien, o { error, requiere_confirmacion } si no.
 */
function validarItemPanol(item, confirmado) {
  const categoria = item.categoria || 'herramienta';
  const retornable = !!item.retornable;
  if (retornable) return null;   // lo que vuelve nunca se descuenta: sin riesgo

  // 1. Herramienta que no vuelve: contradicción pura, no se guarda ni con
  //    confirmación. Para algo descartable existe la categoría "otro".
  if (categoria === 'herramienta') {
    return {
      error: 'Una herramienta tiene que volver al pañol. Si no vuelve, se descuenta del stock ' +
        'en cada salida y se pierde del sistema. Para algo que se consume, usá la categoría "insumo" o "otro".',
      requiere_confirmacion: false,
    };
  }

  // 2. El nombre suena a máquina pero está como consumible. Acá sí puede ser
  //    un falso positivo, así que se pide confirmación en vez de bloquear.
  const motivo = motivoSospechaMaquina(item.nombre);
  if (motivo && !confirmado) {
    return {
      error: `"${item.nombre}" está cargado como consumible, pero ${motivo}. ` +
        'Un consumible se descuenta del stock en cada salida y no queda registrado como prestado. ' +
        'Si es una máquina, ponela como herramienta que vuelve al pañol.',
      requiere_confirmacion: true,
    };
  }
  return null;
}

/**
 * Valida una salida del pañol. Más estricto que el alta: acá no hay
 * confirmación posible, porque el que retira no es quien define el maestro.
 */
function validarSalidaPanol(item) {
  if (item.retornable) return null;
  if (item.categoria === 'herramienta') {
    return { error: `"${item.nombre}" está cargada como herramienta pero marcada como que NO vuelve al pañol. ` +
      'Así, esta salida la descontaría del stock y la herramienta se perdería del sistema. ' +
      'Avisale al encargado del pañol para que la corrija en Maestros antes de entregarla.' };
  }
  const motivo = motivoSospechaMaquina(item.nombre);
  if (motivo) {
    return { error: `"${item.nombre}" figura como consumible, pero ${motivo}. ` +
      'Si sale así, se descuenta del stock y no queda registrada como prestada. ' +
      'Avisale al encargado del pañol para que la corrija en Maestros antes de entregarla.' };
  }
  return null;
}

module.exports = { motivoSospechaMaquina, validarItemPanol, validarSalidaPanol };
