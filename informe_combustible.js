// ══════════════════════════════════════════════════════════════
// Informe de combustible para gerencia (30-sep-2026)
// Aprobado en mockup_informe_gerencia.html (v2, "más simple"). Responde cuatro
// preguntas del mes:
//   1. ¿Dónde fue el combustible?  (bidones / tanque de unidad / equipos)
//   2. ¿Qué objetivos consumieron más?
//   3. ¿Cuánto se cargó con tarjeta sin ticket, y de quién?
//   4. ¿Qué desvíos de litros hay?
// La base es LO QUE DECLARA EL CAPATAZ, ítem por ítem (cargas_combustible_items):
// un ticket de 153 lt de Gustavo son 4 destinos. Edenred es el control.
// Función pura: el endpoint junta los datos y esto arma el informe.
// Compras no lo toca.
// ══════════════════════════════════════════════════════════════
const CE = require('./conciliacion_edenred');

const normObj = v => String(v || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const pareceP = s => /^[a-z]{2,3}\d{3}[a-z]{0,2}$/.test(normObj(s));
const r2 = n => Math.round(n * 100) / 100;

// Mismo criterio que el panel (resolverObj): objetivo real → alias aprendido →
// queda como lo escribieron. Si escribieron una patente ("Ah122jo"), va al
// objetivo de la carga.
function resolverObj(txt, alias, fallback) {
  const n = normObj(txt);
  if (!n) return fallback || 'Sin objetivo';
  const o = (alias.objetivos || []).find(x => normObj(x.nombre) === n);
  if (o) return o.nombre;
  const a = (alias.alias || []).find(x => x.alias === n);
  if (a) return a.nombre;
  if (pareceP(txt)) return fallback || 'Sin objetivo';
  return String(txt).trim();
}

const TIPO = p => /diesel|gasoil|gas oil|d500|evolux|v-?power d|power d|premium d|infinia d/i.test(p || '') ? 'Diesel' : 'Nafta';
// El OCR lee mal muchos totales ($2.113.000 por 50 lt). Un precio fuera de
// este rango no se usa.
const precioOk = (pe, lt) => pe > 0 && lt > 0 && pe / lt >= 1500 && pe / lt <= 4000;

/**
 * cargas:   cargas_combustible del mes (±1 día) con items, capataces, objetivos,
 *           unidades, proveedores
 * edenred:  filas de los listados de Edenred (ya guardados), sin repetir
 * alias:    { alias:[{alias,nombre}], objetivos:[{nombre}] }
 * unidades: [{id, patente, tarjeta_combustible}]
 * mes:      'YYYY-MM'
 */
function armarInforme({ cargas = [], edenred = [], alias = {}, unidades = [], mes }) {
  const enMes = f => String(f || '').startsWith(mes);
  const uni = {}; const tarjetaDePatente = {};
  unidades.forEach(u => { uni[u.id] = u; if (u.patente && u.tarjeta_combustible) tarjetaDePatente[String(u.patente).toUpperCase().replace(/[^A-Z0-9]/g, '')] = String(u.tarjeta_combustible); });

  // ── Cruce con Edenred (mes ±1 día, para las cargas de madrugada)
  const grupos = edenred.map(f => ({ ...f, key: 'ED|' + (f.numero_remito || [f.fecha, f.hora, f.patente, f.litros].join('|')) }));
  const candidatas = cargas.filter(CE.puedeSerEdenred);
  const { pares, sueltas } = CE.emparejar(grupos, candidatas, tarjetaDePatente);
  const parDe = {}; pares.forEach(p => { parDe[p.c.id] = p; });

  // ── Plata de cada carga: Edenred (real) → total del ticket razonable →
  // precio de los ítems razonable → se estima con el promedio del mes.
  const importe = c => {
    const lt = Number(c.litros_total) || 0;
    const p = parDe[c.id];
    if (p && p.g.total && p.g.litros) return { pe: p.g.total * lt / p.g.litros, fuente: 'edenred' };
    if (precioOk(Number(c.total), lt)) return { pe: Number(c.total), fuente: 'ticket' };
    const its = c.cargas_combustible_items || [];
    const pi = its.reduce((s, i) => s + (Number(i.precio_unit) || 0) * (Number(i.litros) || 0), 0);
    if (its.length && its.every(i => i.precio_unit) && precioOk(pi, lt)) return { pe: pi, fuente: 'ticket' };
    return null;
  };
  const delMes = cargas.filter(c => enMes(c.fecha));
  const prom = { Diesel: [0, 0], Nafta: [0, 0] };
  const imp = {};
  delMes.forEach(c => {
    imp[c.id] = importe(c);
    if (imp[c.id]) { const t = TIPO(((c.cargas_combustible_items || [])[0] || {}).producto); prom[t][0] += imp[c.id].pe; prom[t][1] += Number(c.litros_total) || 0; }
  });
  const todos = [prom.Diesel[0] + prom.Nafta[0], prom.Diesel[1] + prom.Nafta[1]];
  const pm = t => prom[t][1] ? prom[t][0] / prom[t][1] : (todos[1] ? todos[0] / todos[1] : 0);

  // ── Ítems declarados del mes (la base del informe)
  const items = [];
  delMes.forEach(c => {
    const its = (c.cargas_combustible_items || []).filter(i => i.es_combustible !== false);
    const lista = its.length ? its : [{ litros: c.litros_total, destino: c.destino === 'bidon' ? 'bidon' : 'unidad', producto: null }];
    const ltC = lista.reduce((s, i) => s + (Number(i.litros) || 0), 0) || Number(c.litros_total) || 0;
    const objC = (c.objetivos && c.objetivos.nombre) || 'Sin objetivo';
    const im = imp[c.id];
    lista.forEach(i => {
      const lt = Number(i.litros) || 0;
      const est = !im;
      const pe = im ? im.pe * lt / (ltC || 1) : pm(TIPO(i.producto)) * lt;
      const dest = i.destino === 'bidon' ? 'Bidones' : i.destino === 'equipo' ? 'Equipos' : 'Tanque de unidad';
      const obj = i.destino === 'bidon' ? resolverObj(i.destino_detalle, alias, objC) : objC;
      // Lo que cobró Edenred por esta carga, repartido según lo declarado
      // (incluye la diferencia si hubo desvío: es lo que se pagó).
      const pE = parDe[c.id];
      const edenred = pE && enMes(pE.g.fecha) ? (Number(pE.g.total) || 0) * lt / (ltC || 1) : 0;
      items.push({ carga_id: c.id, fecha: c.fecha, capataz: (c.capataces && c.capataces.nombre) || '—',
        objetivo: obj, destino: dest, litros: lt, importe: pe, estimado: est, edenred,
        patente: i.destino === 'unidad' ? ((uni[i.unidad_id] || {}).patente || (c.unidades && c.unidades.patente) || c.patente_raw || null) : null });
    });
  });

  const suma = (xs, k) => xs.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  const agrupar = (xs, key) => {
    const r = {};
    xs.forEach(x => { const k = key(x); const g = r[k] || (r[k] = { nombre: k, litros: 0, importe: 0, cargas: new Set(), caps: {} });
      g.litros += x.litros; g.importe += x.importe; g.cargas.add(x.carga_id); g.caps[x.capataz] = (g.caps[x.capataz] || 0) + x.litros; });
    return Object.values(r).map(g => ({ nombre: g.nombre, litros: r2(g.litros), importe: Math.round(g.importe), cargas: g.cargas.size,
      capataces: Object.entries(g.caps).sort((a, b) => b[1] - a[1]).map(z => z[0]).slice(0, 2) })).sort((a, b) => b.litros - a.litros);
  };

  // ── 3 · Sin ticket: líneas de Edenred del mes que nadie declaró
  const sinTicket = sueltas.filter(g => enMes(g.fecha));
  const porChofer = {};
  sinTicket.forEach(g => { const k = String(g.chofer || '').replace(/\s+/g, ' ').trim() || '(sin chofer)';
    const x = porChofer[k] || (porChofer[k] = { chofer: k, patentes: new Set(), cargas: 0, litros: 0, importe: 0 });
    x.cargas++; x.litros += Number(g.litros) || 0; x.importe += Number(g.total) || 0; if (g.patente) x.patentes.add(g.patente); });

  // ── 4 · Desvíos: misma carga, distintos litros
  const desvios = pares.filter(p => enMes(p.g.fecha) && Math.abs(p.dif) > 1).map(p => ({
    fecha: p.g.fecha, chofer: String(p.g.chofer || '').replace(/\s+/g, ' ').trim() || (p.c.capataces && p.c.capataces.nombre) || '—',
    capataz: (p.c.capataces && p.c.capataces.nombre) || null, patente: p.g.patente,
    litros_edenred: r2(p.g.litros), litros_declarados: r2(Number(p.c.litros_total) || 0), dif: p.dif,
    importe: Math.round(p.g.total || 0), ticket: p.c.numero_remito || p.c.lote || null,
  })).sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif));

  const objetivos = agrupar(items, x => x.objetivo).filter(o => o.nombre !== 'Sin objetivo');
  const edenMes = grupos.filter(g => enMes(g.fecha));
  // Plata de la tarjeta Edenred del mes, según adónde se declaró que fue.
  // Lo que no se declaró es "Sin ticket". Lo que falta para llegar al total de
  // Edenred son cargas cruzadas con ticket de otro mes (madrugada del 1°).
  const porDest = {};
  items.forEach(i => { if (i.edenred) porDest[i.destino] = (porDest[i.destino] || 0) + i.edenred; });
  const edTotal = Math.round(suma(edenMes, 'total'));
  const edSin = Math.round(suma(sinTicket, 'total'));
  const edDecl = Object.values(porDest).reduce((s, v) => s + v, 0);
  return {
    mes,
    total: { litros: r2(suma(items, 'litros')), importe: Math.round(suma(items, 'importe')), cargas: delMes.length,
      importe_estimado: Math.round(suma(items.filter(i => i.estimado), 'importe')) },
    destinos: agrupar(items, x => x.destino),
    objetivos,
    sin_ticket: {
      cargas: sinTicket.length, litros: r2(suma(sinTicket, 'litros')), importe: Math.round(suma(sinTicket, 'total')),
      por_chofer: Object.values(porChofer).map(x => ({ ...x, patentes: [...x.patentes], litros: r2(x.litros), importe: Math.round(x.importe) }))
        .sort((a, b) => b.litros - a.litros),
    },
    desvios,
    edenred: { lineas: edenMes.length, cubre: edenMes.length > 0,
      importe: edTotal, litros: r2(suma(edenMes, 'litros')),
      por_destino: ['Bidones', 'Tanque de unidad', 'Equipos'].filter(k => porDest[k]).map(k => ({ nombre: k, importe: Math.round(porDest[k]) })),
      sin_ticket: edSin, otros: Math.max(0, Math.round(edTotal - edSin - edDecl)),
      desde: edenMes.map(g => g.fecha).sort()[0] || null, hasta: edenMes.map(g => g.fecha).sort().slice(-1)[0] || null },
  };
}

module.exports = { armarInforme, resolverObj, normObj };
