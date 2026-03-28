const supabase              = require('./supabase');
const { calcularPrioridad } = require('./prioridad');
const { asignarMecanico }   = require('./mecanico');

const sesiones = {};
const TIMEOUT_MS = 10 * 60 * 1000;

function limpiarSesion(telefono) { delete sesiones[telefono]; }

function resetTimeout(telefono) {
  const s = sesiones[telefono];
  if (!s) return;
  clearTimeout(s._timer);
  s._timer = setTimeout(() => limpiarSesion(telefono), TIMEOUT_MS);
}

async function procesarMensaje(telefono, mensaje) {
  const tel   = telefono.replace('whatsapp:', '').replace('+', '');
  const texto = mensaje.trim();

  if (!sesiones[tel]) {
    const { data: capataz } = await supabase
      .from('capataces')
      .select('id, nombre, objetivo_id')
      .eq('telefono', tel)
      .eq('activo', true)
      .single();

    if (!capataz) {
      return '❌ Tu número no está registrado en el sistema EcoService. Contactá a administración.';
    }

    const { data: equipos } = await supabase
      .from('equipos')
      .select('id, nombre, tipo')
      .eq('objetivo_id', capataz.objetivo_id)
      .eq('activo', true)
      .order('nombre');

    if (!equipos?.length) {
      return '⚠️ No hay equipos registrados para tu objetivo. Contactá a administración.';
    }

    sesiones[tel] = {
      paso: 1,
      capatazId:       capataz.id,
      objetivoId:      capataz.objetivo_id,
      capatazNombre:   capataz.nombre,
      equipos,
      equipoId:        null,
      prioridadDirecta: null,
      equipoParado:    null,
      _timer: null,
    };
    resetTimeout(tel);

    const lista = equipos.map((e, i) => `  ${i + 1}. ${e.nombre}`).join('\n');
    return `👋 Hola *${capataz.nombre}*. Registremos la incidencia.\n\n*¿Qué equipo presenta la falla?*\nRespondé con el número:\n\n${lista}`;
  }

  const s = sesiones[tel];
  resetTimeout(tel);

  if (s.paso === 1) {
    const num = parseInt(texto);
    if (isNaN(num) || num < 1 || num > s.equipos.length) {
      return `Por favor respondé con un número del 1 al ${s.equipos.length}.`;
    }
    s.equipoId     = s.equipos[num - 1].id;
    s.equipoNombre = s.equipos[num - 1].nombre;
    s.equipoTipo   = s.equipos[num - 1].tipo;
    s.paso = 2;

    return `✅ *${s.equipoNombre}*\n\n*¿Cuál es el estado del equipo?*\n\n  1. 🔴 Parado total (Crítico)\n  2. 🟠 Operativo con falla importante (Alta)\n  3. 🟡 Operativo con falla menor (Media)\n  4. 🟢 Mantenimiento preventivo (Baja)`;
  }

  if (s.paso === 2) {
    const op = texto.trim();
    if (!['1','2','3','4'].includes(op)) {
      return 'Respondé con 1, 2, 3 o 4 según el estado del equipo.';
    }
    const prioridadMap = { '1': 'critico', '2': 'alta', '3': 'media', '4': 'baja' };
    s.prioridadDirecta = prioridadMap[op];
    s.equipoParado     = op === '1';
    s.paso = 3;
    return `*¿Cuál es la falla o síntoma que presenta el equipo?*\nDescribilo con el mayor detalle posible.`;
  }

  if (s.paso === 3) {
    if (texto.length < 5) {
      return 'Por favor describí la falla con un poco más de detalle.';
    }

    const prioridad  = s.prioridadDirecta;
    const mecanicoId = await asignarMecanico(s.equipoTipo);

    const { data: incidencia, error } = await supabase
      .from('incidencias')
      .insert({
        capataz_id:    s.capatazId,
        objetivo_id:   s.objetivoId,
        equipo_id:     s.equipoId,
        mecanico_id:   mecanicoId,
        prioridad,
        estado:        'pendiente',
        equipo_parado: s.equipoParado,
        descripcion:   texto,
      })
      .select('id')
      .single();

    limpiarSesion(tel);

    if (error || !incidencia) {
      console.error('Error creando incidencia:', error);
      return '⚠️ Ocurrió un error al registrar la incidencia. Intentá de nuevo en un momento.';
    }

    const iconos    = { critico: '🔴', alta: '🟠', media: '🟡', baja: '🟢' };
    const etiquetas = { critico: 'CRÍTICO', alta: 'ALTA', media: 'MEDIA', baja: 'BAJA' };

    return `${iconos[prioridad]} *Incidencia registrada*\n\n📋 Equipo: ${s.equipoNombre}\n⚡ Prioridad: *${etiquetas[prioridad]}*\n📊 Estado: Pendiente\n🔧 Asignado a mecánico\n\nID: \`${incidencia.id.slice(0, 8).toUpperCase()}\`\n\nEl equipo de taller fue notificado. ✅`;
  }

  return 'No entendí tu respuesta. Enviá cualquier mensaje para empezar de nuevo.';
}

module.exports = { procesarMensaje };
