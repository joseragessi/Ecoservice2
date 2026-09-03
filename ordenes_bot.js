// Órdenes de compra por WhatsApp.
//
// Quien compra manda la foto del remito o del presupuesto con una línea:
//   "oc guantes 10 chacras 10 ucc, cascos deposito"
// El OCR lee proveedor, ítems y montos (el mismo extractor de facturas), la
// IA reparte los ítems entre los objetivos que dice la línea, y la orden
// queda creada. Sin formulario: la orden sale de la foto y una frase.
//
// Solo pueden hacerlo los usuarios del panel con el módulo Compras y un
// teléfono cargado (columna usuarios_panel.telefono). Cualquier otro que
// mande "oc" recibe el flujo normal de la foto (combustible).

const supabase = require('./supabase');
const supabaseCompras = require('./supabase_compras');
const { extraerFactura } = require('./facturas');
const ORD = require('./ordenes');
const { crearOrden } = require('./ordenes_db');

const RE_OC = /^\s*(oc|orden)\b[\s:.\-]*/i;
const MODEL = process.env.ANTHROPIC_MODEL_EXTRACT || 'claude-haiku-4-5-20251001';

function esPedidoDeOrden(texto) { return RE_OC.test(String(texto || '')); }

async function usuarioComprasPorTelefono(telefono) {
  const tel = String(telefono || '').replace('whatsapp:', '').replace('+', '');
  if (!tel) return null;
  const { data } = await supabase.from('usuarios_panel')
    .select('id, usuario, nombre, modulos, admin, activo, telefono').eq('activo', true);
  return (data || []).find(u => u.telefono && String(u.telefono).replace(/\D/g, '') === tel
    && (u.admin || (u.modulos || []).includes('compras'))) || null;
}

async function descargar(mediaUrl) {
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const r = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) throw new Error(`No pude descargar la foto (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

// La IA reparte los ítems leídos del comprobante entre los objetivos que
// dice la línea. Devuelve por ítem el objetivo y la cantidad. Se le pasa la
// lista real de centros de costo para que no invente nombres.
async function repartirConIA(items, linea, centros) {
  const prompt = `Sos el asistente de compras de EcoService (Córdoba, Argentina).
Te paso los ítems leídos de un remito o presupuesto y una línea escrita por quien compró,
que dice a qué objetivo (centro de costo) va cada cosa. Tenés que repartir.

ÍTEMS LEÍDOS DEL COMPROBANTE:
${items.map((i, ix) => `${ix}. ${i.descripcion || '?'} · cantidad ${i.cantidad ?? '?'} · $${i.monto_sin_iva ?? '?'}`).join('\n')}

LÍNEA DE QUIEN COMPRÓ: "${linea}"

CENTROS DE COSTO VÁLIDOS (usá EXACTAMENTE uno de estos nombres, tal cual):
${centros.map(c => `- ${c}`).join('\n')}

Reglas:
- Cada ítem va a uno o más objetivos. Si la línea dice "guantes 10 chacras 10 ucc", el ítem
  guantes se parte en dos: 10 a CHACRAS y 10 a UCC. Cada parte es una fila de salida.
- Si la línea nombra un objetivo sin decir ítem ("todo para deposito"), va todo ahí.
- Si un ítem no aparece en la línea, dejalo con objetivo null: NO adivines.
- Matcheá los nombres de la línea con los centros de costo aunque estén abreviados o en
  minúscula ("ucc" = UCC, "chacras" = CHACRAS DE LA VILLA, "muni" = MUNICIPALIDAD DE CORDOBA).
  Si no hay uno claro, objetivo null.
- Respondé SOLO con JSON, sin texto antes ni después:
{"filas":[{"ix":0,"objetivo":"CHACRAS DE LA VILLA","cantidad":10},{"ix":0,"objetivo":"UCC","cantidad":10}],
 "no_entendi":["texto de la línea que no pudiste ubicar, si hay"]}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) throw new Error(`API Claude ${resp.status}`);
  const d = await resp.json();
  const texto = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = JSON.parse(texto.replace(/```json/gi, '').replace(/```/g, '').trim());
  return sanearReparto(parsed, items, centros);
}

// Red de seguridad sobre lo que devuelve la IA: objetivos que no existen se
// vuelven null, índices fuera de rango se descartan, cantidades absurdas se
// recortan a la del ítem.
function sanearReparto(parsed, items, centros) {
  const validos = new Set((centros || []).map(c => ORD.norm(c)));
  const nombreReal = {};
  (centros || []).forEach(c => { nombreReal[ORD.norm(c)] = c; });
  const filas = (parsed && Array.isArray(parsed.filas) ? parsed.filas : [])
    .filter(f => Number.isInteger(f.ix) && f.ix >= 0 && f.ix < items.length)
    .map(f => {
      const n = ORD.norm(f.objetivo);
      const obj = validos.has(n) ? nombreReal[n] : null;
      const cantItem = Number(items[f.ix].cantidad) || 0;
      let cant = Number(f.cantidad) || 0;
      if (cantItem && cant > cantItem) cant = cantItem;
      if (!cant) cant = cantItem || 1;
      return { ix: f.ix, objetivo: obj, cantidad: cant };
    });
  // Ítems que la IA no repartió: van con objetivo null para que se vea.
  const cubiertos = new Set(filas.map(f => f.ix));
  items.forEach((it, ix) => { if (!cubiertos.has(ix)) filas.push({ ix, objetivo: null, cantidad: Number(it.cantidad) || 1 }); });
  return { filas, no_entendi: (parsed && parsed.no_entendi) || [] };
}

function pesos(n) { return '$' + (Number(n) || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 }); }

// Flujo: foto + "oc ...". Devuelve el texto para responder por WhatsApp.
async function procesarOrdenFoto(telefono, mediaUrl, mediaType, linea, deps) {
  const D = Object.assign({ descargar, extraerFactura, repartirConIA, crearOrden }, deps || {});
  const usuario = await usuarioComprasPorTelefono(telefono);
  if (!usuario) return null;   // no es alguien de compras: que siga el flujo normal

  const lineaLimpia = String(linea || '').replace(RE_OC, '').trim();
  const buffer = await D.descargar(mediaUrl);
  const leido = await D.extraerFactura(buffer, mediaType);
  const items = (leido.items || []).filter(i => i.descripcion);
  if (!items.length) {
    return `❌ No pude leer ítems en la foto. Mandala más derecha y con buena luz, o cargá la orden desde el panel.`;
  }

  const { data: ccRows } = await supabase.from('centros_costo').select('nombre').eq('activo', true).order('nombre');
  const centros = (ccRows || []).map(c => c.nombre);

  let reparto;
  if (lineaLimpia) {
    reparto = await D.repartirConIA(items, lineaLimpia, centros);
  } else {
    reparto = { filas: items.map((it, ix) => ({ ix, objetivo: null, cantidad: Number(it.cantidad) || 1 })), no_entendi: [] };
  }

  // Cada fila del reparto es un ítem de la orden (el mismo producto puede ir
  // a dos objetivos: son dos ítems).
  const itemsOrden = reparto.filas.map(f => {
    const it = items[f.ix];
    const unit = Number(it.monto_sin_iva) && Number(it.cantidad) ? Number(it.monto_sin_iva) / Number(it.cantidad) : null;
    return {
      descripcion: it.descripcion, cantidad: f.cantidad, codigo: it.codigo || null,
      precio: unit != null ? Math.round(unit * 100) / 100 : null,
      objetivo: f.objetivo || '', unidad: '', comentario: lineaLimpia ? `Por WhatsApp · ${usuario.nombre || usuario.usuario}` : '',
    };
  });
  const sinObjetivo = itemsOrden.filter(i => !i.objetivo);
  const totalLeido = (Number(leido.total_sin_iva) || 0) + (Number(leido.total_iva) || 0);
  const total = totalLeido || ORD.totalDeItems(itemsOrden);
  const tramo = ORD.tramoDeMonto(total);

  const datos = {
    origen_tipo: 'bot', origen_id: null,
    proveedor: leido.proveedor || null, cuit: leido.cuit || null,
    fecha: leido.fecha_factura || new Date().toISOString().slice(0, 10),
    descripcion: lineaLimpia || `Foto por WhatsApp · ${leido.proveedor || 'proveedor'}`,
    items: itemsOrden, total_estimado: total, tramo,
    sin_cotizacion: true, cotizaciones: [],
    objetivo_pendiente: sinObjetivo.length > 0,
    // Si algún ítem quedó sin objetivo, o el tramo pide más que una foto, la
    // orden nace como borrador para que se complete en el panel.
    estado: (sinObjetivo.length || tramo === 'comparativos') ? 'borrador' : 'abierta',
    creado_via: 'whatsapp', creado_por_usuario: usuario.usuario,
    remito_numero: leido.numero_factura || null,
  };

  const r = await D.crearOrden(datos, usuario.usuario);
  const oc = r.orden;

  const lineas = itemsOrden.map(i => `• ${i.descripcion} ×${i.cantidad} → ${i.objetivo || '❓ sin objetivo'}`);
  let out = `✅ *${oc.numero}* creada · ${oc.proveedor || 'proveedor sin leer'}\n${pesos(total)} · ${ORD.LABEL_TRAMO[tramo]}\n\n${lineas.join('\n')}`;
  if (sinObjetivo.length) out += `\n\n⚠️ ${sinObjetivo.length} ítem${sinObjetivo.length === 1 ? '' : 's'} sin objetivo: la orden quedó en *borrador*. Completala en Compras → Órdenes.`;
  if (reparto.no_entendi && reparto.no_entendi.length) out += `\n\n🤔 No entendí: "${reparto.no_entendi.join('", "')}"`;
  if (tramo === 'comparativos') out += `\n\n📋 Supera ${pesos(ORD.TRAMOS.COMPARATIVOS_DESDE)}: pide comparativos y aprobación. Quedó en borrador.`;
  else if (tramo === 'presupuesto') out += `\n\n📋 Supera ${pesos(ORD.TRAMOS.DIRECTA_HASTA)}: cargá el presupuesto en el panel.`;
  if (r.fraccionamiento && r.fraccionamiento.aviso) {
    out += `\n\n⚠️ *Fraccionamiento*: con ${r.fraccionamiento.ordenes.join(', ')} suma ${pesos(r.fraccionamiento.suma)} al mismo proveedor y objetivo en ${ORD.FRACCIONAMIENTO_DIAS} días. Ese total pide ${ORD.LABEL_TRAMO[r.fraccionamiento.tramo_suma].toLowerCase()}.`;
  }
  return out;
}

module.exports = { esPedidoDeOrden, procesarOrdenFoto, sanearReparto, usuarioComprasPorTelefono, RE_OC };
