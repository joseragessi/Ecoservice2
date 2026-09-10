const supabase = require('./supabase');

const {
  agruparPorFamilia,
  FAMILIAS_CON_MOTOR,
} = require('./familias_consumo');


// ============================================================
// UTILIDADES
// ============================================================

function numero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function redondear(v, decimales = 2) {
  const p = 10 ** decimales;
  return Math.round((numero(v) + Number.EPSILON) * p) / p;
}

function normalizarTexto(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function mediana(valores) {
  const arr = (valores || [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!arr.length) return 0;

  const mitad = Math.floor(arr.length / 2);

  if (arr.length % 2) {
    return arr[mitad];
  }

  return (arr[mitad - 1] + arr[mitad]) / 2;
}

function promedio(valores) {
  const arr = (valores || [])
    .map(Number)
    .filter(Number.isFinite);

  if (!arr.length) return 0;

  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function desviacionEstandar(valores) {
  const arr = (valores || [])
    .map(Number)
    .filter(Number.isFinite);

  if (arr.length < 2) return 0;

  const prom = promedio(arr);

  const varianza =
    arr.reduce((s, x) => s + Math.pow(x - prom, 2), 0) /
    arr.length;

  return Math.sqrt(varianza);
}


// ============================================================
// FECHAS
// ============================================================

function periodoActualCba() {
  return new Date()
    .toLocaleDateString('sv-SE', {
      timeZone: 'America/Argentina/Cordoba',
    })
    .slice(0, 7);
}

function primerDiaPeriodo(periodo) {
  return `${periodo}-01`;
}

function periodoAnterior(periodo, cantidad = 1) {
  const [anio, mes] = periodo.split('-').map(Number);

  const d = new Date(
    Date.UTC(anio, mes - 1 - cantidad, 1)
  );

  return (
    d.getUTCFullYear() +
    '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0')
  );
}

function limiteSuperiorMes(periodo) {
  const [anio, mes] = periodo.split('-').map(Number);

  if (mes === 12) {
    return `${anio + 1}-01-01`;
  }

  return `${anio}-${String(mes + 1).padStart(2, '0')}-01`;
}


// ============================================================
// PARQUE POR OBJETIVO
// Toma el último censo respondido disponible hasta ese período.
// ============================================================

async function obtenerParque(periodo) {

  const { data: objetivos, error: errorObjetivos } =
    await supabase
      .from('objetivos')
      .select('id, nombre, activo, tipo')
      .eq('activo', true);

  if (errorObjetivos) throw errorObjetivos;

  const { data: censos, error: errorCensos } =
    await supabase
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

  if (errorCensos) throw errorCensos;

  const ultimoCenso = {};

  for (const censo of censos || []) {
    if (!censo.objetivo_id) continue;

    if (!ultimoCenso[censo.objetivo_id]) {
      ultimoCenso[censo.objetivo_id] = censo;
    }
  }

  const salida = {};

  for (const objetivo of objetivos || []) {

    const censo = ultimoCenso[objetivo.id];

    const familias = censo
      ? agruparPorFamilia(censo.censos_stock_items || [])
      : agruparPorFamilia([]);

    salida[objetivo.id] = {
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

  return salida;
}


// ============================================================
// CONSUMO DE COMBUSTIBLE
//
// IMPORTANTE:
// V1 crea:
//   familia = "total"
//   familia = "bidones"
//   familia = "unidades"
//
// Si un item ya tiene familia_consumo, también crea:
//   dos_tiempos
//   tractor
//   etc.
//
// De esta manera NO inventamos familia para datos históricos.
// ============================================================

async function obtenerConsumo(periodo) {

  const desde = primerDiaPeriodo(periodo);
  const hasta = limiteSuperiorMes(periodo);

  const { data: cargas, error } =
    await supabase
      .from('cargas_combustible')
      .select(`
        id,
        fecha,
        estado,
        total,
        litros_total,
        objetivo_id,
        patente_raw,
        objetivos(
          id,
          nombre
        ),
        cargas_combustible_items(
          id,
          litros,
          producto,
          destino,
          destino_detalle,
          familia_consumo,
          familia_origen
        )
      `)
      .gte('fecha', desde)
      .lt('fecha', hasta)
      .neq('estado', 'anulada')
      .limit(10000);

  if (error) throw error;

  const agrupado = {};

  function clave(objetivoId, familia) {
    return `${objetivoId || 'sin_objetivo'}::${familia}`;
  }

  function sumar({
    objetivoId,
    objetivoNombre,
    familia,
    litros,
    importe,
    cargaId,
  }) {

    const k = clave(objetivoId, familia);

    if (!agrupado[k]) {
      agrupado[k] = {
        objetivo_id: objetivoId || null,
        objetivo_nombre:
          objetivoNombre || 'Sin objetivo',

        familia,

        litros: 0,
        importe: 0,

        cargas: new Set(),
      };
    }

    agrupado[k].litros += numero(litros);
    agrupado[k].importe += numero(importe);

    if (cargaId) {
      agrupado[k].cargas.add(cargaId);
    }
  }


  for (const carga of cargas || []) {

    const items =
      Array.isArray(carga.cargas_combustible_items)
        ? carga.cargas_combustible_items
        : [];

    const objetivoCargaId =
      carga.objetivo_id ||
      (carga.objetivos && carga.objetivos.id) ||
      null;

    const objetivoCargaNombre =
      carga.objetivos && carga.objetivos.nombre
        ? carga.objetivos.nombre
        : null;

    const litrosCarga =
      items.length
        ? items.reduce(
            (s, i) => s + numero(i.litros),
            0
          )
        : numero(carga.litros_total);

    const importeCarga = numero(carga.total);


    // ========================================================
    // CARGAS VIEJAS SIN ITEMS
    // ========================================================

    if (!items.length) {

      if (!objetivoCargaId) continue;

      sumar({
        objetivoId: objetivoCargaId,
        objetivoNombre: objetivoCargaNombre,
        familia: 'total',
        litros: litrosCarga,
        importe: importeCarga,
        cargaId: carga.id,
      });

      sumar({
        objetivoId: objetivoCargaId,
        objetivoNombre: objetivoCargaNombre,
        familia: 'unidades',
        litros: litrosCarga,
        importe: importeCarga,
        cargaId: carga.id,
      });

      continue;
    }


    // ========================================================
    // ITEMS
    // ========================================================

    for (const item of items) {

      const litros = numero(item.litros);

      if (!litros) continue;

      const proporcion =
        litrosCarga > 0
          ? litros / litrosCarga
          : 0;

      const importeItem =
        importeCarga * proporcion;

      const esBidon =
        String(item.destino || '').toLowerCase() === 'bidon';

      /*
       * Hoy destino_detalle suele guardar el NOMBRE del objetivo
       * cuando el combustible va a bidones.
       *
       * Resolver ese nombre contra objetivos lo hacemos después.
       */

      let objetivoId = objetivoCargaId;
      let objetivoNombre = objetivoCargaNombre;

      if (esBidon && item.destino_detalle) {
        objetivoNombre =
          String(item.destino_detalle).trim();
      }

      if (!objetivoNombre && !objetivoId) {
        continue;
      }

      sumar({
        objetivoId,
        objetivoNombre,
        familia: 'total',
        litros,
        importe: importeItem,
        cargaId: carga.id,
      });

      sumar({
        objetivoId,
        objetivoNombre,
        familia: esBidon ? 'bidones' : 'unidades',
        litros,
        importe: importeItem,
        cargaId: carga.id,
      });


      // Si desde ahora registramos la familia,
      // también consolidamos por ella.
      const familiaDeclarada =
        String(item.familia_consumo || '').trim();

      if (
        familiaDeclarada &&
        FAMILIAS_CON_MOTOR.includes(familiaDeclarada)
      ) {

        sumar({
          objetivoId,
          objetivoNombre,
          familia: familiaDeclarada,
          litros,
          importe: importeItem,
          cargaId: carga.id,
        });
      }
    }
  }

  return Object.values(agrupado).map(x => ({
    ...x,
    litros: redondear(x.litros, 2),
    importe: Math.round(x.importe),
    cantidad_cargas: x.cargas.size,
  }));
}


// ============================================================
// RESOLVER OBJETIVO POR NOMBRE
//
// Esto es necesario para cargas de bidones porque históricamente
// destino_detalle puede tener el nombre del objetivo.
// ============================================================

async function resolverObjetivos(consumos) {

  const { data: objetivos, error } =
    await supabase
      .from('objetivos')
      .select('id, nombre');

  if (error) throw error;

  const mapa = {};

  for (const o of objetivos || []) {
    mapa[normalizarTexto(o.nombre)] = o;
  }

  return consumos.map(c => {

    if (c.objetivo_id) {
      return c;
    }

    const encontrado =
      mapa[normalizarTexto(c.objetivo_nombre)];

    if (!encontrado) {
      return c;
    }

    return {
      ...c,
      objetivo_id: encontrado.id,
      objetivo_nombre: encontrado.nombre,
    };
  });
}


// ============================================================
// CREAR SNAPSHOT MENSUAL
// ============================================================

async function generarSnapshotMensual(periodo = periodoActualCba()) {

  console.log(
    `[cost-intelligence] generando snapshot ${periodo}`
  );

  const [parque, consumoRaw] = await Promise.all([
    obtenerParque(periodo),
    obtenerConsumo(periodo),
  ]);

  const consumos =
    await resolverObjetivos(consumoRaw);

  const filas = [];

  for (const c of consumos) {

    // No guardamos todavía consumos sin objetivo:
    // Cost Intelligence necesita imputación.
    if (!c.objetivo_id) continue;

    const p =
      parque[c.objetivo_id] || {
        total: 0,
        con_motor: 0,
      };

    let parqueFamilia = 0;

    if (
      FAMILIAS_CON_MOTOR.includes(c.familia)
    ) {
      parqueFamilia =
        numero(p[c.familia]);
    }

    // total/bidones:
    // denominador = parque con motor.
    //
    // unidades:
    // no usamos parque porque vehículos se comportan distinto.
    if (
      c.familia === 'total' ||
      c.familia === 'bidones'
    ) {
      parqueFamilia =
        numero(p.con_motor);
    }

    const litrosPorEquipo =
      parqueFamilia > 0
        ? c.litros / parqueFamilia
        : null;

    const costoPorEquipo =
      parqueFamilia > 0
        ? c.importe / parqueFamilia
        : null;

    filas.push({
      periodo: primerDiaPeriodo(periodo),
      granularidad: 'mensual',

      objetivo_id: c.objetivo_id,
      objetivo_nombre: c.objetivo_nombre,

      familia: c.familia,

      litros: redondear(c.litros, 2),
      importe: Math.round(c.importe),

      parque_total: numero(p.total),
      parque_motor: numero(p.con_motor),
      parque_familia: parqueFamilia,

      litros_por_equipo:
        litrosPorEquipo == null
          ? null
          : redondear(litrosPorEquipo, 3),

      costo_por_equipo:
        costoPorEquipo == null
          ? null
          : Math.round(costoPorEquipo),

      cantidad_cargas:
        numero(c.cantidad_cargas),

      updated_at: new Date().toISOString(),
    });
  }

  if (!filas.length) {
    return {
      periodo,
      snapshots: 0,
    };
  }

  const { data, error } =
    await supabase
      .from('cost_snapshots')
      .upsert(
        filas,
        {
          onConflict:
            'periodo,granularidad,objetivo_id,familia',
        }
      )
      .select();

  if (error) throw error;

  console.log(
    `[cost-intelligence] ${data.length} snapshots generados`
  );

  return {
    periodo,
    snapshots: data.length,
  };
}


// ============================================================
// BASELINES
//
// V1:
// usa la MEDIANA de hasta 6 meses anteriores.
//
// Preferimos litros_por_equipo si existe.
// Si no existe, usa litros totales.
// ============================================================

async function calcularBaselines(
  periodo = periodoActualCba(),
  ventanas = 6
) {

  const inicio =
    periodoAnterior(periodo, ventanas);

  const { data: snapshots, error } =
    await supabase
      .from('cost_snapshots')
      .select('*')
      .gte(
        'periodo',
        primerDiaPeriodo(inicio)
      )
      .lt(
        'periodo',
        primerDiaPeriodo(periodo)
      )
      .order('periodo', {
        ascending: true,
      });

  if (error) throw error;

  const grupos = {};

  for (const s of snapshots || []) {

    const k =
      `${s.objetivo_id}::${s.familia}`;

    if (!grupos[k]) {
      grupos[k] = [];
    }

    grupos[k].push(s);
  }

  const filas = [];

  for (const grupo of Object.values(grupos)) {

    if (!grupo.length) continue;

    const ultimo =
      grupo[grupo.length - 1];

    const consumoEquipo =
      grupo
        .map(x =>
          x.litros_por_equipo == null
            ? null
            : numero(x.litros_por_equipo)
        )
        .filter(x => x != null && x > 0);

    const costoEquipo =
      grupo
        .map(x =>
          x.costo_por_equipo == null
            ? null
            : numero(x.costo_por_equipo)
        )
        .filter(x => x != null && x > 0);

    const litros =
      grupo
        .map(x => numero(x.litros))
        .filter(x => x > 0);

    const importes =
      grupo
        .map(x => numero(x.importe))
        .filter(x => x > 0);

    const consumoPorEquipoBase =
      mediana(consumoEquipo);

    const costoPorEquipoBase =
      mediana(costoEquipo);

    const consumoBase =
      mediana(litros);

    const costoBase =
      mediana(importes);

    const serieDispersion =
      consumoEquipo.length >= 3
        ? consumoEquipo
        : litros;

    const media =
      promedio(serieDispersion);

    const dispersionPct =
      media > 0
        ? desviacionEstandar(
            serieDispersion
          ) / media * 100
        : 0;

    filas.push({
      objetivo_id: ultimo.objetivo_id,
      objetivo_nombre:
        ultimo.objetivo_nombre,

      familia: ultimo.familia,
      granularidad: 'mensual',

      ventanas,

      consumo_base:
        redondear(consumoBase, 3),

      costo_base:
        Math.round(costoBase),

      parque_base:
        mediana(
          grupo.map(
            x => numero(x.parque_familia)
          )
        ),

      consumo_por_equipo_base:
        consumoPorEquipoBase || null,

      costo_por_equipo_base:
        costoPorEquipoBase || null,

      dispersion_pct:
        redondear(dispersionPct, 2),

      muestras: grupo.length,

      calculado_at:
        new Date().toISOString(),
    });
  }

  if (!filas.length) {

    return {
      periodo,
      baselines: 0,
    };
  }

  const { data, error: errorUpsert } =
    await supabase
      .from('cost_baselines')
      .upsert(
        filas,
        {
          onConflict:
            'objetivo_id,familia,granularidad',
        }
      )
      .select();

  if (errorUpsert) {
    throw errorUpsert;
  }

  return {
    periodo,
    baselines: data.length,
  };
}


// ============================================================
// DETECTAR ANOMALÍAS
// ============================================================

async function detectarAnomalias(
  periodo = periodoActualCba()
) {

  const desde =
    primerDiaPeriodo(periodo);

  const [snapRes, baseRes] =
    await Promise.all([

      supabase
        .from('cost_snapshots')
        .select('*')
        .eq('periodo', desde),

      supabase
        .from('cost_baselines')
        .select('*')
        .eq('granularidad', 'mensual'),
    ]);

  if (snapRes.error) throw snapRes.error;
  if (baseRes.error) throw baseRes.error;

  const baselines = {};

  for (const b of baseRes.data || []) {

    baselines[
      `${b.objetivo_id}::${b.familia}`
    ] = b;
  }

  const anomalías = [];

  for (const s of snapRes.data || []) {

    const b =
      baselines[
        `${s.objetivo_id}::${s.familia}`
      ];

    // Necesitamos por lo menos 3 períodos anteriores.
    if (!b || numero(b.muestras) < 3) {
      continue;
    }


    let metrica;
    let real;
    let esperado;


    // Si tenemos parque confiable,
    // comparamos intensidad por equipo.
    if (
      s.litros_por_equipo != null &&
      b.consumo_por_equipo_base != null &&
      numero(s.parque_familia) > 0
    ) {

      metrica = 'litros_por_equipo';

      real =
        numero(s.litros_por_equipo);

      esperado =
        numero(
          b.consumo_por_equipo_base
        );

    } else {

      metrica = 'litros';

      real =
        numero(s.litros);

      esperado =
        numero(b.consumo_base);
    }


    if (esperado <= 0) continue;

    const diferencia =
      real - esperado;

    const desvioPct =
      diferencia / esperado * 100;


    /*
     * V1:
     *
     * +15% = alerta.
     *
     * Más adelante lo haremos dinámico
     * según dispersión histórica.
     */
    if (desvioPct < 15) {
      continue;
    }


    let litrosEsperados;

    if (
      metrica ===
      'litros_por_equipo'
    ) {

      litrosEsperados =
        esperado *
        numero(s.parque_familia);

    } else {
      litrosEsperados =
        esperado;
    }


    const litrosExceso =
      Math.max(
        0,
        numero(s.litros) -
          litrosEsperados
      );


    const precioPromedio =
      numero(s.litros) > 0
        ? numero(s.importe) /
          numero(s.litros)
        : 0;


    const impacto =
      litrosExceso *
      precioPromedio;


    let severidad = 'baja';

    if (desvioPct >= 40) {
      severidad = 'critica';
    } else if (desvioPct >= 25) {
      severidad = 'alta';
    } else if (desvioPct >= 15) {
      severidad = 'media';
    }


    anomalías.push({

      snapshot_id: s.id,
      periodo: s.periodo,

      objetivo_id: s.objetivo_id,
      objetivo_nombre:
        s.objetivo_nombre,

      familia: s.familia,

      metrica,

      esperado:
        redondear(esperado, 3),

      real:
        redondear(real, 3),

      desvio_abs:
        redondear(diferencia, 3),

      desvio_pct:
        redondear(desvioPct, 2),

      litros_exceso:
        redondear(litrosExceso, 2),

      impacto_estimado:
        Math.round(impacto),

      severidad,

      estado: 'abierta',
    });
  }


  if (!anomalías.length) {

    return {
      periodo,
      anomalias: 0,
    };
  }


  const { data, error } =
    await supabase
      .from('cost_anomalies')
      .upsert(
        anomalías,
        {
          onConflict:
            'snapshot_id,metrica',

          // No queremos pisar
          // causa/estado si alguien ya revisó.
          ignoreDuplicates: true,
        }
      )
      .select();


  if (error) throw error;


  return {
    periodo,
    anomalias:
      data ? data.length : 0,
  };
}


// ============================================================
// EJECUCIÓN COMPLETA DEL CEREBRO
// ============================================================

async function ejecutarCostIntelligence(
  periodo = periodoActualCba()
) {

  const inicio = Date.now();

  console.log(
    `[cost-intelligence] iniciando ${periodo}`
  );


  const snapshot =
    await generarSnapshotMensual(
      periodo
    );


  const baseline =
    await calcularBaselines(
      periodo,
      6
    );


  const anomalias =
    await detectarAnomalias(
      periodo
    );


  const resultado = {
    ok: true,
    periodo,
    snapshot,
    baseline,
    anomalias,
    duracion_ms:
      Date.now() - inicio,
  };


  console.log(
    '[cost-intelligence] finalizado',
    resultado
  );


  return resultado;
}


// ============================================================
// EXPORT
// ============================================================

module.exports = {
  periodoActualCba,
  obtenerParque,
  obtenerConsumo,

  generarSnapshotMensual,
  calcularBaselines,
  detectarAnomalias,
  ejecutarCostIntelligence,
};
