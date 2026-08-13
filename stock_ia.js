// Interpreta listados de stock de maquinaria de capataces (texto libre e
// informal por WhatsApp) usando la API de Claude. Sirve para la
// interpretación inicial y para ajustes ("agregá una motosierra", "el tractor es el 5").
//
// 13-ago-2026: Leo Godoy (DEPOSITO) mandó un listado con motoguadañas,
// motosierras y un mini tractor, y volvió TODO como "Motoguadaña" — se
// perdieron dos tipos. El modelo era Sonnet (ANTHROPIC_MODEL no está seteada):
// no fue un problema de modelo barato, el prompt dejaba lugar a fusionar tipos.
//
// La corrección NO se le pide al capataz: el intérprete se controla y se
// corrige solo antes de devolver.
//   1. prompt con regla dura contra fusionar o perder tipos, con ejemplo mixto
//   2. prefill "{" + temperature 0 + parseo tolerante: nunca prosa
//   3. control de COBERTURA sin IA: si el mensaje nombra un tipo de máquina que
//      no quedó en ningún ítem, se hace UNA SEGUNDA PASADA diciéndole al modelo
//      exactamente qué se perdió. Se queda la lectura más completa de las dos.
//   4. control de conteo: la cantidad no puede ser menor que la cantidad de
//      números informados (el censo de Leo trajo cantidad 8 con 9 números, y
//      el panel mostraba 33 cuando eran 34).

// Listado largo y variado: conviene un modelo capaz. Env propia para que un
// cambio hecho para otra cosa no se lo lleve puesto.
const MODEL = process.env.ANTHROPIC_MODEL_STOCK || 'claude-sonnet-5';

// Tipos canónicos de equipo (alineados con TIPOS_EQUIPO de conversacion.js
// más los que aparecen en los censos). La IA mapea a estos cuando puede.
const TIPOS_STOCK = [
  'Motoguadaña', 'Motosierra', 'Extensible', 'Sopladora',
  'Mini tractor / Giro cero', 'Tractor', 'Plana',
  'Toyota / Camioneta', 'Camión / Atego', 'Hidro grúa',
  'Hidrolavadora', 'Cortadora de pasto', 'Carro / Remolque', 'Otro',
];

// Raíces de nombres de máquina, para chequear que no se haya perdido ningún
// tipo. Es comparación de texto, sin IA: si el capataz escribió "motosierra"
// y no hay ningún ítem cuyo tipo contenga "motosierr", falta algo.
const RAICES_EQUIPO = [
  'motoguada', 'motosierr', 'soplador', 'extensible', 'girocero', 'tractor',
  'hidrolavadora', 'hidrogrua', 'cortadora', 'remolque', 'camioneta',
  'desmalezadora', 'bordeadora',
];

// Cómo nombrar la raíz cuando hay que pedirle al modelo que la recupere.
const NOMBRE_RAIZ = {
  motoguada: 'motoguadañas', motosierr: 'motosierras', soplador: 'sopladoras',
  extensible: 'extensibles', girocero: 'giro cero', tractor: 'tractores',
  hidrolavadora: 'hidrolavadoras', hidrogrua: 'hidrogrúas',
  cortadora: 'cortadoras de pasto', remolque: 'carros / remolques',
  camioneta: 'camionetas', desmalezadora: 'desmalezadoras',
  bordeadora: 'bordeadoras',
};

function normEq(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Devuelve las raíces nombradas en el texto que NO quedaron en ningún ítem.
function tiposFaltantes(texto, items) {
  const t = normEq(texto);
  const tipos = (items || []).map(i => normEq(i.tipo)).join(' ');
  return RAICES_EQUIPO.filter(r => t.includes(r) && !tipos.includes(r));
}

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

const FORMATO = `Devolvé SOLO un objeto JSON válido, sin texto antes ni después y sin comillas de markdown:
{
  "items": [
    {
      "tipo": string,              // tipo de equipo
      "cantidad": number,          // cuántos tiene
      "numeros": [string],         // números o códigos de máquina tal como los dijo: ["12","15","21"] o ["MG-04"]; [] si no los dijo
      "observacion": string | null // aclaraciones ("una rota", "en el taller", "modelo 291"); null si no hay
    }
  ]
}`;

const REGLAS = `Reglas:
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

// Una llamada al modelo. Devuelve los items crudos (sin normalizar).
async function pedirInterpretacion(prompt) {
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

  if (data.stop_reason && data.stop_reason !== 'end_turn') {
    console.log(`[stock ia] stop_reason=${data.stop_reason} — la respuesta puede haber quedado cortada`);
  }
  return {
    crudos: Array.isArray(parsed.items) ? parsed.items : [],
    usage: data.usage || null,
  };
}

// Normaliza los items y corrige las cantidades que no cierran con los números.
function normalizarItems(crudos) {
  const avisos = [];
  const items = (crudos || []).map(i => {
    const numeros = Array.isArray(i.numeros) ? i.numeros.map(String) : [];
    let cantidad = parseInt(i.cantidad) || 0;
    const tipo = String(i.tipo || 'Otro');

    // Si enumeró máquinas, la cantidad no puede ser menor que la cantidad de
    // números. Gana lo enumerado, que es lo verificable.
    if (numeros.length && cantidad !== numeros.length) {
      avisos.push(`${tipo}: dijo ${cantidad || 'sin cantidad'} pero listó ${numeros.length} números — tomo ${numeros.length}`);
      cantidad = numeros.length;
    }
    if (!cantidad) cantidad = numeros.length || 1;

    return { tipo, cantidad, numeros, observacion: i.observacion || null };
  });
  return { items, avisos };
}

/**
 * @param {string} texto           - lo que escribió el capataz
 * @param {object|null} estadoActual - { items } si ya hay un censo en curso; null si es nuevo
 * @returns {Promise<{items: Array, avisos: string[]}>}
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

  const base = `Sos un asistente que interpreta listados de stock de maquinaria de
capataces de EcoService (empresa de mantenimiento de espacios verdes),
escritos en texto libre e informal por WhatsApp.

${contextoEstado}

${FORMATO}

${REGLAS}`;

  const r1 = await pedirInterpretacion(base);
  let mejor = normalizarItems(r1.crudos);
  let faltan = tiposFaltantes(texto, mejor.items);
  let pasadas = 1;

  // Segunda pasada CORRECTIVA: se le dice al modelo exactamente qué se perdió.
  // El capataz no se entera; el trabajo lo hace la IA.
  if (faltan.length) {
    console.log(`[stock ia] faltaron tipos en la 1ª pasada: ${faltan.join(', ')} — reintento correctivo`);
    const nombres = faltan.map(r => NOMBRE_RAIZ[r] || r).join(', ');
    const correctivo = `${base}

CORRECCIÓN OBLIGATORIA. Ya interpretaste este mensaje y devolviste:
${JSON.stringify({ items: mejor.items }, null, 2)}

Esa lectura ESTÁ INCOMPLETA: en el mensaje del capataz se nombran ${nombres},
y no aparecen en ningún ítem. Volvé a leer el mensaje COMPLETO, de principio a
fin, y devolvé la lista entera incluyendo esos equipos con su cantidad y sus
números. No quites nada de lo que ya estaba bien.`;

    try {
      const r2 = await pedirInterpretacion(correctivo);
      const cand = normalizarItems(r2.crudos);
      const faltan2 = tiposFaltantes(texto, cand.items);
      pasadas = 2;
      // Nos quedamos con la lectura más completa de las dos.
      if (cand.items.length && faltan2.length < faltan.length) {
        mejor = cand;
        faltan = faltan2;
      }
    } catch (err) {
      console.error('[stock ia] falló el reintento correctivo:', err.message || err);
    }
  }

  // Si después de las dos pasadas sigue faltando algo, ahí sí se avisa: es
  // preferible que quede a la vista antes de guardar.
  if (faltan.length) {
    const nombres = faltan.map(r => NOMBRE_RAIZ[r] || r).join(', ');
    mejor.avisos.push(`No pude tomar bien ${nombres} de tu mensaje. Escribilos de nuevo con la cantidad.`);
    console.log(`[stock ia] ⚠ tipos que no pude recuperar: ${faltan.join(', ')}`);
  }

  console.log(`[stock ia] ${MODEL} · ${pasadas} pasada(s) · ${mejor.items.length} ítems` +
    (r1.usage ? ` · in ${r1.usage.input_tokens} out ${r1.usage.output_tokens}` : '') +
    (mejor.avisos.length ? ` · ${mejor.avisos.length} aviso(s)` : ''));

  return { items: mejor.items, avisos: mejor.avisos };
}

module.exports = { interpretarStock, parseJsonStock, tiposFaltantes, normalizarItems };
