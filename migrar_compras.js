// ══════════════════════════════════════════════════════════════
// MIGRACIÓN · base COMPRAS → base del bot (21-nov-2026)
// Copia de UNA sola vez. Después de pasar las variables y probar, se borra
// este archivo y la línea de index.js.
//
//  Origen : SUPABASE_COMPRAS_URL / SUPABASE_COMPRAS_KEY (proyecto viejo)
//  Destino: SUPABASE_URL / SUPABASE_SERVICE_KEY (base del bot)
//
//  Copia las 4 tablas (con upsert: se puede correr las veces que haga falta,
//  no duplica) y los archivos del bucket 'comprobantes' con la misma ruta,
//  así las facturas siguen apuntando bien.
//  NO borra ni modifica nada en el origen.
//
//  Rutas (todas con ?k=<MIGRAR_KEY>):
//    /api/compras-migracion/revisar   cuenta filas y archivos en las dos bases
//    /api/compras-migracion/iniciar   arranca la copia (corre en segundo plano)
//    /api/compras-migracion/estado    cómo va
// ══════════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const destino = require('./supabase');

const router = express.Router();
const TABLAS = ['proveedores_clase', 'ordenes_compra', 'facturas', 'remitos_combustible'];
const BUCKET = 'comprobantes';
const LOTE = 100;

function origen() {
  return createClient(process.env.SUPABASE_COMPRAS_URL, process.env.SUPABASE_COMPRAS_KEY);
}

function claveOk(req) {
  const k = String(req.query.k || '');
  const esperada = String(process.env.MIGRAR_KEY || '');
  if (!esperada || k.length !== esperada.length) return false;
  return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(esperada));
}

// Si ya se cambiaron las variables, origen y destino son la misma base:
// no hay nada que copiar y correrlo sería confuso.
function mismaBase() {
  const a = (process.env.SUPABASE_COMPRAS_URL || '').replace(/\/+$/, '');
  const b = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  return !a || a === b;
}

async function contar(cli, t) {
  const { count, error } = await cli.from(t).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`${t}: ${error.message}`);
  return count || 0;
}

// Columna para paginar y para el upsert
function claveDe(fila) {
  if ('id' in fila) return 'id';
  if ('cuit' in fila) return 'cuit';
  throw new Error('no encuentro columna id ni cuit');
}

async function copiarTabla(org, t, est) {
  const e = est.tablas[t] = { origen: await contar(org, t), copiadas: 0, destino: null };
  if (!e.origen) { e.destino = await contar(destino, t); return; }
  const { data: muestra, error: e0 } = await org.from(t).select('*').limit(1);
  if (e0) throw new Error(`${t}: ${e0.message}`);
  const clave = claveDe(muestra[0]);
  for (let desde = 0; ; desde += LOTE) {
    const { data, error } = await org.from(t).select('*')
      .order(clave, { ascending: true }).range(desde, desde + LOTE - 1);
    if (error) throw new Error(`${t} (leyendo): ${error.message}`);
    if (!data.length) break;
    const { error: e2 } = await destino.from(t).upsert(data, { onConflict: clave });
    if (e2) throw new Error(`${t} (grabando): ${e2.message}`);
    e.copiadas += data.length;
    if (data.length < LOTE) break;
  }
  e.destino = await contar(destino, t);
}

// Rutas de archivos: las que figuran en las facturas + lo que se pueda listar
async function rutasArchivos(org) {
  const rutas = new Set();
  for (let desde = 0; ; desde += 500) {
    const { data, error } = await org.from('facturas').select('*').range(desde, desde + 499);
    if (error) throw new Error('facturas: ' + error.message);
    for (const r of data) {
      const c = r.comprobante || (r.data && r.data.comprobante);
      if (c && c.ruta) rutas.add(c.ruta);
    }
    if (data.length < 500) break;
  }
  async function listar(pref) {
    for (let off = 0; ; off += 1000) {
      const { data, error } = await org.storage.from(BUCKET).list(pref, { limit: 1000, offset: off });
      if (error || !data) return;
      for (const it of data) {
        if (it.name === '.emptyFolderPlaceholder') continue;
        const ruta = pref ? pref + '/' + it.name : it.name;
        if (it.id === null) await listar(ruta); else rutas.add(ruta);
      }
      if (data.length < 1000) return;
    }
  }
  await listar('').catch(() => {});
  return [...rutas];
}

async function bajar(org, ruta) {
  const { data, error } = await org.storage.from(BUCKET).download(ruta);
  if (!error && data) return { buf: Buffer.from(await data.arrayBuffer()), tipo: data.type };
  const { data: s, error: e2 } = await org.storage.from(BUCKET).createSignedUrl(ruta, 600);
  if (e2) throw new Error(e2.message);
  const r = await fetch(s.signedUrl);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return { buf: Buffer.from(await r.arrayBuffer()), tipo: r.headers.get('content-type') };
}

async function copiarArchivos(org, est) {
  const { error: eb } = await destino.storage.getBucket(BUCKET);
  if (eb) {
    const { error } = await destino.storage.createBucket(BUCKET, { public: false });
    if (error && !/exist/i.test(error.message)) throw new Error('creando bucket: ' + error.message);
  }
  const rutas = await rutasArchivos(org);
  const a = est.archivos = { total: rutas.length, copiados: 0, ya_estaban: 0, errores: [] };
  for (const ruta of rutas) {
    try {
      const { buf, tipo } = await bajar(org, ruta);
      const { error } = await destino.storage.from(BUCKET)
        .upload(ruta, buf, { contentType: tipo || 'application/pdf', upsert: false });
      if (error) {
        if (/exist|duplicate/i.test(error.message)) a.ya_estaban++;
        else throw new Error(error.message);
      } else a.copiados++;
    } catch (err) {
      a.errores.push(ruta + ': ' + (err.message || err));
    }
  }
}

let estado = { fase: 'sin empezar' };
let corriendo = false;

async function correr() {
  corriendo = true;
  estado = { fase: 'tablas', inicio: new Date().toISOString(), tablas: {}, archivos: null };
  try {
    const org = origen();
    for (const t of TABLAS) await copiarTabla(org, t, estado);
    estado.fase = 'archivos';
    await copiarArchivos(org, estado);
    const tablasOk = TABLAS.every(t => estado.tablas[t].destino >= estado.tablas[t].origen);
    estado.fase = tablasOk && !estado.archivos.errores.length ? 'TERMINADO OK' : 'TERMINADO CON DIFERENCIAS';
  } catch (err) {
    estado.fase = 'ERROR';
    estado.error = err.message || String(err);
  } finally {
    estado.fin = new Date().toISOString();
    corriendo = false;
  }
}

router.use('/api/compras-migracion', (req, res, next) => {
  if (!claveOk(req)) return res.status(404).send('Not found');
  if (mismaBase()) return res.json({ aviso: 'SUPABASE_COMPRAS_URL ya apunta a la base del bot: la migración ya está hecha, no hay nada que copiar.' });
  next();
});

router.get('/api/compras-migracion/revisar', async (req, res) => {
  try {
    const org = origen();
    const tablas = {};
    for (const t of TABLAS) {
      tablas[t] = { origen: await contar(org, t) };
      tablas[t].destino = await contar(destino, t).catch(e => 'FALTA LA TABLA (' + e.message + ')');
      tablas[t].igual = tablas[t].origen === tablas[t].destino;
    }
    const rutas = await rutasArchivos(org);
    const { error: eb } = await destino.storage.getBucket(BUCKET);
    res.json({ tablas, archivos_en_origen: rutas.length, bucket_en_destino: !eb });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

router.get('/api/compras-migracion/iniciar', (req, res) => {
  if (!corriendo) correr();
  res.json({ ok: true, mensaje: 'Arrancó. Mirá el avance en /api/compras-migracion/estado?k=…', estado });
});

router.get('/api/compras-migracion/estado', (req, res) => {
  res.json({ corriendo, ...estado });
});

module.exports = router;
