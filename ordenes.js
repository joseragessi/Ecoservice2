// Órdenes de compra — la lógica pura, sin base ni red.
//
// Qué resuelve: hoy quien carga la factura tiene que decidir a qué centro de
// costo va cada cosa. Con la orden, esa decisión la toma quien compra, en el
// momento en que compra, y la factura la hereda. Este módulo tiene todo lo
// que se puede probar sin Supabase: en qué tramo cae una compra, cómo se
// numera, cómo se emparejan los ítems de la factura con los de la orden, qué
// imputación sale de eso, y el control de fraccionamiento.
//
// Todo lo que toca la base está en panel_api.js (endpoints) y ordenes_bot.js
// (WhatsApp). Acá no hay `await` a propósito.

// ── Tramos de compra (decisión de José, 02-sep) ───────────────
// Medidos sobre el total CON IVA de cada compra.
const TRAMOS = {
  DIRECTA_HASTA:      500000,   // Owen compra solo, orden "sin cotización"
  COMPARATIVOS_DESDE: 800000,   // 2-3 presupuestos + aprobación de José
};
const LABEL_TRAMO = {
  directa:      'Compra directa',
  presupuesto:  'Con presupuesto',
  comparativos: 'Comparativos',
};
// Ventana para sumar compras al mismo proveedor y objetivo.
const FRACCIONAMIENTO_DIAS = 7;

function tramoDeMonto(total) {
  const t = Number(total) || 0;
  if (t >= TRAMOS.COMPARATIVOS_DESDE) return 'comparativos';
  if (t > TRAMOS.DIRECTA_HASTA) return 'presupuesto';
  return 'directa';
}

// Cuántas cotizaciones exige cada tramo. La directa no exige ninguna; la
// orden se crea igual con el precio que se sepa.
function cotizacionesRequeridas(tramo) {
  return tramo === 'comparativos' ? 2 : tramo === 'presupuesto' ? 1 : 0;
}

// ── Normalización ─────────────────────────────────────────────
function norm(s) {
  return String(s == null ? '' : s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function normCodigo(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}
// Palabras que no dicen nada del producto y solo suman ruido al comparar.
const RUIDO = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'con', 'sin', 'para', 'por',
  'un', 'una', 'x', 'u', 'un', 'unid', 'unidad', 'unidades', 'lt', 'lts', 'litro', 'litros',
  'kg', 'gr', 'mm', 'cm', 'mt', 'mts', 'pza', 'pzas', 'cja', 'caja', 'art', 'articulo']);
function tokens(s) {
  return norm(s).split(' ').filter(t => t.length > 1 && !RUIDO.has(t));
}

// ── Centros de costo ──────────────────────────────────────────
// Las reparaciones usan la lista `objetivos` ("Chacras") y Compras usa
// `centros_costo` ("CHACRAS DE LA VILLA"). Una orden que nace de una
// reparación tiene que traducir el nombre. Si no puede con certeza, devuelve
// null y la orden queda marcada para que alguien lo elija: guardar un nombre
// que Flexxus no conoce es peor que dejarlo pendiente.
function resolverCentroCosto(nombre, centros) {
  const n = norm(nombre);
  if (!n) return null;
  const lista = (centros || []).map(c => typeof c === 'string' ? { nombre: c } : c);
  // 1. Exacto normalizado.
  const exacto = lista.find(c => norm(c.nombre) === n);
  if (exacto) return exacto;
  // 2. Alias declarado en el maestro (si la fila lo trae).
  const porAlias = lista.find(c => (c.aliases || []).some(a => norm(a) === n));
  if (porAlias) return porAlias;
  // 3. Una sola candidata por contención de palabras: "chacras" está en
  //    "chacras de la villa". Si hay dos, no se elige: elegir mal es peor.
  const tn = tokens(nombre);
  if (!tn.length) return null;
  const cand = lista.filter(c => {
    const tc = new Set(tokens(c.nombre));
    return tn.every(t => tc.has(t));
  });
  return cand.length === 1 ? cand[0] : null;
}

// ── Numeración ────────────────────────────────────────────────
// OC-2026-0041. El correlativo arranca de nuevo cada año.
function siguienteNumero(ultimoNumero, anio) {
  const a = anio || new Date().getFullYear();
  const m = String(ultimoNumero || '').match(/^OC-(\d{4})-(\d+)$/);
  const n = (m && Number(m[1]) === a) ? Number(m[2]) + 1 : 1;
  return `OC-${a}-${String(n).padStart(4, '0')}`;
}

// ── Emparejamiento factura ↔ orden ────────────────────────────
// Cascada: código exacto → descripción parecida → cantidad como desempate.
// Cada ítem de la orden se usa una sola vez. Devuelve, por ítem de factura,
// con cuál de la orden quedó y por qué método, para que quien confirma vea
// cuánto confiar en cada uno.
function similitudDescripcion(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const sa = new Set(ta), sb = new Set(tb);
  let inter = 0;
  sa.forEach(t => { if (sb.has(t)) inter++; });
  const union = new Set([...ta, ...tb]).size;
  const jaccard = inter / union;
  // Contención: si TODOS los tokens de la orden están en la factura, es casi
  // seguro el mismo producto aunque la factura agregue marca y modelo
  // ("filtro aire" ⊂ "FILTRO AIRE STIHL 291").
  const contenido = [...sb].every(t => sa.has(t)) ? 1 : 0;
  return Math.max(jaccard, contenido * 0.8);
}

function emparejarItems(itemsFactura, itemsOrden) {
  const F = itemsFactura || [], O = itemsOrden || [];
  const usados = new Set();
  const res = F.map(() => ({ ix_orden: null, metodo: null, confianza: 0 }));

  // (a) Código exacto, primero: es el único match del que no hay que dudar.
  F.forEach((f, i) => {
    const cf = normCodigo(f.codigo);
    if (!cf) return;
    const j = O.findIndex((o, k) => !usados.has(k) && normCodigo(o.codigo) === cf);
    if (j >= 0) { usados.add(j); res[i] = { ix_orden: j, metodo: 'codigo', confianza: 1 }; }
  });

  // (b) Descripción: se arman todos los pares y se asignan de mayor a menor
  //     similitud, para que un ítem muy parecido no se lo lleve uno tibio.
  const pares = [];
  F.forEach((f, i) => {
    if (res[i].ix_orden != null) return;
    O.forEach((o, j) => {
      if (usados.has(j)) return;
      let s = similitudDescripcion(f.descripcion, o.descripcion);
      if (s <= 0) return;
      // La cantidad no empareja sola, pero desempata.
      const qf = Number(f.cantidad) || 0, qo = Number(o.cantidad) || 0;
      const cant = qf && qo && qf === qo;
      pares.push({ i, j, s: s + (cant ? 0.15 : 0), cant });
    });
  });
  pares.sort((a, b) => b.s - a.s);
  pares.forEach(p => {
    if (res[p.i].ix_orden != null || usados.has(p.j)) return;
    if (p.s < 0.34) return;   // menos de un tercio de palabras en común: no
    usados.add(p.j);
    res[p.i] = { ix_orden: p.j, metodo: p.cant ? 'descripcion+cantidad' : 'descripcion',
      confianza: Math.min(1, Math.round(p.s * 100) / 100) };
  });

  return {
    matches: res.map((r, i) => ({ ix_factura: i, ...r })),
    orden_sin_factura: O.map((o, j) => j).filter(j => !usados.has(j)),
  };
}

// ── Imputación que hereda la factura ──────────────────────────
// Siempre per-item: aunque la orden tenga un solo objetivo, la factura puede
// traer un ítem que no estaba y ese se asigna aparte. Los ítems sin match
// quedan con el objetivo más frecuente de la orden como SUGERENCIA, marcados
// para que quien carga los confirme.
function imputacionDesdeOrden(orden, matches, itemsFactura) {
  const oi = (orden && orden.items) || [];
  const assignments = {};
  const sin_asignar = [];

  // Objetivo dominante de la orden, para sugerir en los que no matchearon.
  const cuenta = {};
  oi.forEach(o => { if (o.objetivo) cuenta[o.objetivo] = (cuenta[o.objetivo] || 0) + 1; });
  const sugerido = Object.keys(cuenta).sort((a, b) => cuenta[b] - cuenta[a])[0] || '';
  const unidadSug = (oi.find(o => o.objetivo === sugerido) || {}).unidad || '';

  (itemsFactura || []).forEach((f, i) => {
    const m = (matches || []).find(x => x.ix_factura === i);
    const o = m && m.ix_orden != null ? oi[m.ix_orden] : null;
    if (o) {
      assignments[i] = {
        objetivo: o.objetivo || '',
        unidad: o.unidad || '',
        comentario: o.comentario || `${orden.numero || 'OC'} · ${o.descripcion || ''}`.trim(),
        desde_orden: true, metodo: m.metodo,
      };
    } else {
      sin_asignar.push(i);
      assignments[i] = {
        objetivo: sugerido, unidad: unidadSug, comentario: '',
        desde_orden: false, sugerido: !!sugerido,
      };
    }
  });
  return { assignmentMode: 'per-item', assignments, sin_asignar };
}

// ── Diferencia contra lo cotizado ─────────────────────────────
function diferenciaVsCotizado(orden, totalFactura) {
  const cot = Number(orden && orden.total_estimado) || 0;
  const fac = Number(totalFactura) || 0;
  const dif = Math.round((fac - cot) * 100) / 100;
  return {
    cotizado: cot, facturado: fac, diferencia: dif,
    pct: cot ? Math.round(dif / cot * 1000) / 10 : null,
    sin_cotizacion: !cot,
  };
}

// ── Fraccionamiento ───────────────────────────────────────────
// Dos compras de $450.000 al mismo proveedor y objetivo en la misma semana
// son una de $900.000 partida para no pasar el tramo. Se suma lo abierto de
// los últimos días y, si la suma cruza un umbral que la compra sola no cruza,
// se avisa. No frena: avisa.
function detectarFraccionamiento(nueva, abiertas, dias) {
  const ventana = (dias || FRACCIONAMIENTO_DIAS) * 86400000;
  const ref = new Date(nueva.fecha || Date.now()).getTime();
  const provN = norm(nueva.proveedor), cuitN = String(nueva.cuit || '').replace(/\D/g, '');
  const objs = new Set((nueva.items || []).map(i => norm(i.objetivo)).filter(Boolean));

  const cercanas = (abiertas || []).filter(o => {
    if (o.id && nueva.id && o.id === nueva.id) return false;
    if (o.estado === 'anulada') return false;
    const t = new Date(o.fecha || o.created_at || 0).getTime();
    if (!t || Math.abs(ref - t) > ventana) return false;
    const mismoProv = (cuitN && String(o.cuit || '').replace(/\D/g, '') === cuitN)
      || (provN && norm(o.proveedor) === provN);
    if (!mismoProv) return false;
    const objsO = (o.items || []).map(i => norm(i.objetivo)).filter(Boolean);
    return objsO.some(x => objs.has(x));
  });
  if (!cercanas.length) return { aviso: false, suma: Number(nueva.total_estimado) || 0, ordenes: [] };

  const suma = cercanas.reduce((s, o) => s + (Number(o.total_estimado) || 0), Number(nueva.total_estimado) || 0);
  const tramoSola = tramoDeMonto(nueva.total_estimado);
  const tramoSuma = tramoDeMonto(suma);
  const orden = ['directa', 'presupuesto', 'comparativos'];
  const cruza = orden.indexOf(tramoSuma) > orden.indexOf(tramoSola);
  return {
    aviso: cruza, suma, tramo_sola: tramoSola, tramo_suma: tramoSuma,
    ordenes: cercanas.map(o => o.numero || o.id),
  };
}

// ── Órdenes que nacen de un pedido ────────────────────────────
// Repuestos: al aprobar (cotizado → a_comprar) ya hay proveedor, precio,
// ítems y la imputación de la reparación. La orden es esa información con
// número.
function ordenDesdeRepuesto(ped, inc, centros, unidadesTexto) {
  const objRaw = inc && inc.objetivos ? inc.objetivos.nombre : null;
  const cc = resolverCentroCosto(objRaw, centros);
  const unidad = unidadTexto(inc && inc.numero_unidad, unidadesTexto);
  const ref = `Reparación #${String(inc && inc.id || '').slice(0, 6)}`;
  const falla = inc && inc.tipo_falla ? ` · ${inc.tipo_falla}` : '';
  const comentario = `${ref} · ${inc && inc.numero_unidad ? inc.numero_unidad : (inc && inc.tipo_equipo) || 'equipo'}${falla}`;
  const items = (Array.isArray(ped.items) ? ped.items : []).map(i => ({
    descripcion: i.descripcion, cantidad: Number(i.cantidad) || 1, codigo: i.codigo || null,
    precio: null, objetivo: cc ? cc.nombre : (objRaw || ''), unidad, comentario,
  }));
  const total = Number(ped.nota_precio) || 0;
  return {
    origen_tipo: 'repuesto', origen_id: ped.id,
    proveedor: ped.nota_proveedor || null, cuit: null,
    fecha: new Date().toISOString().slice(0, 10),
    descripcion: `${ref} · ${ped.marca_modelo || (inc && inc.tipo_equipo) || ''}`.trim(),
    items, total_estimado: total,
    tramo: tramoDeMonto(total),
    sin_cotizacion: !total,
    cotizaciones: total ? [{ proveedor: ped.nota_proveedor, precio: total, plazo: ped.nota_plazo || null, elegida: true, origen: 'nota de pedido' }] : [],
    objetivo_pendiente: !cc,
    objetivo_original: cc ? null : objRaw,
    estado: 'abierta',
  };
}

// Insumos: el pedido tiene ítems y objetivo pero NO proveedor ni precio (se
// compra en el momento). La orden nace como borrador con la imputación
// resuelta; proveedor y precio los completa la foto del remito o Owen.
function ordenDesdeInsumo(ped, items, centros) {
  const objRaw = ped && ped.objetivos ? ped.objetivos.nombre : (ped.objetivo_nombre || null);
  const cc = resolverCentroCosto(objRaw, centros);
  const comentario = `Pedido de insumos${ped.capataz_nombre ? ' · ' + ped.capataz_nombre : ''}`;
  return {
    origen_tipo: 'insumo', origen_id: ped.id,
    proveedor: null, cuit: null,
    fecha: new Date().toISOString().slice(0, 10),
    descripcion: `Insumos · ${objRaw || 'sin objetivo'}`,
    items: (items || []).map(i => ({
      descripcion: i.item, cantidad: Number(String(i.cantidad || '').replace(/[^\d.,]/g, '').replace(',', '.')) || 1,
      codigo: null, precio: null, objetivo: cc ? cc.nombre : (objRaw || ''), unidad: '', comentario,
    })),
    total_estimado: 0, tramo: 'directa', sin_cotizacion: true, cotizaciones: [],
    objetivo_pendiente: !cc, objetivo_original: cc ? null : objRaw,
    estado: 'borrador',
  };
}

// La unidad en Compras es un texto "U22 — Toyota Hilux — KCG906 — Luis". Se
// busca el que contenga la patente/código de la incidencia.
function unidadTexto(numeroUnidad, unidadesTexto) {
  const n = normCodigo(numeroUnidad);
  if (!n) return '';
  const hit = (unidadesTexto || []).find(u => normCodigo(u).includes(n));
  return hit || '';
}

// Total estimado de una orden = suma de precio × cantidad de los ítems, o el
// total que venga de la cotización si los ítems no tienen precio.
function totalDeItems(items) {
  return Math.round((items || []).reduce((s, i) => s + (Number(i.precio) || 0) * (Number(i.cantidad) || 1), 0) * 100) / 100;
}

module.exports = {
  TRAMOS, LABEL_TRAMO, FRACCIONAMIENTO_DIAS,
  tramoDeMonto, cotizacionesRequeridas, norm, normCodigo, tokens,
  resolverCentroCosto, siguienteNumero,
  similitudDescripcion, emparejarItems, imputacionDesdeOrden, diferenciaVsCotizado,
  detectarFraccionamiento, ordenDesdeRepuesto, ordenDesdeInsumo, unidadTexto, totalDeItems,
};
