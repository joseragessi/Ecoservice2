// ============================================================
// COST INTELLIGENCE V2.4 - ECOSERVICE
// ============================================================
// Inteligencia semanal de consumo y costo.
//
// V2.4 agrega clasificación automática usando información que
// YA existe en el módulo Combustible:
//
// 1) familia_consumo explícita                        -> se respeta
// 2) destino = unidad                                -> vehiculo
// 3) destino = equipo + nombre identificable         -> familia real
// 4) producto de nafta destinado a objetivo/bidón    -> dos_tiempos
// 5) gasoil/diesel + objetivo con tractor            -> tractor
// 6) caso ambiguo                                    -> sólo total
//
// La clasificación queda además persistida en
// cargas_combustible_items.familia_consumo / familia_origen
// para que el dato gane calidad con el tiempo.
//
// TOTAL:
//   compara litros semanales vs historia propia del objetivo.
//
// FAMILIAS:
//   compara litros/equipo cuando el parque es confiable.
//
// IMPACTO ECONÓMICO:
//   valida el precio de la semana contra referencia histórica.
// ============================================================
 
const supabase = require('./supabase');
const {
  agruparPorFamilia,
  familiaConsumo,
  FAMILIAS_CON_MOTOR,
} = require('./familias_consumo');
 
// ============================================================
// CONFIGURACIÓN
// ============================================================
 
const GRANULARIDAD = 'semanal';
const VENTANA_SEMANAS = 8;
const MIN_MUESTRAS_ANOMALIA = 5;
const UMBRAL_MINIMO_PCT = 15;
const MULTIPLICADOR_DISPERSION = 2;
const CAMBIO_MAX_PARQUE_PCT = 50;
const DESVIO_PRECIO_MAX_PCT = 35;
const COBERTURA_FAMILIAS_MIN_PCT = 80;
 
const FAMILIAS_NO_ALERTABLES = ['bidones', 'unidades'];
const FAMILIAS_NORMALIZABLES = ['dos_tiempos', 'tractor', 'cortadora', 'vehiculo', 'fijo'];
const OBJETIVOS_NO_OPERATIVOS = ['deposito'];
 
// ============================================================
// UTILIDADES
// ============================================================
 
function numero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
 
function redondear(valor, decimales = 2) {
  const p = 10 ** decimales;
  return Math.round((numero(valor) + Number.EPSILON) * p) / p;
}
 
function promedio(valores) {
  const arr = (valores || []).map(Number).filter(Number.isFinite);
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
 
function mediana(valores) {
  const arr = (valores || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const m = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
}
 
function desviacionEstandar(valores) {
  const arr = (valores || []).map(Number).filter(Number.isFinite);
  if (arr.length < 2) return 0;
  const media = promedio(arr);
  const vari = arr.reduce((s, v) => s + Math.pow(v - media, 2), 0) / arr.length;
  return Math.sqrt(vari);
}
 
function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}
 
function esFamiliaMotor(familia) {
  return FAMILIAS_CON_MOTOR.includes(String(familia || '').trim());
}
 
// ============================================================
// FECHA CÓRDOBA / UTC
// ============================================================
 
function hoyCordoba() {
  return new Date().toLocaleDateString('sv-SE', {
    timeZone: 'America/Argentina/Cordoba',
  });
}
 
function periodoActualCba() {
  return hoyCordoba().slice(0, 7);
}
 
function fechaUTC(texto) {
  return new Date(`${texto}T00:00:00Z`);
}
 
function fechaISO(fecha) {
  return fecha.toISOString().slice(0, 10);
}
 
function sumarDias(fechaTexto, cantidad) {
  const fecha = fechaUTC(fechaTexto);
  fecha.setUTCDate(fecha.getUTCDate() + cantidad);
  return fechaISO(fecha);
}
 
function primerDiaPeriodo(periodo) {
  return `${periodo}-01`;
}
 
function limiteSuperiorMes(periodo) {
  const [anio, mes] = periodo.split('-').map(Number);
  if (mes === 12) return `${anio + 1}-01-01`;
  return `${anio}-${String(mes + 1).padStart(2, '0')}-01`;
}
 
// ============================================================
// SEMANAS
// ============================================================
 
function inicioSemana(fechaTexto) {
  const fecha = fechaUTC(fechaTexto);
  const dia = fecha.getUTCDay();
  const diferencia = dia === 0 ? -6 : 1 - dia;
  fecha.setUTCDate(fecha.getUTCDate() + diferencia);
  return fechaISO(fecha);
}
 
function semanaSiguiente(semana) {
  return sumarDias(semana, 7);
}
 
function semanaAnterior(semana, cantidad = 1) {
  return sumarDias(semana, -7 * cantidad);
}
 
function semanasDelMes(periodo) {
  const inicioMes = primerDiaPeriodo(periodo);
  const finMes = limiteSuperiorMes(periodo);
  let semana = inicioSemana(inicioMes);
  const resultado = [];
  while (semana < finMes) {
    resultado.push(semana);
    semana = semanaSiguiente(semana);
  }
  return resultado;
}
 
// ============================================================
// DÍAS HÁBILES
// ============================================================
 
function esDiaHabil(fecha) {
  const d = fecha.getUTCDay();
  return d !== 0 && d !== 6;
}
 
function diasHabilesEntre(desdeTexto, hastaExclusivoTexto) {
  let fecha = fechaUTC(desdeTexto);
  const hasta = fechaUTC(hastaExclusivoTexto);
  let cantidad = 0;
  while (fecha < hasta) {
    if (esDiaHabil(fecha)) cantidad++;
    fecha.setUTCDate(fecha.getUTCDate() + 1);
  }
  return cantidad;
}
 
function factorSemanaTranscurrida(semana) {
  const hoy = hoyCordoba();
  const fin = semanaSiguiente(semana);
  if (semana > hoy) return 0;
  if (fin <= hoy) return 1;
 
  const totalHabiles = diasHabilesEntre(semana, fin);
  const manana = sumarDias(hoy, 1);
  const transcurridos = diasHabilesEntre(semana, manana);
  if (totalHabiles <= 0) return 1;
  return Math.max(0.01, Math.min(1, transcurridos / totalHabiles));
}
 
// ============================================================
// OBJETIVOS
// ============================================================
 
function esObjetivoNoOperativo(nombre) {
  const n = normalizarTexto(nombre);
  return OBJETIVOS_NO_OPERATIVOS.some(p => n === p || n.includes(`${p} `) || n.includes(` ${p}`));
}
 
async function cargarMapaObjetivos() {
  const { data, error } = await supabase
    .from('objetivos')
    .select('id, nombre, activo, tipo');
 
  if (error) throw error;
 
  const lista = data || [];
  const porId = {};
  const porNombre = {};
 
  for (const objetivo of lista) {
    porId[objetivo.id] = objetivo;
    porNombre[normalizarTexto(objetivo.nombre)] = objetivo;
  }
 
  return { lista, porId, porNombre };
}
 
// ============================================================
// PARQUE POR OBJETIVO
// ============================================================
 
async function obtenerParque(periodo) {
  const mapaObjetivos = await cargarMapaObjetivos();
 
  const { data: censos, error } = await supabase
    .from('censos_stock')
    .select(`
      id,
      objetivo_id,
      periodo,
      estado,
      respondido_at,
      censos_stock_items(
        tipo_equipo,
        cantidad,
        numeros
      )
    `)
    .eq('estado', 'respondido')
    .lte('periodo', periodo)
    .order('periodo', { ascending: false });
 
  if (error) throw error;
 
  const ultimoCenso = {};
  for (const censo of censos || []) {
    if (!censo.objetivo_id) continue;
    if (!ultimoCenso[censo.objetivo_id]) ultimoCenso[censo.objetivo_id] = censo;
  }
 
  const resultado = {};
 
  for (const objetivo of mapaObjetivos.lista) {
    const censo = ultimoCenso[objetivo.id];
    const familias = censo
      ? agruparPorFamilia(censo.censos_stock_items || [])
      : agruparPorFamilia([]);
 
    resultado[objetivo.id] = {
      objetivo_id: objetivo.id,
      objetivo_nombre: objetivo.nombre,
      censo_id: censo ? censo.id : null,
      censo_periodo: censo ? censo.periodo : null,
      total: familias.total || 0,
      con_motor: familias.con_motor || 0,
      dos_tiempos: familias.dos_tiempos || 0,
      cortadora: familias.cortadora || 0,
      tractor: familias.tractor || 0,
      vehiculo: familias.vehiculo || 0,
      fijo: familias.fijo || 0,
      sin_motor: familias.sin_motor || 0,
      otro: familias.otro || 0,
    };
  }
 
  return resultado;
}
 
// ============================================================
// V2.4 - CLASIFICACIÓN AUTOMÁTICA DE COMBUSTIBLE
// ============================================================
 
function productoEsNafta(producto) {
  const p = normalizarTexto(producto);
  if (!p) return false;
 
  // Señales explícitas de nafta.
  if (/\bnafta\b|\bsuper\b|\bnafta super\b|\bv[- ]?power nafta\b|\bquantium nafta\b/.test(p)) {
    return true;
  }
 
  // "Infinia" solo se toma como nafta si no dice diesel/gasoil.
  if (/\binfinia\b/.test(p) && !/diesel|gasoil|gasoil/.test(p)) {
    return true;
  }
 
  return false;
}
 
function productoEsDiesel(producto) {
  const p = normalizarTexto(producto);
  if (!p) return false;
  return /diesel|gasoil|gasoil|euro diesel|infinia diesel|v[- ]?power diesel/.test(p);
}
 
/**
 * Resuelve la familia sin inventar información.
 *
 * Prioridad:
 * A. familia explícita ya guardada
 * B. destino unidad -> vehículo
 * C. destino equipo + nombre -> familiaConsumo(nombre)
 * D. nafta a objetivo/bidón -> dos_tiempos
 * E. diesel a objetivo/bidón + tractor en parque -> tractor
 * F. ambiguo -> null (queda sólo en TOTAL)
 */
function resolverFamiliaConsumo(item, carga, parqueObjetivo) {
  const explicita = String(item.familia_consumo || '').trim();
  const origenExistente = String(item.familia_origen || '').trim();
 
  if (esFamiliaMotor(explicita)) {
    return {
      familia: explicita,
      origen: origenExistente || 'explicita',
      confianza: 'alta',
    };
  }
 
  const destino = normalizarTexto(item.destino || carga.destino);
  const detalle = String(item.destino_detalle || '').trim();
  const producto = String(item.producto || '').trim();
 
  // Si el capataz dijo que fue a "la unidad", es combustible de vehículo.
  // IMPORTANTE: no usamos solamente unidad_id porque un destino="equipo"
  // puede apuntar internamente a una unidad del maestro (tractor, bobcat, etc.).
  if (destino === 'unidad') {
    return {
      familia: 'vehiculo',
      origen: 'destino_unidad',
      confianza: 'alta',
    };
  }
 
  // Si fue a un equipo concreto y tenemos su nombre, usamos el clasificador
  // existente de familias_consumo.js.
  if (destino === 'equipo' && detalle) {
    const f = familiaConsumo(detalle);
    if (esFamiliaMotor(f)) {
      return {
        familia: f,
        origen: 'equipo_identificado',
        confianza: 'alta',
      };
    }
  }
 
  // Regla operativa definida para Ecoservice:
  // nafta enviada al objetivo/bidones alimenta parque de 2 tiempos.
  if (productoEsNafta(producto)) {
    return {
      familia: 'dos_tiempos',
      origen: 'producto_nafta',
      confianza: 'alta',
    };
  }
 
  // Regla operativa definida para Ecoservice:
  // diesel/gasoil destinado al objetivo con tractor existente -> tractor.
  if (productoEsDiesel(producto) && numero(parqueObjetivo && parqueObjetivo.tractor) > 0) {
    return {
      familia: 'tractor',
      origen: 'producto_diesel_parque_tractor',
      confianza: 'media',
    };
  }
 
  return {
    familia: null,
    origen: 'sin_clasificar',
    confianza: 'baja',
  };
}
 
async function persistirClasificaciones(updates) {
  const unicos = new Map();
 
  for (const u of updates || []) {
    if (!u.id || !u.familia_consumo) continue;
    unicos.set(u.id, u);
  }
 
  const filas = [...unicos.values()];
  if (!filas.length) return { actualizados: 0 };
 
  let actualizados = 0;
 
  // Update individual intencional: no necesitamos conocer todas las columnas
  // obligatorias del item para hacer un upsert completo.
  for (const fila of filas) {
    const { error } = await supabase
      .from('cargas_combustible_items')
      .update({
        familia_consumo: fila.familia_consumo,
        familia_origen: fila.familia_origen,
      })
      .eq('id', fila.id);
 
    if (error) {
      console.warn('[cost-intelligence V2.4] no pude persistir clasificación item', fila.id, error.message);
      continue;
    }
 
    actualizados++;
  }
 
  return { actualizados };
}
 
// ============================================================
// PRECIOS DE CARGAS
// ============================================================
 
function obtenerCandidatosPrecio(cargas) {
  const candidatos = [];
 
  for (const carga of cargas || []) {
    const items = Array.isArray(carga.cargas_combustible_items)
      ? carga.cargas_combustible_items
      : [];
 
    for (const item of items) {
      if (item.es_combustible === false) continue;
      const litros = numero(item.litros);
      const precioUnit = numero(item.precio_unit);
      const subtotal = numero(item.subtotal);
 
      if (precioUnit > 0) {
        candidatos.push(precioUnit);
      } else if (subtotal > 0 && litros > 0) {
        candidatos.push(subtotal / litros);
      }
    }
 
    const litrosCarga = numero(carga.litros_total);
    const totalCarga = numero(carga.total);
    if (litrosCarga > 0 && totalCarga > 0) candidatos.push(totalCarga / litrosCarga);
  }
 
  return candidatos.filter(p => Number.isFinite(p) && p > 0);
}
 
function calcularPrecioReferencia(cargas) {
  const candidatos = obtenerCandidatosPrecio(cargas);
  if (!candidatos.length) return 0;
  const inicial = mediana(candidatos);
  if (inicial <= 0) return 0;
  const filtrados = candidatos.filter(p => p >= inicial * 0.5 && p <= inicial * 2);
  return filtrados.length ? mediana(filtrados) : inicial;
}
 
function precioEsRazonable(precio, referencia) {
  if (precio <= 0) return false;
  if (referencia <= 0) return true;
  return precio >= referencia * 0.5 && precio <= referencia * 2;
}
 
function calcularImporteItem({ item, carga, litrosItem, litrosCombustibleCarga, precioReferencia }) {
  const subtotal = numero(item.subtotal);
  if (subtotal > 0 && litrosItem > 0) {
    const precio = subtotal / litrosItem;
    if (precioEsRazonable(precio, precioReferencia)) return subtotal;
  }
 
  const precioUnit = numero(item.precio_unit);
  if (precioUnit > 0 && litrosItem > 0 && precioEsRazonable(precioUnit, precioReferencia)) {
    return precioUnit * litrosItem;
  }
 
  const totalCarga = numero(carga.total);
  if (totalCarga > 0 && litrosCombustibleCarga > 0) {
    const precioCarga = totalCarga / litrosCombustibleCarga;
    if (precioEsRazonable(precioCarga, precioReferencia)) {
      return totalCarga * (litrosItem / litrosCombustibleCarga);
    }
  }
 
  if (precioReferencia > 0) return litrosItem * precioReferencia;
  return 0;
}
 
// ============================================================
// CONSUMO SEMANAL V2.4
// ============================================================
 
async function obtenerConsumoSemana(semana) {
  const hasta = semanaSiguiente(semana);
 
  const { data: cargas, error } = await supabase
    .from('cargas_combustible')
    .select(`
      id,
      fecha,
      estado,
      destino,
      total,
      litros_total,
      objetivo_id,
      unidad_id,
      patente_raw,
      objetivos(id,nombre),
      cargas_combustible_items(
        id,
        litros,
        producto,
        es_combustible,
        precio_unit,
        subtotal,
        destino,
        unidad_id,
        equipo_id,
        objetivo_id,
        destino_detalle,
        familia_consumo,
        familia_origen
      )
    `)
    .gte('fecha', semana)
    .lt('fecha', hasta)
    .neq('estado', 'anulada')
    .limit(10000);
 
  if (error) throw error;
 
  const listaCargas = cargas || [];
  if (!listaCargas.length) return [];
 
  const mapaObjetivos = await cargarMapaObjetivos();
  const parque = await obtenerParque(semana.slice(0, 7));
  const precioReferencia = calcularPrecioReferencia(listaCargas);
 
  console.log(`[cost-intelligence V2.4] ${semana} precio ref: $${redondear(precioReferencia, 2)}/L`);
 
  const agrupado = {};
  const actualizacionesFamilia = [];
 
  function clave(objetivoId, objetivoNombre, familia) {
    return `${objetivoId || normalizarTexto(objetivoNombre) || 'sin_objetivo'}::${familia}`;
  }
 
  function sumar({ objetivoId, objetivoNombre, familia, litros, importe, cargaId }) {
    const k = clave(objetivoId, objetivoNombre, familia);
 
    if (!agrupado[k]) {
      agrupado[k] = {
        objetivo_id: objetivoId || null,
        objetivo_nombre: objetivoNombre || 'Sin objetivo',
        familia,
        litros: 0,
        importe: 0,
        cargas: new Set(),
      };
    }
 
    agrupado[k].litros += numero(litros);
    agrupado[k].importe += numero(importe);
    if (cargaId) agrupado[k].cargas.add(cargaId);
  }
 
  for (const carga of listaCargas) {
    const items = Array.isArray(carga.cargas_combustible_items)
      ? carga.cargas_combustible_items
      : [];
 
    const objetivoCargaId =
      carga.objetivo_id ||
      (carga.objetivos && carga.objetivos.id) ||
      null;
 
    const objetivoCarga = objetivoCargaId ? mapaObjetivos.porId[objetivoCargaId] : null;
 
    const objetivoCargaNombre =
      (carga.objetivos && carga.objetivos.nombre) ||
      (objetivoCarga && objetivoCarga.nombre) ||
      null;
 
    // Cargas históricas sin items: mantenemos TOTAL + UNIDADES.
    // No inventamos una familia porque no tenemos el producto/reparto.
    if (!items.length) {
      const litros = numero(carga.litros_total);
      if (litros <= 0 || !objetivoCargaId) continue;
 
      let importe = numero(carga.total);
      if (importe <= 0 && precioReferencia > 0) importe = litros * precioReferencia;
 
      sumar({
        objetivoId: objetivoCargaId,
        objetivoNombre: objetivoCargaNombre,
        familia: 'total',
        litros,
        importe,
        cargaId: carga.id,
      });
 
      sumar({
        objetivoId: objetivoCargaId,
        objetivoNombre: objetivoCargaNombre,
        familia: 'unidades',
        litros,
        importe,
        cargaId: carga.id,
      });
 
      continue;
    }
 
    const itemsCombustible = items.filter(i => i.es_combustible !== false);
 
    let litrosCombustibleCarga = itemsCombustible.reduce((s, i) => s + numero(i.litros), 0);
    if (litrosCombustibleCarga <= 0) litrosCombustibleCarga = numero(carga.litros_total);
 
    for (const item of itemsCombustible) {
      const litros = numero(item.litros);
      if (litros <= 0) continue;
 
      const importe = calcularImporteItem({
        item,
        carga,
        litrosItem: litros,
        litrosCombustibleCarga,
        precioReferencia,
      });
 
      const destino = normalizarTexto(item.destino || carga.destino);
      const esBidon = destino === 'bidon';
 
      // ------------------------------------------------------
      // Resolver objetivo del reparto
      // ------------------------------------------------------
      let objetivoId = item.objetivo_id || objetivoCargaId || null;
      let objetivoNombre = null;
 
      if (objetivoId && mapaObjetivos.porId[objetivoId]) {
        objetivoNombre = mapaObjetivos.porId[objetivoId].nombre;
      }
 
      if (!objetivoId && esBidon && item.destino_detalle) {
        const raw = String(item.destino_detalle).trim();
        const encontrado = mapaObjetivos.porNombre[normalizarTexto(raw)];
        if (encontrado) {
          objetivoId = encontrado.id;
          objetivoNombre = encontrado.nombre;
        } else {
          objetivoNombre = raw;
        }
      }
 
      if (!objetivoNombre && objetivoCargaNombre) objetivoNombre = objetivoCargaNombre;
      if (!objetivoId && !objetivoNombre) continue;
 
      // Siempre sumamos TOTAL una sola vez.
      sumar({
        objetivoId,
        objetivoNombre,
        familia: 'total',
        litros,
        importe,
        cargaId: carga.id,
      });
 
      // Dimensión de destino, útil para auditoría pero no alertable.
      sumar({
        objetivoId,
        objetivoNombre,
        familia: esBidon ? 'bidones' : 'unidades',
        litros,
        importe,
        cargaId: carga.id,
      });
 
      // ------------------------------------------------------
      // V2.4: familia automática
      // ------------------------------------------------------
      const parqueObjetivo = objetivoId ? parque[objetivoId] : null;
      const clasificacion = resolverFamiliaConsumo(item, carga, parqueObjetivo);
 
      if (clasificacion.familia) {
        sumar({
          objetivoId,
          objetivoNombre,
          familia: clasificacion.familia,
          litros,
          importe,
          cargaId: carga.id,
        });
 
        // Sólo persistimos si no había una familia explícita válida.
        if (!esFamiliaMotor(item.familia_consumo)) {
          actualizacionesFamilia.push({
            id: item.id,
            familia_consumo: clasificacion.familia,
            familia_origen: clasificacion.origen,
          });
        }
      }
    }
  }
 
  // Persistencia best-effort: si falla una actualización, el cálculo actual
  // sigue siendo válido porque ya se clasificó en memoria.
  const persistencia = await persistirClasificaciones(actualizacionesFamilia);
  if (persistencia.actualizados > 0) {
    console.log(`[cost-intelligence V2.4] ${semana}: ${persistencia.actualizados} items clasificados/persistidos`);
  }
 
  return Object.values(agrupado).map(fila => ({
    ...fila,
    litros: redondear(fila.litros, 2),
    importe: Math.round(fila.importe),
    cantidad_cargas: fila.cargas.size,
  }));
}
 
// ============================================================
// RESOLVER OBJETIVOS
// ============================================================
 
async function resolverObjetivos(consumos) {
  const mapa = await cargarMapaObjetivos();
 
  return consumos.map(consumo => {
    if (consumo.objetivo_id) {
      const encontrado = mapa.porId[consumo.objetivo_id];
      return encontrado
        ? { ...consumo, objetivo_nombre: encontrado.nombre }
        : consumo;
    }
 
    const encontrado = mapa.porNombre[normalizarTexto(consumo.objetivo_nombre)];
    if (!encontrado) return consumo;
 
    return {
      ...consumo,
      objetivo_id: encontrado.id,
      objetivo_nombre: encontrado.nombre,
    };
  });
}
 
// ============================================================
// SNAPSHOT SEMANAL
// ============================================================
 
async function generarSnapshotSemanal(semana) {
  console.log(`[cost-intelligence V2.4] generando ${semana}`);
 
  const periodo = semana.slice(0, 7);
  const [parque, consumoRaw] = await Promise.all([
    obtenerParque(periodo),
    obtenerConsumoSemana(semana),
  ]);
 
  const consumos = await resolverObjetivos(consumoRaw);
  const filas = [];
 
  for (const consumo of consumos) {
    if (!consumo.objetivo_id) continue;
 
    const p = parque[consumo.objetivo_id] || { total: 0, con_motor: 0 };
 
    let parqueFamilia = 0;
    if (FAMILIAS_NORMALIZABLES.includes(consumo.familia)) {
      parqueFamilia = numero(p[consumo.familia]);
    }
 
    const litrosPorEquipo = parqueFamilia > 0 ? consumo.litros / parqueFamilia : null;
    const costoPorEquipo = parqueFamilia > 0 ? consumo.importe / parqueFamilia : null;
 
    filas.push({
      periodo: semana,
      granularidad: GRANULARIDAD,
      objetivo_id: consumo.objetivo_id,
      objetivo_nombre: consumo.objetivo_nombre,
      familia: consumo.familia,
      litros: redondear(consumo.litros, 2),
      importe: Math.round(consumo.importe),
      parque_total: numero(p.total),
      parque_motor: numero(p.con_motor),
      parque_familia: parqueFamilia,
      litros_por_equipo: litrosPorEquipo == null ? null : redondear(litrosPorEquipo, 3),
      costo_por_equipo: costoPorEquipo == null ? null : Math.round(costoPorEquipo),
      cantidad_cargas: numero(consumo.cantidad_cargas),
      updated_at: new Date().toISOString(),
    });
  }
 
  // IMPORTANTE DE AUDITORÍA:
  // no borramos todos los snapshots de la semana antes del upsert.
  // Así evitamos borrar en cascada una anomalía ya revisada/validada.
  // El upsert actualiza las claves existentes y crea las familias nuevas.
  if (!filas.length) {
    return { semana, snapshots: 0 };
  }
 
  const { data, error } = await supabase
    .from('cost_snapshots')
    .upsert(filas, {
      onConflict: 'periodo,granularidad,objetivo_id,familia',
    })
    .select();
 
  if (error) throw error;
 
  return {
    semana,
    snapshots: data ? data.length : 0,
  };
}
 
async function generarSnapshotsSemanalesMes(periodo) {
  const semanas = semanasDelMes(periodo);
  const hoy = hoyCordoba();
  let total = 0;
  const detalle = [];
 
  for (const semana of semanas) {
    if (semana > hoy) continue;
    const resultado = await generarSnapshotSemanal(semana);
    detalle.push(resultado);
    total += numero(resultado.snapshots);
  }
 
  return {
    periodo,
    granularidad: GRANULARIDAD,
    snapshots: total,
    semanas: detalle,
  };
}
 
// ============================================================
// HISTÓRICO / BASELINE
// ============================================================
 
async function obtenerHistorico(semana, objetivoId, familia, ventanas = VENTANA_SEMANAS) {
  const desde = semanaAnterior(semana, ventanas);
 
  const { data, error } = await supabase
    .from('cost_snapshots')
    .select('*')
    .eq('granularidad', GRANULARIDAD)
    .eq('objetivo_id', objetivoId)
    .eq('familia', familia)
    .gte('periodo', desde)
    .lt('periodo', semana)
    .order('periodo', { ascending: true });
 
  if (error) throw error;
  return data || [];
}
 
function construirBaseline(historico) {
  const filas = historico || [];
 
  const litros = filas.map(x => numero(x.litros)).filter(x => x > 0);
  const costos = filas.map(x => numero(x.importe)).filter(x => x > 0);
  const litrosEquipo = filas
    .map(x => x.litros_por_equipo == null ? null : numero(x.litros_por_equipo))
    .filter(x => x != null && x > 0);
  const costosEquipo = filas
    .map(x => x.costo_por_equipo == null ? null : numero(x.costo_por_equipo))
    .filter(x => x != null && x > 0);
  const parque = filas.map(x => numero(x.parque_familia)).filter(x => x > 0);
 
  const consumoBase = mediana(litros);
  const costoBase = mediana(costos);
  const consumoEquipoBase = litrosEquipo.length ? mediana(litrosEquipo) : null;
  const costoEquipoBase = costosEquipo.length ? mediana(costosEquipo) : null;
  const parqueBase = parque.length ? mediana(parque) : 0;
 
  const seriePrincipal = litrosEquipo.length >= MIN_MUESTRAS_ANOMALIA
    ? litrosEquipo
    : litros;
 
  const media = promedio(seriePrincipal);
  const dispersionPct = media > 0
    ? desviacionEstandar(seriePrincipal) / media * 100
    : 0;
 
  return {
    muestras: filas.length,
    consumo_base: consumoBase,
    costo_base: costoBase,
    consumo_por_equipo_base: consumoEquipoBase,
    costo_por_equipo_base: costoEquipoBase,
    parque_base: parqueBase,
    dispersion_pct: redondear(dispersionPct, 2),
  };
}
 
// ============================================================
// PRECIO HISTÓRICO / IMPACTO
// ============================================================
 
function precioSnapshot(snapshot) {
  const litros = numero(snapshot.litros);
  const importe = numero(snapshot.importe);
  if (litros <= 0 || importe <= 0) return 0;
  return importe / litros;
}
 
function calcularPrecioHistorico(historico) {
  const precios = (historico || [])
    .map(precioSnapshot)
    .filter(p => p > 0 && Number.isFinite(p));
 
  if (!precios.length) return { precio: 0, muestras: 0 };
 
  const inicial = mediana(precios);
  const filtrados = precios.filter(p => p >= inicial * 0.5 && p <= inicial * 2);
  const serie = filtrados.length ? filtrados : precios;
 
  return {
    precio: mediana(serie),
    muestras: serie.length,
  };
}
 
function seleccionarPrecioImpacto({ snapshot, historico }) {
  const actual = precioSnapshot(snapshot);
  const hist = calcularPrecioHistorico(historico);
  const referencia = numero(hist.precio);
 
  if (referencia <= 0) {
    return {
      precio: actual,
      origen: actual > 0 ? 'precio_actual' : 'sin_precio',
      precio_actual: actual,
      precio_historico: 0,
      desvio_precio_pct: null,
    };
  }
 
  if (actual <= 0) {
    return {
      precio: referencia,
      origen: 'referencia_historica',
      precio_actual: 0,
      precio_historico: referencia,
      desvio_precio_pct: null,
    };
  }
 
  const desvioPct = ((actual - referencia) / referencia) * 100;
 
  if (Math.abs(desvioPct) > DESVIO_PRECIO_MAX_PCT) {
    return {
      precio: referencia,
      origen: 'referencia_historica',
      precio_actual: actual,
      precio_historico: referencia,
      desvio_precio_pct: desvioPct,
    };
  }
 
  return {
    precio: actual,
    origen: 'precio_actual',
    precio_actual: actual,
    precio_historico: referencia,
    desvio_precio_pct: desvioPct,
  };
}
 
// ============================================================
// CALIDAD DE PARQUE / CONFIANZA / UMBRAL
// ============================================================
 
function evaluarCalidadParque({ parqueActual, parqueHistorico }) {
  const actual = numero(parqueActual);
  const historico = numero(parqueHistorico);
 
  if (actual <= 0 || historico <= 0) {
    return {
      confiable: false,
      cambio_pct: null,
      motivo: 'Sin parque suficiente',
    };
  }
 
  const cambioPct = ((actual - historico) / historico) * 100;
 
  if (Math.abs(cambioPct) > CAMBIO_MAX_PARQUE_PCT) {
    return {
      confiable: false,
      cambio_pct: redondear(cambioPct, 2),
      motivo: 'Cambio abrupto de parque',
    };
  }
 
  return {
    confiable: true,
    cambio_pct: redondear(cambioPct, 2),
    motivo: null,
  };
}
 
function calcularConfianza({ muestras, dispersionPct }) {
  if (muestras < 3) return { nivel: 'insuficiente', score: 0 };
  if (muestras < 5) return { nivel: 'baja', score: 25 };
  if (dispersionPct > 50) return { nivel: 'baja', score: 35 };
  if (muestras >= 7 && dispersionPct <= 25) return { nivel: 'alta', score: 90 };
  if (muestras >= 6 && dispersionPct <= 35) return { nivel: 'alta', score: 80 };
  return { nivel: 'media', score: 60 };
}
 
function calcularUmbral(dispersionPct) {
  return Math.max(
    UMBRAL_MINIMO_PCT,
    numero(dispersionPct) * MULTIPLICADOR_DISPERSION
  );
}
 
// ============================================================
// BASELINES
// ============================================================
 
async function calcularBaselinesSemana(semana, ventanas = VENTANA_SEMANAS) {
  const { data: actuales, error } = await supabase
    .from('cost_snapshots')
    .select('*')
    .eq('periodo', semana)
    .eq('granularidad', GRANULARIDAD);
 
  if (error) throw error;
 
  const filas = [];
 
  for (const snapshot of actuales || []) {
    const historico = await obtenerHistorico(
      semana,
      snapshot.objetivo_id,
      snapshot.familia,
      ventanas
    );
 
    if (!historico.length) continue;
 
    const base = construirBaseline(historico);
 
    filas.push({
      objetivo_id: snapshot.objetivo_id,
      objetivo_nombre: snapshot.objetivo_nombre,
      familia: snapshot.familia,
      granularidad: GRANULARIDAD,
      ventanas,
      consumo_base: redondear(base.consumo_base, 3),
      costo_base: Math.round(base.costo_base),
      parque_base: redondear(base.parque_base, 2),
      consumo_por_equipo_base:
        base.consumo_por_equipo_base == null
          ? null
          : redondear(base.consumo_por_equipo_base, 3),
      costo_por_equipo_base:
        base.costo_por_equipo_base == null
          ? null
          : Math.round(base.costo_por_equipo_base),
      dispersion_pct: redondear(base.dispersion_pct, 2),
      muestras: base.muestras,
      calculado_at: new Date().toISOString(),
    });
  }
 
  if (!filas.length) return { semana, baselines: 0 };
 
  const { data, error: upsertError } = await supabase
    .from('cost_baselines')
    .upsert(filas, {
      onConflict: 'objetivo_id,familia,granularidad',
    })
    .select();
 
  if (upsertError) throw upsertError;
 
  return {
    semana,
    baselines: data ? data.length : 0,
  };
}
 
// ============================================================
// ANOMALÍAS / EXPLICABILIDAD V2.4
// ============================================================
//
// Principios V2.4:
// 1) Una familia real se evalúa por litros/equipo solamente cuando
//    el parque es confiable.
// 2) Si el parque cambia bruscamente o falta, NO convertimos ese
//    problema de datos en una alerta de consumo.
// 3) Si >= 80% del TOTAL de un objetivo está explicado por familias
//    reales, la alerta TOTAL se suprime. Primero mandan las familias.
// 4) Si una familia todavía no tiene 5 muestras comparables queda
//    "en aprendizaje" y no se acusa un desvío.
// 5) Las alertas que el modelo nuevo deja de reproducir no se borran:
//    pasan a estado superada_modelo para conservar auditoría.
// ============================================================
 
function construirMapaCoberturaFamilias(snapshots) {
  const porObjetivo = new Map();
 
  for (const s of snapshots || []) {
    if (!s.objetivo_id) continue;
 
    let x = porObjetivo.get(s.objetivo_id);
    if (!x) {
      x = {
        total_litros: 0,
        litros_clasificados: 0,
        familias: [],
      };
      porObjetivo.set(s.objetivo_id, x);
    }
 
    if (s.familia === 'total') {
      x.total_litros = numero(s.litros);
      continue;
    }
 
    if (FAMILIAS_NORMALIZABLES.includes(s.familia)) {
      x.litros_clasificados += numero(s.litros);
      x.familias.push(s.familia);
    }
  }
 
  for (const x of porObjetivo.values()) {
    const total = numero(x.total_litros);
    const clasificados = Math.min(total, numero(x.litros_clasificados));
 
    x.litros_clasificados = redondear(clasificados, 2);
    x.cobertura_pct = total > 0
      ? redondear((clasificados / total) * 100, 2)
      : 0;
    x.familias = [...new Set(x.familias)];
  }
 
  return porObjetivo;
}
 
async function sincronizarAnomaliasSemana(semana, candidatas) {
  const activasModelo = ['abierta', 'en_revision', 'pendiente', 'superada_modelo'];
 
  const { data: existentes, error } = await supabase
    .from('cost_anomalies')
    .select('id,snapshot_id,metrica,estado,validada')
    .eq('periodo', semana)
    .eq('validada', false)
    .in('estado', activasModelo);
 
  if (error) throw error;
 
  const porClave = new Map(
    (existentes || []).map(a => [`${a.snapshot_id}|${a.metrica}`, a])
  );
 
  const clavesActuales = new Set(
    (candidatas || []).map(a => `${a.snapshot_id}|${a.metrica}`)
  );
 
  let superadas = 0;
  let reactivadas = 0;
  let nuevas = 0;
 
  // Todo lo que estaba activo y ya no lo reproduce V2.4 queda como
  // histórico, sin borrarlo y sin tocar una alerta validada/cerrada.
  for (const a of existentes || []) {
    const clave = `${a.snapshot_id}|${a.metrica}`;
 
    if (!clavesActuales.has(clave) && a.estado !== 'superada_modelo') {
      const { error: upErr } = await supabase
        .from('cost_anomalies')
        .update({
          estado: 'superada_modelo',
          revisado_at: new Date().toISOString(),
        })
        .eq('id', a.id)
        .eq('validada', false);
 
      if (upErr) throw upErr;
      superadas++;
    }
  }
 
  // Insertamos solamente nuevas alertas. Si una alerta que el modelo había
  // superado vuelve a ser válida para la misma snapshot/métrica, la reactivamos.
  for (const candidata of candidatas || []) {
    const clave = `${candidata.snapshot_id}|${candidata.metrica}`;
    const existente = porClave.get(clave);
 
    if (existente) {
      if (existente.estado === 'superada_modelo') {
        const { error: reactErr } = await supabase
          .from('cost_anomalies')
          .update({
            ...candidata,
            estado: 'abierta',
            revisado_at: null,
          })
          .eq('id', existente.id)
          .eq('validada', false);
 
        if (reactErr) throw reactErr;
        reactivadas++;
      }
      continue;
    }
 
    const { error: insErr } = await supabase
      .from('cost_anomalies')
      .insert(candidata);
 
    if (insErr) throw insErr;
    nuevas++;
  }
 
  return {
    detectadas: (candidatas || []).length,
    nuevas,
    reactivadas,
    superadas,
  };
}
 
async function detectarAnomaliasSemana(semana) {
  const { data: snapshots, error } = await supabase
    .from('cost_snapshots')
    .select('*')
    .eq('periodo', semana)
    .eq('granularidad', GRANULARIDAD);
 
  if (error) throw error;
 
  const factorTiempo = factorSemanaTranscurrida(semana);
  const coberturaPorObjetivo = construirMapaCoberturaFamilias(snapshots || []);
 
  let anomalias = [];
  const aprendizaje = [];
  const calidad = [];
  const totalesSuprimidos = [];
 
  for (const snapshot of snapshots || []) {
    if (esObjetivoNoOperativo(snapshot.objetivo_nombre)) continue;
    if (FAMILIAS_NO_ALERTABLES.includes(snapshot.familia)) continue;
 
    const historico = await obtenerHistorico(
      semana,
      snapshot.objetivo_id,
      snapshot.familia,
      VENTANA_SEMANAS
    );
 
    const base = construirBaseline(historico);
    const esFamiliaReal = FAMILIAS_NORMALIZABLES.includes(snapshot.familia);
 
    // Una familia nueva puede estar perfectamente clasificada pero todavía no
    // tiene historia suficiente. Se informa como aprendizaje, no como anomalía.
    if (base.muestras < MIN_MUESTRAS_ANOMALIA) {
      if (esFamiliaReal) {
        aprendizaje.push({
          objetivo_id: snapshot.objetivo_id,
          objetivo_nombre: snapshot.objetivo_nombre,
          familia: snapshot.familia,
          muestras: base.muestras,
          requeridas: MIN_MUESTRAS_ANOMALIA,
          litros: redondear(snapshot.litros, 2),
          parque_familia: numero(snapshot.parque_familia),
          litros_por_equipo: snapshot.litros_por_equipo == null
            ? null
            : redondear(snapshot.litros_por_equipo, 3),
          motivo: 'Historial insuficiente',
        });
      }
      continue;
    }
 
    const confianza = calcularConfianza({
      muestras: base.muestras,
      dispersionPct: base.dispersion_pct,
    });
 
    if (confianza.nivel === 'baja' || confianza.nivel === 'insuficiente') {
      if (esFamiliaReal) {
        aprendizaje.push({
          objetivo_id: snapshot.objetivo_id,
          objetivo_nombre: snapshot.objetivo_nombre,
          familia: snapshot.familia,
          muestras: base.muestras,
          requeridas: MIN_MUESTRAS_ANOMALIA,
          litros: redondear(snapshot.litros, 2),
          parque_familia: numero(snapshot.parque_familia),
          litros_por_equipo: snapshot.litros_por_equipo == null
            ? null
            : redondear(snapshot.litros_por_equipo, 3),
          motivo: 'Historial todavía inestable',
        });
      }
      continue;
    }
 
    let metrica = 'litros';
    let real = numero(snapshot.litros);
    let esperadoSemana = numero(base.consumo_base);
    let calidadDato = 'correcta';
 
    if (esFamiliaReal) {
      const calidadParque = evaluarCalidadParque({
        parqueActual: snapshot.parque_familia,
        parqueHistorico: base.parque_base,
      });
 
      // V2.4: un problema de parque ya no se transforma en "consumo anormal".
      // Lo separamos como calidad de datos.
      if (
        !calidadParque.confiable ||
        snapshot.litros_por_equipo == null ||
        base.consumo_por_equipo_base == null
      ) {
        calidad.push({
          objetivo_id: snapshot.objetivo_id,
          objetivo_nombre: snapshot.objetivo_nombre,
          familia: snapshot.familia,
          parque_actual: numero(snapshot.parque_familia),
          parque_base: redondear(base.parque_base, 2),
          cambio_parque_pct: calidadParque.cambio_pct,
          motivo: calidadParque.motivo || 'Sin indicador litros/equipo comparable',
        });
        continue;
      }
 
      metrica = 'litros_por_equipo';
      real = numero(snapshot.litros_por_equipo);
      esperadoSemana = numero(base.consumo_por_equipo_base);
    }
 
    const esperado = esperadoSemana * factorTiempo;
    if (esperado <= 0) continue;
 
    const diferencia = real - esperado;
    const desvioPct = (diferencia / esperado) * 100;
    const umbral = calcularUmbral(base.dispersion_pct);
 
    // Sólo excesos por ahora.
    if (desvioPct < umbral) continue;
 
    // V2.4: si el TOTAL está prácticamente explicado por familias reales,
    // no generamos una alerta genérica. El mix de maquinaria/producto manda.
    if (snapshot.familia === 'total') {
      const cobertura = coberturaPorObjetivo.get(snapshot.objetivo_id) || {
        cobertura_pct: 0,
        litros_clasificados: 0,
        familias: [],
      };
 
      if (numero(cobertura.cobertura_pct) >= COBERTURA_FAMILIAS_MIN_PCT) {
        totalesSuprimidos.push({
          objetivo_id: snapshot.objetivo_id,
          objetivo_nombre: snapshot.objetivo_nombre,
          litros_total: redondear(snapshot.litros, 2),
          litros_clasificados: redondear(cobertura.litros_clasificados, 2),
          cobertura_pct: redondear(cobertura.cobertura_pct, 2),
          familias: cobertura.familias,
          desvio_total_pct: redondear(desvioPct, 2),
          motivo: 'Total explicado por familias de consumo',
        });
        continue;
      }
    }
 
    let litrosEsperados;
    if (metrica === 'litros_por_equipo') {
      litrosEsperados = esperado * numero(snapshot.parque_familia);
    } else {
      litrosEsperados = esperado;
    }
 
    const litrosExceso = Math.max(0, numero(snapshot.litros) - litrosEsperados);
 
    const precio = seleccionarPrecioImpacto({ snapshot, historico });
    const impacto = litrosExceso * numero(precio.precio);
 
    let severidad = 'media';
    if (desvioPct >= 60) severidad = 'critica';
    else if (desvioPct >= 35) severidad = 'alta';
 
    if (precio.origen === 'referencia_historica') {
      calidadDato = calidadDato === 'correcta'
        ? 'Precio actual atípico'
        : `${calidadDato}; precio actual atípico`;
    }
 
    anomalias.push({
      snapshot_id: snapshot.id,
      periodo: snapshot.periodo,
      objetivo_id: snapshot.objetivo_id,
      objetivo_nombre: snapshot.objetivo_nombre,
      familia: snapshot.familia,
      metrica,
      esperado: redondear(esperado, 3),
      real: redondear(real, 3),
      desvio_abs: redondear(diferencia, 3),
      desvio_pct: redondear(desvioPct, 2),
      litros_exceso: redondear(litrosExceso, 2),
      impacto_estimado: Math.max(0, Math.round(impacto)),
      precio_utilizado: redondear(precio.precio, 2),
      precio_origen: precio.origen,
      confianza_nivel: confianza.nivel,
      confianza_score: confianza.score,
      muestras_historicas: base.muestras,
      dispersion_pct: redondear(base.dispersion_pct, 2),
      umbral_pct: redondear(umbral, 2),
      calidad_dato: calidadDato,
      severidad,
      estado: 'abierta',
    });
  }
 
  // Si existe una alerta específica por familia, nunca duplicamos con TOTAL.
  const objetivosConAlertaEspecifica = new Set(
    anomalias
      .filter(a => a.familia !== 'total')
      .map(a => a.objetivo_id)
      .filter(Boolean)
  );
 
  anomalias = anomalias.filter(a =>
    a.familia !== 'total' ||
    !objetivosConAlertaEspecifica.has(a.objetivo_id)
  );
 
  const sync = await sincronizarAnomaliasSemana(semana, anomalias);
 
  return {
    semana,
    anomalias: anomalias.length,
    nuevas: sync.nuevas,
    reactivadas: sync.reactivadas,
    superadas: sync.superadas,
    en_aprendizaje: aprendizaje.length,
    calidad_datos: calidad.length,
    totales_suprimidos: totalesSuprimidos.length,
    detalle_aprendizaje: aprendizaje,
    detalle_calidad: calidad,
    detalle_totales_suprimidos: totalesSuprimidos,
  };
}
 
// ============================================================
// EJECUCIÓN
// ============================================================
 
async function analizarSemana(semana) {
  const snapshot = await generarSnapshotSemanal(semana);
  const baseline = await calcularBaselinesSemana(semana, VENTANA_SEMANAS);
  const anomalias = await detectarAnomaliasSemana(semana);
 
  return {
    semana,
    snapshot,
    baseline,
    anomalias,
  };
}
 
async function ejecutarCostIntelligence(periodo = periodoActualCba()) {
  const inicio = Date.now();
 
  if (!/^\d{4}-\d{2}$/.test(periodo)) {
    throw new Error('Periodo inválido. Usá formato YYYY-MM');
  }
 
  console.log('================================================');
  console.log(`[cost-intelligence V2.4] procesando ${periodo}`);
 
  const semanas = semanasDelMes(periodo);
  const hoy = hoyCordoba();
  const resultados = [];
 
  let totalSnapshots = 0;
  let totalBaselines = 0;
  let totalAnomalias = 0;
 
  for (const semana of semanas) {
    if (semana > hoy) continue;
 
    console.log(`[cost-intelligence V2.4] semana ${semana}`);
    const resultado = await analizarSemana(semana);
    resultados.push(resultado);
 
    totalSnapshots += numero(resultado.snapshot.snapshots);
    totalBaselines += numero(resultado.baseline.baselines);
    totalAnomalias += numero(resultado.anomalias.anomalias);
  }
 
  const resultadoFinal = {
    ok: true,
    version: '2.4',
    periodo,
    granularidad: GRANULARIDAD,
    semanas_procesadas: resultados.length,
    snapshot: { periodo, snapshots: totalSnapshots },
    baseline: { periodo, baselines: totalBaselines },
    anomalias: { periodo, anomalias: totalAnomalias },
    detalle_semanas: resultados,
    duracion_ms: Date.now() - inicio,
  };
 
  console.log('[cost-intelligence V2.4] finalizado', {
    periodo,
    semanas: resultados.length,
    snapshots: totalSnapshots,
    baselines: totalBaselines,
    anomalias: totalAnomalias,
  });
  console.log('================================================');
 
  return resultadoFinal;
}
 
// ============================================================
// COMPATIBILIDAD API
// ============================================================
 
async function generarSnapshotMensual(periodo = periodoActualCba()) {
  return generarSnapshotsSemanalesMes(periodo);
}
 
async function calcularBaselines(periodo = periodoActualCba(), ventanas = VENTANA_SEMANAS) {
  const semanas = semanasDelMes(periodo);
  const hoy = hoyCordoba();
  let total = 0;
  const detalle = [];
 
  for (const semana of semanas) {
    if (semana > hoy) continue;
    const resultado = await calcularBaselinesSemana(semana, ventanas);
    detalle.push(resultado);
    total += numero(resultado.baselines);
  }
 
  return {
    periodo,
    granularidad: GRANULARIDAD,
    baselines: total,
    semanas: detalle,
  };
}
 
async function detectarAnomalias(periodo = periodoActualCba()) {
  const semanas = semanasDelMes(periodo);
  const hoy = hoyCordoba();
  let total = 0;
  const detalle = [];
 
  for (const semana of semanas) {
    if (semana > hoy) continue;
    const resultado = await detectarAnomaliasSemana(semana);
    detalle.push(resultado);
    total += numero(resultado.anomalias);
  }
 
  return {
    periodo,
    granularidad: GRANULARIDAD,
    anomalias: total,
    semanas: detalle,
  };
}
 
async function obtenerConsumo(periodo) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(periodo)) {
    return obtenerConsumoSemana(inicioSemana(periodo));
  }
 
  if (/^\d{4}-\d{2}$/.test(periodo)) {
    const semanas = semanasDelMes(periodo);
    const resultado = [];
    for (const semana of semanas) {
      const filas = await obtenerConsumoSemana(semana);
      resultado.push(...filas);
    }
    return resultado;
  }
 
  throw new Error('Periodo inválido');
}
 
// ============================================================
// EXPORTS
// ============================================================
 
module.exports = {
  periodoActualCba,
  inicioSemana,
  semanasDelMes,
  obtenerParque,
  obtenerConsumo,
  obtenerConsumoSemana,
  generarSnapshotSemanal,
  generarSnapshotsSemanalesMes,
  generarSnapshotMensual,
  calcularBaselinesSemana,
  calcularBaselines,
  detectarAnomaliasSemana,
  detectarAnomalias,
  analizarSemana,
  ejecutarCostIntelligence,
  calcularConfianza,
  calcularUmbral,
  evaluarCalidadParque,
  calcularPrecioHistorico,
  seleccionarPrecioImpacto,
  resolverFamiliaConsumo,
  productoEsNafta,
  productoEsDiesel,
};
