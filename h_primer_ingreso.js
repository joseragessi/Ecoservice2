// Harness del primer ingreso (app_api.js) y del menú del bot (conversacion.js).
//
// Decisión 10-sep: el capataz recibe por WhatsApp el link y su USUARIO, sin
// contraseña — una clave mandada por WhatsApp queda escrita en el chat para
// siempre. La crea él la primera vez que entra.
//
// Lo crítico: /crear-clave NO puede servir para pisar la clave de alguien
// que ya entró. Si eso falla, cualquiera que sepa un usuario entra al sistema.

process.env.SUPABASE_URL='https://x.supabase.co';process.env.SUPABASE_SERVICE_KEY='x';
process.env.SUPABASE_COMPRAS_URL='https://y.supabase.co';process.env.SUPABASE_COMPRAS_KEY='x';
process.env.TWILIO_ACCOUNT_SID='AC'+'0'.repeat(32);process.env.TWILIO_AUTH_TOKEN='0'.repeat(32);

let MECANICOS=[], CAPATACES=[], updates=[];
function cliente(){return {from:t=>{const q={_t:t,_u:null,
  select(){return q;}, eq(){return q;}, ilike(c,v){q._u=String(v).toLowerCase();return q;},
  async maybeSingle(){const arr=t==='mecanicos'?MECANICOS:t==='capataces'?CAPATACES:[];
    return {data:arr.find(x=>String(x.usuario||'').toLowerCase()===q._u)||null,error:null};},
  async single(){return q.maybeSingle();},
  update(p){updates.push({tabla:t,patch:p});return {eq:async()=>({error:null})};},
  then(res,rej){return Promise.resolve({data:[],error:null}).then(res,rej);}};return q;}};}
require.cache[require.resolve('./supabase.js')]={id:'sb',filename:'sb',loaded:true,exports:cliente()};
require.cache[require.resolve('./supabase_compras.js')]={id:'sbc',filename:'sbc',loaded:true,exports:cliente()};
require.cache[require.resolve('./notificar.js')]={id:'n',filename:'n',loaded:true,exports:{
  notificarCapataz:async()=>false,notificarCapatazTemplate:async()=>false,notificarConFallback:async()=>({ok:false}),
  mensajeEstadoIncidencia:()=>'',mensajeCierreSinReparar:()=>''}};

const mod=require('./app_api.js');
const router=mod.router, hashClave=mod.hashClave;
function h(path,method){const c=router.stack.find(l=>l.route&&l.route.path===path&&l.route.methods[method]);
  if(!c){console.error('✗ no encontré '+path);process.exit(1);}return c.route.stack[c.route.stack.length-1].handle;}
const primer=h('/api/app/primer-ingreso','post'), crear=h('/api/app/crear-clave','post'), login=h('/api/app/login','post');

async function call(handler,body){updates=[];let out={code:200,json:null};
  const res={status(c){out.code=c;return res;},json(j){out.json=j;return res;}};
  await handler({body:body||{},ip:'1.2.3.4',headers:{},connection:{remoteAddress:'1.2.3.4'}},res);return out;}

let ok=0,mal=0;const eq=(n,c,d)=>{if(c){ok++;console.log('✓ '+n);}else{mal++;console.log('✗ '+n+(d?' — '+d:''));}};

(async()=>{
  console.log('— Capataz nuevo, sin clave —');
  CAPATACES=[{id:'c1',nombre:'Eduardo Islas',usuario:'eislas',clave_hash:null,activo:true}];
  MECANICOS=[];
  let r=await call(primer,{usuario:'eislas'});
  eq('dice que tiene que crear la clave', r.json.existe===true && r.json.crear===true, JSON.stringify(r.json));
  eq('devuelve el nombre para saludarlo', r.json.nombre==='Eduardo Islas');
  r=await call(primer,{usuario:'EISLAS'});
  eq('el usuario no distingue mayúsculas', r.json.crear===true);

  r=await call(crear,{usuario:'eislas',clave:'chacras25'});
  eq('crea la clave', r.code===200 && r.json.ok, JSON.stringify(r.json));
  eq('la guarda hasheada, no en texto plano',
    updates.length===1 && updates[0].patch.clave_hash && !/chacras25/.test(JSON.stringify(updates[0].patch)), JSON.stringify(updates));

  console.log('\n— LO CRÍTICO: no se puede pisar una clave existente —');
  CAPATACES=[{id:'c1',nombre:'Eduardo Islas',usuario:'eislas',clave_hash:hashClave('chacras25'),activo:true}];
  r=await call(primer,{usuario:'eislas'});
  eq('ya no pide crear', r.json.existe===true && r.json.crear===false);
  r=await call(crear,{usuario:'eislas',clave:'otraclave'});
  eq('crear-clave se rechaza con 409', r.code===409, `dio ${r.code}`);
  eq('y NO toca la base', updates.length===0, JSON.stringify(updates));
  eq('el mensaje manda a pedirla a Logística', /Log[íi]stica/i.test((r.json||{}).error||''));

  console.log('\n— Usuario que no existe —');
  r=await call(primer,{usuario:'noexiste'});
  eq('no dice si existe o no (sirve para adivinar usuarios)', r.json.existe===false && r.json.crear===false);
  eq('tampoco devuelve nombre', !r.json.nombre);
  r=await call(crear,{usuario:'noexiste',clave:'1234'});
  eq('crear-clave da 404', r.code===404);

  console.log('\n— Inactivo —');
  CAPATACES=[{id:'c2',nombre:'Ex Capataz',usuario:'exc',clave_hash:null,activo:false}];
  r=await call(primer,{usuario:'exc'});
  eq('un capataz dado de baja no puede crear clave', r.json.crear===false);
  r=await call(crear,{usuario:'exc',clave:'1234'});
  eq('y crear-clave lo rechaza', r.code===404, `dio ${r.code}`);

  console.log('\n— Validaciones —');
  CAPATACES=[{id:'c1',nombre:'E',usuario:'eislas',clave_hash:null,activo:true}];
  r=await call(crear,{usuario:'eislas',clave:'123'});
  eq('clave de 3 caracteres se rechaza', r.code===400);
  r=await call(crear,{usuario:'',clave:'1234'});
  eq('sin usuario, 400', r.code===400);
  r=await call(primer,{usuario:''});
  eq('primer-ingreso sin usuario, 400', r.code===400);

  console.log('\n— También sirve para mecánicos —');
  MECANICOS=[{id:'m1',nombre:'Leo Godoy',usuario:'lgodoy',clave_hash:null,activo:true}];
  CAPATACES=[];
  r=await call(primer,{usuario:'lgodoy'});
  eq('un mecánico sin clave también la crea', r.json.crear===true);
  r=await call(crear,{usuario:'lgodoy',clave:'taller2026'});
  eq('y se guarda en mecanicos', r.code===200 && updates[0].tabla==='mecanicos', JSON.stringify(updates));

  console.log('\n— El bot quedó como estaba (10-sep: se revirtió el cambio) —');
  const conv=require('fs').readFileSync(__dirname+'/conversacion.js','utf8');
  eq('el menú sigue ofreciendo cargar combustible por WhatsApp', /Cargar combustible/.test(conv));
  eq('y sigue ofreciendo informar stock', /Informar stock de maquinaria/.test(conv));
  eq('el primer ingreso NO depende del bot: funciona con el link solo', typeof crear==='function');

  console.log(`\n${ok} ok · ${mal} mal`);process.exit(mal?1:0);
})().catch(e=>{console.error('✗ explotó:',e);process.exit(1);});
