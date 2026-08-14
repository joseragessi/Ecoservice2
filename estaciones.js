// ── Estaciones de servicio (red Edenred) ────────────────────────────────────
// El capataz comparte su ubicación por WhatsApp y el bot le devuelve las
// estaciones más cercanas donde puede pagar con la tarjeta.
//
// Los datos salen del export oficial de Edenred (tabla estaciones_servicio).
// Las que vinieron con coordenadas de otra provincia quedaron con
// coord_ok = false y NO entran en la búsqueda por cercanía: aparecen solo
// cuando se busca por localidad escrita a mano.

const supabase = require('./supabase');
const ses = require('./sesion');

const sesiones = {};
const CANCELACIONES = ['cancelar', 'cancela', 'no', 'nada', 'dejalo', 'olvidalo'];
const SALIDAS = ['menu', 'menú', 'salir', 'volver', 'atras', 'atrás', 'chau', 'cancelar', 'cancela'];

const CUANTAS = 3;          // cuántas estaciones se devuelven
const RADIO_KM = 60;        // más lejos que esto no tiene sentido ofrecer

// Distancia en km entre dos puntos (haversine). Alcanza y sobra para
// ordenar estaciones a pocos kilómetros.
function distanciaKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normTxt(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function limpiarTel(t) {
  return String(t || '').replace('whatsapp:', '').replace('+', '');
}

function iniciarEstaciones(telefono, capataz) {
  const tel = limpiarTel(telefono);
  sesiones[tel] = { paso: 'esperando_ubicacion', capataz };
  const nombre = capataz && capataz.nombre ? capataz.nombre.split(' ')[0] : '';
  return `⛽ *Estaciones de servicio*\n\n` +
         `Dale${nombre ? ' ' + nombre : ''}, mandame tu *ubicación* y te digo las estaciones de la red más cercanas.\n\n` +
         `📎 Tocá el clip → *Ubicación* → _Enviar mi ubicación actual_.\n\n` +
         `Si preferís, escribime el nombre de la localidad (ej: _Villa Carlos Paz_).`;
}

// Mismo patrón que tieneSesionActiva() de stock.js: memoria primero, y si el
// proceso arrancó de cero se restaura la sesión persistida.
async function tieneSesionEstaciones(telefono) {
  const tel = limpiarTel(telefono);
  if (sesiones[tel]) return true;
  const rec = await ses.restaurar('estaciones', tel);
  if (rec) { sesiones[tel] = rec; return true; }
  return false;
}

// Arma el mensaje de una estación con su link para ir.
function ficha(e, dist) {
  const extras = [];
  if (e.gnc) extras.push('GNC');
  if (e.lubricantes) extras.push('lubricantes');
  if (e.electrico) extras.push('carga eléctrica');
  const marca = String(e.marca || '').replace('BANDERAS_BLANCAS', 'Bandera blanca');
  return `*${e.nombre}* · ${marca}\n` +
         `📍 ${e.direccion || ''}${e.localidad ? ', ' + e.localidad : ''}\n` +
         (dist != null ? `📏 a ${dist < 1 ? Math.round(dist * 1000) + ' m' : dist.toFixed(1) + ' km'}\n` : '') +
         (extras.length ? `🔧 ${extras.join(' · ')}\n` : '') +
         `🗺 https://www.google.com/maps/dir/?api=1&destination=${e.lat},${e.lng}`;
}

async function porCercania(lat, lng) {
  // Se traen solo las de coordenada confiable y se ordena en memoria: son
  // ~120 filas, no vale la pena una extensión geoespacial para esto.
  const { data, error } = await supabase.from('estaciones_servicio')
    .select('*').eq('activa', true).eq('coord_ok', true);
  if (error) throw error;
  return (data || [])
    .map(e => ({ e, d: distanciaKm(lat, lng, e.lat, e.lng) }))
    .filter(x => x.d <= RADIO_KM)
    .sort((a, b) => a.d - b.d)
    .slice(0, CUANTAS);
}

async function porLocalidad(texto) {
  const q = normTxt(texto);
  if (q.length < 3) return [];
  const { data, error } = await supabase.from('estaciones_servicio')
    .select('*').eq('activa', true);
  if (error) throw error;
  return (data || [])
    .filter(e => normTxt(e.localidad).includes(q) || q.includes(normTxt(e.localidad)))
    .slice(0, CUANTAS)
    .map(e => ({ e, d: null }));
}

// Entrada principal. `ubicacion` llega cuando el capataz comparte ubicación
// por WhatsApp (Twilio manda Latitude/Longitude en el webhook).
async function continuarEstaciones(telefono, mensaje, ubicacion) {
  const tel = limpiarTel(telefono);
  const sesion = sesiones[tel];
  if (!sesion) return null;

  const texto = String(mensaje || '').trim();
  const t = texto.toLowerCase();

  if (SALIDAS.includes(t) || CANCELACIONES.includes(t)) {
    delete sesiones[tel];
    return { __derivar: 'menu' };
  }

  try {
    let encontradas = [], porDonde = '';
    if (ubicacion && ubicacion.lat != null && ubicacion.lng != null) {
      encontradas = await porCercania(Number(ubicacion.lat), Number(ubicacion.lng));
      porDonde = 'cerca tuyo';
    } else if (texto) {
      encontradas = await porLocalidad(texto);
      porDonde = `en ${texto}`;
    } else {
      return 'Mandame tu *ubicación* con el clip 📎, o escribime el nombre de la localidad.';
    }

    delete sesiones[tel];

    if (!encontradas.length) {
      return ubicacion
        ? `😕 No encontré estaciones de la red a menos de ${RADIO_KM} km tuyo.\n\n` +
          `Probá escribiendo el nombre de una localidad, o consultá el mapa completo: https://edenred.com.ar/estaciones/`
        : `😕 No encontré estaciones en "${texto}".\n\n` +
          `Fijate que esté bien escrito, o mandame tu *ubicación* con el clip 📎.`;
    }

    const titulo = encontradas.length === 1
      ? `⛽ Encontré esta estación ${porDonde}:`
      : `⛽ Las ${encontradas.length} estaciones más cercanas ${porDonde}:`;
    return `${titulo}\n\n` + encontradas.map(x => ficha(x.e, x.d)).join('\n\n') +
           `\n\n_Escribí *menu* para volver._`;
  } catch (err) {
    console.error('[estaciones] error:', err);
    delete sesiones[tel];
    return '⚠️ No pude buscar las estaciones ahora. Probá de nuevo en un rato.';
  }
}

module.exports = {
  iniciarEstaciones: ses.conPersistencia('estaciones', sesiones, iniciarEstaciones),
  continuarEstaciones: ses.conPersistencia('estaciones', sesiones, continuarEstaciones),
  tieneSesionEstaciones,
  distanciaKm,
};
