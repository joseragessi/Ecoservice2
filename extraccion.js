// Extrae los datos de un comprobante de combustible (remito o factura)
// usando la API de Claude con visión. Devuelve un objeto JSON estructurado.

// Extracción = OCR estructurado: Haiku es mucho más rápido que Sonnet y
// igual de preciso acá. Override con ANTHROPIC_MODEL_EXTRACT.
const MODEL = process.env.ANTHROPIC_MODEL_EXTRACT || 'claude-haiku-4-5-20251001';

const PROMPT = `Sos un asistente que extrae datos de comprobantes de carga de combustible
de estaciones de servicio de Argentina. Te paso la foto de un comprobante.
Devolvé SOLO un objeto JSON válido, sin texto antes ni después y sin comillas de markdown.

Primero clasificá el tipo de documento:
- "factura": dice FACTURA A/B/C, TIQUE FACTURA, o tiene desglose de IVA y TOTAL en pesos.
- "remito": dice REMITO, "DOCUMENTO NO VALIDO COMO FACTURA" o "EXIJA SU FACTURA".
  Los remitos NO tienen montos: dejá neto, iva, otros_tributos, total y los precios en null.

Devolvé exactamente esta estructura:
{
  "tipo_doc": "factura" | "remito",
  "proveedor": string,              // razón social del emisor (la estación de servicio)
  "cuit": string,                   // CUIT del emisor, formato XX-XXXXXXXX-X
  "numero": string,                 // N° de factura o de remito
  "fecha": string,                  // ISO YYYY-MM-DD
  "patente": string | null,         // patente del vehículo (VEH / Vehículo / PAT / Patente). Sin espacios.
  "chofer": string | null,
  "neto": number | null,            // solo factura: neto gravado
  "iva": number | null,             // solo factura: IVA (alícuota, típicamente 21%)
  "otros_tributos": number | null,  // solo factura: impuesto interno + CO2 + otros tributos
  "total": number | null,           // solo factura
  "items": [
    {
      "producto": string,           // ej "V-POWER DIESEL", "PUMA SUPER", "BIDON X 5 LTS"
      "es_combustible": boolean,    // false para bidones, urea (AdBlue), agua destilada
      "litros": number | null,
      "precio_unit": number | null,
      "subtotal": number | null
    }
  ]
}

Reglas de números: los importes vienen en formato argentino (miles con punto, decimales con coma).
Convertilos a número con punto decimal. Ejemplos: "147.141,40" -> 147141.40 ; "76,9527" -> 76.9527.

MUY IMPORTANTE — cómo leer los litros en los remitos de surtidor:
- En los remitos, cada línea de producto tiene el formato: LITROS.....(CÓDIGO)NOMBRE_PRODUCTO
  Por ejemplo: "61,6549.....(1)UPOWER DIESEL" significa 61,65 litros (=61.6549) del producto "UPOWER DIESEL".
  Otro ejemplo: "46,0070.....(11001)PUMA SUPER" son 46,00 litros (=46.007) de "PUMA SUPER".
- Los LITROS son SIEMPRE el número que aparece ANTES de los puntos suspensivos y del nombre del producto, con coma decimal.
- El número entre paréntesis "(1)", "(11001)", "(11008)" es el CÓDIGO INTERNO del producto de la estación.
  NUNCA lo uses como litros, precio ni subtotal. Descartalo por completo.
- El nombre del producto es el texto que sigue al paréntesis (ej "UPOWER DIESEL", "PUMA SUPER", "ION PUMA DIESEL").
- Los puntos suspensivos "....." son solo relleno de impresión, no son parte de ningún número.

El chofer suele figurar como "Chofer: APELLIDO NOMBRE". La patente como "Patente: XXXXX".

MUY IMPORTANTE — número de comprobante:
- Si en el cuerpo hay una línea "Remito" seguida de un número con formato punto de venta-número
  (ej: "Remito" / "0033-00000305"), ESE es el número del remito. Transcribilo completo con el guión.
- El "N°" del encabezado (ej: "N° 00003443") es el número interno del tique de la impresora:
  NO lo uses como número de remito ni de factura si existe el número con formato PV-NUMERO.

Proveedor y CUIT:
- "proveedor" es la RAZÓN SOCIAL impresa del emisor (ej: "SERVI SUD SA"), no el logo ni la marca
  comercial grande del encabezado (GNG, Shell, Puma, YPF son marcas, no la razón social).
- "cuit" es el CUIT del EMISOR (el que está junto a la razón social, arriba). El CUIT que aparece
  junto a "Cliente" (ECOSERVICE S.R.L., CUIT 30-70793029-9) es del cliente: NUNCA lo uses.

Patente: transcribila EXACTA, carácter por carácter. Formatos argentinos: AA999AA o AAA999.
Cuidado con letras que se confunden en la impresión térmica: U/V, O/0, I/1, B/8. Si un carácter
no se lee con seguridad, igual transcribí lo que mejor se vea (el sistema la valida contra la flota).
Si un dato no está o no se lee con seguridad, poné null. No inventes valores, pero SÍ leé los litros
del remito siguiendo la regla de arriba: casi siempre están presentes aunque el remito no tenga montos.`;

/**
 * @param {Buffer} imagenBuffer - bytes de la imagen del comprobante
 * @param {string} mediaType    - content-type (ej: "image/jpeg")
 * @returns {Promise<object>} JSON estructurado del comprobante
 */
async function extraerComprobante(imagenBuffer, mediaType) {
  const t0 = Date.now();
  const base64 = imagenBuffer.toString('base64');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text',  text: PROMPT },
        ],
      }],
    }),
  });

  if (!resp.ok) {
    const detalle = await resp.text();
    throw new Error(`API Claude ${resp.status}: ${detalle}`);
  }

  const data = await resp.json();
  console.log(`[remito] extraído en ${((Date.now() - t0) / 1000).toFixed(1)}s (${MODEL})`);
  const texto = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Por si el modelo envuelve el JSON en un bloque markdown, lo limpiamos.
  const limpio = texto.replace(/```json/gi, '').replace(/```/g, '').trim();

  const parsed = JSON.parse(limpio);

  // Red de seguridad para los litros. En los remitos de surtidor el litraje
  // viene como "88,7870". Si la IA devuelve un número imposible (una carga real
  // casi nunca supera ~500 litros), NO lo adivinamos —porque no sabemos cuántos
  // decimales tenía—, lo marcamos como dudoso y el bot le preguntará al capataz.
  (parsed.items || []).forEach(it => {
    const l = Number(it.litros);
    if (isFinite(l) && l > 500) {
      it._litros_dudoso = true;
      it.litros = null;   // fuerza a que el bot pregunte, en vez de guardar basura
    }
  });

  return parsed;
}

// ── Parseo del destino en texto libre ─────────────────────────
// El capataz contesta como habla ("50 a la bobcat y 50 a la unidad, la super
// a bidones para Ayres") y esto lo convierte en repartos estructurados.
const PROMPT_DESTINO = `Sos un asistente de un sistema de control de combustible de una empresa
de espacios verdes de Argentina. Un capataz cargó combustible (te paso los productos del ticket)
y ahora te dice, en lenguaje coloquial, a dónde va cada cosa.

Destinos posibles:
- "unidad": el vehículo del ticket (la camioneta/camión con esa patente).
- "bidon": bidones que se llevan a un objetivo (un predio/cliente donde se trabaja).
- "equipo": una máquina o equipo nombrado (bobcat, tractor, minicargadora, hidro, generador, etc).
  En ese caso poné el nombre en "detalle" tal como lo escribió.

Reglas:
- Si el mensaje da UN solo destino global sin nombrar productos ("todo a la unidad",
  "todo a bidones para X"), asigná TODOS los litros de TODOS los productos a ese destino.
- Si nombra un producto ("el gasoil", "la super"), matchealo con el producto del ticket que
  mejor corresponda (gasoil/diesel ↔ productos DIESEL/GASOIL; super/nafta ↔ SUPER/NAFTA).
- Podés repartir un mismo producto en varios destinos. "la mitad" = dividir en partes iguales.
- NUNCA inventes litros: si asigna cantidades y no se entiende a dónde va el resto de un
  producto, devolvé ok:false con el motivo. Si dice "el resto a X", usalo.
- Si menciona un objetivo (para bidones o equipos), poné el texto tal cual en "objetivo"
  (incluido "mío" / "mi objetivo" si lo dice así). Si no menciona objetivo, null.
- Números argentinos: coma decimal ("61,5" = 61.5).

Devolvé SOLO un JSON válido, sin markdown:
{
  "ok": true | false,
  "motivo": string | null,          // solo si ok es false: qué no se entendió, en una frase
  "repartos": [
    { "item": number,               // índice del producto del ticket (te lo paso yo)
      "litros": number,
      "destino": "unidad" | "bidon" | "equipo",
      "detalle": string | null,     // nombre del equipo si destino es "equipo"
      "objetivo": string | null }   // texto del objetivo si lo mencionó
  ]
}`;

async function parsearDestinoCombustible({ texto, items, patente, objetivo_capataz }) {
  const contexto =
    `Productos del ticket:\n` +
    items.map(it => `  item ${it.i}: ${it.producto} — ${it.litros} litros`).join('\n') +
    `\nPatente de la unidad: ${patente || 'sin patente'}\n` +
    `Objetivo del capataz (por si dice "mío"): ${objetivo_capataz || 'sin objetivo'}\n\n` +
    `El capataz escribió:\n"${texto}"`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT_DESTINO + '\n\n' + contexto }] }],
    }),
  });
  if (!resp.ok) throw new Error(`API Claude ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const salida = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(salida.replace(/```json/gi, '').replace(/```/g, '').trim());
}

module.exports = { extraerComprobante, parsearDestinoCombustible };
