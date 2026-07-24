// ── Sugerencia de repuestos con IA ──────────────────────────────────────────
// Analiza la reparación puntual (equipo, falla, descripción del capataz y
// comentarios/diagnóstico del mecánico) y propone la lista probable de
// repuestos. Es un punto de partida EDITABLE: el mecánico agrega, borra o
// corrige todo antes de mandar el pedido.

const supabase = require('./supabase');

const MODEL = process.env.ANTHROPIC_MODEL_EXTRACT || 'claude-haiku-4-5-20251001';

async function sugerirRepuestos(incidenciaId) {
  const { data: inc, error } = await supabase.from('incidencias')
    .select('tipo_equipo, tipo_falla, descripcion, numero_unidad, equipo_parado, ' +
            'equipos(nombre,tipo), comentarios_incidencias(mecanico_nombre,texto,created_at)')
    .eq('id', incidenciaId).single();
  if (error || !inc) throw new Error('Incidencia inexistente');

  const equipo = inc.tipo_equipo || (inc.equipos && (inc.equipos.nombre || inc.equipos.tipo)) || 'equipo';
  const coms = (inc.comentarios_incidencias || [])
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(c => `- ${c.mecanico_nombre || 'Mecánico'}: ${c.texto}`).join('\n');

  const prompt =
    'Sos ayudante de un taller de mantenimiento de parques (EcoService, Córdoba, Argentina). ' +
    'Un mecánico va a pedir repuestos para esta reparación. Proponé la lista PROBABLE de repuestos.\n\n' +
    `EQUIPO: ${equipo}${inc.numero_unidad ? ' (unidad N° ' + inc.numero_unidad + ')' : ''}\n` +
    `TIPO DE FALLA: ${inc.tipo_falla || 'no especificada'}\n` +
    `EQUIPO PARADO: ${inc.equipo_parado ? 'sí' : 'no'}\n` +
    `DESCRIPCIÓN DEL CAPATAZ: ${inc.descripcion || '—'}\n` +
    (coms ? `DIAGNÓSTICO / COMENTARIOS DEL MECÁNICO:\n${coms}\n` : '') +
    '\nDevolvé ÚNICAMENTE JSON sin backticks con este formato:\n' +
    '{"items":[{"descripcion":"string","cantidad":1}],"razon":"string"}\n' +
    'Reglas:\n' +
    '- Entre 2 y 6 repuestos, los MÁS probables primero. Si los comentarios del mecánico ya nombran ' +
    'repuestos concretos, esos van primero tal cual los nombró.\n' +
    '- Descripciones genéricas de taller en español argentino (ej. "Bujía", "Filtro de aire", ' +
    '"Carburador completo", "Cable de acelerador"). NO inventes códigos de parte ni marcas ' +
    'salvo que el mecánico las haya mencionado.\n' +
    '- "cantidad" entera estimada (default 1).\n' +
    '- "razon": UNA frase corta explicando el porqué (ej. "Falla de arranque en motor 2T: lo típico es ' +
    'chispa o carburación"). Sin tecnicismos innecesarios.\n' +
    '- Si la información es muy vaga, igual proponé lo típico para esa falla en ese equipo.';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await resp.json();
  const txt = (data.content || []).map(c => c.text || '').join('');
  const parsed = JSON.parse(txt.replace(/```json|```/g, '').trim());
  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .map(i => ({ descripcion: String(i.descripcion || '').trim(), cantidad: Number(i.cantidad) || 1, codigo: '' }))
    .filter(i => i.descripcion).slice(0, 6);
  if (!items.length) throw new Error('Sin sugerencias');
  console.log(`[repuestos-ia] ${items.length} sugerencias para incidencia ${incidenciaId} (${equipo} · ${inc.tipo_falla || 's/falla'})`);
  return { items, razon: String(parsed.razon || '').trim() };
}

module.exports = { sugerirRepuestos };
