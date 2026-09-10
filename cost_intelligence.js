// ============================================================
// COST INTELLIGENCE V2.0
// ECOSERVICE
//
// CEREBRO SEMANAL DE INTELIGENCIA DE COSTOS
//
// Objetivo:
// OBJETIVO
//   ↓
// SEMANA
//   ↓
// CONSUMO
//   ↓
// PARQUE
//   ↓
// NORMALIZACIÓN
//   ↓
// BASELINE 8 SEMANAS
//   ↓
// DESVÍO
//   ↓
// CONFIANZA
//   ↓
// IMPACTO ECONÓMICO
//
// Compatible con:
// ejecutarCostIntelligence('2026-09')
//
// Eso genera y analiza todas las semanas de septiembre.
// ============================================================

const supabase = require('./supabase');

const {
  agruparPorFamilia,
  FAMILIAS_CON_MOTOR,
} = require('./familias_consumo');


// ============================================================
// CONFIGURACIÓN
// ============================================================

const GRANULARIDAD = 'semanal';


// Cantidad máxima de semanas usadas
// para construir la línea base.
const VENTANA_SEMANAS = 8;


// Necesitamos al menos 5 semanas
// para crear una anomalía real.
const MIN_MUESTRAS_ANOMALIA = 5;


// Umbral mínimo absoluto.
const UMBRAL_MINIMO_PCT = 15;


// Si la serie es muy variable,
// exigimos un desvío superior.
//
// Ej:
// dispersión histórica 12%
//
// umbral dinámico:
//
// 12 × 2 = 24%
const MULTIPLICADOR_DISPERSION = 2;


// Familias que NO usamos para generar alertas.
//
// Se mantienen en snapshots para análisis,
// pero evitamos duplicar:
//
// TOTAL = 100L
// BIDONES = 100L
//
// No queremos dos alertas iguales.
const FAMILIAS_NO_ALERTABLES = [
  'bidones',
  'unidades',
];


// Centros que queremos contabilizar
// pero NO tratar como objetivos operativos.
const OBJETIVOS_NO_OPERATIVOS = [
  'deposito',
];


// ============================================================
// UTILIDADES
// ============================================================

function numero(v) {

  const n = Number(v);

  return Number.isFinite(n)
    ? n
    : 0;
}


function redondear(
  valor,
  decimales = 2
) {

  const p =
    10 ** decimales;

  return Math.round(
    (
      numero(valor) +
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
      .filter(Number.isFinite);


  if (!arr.length) {
    return 0;
  }


  return (
    arr.reduce(
      (suma, valor) =>
        suma + valor,
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
      .filter(Number.isFinite)
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
      .filter(Number.isFinite);


  if (
    arr.length < 2
  ) {

    return 0;
  }


  const media =
    promedio(arr);


  const varianza =
    arr.reduce(
      (suma, valor) => {

        return (
          suma +
          Math.pow(
            valor - media,
            2
          )
        );

      },
      0
    ) /
    arr.length;


  return Math.sqrt(
    varianza
  );
}


function normalizarTexto(
  texto
) {

  return String(
    texto || ''
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


// ============================================================
// FECHA LOCAL CÓRDOBA
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


// ============================================================
// UTILIDADES FECHA UTC
// ============================================================

function fechaUTC(
  texto
) {

  return new Date(
    `${texto}T00:00:00Z`
  );
}


function fechaISO(
  fecha
) {

  return fecha
    .toISOString()
    .slice(
      0,
      10
    );
}


function sumarDias(
  fechaTexto,
  cantidad
) {

  const d =
    fechaUTC(
      fechaTexto
    );


  d.setUTCDate(
    d.getUTCDate() +
    cantidad
  );


  return fechaISO(d);
}


function primerDiaPeriodo(
  periodo
) {

  return `${periodo}-01`;
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
// SEMANAS
// ============================================================

// Devuelve lunes de la semana
// correspondiente a una fecha.
function inicioSemana(
  fechaTexto
) {

  const fecha =
    fechaUTC(
      fechaTexto
    );


  const dia =
    fecha.getUTCDay();


  // JS:
// domingo = 0
// lunes   = 1
//
// Queremos lunes = inicio.
  const diferencia =
    dia === 0
      ? -6
      : 1 - dia;


  fecha.setUTCDate(
    fecha.getUTCDate() +
    diferencia
  );


  return fechaISO(
    fecha
  );
}


// Devuelve lunes siguiente.
function semanaSiguiente(
  semana
) {

  return sumarDias(
    semana,
    7
  );
}


// Devuelve semana anterior.
function semanaAnterior(
  semana,
  cantidad = 1
) {

  return sumarDias(
    semana,
    -7 * cantidad
  );
}


// Todas las semanas que tocan un mes.
//
// Ejemplo:
//
// septiembre puede producir:
//
// 2026-08-31
// 2026-09-07
// 2026-09-14
// 2026-09-21
// 2026-09-28
function semanasDelMes(
  periodo
) {

  const inicioMes =
    primerDiaPeriodo(
      periodo
    );


  const finMes =
    limiteSuperiorMes(
      periodo
    );


  let semana =
    inicioSemana(
      inicioMes
    );


  const resultado = [];


  while (
    semana < finMes
  ) {

    resultado.push(
      semana
    );


    semana =
      semanaSiguiente(
        semana
      );
  }


  return resultado;
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


function diasHabilesEntre(
  desdeTexto,
  hastaExclusivoTexto
) {

  let fecha =
    fechaUTC(
      desdeTexto
    );


  const hasta =
    fechaUTC(
      hastaExclusivoTexto
    );


  let cantidad = 0;


  while (
    fecha < hasta
  ) {

    if (
      esDiaHabil(
        fecha
      )
    ) {

      cantidad++;
    }


    fecha.setUTCDate(
      fecha.getUTCDate() +
      1
    );
  }


  return cantidad;
}


// ============================================================
// FACTOR DE SEMANA TRANSCURRIDA
//
// Semana cerrada:
// 100%
//
// Semana actual:
// porcentaje de días hábiles transcurridos.
//
// Ej:
//
// miércoles:
//
// 3 / 5 = 60%
// ============================================================

function factorSemanaTranscurrida(
  semana
) {

  const hoy =
    hoyCordoba();


  const inicio =
    semana;


  const fin =
    semanaSiguiente(
      semana
    );


  // Semana futura.
  if (
    inicio > hoy
  ) {

    return 0;
  }


  // Semana terminada.
  if (
    fin <= hoy
  ) {

    return 1;
  }


  const totalHabiles =
    diasHabilesEntre(
      inicio,
      fin
    );


  const manana =
    sumarDias(
      hoy,
      1
    );


  const transcurridos =
    diasHabilesEntre(
      inicio,
      manana
    );


  if (
    totalHabiles <= 0
  ) {

    return 1;
  }


  return Math.max(
    0.01,
    Math.min(
      1,
      transcurridos /
      totalHabiles
    )
  );
}


// ============================================================
// OBJETIVO NO OPERATIVO
// ============================================================

function esObjetivoNoOperativo(
  nombre
) {

  const normalizado =
    normalizarTexto(
      nombre
    );


  return (
    OBJETIVOS_NO_OPERATIVOS
      .some(
        palabra => {

          return (
            normalizado ===
              palabra ||

            normalizado.includes(
              `${palabra} `
            ) ||

            normalizado.includes(
              ` ${palabra}`
            )
          );

        }
      )
  );
}


// ============================================================
// MAPA OBJETIVOS
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


  const lista =
    data || [];


  const porId = {};
  const porNombre = {};


  for (
    const objetivo of
    lista
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
    lista,
    porId,
    porNombre,
  };
}


// ============================================================
// PARQUE
//
// Usa último censo disponible
// hasta el mes de esa semana.
// ============================================================

async function obtenerParque(
  periodo
) {

  const mapaObjetivos =
    await cargarMapaObjetivos();


  const {
    data: censos,
    error
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


  if (error) {
    throw error;
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


  const resultado = {};


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


    resultado[
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


  return resultado;
}


// ============================================================
// PRECIO DE COMBUSTIBLE
// ============================================================

function obtenerCandidatosPrecio(
  cargas
) {

  const candidatos = [];


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

        candidatos.push(
          precioUnit
        );

        continue;
      }


      if (
        subtotal > 0 &&
        litros > 0
      ) {

        candidatos.push(
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

      candidatos.push(
        totalCarga /
        litrosCarga
      );
    }
  }


  return candidatos.filter(
    x =>
      Number.isFinite(x) &&
      x > 0
  );
}


// ============================================================
// PRECIO REFERENCIA ROBUSTO
//
// 1. Calculamos mediana.
// 2. Eliminamos precios extremos.
// 3. Volvemos a calcular mediana.
//
// Esto evita que un comprobante mal interpretado
// distorsione todo el costo.
// ============================================================

function calcularPrecioReferencia(
  cargas
) {

  const candidatos =
    obtenerCandidatosPrecio(
      cargas
    );


  if (
    !candidatos.length
  ) {

    return 0;
  }


  const medianaInicial =
    mediana(
      candidatos
    );


  if (
    medianaInicial <= 0
  ) {

    return 0;
  }


  const filtrados =
    candidatos.filter(
      precio => {

        return (
          precio >=
            medianaInicial * 0.5 &&

          precio <=
            medianaInicial * 2
        );

      }
    );


  if (
    !filtrados.length
  ) {

    return medianaInicial;
  }


  return mediana(
    filtrados
  );
}


// ============================================================
// VALIDAR PRECIO
// ============================================================

function precioEsRazonable(
  precio,
  referencia
) {

  if (
    precio <= 0
  ) {

    return false;
  }


  if (
    referencia <= 0
  ) {

    return true;
  }


  return (
    precio >=
      referencia * 0.5 &&

    precio <=
      referencia * 2
  );
}


// ============================================================
// IMPORTE ITEM
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
    subtotal > 0 &&
    litrosItem > 0
  ) {

    const precioSubtotal =
      subtotal /
      litrosItem;


    if (
      precioEsRazonable(
        precioSubtotal,
        precioReferencia
      )
    ) {

      return subtotal;
    }
  }


  const precioUnit =
    numero(
      item.precio_unit
    );


  if (
    precioUnit > 0 &&
    litrosItem > 0 &&
    precioEsRazonable(
      precioUnit,
      precioReferencia
    )
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

    const precioCarga =
      totalCarga /
      litrosCombustibleCarga;


    if (
      precioEsRazonable(
        precioCarga,
        precioReferencia
      )
    ) {

      const proporcion =
        litrosItem /
        litrosCombustibleCarga;


      return (
        totalCarga *
        proporcion
      );
    }
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
// OBTENER CONSUMO DE UNA SEMANA
// ============================================================

async function obtenerConsumoSemana(
  semana
) {

  const desde =
    semana;


  const hasta =
    semanaSiguiente(
      semana
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


  if (
    !listaCargas.length
  ) {

    return [];
  }


  const mapaObjetivos =
    await cargarMapaObjetivos();


  const precioReferencia =
    calcularPrecioReferencia(
      listaCargas
    );


  console.log(
    `[cost-intelligence] semana ${semana} precio referencia $${redondear(
      precioReferencia,
      2
    )}/L`
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


    agrupado[
      k
    ].litros +=
      numero(
        litros
      );


    agrupado[
      k
    ].importe +=
      numero(
        importe
      );


    if (
      cargaId
    ) {

      agrupado[
        k
      ]
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


    const objetivoCarga =
      objetivoCargaId
        ? mapaObjetivos
            .porId[
              objetivoCargaId
            ]
        : null;


    const objetivoCargaNombre =
      (
        carga.objetivos &&
        carga.objetivos.nombre
      ) ||
      (
        objetivoCarga &&
        objetivoCarga.nombre
      ) ||
      null;


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


    const itemsCombustible =
      items.filter(
        item =>
          item.es_combustible !==
          false
      );


    let litrosCombustibleCarga =
      itemsCombustible
        .reduce(
          (
            suma,
            item
          ) =>
            suma +
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


      const importe =
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
          .trim()
          .toLowerCase() ===
        'bidon';


      // ======================================================
      // RESOLVER OBJETIVO
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


      if (
        !objetivoId &&
        esBidon &&
        item.destino_detalle
      ) {

        const nombreRaw =
          String(
            item.destino_detalle
          )
            .trim();


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

        importe,

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

        importe,

        cargaId:
          carga.id,
      });


      // ======================================================
      // FAMILIA REAL DECLARADA
      // ======================================================

      const familiaDeclarada =
        String(
          item.familia_consumo ||
          ''
        )
          .trim();


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

          importe,

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
        fila => ({

          ...fila,

          litros:
            redondear(
              fila.litros,
              2
            ),

          importe:
            Math.round(
              fila.importe
            ),

          cantidad_cargas:
            fila.cargas.size,

        })
      )
  );
}


// ============================================================
// RESOLVER OBJETIVOS
// ============================================================

async function resolverObjetivos(
  consumos
) {

  const mapa =
    await cargarMapaObjetivos();


  return (
    consumos.map(
      consumo => {

        if (
          consumo.objetivo_id
        ) {

          const encontrado =
            mapa
              .porId[
                consumo.objetivo_id
              ];


          if (
            encontrado
          ) {

            return {

              ...consumo,

              objetivo_nombre:
                encontrado.nombre,
            };
          }


          return consumo;
        }


        const encontrado =
          mapa
            .porNombre[
              normalizarTexto(
                consumo.objetivo_nombre
              )
            ];


        if (
          !encontrado
        ) {

          return consumo;
        }


        return {

          ...consumo,

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
// SNAPSHOT SEMANAL
// ============================================================

async function generarSnapshotSemanal(
  semana
) {

  console.log(
    `[cost-intelligence] generando semana ${semana}`
  );


  const periodo =
    semana.slice(
      0,
      7
    );


  const [
    parque,
    consumoRaw
  ] =
    await Promise.all([

      obtenerParque(
        periodo
      ),

      obtenerConsumoSemana(
        semana
      ),

    ]);


  const consumos =
    await resolverObjetivos(
      consumoRaw
    );


  const filas = [];


  for (
    const consumo of
    consumos
  ) {

    if (
      !consumo.objetivo_id
    ) {

      continue;
    }


    const p =
      parque[
        consumo.objetivo_id
      ] || {

        total:
          0,

        con_motor:
          0,
      };


    let parqueFamilia = 0;


    // Familia concreta.
    if (
      FAMILIAS_CON_MOTOR
        .includes(
          consumo.familia
        )
    ) {

      parqueFamilia =
        numero(
          p[
            consumo.familia
          ]
        );
    }


    // Total y bidones:
    // normalizamos por parque motorizado.
    if (
      consumo.familia ===
        'total' ||
      consumo.familia ===
        'bidones'
    ) {

      parqueFamilia =
        numero(
          p.con_motor
        );
    }


    // Unidades:
    // no normalizamos todavía.
    if (
      consumo.familia ===
      'unidades'
    ) {

      parqueFamilia =
        0;
    }


    const litrosPorEquipo =
      parqueFamilia > 0

        ? (
            consumo.litros /
            parqueFamilia
          )

        : null;


    const costoPorEquipo =
      parqueFamilia > 0

        ? (
            consumo.importe /
            parqueFamilia
          )

        : null;


    filas.push({

      periodo:
        semana,

      granularidad:
        GRANULARIDAD,

      objetivo_id:
        consumo.objetivo_id,

      objetivo_nombre:
        consumo.objetivo_nombre,

      familia:
        consumo.familia,

      litros:
        redondear(
          consumo.litros,
          2
        ),

      importe:
        Math.round(
          consumo.importe
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
          consumo
            .cantidad_cargas
        ),

      updated_at:
        new Date()
          .toISOString(),
    });
  }


  // ==========================================================
  // LIMPIAR SNAPSHOTS SEMANALES ANTERIORES
  //
  // Solamente esta semana.
  // Los mensuales viejos quedan intactos.
  // ==========================================================

  const {
    error:
      errorDelete
  } =
    await supabase
      .from(
        'cost_snapshots'
      )
      .delete()
      .eq(
        'periodo',
        semana
      )
      .eq(
        'granularidad',
        GRANULARIDAD
      );


  if (
    errorDelete
  ) {

    throw errorDelete;
  }


  if (
    !filas.length
  ) {

    return {

      semana,

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
    `[cost-intelligence] semana ${semana}: ${data.length} snapshots`
  );


  return {

    semana,

    snapshots:
      data.length,
  };
}


// ============================================================
// GENERAR TODAS LAS SEMANAS DEL MES
// ============================================================

async function generarSnapshotsSemanalesMes(
  periodo
) {

  const semanas =
    semanasDelMes(
      periodo
    );


  const hoy =
    hoyCordoba();


  const detalles = [];

  let total = 0;


  for (
    const semana of semanas
  ) {

    // No generamos semanas
    // completamente futuras.
    if (
      semana > hoy
    ) {

      continue;
    }


    const resultado =
      await generarSnapshotSemanal(
        semana
      );


    detalles.push(
      resultado
    );


    total +=
      numero(
        resultado.snapshots
      );
  }


  return {

    periodo,

    granularidad:
      GRANULARIDAD,

    snapshots:
      total,

    semanas:
      detalles,
  };
}


// ============================================================
// OBTENER HISTORIAL PARA BASELINE
// ============================================================

async function obtenerHistorico(
  semana,
  objetivoId,
  familia,
  ventanas =
    VENTANA_SEMANAS
) {

  const desde =
    semanaAnterior(
      semana,
      ventanas
    );


  const {
    data,
    error
  } =
    await supabase
      .from(
        'cost_snapshots'
      )
      .select('*')
      .eq(
        'granularidad',
        GRANULARIDAD
      )
      .eq(
        'objetivo_id',
        objetivoId
      )
      .eq(
        'familia',
        familia
      )
      .gte(
        'periodo',
        desde
      )
      .lt(
        'periodo',
        semana
      )
      .order(
        'periodo',
        {
          ascending:
            true
        }
      );


  if (error) {
    throw error;
  }


  return data || [];
}


// ============================================================
// CALCULAR BASELINE DE UNA SERIE
// ============================================================

function construirBaseline(
  historico
) {

  const filas =
    historico || [];


  const litros =
    filas
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


  const costos =
    filas
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


  const litrosEquipo =
    filas
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


  const costosEquipo =
    filas
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


  const parque =
    filas
      .map(
        x =>
          numero(
            x.parque_familia
          )
      )
      .filter(
        x =>
          x >= 0
      );


  const seriePrincipal =
    litrosEquipo.length >=
      MIN_MUESTRAS_ANOMALIA

      ? litrosEquipo

      : litros;


  const media =
    promedio(
      seriePrincipal
    );


  const dispersion =
    media > 0

      ? (
          desviacionEstandar(
            seriePrincipal
          ) /
          media *
          100
        )

      : 0;


  return {

    muestras:
      filas.length,

    consumo_base:
      mediana(
        litros
      ),

    costo_base:
      mediana(
        costos
      ),

    consumo_por_equipo_base:
      litrosEquipo.length
        ? mediana(
            litrosEquipo
          )
        : null,

    costo_por_equipo_base:
      costosEquipo.length
        ? mediana(
            costosEquipo
          )
        : null,

    parque_base:
      parque.length
        ? mediana(
            parque
          )
        : 0,

    dispersion_pct:
      redondear(
        dispersion,
        2
      ),
  };
}


// ============================================================
// CONFIANZA
// ============================================================

function calcularConfianza({
  muestras,
  dispersionPct,
}) {

  if (
    muestras < 3
  ) {

    return {
      nivel:
        'insuficiente',

      score:
        0,
    };
  }


  if (
    muestras < 5
  ) {

    return {
      nivel:
        'baja',

      score:
        25,
    };
  }


  if (
    dispersionPct > 50
  ) {

    return {
      nivel:
        'baja',

      score:
        35,
    };
  }


  if (
    muestras >= 7 &&
    dispersionPct <= 25
  ) {

    return {
      nivel:
        'alta',

      score:
        90,
    };
  }


  if (
    muestras >= 6 &&
    dispersionPct <= 35
  ) {

    return {
      nivel:
        'alta',

      score:
        80,
    };
  }


  return {
    nivel:
      'media',

    score:
      60,
  };
}


// ============================================================
// UMBRAL DINÁMICO
// ============================================================

function calcularUmbral(
  dispersionPct
) {

  const dinamico =
    numero(
      dispersionPct
    ) *
    MULTIPLICADOR_DISPERSION;


  return Math.max(
    UMBRAL_MINIMO_PCT,
    dinamico
  );
}


// ============================================================
// CALCULAR Y GUARDAR BASELINES
// PARA UNA SEMANA
// ============================================================

async function calcularBaselinesSemana(
  semana,
  ventanas =
    VENTANA_SEMANAS
) {

  const {
    data: actuales,
    error
  } =
    await supabase
      .from(
        'cost_snapshots'
      )
      .select('*')
      .eq(
        'periodo',
        semana
      )
      .eq(
        'granularidad',
        GRANULARIDAD
      );


  if (error) {
    throw error;
  }


  const filasBaseline = [];


  for (
    const snapshot of
    actuales || []
  ) {

    const historico =
      await obtenerHistorico(
        semana,
        snapshot.objetivo_id,
        snapshot.familia,
        ventanas
      );


    if (
      !historico.length
    ) {

      continue;
    }


    const base =
      construirBaseline(
        historico
      );


    filasBaseline.push({

      objetivo_id:
        snapshot.objetivo_id,

      objetivo_nombre:
        snapshot.objetivo_nombre,

      familia:
        snapshot.familia,

      granularidad:
        GRANULARIDAD,

      ventanas,

      consumo_base:
        redondear(
          base.consumo_base,
          3
        ),

      costo_base:
        Math.round(
          base.costo_base
        ),

      parque_base:
        redondear(
          base.parque_base,
          2
        ),

      consumo_por_equipo_base:
        base
          .consumo_por_equipo_base ==
        null
          ? null
          : redondear(
              base
                .consumo_por_equipo_base,
              3
            ),

      costo_por_equipo_base:
        base
          .costo_por_equipo_base ==
        null
          ? null
          : Math.round(
              base
                .costo_por_equipo_base
            ),

      dispersion_pct:
        redondear(
          base.dispersion_pct,
          2
        ),

      muestras:
        base.muestras,

      calculado_at:
        new Date()
          .toISOString(),
    });
  }


  if (
    !filasBaseline.length
  ) {

    return {

      semana,

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
        filasBaseline,
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


  return {

    semana,

    baselines:
      data
        ? data.length
        : 0,
  };
}


// ============================================================
// LIMPIAR ANOMALÍAS AUTOMÁTICAS
// ============================================================

async function limpiarAnomaliasSemana(
  semana
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
        semana
      )
      .eq(
        'estado',
        'abierta'
      )
      .eq(
        'validada',
        false
      );


  if (error) {
    throw error;
  }
}


// ============================================================
// DETECTAR ANOMALÍAS DE UNA SEMANA
// ============================================================

async function detectarAnomaliasSemana(
  semana
) {

  const {
    data: snapshots,
    error
  } =
    await supabase
      .from(
        'cost_snapshots'
      )
      .select('*')
      .eq(
        'periodo',
        semana
      )
      .eq(
        'granularidad',
        GRANULARIDAD
      );


  if (error) {
    throw error;
  }


  await limpiarAnomaliasSemana(
    semana
  );


  const factorTiempo =
    factorSemanaTranscurrida(
      semana
    );


  const anomalías = [];


  for (
    const snapshot of
    snapshots || []
  ) {

    // ========================================================
    // DEPÓSITO NO GENERA ALERTA
    // ========================================================

    if (
      esObjetivoNoOperativo(
        snapshot.objetivo_nombre
      )
    ) {

      continue;
    }


    // ========================================================
    // EVITAR DUPLICACIONES
    // ========================================================

    if (
      FAMILIAS_NO_ALERTABLES
        .includes(
          snapshot.familia
        )
    ) {

      continue;
    }


    const historico =
      await obtenerHistorico(
        semana,
        snapshot.objetivo_id,
        snapshot.familia,
        VENTANA_SEMANAS
      );


    const base =
      construirBaseline(
        historico
      );


    if (
      base.muestras <
      MIN_MUESTRAS_ANOMALIA
    ) {

      continue;
    }


    const confianza =
      calcularConfianza({

        muestras:
          base.muestras,

        dispersionPct:
          base.dispersion_pct,

      });


    // No generamos alerta
    // con confianza baja.
    if (
      confianza.nivel ===
        'baja' ||
      confianza.nivel ===
        'insuficiente'
    ) {

      continue;
    }


    let metrica;

    let esperadoSemana;

    let real;


    // ========================================================
    // NORMALIZADO POR PARQUE
    // ========================================================

    if (
      snapshot
        .litros_por_equipo !=
        null &&

      base
        .consumo_por_equipo_base !=
        null &&

      numero(
        snapshot.parque_familia
      ) > 0
    ) {

      metrica =
        'litros_por_equipo';


      esperadoSemana =
        numero(
          base
            .consumo_por_equipo_base
        );


      real =
        numero(
          snapshot
            .litros_por_equipo
        );


    } else {


      // ======================================================
      // SIN PARQUE
      // ======================================================

      metrica =
        'litros';


      esperadoSemana =
        numero(
          base.consumo_base
        );


      real =
        numero(
          snapshot.litros
        );
    }


    // Semana actual incompleta.
    const esperado =
      esperadoSemana *
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


    const umbral =
      calcularUmbral(
        base.dispersion_pct
      );


    // Solo excesos.
    if (
      desvioPct <
      umbral
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
          snapshot.parque_familia
        );

    } else {

      litrosEsperados =
        esperado;
    }


    const litrosExceso =
      Math.max(
        0,

        numero(
          snapshot.litros
        ) -
        litrosEsperados
      );


    // ========================================================
    // PRECIO PROMEDIO REAL
    // ========================================================

    const precioPromedio =
      numero(
        snapshot.litros
      ) > 0

        ? (
            numero(
              snapshot.importe
            ) /
            numero(
              snapshot.litros
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
      'media';


    if (
      desvioPct >= 60
    ) {

      severidad =
        'critica';

    } else if (
      desvioPct >= 35
    ) {

      severidad =
        'alta';

    } else {

      severidad =
        'media';
    }


    // ========================================================
    // GUARDAR
    // ========================================================

    anomalías.push({

      snapshot_id:
        snapshot.id,

      periodo:
        snapshot.periodo,

      objetivo_id:
        snapshot.objetivo_id,

      objetivo_nombre:
        snapshot.objetivo_nombre,

      familia:
        snapshot.familia,

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
        Math.max(
          0,
          Math.round(
            impacto
          )
        ),

      severidad,

      estado:
        'abierta',

      // No usamos observacion para guardar
      // confianza porque está reservada
      // para revisión humana.
    });
  }


  if (
    !anomalías.length
  ) {

    return {

      semana,

      anomalias:
        0,
    };
  }


  const {
    data,
    error:
      errorInsert
  } =
    await supabase
      .from(
        'cost_anomalies'
      )
      .upsert(
        anomalías,
        {
          onConflict:
            'snapshot_id,metrica',

          ignoreDuplicates:
            true,
        }
      )
      .select();


  if (
    errorInsert
  ) {

    throw errorInsert;
  }


  return {

    semana,

    anomalias:
      data
        ? data.length
        : 0,
  };
}


// ============================================================
// ANALIZAR UNA SEMANA COMPLETA
// ============================================================

async function analizarSemana(
  semana
) {

  const snapshot =
    await generarSnapshotSemanal(
      semana
    );


  const baseline =
    await calcularBaselinesSemana(
      semana,
      VENTANA_SEMANAS
    );


  const anomalias =
    await detectarAnomaliasSemana(
      semana
    );


  return {

    semana,

    snapshot,

    baseline,

    anomalias,
  };
}


// ============================================================
// EJECUTAR MES COMPLETO
//
// IMPORTANTE:
//
// Seguimos aceptando:
//
// ejecutarCostIntelligence('2026-09')
//
// Pero internamente ahora trabaja SEMANA A SEMANA.
// ============================================================

async function ejecutarCostIntelligence(
  periodo =
    periodoActualCba()
) {

  const inicio =
    Date.now();


  if (
    !/^\d{4}-\d{2}$/.test(
      periodo
    )
  ) {

    throw new Error(
      'Periodo inválido. Usá formato YYYY-MM'
    );
  }


  console.log(
    '================================================'
  );

  console.log(
    `[cost-intelligence V2] procesando ${periodo}`
  );


  const semanas =
    semanasDelMes(
      periodo
    );


  const hoy =
    hoyCordoba();


  const resultados = [];


  let totalSnapshots = 0;
  let totalBaselines = 0;
  let totalAnomalias = 0;


  for (
    const semana of semanas
  ) {

    // Semana completamente futura.
    if (
      semana > hoy
    ) {

      continue;
    }


    console.log(
      `--- semana ${semana} ---`
    );


    const resultado =
      await analizarSemana(
        semana
      );


    resultados.push(
      resultado
    );


    totalSnapshots +=
      numero(
        resultado
          .snapshot
          .snapshots
      );


    totalBaselines +=
      numero(
        resultado
          .baseline
          .baselines
      );


    totalAnomalias +=
      numero(
        resultado
          .anomalias
          .anomalias
      );
  }


  const resultadoFinal = {

    ok:
      true,

    version:
      '2.0',

    periodo,

    granularidad:
      GRANULARIDAD,

    semanas_procesadas:
      resultados.length,

    snapshot: {

      periodo,

      snapshots:
        totalSnapshots,

    },

    baseline: {

      periodo,

      baselines:
        totalBaselines,

    },

    anomalias: {

      periodo,

      anomalias:
        totalAnomalias,

    },

    detalle_semanas:
      resultados,

    duracion_ms:
      Date.now() -
      inicio,
  };


  console.log(
    '[cost-intelligence V2] finalizado:',
    {
      periodo,
      semanas:
        resultados.length,
      snapshots:
        totalSnapshots,
      baselines:
        totalBaselines,
      anomalias:
        totalAnomalias,
    }
  );


  console.log(
    '================================================'
  );


  return resultadoFinal;
}


// ============================================================
// COMPATIBILIDAD CON API EXISTENTE
//
// La API anterior llama:
// generarSnapshotMensual('2026-09')
//
// Ahora genera snapshots semanales
// del mes solicitado.
// ============================================================

async function generarSnapshotMensual(
  periodo =
    periodoActualCba()
) {

  return generarSnapshotsSemanalesMes(
    periodo
  );
}


// ============================================================
// COMPATIBILIDAD:
// calcularBaselines('2026-09')
//
// Calcula baseline de todas las semanas
// existentes del mes.
// ============================================================

async function calcularBaselines(
  periodo =
    periodoActualCba(),

  ventanas =
    VENTANA_SEMANAS
) {

  const semanas =
    semanasDelMes(
      periodo
    );


  const hoy =
    hoyCordoba();


  let total = 0;

  const detalle = [];


  for (
    const semana of semanas
  ) {

    if (
      semana > hoy
    ) {

      continue;
    }


    const resultado =
      await calcularBaselinesSemana(
        semana,
        ventanas
      );


    detalle.push(
      resultado
    );


    total +=
      numero(
        resultado.baselines
      );
  }


  return {

    periodo,

    granularidad:
      GRANULARIDAD,

    baselines:
      total,

    semanas:
      detalle,
  };
}


// ============================================================
// COMPATIBILIDAD:
// detectarAnomalias('2026-09')
//
// Analiza todas las semanas del mes.
// ============================================================

async function detectarAnomalias(
  periodo =
    periodoActualCba()
) {

  const semanas =
    semanasDelMes(
      periodo
    );


  const hoy =
    hoyCordoba();


  let total = 0;

  const detalle = [];


  for (
    const semana of semanas
  ) {

    if (
      semana > hoy
    ) {

      continue;
    }


    const resultado =
      await detectarAnomaliasSemana(
        semana
      );


    detalle.push(
      resultado
    );


    total +=
      numero(
        resultado.anomalias
      );
  }


  return {

    periodo,

    granularidad:
      GRANULARIDAD,

    anomalias:
      total,

    semanas:
      detalle,
  };
}


// ============================================================
// OBTENER CONSUMO
//
// Compatibilidad.
//
// Si recibe YYYY-MM:
// devuelve todas las semanas del mes.
//
// Si recibe YYYY-MM-DD:
// devuelve esa semana.
// ============================================================

async function obtenerConsumo(
  periodo
) {

  if (
    /^\d{4}-\d{2}-\d{2}$/.test(
      periodo
    )
  ) {

    return obtenerConsumoSemana(
      inicioSemana(
        periodo
      )
    );
  }


  if (
    /^\d{4}-\d{2}$/.test(
      periodo
    )
  ) {

    const semanas =
      semanasDelMes(
        periodo
      );


    const resultado = [];


    for (
      const semana of semanas
    ) {

      const filas =
        await obtenerConsumoSemana(
          semana
        );


      resultado.push(
        ...filas
      );
    }


    return resultado;
  }


  throw new Error(
    'Periodo inválido'
  );
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

  // Compatibilidad
  generarSnapshotMensual,

  calcularBaselinesSemana,

  calcularBaselines,

  detectarAnomaliasSemana,

  detectarAnomalias,

  analizarSemana,

  ejecutarCostIntelligence,

  calcularConfianza,

  calcularUmbral,
};
