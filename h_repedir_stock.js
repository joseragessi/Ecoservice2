// Harness de "volver a pedir el stock" (panel_api.js · pedirStockObjetivos).
//
// Cubre el caso del 04-sep: un objetivo que ya respondió no recibía un nuevo
// pedido, así que un censo mal cargado (el carro de UCC) no se podía rehacer
// sin borrar la respuesta. Con `forzar` se vuelve a pedir sin borrar nada.

process.env.SUPABASE_URL='https://x.supabase.co';process.env.SUPABASE_SERVICE_KEY='x';
process.env.SUPABASE_COMPRAS_URL='https://y.supabase.co';process.env.SUPABASE_COMPRAS_KEY='x';
process.env.PANEL_SECRET='test';
process.env.TWILIO_ACCOUNT_SID='AC'+'0'.repeat(32);process.env.TWILIO_AUTH_TOKEN='0'.repeat(32);

const OBJ=[{id:'o1',nombre:'Logistica',grupo_stock:'deposito',tipo:'operativo'}];
const CAPS=[{id:'c1',nombre:'Jose',telefono:'5493512665495',objetivo_id:'o1'}];
let CENSOS=[];let updates=[];let inserts=[];
function cliente(){return {from:t=>{const q={_t:t,
  select(){return q;},eq(){return q;},in(){return q;},neq(){return q;},order(){return q;},limit(){return q;},
  update(p){updates.push({tabla:t,patch:p});return {eq:async()=>({error:null})};},
  insert(p){inserts.push({tabla:t,fila:p});return {select:()=>({single:async()=>({data:{id:'nuevo'},error:null})}),then(r){return Promise.resolve({error:null}).then(r);}};},
  then(res,rej){const data=t==='objetivos'?OBJ:t==='capataces'?CAPS:t==='censos_stock'?CENSOS:[];
    return Promise.resolve({data,error:null}).then(res,rej);},
  async single(){return {data:null,error:null};},async maybeSingle(){return {data:null,error:null};}};return q;}};}
require.cache[require.resolve('./supabase.js')]={id:'sb',filename:'sb',loaded:true,exports:cliente()};
require.cache[require.resolve('./supabase_compras.js')]={id:'sbc',filename:'sbc',loaded:true,exports:cliente()};
let mandados=[];
require.cache[require.resolve('./notificar.js')]={id:'n',filename:'n',loaded:true,exports:{
  notificarCapataz:async()=>true,notificarCapatazTemplate:async(tel)=>{mandados.push(tel);return true;},
  mensajeEstadoIncidencia:()=>'',mensajeCierreSinReparar:()=>''}};

const pedir=require('./panel_api.js').pedirStockObjetivos;
let ok=0,mal=0;const eq=(n,c,d)=>{if(c){ok++;console.log('✓ '+n);}else{mal++;console.log('✗ '+n+(d?' — '+d:''));}};

(async()=>{
  console.log('— Sin forzar —');
  CENSOS=[{id:'x1',objetivo_id:'o1',estado:'respondido'}];updates=[];mandados=[];
  let r=await pedir({periodo:'2026-09',objetivo_ids:['o1']});
  eq('un objetivo que ya respondió se saltea',r.ya_respondidos===1&&r.enviados===0,JSON.stringify(r));
  eq('no manda WhatsApp',mandados.length===0);
  eq('no toca el censo',updates.filter(u=>u.tabla==='censos_stock'&&u.patch.estado).length===0);

  console.log('\n— Forzando —');
  CENSOS=[{id:'x1',objetivo_id:'o1',estado:'respondido'}];updates=[];mandados=[];
  r=await pedir({periodo:'2026-09',objetivo_ids:['o1'],forzar:true});
  eq('se envía igual',r.enviados===1,JSON.stringify(r));
  eq('manda el WhatsApp al capataz',mandados.length===1&&mandados[0]==='5493512665495',JSON.stringify(mandados));
  eq('el censo NO pasa a pendiente (si no, desaparece de todas las vistas)',
    !updates.some(u=>u.tabla==='censos_stock'&&u.patch.estado==='pendiente'),JSON.stringify(updates));
  eq('se marca reenviado_at, que es lo que abre el pedido',
    updates.some(u=>u.tabla==='censos_stock'&&u.patch.reenviado_at),JSON.stringify(updates));
  eq('lo cuenta como repedido',r.repedidos===1,String(r.repedidos));
  eq('NO borra el censo (solo cambia el estado)',!updates.some(u=>u.patch&&u.patch.items===null));

  console.log('\n— Pendiente: forzar no cambia nada —');
  CENSOS=[{id:'x1',objetivo_id:'o1',estado:'pendiente'}];updates=[];mandados=[];
  r=await pedir({periodo:'2026-09',objetivo_ids:['o1'],forzar:true});
  eq('un censo pendiente se reenvía igual',r.enviados===1&&r.repedidos===0,JSON.stringify(r));

  console.log('\n— Sin capataz con teléfono —');
  CENSOS=[{id:'x1',objetivo_id:'o1',estado:'respondido'}];
  const guardo=CAPS[0].telefono;CAPS[0].telefono=null;mandados=[];updates=[];
  r=await pedir({periodo:'2026-09',objetivo_ids:['o1'],forzar:true});
  eq('avisa que no hay capataz, no explota',r.sin_capataz===1&&r.enviados===0,JSON.stringify(r));
  eq('y no marca nada',r.repedidos===0&&updates.length===0,JSON.stringify(r));
  CAPS[0].telefono=guardo;

  console.log('\n— El bot reconoce el repedido —');
  const S=require('./stock.js');
  eq('exporta tienePedidoPendiente',typeof S.tienePedidoPendiente==='function');

  console.log(`\n${ok} ok · ${mal} mal`);process.exit(mal?1:0);
})().catch(e=>{console.error('✗ el harness explotó:',e);process.exit(1);});
