// ============================================================
// COST INTELLIGENCE V2.2
// ECOSERVICE
//
// Inteligencia semanal de costos.
//
// TOTAL
//   -> litros semanales
//
// FAMILIAS REALES
//   -> litros/equipo cuando parque es confiable
//
// IMPACTO ECONÓMICO
//   -> valida precio actual
//   -> compara contra historial
//   -> si el precio actual es anormal,
//      usa precio histórico robusto
//
// ============================================================

const supabase = require('./supabase');

const {
  agruparPorFamilia,
  FAMILIAS_CON_MOTOR,
} = require('./familias_consumo');


// ============================================================
// CONFIG
// ============================================================

const GRANULARIDAD =
  'semanal';

const VENTANA_SEMANAS =
  8;

const MIN_MUESTRAS_ANOMALIA =
  5;

const UMBRAL_MINIMO_PCT =
  15;

const MULTIPLICADOR_DISPERSION =
  2;

const CAMBIO_MAX_PARQUE_PCT =
  50;


// El precio actual puede variar hasta ±35%
// respecto de la referencia histórica.
//
// Si excede eso,
// usamos precio histórico.
const DESVIO_PRECIO_MAX_PCT =
  35;


const FAMILIAS_NO_ALERTABLES = [
  'bidones',
  'unidades',
];


const FAMILIAS_NORMALIZABLES = [
  'dos_tiempos',
  'tractor',
  'cortadora',
  'vehiculo',
  'fijo',
];


const OBJETIVOS_NO_OPERATIVOS = [
  'deposito',
];


// ============================================================
// NÚMEROS
// ============================================================

function numero(v) {

  const n =
    Number(v);

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
      .filter(
        Number.isFinite
      );


  if (
    !arr.length
  ) {

    return 0;
  }


  return (
    arr.reduce(
      (
        suma,
        valor
      ) =>
        suma +
        valor,
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
        (
          a,
          b
        ) =>
          a - b
      );


  if (
    !arr.length
  ) {

    return 0;
  }


  const mitad =
    Math.floor(
      arr.length /
      2
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
    arr.length <
    2
  ) {

    return 0;
  }


  const media =
    promedio(
      arr
    );


  const varianza =
    arr.reduce(
      (
        suma,
        valor
      ) =>

        suma +
        Math.pow(
          valor - media,
          2
        ),

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
    .normalize(
      'NFD'
    )
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

  const fecha =
    fechaUTC(
      fechaTexto
    );


  fecha.setUTCDate(
    fecha.getUTCDate() +
    cantidad
  );


  return fechaISO(
    fecha
  );
}


function primerDiaPeriodo(
  periodo
) {

  return (
    `${periodo}-01`
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

    return (
      `${anio + 1}-01-01`
    );
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

function inicioSemana(
  fechaTexto
) {

  const fecha =
    fechaUTC(
      fechaTexto
    );


  const dia =
    fecha.getUTCDay();


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


function semanaSiguiente(
  semana
) {

  return sumarDias(
    semana,
    7
  );
}


function semanaAnterior(
  semana,
  cantidad = 1
) {

  return sumarDias(
    semana,
    -7 * cantidad
  );
}


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
    semana <
    finMes
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


function factorSemanaTranscurrida(
  semana
) {

  const hoy =
    hoyCordoba();


  const fin =
    semanaSiguiente(
      semana
    );


  if (
    semana > hoy
  ) {

    return 0;
  }


  if (
    fin <= hoy
  ) {

    return 1;
  }


  const totalHabiles =
    diasHabilesEntre(
      semana,
      fin
    );


  const manana =
    sumarDias(
      hoy,
      1
    );


  const transcurridos =
    diasHabilesEntre(
      semana,
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
// OBJETIVOS
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
        palabra =>

          normalizado ===
            palabra ||

          normalizado.includes(
            `${palabra} `
          ) ||

          normalizado.includes(
            ` ${palabra}`
          )
      )
  );
}


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


  if (
    error
  ) {

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


  if (
    error
  ) {

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
// PRECIOS DE CARGAS
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
      const item of
      items
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
    precio =>
      Number.isFinite(
        precio
      ) &&
      precio > 0
  );
}


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


  const inicial =
    mediana(
      candidatos
    );


  if (
    inicial <= 0
  ) {

    return 0;
  }


  const filtrados =
    candidatos.filter(
      precio =>

        precio >=
          inicial * 0.5 &&

        precio <=
          inicial * 2
    );


  return filtrados.length
    ? mediana(
        filtrados
      )
    : inicial;
}


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

    const precio =
      subtotal /
      litrosItem;


    if (
      precioEsRazonable(
        precio,
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

      return (
        totalCarga *
        (
          litrosItem /
          litrosCombustibleCarga
        )
      );
    }
  }


  if (
    precioReferencia > 0
  ) {

    return (
      litrosItem *
      precioReferencia
    );
  }


  return 0;
}


// ============================================================
// CONSUMO SEMANAL
// ============================================================

async function obtenerConsumoSemana(
  semana
) {

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
        semana
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


  if (
    error
  ) {

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
      ].cargas.add(
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
    // SIN ITEMS
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

        const raw =
          String(
            item.destino_detalle
          ).trim();


        const encontrado =
          mapaObjetivos
            .porNombre[
              normalizarTexto(
                raw
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
            raw;
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


      // TOTAL
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


      // BIDÓN / UNIDAD
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


      // FAMILIA REAL
      const familiaDeclarada =
        String(
          item.familia_consumo ||
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

          importe,

          cargaId:
            carga.id,
        });
      }
    }
  }


  return Object
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


  return consumos.map(
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
  );
}


// ============================================================
// SNAPSHOT
// ============================================================

async function generarSnapshotSemanal(
  semana
) {

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


    let parqueFamilia =
      0;


    if (
      FAMILIAS_NORMALIZABLES
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


    const litrosPorEquipo =
      parqueFamilia > 0

        ? consumo.litros /
          parqueFamilia

        : null;


    const costoPorEquipo =
      parqueFamilia > 0

        ? consumo.importe /
          parqueFamilia

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


  const {
    error:
      deleteError
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
    deleteError
  ) {

    throw deleteError;
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


  return {

    semana,

    snapshots:
      data.length,
  };
}


// ============================================================
// SNAPSHOTS MES
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


  let total =
    0;

  const detalle = [];


  for (
    const semana of
    semanas
  ) {

    if (
      semana > hoy
    ) {

      continue;
    }


    const resultado =
      await generarSnapshotSemanal(
        semana
      );


    detalle.push(
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
      detalle,
  };
}


// ============================================================
// HISTÓRICO
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


  if (
    error
  ) {

    throw error;
  }


  return data || [];
}


// ============================================================
// PRECIO DESDE SNAPSHOT
// ============================================================

function precioSnapshot(
  snapshot
) {

  const litros =
    numero(
      snapshot.litros
    );


  const importe =
    numero(
      snapshot.importe
    );


  if (
    litros <= 0 ||
    importe <= 0
  ) {

    return 0;
  }


  return (
    importe /
    litros
  );
}


// ============================================================
// PRECIO HISTÓRICO ROBUSTO
// ============================================================

function calcularPrecioHistorico(
  historico
) {

  const precios =
    (historico || [])
      .map(
        precioSnapshot
      )
      .filter(
        precio =>
          precio > 0 &&
          Number.isFinite(
            precio
          )
      );


  if (
    !precios.length
  ) {

    return {

      precio:
        0,

      muestras:
        0,
    };
  }


  const inicial =
    mediana(
      precios
    );


  const filtrados =
    precios.filter(
      precio =>

        precio >=
          inicial * 0.5 &&

        precio <=
          inicial * 2
    );


  const serie =
    filtrados.length
      ? filtrados
      : precios;


  return {

    precio:
      mediana(
        serie
      ),

    muestras:
      serie.length,
  };
}


// ============================================================
// SELECCIONAR PRECIO PARA IMPACTO
// ============================================================

function seleccionarPrecioImpacto({
  snapshot,
  historico,
}) {

  const actual =
    precioSnapshot(
      snapshot
    );


  const historicoPrecio =
    calcularPrecioHistorico(
      historico
    );


  const referencia =
    numero(
      historicoPrecio.precio
    );


  // No hay referencia histórica.
  if (
    referencia <= 0
  ) {

    return {

      precio:
        actual,

      origen:
        actual > 0
          ? 'precio_actual'
          : 'sin_precio',

      precio_actual:
        actual,

      precio_historico:
        0,

      desvio_precio_pct:
        null,
    };
  }


  // No hay precio actual.
  if (
    actual <= 0
  ) {

    return {

      precio:
        referencia,

      origen:
        'referencia_historica',

      precio_actual:
        0,

      precio_historico:
        referencia,

      desvio_precio_pct:
        null,
    };
  }


  const desvioPct =
    (
      (
        actual -
        referencia
      ) /
      referencia
    ) *
    100;


  if (
    Math.abs(
      desvioPct
    ) >
    DESVIO_PRECIO_MAX_PCT
  ) {

    return {

      precio:
        referencia,

      origen:
        'referencia_historica',

      precio_actual:
        actual,

      precio_historico:
        referencia,

      desvio_precio_pct:
        desvioPct,
    };
  }


  return {

    precio:
      actual,

    origen:
      'precio_actual',

    precio_actual:
      actual,

    precio_historico:
      referencia,

    desvio_precio_pct:
      desvioPct,
  };
}


// ============================================================
// BASELINE
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
          x > 0
      );


  const consumoBase =
    mediana(
      litros
    );


  const costoBase =
    mediana(
      costos
    );


  const consumoEquipoBase =
    litrosEquipo.length
      ? mediana(
          litrosEquipo
        )
      : null;


  const costoEquipoBase =
    costosEquipo.length
      ? mediana(
          costosEquipo
        )
      : null;


  const parqueBase =
    parque.length
      ? mediana(
          parque
        )
      : 0;


  const seriePrincipal =
    litrosEquipo.length >=
      MIN_MUESTRAS_ANOMALIA

      ? litrosEquipo

      : litros;


  const media =
    promedio(
      seriePrincipal
    );


  const dispersionPct =
    media > 0

      ? desviacionEstandar(
          seriePrincipal
        ) /
        media *
        100

      : 0;


  return {

    muestras:
      filas.length,

    consumo_base:
      consumoBase,

    costo_base:
      costoBase,

    consumo_por_equipo_base:
      consumoEquipoBase,

    costo_por_equipo_base:
      costoEquipoBase,

    parque_base:
      parqueBase,

    dispersion_pct:
      redondear(
        dispersionPct,
        2
      ),
  };
}


// ============================================================
// PARQUE
// ============================================================

function evaluarCalidadParque({
  parqueActual,
  parqueHistorico,
}) {

  const actual =
    numero(
      parqueActual
    );


  const historico =
    numero(
      parqueHistorico
    );


  if (
    actual <= 0 ||
    historico <= 0
  ) {

    return {

      confiable:
        false,

      cambio_pct:
        null,

      motivo:
        'Sin parque suficiente',
    };
  }


  const cambioPct =
    (
      (
        actual -
        historico
      ) /
      historico
    ) *
    100;


  if (
    Math.abs(
      cambioPct
    ) >
    CAMBIO_MAX_PARQUE_PCT
  ) {

    return {

      confiable:
        false,

      cambio_pct:
        redondear(
          cambioPct,
          2
        ),

      motivo:
        'Cambio abrupto de parque',
    };
  }


  return {

    confiable:
      true,

    cambio_pct:
      redondear(
        cambioPct,
        2
      ),

    motivo:
      null,
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
// UMBRAL
// ============================================================

function calcularUmbral(
  dispersionPct
) {

  return Math.max(

    UMBRAL_MINIMO_PCT,

    numero(
      dispersionPct
    ) *
    MULTIPLICADOR_DISPERSION
  );
}


// ============================================================
// BASELINES
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


  if (
    error
  ) {

    throw error;
  }


  const filas = [];


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


    filas.push({

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
    !filas.length
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
      upsertError
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
    upsertError
  ) {

    throw upsertError;
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
// LIMPIAR ALERTAS AUTOMÁTICAS
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


  if (
    error
  ) {

    throw error;
  }
}


// ============================================================
// DETECTAR ANOMALÍAS
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


  if (
    error
  ) {

    throw error;
  }


  await limpiarAnomaliasSemana(
    semana
  );


  const factorTiempo =
    factorSemanaTranscurrida(
      semana
    );


  const anomalias = [];


  for (
    const snapshot of
    snapshots || []
  ) {

    if (
      esObjetivoNoOperativo(
        snapshot.objetivo_nombre
      )
    ) {

      continue;
    }


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


    if (
      confianza.nivel ===
        'baja' ||
      confianza.nivel ===
        'insuficiente'
    ) {

      continue;
    }


    let metrica =
      'litros';


    let real =
      numero(
        snapshot.litros
      );


    let esperadoSemana =
      numero(
        base.consumo_base
      );


    let calidadDato =
      'correcta';


    const esFamiliaReal =
      FAMILIAS_NORMALIZABLES
        .includes(
          snapshot.familia
        );


    if (
      esFamiliaReal
    ) {

      const calidadParque =
        evaluarCalidadParque({

          parqueActual:
            snapshot.parque_familia,

          parqueHistorico:
            base.parque_base,
        });


      if (
        calidadParque.confiable &&
        snapshot
          .litros_por_equipo !=
          null &&
        base
          .consumo_por_equipo_base !=
          null
      ) {

        metrica =
          'litros_por_equipo';


        real =
          numero(
            snapshot
              .litros_por_equipo
          );


        esperadoSemana =
          numero(
            base
              .consumo_por_equipo_base
          );

      } else {

        calidadDato =
          calidadParque.motivo ||
          'Parque no confiable';
      }
    }


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


    if (
      desvioPct <
      umbral
    ) {

      continue;
    }


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
    // V2.2 - PRECIO INTELIGENTE
    // ========================================================

    const precio =
      seleccionarPrecioImpacto({

        snapshot,

        historico,
      });


    const impacto =
      litrosExceso *
      numero(
        precio.precio
      );


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
    }


    if (
      precio.origen ===
      'referencia_historica'
    ) {

      calidadDato =
        calidadDato ===
        'correcta'

          ? 'Precio actual atípico'

          : `${calidadDato}; precio actual atípico`;
    }


    anomalias.push({

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

      precio_utilizado:
        redondear(
          precio.precio,
          2
        ),

      precio_origen:
        precio.origen,

      confianza_nivel:
        confianza.nivel,

      confianza_score:
        confianza.score,

      muestras_historicas:
        base.muestras,

      dispersion_pct:
        redondear(
          base.dispersion_pct,
          2
        ),

      umbral_pct:
        redondear(
          umbral,
          2
        ),

      calidad_dato:
        calidadDato,

      severidad,

      estado:
        'abierta',
    });
  }


  if (
    !anomalias.length
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
      insertError
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

          ignoreDuplicates:
            true,
        }
      )
      .select();


  if (
    insertError
  ) {

    throw insertError;
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
// ANALIZAR SEMANA
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
// EJECUTAR MES
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


  const semanas =
    semanasDelMes(
      periodo
    );


  const hoy =
    hoyCordoba();


  const resultados = [];


  let totalSnapshots =
    0;

  let totalBaselines =
    0;

  let totalAnomalias =
    0;


  for (
    const semana of
    semanas
  ) {

    if (
      semana > hoy
    ) {

      continue;
    }


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


  return {

    ok:
      true,

    version:
      '2.2',

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
}


// ============================================================
// COMPATIBILIDAD API
// ============================================================

async function generarSnapshotMensual(
  periodo =
    periodoActualCba()
) {

  return generarSnapshotsSemanalesMes(
    periodo
  );
}


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


  let total =
    0;

  const detalle = [];


  for (
    const semana of
    semanas
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


  let total =
    0;

  const detalle = [];


  for (
    const semana of
    semanas
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
      const semana of
      semanas
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
};
