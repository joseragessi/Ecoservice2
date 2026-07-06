// Interpreta pedidos de insumos de capataces (texto libre e informal)
// usando la API de Claude. Sirve tanto para la interpretación inicial
// como para aplicar ajustes ("agregá alambre", "sacá la nafta").

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

/**
 * @param {string} texto          - lo que escribió el capataz
 * @param {object|null} estadoActual - { objetivo, items } si ya hay un pedido en curso; null si es nuevo
 * @returns {Promise<{objetivo: string|null, items: Array<{item:string, cantidad:string|null}>}>}
 */
async function interpretarInsumos(texto, estadoActual = null) {
  const contextoEstado = estadoActual
    ? `El capataz ya tiene este pedido en curso:
${JSON.stringify(estadoActual, null, 2)}

Ahora dice: "${texto}"

Actualizá el pedido según lo que pide: puede AGREGAR ítems, QUITAR ítems,
cambiar cantidades, o cambiar el objetivo. Devolvé el pedido COMPLETO y actualizado.`
    : `El capataz escribió este pedido de insumos:
"${texto}"

Interpretalo y extraé el objetivo (obra/lugar) si lo menciona, y la lista de ítems.`;

  const prompt = `Sos un asistente que interpreta pedidos de insumos y materiales de
capataces de EcoService, escritos en texto libre e informal por WhatsApp.

${contextoEstado}

Devolvé SOLO un objeto JSON válido, sin texto antes ni después y sin comillas de markdown:
{
  "objetivo": string | null,   // obra, lugar o cuadrilla (ej "Casonas del Sur"); null si no lo dice
  "items": [
    { "item": string, "cantidad": string | null }   // cantidad tal como la dijo: "10 lts", "2 bolsas", null si no aclaró
  ]
}

Reglas:
- Separá cantidad de la descripción: "10 lts de pintura latex" -> item "pintura latex", cantidad "10 lts".
- Si un renglón no tiene cantidad, poné cantidad null.
- No inventes ítems que no dijo. No agregues el objetivo a los ítems.
- Respetá los materiales tal como los nombró (guantes, alambre, bolsas, nafta, aceite 2t, etc.).`;

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
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const detalle = await resp.text();
    throw new Error(`API Claude ${resp.status}: ${detalle}`);
  }

  const data = await resp.json();
  const textoResp = (data.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('');
  const limpio = textoResp.replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(limpio);

  return {
    objetivo: parsed.objetivo ?? null,
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}

module.exports = { interpretarInsumos };
