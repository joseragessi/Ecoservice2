// ============================================================
// COST INTELLIGENCE V2.1
// ECOSERVICE
//
// CEREBRO SEMANAL DE INTELIGENCIA DE COSTOS
//
// REGLA PRINCIPAL V2.1:
//
// TOTAL
//   → compara litros semanales contra historia
//   → NO divide por parque
//
// BIDONES
//   → se registra
//   → NO genera alerta por ahora
//
// UNIDADES
//   → se registra
//   → NO genera alerta por ahora
//
// FAMILIAS IDENTIFICADAS:
//   dos_tiempos
//   tractor
//   cortadora
//   vehiculo
//   fijo
//
//   → pueden comparar litros/equipo
//   → solamente si el parque es confiable
//
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


// Semanas utilizadas para construir baseline
const VENTANA_SEMANAS = 8;


// Historial mínimo para una alerta real
const MIN_MUESTRAS_ANOMALIA = 5;


// Umbral mínimo de desviación
const UMBRAL_MINIMO_PCT = 15;


// Multiplicador de dispersión histórica
const MULTIPLICADOR_DISPERSION = 2;


// Cambio máximo tolerado de parque.
//
// Ejemplo:
//
// histórico = 10 máquinas
// actual    = 3 máquinas
//
// cambio = -70%
//
// En ese caso NO confiamos en litros/equipo.
const CAMBIO_MAX_PARQUE_PCT = 50;


// Familias que se guardan pero,
// por ahora, NO generan alertas.
const FAMILIAS_NO_ALERTABLES = [
  'bidones',
  'unidades',
];


// Familias donde sí podemos normalizar
// por cantidad de equipos.
const FAMILIAS_NORMALIZABLES = [
  'dos_tiempos',
  'tractor',
  'cortadora',
  'vehiculo',
  'fijo',
];


// Centros no operativos.
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
      (suma, valor) =>
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
// FECHA CÓRDOBA
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
// FECHAS UTC
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


  if (
    inicio > hoy
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
// PRECIOS
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
    valor =>
      Number.isFinite(
        valor
      ) &&
      valor > 0
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
      precio =>
        precio >=
          medianaInicial * 0.5 &&
        precio <=
          medianaInicial * 2
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
    `[cost-intelligence V2.1] ${semana} precio ref: $${redondear(
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
      // OBJETIVO
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
      // FAMILIA REAL
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
// SNAPSHOT SEMANAL
// ============================================================

async function generarSnapshotSemanal(
  semana
) {

  console.log(
    `[cost-intelligence V2.1] generando ${semana}`
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


    // ========================================================
    // V2.1
    //
    // SOLO familias reales usan parque_familia.
    //
    // total    = 0
    // bidones  = 0
    // unidades = 0
    //
    // Esto evita falsos positivos como COUNTRY CAÑUELAS.
    // ========================================================

    let parqueFamilia = 0;


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

      // Seguimos guardando parque total
      // como contexto.
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
  // BORRAR SNAPSHOT DE ESA SEMANA
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


  let total = 0;

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


  // ==========================================================
  // DISPERSIÓN
  //
  // Solamente usamos litros/equipo
  // cuando realmente hay suficientes datos.
  // ==========================================================

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
// CALIDAD DE PARQUE
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
// BASELINES SEMANA
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


  return {

    semana,

    baselines:
      data
        ? data.length
        : 0,
  };
}


// ============================================================
// LIMPIAR ANOMALÍAS
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

    // ========================================================
    // OBJETIVOS NO OPERATIVOS
    // ========================================================

    if (
      esObjetivoNoOperativo(
        snapshot.objetivo_nombre
      )
    ) {

      continue;
    }


    // ========================================================
    // BIDONES / UNIDADES
    //
    // Se usan para análisis pero
    // todavía no generan alerta.
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


    if (
      confianza.nivel ===
        'baja' ||
      confianza.nivel ===
        'insuficiente'
    ) {

      continue;
    }


    // ========================================================
    // DECIDIR MÉTRICA
    //
    // TOTAL:
    // siempre litros.
    //
    // FAMILIA:
    // litros/equipo solamente
    // si el parque es confiable.
    // ========================================================

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


    let calidadParque = null;


    const esFamiliaReal =
      FAMILIAS_NORMALIZABLES
        .includes(
          snapshot.familia
        );


    if (
      esFamiliaReal
    ) {

      calidadParque =
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
      }
    }


    // ========================================================
    // SEMANA ACTUAL INCOMPLETA
    // ========================================================

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


    // Solo exceso.
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
    // PRECIO
    // ========================================================

    const precioPromedio =
      numero(
        snapshot.litros
      ) > 0 &&
      numero(
        snapshot.importe
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
    }


    // ========================================================
    // GUARDAR ANOMALÍA
    // ========================================================

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
      errorInsert
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
// EJECUTAR MES COMPLETO
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
    `[cost-intelligence V2.1] procesando ${periodo}`
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
    const semana of
    semanas
  ) {

    if (
      semana > hoy
    ) {

      continue;
    }


    console.log(
      `[cost-intelligence V2.1] semana ${semana}`
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
      '2.1',

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
    '[cost-intelligence V2.1] finalizado',
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
// COMPATIBILIDAD CON API
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


  let total = 0;

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


  let total = 0;

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


// ============================================================
// OBTENER CONSUMO
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
};
