const supabase           = require('./supabase');
const { asignarMecanico } = require('./mecanico');

const sesiones = {};
const TIMEOUT_MS = 10 * 60 * 1000;

const TIPOS_EQUIPO = [
  { label: 'Motoguadaña',  tipo: 'motoguadana' },
  { label: 'Motosierra',   tipo: 'motosierra'  },
  { label: 'Extensible',   tipo: 'maquina'     },
  { label: 'Mini tractor', tipo: 'maquina'     },
  { label: 'Giro cero',    tipo: 'maquina'     },
  { label: 'Plana',        tipo: 'maquina'     },
  { label: 'Toyota',       tipo: 'unidad'      },
  { label: 'Hidro grúa',   tipo: 'maquina'     },
  { label: 'Otro',         tipo: 'general'     },
];

function limpiarSesion(tel) { delete sesiones[tel]; }

function resetTimeout(tel) {
  const s = sesiones[tel];
  if (!s) return;
  clearTimeout(s._timer);
  s._timer = setTimeout(() => limpiarSesion(tel), TIMEOUT_MS);
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

    sesiones[tel] = {
      paso:          1,
      capatazId:     capataz.id,
      objetivoId:    capataz.objetivo_id,
      capatazNombre: capataz.nombre,
      tipoLabel:     null,
      tipoDb:        null,
      tipoFalla:     null,
      numeroUnidad:  null,
      prioridad:     null,
      equipoParado:  null,
      _timer:        null,
    };
    resetTimeout(tel);

    const lista = TIPOS_EQUIPO.map((t, i) => `  ${i + 1}. ${t.label}`).join('\n');
    return `👋 Hola *${capataz.nombre}*. Registremos la incidencia.\n\n*¿Qué equipo presenta la falla?*\nRespondé con el número:\n\n${lista}`;
  }

  const s = sesiones[tel];
  resetTimeout(tel);

  // P1: tipo de equipo
  if (s.paso === 1) {
    const num = parseInt(texto);
    if (isNaN(num) || num < 1 || num > TIPOS_EQUIPO.length) {
      return `Por favor respondé con un número del 1 al ${TIPOS_EQUIPO.length}.`;
    }
    s.tipoLabel = TIPOS_EQUIPO[num - 1].label;
    s.tipoDb    = TIPOS_EQUIPO[num - 1].tipo;
    s.paso = 2;
    return `✅ *${s.tipoLabel}*\n\n*¿Cuál es el número o código de la unidad?*\nEjemplo: MG-045, U30, 12, G01`;
  }

  // P2: número de unidad
  if (s.paso === 2) {
    s.numeroUnidad = texto;
    s.paso = 3;
    return `✅ *Unidad: ${s.numeroUnidad}*\n\n*¿De qué tipo es la falla?*\n\n  1. 🔧 Mecánica (motor, transmisión, frenos)\n  2. ⚡ Eléctrica (batería, luces, arranque)\n  3. 💧 Hidráulica (dirección, cilindros)\n  4. 🔄 Neumática (cubiertas, suspensión)\n  5. 🪚 Maquinaria liviana (carburador, filtro, cuchilla, cadena, bujía)\n  6. 🤷 No sé / otro`;
  }

  // P3: tipo de falla
  if (s.paso === 3) {
    const op = texto.trim();
    if (!['1','2','3','4','5','6'].includes(op)) {
      return 'Respondé con un número del 1 al 6.';
    }
    const fallaMap = { '1': 'mecanica', '2': 'electrica', '3': 'hidraulica', '4': 'neumatica', '5': 'liviana', '6': 'otro' };
    const fallaDb  = { '1': 'motor_4t', '2': 'electrico', '3': 'hidraulica', '4': 'neumatico', '5': 'motor_2t', '6': 'general' };
    s.tipoFalla = fallaMap[op];
    s.tipoDb    = fallaDb[op];
    s.paso = 4;
    return `*¿Cuál es el estado del equipo?*\n\n  1. 🔴 Está parado, no puede trabajar\n  2. 🟠 Puede trabajar pero necesita reparación mañana\n  3. ⚪ Puede esperar unos días para reparar\n  4. 🟢 Mantenimiento programado`;
  }

  // P4: prioridad
  if (s.paso === 4) {
    const op = texto.trim();
    if (!['1','2','3','4'].includes(op)) {
      return 'Respondé con 1, 2, 3 o 4 según el estado del equipo.';
    }
    const mapa = { '1': 'critico', '2': 'alta', '3': 'media', '4': 'baja' };
    s.prioridad    = mapa[op];
    s.equipoParado = op === '1';
    s.paso = 5;
    return `*¿Cuál es la falla o síntoma que presenta el equipo?*\nDescribilo con el mayor detalle posible.`;
  }

  // P5: descripción + crear incidencia
  if (s.paso === 5) {
    if (texto.length < 5) {
      return 'Por favor describí la falla con un poco más de detalle.';
    }

    const mecanicoId = await asignarMecanico(s.tipoFalla, s.tipoDb);

    const { data: equipos } = await supabase
      .from('equipos')
      .select('id')
      .eq('objetivo_id', s.objetivoId)
      .eq('nombre', s.tipoLabel)
      .limit(1);

    let equipoId = equipos?.[0]?.id;
    if (!equipoId) {
      const { data: fallback } = await supabase
        .from('equipos')
        .select('id')
        .eq('objetivo_id', s.objetivoId)
        .limit(1);
      equipoId = fallback?.[0]?.id;
    }

    if (!equipoId) {
      limpiarSesion(tel);
      return '⚠️ No hay equipos registrados para tu objetivo. Contactá a administración.';
    }

    const { data: incidencia, error } = await supabase
      .from('incidencias')
      .insert({
        capataz_id:    s.capatazId,
        objetivo_id:   s.objetivoId,
        equipo_id:     equipoId,
        mecanico_id:   mecanicoId,
        prioridad:     s.prioridad,
        estado:        'pendiente',
        equipo_parado: s.equipoParado,
        descripcion:   texto,
        numero_unidad: s.numeroUnidad,
        tipo_equipo:   s.tipoLabel,
        tipo_falla:    s.tipoFalla,
      })
      .select('id')
      .single();

    limpiarSesion(tel);

    if (error || !incidencia) {
      console.error('Error creando incidencia:', error);
      return '⚠️ Ocurrió un error al registrar la incidencia. Intentá de nuevo en un momento.';
    }

    const iconos    = { critico: '🔴', alta: '🟠', media: '⚪', baja: '🟢' };
    const etiquetas = { critico: 'CRÍTICO', alta: 'ALTA', media: 'MEDIA', baja: 'BAJA' };

    return `${iconos[s.prioridad]} *Incidencia registrada*\n\n` +
           `🔧 Equipo: ${s.tipoLabel}\n` +
           `🔢 Unidad: ${s.numeroUnidad}\n` +
           `🔩 Falla: ${s.tipoFalla}\n` +
           `⚡ Prioridad: *${etiquetas[s.prioridad]}*\n` +
           `📊 Estado: Pendiente\n` +
           `👨‍🔧 Asignado a mecánico\n\n` +
           `ID: \`${incidencia.id.slice(0, 8).toUpperCase()}\`\n\n` +
           `El equipo de taller fue notificado. ✅`;
  }

  return 'No entendí tu respuesta. Enviá cualquier mensaje para empezar de nuevo.';
}

module.exports = { procesarMensaje };
