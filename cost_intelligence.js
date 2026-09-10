// ============================================================
// COST INTELLIGENCE V1.1
// Ecoservice
//
// Motor de inteligencia de costos.
//
// V1.1:
// - Corrige cálculo económico de combustible.
// - Usa subtotal / precio_unit / total / precio promedio.
// - Usa objetivo_id del ITEM cuando existe.
// - Resuelve correctamente nombres e IDs de objetivos.
// - No genera anomalías operativas para DEPÓSITO.
// - Ajusta mes actual por días hábiles transcurridos.
// - Limpia anomalías automáticas abiertas al recalcular.
// - Mantiene snapshots de depósito para control económico.
// ============================================================

const supabase = require('./supabase');

const {
  agruparPorFamilia,
  FAMILIAS_CON_MOTOR,
} = require('./familias_consumo');


// ============================================================
// CONFIGURACIÓN
// ============================================================

// Cantidad de meses históricos máximos
// utilizados para calcular el baseline.
const VENTANA_BASELINE_DEFAULT = 6;


// Cantidad mínima de muestras históricas
// para generar una anomalía.
const MIN_MUESTRAS_ANOMALIA = 3;


// Desvío mínimo para generar alerta.
const UMBRAL_DESVIO_PCT = 15;


// Objetivos que queremos contabilizar,
// pero NO comparar como operación.
//
// Depósito puede recibir / redistribuir combustible
// y no necesariamente representa consumo productivo.
const OBJETIVOS_NO_OPERATIVOS = [
  'deposito',
];


// ============================================================
// UTILIDADES NUMÉRICAS
// ============================================================

function numero(v) {

  const n = Number(v);

  return Number.isFinite(n)
    ? n
    : 0;
}


function redondear(
  v,
  decimales = 2
) {

  const p =
    10 ** decimales;

  return Math.round(
    (
      numero(v) +
      Number.EPSILON
    ) * p
  ) / p;
}


function promedio(
  valores
) {

  const arr =
    (valores || [])
      .map(Number)
      .filter(
        Number.isFinite
      );


  if (!arr.length) {
    return 0;
  }


  return (
    arr.reduce(
      (s, x) =>
        s + x,
      0
    ) /
    arr.length
  );
}


function mediana(
  valores
) {

  const arr =
    (valores || [])
      .map(Number)
      .filter(
        Number.isFinite
      )
      .sort(
        (a, b) =>
          a - b
      );


  if (!arr.length) {
    return 0;
  }


  const mitad =
    Math.floor(
      arr.length / 2
    );


  if (
    arr.length % 2
  ) {

    return arr[
      mitad
    ];
  }


  return (
    arr[
      mitad - 1
    ] +
    arr[
      mitad
    ]
  ) / 2;
}


function desviacionEstandar(
  valores
) {

  const arr =
    (valores || [])
      .map(Number)
      .filter(
        Number.isFinite
      );


  if (
    arr.length < 2
  ) {

    return 0;
  }


  const prom =
    promedio(arr);


  const varianza =
    arr.reduce(
      (s, x) =>
        s +
        Math.pow(
          x - prom,
          2
        ),
      0
    ) /
    arr.length;


  return Math.sqrt(
    varianza
  );
}


// ============================================================
// UTILIDADES TEXTO
// ============================================================

function normalizarTexto(
  s
) {

  return String(
    s || ''
  )
    .normalize('NFD')
    .replace(
      /[\u0300-\u036f]/g,
      ''
    )
    .trim()
    .toLowerCase()
    .replace(
      /\s+/g,
      ' '
    );
}


function esObjetivoNoOperativo(
  nombre
) {

  const n =
    normalizarTexto(
      nombre
    );


  if (!n) {
    return false;
  }


  return (
    OBJETIVOS_NO_OPERATIVOS
      .some(
        palabra =>
          n === palabra ||
          n.includes(
            `${palabra} `
          ) ||
          n.includes(
            ` ${palabra}`
          )
      )
  );
}


// ============================================================
// FECHAS
// ============================================================

function hoyCordoba() {

  return new Date()
    .toLocaleDateString(
      'sv-SE',
      {
        timeZone:
          'America/Argentina/Cordoba',
      }
    );
}


function periodoActualCba() {

  return hoyCordoba()
    .slice(
      0,
      7
    );
}


function primerDiaPeriodo(
  periodo
) {

  return `${periodo}-01`;
}


function periodoAnterior(
  periodo,
  cantidad = 1
) {

  const [
    anio,
    mes
  ] =
    periodo
      .split('-')
      .map(Number);


  const d =
    new Date(
      Date.UTC(
        anio,
        mes - 1 - cantidad,
        1
      )
    );


  return (
    d.getUTCFullYear() +
    '-' +
    String(
      d.getUTCMonth() + 1
    ).padStart(
      2,
      '0'
    )
  );
}


function limiteSuperiorMes(
  periodo
) {

  const [
    anio,
    mes
  ] =
    periodo
      .split('-')
      .map(Number);


  if (
    mes === 12
  ) {

    return `${anio + 1}-01-01`;
  }


  return (
    `${anio}-` +
    `${String(
      mes + 1
    ).padStart(
      2,
      '0'
    )}-01`
  );
}


// ============================================================
// DÍAS HÁBILES
// ============================================================

function esDiaHabil(
  fecha
) {

  const dia =
    fecha.getUTCDay();


  return (
    dia !== 0 &&
    dia !== 6
  );
}


function diasHabilesMes(
  periodo
) {

  const [
    anio,
    mes
  ] =
    periodo
      .split('-')
      .map(Number);


  const ultimoDia =
    new Date(
      Date.UTC(
        anio,
        mes,
        0
      )
    ).getUTCDate();


  let cantidad = 0;


  for (
    let dia = 1;
    dia <= ultimoDia;
    dia++
  ) {

    const fecha =
      new Date(
        Date.UTC(
          anio,
          mes - 1,
          dia
        )
      );


    if (
      esDiaHabil(fecha)
    ) {

      cantidad++;
    }
  }


  return cantidad;
}


function diasHabilesTranscurridos(
  periodo
) {

  const actual =
    periodoActualCba();


  // Mes cerrado:
  // todos sus días hábiles cuentan.
  if (
    periodo !== actual
  ) {

    return diasHabilesMes(
      periodo
    );
  }


  const hoy =
    hoyCordoba();


  const [
    anio,
    mes,
    diaActual
  ] =
    hoy
      .split('-')
      .map(Number);


  let cantidad = 0;


  for (
    let dia = 1;
    dia <= diaActual;
    dia++
  ) {

    const fecha =
      new Date(
        Date.UTC(
          anio,
          mes - 1,
          dia
        )
      );


    if (
      esDiaHabil(fecha)
    ) {

      cantidad++;
    }
  }


  return cantidad;
}


function factorPeriodoTranscurrido(
  periodo
) {

  if (
    periodo !==
    periodoActualCba()
  ) {

    return 1;
  }


  const total =
    diasHabilesMes(
      periodo
    );


  const transcurridos =
    diasHabilesTranscurridos(
      periodo
    );


  if (
    total <= 0
  ) {

    return 1;
  }


  const factor =
    transcurridos /
    total;


  return Math.max(
    0.01,
    Math.min(
      1,
      factor
    )
  );
}


// ============================================================
// OBJETIVOS
// ============================================================

async function cargarMapaObjetivos() {

  const {
    data,
    error
  } =
    await supabase
      .from(
        'objetivos'
      )
      .select(
        'id, nombre, activo, tipo'
      );


  if (error) {
    throw error;
  }


  const porId = {};
  const porNombre = {};


  for (
    const objetivo of
    data || []
  ) {

    porId[
      objetivo.id
    ] =
      objetivo;


    porNombre[
      normalizarTexto(
        objetivo.nombre
      )
    ] =
      objetivo;
  }


  return {
    lista:
      data || [],

    porId,

    porNombre,
  };
}


// ============================================================
// PARQUE POR OBJETIVO
//
// Utiliza el último censo respondido existente
// hasta el período solicitado.
// ============================================================

async function obtenerParque(
  periodo
) {

  const mapaObjetivos =
    await cargarMapaObjetivos();


  const {
    data: censos,
    error: errorCensos
  } =
    await supabase
      .from(
        'censos_stock'
      )
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
      .eq(
        'estado',
        'respondido'
      )
      .lte(
        'periodo',
        periodo
      )
      .order(
        'periodo',
        {
          ascending:
            false
        }
      );


  if (
    errorCensos
  ) {

    throw errorCensos;
  }


  const ultimoCenso = {};


  for (
    const censo of
    censos || []
  ) {

    if (
      !censo.objetivo_id
    ) {

      continue;
    }


    // Como vienen ordenados DESC,
    // el primero de cada objetivo
    // es el más reciente.
    if (
      !ultimoCenso[
        censo.objetivo_id
      ]
    ) {

      ultimoCenso[
        censo.objetivo_id
      ] =
        censo;
    }
  }


  const salida = {};


  for (
    const objetivo of
    mapaObjetivos.lista
  ) {

    const censo =
      ultimoCenso[
        objetivo.id
      ];


    const familias =
      censo
        ? agruparPorFamilia(
            censo
              .censos_stock_items ||
            []
          )
        : agruparPorFamilia(
            []
          );


    salida[
      objetivo.id
    ] = {

      objetivo_id:
        objetivo.id,

      objetivo_nombre:
        objetivo.nombre,

      censo_id:
        censo
          ? censo.id
          : null,

      censo_periodo:
        censo
          ? censo.periodo
          : null,

      total:
        familias.total ||
        0,

      con_motor:
        familias.con_motor ||
        0,

      dos_tiempos:
        familias.dos_tiempos ||
        0,

      cortadora:
        familias.cortadora ||
        0,

      tractor:
        familias.tractor ||
        0,

      vehiculo:
        familias.vehiculo ||
        0,

      fijo:
        familias.fijo ||
        0,

      sin_motor:
        familias.sin_motor ||
        0,

      otro:
        familias.otro ||
        0,
    };
  }


  return salida;
}


// ============================================================
// PRECIO DE REFERENCIA
//
// Calculamos una mediana de precios observados.
//
// Prioridad:
// 1. precio_unit de los items.
// 2. subtotal / litros.
// 3. total carga / litros carga.
//
// Esto evita impacto_estimado = 0
// cuando alguna carga no tiene total.
// ============================================================

function calcularPrecioReferencia(
  cargas
) {

  const preciosItems = [];
  const preciosCarga = [];


  for (
    const carga of
    cargas || []
  ) {

    const items =
      Array.isArray(
        carga
          .cargas_combustible_items
      )
        ? carga
            .cargas_combustible_items
        : [];


    for (
      const item of items
    ) {

      if (
        item.es_combustible ===
        false
      ) {

        continue;
      }


      const litros =
        numero(
          item.litros
        );


      const precioUnit =
        numero(
          item.precio_unit
        );


      const subtotal =
        numero(
          item.subtotal
        );


      if (
        precioUnit > 0
      ) {

        preciosItems.push(
          precioUnit
        );

        continue;
      }


      if (
        subtotal > 0 &&
        litros > 0
      ) {

        preciosItems.push(
          subtotal /
          litros
        );
      }
    }


    const litrosCarga =
      numero(
        carga.litros_total
      );


    const totalCarga =
      numero(
        carga.total
      );


    if (
      litrosCarga > 0 &&
      totalCarga > 0
    ) {

      preciosCarga.push(
        totalCarga /
        litrosCarga
      );
    }
  }


  if (
    preciosItems.length
  ) {

    return mediana(
      preciosItems
    );
  }


  if (
    preciosCarga.length
  ) {

    return mediana(
      preciosCarga
    );
  }


  return 0;
}


// ============================================================
// IMPORTE DE UN ITEM
//
// Prioridad:
//
// 1. subtotal
// 2. precio_unit × litros
// 3. proporción sobre total de carga
// 4. precio referencia × litros
// ============================================================

function calcularImporteItem({
  item,
  carga,
  litrosItem,
  litrosCombustibleCarga,
  precioReferencia,
}) {

  const subtotal =
    numero(
      item.subtotal
    );


  if (
    subtotal > 0
  ) {

    return subtotal;
  }


  const precioUnit =
    numero(
      item.precio_unit
    );


  if (
    precioUnit > 0 &&
    litrosItem > 0
  ) {

    return (
      precioUnit *
      litrosItem
    );
  }


  const totalCarga =
    numero(
      carga.total
    );


  if (
    totalCarga > 0 &&
    litrosCombustibleCarga > 0
  ) {

    const proporcion =
      litrosItem /
      litrosCombustibleCarga;


    return (
      totalCarga *
      proporcion
    );
  }


  if (
    precioReferencia > 0 &&
    litrosItem > 0
  ) {

    return (
      precioReferencia *
      litrosItem
    );
  }


  return 0;
}


// ============================================================
// CONSUMO DE COMBUSTIBLE
//
// Genera familias:
//
// total
// bidones
// unidades
//
// Y también familia declarada:
//
// dos_tiempos
// tractor
// cortadora
// vehiculo
// fijo
//
// si el item ya fue clasificado.
// ============================================================

async function obtenerConsumo(
  periodo
) {

  const desde =
    primerDiaPeriodo(
      periodo
    );


  const hasta =
    limiteSuperiorMes(
      periodo
    );


  const {
    data: cargas,
    error
  } =
    await supabase
      .from(
        'cargas_combustible'
      )
      .select(`
        id,
        fecha,
        estado,
        total,
        litros_total,
        objetivo_id,
        unidad_id,
        patente_raw,
        objetivos(
          id,
          nombre
        ),
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
      .gte(
        'fecha',
        desde
      )
      .lt(
        'fecha',
        hasta
      )
      .neq(
        'estado',
        'anulada'
      )
      .limit(
        10000
      );


  if (error) {
    throw error;
  }


  const listaCargas =
    cargas || [];


  const mapaObjetivos =
    await cargarMapaObjetivos();


  const precioReferencia =
    calcularPrecioReferencia(
      listaCargas
    );


  console.log(
    `[cost-intelligence] ${periodo} precio referencia:`,
    redondear(
      precioReferencia,
      2
    )
  );


  const agrupado = {};


  function clave(
    objetivoId,
    objetivoNombre,
    familia
  ) {

    return (
      `${
        objetivoId ||
        normalizarTexto(
          objetivoNombre
        ) ||
        'sin_objetivo'
      }::${familia}`
    );
  }


  function sumar({
    objetivoId,
    objetivoNombre,
    familia,
    litros,
    importe,
    cargaId,
  }) {

    const k =
      clave(
        objetivoId,
        objetivoNombre,
        familia
      );


    if (
      !agrupado[k]
    ) {

      agrupado[k] = {

        objetivo_id:
          objetivoId ||
          null,

        objetivo_nombre:
          objetivoNombre ||
          'Sin objetivo',

        familia,

        litros:
          0,

        importe:
          0,

        cargas:
          new Set(),
      };
    }


    agrupado[k].litros +=
      numero(
        litros
      );


    agrupado[k].importe +=
      numero(
        importe
      );


    if (
      cargaId
    ) {

      agrupado[k]
        .cargas
        .add(
          cargaId
        );
    }
  }


  for (
    const carga of
    listaCargas
  ) {

    const items =
      Array.isArray(
        carga
          .cargas_combustible_items
      )
        ? carga
            .cargas_combustible_items
        : [];


    const objetivoCargaId =
      carga.objetivo_id ||
      (
        carga.objetivos &&
        carga.objetivos.id
      ) ||
      null;


    const objetivoCargaNombre =
      (
        carga.objetivos &&
        carga.objetivos.nombre
      )
        ? carga.objetivos.nombre
        : (
            objetivoCargaId &&
            mapaObjetivos
              .porId[
                objetivoCargaId
              ]
          )
          ? mapaObjetivos
              .porId[
                objetivoCargaId
              ]
              .nombre
          : null;


    // ========================================================
    // CARGA SIN ITEMS
    // ========================================================

    if (
      !items.length
    ) {

      const litros =
        numero(
          carga.litros_total
        );


      if (
        litros <= 0 ||
        !objetivoCargaId
      ) {

        continue;
      }


      let importe =
        numero(
          carga.total
        );


      if (
        importe <= 0 &&
        precioReferencia > 0
      ) {

        importe =
          litros *
          precioReferencia;
      }


      sumar({

        objetivoId:
          objetivoCargaId,

        objetivoNombre:
          objetivoCargaNombre,

        familia:
          'total',

        litros,

        importe,

        cargaId:
          carga.id,
      });


      sumar({

        objetivoId:
          objetivoCargaId,

        objetivoNombre:
          objetivoCargaNombre,

        familia:
          'unidades',

        litros,

        importe,

        cargaId:
          carga.id,
      });


      continue;
    }


    // ========================================================
    // LITROS COMBUSTIBLES DE LA CARGA
    // ========================================================

    const itemsCombustible =
      items.filter(
        item =>
          item
            .es_combustible !==
          false
      );


    let litrosCombustibleCarga =
      itemsCombustible
        .reduce(
          (
            total,
            item
          ) =>
            total +
            numero(
              item.litros
            ),
          0
        );


    if (
      litrosCombustibleCarga <= 0
    ) {

      litrosCombustibleCarga =
        numero(
          carga.litros_total
        );
    }


    // ========================================================
    // ITEMS
    // ========================================================

    for (
      const item of
      itemsCombustible
    ) {

      const litros =
        numero(
          item.litros
        );


      if (
        litros <= 0
      ) {

        continue;
      }


      const importeItem =
        calcularImporteItem({

          item,

          carga,

          litrosItem:
            litros,

          litrosCombustibleCarga,

          precioReferencia,
        });


      const esBidon =
        String(
          item.destino ||
          ''
        )
          .toLowerCase()
          .trim() ===
        'bidon';


      // ======================================================
      // OBJETIVO DEL ITEM
      //
      // El reparto individual tiene prioridad
      // sobre el objetivo general de la carga.
      // ======================================================

      let objetivoId =
        item.objetivo_id ||
        objetivoCargaId ||
        null;


      let objetivoNombre =
        null;


      if (
        objetivoId &&
        mapaObjetivos
          .porId[
            objetivoId
          ]
      ) {

        objetivoNombre =
          mapaObjetivos
            .porId[
              objetivoId
            ]
            .nombre;
      }


      // Históricos de bidones:
      // destino_detalle puede contener
      // el nombre del objetivo.
      if (
        !objetivoId &&
        esBidon &&
        item.destino_detalle
      ) {

        const nombreRaw =
          String(
            item.destino_detalle
          ).trim();


        const encontrado =
          mapaObjetivos
            .porNombre[
              normalizarTexto(
                nombreRaw
              )
            ];


        if (
          encontrado
        ) {

          objetivoId =
            encontrado.id;

          objetivoNombre =
            encontrado.nombre;

        } else {

          objetivoNombre =
            nombreRaw;
        }
      }


      if (
        !objetivoNombre &&
        objetivoCargaNombre
      ) {

        objetivoNombre =
          objetivoCargaNombre;
      }


      // Sin objetivo no podemos
      // hacer inteligencia de costos.
      if (
        !objetivoId &&
        !objetivoNombre
      ) {

        continue;
      }


      // ======================================================
      // TOTAL
      // ======================================================

      sumar({

        objetivoId,

        objetivoNombre,

        familia:
          'total',

        litros,

        importe:
          importeItem,

        cargaId:
          carga.id,
      });


      // ======================================================
      // BIDONES / UNIDADES
      // ======================================================

      sumar({

        objetivoId,

        objetivoNombre,

        familia:
          esBidon
            ? 'bidones'
            : 'unidades',

        litros,

        importe:
          importeItem,

        cargaId:
          carga.id,
      });


      // ======================================================
      // FAMILIA DECLARADA
      // ======================================================

      const familiaDeclarada =
        String(
          item
            .familia_consumo ||
          ''
        ).trim();


      if (
        familiaDeclarada &&
        FAMILIAS_CON_MOTOR
          .includes(
            familiaDeclarada
          )
      ) {

        sumar({

          objetivoId,

          objetivoNombre,

          familia:
            familiaDeclarada,

          litros,

          importe:
            importeItem,

          cargaId:
            carga.id,
        });
      }
    }
  }


  return (
    Object
      .values(
        agrupado
      )
      .map(
        x => ({

          ...x,

          litros:
            redondear(
              x.litros,
              2
            ),

          importe:
            Math.round(
              x.importe
            ),

          cantidad_cargas:
            x.cargas.size,

        })
      )
  );
}


// ============================================================
// RESOLVER OBJETIVOS
//
// Completa ID o nombre cuando uno de los dos falta.
// ============================================================

async function resolverObjetivos(
  consumos
) {

  const mapa =
    await cargarMapaObjetivos();


  return (
    consumos.map(
      c => {

        // Tiene ID:
        // completamos nombre.
        if (
          c.objetivo_id
        ) {

          const encontrado =
            mapa
              .porId[
                c.objetivo_id
              ];


          if (
            encontrado
          ) {

            return {

              ...c,

              objetivo_nombre:
                encontrado.nombre,
            };
          }


          return c;
        }


        // No tiene ID:
        // intentamos resolver
        // por nombre.
        const encontrado =
          mapa
            .porNombre[
              normalizarTexto(
                c.objetivo_nombre
              )
            ];


        if (
          !encontrado
        ) {

          return c;
        }


        return {

          ...c,

          objetivo_id:
            encontrado.id,

          objetivo_nombre:
            encontrado.nombre,
        };
      }
    )
  );
}


// ============================================================
// CREAR SNAPSHOT MENSUAL
// ============================================================

async function generarSnapshotMensual(
  periodo =
    periodoActualCba()
) {

  console.log(
    `[cost-intelligence] generando snapshot ${periodo}`
  );


  const [
    parque,
    consumoRaw
  ] =
    await Promise.all([

      obtenerParque(
        periodo
      ),

      obtenerConsumo(
        periodo
      ),

    ]);


  const consumos =
    await resolverObjetivos(
      consumoRaw
    );


  const filas = [];


  for (
    const c of
    consumos
  ) {

    // Cost Intelligence necesita
    // objetivo identificable.
    if (
      !c.objetivo_id
    ) {

      console.warn(
        '[cost-intelligence] consumo sin objetivo resoluble:',
        c.objetivo_nombre,
        c.familia
      );

      continue;
    }


    const p =
      parque[
        c.objetivo_id
      ] || {

        total:
          0,

        con_motor:
          0,
      };


    let parqueFamilia = 0;


    // ========================================================
    // FAMILIAS ESPECÍFICAS
    // ========================================================

    if (
      FAMILIAS_CON_MOTOR
        .includes(
          c.familia
        )
    ) {

      parqueFamilia =
        numero(
          p[
            c.familia
          ]
        );
    }


    // ========================================================
    // TOTAL / BIDONES
    //
    // Para estos usamos todo el parque con motor.
    // ========================================================

    if (
      c.familia ===
        'total' ||
      c.familia ===
        'bidones'
    ) {

      parqueFamilia =
        numero(
          p.con_motor
        );
    }


    // ========================================================
    // UNIDADES
    //
    // No usamos parque genérico.
    // Los vehículos deben compararse por su propia historia.
    // ========================================================

    if (
      c.familia ===
      'unidades'
    ) {

      parqueFamilia =
        0;
    }


    const litrosPorEquipo =
      parqueFamilia > 0
        ? (
            c.litros /
            parqueFamilia
          )
        : null;


    const costoPorEquipo =
      parqueFamilia > 0
        ? (
            c.importe /
            parqueFamilia
          )
        : null;


    filas.push({

      periodo:
        primerDiaPeriodo(
          periodo
        ),

      granularidad:
        'mensual',

      objetivo_id:
        c.objetivo_id,

      objetivo_nombre:
        c.objetivo_nombre,

      familia:
        c.familia,

      litros:
        redondear(
          c.litros,
          2
        ),

      importe:
        Math.round(
          c.importe
        ),

      parque_total:
        numero(
          p.total
        ),

      parque_motor:
        numero(
          p.con_motor
        ),

      parque_familia:
        parqueFamilia,

      litros_por_equipo:
        litrosPorEquipo ==
        null
          ? null
          : redondear(
              litrosPorEquipo,
              3
            ),

      costo_por_equipo:
        costoPorEquipo ==
        null
          ? null
          : Math.round(
              costoPorEquipo
            ),

      cantidad_cargas:
        numero(
          c.cantidad_cargas
        ),

      updated_at:
        new Date()
          .toISOString(),
    });
  }


  if (
    !filas.length
  ) {

    return {

      periodo,

      snapshots:
        0,
    };
  }


  const {
    data,
    error
  } =
    await supabase
      .from(
        'cost_snapshots'
      )
      .upsert(
        filas,
        {
          onConflict:
            'periodo,granularidad,objetivo_id,familia',
        }
      )
      .select();


  if (
    error
  ) {

    throw error;
  }


  console.log(
    `[cost-intelligence] ${data.length} snapshots generados`
  );


  return {

    periodo,

    snapshots:
      data.length,
  };
}


// ============================================================
// CALCULAR BASELINES
//
// Baseline = mediana de hasta N meses anteriores.
//
// Para familias con parque:
// litros/equipo.
//
// Para unidades sin parque:
// litros totales.
//
// La mediana evita que un pico extraordinario
// deforme demasiado el patrón normal.
// ============================================================

async function calcularBaselines(
  periodo =
    periodoActualCba(),

  ventanas =
    VENTANA_BASELINE_DEFAULT
) {

  const inicio =
    periodoAnterior(
      periodo,
      ventanas
    );


  const {
    data: snapshots,
    error
  } =
    await supabase
      .from(
        'cost_snapshots'
      )
      .select('*')
      .gte(
        'periodo',
        primerDiaPeriodo(
          inicio
        )
      )
      .lt(
        'periodo',
        primerDiaPeriodo(
          periodo
        )
      )
      .order(
        'periodo',
        {
          ascending:
            true
        }
      );


  if (
    error
  ) {

    throw error;
  }


  const grupos = {};


  for (
    const s of
    snapshots || []
  ) {

    const k =
      `${s.objetivo_id}::${s.familia}`;


    if (
      !grupos[k]
    ) {

      grupos[k] = [];
    }


    grupos[k].push(
      s
    );
  }


  const filas = [];


  for (
    const grupo of
    Object.values(
      grupos
    )
  ) {

    if (
      !grupo.length
    ) {

      continue;
    }


    const ultimo =
      grupo[
        grupo.length - 1
      ];


    const consumoEquipo =
      grupo
        .map(
          x =>
            x.litros_por_equipo ==
            null
              ? null
              : numero(
                  x.litros_por_equipo
                )
        )
        .filter(
          x =>
            x != null &&
            x > 0
        );


    const costoEquipo =
      grupo
        .map(
          x =>
            x.costo_por_equipo ==
            null
              ? null
              : numero(
                  x.costo_por_equipo
                )
        )
        .filter(
          x =>
            x != null &&
            x > 0
        );


    const litros =
      grupo
        .map(
          x =>
            numero(
              x.litros
            )
        )
        .filter(
          x =>
            x > 0
        );


    const importes =
      grupo
        .map(
          x =>
            numero(
              x.importe
            )
        )
        .filter(
          x =>
            x > 0
        );


    const consumoPorEquipoBase =
      mediana(
        consumoEquipo
      );


    const costoPorEquipoBase =
      mediana(
        costoEquipo
      );


    const consumoBase =
      mediana(
        litros
      );


    const costoBase =
      mediana(
        importes
      );


    // Para medir cuán estable
    // es la serie.
    const serieDispersion =
      consumoEquipo.length >= 3
        ? consumoEquipo
        : litros;


    const media =
      promedio(
        serieDispersion
      );


    const dispersionPct =
      media > 0
        ? (
            desviacionEstandar(
              serieDispersion
            ) /
            media *
            100
          )
        : 0;


    filas.push({

      objetivo_id:
        ultimo.objetivo_id,

      objetivo_nombre:
        ultimo.objetivo_nombre,

      familia:
        ultimo.familia,

      granularidad:
        'mensual',

      ventanas,

      consumo_base:
        redondear(
          consumoBase,
          3
        ),

      costo_base:
        Math.round(
          costoBase
        ),

      parque_base:
        mediana(
          grupo.map(
            x =>
              numero(
                x.parque_familia
              )
          )
        ),

      consumo_por_equipo_base:
        consumoPorEquipoBase ||
        null,

      costo_por_equipo_base:
        costoPorEquipoBase ||
        null,

      dispersion_pct:
        redondear(
          dispersionPct,
          2
        ),

      muestras:
        grupo.length,

      calculado_at:
        new Date()
          .toISOString(),
    });
  }


  if (
    !filas.length
  ) {

    return {

      periodo,

      baselines:
        0,
    };
  }


  const {
    data,
    error:
      errorUpsert
  } =
    await supabase
      .from(
        'cost_baselines'
      )
      .upsert(
        filas,
        {
          onConflict:
            'objetivo_id,familia,granularidad',
        }
      )
      .select();


  if (
    errorUpsert
  ) {

    throw errorUpsert;
  }


  console.log(
    `[cost-intelligence] ${data.length} baselines calculados`
  );


  return {

    periodo,

    baselines:
      data.length,
  };
}


// ============================================================
// LIMPIAR ANOMALÍAS AUTOMÁTICAS
//
// Antes de recalcular:
//
// eliminamos solamente anomalías:
//
// - abiertas
// - no validadas
//
// Nunca tocamos una anomalía
// que alguien ya revisó.
// ============================================================

async function limpiarAnomaliasAutomaticas(
  fecha
) {

  const {
    error
  } =
    await supabase
      .from(
        'cost_anomalies'
      )
      .delete()
      .eq(
        'periodo',
        fecha
      )
      .eq(
        'estado',
        'abierta'
      )
      .eq(
        'validada',
        false
      );


  if (
    error
  ) {

    throw error;
  }
}


// ============================================================
// DETECTAR ANOMALÍAS
// ============================================================

async function detectarAnomalias(
  periodo =
    periodoActualCba()
) {

  const fecha =
    primerDiaPeriodo(
      periodo
    );


  const [
    snapRes,
    baseRes
  ] =
    await Promise.all([

      supabase
        .from(
          'cost_snapshots'
        )
        .select('*')
        .eq(
          'periodo',
          fecha
        ),

      supabase
        .from(
          'cost_baselines'
        )
        .select('*')
        .eq(
          'granularidad',
          'mensual'
        ),

    ]);


  if (
    snapRes.error
  ) {

    throw snapRes.error;
  }


  if (
    baseRes.error
  ) {

    throw baseRes.error;
  }


  // Eliminamos alertas automáticas anteriores
  // para recalcularlas con los datos actuales.
  await limpiarAnomaliasAutomaticas(
    fecha
  );


  const baselines = {};


  for (
    const b of
    baseRes.data || []
  ) {

    baselines[
      `${b.objetivo_id}::${b.familia}`
    ] =
      b;
  }


  const anomalias = [];


  // ==========================================================
  // SI EL MES ACTUAL NO ESTÁ CERRADO
  //
  // Escalamos el esperado al porcentaje
  // de días hábiles transcurridos.
  //
  // Ejemplo:
  //
  // baseline mensual = 3.000 L
  // transcurrió 40% del mes
  //
  // esperado a hoy ≈ 1.200 L
  // ==========================================================

  const factorTiempo =
    factorPeriodoTranscurrido(
      periodo
    );


  console.log(
    `[cost-intelligence] ${periodo} factor temporal:`,
    redondear(
      factorTiempo *
      100,
      1
    ) + '%'
  );


  for (
    const s of
    snapRes.data || []
  ) {

    // ========================================================
    // DEPÓSITO SE CONTROLA ECONÓMICAMENTE,
    // PERO NO GENERA ALERTAS OPERATIVAS.
    // ========================================================

    if (
      esObjetivoNoOperativo(
        s.objetivo_nombre
      )
    ) {

      continue;
    }


    const b =
      baselines[
        `${s.objetivo_id}::${s.familia}`
      ];


    if (
      !b
    ) {

      continue;
    }


    // Necesitamos historial suficiente.
    if (
      numero(
        b.muestras
      ) <
      MIN_MUESTRAS_ANOMALIA
    ) {

      continue;
    }


    let metrica;
    let real;
    let esperadoMensual;


    // ========================================================
    // CON PARQUE CONFIABLE
    // ========================================================

    if (
      s.litros_por_equipo !=
        null &&
      b.consumo_por_equipo_base !=
        null &&
      numero(
        s.parque_familia
      ) > 0
    ) {

      metrica =
        'litros_por_equipo';


      real =
        numero(
          s.litros_por_equipo
        );


      esperadoMensual =
        numero(
          b.consumo_por_equipo_base
        );


    } else {


      // ======================================================
      // SIN PARQUE
      // ======================================================

      metrica =
        'litros';


      real =
        numero(
          s.litros
        );


      esperadoMensual =
        numero(
          b.consumo_base
        );
    }


    if (
      esperadoMensual <= 0
    ) {

      continue;
    }


    // Mes actual:
    // esperado proporcional a días transcurridos.
    const esperado =
      esperadoMensual *
      factorTiempo;


    if (
      esperado <= 0
    ) {

      continue;
    }


    const diferencia =
      real -
      esperado;


    const desvioPct =
      (
        diferencia /
        esperado
      ) *
      100;


    // Solo buscamos exceso.
    if (
      desvioPct <
      UMBRAL_DESVIO_PCT
    ) {

      continue;
    }


    // ========================================================
    // LITROS ESPERADOS
    // ========================================================

    let litrosEsperados;


    if (
      metrica ===
      'litros_por_equipo'
    ) {

      litrosEsperados =
        esperado *
        numero(
          s.parque_familia
        );

    } else {

      litrosEsperados =
        esperado;
    }


    const litrosExceso =
      Math.max(
        0,
        numero(
          s.litros
        ) -
        litrosEsperados
      );


    // ========================================================
    // PRECIO PROMEDIO REAL DEL SNAPSHOT
    // ========================================================

    const precioPromedio =
      numero(
        s.litros
      ) > 0 &&
      numero(
        s.importe
      ) > 0

        ? (
            numero(
              s.importe
            ) /
            numero(
              s.litros
            )
          )

        : 0;


    const impacto =
      litrosExceso *
      precioPromedio;


    // ========================================================
    // SEVERIDAD
    // ========================================================

    let severidad =
      'baja';


    if (
      desvioPct >= 40
    ) {

      severidad =
        'critica';

    } else if (
      desvioPct >= 25
    ) {

      severidad =
        'alta';

    } else if (
      desvioPct >= 15
    ) {

      severidad =
        'media';
    }


    anomalias.push({

      snapshot_id:
        s.id,

      periodo:
        s.periodo,

      objetivo_id:
        s.objetivo_id,

      objetivo_nombre:
        s.objetivo_nombre,

      familia:
        s.familia,

      metrica,

      esperado:
        redondear(
          esperado,
          3
        ),

      real:
        redondear(
          real,
          3
        ),

      desvio_abs:
        redondear(
          diferencia,
          3
        ),

      desvio_pct:
        redondear(
          desvioPct,
          2
        ),

      litros_exceso:
        redondear(
          litrosExceso,
          2
        ),

      impacto_estimado:
        Math.round(
          impacto
        ),

      severidad,

      estado:
        'abierta',
    });
  }


  if (
    !anomalias.length
  ) {

    console.log(
      `[cost-intelligence] ${periodo}: sin anomalías`
    );


    return {

      periodo,

      anomalias:
        0,
    };
  }


  const {
    data,
    error
  } =
    await supabase
      .from(
        'cost_anomalies'
      )
      .upsert(
        anomalias,
        {
          onConflict:
            'snapshot_id,metrica',

          // Si existe una anomalía revisada,
          // no la pisamos.
          ignoreDuplicates:
            true,
        }
      )
      .select();


  if (
    error
  ) {

    throw error;
  }


  console.log(
    `[cost-intelligence] ${periodo}: ${data ? data.length : 0} anomalías`
  );


  return {

    periodo,

    anomalias:
      data
        ? data.length
        : 0,
  };
}


// ============================================================
// EJECUCIÓN COMPLETA
//
// 1. Snapshot
// 2. Baseline
// 3. Anomalías
// ============================================================

async function ejecutarCostIntelligence(
  periodo =
    periodoActualCba()
) {

  const inicio =
    Date.now();


  console.log(
    '============================================='
  );

  console.log(
    `[cost-intelligence] iniciando ${periodo}`
  );


  // ==========================================================
  // 1. SNAPSHOT
  // ==========================================================

  const snapshot =
    await generarSnapshotMensual(
      periodo
    );


  // ==========================================================
  // 2. BASELINE
  // ==========================================================

  const baseline =
    await calcularBaselines(
      periodo,
      VENTANA_BASELINE_DEFAULT
    );


  // ==========================================================
  // 3. ANOMALÍAS
  // ==========================================================

  const anomalias =
    await detectarAnomalias(
      periodo
    );


  const resultado = {

    ok:
      true,

    periodo,

    snapshot,

    baseline,

    anomalias,

    duracion_ms:
      Date.now() -
      inicio,
  };


  console.log(
    '[cost-intelligence] finalizado',
    resultado
  );


  console.log(
    '============================================='
  );


  return resultado;
}


// ============================================================
// EXPORTS
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
