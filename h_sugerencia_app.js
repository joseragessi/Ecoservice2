// Harness de la sugerencia de usar la app (combustible.js y conversacion.js).
//
// Decisión 10-sep: el bot SUGIERE la app al cargar combustible, pero no
// obliga — el flujo por WhatsApp sigue funcionando igual. El mensaje completo
// sale una vez por semana; el resto de las veces, una línea.
//
// Lo que se verifica: que sugiera cuando toca, que NO moleste el resto de las
// veces, que nunca frene la carga, y que no mande un link a quien no tiene
// usuario (iría a una pantalla donde falla sin entender por qué).

process.env.SUPABASE_URL='https://x.supabase.co';process.env.SUPABASE_SERVICE_KEY='x';
process.env.TWILIO_ACCOUNT_SID='AC'+'0'.repeat(32);process.env.TWILIO_AUTH_TOKEN='0'.repeat(32);
process.env.APP_URL='https://ecoservice-production.up.railway.app/app';

let CAP=null, updates=[], fallarUpdate=false;
function cliente(){return {from:t=>{const q={
  select(){return q;}, eq(){return q;},
  async maybeSingle(){return {data:CAP,error:null};},
  async single(){return {data:CAP,error:null};},
  update(p){updates.push(p);return {eq:async()=>{ if(fallarUpdate) throw new Error('columna inexistente'); return {error:null};}};},
  then(r){return Promise.resolve({data:[],error:null}).then(r);}};return q;}};}
require.cache[require.resolve('./supabase.js')]={id:'sb',filename:'sb',loaded:true,exports:cliente()};
require.cache[require.resolve('./notificar.js')]={id:'n',filename:'n',loaded:true,exports:{
  notificarCapataz:async()=>false,notificarCapatazTemplate:async()=>false,notificarConFallback:async()=>({ok:false}),
  mensajeEstadoIncidencia:()=>'',mensajeCierreSinReparar:()=>''}};

// Se extrae sugerirApp del archivo REAL (no está exportada).
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/combustible.js','utf8');
const ini=src.indexOf('async function sugerirApp');
const fin=src.indexOf('\n}\n', src.indexOf('console.error(\'[app] sugerencia combustible', ini))+3;
const supabase=require('./supabase.js');
const sugerirApp=new Function('supabase','process', src.slice(ini,fin)+'\nreturn sugerirApp;')(supabase,process);

let ok=0,mal=0;const eq=(n,c,d)=>{if(c){ok++;console.log('✓ '+n);}else{mal++;console.log('✗ '+n+(d?' — '+d:''));}};
const hace=(d)=>new Date(Date.now()-d*86400000).toISOString();

(async()=>{
  console.log('— Primera vez: mensaje completo —');
  CAP={id:'c1',usuario:'eislas',app_sugerida_at:null};updates=[];
  let m=await sugerirApp({id:'c1',usuario:'eislas',app_sugerida_at:null});
  eq('sugiere', m.length>0);
  eq('trae el link', /ecoservice-production\.up\.railway\.app\/app/.test(m), m.slice(0,150));
  eq('el link va sin https:// (WhatsApp lo linkea igual y se lee mejor)', !/https:\/\//.test(m));
  eq('trae el usuario', /eislas/.test(m));
  eq('explica el beneficio (a qué máquina fue cada litro)', /a qu[ée] m[áa]quina/i.test(m));
  eq('aclara que puede seguir por WhatsApp', /segu[ií].*por ac[áa]/i.test(m), m.slice(-120));
  eq('avisa que la contraseña la crea él', /cre[áa]s tu contrase/i.test(m));
  eq('marca la fecha para no repetir', updates.length===1 && updates[0].app_sugerida_at);

  console.log('\n— Insiste hasta que entre a la app (decisión 11-sep) —');
  updates=[];
  m=await sugerirApp({id:'c1',usuario:'eislas',app_sugerida_at:hace(0),clave_hash:null});
  eq('aunque se la sugerimos hoy, vuelve a salir COMPLETA', /¿Sab[íi]as/.test(m), m.slice(0,80));
  m=await sugerirApp({id:'c1',usuario:'eislas',app_sugerida_at:hace(2),clave_hash:null});
  eq('a los 2 días también', /¿Sab[íi]as/.test(m));
  eq('con el link y el usuario siempre', /railway\.app\/app/.test(m) && /eislas/.test(m));

  console.log('\n— Deja de insistir cuando ya entró —');
  updates=[];
  m=await sugerirApp({id:'c1',usuario:'eislas',app_sugerida_at:hace(1),clave_hash:'abc123:def'});
  eq('con clave creada, no sugiere nada', m==='', m);
  eq('y no toca la base', updates.length===0);

  console.log('\n— Sin usuario cargado en Maestros —');
  updates=[];CAP={usuario:null,clave_hash:null};
  m=await sugerirApp({id:'c2',usuario:null,clave_hash:null});
  eq('NO manda el link (iría a una pantalla donde falla)', !/railway\.app\/app/.test(m), m);
  eq('lo manda a Logística', /Log[íi]stica/i.test(m));
  eq('y le dice que siga por WhatsApp', /segu[ií].*por ac[áa]/i.test(m));

  console.log('\n— Nunca frena la carga —');
  CAP=null;
  m=await sugerirApp({id:'c3'});
  eq('si no puede leer el capataz, devuelve vacío en vez de romper', typeof m==='string');
  m=await sugerirApp(null);
  eq('capataz null no rompe', m==='');
  m=await sugerirApp({});
  eq('capataz sin id no rompe', m==='');
  CAP={id:'c1',usuario:'eislas',app_sugerida_at:null};
  fallarUpdate=true;
  m=await sugerirApp({id:'c1',usuario:'eislas',app_sugerida_at:null});
  eq('si la columna app_sugerida_at no existe, sugiere igual', m.length>0, m.slice(0,80));
  fallarUpdate=false;

  console.log('\n— Los datos se traen si no vienen en la sesión —');
  CAP={usuario:'dvega',clave_hash:null};updates=[];
  m=await sugerirApp({id:'c9'});
  eq('busca usuario y fecha en la base', /dvega/.test(m), m.slice(0,200));

  console.log('\n— El menú NO cae en el flujo de stock (bug del 11-sep) —');
  const idx=fs.readFileSync(__dirname+'/index.js','utf8');
  const sinEsp=idx.replace(/\s+/g,' ');
  eq('las opciones 1-6 pasan de largo el pedido pendiente',
    /!\/\^\[1-6\]\$\/\.test\( ?mensaje\.trim\(\) ?\) && await tienePedidoPendiente/.test(sinEsp),
    sinEsp.slice(sinEsp.indexOf('tienePedidoPendiente')-160, sinEsp.indexOf('tienePedidoPendiente')+40));

  console.log('\n— El menú sigue igual: es sugerencia, no bloqueo —');
  const conv=fs.readFileSync(__dirname+'/conversacion.js','utf8');
  eq('la opción 1 sigue siendo cargar combustible', /1\. ⛽ Cargar combustible/.test(conv));
  eq('la opción 4 sigue siendo informar stock', /4\. 📋 Informar stock/.test(conv));
  eq('al elegir 1 pide la foto como siempre', /Sacale una \*foto\* al remito/.test(conv));
  eq('y suma la sugerencia', /sugerenciaApp\(cap\)/.test(conv));
  const comb=fs.readFileSync(__dirname+'/combustible.js','utf8');
  eq('la sugerencia va DESPUÉS de registrar la carga', /resumenFinal\(sesion, nombre\) \+ await sugerirApp/.test(comb));
  eq('en los tres cierres del flujo', (comb.match(/await sugerirApp\(sesion\.capataz\)/g)||[]).length===3);

  console.log(`\n${ok} ok · ${mal} mal`);process.exit(mal?1:0);
})().catch(e=>{console.error('✗ explotó:',e);process.exit(1);});
