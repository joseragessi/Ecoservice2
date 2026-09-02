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
  Los remitos de surtidor NO tienen montos: dejá neto, iva, otros_tributos, total
  y los precios en null.
- "remito" TAMBIÉN es el "COMPROBANTE DE OPERACION ONLINE" de una tarjeta de combustible
  (Edenred, Ticket Car, YPF Ruta). Ver la sección de abajo: estos SÍ traen importes.

Devolvé exactamente esta estructura:
{
  "tipo_doc": "factura" | "remito",
  "es_tarjeta": boolean,            // true solo si es comprobante de tarjeta de combustible
  "proveedor": string,              // razón social del emisor (la estación de servicio)
  "cuit": string,                   // CUIT del emisor, formato XX-XXXXXXXX-X
  "numero": string,                 // N° de factura, de remito o de comprobante
  "lote": string | null,            // solo tarjeta: el campo "Lote"
  "tarjeta": string | null,         // solo tarjeta: el campo "Tarj" / "Tarjeta", solo dígitos
  "km_anterior": number | null,     // solo tarjeta: "KILOMETRAJE anterior"
  "km_actual": number | null,       // solo tarjeta: "KILOMETRAJE actual"
  "saldo_tarjeta": number | null,   // solo tarjeta: el campo "Saldo"
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

MUY IMPORTANTE — comprobantes de TARJETA de combustible (Edenred, Ticket Car, YPF Ruta):
Se reconocen porque dicen "COMPROBANTE DE OPERACION ONLINE" y traen los campos
Lote, Compr, Tarj, Autorizacion, Criptograma, KILOMETRAJE y Saldo.
Para estos: "es_tarjeta": true, "tipo_doc": "remito".
- El importe SÍ se lee: poné el precio por litro en "precio_unit", el importe de la línea
  en "subtotal" y el mismo importe en "total". La tarjeta NO discrimina IVA (la factura la
  emite la tarjeta a fin de mes, consolidada): dejá neto, iva y otros_tributos en null.
- "numero" es el campo **Compr** (ej: 2951), NO el Lote. El Lote va en su propio campo.
- "tarjeta" son los dígitos del campo Tarj, sin espacios.
- El producto viene bajo "TOTAL CARGADO" con la forma:
    NOMBRE_PRODUCTO / Cantidad: LTS <litros> / Precio: $ <precio> / Total: $ <importe>
  Ejemplo: "ION DIESEL", Cantidad 39,002 → litros 39.002 ; Precio 2.465,0000 → 2465
  ; Total 96.139,93 → 96139.93.
- "Saldo" es el saldo que le queda a la tarjeta DESPUÉS de la carga, no un importe cobrado.
- KILOMETRAJE: leé "anterior" y "actual" como enteros, sacando los separadores de miles
  ("219.625" → 219625). Si el anterior viene en 0, ponelo en 0, no en null: el 0 es el dato.
- **IGNORÁ el campo "Rendimiento"**: lo calcula la terminal con el kilometraje anterior y
  cuando ese viene en 0 imprime un número absurdo (563,1 KM/LTS). No lo devuelvas.
- La patente figura suelta cerca de la razón social del cliente (ej: "ECOSERVICE SRL
  (34108.1)" y abajo "KCG906"). El número largo debajo de "CONDUCTOR" es un DNI o legajo,
  NO es la patente y NO es el chofer: dejá "chofer" en null si solo aparece ese número.

Para los comprobantes que NO son de tarjeta poné "es_tarjeta": false y dejá lote, tarjeta,
km_anterior, km_actual y saldo_tarjeta en null.

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
Cuidado con letras que se confunden en la impresión térmica: U/V, O/0, I/1, B/8, H/W, A/M. Si un carácter
no se lee con seguridad, igual transcribí lo que mejor se vea (el sistema la valida contra la flota).
Si un dato no está o no se lee con seguridad, poné null. No inventes valores, pero SÍ leé los litros
del remito siguiendo la regla de arriba: casi siempre están presentes aunque el remito no tenga montos.`;

// ── Saneamiento de los campos de tarjeta ──────────────────────
// El ticket térmico de Edenred se lee mal seguido y hay tres formas conocidas
// de que la lectura salga plausible pero falsa. Se corrigen acá, no en el
// prompt, porque el modelo no es determinístico y esto sí tiene que serlo.
function sanearTarjeta(p) {
  if (!p) return p;
  const num = v => {
    if (v == null || v === '') return null;
    const crudo = String(v).replace(/[^0-9.,-]/g, '');
    // Sin un solo dígito no hay número: "ilegible" o "---" limpiaban a cadena
    // vacía y Number('') da 0, así que un saldo que no se leyó se guardaba
    // como $0. Un cero falso es peor que un dato ausente.
    if (!/\d/.test(crudo)) return null;
    const n = Number(crudo.replace(/\./g, '').replace(',', '.'));
    return isFinite(n) ? n : null;
  };
  const soloDigitos = v => {
    const d = String(v == null ? '' : v).replace(/\D/g, '');
    return d || null;
  };

  p.es_tarjeta = p.es_tarjeta === true;
  p.lote    = p.lote ? String(p.lote).trim() : null;
  p.tarjeta = soloDigitos(p.tarjeta);

  // El odómetro de una camioneta de la flota no pasa del millón de km. Un valor
  // fuera de rango es lectura mala del térmico: mejor null que un km inventado
  // que después arrastre el cálculo de rendimiento de esa unidad.
  const km = v => { const n = num(v); return n != null && n >= 0 && n <= 1000000 ? Math.round(n) : null; };
  p.km_anterior   = km(p.km_anterior);
  p.km_actual     = km(p.km_actual);
  p.saldo_tarjeta = num(p.saldo_tarjeta);

  // Si el odómetro "actual" quedó por debajo del "anterior", uno de los dos se
  // leyó mal y no hay forma de saber cuál: se descartan los dos. El km sirve
  // para medir rendimiento; un par invertido daría consumo negativo.
  if (p.km_anterior != null && p.km_actual != null && p.km_actual < p.km_anterior) {
    p.km_anterior = null;
    p.km_actual   = null;
    p._km_dudoso  = true;
  }

  // El modelo confunde Lote con Compr (los dos están pegados en el ticket).
  // Si devolvió el mismo número en los dos lados, el de comprobante es el que
  // no podemos sostener: el lote es más largo y más distintivo.
  if (p.lote && p.numero && String(p.numero).replace(/\D/g, '') === p.lote.replace(/\D/g, '')) {
    p.numero = null;
  }

  // Un comprobante de tarjeta nunca discrimina IVA: si el modelo lo inventó,
  // se borra. La factura consolidada la emite la tarjeta a fin de mes.
  if (p.es_tarjeta) {
    p.neto = null;
    p.iva = null;
    p.otros_tributos = null;
  }
  return p;
}

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

  sanearTarjeta(parsed);
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
- Si el capataz menciona una PATENTE (ej "la hilux HAI248", "unidad AB123CD"), ponela en el campo
  "patente" del reparto, en mayúsculas y sin espacios, con destino "unidad".
  Si esa patente NO coincide con la del ticket, NO es un error: los tickets térmicos se leen mal
  seguido y el capataz la está corrigiendo. NUNCA devuelvas ok:false por una patente distinta.
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
      "patente": string | null,     // patente si el capataz la nombró (destino "unidad")
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

module.exports = { extraerComprobante, parsearDestinoCombustible, sanearTarjeta };
