// Smoke-tests de los parsers críticos del bot.
//
// Correr con:  node tests.js
// Sale con código 1 si algo falla — para frenar antes de deployar.
// Cubre lógica pura (sin base de datos ni IA): prioridad de incidencias,
// matcheo aproximado de patentes y normalizadores.

const { calcularPrioridad } = require('./prioridad');
const { distanciaEdicion, normalizarPatente, numNorm } = require('./combustible');

let ok = 0, mal = 0;
function t(nombre, real, esperado) {
  const pasa = JSON.stringify(real) === JSON.stringify(esperado);
  if (pasa) { ok++; }
  else { mal++; console.error(`✗ ${nombre}\n    esperado: ${JSON.stringify(esperado)}\n    real:     ${JSON.stringify(real)}`); }
}

// ── Prioridad de incidencias (reglas acordadas con datos reales) ──
t('unidad frenos = critico',            calcularPrioridad('unidad', 'frenos (pastillas, discos)', false), 'critico');
t('motoguadaña piola = baja',           calcularPrioridad('motoguadana', 'piola o soga cortada', false), 'baja');
t('motoguadaña service = baja',         calcularPrioridad('motoguadana', 'service / mantenimiento', false), 'baja');
t('motoguadaña no arranca = alta',      calcularPrioridad('motoguadana', 'no arranca o cuesta arrancar', false), 'alta');
t('maquina hidraulica = critico',       calcularPrioridad('maquina', 'perdida hidraulica', false), 'critico');
t('maquina correa = baja',              calcularPrioridad('maquina', 'correa cortada', false), 'baja');
t('carro otro = baja (piso carro)',     calcularPrioridad('carro', 'otro', false), 'baja');
t('unidad otro = alta (piso unidad)',   calcularPrioridad('unidad', 'otro', false), 'alta');
t('equipo parado fuerza >= alta',       ['critico', 'alta'].includes(calcularPrioridad('motoguadana', 'bujia', true)), true);
t('falla desconocida usa piso tipo',    calcularPrioridad('motosierra', 'falla inventada xyz', false), 'media');

// ── Patente: matcheo aproximado contra flota (casos reales del 30-jul) ──
t('OCR HJ1248 → HAI248 dista 2',        distanciaEdicion('HJ1248', 'HAI248'), 2);
t('OCR WMI248 → HAI248 dista 2',        distanciaEdicion('WMI248', 'HAI248'), 2);
t('patentes distintas quedan lejos',    distanciaEdicion('HAI248', 'AB123CD') > 2, true);
t('idénticas distan 0',                 distanciaEdicion('HAI248', 'HAI248'), 0);
t('un caracter dista 1',                distanciaEdicion('HAI248', 'HAI249'), 1);
t('largo muy distinto corta rápido',    distanciaEdicion('AB1', 'ABCDEF12') > 2, true);

// ── Normalizadores ──
t('normalizarPatente saca símbolos',    normalizarPatente('ah-182 lv'), 'AH182LV');
t('normalizarPatente null',             normalizarPatente(null), null);
t('numNorm saca ceros iniciales',       numNorm('0033-00000316'), '3300000316');
t('numNorm solo dígitos',               numNorm('N° 00003443'), '3443');
t('numNorm vacío = null',               numNorm(''), null);

// ── Resultado ──
console.log(`\n${ok} ok · ${mal} fallando`);
process.exit(mal ? 1 : 0);
