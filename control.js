// ── Kill switch por PIN rotativo (dead man's switch) ───────────────────────
// El sistema exige renovar un PIN cada VENTANA_DIAS. La renovación es rotar el
// valor de la env var SYSTEM_PIN en Railway por uno DISTINTO al anterior.
//
// Cómo funciona:
//  - En Supabase, tabla `sistema_control` guarda { pin, renovado_at }.
//  - Al arrancar y en cada request relevante, se compara SYSTEM_PIN (env) contra
//    el pin guardado. Si es DISTINTO → hubo rotación → se guarda el nuevo pin y
//    se resetea renovado_at = ahora (contador vuelve a cero). Rotación real:
//    poner el mismo valor de antes NO cuenta como renovación.
//  - vencimiento = renovado_at + VENTANA_DIAS.
//  - Si hoy >= vencimiento → sistema BLOQUEADO (bot no responde, panel no opera).
//
// La única forma de renovar es cambiar SYSTEM_PIN en Railway. No hay puerta
// trasera desde el panel: es intencional (kill switch).
//
// Tabla esperada (crear una vez en Supabase):
//   create table sistema_control (
//     id int primary key default 1,
//     pin text,
//     renovado_at timestamptz default now(),
//     aviso_enviado_at timestamptz,
//     check (id = 1)
//   );
//   insert into sistema_control (id) values (1) on conflict do nothing;

const supabase = require('./supabase');

const VENTANA_DIAS = Number(process.env.SYSTEM_PIN_DIAS) || 15;
const AVISO_DIAS   = Number(process.env.SYSTEM_PIN_AVISO_DIAS) || 3;  // avisar cuando faltan <= N días
const MS_DIA = 86400000;

// Cache en memoria para no pegarle a la DB en cada request. Se refresca solo.
let cache = null;          // { pin, renovado_at, aviso_enviado_at }
let cacheAt = 0;
const CACHE_MS = 30000;    // 30s

function pinEnv() {
  return String(process.env.SYSTEM_PIN || '').trim();
}

// Lee el estado, aplicando rotación si el env cambió. Devuelve el estado actual.
async function leerEstado(force) {
  const ahora = Date.now();
  if (!force && cache && (ahora - cacheAt) < CACHE_MS) return cache;

  const envPin = pinEnv();

  // Si no hay SYSTEM_PIN configurado, el kill switch está DESACTIVADO (fail-open):
  // así el sistema sigue andando hasta que decidas activarlo poniendo la env var.
  if (!envPin) {
    cache = { desactivado: true };
    cacheAt = ahora;
    return cache;
  }

  let fila;
  try {
    const { data, error } = await supabase
      .from('sistema_control').select('*').eq('id', 1).single();
    if (error) throw error;
    fila = data;
  } catch (e) {
    // Si no podemos leer la tabla (no existe aún, DB caída), fail-open: no
    // bloqueamos por un problema de infraestructura, solo por PIN vencido.
    console.error('[control] no pude leer sistema_control:', e.message || e);
    cache = { desactivado: true, error: true };
    cacheAt = ahora;
    return cache;
  }

  // ¿Rotó el PIN? (env distinto del guardado, o primera vez)
  if (!fila || fila.pin !== envPin) {
    const nuevo = { id: 1, pin: envPin, renovado_at: new Date().toISOString(), aviso_enviado_at: null };
    try {
      await supabase.from('sistema_control').upsert(nuevo, { onConflict: 'id' });
      console.log('[control] PIN rotado — contador reiniciado a', VENTANA_DIAS, 'días');
      fila = nuevo;
    } catch (e) {
      console.error('[control] no pude guardar la rotación:', e.message || e);
      // Igual seguimos con el valor nuevo en memoria
      fila = nuevo;
    }
  }

  cache = fila;
  cacheAt = ahora;
  return cache;
}

// Devuelve un resumen legible del estado (para el panel y los avisos).
async function estado(force) {
  const e = await leerEstado(force);
  if (e.desactivado) {
    return { activo: false, bloqueado: false, dias_restantes: null, vencimiento: null };
  }
  const renov = new Date(e.renovado_at).getTime();
  const venc = renov + VENTANA_DIAS * MS_DIA;
  const diasRest = Math.ceil((venc - Date.now()) / MS_DIA);
  return {
    activo: true,
    bloqueado: Date.now() >= venc,
    dias_restantes: diasRest,
    vencimiento: new Date(venc).toISOString(),
    renovado_at: e.renovado_at,
    en_aviso: diasRest <= AVISO_DIAS,
  };
}

// True si el sistema está operativo (no vencido). El bot y el panel lo usan.
async function estaOperativo() {
  const e = await estado();
  return !e.bloqueado;   // desactivado o vigente => operativo
}

// Marca que ya se mandó el aviso de este ciclo, para no spamear.
async function marcarAvisoEnviado() {
  try {
    await supabase.from('sistema_control')
      .update({ aviso_enviado_at: new Date().toISOString() }).eq('id', 1);
    if (cache) cache.aviso_enviado_at = new Date().toISOString();
  } catch (e) { console.error('[control] no pude marcar aviso:', e.message || e); }
}

// ¿Hace falta avisar ahora? (estamos en ventana de aviso y no se avisó hoy)
async function debeAvisar() {
  const e = await leerEstado();
  if (e.desactivado) return false;
  const st = await estado();
  if (!st.en_aviso || st.bloqueado) return false;
  // No repetir el aviso si ya se mandó en las últimas 24hs
  if (e.aviso_enviado_at && (Date.now() - new Date(e.aviso_enviado_at).getTime()) < MS_DIA) return false;
  return true;
}

module.exports = { estado, estaOperativo, debeAvisar, marcarAvisoEnviado, VENTANA_DIAS, AVISO_DIAS };
