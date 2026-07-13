// Extrae los datos de una factura de compra de un proveedor (foto o PDF)
// usando la API de Claude. Devuelve un objeto JSON estructurado.

// Extracción = OCR estructurado, no razonamiento: Haiku es mucho más rápido
// y con la misma precisión. Override con ANTHROPIC_MODEL_EXTRACT.
const MODEL = process.env.ANTHROPIC_MODEL_EXTRACT || 'claude-haiku-4-5-20251001';

const PROMPT = `Sos un asistente que extrae datos de facturas de compra de proveedores
en Argentina (facturas A, B o C). Te paso una foto o un PDF de la factura.
Devolvé SOLO un objeto JSON válido, sin texto antes ni después y sin comillas de markdown.

Estructura exacta a devolver:
{
  "proveedor": string,              // razón social del EMISOR (el proveedor que vende)
  "cuit": string,                   // CUIT del emisor, formato XX-XXXXXXXX-X
  "tipo_comprobante": string,       // "A", "B" o "C"
  "numero": string,                 // N° de factura completo
  "fecha": string,                  // ISO YYYY-MM-DD
  "vencimiento": string | null,     // fecha de vencimiento de pago, ISO, si figura
  "vendedor": string | null,        // nombre del vendedor si figura
  "cond_venta": string | null,      // condición de venta (contado, cta cte, etc.)
  "items": [
    {
      "codigo": string | null,      // código de artículo
      "descripcion": string,        // descripción del producto/servicio
      "cantidad": number | null,
      "precio_unit": number | null,
      "bonif": number | null,       // % de bonificación de la línea, si hay
      "importe": number | null      // importe de la línea
    }
  ],
  "subtotal": number | null,        // subtotal antes de impuestos
  "bonificacion": number | null,    // monto total de bonificación
  "iva": number | null,             // monto de IVA, si está desglosado
  "otros_tributos": number | null,  // percepciones, IIBB, otros
  "total": number | null,           // TOTAL a pagar
  "cae": string | null              // CAE / CAI si figura
}

IMPORTANTE:
- El EMISOR es el proveedor que factura (arriba, con su CUIT y razón social),
  NO el cliente (ECOSERVICE). No los confundas.
- Los importes vienen en formato argentino (miles con punto, decimales con coma).
  Convertilos a número con punto decimal. Ej: "6.626.244,34" -> 6626244.34.
- Si un dato no está o no se lee con seguridad, poné null. No inventes.`;

/** Arma el bloque de contenido según sea imagen o PDF. */
function bloqueArchivo(buffer, mediaType) {
  const data = buffer.toString('base64');
  if (mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

/**
 * @param {Buffer} buffer    - bytes de la factura (foto o PDF)
 * @param {string} mediaType - "image/jpeg", "image/png" o "application/pdf"
 * @returns {Promise<object>} JSON estructurado de la factura
 */
async function extraerFactura(buffer, mediaType) {
  const t0 = Date.now();
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [ bloqueArchivo(buffer, mediaType), { type: 'text', text: PROMPT } ],
      }],
    }),
  });

  if (!resp.ok) {
    const detalle = await resp.text();
    throw new Error(`API Claude ${resp.status}: ${detalle}`);
  }

  const dataResp = await resp.json();
  console.log(`[factura-bot] extraída en ${((Date.now() - t0) / 1000).toFixed(1)}s (${MODEL})`);
  const texto = (dataResp.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('');
  const limpio = texto.replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(limpio);
}

module.exports = { extraerFactura };
