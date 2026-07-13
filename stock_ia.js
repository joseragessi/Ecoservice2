// Interpreta listados de stock de maquinaria de capataces (texto libre e
// informal por WhatsApp) usando la API de Claude. Sirve para la
// interpretación inicial y para ajustes ("agregá una motosierra", "el tractor es el 5").

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

// Tipos canónicos de equipo (alineados con TIPOS_EQUIPO de conversacion.js
// más los que aparecen en los censos). La IA mapea a estos cuando puede.
const TIPOS_STOCK = [
  'Motoguadaña', 'Motosierra', 'Extensible', 'Sopladora',
  'Mini tractor / Giro cero', 'Tractor', 'Plana',
  'Toyota / Camioneta', 'Camión / Atego', 'Hidro grúa',
  'Hidrolavadora', 'Cortadora de pasto', 'Carro / Remolque', 'Otro',
];

/**
 * @param {string} texto           - lo que escribió el capataz
 * @param {object|null} estadoActual - { items } si ya hay un censo en curso; null si es nuevo
 * @returns {Promise<{items: Array<{tipo:string, cantidad:number, numeros:string[], observacion:string|null}>}>}
 */
async function interpretarStock(texto, estadoActual = null) {
  const contextoEstado = estadoActual
    ? `El capataz ya tiene este listado de stock en curso:
${JSON.stringify(estadoActual, null, 2)}

Ahora dice: "${texto}"

Actualizá el listado según lo que pide: puede AGREGAR equipos, QUITAR equipos,
corregir cantidades o números de máquina. Devolvé el listado COMPLETO y actualizado.`
    : `El capataz mandó este listado de stock de maquinaria de su objetivo:
"${texto}"

Interpretalo y extraé los equipos con su cantidad y números de máquina.`;

  const prompt = `Sos un asistente que interpreta listados de stock de maquinaria de
capataces de EcoService (empresa de mantenimiento de espacios verdes),
escritos en texto libre e informal por WhatsApp.

${contextoEstado}

Devolvé SOLO un objeto JSON válido, sin texto antes ni después y sin comillas de markdown:
{
  "items": [
    {
      "tipo": string,              // tipo de equipo
      "cantidad": number,          // cuántos tiene
      "numeros": [string],         // números o códigos de máquina tal como los dijo: ["12","15","21"] o ["MG-04"]; [] si no los dijo
      "observacion": string | null // aclaraciones ("una rota", "en el taller"); null si no hay
    }
  ]
}

Reglas:
- Para "tipo" usá preferentemente uno de estos nombres: ${TIPOS_STOCK.join(', ')}.
  Si lo que nombró no encaja en ninguno, usá el nombre tal como lo dijo el capataz.
- "3 motoguadañas la 12 la 15 y la 21" -> tipo "Motoguadaña", cantidad 3, numeros ["12","15","21"].
- Si dice una cantidad sin números de máquina, poné numeros [].
- Si da números pero no cantidad, la cantidad es la cantidad de números.
- No inventes equipos que no dijo. No mezcles tipos distintos en un mismo ítem.
- Estados o aclaraciones ("una está rota", "el tractor está en el taller") van en "observacion" del ítem correspondiente.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
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

  const items = (Array.isArray(parsed.items) ? parsed.items : []).map(i => ({
    tipo:        String(i.tipo || 'Otro'),
    cantidad:    Math.max(1, parseInt(i.cantidad) || (Array.isArray(i.numeros) ? i.numeros.length : 0) || 1),
    numeros:     Array.isArray(i.numeros) ? i.numeros.map(String) : [],
    observacion: i.observacion || null,
  }));

  return { items };
}

module.exports = { interpretarStock };
