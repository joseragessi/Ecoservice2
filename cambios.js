// Registro de cambios por módulo, en memoria del servidor.
//
// Para qué: el panel necesita enterarse cuando otra persona modifica algo —un
// mecánico desde la compu del taller, alguien desde la app— sin recargar cada
// tanto (eso interrumpe el trabajo) y sin consultar la base cada 20 segundos.
//
// Cómo: cada escritura que termina bien incrementa un contador del módulo que
// tocó. El panel pide /api/cambios (unos 200 bytes, cero consultas a la base)
// y compara con lo que tenía. Si el número no se movió, no hace nada.
//
// Límite conocido: es memoria del proceso. Si Railway reinicia, los contadores
// vuelven a cero; el panel detecta que bajaron y se resincroniza sin avisar.
// Con varias instancias detrás de un balanceador esto no alcanzaría, pero hoy
// corre una sola.

const contadores = {};
let arranque = Date.now();

/** Suma un cambio al módulo. */
function marcar(modulo) {
  if (!modulo) return;
  contadores[modulo] = (contadores[modulo] || 0) + 1;
}

/** Estado actual, para que el panel compare. */
function estado() {
  return { arranque, modulos: { ...contadores } };
}

// Qué módulo toca cada ruta. Incluye las rutas de la app del celular, porque
// un mecánico que cierra una reparación desde el teléfono tiene que hacer que
// el panel de la oficina se entere igual.
function moduloDeRuta(p) {
  if (!p) return null;
  if (p.startsWith('/api/app/panol') || p.startsWith('/api/panol')) return 'stock';
  if (p.startsWith('/api/app/service') || p.startsWith('/api/services')) return 'reparaciones';
  if (p.startsWith('/api/app/incidencia') || p.startsWith('/api/app/referente') ||
      p.startsWith('/api/app/supervisor') || p.startsWith('/api/reparaciones')) return 'reparaciones';
  if (p.startsWith('/api/insumos') || p.startsWith('/api/app/insumos')) return 'insumos';
  if (p.startsWith('/api/combustible')) return 'combustible';
  if (p.startsWith('/api/viajes')) return 'bateas';
  if (p.startsWith('/api/compras')) return 'compras';
  if (p.startsWith('/api/stock') || p.startsWith('/api/censos')) return 'stock';
  if (p.startsWith('/api/movimientos')) return 'movimientos';
  if (p.startsWith('/api/maestros') || p.startsWith('/api/mecanicos') ||
      p.startsWith('/api/objetivos') || p.startsWith('/api/usuarios') ||
      p.startsWith('/api/capataces') || p.startsWith('/api/unidades')) return 'maestros';
  return null;
}

/**
 * Middleware: marca el módulo cuando una escritura termina con 2xx.
 * Se engancha al final de la respuesta, así un 403 o un 500 no cuentan como
 * cambio (si contaran, el panel se recargaría por movimientos que no fueron).
 */
function registrarCambios(req, res, next) {
  const metodo = (req.method || 'GET').toUpperCase();
  if (metodo === 'GET' || metodo === 'HEAD' || metodo === 'OPTIONS') return next();
  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      marcar(moduloDeRuta(req.path));
    }
  });
  next();
}

module.exports = { marcar, estado, moduloDeRuta, registrarCambios };
