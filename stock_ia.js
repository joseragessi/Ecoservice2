// Interpreta listados de stock de maquinaria de capataces (texto libre e
// informal por WhatsApp) usando la API de Claude. Sirve para la
// interpretación inicial y para ajustes ("agregá una motosierra", "el tractor es el 5").
//
// 13-ago-2026: Leo Godoy (DEPOSITO) mandó un listado con motoguadañas,
// motosierras y un mini tractor, y volvió TODO como "Motoguadaña" — se
// perdieron dos tipos y el capataz confirmó sin mirar. Tres defensas:
//   1. modelo propio (no colgarse de ANTHROPIC_MODEL, que puede estar en Haiku)
//   2. prefill "{" + temperature 0 + parseo tolerante: nunca prosa
//   3. control de conteo server-side: la cantidad no puede ser menor que la
//      cantidad de números informados (el mismo censo trajo cantidad 8 con
//      9 números, y el panel mostraba 33 cuando eran 34).

// Este listado es largo y variado: conviene un modelo capaz. Override con
// ANTHROPIC_MODEL_STOCK.
const MODEL = process.env.ANTHROPIC_MODEL_STOCK || 'claude-sonnet-5';

// Tipos canónicos de equipo (alineados con TIPOS_EQUIPO de conversacion.js
// más los que aparecen en los censos). La IA mapea a estos cuando puede.
const TIPOS_STOCK = [
  'Motoguadaña', 'Motosierra', 'Extensible', 'Sopladora',
  'Mini tractor / Giro cero', 'Tractor', 'Plana',
  'Toyota / Camioneta', 'Camión / Atego', 'Hidro grúa',
  'Hidrolavadora', 'Cortadora de pasto', 'Carro / Remolque', 'Otro',
];

// El modelo puede repetir la llave del prefill o colgar texto al final.
// Mismo criterio que parseJsonFactura() en panel_api.js.
function parseJsonStock(txt) {
  const intentos = [
    txt,
    '{' + txt,
    txt.replace(/^\s*\{\s*\{/, '{'),
  ];
  for (let t of intentos) {
    if (!t) continue;
    t = t.replace(/```json/gi, '').replace(/```/g, '').trim();
    const candidatos = [t];
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) candidatos.push(t.slice(a, b + 1));
    for (const c of candidatos) {
      try { const p = JSON.parse(c); if (p && typeof p === 'object') return p; } catch (e) { /* sigo */ }
    }
  }
  return null;
}

/**
 * @param {string} texto           - lo que escribió el capataz
 * @param {object|null} estadoActual - { items } si ya hay un censo en curso; null si es nuevo
 * @returns {Promise<{items: Array<{tipo:string, cantidad:number, numeros:string[], observacion:string|null}>, avisos: string[]}>}
 */
async function interpretarStock(texto, estadoActual = null) {
  const contextoEstado = estadoActual
    ? `El capataz ya tiene este listado de stock en curso:
${JSON.stringify(estadoActual, null, 2)}

Ahora dice: "${texto}"

Actualizá el listado según lo que pide: puede AGREGAR equipos, QUITAR equipos,
corregir cantidades o números de máquina. Devolvé el listado COMPLETO y actualizado.
No pierdas nada de lo que ya estaba, salvo que pida quitarlo expresamente.`
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
      "observacion": string | null // aclaraciones ("una rota", "en el taller", "modelo 291"); null si no hay
    }
  ]
}

Reglas:
- Para "tipo" usá preferentemente uno de estos nombres: ${TIPOS_STOCK.join(', ')}.
  Si lo que nombró no encaja en ninguno, usá el nombre tal como lo dijo el capataz.
- "3 motoguadañas la 12 la 15 y la 21" -> tipo "Motoguadaña", cantidad 3, numeros ["12","15","21"].
- Si dice una cantidad sin números de máquina, poné numeros [].
- Si da números pero no cantidad, la cantidad es la cantidad de números.
- No inventes equipos que no dijo.

MUY IMPORTANTE — no perder ni fusionar tipos:
- CADA TIPO DE EQUIPO NOMBRADO VA EN SU PROPIO ÍTEM. Nunca juntes equipos de
  tipos distintos en un mismo ítem, ni cambies el tipo de unos por el de otros.
  Si el mensaje nombra motoguadañas, motosierras y un mini tractor, tienen que
  salir al menos tres ítems, uno por tipo.
- Recorré el mensaje ENTERO antes de responder, de principio a fin: los listados
  largos suelen terminar con equipos sueltos ("y 2 motosierras, 1 mini tractor")
  que no hay que dejar afuera.
- Un mismo tipo PUEDE aparecer en varios ítems si el capataz los separa por
  marca o modelo (por ejemplo motoguadañas modelo 291 y motoguadañas Husqvarna):
  en ese caso poné la marca o el modelo en "observacion".
- "cantidad" tiene que coincidir con la cantidad de elementos de "numeros"
  cuando el capataz enumeró las máquinas. Contá los números uno por uno antes
  de escribir la cantidad.

Ejemplo de listado mixto:
"8 motoguadañas modelo 291 la 227 230 218, 2 motosierras la 4 y la 9, 1 mini tractor"
-> items:
   {"tipo":"Motoguadaña","cantidad":3,"numeros":["227","230","218"],"observacion":"modelo 291"},
   {"tipo":"Motosierra","cantidad":2,"numeros":["4","9"],"observacion":null},
   {"tipo":"Mini tractor / Giro cero","cantidad":1,"numeros":[],"observacion":null}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,          // un censo grande con números pasaba los 1500
      temperature: 0,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '{' },   // prefill: obliga JSON, nunca prosa
      ],
    }),
  });

  if (!resp.ok) {
    const detalle = await resp.text();
    throw new Error(`API Claude ${resp.status}: ${detalle}`);
  }

  const data = await resp.json();
  const textoResp = (data.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('');

  // El prefill no vuelve en la respuesta: se la anteponemos.
  const parsed = parseJsonStock('{' + textoResp) || parseJsonStock(textoResp);
  if (!parsed) throw new Error('No pude interpretar la respuesta del modelo');

  const avisos = [];
  const items = (Array.isArray(parsed.items) ? parsed.items : []).map(i => {
    const numeros = Array.isArray(i.numeros) ? i.numeros.map(String) : [];
    let cantidad = parseInt(i.cantidad) || 0;
    const tipo = String(i.tipo || 'Otro');

    // Control de conteo: si enumeró máquinas, la cantidad no puede ser menor
    // que la cantidad de números. Gana lo enumerado, que es lo verificable.
    if (numeros.length && cantidad !== numeros.length) {
      avisos.push(`${tipo}: dijo ${cantidad || 'sin cantidad'} pero listó ${numeros.length} números — tomo ${numeros.length}`);
      cantidad = numeros.length;
    }
    if (!cantidad) cantidad = numeros.length || 1;

    return { tipo, cantidad, numeros, observacion: i.observacion || null };
  });

  if (data.usage) {
    console.log(`[stock ia] ${MODEL} · in ${data.usage.input_tokens} out ${data.usage.output_tokens} · ${items.length} ítems` +
      (avisos.length ? ` · ${avisos.length} aviso(s)` : ''));
  }
  if (data.stop_reason && data.stop_reason !== 'end_turn') {
    console.log(`[stock ia] stop_reason=${data.stop_reason} — la respuesta puede haber quedado cortada`);
  }

  return { items, avisos };
}

module.exports = { interpretarStock, parseJsonStock };
