const supabase           = require('./supabase');
const { asignarMecanico } = require('./mecanico');
const { calcularPrioridad } = require('./prioridad');

const sesiones = {};
const TIMEOUT_MS = 10 * 60 * 1000;

const TIPOS_EQUIPO = [
  { label: 'Motoguadaña',          tipo: 'motoguadana' },
  { label: 'Motosierra',           tipo: 'motosierra'  },
  { label: 'Extensible',           tipo: 'motoguadana' },
  { label: 'Sopladora',            tipo: 'motoguadana' },
  { label: 'Mini tractor / Giro cero', tipo: 'maquina' },
  { label: 'Tractor',              tipo: 'maquina'     },
  { label: 'Plana',                tipo: 'maquina'     },
  { label: 'Toyota / Camioneta',   tipo: 'unidad'      },
  { label: 'Camión / Atego',       tipo: 'unidad'      },
  { label: 'Hidro grúa',           tipo: 'maquina'     },
  { label: 'Carro / Remolque',     tipo: 'carro'       },
  { label: 'Otro',                 tipo: 'general'     },
];

// Fallas específicas por grupo de equipo
const FALLAS_POR_TIPO = {
  motoguadana: [
    'No arranca o cuesta arrancar',
    'No tiene fuerza o no modera',
    'Se calienta y se apaga',
    'Piola o soga cortada',
    'Cable del acelerador',
    'Carburación o regulación',
    'Bujía',
    'Embrague o trinquete',
    'Pistón o motor roto',
    'Escape roto',
    'Tanque pinchado',
    'Service / mantenimiento',
    'Otro',
  ],
  maquina: [
    'No arranca',
    'Correa cortada',
    'Cuchillas — cambio o desgaste',
    'Enganche roto',
    'Escape cortado',
    'Pérdida hidráulica',
    'Patín roto',
    'Service / mantenimiento',
    'Otro',
  ],
  unidad: [
    'Batería agotada',
    'Cambio de cubiertas',
    'Frenos (pastillas, discos)',
    'Service (filtros, aceite)',
    'Eléctrico / alternador / luces',
    'Hidráulico (dirección, pérdida)',
    'Embrague',
    'Otro',
  ],
  hidrogua: [
    'Pérdida hidráulica (toma de fuerza, mangueras)',
    'No levanta / sin fuerza',
    'Problema eléctrico',
    'Service / mantenimiento',
    'Otro',
  ],
  carro: [
    'Compuerta rota',
    'Llanta / cubierta',
    'Luces / cable eléctrico',
    'Enganche / bulones',
    'Soldadura / estructura',
    'Otro',
  ],
  motosierra: null,
  general: ['Otro'],
};

FALLAS_POR_TIPO.motosierra = FALLAS_POR_TIPO.motoguadana;

// Mapa tipo de equipo → grupo de fallas
function getFallasGrupo(tipoLabel, tipoDb) {
  if (tipoLabel === 'Hidro grúa') return FALLAS_POR_TIPO.hidrogua;
  if (tipoLabel === 'Carro / Remolque') return FALLAS_POR_TIPO.carro;
  return FALLAS_POR_TIPO[tipoDb] || FALLAS_POR_TIPO.general;
}

// Equipos que van a Santiago (motor 2T)
const EQUIPOS_SANTIAGO = ['motoguadana', 'motosierra'];

function limpiarSesion(tel) { delete sesiones[tel]; }

function resetTimeout(tel) {
  const s = sesiones[tel];
  if (!s) return;
  clearTimeout(s._timer);
  s._timer = setTimeout(() => limpiarSesion(tel), TIMEOUT_MS);
}

// Arranca el flujo de incidencia (menú de equipos). Reutilizable desde el menú principal.
function iniciarIncidencia(tel, capataz) {
  sesiones[tel] = {
    paso:          1,
    capatazId:     capataz.id,
    objetivoId:    capataz.objetivo_id,
    capatazNombre: capataz.nombre,
    tipoLabel:     null,
    tipoDb:        null,
    tipoFalla:     null,
    fallaLabel:    null,
    numeroUnidad:  null,
    prioridad:     null,
    equipoParado:  null,
    _timer:        null,
  };
  resetTimeout(tel);
  const lista = TIPOS_EQUIPO.map((t, i) => `  ${i + 1}. ${t.label}`).join('\n');
  return `🔧 Registremos la incidencia.\n\n*¿Qué equipo presenta la falla?*\nRespondé con el número:\n\n${lista}`;
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

    // Menú principal: el capataz elige qué hacer.
    sesiones[tel] = {
      paso:          'menu',
      capatazId:     capataz.id,
      objetivoId:    capataz.objetivo_id,
      capatazNombre: capataz.nombre,
      _capataz:      capataz,
      _timer:        null,
    };
    resetTimeout(tel);
    return `👋 Hola *${capataz.nombre}*. ¿Qué necesitás?\nRespondé con el número:\n\n` +
           `  1. ⛽ Cargar combustible\n` +
           `  2. 📦 Pedir insumos\n` +
           `  3. 🔧 Reportar una reparación\n` +
           `  4. 📋 Informar stock de maquinaria`;
  }

  const s = sesiones[tel];
  resetTimeout(tel);

  // Menú principal: derivar según la opción
  if (s.paso === 'menu') {
    const op = texto.trim();
    if (op === '1') {
      limpiarSesion(tel);
      return '⛽ Perfecto. Sacale una *foto* al remito o factura de la carga y mandámela por acá.';
    }
    if (op === '2') {
      limpiarSesion(tel);
      return { __derivar: 'insumos' };  // index.js arranca el flujo de insumos
    }
    if (op === '3') {
      return iniciarIncidencia(tel, s._capataz);
    }
    if (op === '4') {
      limpiarSesion(tel);
      return { __derivar: 'stock' };    // index.js arranca el flujo de stock
    }
    return 'Respondé con *1* (combustible), *2* (insumos), *3* (reparación) o *4* (stock).';
  }

  // P1: tipo de equipo
  if (s.paso === 1) {
    const num = parseInt(texto);
    if (isNaN(num) || num < 1 || num > TIPOS_EQUIPO.length) {
      return `Por favor respondé con un número del 1 al ${TIPOS_EQUIPO.length}.`;
    }
    s.tipoLabel = TIPOS_EQUIPO[num - 1].label;
    s.tipoDb    = TIPOS_EQUIPO[num - 1].tipo;
    s.paso = 2;
    return `✅ *${s.tipoLabel}*\n\n*¿Cuál es el número o código de la unidad?*\nEjemplo: MG-045, U30, T22, 188`;
  }

  // P2: número de unidad
  if (s.paso === 2) {
    s.numeroUnidad = texto;
    s.paso = 3;
    const fallas = getFallasGrupo(s.tipoLabel, s.tipoDb);
    const lista = fallas.map((f, i) => `  ${i + 1}. ${f}`).join('\n');
    return `✅ *Unidad: ${s.numeroUnidad}*\n\n*¿Cuál es la falla?*\n\n${lista}`;
  }

  // P3: tipo de falla específica
  if (s.paso === 3) {
    const fallas = getFallasGrupo(s.tipoLabel, s.tipoDb);
    const num = parseInt(texto);
    if (isNaN(num) || num < 1 || num > fallas.length) {
      return `Por favor respondé con un número del 1 al ${fallas.length}.`;
    }
    s.fallaLabel = fallas[num - 1];
    s.tipoFalla  = s.fallaLabel.toLowerCase();
    s.paso = 4;
    return `*¿La máquina puede trabajar?*\n\n  1. 🔧 Sí, pero necesita reparación\n  2. 🛑 No, está parada`;
  }

  // P4: ¿puede trabajar? → dato objetivo (equipo_parado). La PRIORIDAD la
  // calcula el sistema según la falla + tipo de equipo (el capataz no la elige,
  // así nadie infla la urgencia y no se tapa el taller).
  if (s.paso === 4) {
    const op = texto.trim();
    if (!['1','2'].includes(op)) {
      return 'Respondé con *1* (puede trabajar) o *2* (está parada).';
    }
    s.equipoParado = op === '2';
    s.prioridad    = calcularPrioridad(s.tipoDb, s.fallaLabel, s.equipoParado);
    s.paso = 5;
    return `*¿Querés agregar algún detalle adicional?*\nDescribilo o escribí "listo" para finalizar.`;
  }

  // P5: descripción + crear incidencia
  if (s.paso === 5) {
    const descripcion = texto.toLowerCase() === 'listo' ? s.fallaLabel : `${s.fallaLabel}. ${texto}`;

    // Asignar mecánico según equipo y falla
    const mecanicoId = await asignarMecanico(s.tipoFalla, s.tipoDb);

    // Buscar equipo en la DB
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
        descripcion:   descripcion,
        numero_unidad: s.numeroUnidad,
        tipo_equipo:   s.tipoLabel,
        tipo_falla:    s.fallaLabel,
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
           `🔩 Falla: ${s.fallaLabel}\n` +
           `${s.equipoParado ? '🛑 Estado: Parada\n' : '🔧 Estado: Puede trabajar\n'}` +
           `⚡ Prioridad: *${etiquetas[s.prioridad]}* _(asignada por el sistema)_\n` +
           `📊 Estado: Pendiente\n` +
           `👨‍🔧 Asignado a mecánico\n\n` +
           `ID: \`${incidencia.id.slice(0, 8).toUpperCase()}\`\n\n` +
           `El equipo de taller fue notificado. ✅`;
  }

  return 'No entendí tu respuesta. Enviá cualquier mensaje para empezar de nuevo.';
}

module.exports = { procesarMensaje };
