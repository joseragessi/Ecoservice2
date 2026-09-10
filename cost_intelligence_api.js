// ============================================================
// COST INTELLIGENCE API
// Ecoservice
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
    '[cost-intelligence] PANEL_SECRET no configurado. ' +
    'Cost Intelligence requiere PANEL_SECRET para autenticar el panel.'
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


    // Kill switch de Ecoservice
    if (
      !(await control.estaOperativo())
    ) {

      return res
        .status(423)
        .json({

          error:
            'Sistema bloqueado: PIN vencido. Renová SYSTEM_PIN en Railway.',

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
// HEALTH
// No necesita autenticación.
// Sirve para comprobar que el módulo cargó.
// ============================================================

router.get(
  '/health',
  (req, res) => {

    res.json({

      ok: true,

      modulo:
        'Cost Intelligence',

      version:
        '1.0.0',

      timestamp:
        new Date().toISOString()

    });
  }
);


// ============================================================
// EJECUTAR CEREBRO COMPLETO
//
// POST
// /api/cost-intelligence/ejecutar
//
// body:
// {
//   "periodo": "2026-09"
// }
//
// Ejecuta:
//
// snapshot
// baseline
// anomalías
//
// ============================================================

router.post(
  '/ejecutar',
  auth,
  async (req, res) => {

    try {

      const periodoRecibido =
        String(
          req.body?.periodo || ''
        );


      const periodo =
        /^\d{4}-\d{2}$/.test(
          periodoRecibido
        )
          ? periodoRecibido
          : costIntelligence
              .periodoActualCba();


      console.log(
        `[cost-intelligence-api] ejecutando ${periodo}`
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
// GENERAR SNAPSHOT
//
// POST
// /api/cost-intelligence/snapshot
// ============================================================

router.post(
  '/snapshot',
  auth,
  async (req, res) => {

    try {

      const recibido =
        String(
          req.body?.periodo || ''
        );


      const periodo =
        /^\d{4}-\d{2}$/.test(
          recibido
        )
          ? recibido
          : costIntelligence
              .periodoActualCba();


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
// CALCULAR BASELINES
//
// POST
// /api/cost-intelligence/baselines
// ============================================================

router.post(
  '/baselines',
  auth,
  async (req, res) => {

    try {

      const recibido =
        String(
          req.body?.periodo || ''
        );


      const periodo =
        /^\d{4}-\d{2}$/.test(
          recibido
        )
          ? recibido
          : costIntelligence
              .periodoActualCba();


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
//
// POST
// /api/cost-intelligence/detectar-anomalias
// ============================================================

router.post(
  '/detectar-anomalias',
  auth,
  async (req, res) => {

    try {

      const recibido =
        String(
          req.body?.periodo || ''
        );


      const periodo =
        /^\d{4}-\d{2}$/.test(
          recibido
        )
          ? recibido
          : costIntelligence
              .periodoActualCba();


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
// RESUMEN PARA DASHBOARD
//
// GET
// /api/cost-intelligence/resumen?periodo=2026-09
// ============================================================

router.get(
  '/resumen',
  auth,
  async (req, res) => {

    try {

      const recibido =
        String(
          req.query?.periodo || ''
        );


      const periodo =
        /^\d{4}-\d{2}$/.test(
          recibido
        )
          ? recibido
          : costIntelligence
              .periodoActualCba();


      const fecha =
        `${periodo}-01`;


      const [
        snapshotsResult,
        anomaliesResult
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
              'cost_anomalies'
            )
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


      // Solo familia total para
      // evitar duplicar costos.
      const snapshotsTotales =
        snapshots.filter(
          s =>
            s.familia === 'total'
        );


      const costoControlado =
        snapshotsTotales.reduce(
          (total, item) =>
            total +
            Number(
              item.importe || 0
            ),
          0
        );


      const litrosControlados =
        snapshotsTotales.reduce(
          (total, item) =>
            total +
            Number(
              item.litros || 0
            ),
          0
        );


      const desviosDetectados =
        anomalies.reduce(
          (total, item) =>
            total +
            Number(
              item.impacto_estimado ||
              0
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
              Number(
                item.impacto_estimado ||
                0
              ),
            0
          );


      const ahorroValidado =
        anomalies.reduce(
          (total, item) =>
            total +
            Number(
              item.ahorro_validado ||
              0
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


      const criticas =
        anomalies.filter(
          x =>
            x.severidad ===
            'critica'
        ).length;


      const altas =
        anomalies.filter(
          x =>
            x.severidad ===
            'alta'
        ).length;


      const medias =
        anomalies.filter(
          x =>
            x.severidad ===
            'media'
        ).length;


      return res.json({

        ok: true,

        periodo,

        kpis: {

          costo_controlado:
            Math.round(
              costoControlado
            ),

          litros_controlados:
            Math.round(
              litrosControlados *
              100
            ) / 100,

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
            anomalies.length,

          alertas_criticas:
            criticas,

          alertas_altas:
            altas,

          alertas_medias:
            medias

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
// HISTÓRICO DE SNAPSHOTS
//
// GET
// /api/cost-intelligence/snapshots
// ============================================================

router.get(
  '/snapshots',
  auth,
  async (req, res) => {

    try {

      let query =
        supabase
          .from(
            'cost_snapshots'
          )
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
// BASELINES
//
// GET
// /api/cost-intelligence/baselines
// ============================================================

router.get(
  '/baselines',
  auth,
  async (req, res) => {

    try {

      let query =
        supabase
          .from(
            'cost_baselines'
          )
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
// LISTADO DE ANOMALÍAS
//
// GET
// /api/cost-intelligence/anomalias
//
// Parámetros opcionales:
//
// ?periodo=2026-09
// ?estado=abierta
// ?objetivo_id=...
// ============================================================

router.get(
  '/anomalias',
  auth,
  async (req, res) => {

    try {

      let query =
        supabase
          .from(
            'cost_anomalies'
          )
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
//
// POST
// /api/cost-intelligence/anomalias/:id/revisar
//
// Ejemplo:
//
// {
//   "estado": "justificada",
//   "causa": "Mayor actividad",
//   "observacion": "Poda extraordinaria",
//   "responsable": "José",
//   "validada": false,
//   "ahorro_validado": 0
// }
//
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
            Number(
              ahorro_validado
            ) || 0
          );
      }


      const {
        data,
        error
      } =
        await supabase
          .from(
            'cost_anomalies'
          )
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
// EXPORT
// ============================================================
// ============================================================
// TEST TEMPORAL DESDE NAVEGADOR
//
// Ejemplo:
// /api/cost-intelligence/test/2026-09
//
// IMPORTANTE:
// Esta ruta es solo para pruebas iniciales.
// Después la eliminamos.
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
        !/^\d{4}-\d{2}$/.test(periodo)
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Periodo inválido. Usá formato YYYY-MM'
          });
      }


      console.log(
        `[cost-intelligence-test] ejecutando ${periodo}`
      );


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
// TEST TEMPORAL - VER ANOMALÍAS DESDE NAVEGADOR
//
// Ejemplo:
// /api/cost-intelligence/test-anomalias/2026-09
//
// SOLO PARA PRUEBAS.
// Después la eliminamos.
// ============================================================

router.get(
  '/test-anomalias/:periodo',
  async (req, res) => {
    try {

      const periodo =
        String(req.params.periodo || '');

      if (!/^\d{4}-\d{2}$/.test(periodo)) {
        return res.status(400).json({
          ok: false,
          error: 'Periodo inválido. Usá formato YYYY-MM'
        });
      }

      const fecha = `${periodo}-01`;

      const { data, error } =
        await supabase
          .from('cost_anomalies')
          .select('*')
          .eq('periodo', fecha)
          .order(
            'impacto_estimado',
            { ascending: false }
          );

      if (error) {
        throw error;
      }

      return res.json({
        ok: true,
        periodo,
        cantidad: (data || []).length,
        anomalias: data || []
      });

    } catch (error) {

      console.error(
        '[cost-intelligence-test-anomalias] error:',
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          'Error leyendo anomalías'
      });
    }
  }
);
module.exports = router;
