// ============================================================
// COST INTELLIGENCE API
// Ecoservice
// V1.3
// ============================================================

const express = require('express');
const crypto = require('crypto');

const supabase = require('./supabase');
const control = require('./control');
const costIntelligence = require('./cost_intelligence');

const router = express.Router();


// ============================================================
// AUTENTICACIÓN
// ============================================================

const SECRET = process.env.PANEL_SECRET;

if (!SECRET) {
  console.warn(
    '[cost-intelligence] PANEL_SECRET no configurado.'
  );
}


function verificar(token) {

  if (!token || !SECRET) {
    return null;
  }

  const partes = token.split('.');

  if (partes.length !== 2) {
    return null;
  }

  const [body, sig] = partes;

  if (!body || !sig) {
    return null;
  }

  const esperado = crypto
    .createHmac('sha256', SECRET)
    .update(body)
    .digest('base64url');

  if (sig !== esperado) {
    return null;
  }

  try {

    const payload = JSON.parse(
      Buffer
        .from(body, 'base64url')
        .toString()
    );

    if (
      payload.exp &&
      Date.now() > payload.exp
    ) {
      return null;
    }

    return payload;

  } catch (error) {

    return null;
  }
}


async function auth(req, res, next) {

  try {

    const h =
      req.headers.authorization || '';

    const token =
      h.startsWith('Bearer ')
        ? h.slice(7)
        : null;

    const payload =
      verificar(token);

    if (!payload) {
      return res
        .status(401)
        .json({
          error: 'No autorizado'
        });
    }

    if (
      !(await control.estaOperativo())
    ) {

      return res
        .status(423)
        .json({
          error:
            'Sistema bloqueado: PIN vencido.',
          bloqueado: true
        });
    }

    req.usuario =
      payload.usuario;

    req.esAdmin =
      payload.admin === true;

    next();

  } catch (error) {

    console.error(
      '[cost-intelligence] auth:',
      error
    );

    return res
      .status(500)
      .json({
        error:
          'Error validando acceso'
      });
  }
}


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


function periodoValido(valor) {

  const periodo =
    String(valor || '');

  return /^\d{4}-\d{2}$/.test(periodo)
    ? periodo
    : costIntelligence.periodoActualCba();
}


function fechaPeriodo(periodo) {

  return `${periodo}-01`;
}


// ============================================================
// OBTENER SEMANAS DE UN MES
// ============================================================

function semanasPeriodo(periodo) {

  if (
    typeof costIntelligence
      .semanasDelMes === 'function'
  ) {

    return costIntelligence
      .semanasDelMes(periodo);
  }

  return [
    `${periodo}-01`
  ];
}


// ============================================================
// HEALTH
// ============================================================

router.get(
  '/health',
  (req, res) => {

    res.json({
      ok: true,
      modulo:
        'Cost Intelligence',
      version:
        '1.3.0',
      timestamp:
        new Date().toISOString()
    });
  }
);


// ============================================================
// EJECUTAR CEREBRO COMPLETO
// ============================================================

router.post(
  '/ejecutar',
  auth,
  async (req, res) => {

    try {

      const periodo =
        periodoValido(
          req.body?.periodo
        );

      const resultado =
        await costIntelligence
          .ejecutarCostIntelligence(
            periodo
          );

      return res.json({
        ok: true,
        ...resultado
      });

    } catch (error) {

      console.error(
        '[cost-intelligence-api] ejecutar:',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'Error ejecutando Cost Intelligence'
        });
    }
  }
);


// ============================================================
// SNAPSHOT
// ============================================================

router.post(
  '/snapshot',
  auth,
  async (req, res) => {

    try {

      const periodo =
        periodoValido(
          req.body?.periodo
        );

      const resultado =
        await costIntelligence
          .generarSnapshotMensual(
            periodo
          );

      return res.json({
        ok: true,
        ...resultado
      });

    } catch (error) {

      console.error(
        '[cost-intelligence-api] snapshot:',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'Error generando snapshot'
        });
    }
  }
);


// ============================================================
// BASELINES
// ============================================================

router.post(
  '/baselines',
  auth,
  async (req, res) => {

    try {

      const periodo =
        periodoValido(
          req.body?.periodo
        );

      const ventanas =
        Number(
          req.body?.ventanas
        ) > 0
          ? Number(
              req.body.ventanas
            )
          : 8;

      const resultado =
        await costIntelligence
          .calcularBaselines(
            periodo,
            ventanas
          );

      return res.json({
        ok: true,
        ...resultado
      });

    } catch (error) {

      console.error(
        '[cost-intelligence-api] baselines:',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'Error calculando baselines'
        });
    }
  }
);


// ============================================================
// DETECTAR ANOMALÍAS
// ============================================================

router.post(
  '/detectar-anomalias',
  auth,
  async (req, res) => {

    try {

      const periodo =
        periodoValido(
          req.body?.periodo
        );

      const resultado =
        await costIntelligence
          .detectarAnomalias(
            periodo
          );

      return res.json({
        ok: true,
        ...resultado
      });

    } catch (error) {

      console.error(
        '[cost-intelligence-api] detectar:',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'Error detectando anomalías'
        });
    }
  }
);


// ============================================================
// RESUMEN DASHBOARD
// ============================================================

router.get(
  '/resumen',
  auth,
  async (req, res) => {

    try {

      const periodo =
        periodoValido(
          req.query?.periodo
        );

      const semanas =
        semanasPeriodo(
          periodo
        );

      const [
        snapshotsResult,
        anomaliesResult
      ] =
        await Promise.all([

          supabase
            .from('cost_snapshots')
            .select('*')
            .eq(
              'granularidad',
              'semanal'
            )
            .in(
              'periodo',
              semanas
            ),

          supabase
            .from('cost_anomalies')
            .select('*')
            .in(
              'periodo',
              semanas
            )
            .order(
              'impacto_estimado',
              {
                ascending: false
              }
            )
        ]);

      if (
        snapshotsResult.error
      ) {
        throw snapshotsResult.error;
      }

      if (
        anomaliesResult.error
      ) {
        throw anomaliesResult.error;
      }

      const snapshots =
        snapshotsResult.data || [];

      const anomalies =
        anomaliesResult.data || [];

      const snapshotsTotales =
        snapshots.filter(
          s =>
            s.familia === 'total'
        );

      const costoControlado =
        snapshotsTotales.reduce(
          (total, item) =>
            total +
            numero(
              item.importe
            ),
          0
        );

      const litrosControlados =
        snapshotsTotales.reduce(
          (total, item) =>
            total +
            numero(
              item.litros
            ),
          0
        );

      const desviosDetectados =
        anomalies.reduce(
          (total, item) =>
            total +
            numero(
              item.impacto_estimado
            ),
          0
        );

      const desviosSinExplicar =
        anomalies
          .filter(
            item =>
              item.estado ===
                'abierta' ||
              item.estado ===
                'en_revision'
          )
          .reduce(
            (total, item) =>
              total +
              numero(
                item.impacto_estimado
              ),
            0
          );

      const ahorroValidado =
        anomalies.reduce(
          (total, item) =>
            total +
            numero(
              item.ahorro_validado
            ),
          0
        );

      const objetivosControlados =
        new Set(
          snapshotsTotales
            .map(
              item =>
                item.objetivo_id
            )
            .filter(Boolean)
        ).size;

      return res.json({

        ok: true,

        periodo,

        granularidad:
          'semanal',

        semanas,

        kpis: {

          costo_controlado:
            Math.round(
              costoControlado
            ),

          litros_controlados:
            redondear(
              litrosControlados,
              2
            ),

          desvios_detectados:
            Math.round(
              desviosDetectados
            ),

          desvios_sin_explicar:
            Math.round(
              desviosSinExplicar
            ),

          ahorro_validado:
            Math.round(
              ahorroValidado
            ),

          objetivos_controlados:
            objetivosControlados,

          alertas:
            anomalies.length
        },

        donde_actuar_hoy:
          anomalies.slice(
            0,
            10
          )
      });

    } catch (error) {

      console.error(
        '[cost-intelligence-api] resumen:',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'Error obteniendo resumen'
        });
    }
  }
);


// ============================================================
// SNAPSHOTS
// ============================================================

router.get(
  '/snapshots',
  auth,
  async (req, res) => {

    try {

      let query =
        supabase
          .from('cost_snapshots')
          .select('*')
          .order(
            'periodo',
            {
              ascending: false
            }
          );

      if (
        req.query.objetivo_id
      ) {

        query =
          query.eq(
            'objetivo_id',
            req.query.objetivo_id
          );
      }

      if (
        req.query.familia
      ) {

        query =
          query.eq(
            'familia',
            req.query.familia
          );
      }

      if (
        req.query.granularidad
      ) {

        query =
          query.eq(
            'granularidad',
            req.query.granularidad
          );
      }

      const {
        data,
        error
      } =
        await query.limit(
          2000
        );

      if (error) {
        throw error;
      }

      return res.json({
        ok: true,
        data:
          data || []
      });

    } catch (error) {

      console.error(
        '[cost-intelligence-api] snapshots:',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'Error obteniendo snapshots'
        });
    }
  }
);


// ============================================================
// GET BASELINES
// ============================================================

router.get(
  '/baselines',
  auth,
  async (req, res) => {

    try {

      let query =
        supabase
          .from('cost_baselines')
          .select('*')
          .order(
            'objetivo_nombre',
            {
              ascending: true
            }
          );

      if (
        req.query.objetivo_id
      ) {

        query =
          query.eq(
            'objetivo_id',
            req.query.objetivo_id
          );
      }

      if (
        req.query.familia
      ) {

        query =
          query.eq(
            'familia',
            req.query.familia
          );
      }

      if (
        req.query.granularidad
      ) {

        query =
          query.eq(
            'granularidad',
            req.query.granularidad
          );
      }

      const {
        data,
        error
      } =
        await query.limit(
          2000
        );

      if (error) {
        throw error;
      }

      return res.json({
        ok: true,
        data:
          data || []
      });

    } catch (error) {

      console.error(
        '[cost-intelligence-api] GET baselines:',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'Error obteniendo baselines'
        });
    }
  }
);


// ============================================================
// ANOMALÍAS
// ============================================================

router.get(
  '/anomalias',
  auth,
  async (req, res) => {

    try {

      let query =
        supabase
          .from('cost_anomalies')
          .select('*')
          .order(
            'impacto_estimado',
            {
              ascending: false
            }
          );

      if (
        req.query.periodo
      ) {

        const periodo =
          periodoValido(
            req.query.periodo
          );

        const semanas =
          semanasPeriodo(
            periodo
          );

        query =
          query.in(
            'periodo',
            semanas
          );
      }

      if (
        req.query.estado
      ) {

        query =
          query.eq(
            'estado',
            req.query.estado
          );
      }

      if (
        req.query.objetivo_id
      ) {

        query =
          query.eq(
            'objetivo_id',
            req.query.objetivo_id
          );
      }

      const {
        data,
        error
      } =
        await query.limit(
          1000
        );

      if (error) {
        throw error;
      }

      return res.json({
        ok: true,
        data:
          data || []
      });

    } catch (error) {

      console.error(
        '[cost-intelligence-api] anomalías:',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'Error obteniendo anomalías'
        });
    }
  }
);


// ============================================================
// REVISAR ANOMALÍA
// ============================================================

router.post(
  '/anomalias/:id/revisar',
  auth,
  async (req, res) => {

    try {

      const id =
        req.params.id;

      const {
        estado,
        causa,
        observacion,
        responsable,
        validada,
        ahorro_validado
      } =
        req.body || {};

      const estadosPermitidos = [
        'abierta',
        'en_revision',
        'justificada',
        'validada',
        'descartada',
        'cerrada'
      ];

      const cambios = {

        revisado_at:
          new Date()
            .toISOString()
      };

      if (
        estado &&
        estadosPermitidos
          .includes(estado)
      ) {

        cambios.estado =
          estado;
      }

      if (
        causa !== undefined
      ) {

        cambios.causa =
          causa || null;
      }

      if (
        observacion !==
        undefined
      ) {

        cambios.observacion =
          observacion || null;
      }

      if (
        responsable !==
        undefined
      ) {

        cambios.responsable =
          responsable || null;
      }

      if (
        validada !== undefined
      ) {

        cambios.validada =
          Boolean(validada);
      }

      if (
        ahorro_validado !==
        undefined
      ) {

        cambios.ahorro_validado =
          Math.max(
            0,
            numero(
              ahorro_validado
            )
          );
      }

      const {
        data,
        error
      } =
        await supabase
          .from('cost_anomalies')
          .update(
            cambios
          )
          .eq(
            'id',
            id
          )
          .select()
          .single();

      if (error) {
        throw error;
      }

      return res.json({
        ok: true,
        anomalia:
          data
      });

    } catch (error) {

      console.error(
        '[cost-intelligence-api] revisar:',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'Error revisando anomalía'
        });
    }
  }
);


// ============================================================
// TEST TEMPORAL - EJECUTAR DESDE NAVEGADOR
// ============================================================

router.get(
  '/test/:periodo',
  async (req, res) => {

    try {

      const periodo =
        String(
          req.params.periodo || ''
        );

      if (
        !/^\d{4}-\d{2}$/.test(
          periodo
        )
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Periodo inválido'
          });
      }

      const resultado =
        await costIntelligence
          .ejecutarCostIntelligence(
            periodo
          );

      return res.json({
        ok: true,
        modo:
          'test',
        ...resultado
      });

    } catch (error) {

      console.error(
        '[cost-intelligence-test] error:',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'Error ejecutando Cost Intelligence'
        });
    }
  }
);


// ============================================================
// TEST TEMPORAL - VER ANOMALÍAS DEL MES
// CORREGIDO PARA SEMANAS
// ============================================================

router.get(
  '/test-anomalias/:periodo',
  async (req, res) => {

    try {

      const periodo =
        String(
          req.params.periodo || ''
        );

      if (
        !/^\d{4}-\d{2}$/.test(
          periodo
        )
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Periodo inválido'
          });
      }

      const semanas =
        semanasPeriodo(
          periodo
        );

      const {
        data,
        error
      } =
        await supabase
          .from('cost_anomalies')
          .select('*')
          .in(
            'periodo',
            semanas
          )
          .order(
            'periodo',
            {
              ascending: true
            }
          )
          .order(
            'impacto_estimado',
            {
              ascending: false
            }
          );

      if (error) {
        throw error;
      }

      return res.json({

        ok: true,

        periodo,

        granularidad:
          'semanal',

        semanas,

        cantidad:
          (data || []).length,

        anomalias:
          data || []
      });

    } catch (error) {

      console.error(
        '[cost-intelligence-test-anomalias]',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'Error leyendo anomalías'
        });
    }
  }
);


// ============================================================
// TEST TEMPORAL - TOP DESVÍOS
// ============================================================

router.get(
  '/test-desvios/:periodo',
  async (req, res) => {

    try {

      const periodo =
        String(
          req.params.periodo || ''
        );

      if (
        !/^\d{4}-\d{2}$/.test(
          periodo
        )
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Periodo inválido'
          });
      }

      const semanas =
        semanasPeriodo(
          periodo
        );

      const {
        data: snapshots,
        error
      } =
        await supabase
          .from('cost_snapshots')
          .select('*')
          .eq(
            'granularidad',
            'semanal'
          )
          .in(
            'periodo',
            semanas
          )
          .order(
            'periodo',
            {
              ascending: true
            }
          );

      if (error) {
        throw error;
      }

      const resultados = [];

      for (
        const snapshot of
        snapshots || []
      ) {

        const nombre =
          String(
            snapshot.objetivo_nombre ||
            ''
          ).toLowerCase();

        if (
          nombre.includes(
            'deposito'
          ) ||
          nombre.includes(
            'depósito'
          )
        ) {
          continue;
        }

        if (
          snapshot.familia ===
            'bidones' ||
          snapshot.familia ===
            'unidades'
        ) {
          continue;
        }

        const historicoDesde =
          costIntelligence
            .inicioSemana(
              new Date(
                new Date(
                  `${snapshot.periodo}T00:00:00Z`
                ).getTime() -
                8 *
                7 *
                24 *
                60 *
                60 *
                1000
              )
                .toISOString()
                .slice(
                  0,
                  10
                )
            );

        const {
          data: historico,
          error:
            historicoError
        } =
          await supabase
            .from('cost_snapshots')
            .select('*')
            .eq(
              'granularidad',
              'semanal'
            )
            .eq(
              'objetivo_id',
              snapshot.objetivo_id
            )
            .eq(
              'familia',
              snapshot.familia
            )
            .gte(
              'periodo',
              historicoDesde
            )
            .lt(
              'periodo',
              snapshot.periodo
            )
            .order(
              'periodo',
              {
                ascending: true
              }
            );

        if (
          historicoError
        ) {
          throw historicoError;
        }

        const filas =
          historico || [];

        if (
          !filas.length
        ) {
          continue;
        }

        const usarPorEquipo =
          snapshot
            .litros_por_equipo != null &&
          numero(
            snapshot.parque_familia
          ) > 0;

        let serie;

        let real;

        let metrica;

        if (
          usarPorEquipo
        ) {

          serie =
            filas
              .map(
                x =>
                  numero(
                    x.litros_por_equipo
                  )
              )
              .filter(
                x =>
                  x > 0
              );

          real =
            numero(
              snapshot.litros_por_equipo
            );

          metrica =
            'litros_por_equipo';

        } else {

          serie =
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

          real =
            numero(
              snapshot.litros
            );

          metrica =
            'litros';
        }

        if (
          !serie.length
        ) {
          continue;
        }

        const ordenada =
          [...serie]
            .sort(
              (a, b) =>
                a - b
            );

        const mitad =
          Math.floor(
            ordenada.length /
            2
          );

        const esperado =
          ordenada.length % 2
            ? ordenada[
                mitad
              ]
            : (
                ordenada[
                  mitad - 1
                ] +
                ordenada[
                  mitad
                ]
              ) / 2;

        if (
          esperado <= 0
        ) {
          continue;
        }

        const desvioPct =
          (
            real -
            esperado
          ) /
          esperado *
          100;

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

        const diferenciaLitros =
          numero(
            snapshot.litros
          ) -
          litrosEsperados;

        const precioPromedio =
          numero(
            snapshot.litros
          ) > 0
            ? numero(
                snapshot.importe
              ) /
              numero(
                snapshot.litros
              )
            : 0;

        resultados.push({

          semana:
            snapshot.periodo,

          objetivo:
            snapshot.objetivo_nombre,

          familia:
            snapshot.familia,

          muestras_historicas:
            serie.length,

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

          desvio_pct:
            redondear(
              desvioPct,
              2
            ),

          litros_reales:
            redondear(
              snapshot.litros,
              2
            ),

          litros_esperados:
            redondear(
              litrosEsperados,
              2
            ),

          diferencia_litros:
            redondear(
              diferenciaLitros,
              2
            ),

          importe_real:
            Math.round(
              numero(
                snapshot.importe
              )
            ),

          precio_promedio:
            redondear(
              precioPromedio,
              2
            ),

          impacto_estimado:
            Math.round(
              Math.max(
                0,
                diferenciaLitros
              ) *
              precioPromedio
            )
        });
      }

      resultados.sort(
        (a, b) =>
          b.desvio_pct -
          a.desvio_pct
      );

      return res.json({

        ok: true,

        periodo,

        granularidad:
          'semanal',

        semanas,

        cantidad:
          resultados.length,

        top_desvios:
          resultados.slice(
            0,
            30
          )
      });

    } catch (error) {

      console.error(
        '[cost-intelligence-test-desvios]',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'Error calculando top desvíos'
        });
    }
  }
);


// ============================================================
// EXPORT
// ============================================================
// ============================================================
// TEST TEMPORAL - HISTÓRICO DE UN OBJETIVO
//
// URL:
// /api/cost-intelligence/test-historico/:objetivoId
//
// Ejemplo:
// /api/cost-intelligence/test-historico/44ec31c7-05c5-4917-bc96-a5586a36f2f7
// ============================================================

router.get(
  '/test-historico/:objetivoId',
  async (req, res) => {

    try {

      const objetivoId =
        String(
          req.params.objetivoId || ''
        );

      if (
        !objetivoId
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'objetivoId requerido'
          });
      }


      const {
        data,
        error
      } =
        await supabase
          .from('cost_snapshots')
          .select(
            'periodo, objetivo_id, objetivo_nombre, familia, litros, importe, parque_familia, litros_por_equipo, cantidad_cargas'
          )
          .eq(
            'granularidad',
            'semanal'
          )
          .eq(
            'objetivo_id',
            objetivoId
          )
          .eq(
            'familia',
            'total'
          )
          .order(
            'periodo',
            {
              ascending: true
            }
          );


      if (error) {
        throw error;
      }


      const filas =
        data || [];


      const litros =
        filas
          .map(
            x =>
              Number(
                x.litros || 0
              )
          )
          .filter(
            x =>
              Number.isFinite(x) &&
              x > 0
          );


      const ordenados =
        [...litros]
          .sort(
            (a, b) =>
              a - b
          );


      let mediana = 0;


      if (
        ordenados.length
      ) {

        const mitad =
          Math.floor(
            ordenados.length /
            2
          );


        mediana =
          ordenados.length % 2

            ? ordenados[
                mitad
              ]

            : (
                ordenados[
                  mitad - 1
                ] +
                ordenados[
                  mitad
                ]
              ) / 2;
      }


      return res.json({

        ok: true,

        objetivo_id:
          objetivoId,

        objetivo_nombre:
          filas[0]
            ? filas[0]
                .objetivo_nombre
            : null,

        familia:
          'total',

        cantidad_semanas:
          filas.length,

        mediana_litros:
          Math.round(
            mediana *
            100
          ) / 100,

        historico:
          filas.map(
            fila => ({

              semana:
                fila.periodo,

              litros:
                Number(
                  fila.litros || 0
                ),

              importe:
                Number(
                  fila.importe || 0
                ),

              cantidad_cargas:
                Number(
                  fila.cantidad_cargas || 0
                )

            })
          )

      });


    } catch (error) {

      console.error(
        '[cost-intelligence-test-historico]',
        error
      );


      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'Error leyendo histórico'
        });
    }
  }
);
module.exports = router;
