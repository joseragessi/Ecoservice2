// ============================================================
// COST INTELLIGENCE API
// Ecoservice
// V1.2
// ============================================================

const express = require('express');
const crypto = require('crypto');

const supabase = require('./supabase');
const control = require('./control');
const costIntelligence = require('./cost_intelligence');

const router = express.Router();


// ============================================================
// AUTENTICACIÓN
// Usa el mismo PANEL_SECRET que panel_api.js
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


function redondear(v, decimales = 2) {

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
// HEALTH
// ============================================================

router.get(
  '/health',
  (req, res) => {

    res.json({
      ok: true,
      modulo: 'Cost Intelligence',
      version: '1.2.0',
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
          : 6;

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

      const fecha =
        fechaPeriodo(periodo);

      const [
        snapshotsResult,
        anomaliesResult
      ] =
        await Promise.all([

          supabase
            .from('cost_snapshots')
            .select('*')
            .eq(
              'periodo',
              fecha
            ),

          supabase
            .from('cost_anomalies')
            .select('*')
            .eq(
              'periodo',
              fecha
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
        data: data || []
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
        data: data || []
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

        query =
          query.eq(
            'periodo',
            `${req.query.periodo}-01`
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
        data: data || []
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
        modo: 'test',
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
// TEST TEMPORAL - VER ANOMALÍAS
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

      const fecha =
        `${periodo}-01`;

      const {
        data,
        error
      } =
        await supabase
          .from('cost_anomalies')
          .select('*')
          .eq(
            'periodo',
            fecha
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
        cantidad:
          (data || []).length,
        anomalias:
          data || []
      });

    } catch (error) {

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
// NUEVO TEST TEMPORAL - TOP DESVÍOS
//
// No exige que superen 15%.
// Sirve para validar el cerebro.
//
// URL:
// /api/cost-intelligence/test-desvios/2026-09
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

      const fecha =
        `${periodo}-01`;

      const [
        snapshotsRes,
        baselinesRes
      ] =
        await Promise.all([

          supabase
            .from('cost_snapshots')
            .select('*')
            .eq(
              'periodo',
              fecha
            ),

          supabase
            .from('cost_baselines')
            .select('*')
            .eq(
              'granularidad',
              'mensual'
            )
        ]);

      if (
        snapshotsRes.error
      ) {
        throw snapshotsRes.error;
      }

      if (
        baselinesRes.error
      ) {
        throw baselinesRes.error;
      }

      const snapshots =
        snapshotsRes.data || [];

      const baselines =
        baselinesRes.data || [];

      const mapaBaselines = {};

      for (
        const b of baselines
      ) {

        mapaBaselines[
          `${b.objetivo_id}::${b.familia}`
        ] = b;
      }

      const filas = [];

      for (
        const s of snapshots
      ) {

        const nombre =
          String(
            s.objetivo_nombre ||
            ''
          ).toLowerCase();

        // Depósito no participa
        // de comparación operativa.
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

        const baseline =
          mapaBaselines[
            `${s.objetivo_id}::${s.familia}`
          ];

        if (!baseline) {
          continue;
        }

        if (
          numero(
            baseline.muestras
          ) < 1
        ) {
          continue;
        }

        let metrica;
        let real;
        let esperado;

        if (
          s.litros_por_equipo != null &&
          baseline.consumo_por_equipo_base != null &&
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

          esperado =
            numero(
              baseline
                .consumo_por_equipo_base
            );

        } else {

          metrica =
            'litros';

          real =
            numero(
              s.litros
            );

          esperado =
            numero(
              baseline
                .consumo_base
            );
        }

        if (
          esperado <= 0
        ) {
          continue;
        }

        const diferencia =
          real -
          esperado;

        const desvioPct =
          diferencia /
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
              s.parque_familia
            );

        } else {

          litrosEsperados =
            esperado;
        }

        const litrosDiferencia =
          numero(
            s.litros
          ) -
          litrosEsperados;

        const precioPromedio =
          numero(
            s.litros
          ) > 0
            ? numero(
                s.importe
              ) /
              numero(
                s.litros
              )
            : 0;

        const impactoEstimado =
          litrosDiferencia *
          precioPromedio;

        filas.push({

          objetivo:
            s.objetivo_nombre,

          objetivo_id:
            s.objetivo_id,

          familia:
            s.familia,

          muestras_historicas:
            numero(
              baseline.muestras
            ),

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
              s.litros,
              2
            ),

          litros_esperados:
            redondear(
              litrosEsperados,
              2
            ),

          diferencia_litros:
            redondear(
              litrosDiferencia,
              2
            ),

          importe_real:
            Math.round(
              numero(
                s.importe
              )
            ),

          precio_promedio:
            redondear(
              precioPromedio,
              2
            ),

          impacto_estimado:
            Math.round(
              impactoEstimado
            ),

          parque:
            numero(
              s.parque_familia
            )
        });
      }

      filas.sort(
        (a, b) =>
          b.desvio_pct -
          a.desvio_pct
      );

      return res.json({

        ok: true,

        periodo,

        cantidad:
          filas.length,

        top_desvios:
          filas.slice(
            0,
            20
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

module.exports = router;
