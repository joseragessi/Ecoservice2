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

module.exports = { extraerComprobante };
