const PANEL_BUILD = 'fase3';  // JS del panel extraído de panel.html (Fase 3)
// Todo el código del panel vive acá. panel.html quedó solo con markup y CSS.

/* ===== UI: toast + diálogos propios (reemplazan alert/confirm/prompt) ===== */
function toast(msg,tipo){
  let c=document.getElementById('toast-cont');
  if(!c){c=document.createElement('div');c.id='toast-cont';
    c.style.cssText='position:fixed;top:16px;right:16px;z-index:200;display:flex;flex-direction:column;gap:8px';
    document.body.appendChild(c);}
  const col=tipo==='error'?'var(--rojo)':tipo==='info'?'var(--tinta-2)':'var(--brote)';
  const t=document.createElement('div');
  t.style.cssText='background:var(--blanco);border-left:4px solid '+col+';box-shadow:var(--sombra-lg);border-radius:10px;padding:12px 16px;font-size:13.5px;max-width:340px;white-space:pre-line;opacity:0;transform:translateX(12px);transition:.2s';
  t.textContent=msg;
  c.appendChild(t);requestAnimationFrame(()=>{t.style.opacity=1;t.style.transform='none';});
  setTimeout(()=>{t.style.opacity=0;t.style.transform='translateX(12px)';setTimeout(()=>t.remove(),250);},tipo==='error'?6000:4000);
}
function uiDialog({titulo,cuerpo,ok='Aceptar',cancel='Cancelar',danger,input}){
  return new Promise(res=>{
    const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=180;
    bg.innerHTML=`<div class="modal" style="max-width:420px">
      <h3>${titulo||''}</h3>
      <div style="font-size:13.5px;color:var(--tinta-2);white-space:pre-line;line-height:1.5">${cuerpo||''}</div>
      ${input!=null?`<input id="ui-inp" value="${String(input).replace(/"/g,'&quot;')}" style="width:100%;box-sizing:border-box;margin-top:12px;padding:9px;border:1px solid var(--linea);border-radius:8px;font:inherit">`:''}
      <div class="modal-acciones">
        ${cancel?`<button class="btn ghost" id="ui-no">${cancel}</button>`:''}
        <button class="btn" id="ui-si" style="${danger?'background:var(--rojo);border-color:var(--rojo)':''}">${ok}</button>
      </div></div>`;
    document.body.appendChild(bg);
    const inp=bg.querySelector('#ui-inp');if(inp){inp.focus();inp.select();}
    const cerrar=v=>{bg.remove();res(v);};
    bg.querySelector('#ui-si').onclick=()=>cerrar(input!=null?(inp?inp.value:''):true);
    const no=bg.querySelector('#ui-no');if(no)no.onclick=()=>cerrar(input!=null?null:false);
    bg.addEventListener('click',e=>{if(e.target===bg)cerrar(input!=null?null:false);});
    if(inp)inp.addEventListener('keydown',e=>{if(e.key==='Enter')bg.querySelector('#ui-si').click();});
  });
}
const uiConfirm=(cuerpo,opts={})=>uiDialog({titulo:opts.titulo||'Confirmar',cuerpo,ok:opts.ok||'Sí',cancel:opts.cancel||'Cancelar',danger:opts.danger});
const uiAlert=(cuerpo,titulo)=>uiDialog({titulo:titulo||'',cuerpo,cancel:''});
const uiPrompt=(cuerpo,valor,titulo)=>uiDialog({titulo:titulo||'',cuerpo,input:valor==null?'':valor,ok:'Aceptar'});

/* ===== Estado ===== */
let token = localStorage.getItem('eco_token') || null;
let objetivos = [];
let insumosData = [], facturasData = [], repData = [], mecanicos = [];
let filtroIns = '', combMes = '';
let insumoEntrega = null;   // pedido en el modal de entrega
let repFEstado = '', repFPrio = '', repFMec = '';

/* Estados y colores de reparaciones */
const EST_REP = ['pendiente','diagnostico','esperando_repuestos','en_reparacion','finalizado'];
const EST_REP_LABEL = ['Pendiente','Diagnóstico','Esp. repuestos','En reparación','Finalizado'];
const PRIO_BADGE = {critico:'b-red',alta:'b-amber',media:'b-blue',baja:'b-green'};
const HAB_COLOR = {hidraulica:'b-amber',soldadura:'b-red',giro_cero:'b-green',unidades:'b-amber',tractores:'b-violet',general:'b-gray',electrico:'b-amber',neumatico:'b-red',motor_2t:'b-blue',cortadora:'b-green',motor_4t:'b-blue'};
function hace(f){if(!f)return'';const d=Math.floor((Date.now()-new Date(f))/86400000);return d<=0?'hoy':d+'d';}

/* ===== Helpers ===== */
const money  = n => n==null?'—':'$ '+Number(n).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2});
const money0 = n => n==null?'—':'$ '+Number(n).toLocaleString('es-AR',{maximumFractionDigits:0});
const fechaAR = f => {
  if(!f) return '—';
  const s = String(f);
  // Fecha pura (YYYY-MM-DD, sin hora, ej. cargas_combustible.fecha): parsear
  // componentes directo, sin pasar por Date(), para no correrse con el timezone
  // local del navegador (evita el bug de mostrar el día anterior).
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${parseInt(m[2],10)}/${m[1]}`;
  const d = new Date(s);
  return isNaN(d) ? '—' : d.toLocaleDateString('es-AR');
};
const cap = s => s?s.charAt(0).toUpperCase()+s.slice(1).replace(/_/g,' '):'';

// ── Otros conceptos (percepciones IIBB, sellados, tasas, etc.) ──
// Cada concepto tiene {concepto, monto, tipo, exento}. Los NO exentos se suman
// al total a pagar; los exentos se muestran pero no suman.
// Retrocompat: facturas viejas sin otros_conceptos → lista vacía, total igual que antes.
function otrosPagables(f){
  return (f&&f.otros_conceptos||[]).reduce((s,o)=>s+(o.exento?0:(Number(o.monto)||0)),0);
}
function otrosExentos(f){
  return (f&&f.otros_conceptos||[]).reduce((s,o)=>s+(o.exento?(Number(o.monto)||0):0),0);
}
// Bruto = neto + IVA + otros conceptos pagables (sin descontar NC todavía)
function brutoFactura(f){
  return (Number(f.total_sin_iva)||0)+(Number(f.total_iva)||0)+otrosPagables(f);
}
function ncFactura(f){
  return (f.notas_credito||[]).reduce((s,n)=>s+(Number(n.total_sin_iva)||0)+(Number(n.total_iva)||0),0);
}
// Total a pagar = bruto − notas de crédito
function totalFactura(f){ return brutoFactura(f)-ncFactura(f); }

function railEstado(idx,total,amber){let s='';for(let i=0;i<total;i++)s+=`<div class="seg ${i<idx?'done':i===idx?'cur':''}"></div>`;return `<div class="rail-estado ${amber?'amber':''}">${s}</div>`}
function railLabels(labels,idx){return `<div class="rail-labels">${labels.map((l,i)=>`<span class="${i===idx?'cur':''}">${l}</span>`).join('')}</div>`}

/* ===== API ===== */
async function api(ruta, opts={}) {
  const r = await fetch(ruta, { ...opts,
    headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}), ...(opts.headers||{}) }});
  if (r.status===401){ salir(); throw new Error('Sesión vencida'); }
  if (r.status===423){ mostrarBloqueo(); throw new Error('Sistema bloqueado'); }  // PIN vencido
  if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error||'Error');
  return r.json();
}

/* ===== Login ===== */
async function entrar(){
  const usuario=document.getElementById('in-usuario').value.trim();
  const clave=document.getElementById('in-clave').value;
  const err=document.getElementById('login-err'); err.textContent='';
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario,clave})});
    if(r.status===423){mostrarBloqueo();return;}   // PIN vencido
    if(!r.ok){err.textContent='Usuario o clave incorrectos';return;}
    const d=await r.json(); token=d.token;
    localStorage.setItem('eco_token',token); localStorage.setItem('eco_user',d.nombre||d.usuario);
    localStorage.setItem('eco_mods',JSON.stringify(d.modulos||[]));
    localStorage.setItem('eco_admin',d.admin?'1':'');
    iniciar();
  }catch(e){err.textContent='No pude conectar. Reintentá.';}
}
function salir(){
  token=null; ['eco_token','eco_user','eco_mods','eco_admin'].forEach(k=>localStorage.removeItem(k));
  document.getElementById('app').classList.remove('show');
  document.getElementById('login').classList.add('show');
}
document.getElementById('in-clave').addEventListener('keydown',e=>{if(e.key==='Enter')entrar();});

// Permisos del usuario logueado. Sin dato guardado (sesión vieja) = admin,
// que era el único esquema anterior. El backend valida igual (403 si no puede).
function misModulos(){
  if(localStorage.getItem('eco_admin')==='1')return null;   // null = todo
  try{const m=JSON.parse(localStorage.getItem('eco_mods')||'null');return Array.isArray(m)?m:null;}
  catch(e){return null;}
}
function puedeVer(mod){const m=misModulos();return m===null||m.includes(mod);}
function toastPermiso(){alert('No tenés acceso a ese módulo. Pedile al administrador que te lo habilite.');}
function aplicarPermisosNav(){
  const m=misModulos();
  document.querySelectorAll('.nav-item[data-v]').forEach(el=>{
    el.style.display=puedeVer(el.dataset.v)?'':'none';
  });
  // Ocultar la etiqueta "Sistema" si Maestros no está permitido
  document.querySelectorAll('.nav-label').forEach(l=>{
    if(l.textContent.trim()==='Sistema')l.style.display=puedeVer('maestros')?'':'none';
  });
}

async function iniciar(){
  document.getElementById('login').classList.remove('show');
  document.getElementById('app').classList.add('show');
  document.getElementById('user-name').textContent=localStorage.getItem('eco_user')||'';
  document.getElementById('hoy').textContent=new Date().toLocaleDateString('es-AR',{month:'short',year:'numeric'});
  aplicarPermisosNav();
  try{objetivos=await api('/api/objetivos');}catch(e){objetivos=[];}
  try{mecanicos=await api('/api/mecanicos');}catch(e){mecanicos=[];}
  // Entrar por el primer módulo permitido (no siempre es el dashboard)
  const orden=['dashboard','compras','insumos','combustible','bateas','reparaciones','stock','maestros'];
  go(orden.find(puedeVer)||'dashboard');
  refrescarContadores();
}
async function refrescarContadores(){
  try{
    const d=await api('/api/dashboard');
    const cf=document.getElementById('c-fact'), ci=document.getElementById('c-ins');
    if(cf) cf.textContent=d.facturas.pendientes;
    if(ci) ci.textContent=d.insumos.pendientes+(d.insumos.en_compra||0);
  }catch(e){}
  try{
    const reps=await api('/api/reparaciones');
    const activas=reps.filter(r=>r.estado!=='finalizado').length;
    const cr=document.getElementById('c-rep'); if(cr) cr.textContent=activas;
  }catch(e){}
}

/* ===== Navegación ===== */
const CRUMB={dashboard:'Dashboard',bateas:'Bateas',insumos:'Insumos',combustible:'Combustible',reparaciones:'Reparaciones',maestros:'Maestros',compras:'Compras',stock:'Stock'};
let _autoRefreshTimer=null, _vistaActual=null;
const AUTO_REFRESH_MS=10*60*1000; // 10 minutos
const MODULOS_AUTOREFRESH=['reparaciones','compras','insumos'];
function programarAutoRefresh(v){
  clearTimeout(_autoRefreshTimer);
  if(!MODULOS_AUTOREFRESH.includes(v))return;
  _autoRefreshTimer=setTimeout(function tick(){
    // No refrescar si: cambiaste de módulo, hay un modal abierto, o estás
    // mirando/editando un detalle (para no patearte lo que tenés en pantalla)
    const hayModal=document.querySelector('.modal-bg.abierto');
    const hayDetalle=(v==='reparaciones'&&repDetalleAbierto)||(v==='compras'&&(comprasVer!=null||comprasMode==='carga'||comprasMode==='detalle'));
    if(_vistaActual===v&&!hayModal&&!hayDetalle){
      go(v);                       // recarga el módulo
      toast('Datos actualizados','info');
    }else{
      _autoRefreshTimer=setTimeout(tick,60*1000); // ocupado: reintenta en 1 min
    }
  },AUTO_REFRESH_MS);
}
function go(v){
  if(!puedeVer(v)){toastPermiso();return;}
  _vistaActual=v;
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('on',b.dataset.v===v));
  document.getElementById('crumb').textContent=CRUMB[v];
  const view=document.getElementById('view');
  view.innerHTML='<div class="cargando-v">Cargando…</div>';
  if(v==='dashboard')vDashboard(view);
  if(v==='bateas')vBateas(view);
  if(v==='insumos')vInsumos(view);
  if(v==='combustible')vCombustible(view);
  if(v==='reparaciones')vReparaciones(view);
  if(v==='maestros')vMaestros(view);
  if(v==='compras')vCompras(view);
  if(v==='stock')vStock(view);
  programarAutoRefresh(v);
}

/* ===== Dashboard ===== */
async function vDashboard(view){
  try{
    const d=await api('/api/dashboard');
    const c=d.compras||{},t=d.taller||{},st=d.stock||{},a=d.acciones||{};
    const pp=c.pendiente_pago||{};
    const paradas=t.paradas||[];
    const prio=t.por_prioridad||{};
    const mm=n=>{n=Number(n)||0;return n>=1e6?'$'+(n/1e6).toLocaleString('es-AR',{minimumFractionDigits:1,maximumFractionDigits:1})+'M':money0(n);};
    const varPct=c.var_pct!=null?Math.round(c.var_pct):null;

    // Evolución (línea compacta)
    const ev=(c.evolucion||[]);
    const evMax=Math.max(...ev.map(e=>e.total),1);
    const W=520,H=118,PX=30,PY=16;
    const px=i=>PX+i*((W-PX*2)/Math.max(ev.length-1,1));
    const py=v=>H-24-((v/evMax)*(H-24-PY));
    const puntos=ev.map((e,i)=>px(i)+','+py(e.total)).join(' ');
    const mesCorto=m=>['','ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][Number(String(m).slice(5,7))]||m;
    const svgEvol=ev.length>1?`<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">
      <line x1="${PX}" y1="${H-24}" x2="${W-PX}" y2="${H-24}" stroke="var(--linea)" stroke-width="1"/>
      <polyline points="${puntos}" fill="none" stroke="var(--brote)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${ev.map((e,i)=>{const ult=i===ev.length-1;return `<circle cx="${px(i)}" cy="${py(e.total)}" r="${ult?4.5:3}" fill="${ult?'var(--brote-2)':'var(--brote)'}" opacity="${ult?1:.5}"/>
        ${ult?`<text x="${px(i)}" y="${py(e.total)-8}" text-anchor="end" style="font-size:11px;font-weight:700;fill:var(--tinta)">${mm(e.total)}</text>`:''}
        <text x="${px(i)}" y="${H-8}" text-anchor="middle" style="font-size:10px;fill:var(--tinta-3);${ult?'font-weight:700;fill:var(--tinta)':''}">${mesCorto(e.mes)}</text>`;}).join('')}
    </svg>`:'<div class="sub" style="padding:14px 0">Sin datos suficientes.</div>';

    // Objetivos con mayor gasto (top 4 + Sin asignar)
    let objs=(c.objetivos_gasto||[]);
    const sinAsig=objs.find(o=>o.nombre==='Sin asignar');
    objs=objs.filter(o=>o.nombre!=='Sin asignar').slice(0,4);
    if(sinAsig)objs.push(sinAsig);
    const objMax=Math.max(...objs.map(o=>o.total),1);
    const rampVerde=['#1D9E75','#5DCAA5','#9FE1CB','#9FE1CB'];
    const barsObj=objs.length?objs.map((o,ix)=>{const esSA=o.nombre==='Sin asignar';
      return `<div style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;${esSA?'color:var(--diesel)':''}">
          <span style="font-weight:600">${o.nombre.slice(0,26)}</span><span class="mono">${mm(o.total)}</span></div>
        <div style="height:7px;background:var(--papel);border-radius:4px">
          <div style="width:${Math.max(3,Math.round(o.total*100/objMax))}%;height:100%;background:${esSA?'#EF9F27':rampVerde[Math.min(ix,3)]};border-radius:4px"></div></div>
      </div>`;}).join('')
      :'<div class="sub" style="padding:10px 0">Sin compras imputadas este mes.</div>';

    // Paradas ahora
    const listaParadas=paradas.length?paradas.slice(0,4).map(p=>`
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--papel);font-size:12.5px">
        <div style="flex:1;min-width:0"><span style="font-weight:600">${p.unidad?'🚚 ':''}${p.equipo}</span>${p.falla?' · '+p.falla:''}
          ${p.objetivo?`<span class="sub" style="font-size:11px"> · ${p.objetivo}</span>`:''}</div>
        <span class="mono" style="font-size:12px;font-weight:600;flex:0 0 auto;color:${p.dias>=3?'var(--rojo)':p.dias>=1?'var(--diesel)':'var(--tinta-2)'}">${p.dias} d</span>
      </div>`).join('')
      :'<div class="sub" style="padding:6px 0;font-size:12px">No hay máquinas paradas ✓</div>';

    // Estilo compacto tipo mockup (todo clickeable)
    const kpi=(label,val,sub,extra,click)=>`
      <div onclick="${click}" style="background:${extra&&extra.bg||'var(--blanco)'};border:1px solid ${extra&&extra.bg?'transparent':'var(--linea)'};border-radius:10px;padding:12px 14px;cursor:pointer">
        <div style="font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;font-weight:600;color:${extra&&extra.col||'var(--tinta-3)'}">${label}</div>
        <div style="font-size:23px;font-weight:700;margin-top:3px;color:${extra&&extra.col||'var(--tinta)'}">${val}</div>
        <div style="font-size:11.5px;margin-top:3px;color:${extra&&extra.subCol||'var(--tinta-2)'}">${sub}</div>
      </div>`;

    view.innerHTML=`
    <div class="view-head" style="margin-bottom:14px"><div><div class="view-title">Panel de gestión</div>
      <div class="view-desc">Compras y taller de un vistazo · ${new Date().toLocaleDateString('es-AR',{month:'long',year:'numeric'})}</div></div></div>

    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px">
      ${kpi('Gasto del mes',mm(c.gasto_mes),
        varPct!=null?`<span style="color:${varPct>0?'var(--rojo)':'var(--brote-2)'}">${varPct>0?'▲ +':'▼ '}${varPct}% vs mes anterior</span>`:'sin mes anterior',
        null,"go('compras')")}
      ${kpi('Pendiente de pago',mm(pp.total),`${pp.facturas||0} facturas · ${pp.proveedores||0} proveedores`,
        null,"comprasTab='cuenta';go('compras')")}
      ${kpi('Máquinas paradas',paradas.length,
        paradas.length?paradas.filter(p=>p.unidad).length+' unidad(es) · '+paradas.filter(p=>!p.unidad).length+' máquina(s)':'ninguna ✓',
        paradas.length?{bg:'var(--rojo-soft)',col:'var(--rojo)',subCol:'var(--rojo)'}:null,"go('reparaciones')")}
      ${kpi('Taller',`${t.activas||0} <span style="font-size:14px">activas</span>`,
        t.resolucion_prom!=null?'resolución prom. '+t.resolucion_prom.toFixed(1)+' días':(t.finalizadas_mes||0)+' cerradas este mes',
        null,"go('reparaciones')")}
    </div>

    <div style="display:grid;grid-template-columns:1.35fr 1fr;gap:10px;margin-bottom:10px">
      <div class="panel" style="padding:14px 16px;cursor:pointer" onclick="comprasTab='indicadores';go('compras')">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <div style="font-size:13.5px;font-weight:600"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:15px;height:15px;vertical-align:-2px;margin-right:4px"><circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M3 4h2l2.5 12h10L20 8H6.2"/></svg>Compras · evolución del gasto</div>
          <div class="sub" style="font-size:11px">últimos 6 meses</div></div>
        ${svgEvol}</div>
      <div class="panel" style="padding:14px 16px;cursor:pointer" onclick="comprasTab='consumos';go('compras')">
        <div style="font-size:13.5px;font-weight:600;margin-bottom:10px">Objetivos con mayor gasto · ${new Date().toLocaleDateString('es-AR',{month:'long'})}</div>
        ${barsObj}</div>
    </div>

    <div style="display:grid;grid-template-columns:1.35fr 1fr;gap:10px">
      <div class="panel" style="padding:14px 16px">
        <div style="font-size:13.5px;font-weight:600;margin-bottom:9px;cursor:pointer" onclick="go('reparaciones')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:15px;height:15px;vertical-align:-2px;margin-right:4px"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>Taller · reparaciones activas</div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          ${[['critico','crítico','var(--rojo)','var(--rojo-soft)'],['alta','alta','var(--diesel)','var(--diesel-soft)'],['media','media','var(--tinta-2)','var(--papel)'],['baja','baja','var(--brote-2)','var(--brote-soft)']].map(([k,l,col,bg])=>`
          <div style="flex:1;background:${bg};border-radius:9px;padding:7px;text-align:center;cursor:pointer" onclick="repFPrio='${k}';go('reparaciones')">
            <div style="font-size:17px;font-weight:700;color:${col}">${prio[k]||0}</div>
            <div style="font-size:10.5px;color:${col}">${l}</div></div>`).join('')}
        </div>
        <div style="font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;color:var(--tinta-3);margin-bottom:4px">Paradas ahora</div>
        ${listaParadas}</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="panel" style="flex:1;display:flex;align-items:center;gap:12px;cursor:pointer;padding:12px 16px" onclick="go('insumos')">
          <div style="color:var(--tinta-2)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:20px;height:20px;vertical-align:-2px;margin-right:4px"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg></div>
          <div style="flex:1"><div style="font-weight:600;font-size:13px">Insumos</div>
            <div class="sub" style="font-size:12px">${a.insumos_pendientes||0} pendiente${(a.insumos_pendientes||0)===1?'':'s'} de entrega</div></div>
          ${a.insumos_pendientes?`<span class="badge b-amber">${a.insumos_pendientes}</span>`:'<span class="badge b-green">✓</span>'}</div>
        <div class="panel" style="flex:1;display:flex;align-items:center;gap:12px;cursor:pointer;padding:12px 16px" onclick="go('stock')">
          <div style="color:var(--tinta-2)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:20px;height:20px;vertical-align:-2px;margin-right:4px"><rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4a2 2 0 012-2h2a2 2 0 012 2M9 10h6M9 14h6"/></svg></div>
          <div style="flex:1"><div style="font-weight:600;font-size:13px">Censo de stock · ${new Date().toLocaleDateString('es-AR',{month:'long'})}</div>
            <div style="height:7px;background:var(--papel);border-radius:4px;margin-top:5px">
              <div style="width:${st.total?Math.round((st.respondieron||0)*100/st.total):0}%;height:100%;background:var(--brote);border-radius:4px"></div></div></div>
          <span class="sub mono" style="font-size:12px">${st.respondieron||0}/${st.total||0}</span></div>
      </div>
    </div>`;
  }catch(e){view.innerHTML=`<div class="cargando-v">No pude cargar el resumen. ${e.message||''}</div>`;}
}

/* ===== Facturas (patrón "entrantes" con detalle lateral) ===== */
/* vFacturas eliminada (Fase 3): el módulo viejo de facturas quedó reemplazado por Compras */

/* ===== Insumos ===== */
/* ===== Insumos · Indicadores ===== */
let insTab='resumen', insIndPer='';
function tabsIns(){return `<div class="toggle-imp" style="margin-bottom:16px">
  <button class="${insTab==='resumen'?'on':''}" onclick="insTab='resumen';go('insumos')">Resumen</button>
  <button class="${insTab==='indicadores'?'on':''}" onclick="insTab='indicadores';go('insumos')">Indicadores</button>
</div>`;}

function vInsInd(view,todas){
  const meses=[...new Set(todas.map(p=>mesDe(p.created_at)))].filter(m=>m!=='sin fecha').sort().reverse();
  const fs=insIndPer?todas.filter(p=>mesDe(p.created_at)===insIndPer):todas;
  const pend=fs.filter(p=>p.estado==='pendiente'||p.estado==='en_compra');
  const entreg=fs.filter(p=>p.estado==='entregado');
  const items=fs.flatMap(p=>p.pedidos_insumos_items||[]);
  // Top materiales: normalizados a minúsculas para juntar "Nafta" y "nafta"
  const mat={};items.forEach(i=>{const k=String(i.item||'').trim().toLowerCase();
    if(k)mat[k]=(mat[k]||0)+1;});
  const topMat=Object.entries(mat).map(([nombre,valor])=>({nombre,valor})).sort((a,b)=>b.valor-a.valor);
  const porObj={};fs.forEach(p=>{const k=p.objetivos?p.objetivos.nombre:(p.objetivo_texto||'Sin asignar');
    porObj[k]=(porObj[k]||0)+1;});
  const topObj=Object.entries(porObj).map(([nombre,valor])=>({nombre,valor})).sort((a,b)=>b.valor-a.valor);
  const porMes={};todas.forEach(p=>{const m=mesDe(p.created_at);if(m==='sin fecha')return;
    porMes[m]=porMes[m]||{pedidos:0,items:0,entregados:0};porMes[m].pedidos++;
    porMes[m].items+=(p.pedidos_insumos_items||[]).length;
    if(p.estado==='entregado')porMes[m].entregados++;});
  const evol=Object.entries(porMes).sort((a,b)=>a[0].localeCompare(b[0]));
  view.innerHTML=`
  <div class="view-head"><div><div class="view-title">Insumos · Indicadores</div>
    <div class="view-desc">Qué se pide, cuánto y desde dónde</div></div>
    <select class="busca" style="width:auto" onchange="insIndPer=this.value;go('insumos')">
      <option value="">Todo el período</option>
      ${meses.map(m=>`<option value="${m}" ${m===insIndPer?'selected':''}>${mesStk(m)}</option>`).join('')}
    </select></div>
  ${tabsIns()}
  <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
    <div class="kpi"><div class="kpi-label">Pedidos</div><div class="kpi-val">${fs.length}</div><div class="kpi-sub">${insIndPer?mesStk(insIndPer):'histórico'}</div></div>
    <div class="kpi ${pend.length?'amber':'plain'}"><div class="kpi-label">Pendientes</div><div class="kpi-val ${pend.length?'amber':''}">${pend.length}</div><div class="kpi-sub">por entregar</div></div>
    <div class="kpi plain"><div class="kpi-label">Entregados</div><div class="kpi-val green">${entreg.length}</div><div class="kpi-sub">${fs.length?Math.round(entreg.length*100/fs.length)+'% del total':'—'}</div></div>
    <div class="kpi plain"><div class="kpi-label">Materiales pedidos</div><div class="kpi-val">${items.length}</div><div class="kpi-sub">${topMat.length} distintos</div></div>
  </div>
  <div class="grid g-2" style="margin-bottom:18px">
    <div class="panel"><div class="panel-title">Materiales más pedidos</div>${barsGen(topMat,'var(--brote)',v=>v+' veces')}</div>
    <div class="panel"><div class="panel-title">Pedidos por objetivo</div>${barsGen(topObj,'var(--diesel)',v=>v+' pedidos')}</div>
  </div>
  <div class="panel"><div class="panel-title">Evolución mensual</div>
    <table style="font-size:12px"><thead><tr><th>Período</th><th class="num">Pedidos</th><th class="num">Materiales</th><th class="num">Entregados</th></tr></thead>
    <tbody>${evol.map(([m,v])=>`<tr><td class="mono">${m}</td><td class="num">${v.pedidos}</td>
      <td class="num">${v.items}</td><td class="num">${v.entregados}</td></tr>`).join('')||'<tr><td colspan="4" class="sub" style="padding:10px">Sin datos</td></tr>'}</tbody></table>
  </div>`;
}

async function vInsumos(view){
  try{
    insumosData=await api('/api/insumos');
    if(insTab==='indicadores'){vInsInd(view,insumosData);return;}
    // 'en_compra' quedó como estado legacy: en la UI cuenta como pendiente.
    const esPend=p=>p.estado==='pendiente'||p.estado==='en_compra';
    if(filtroIns==='pendiente')insumosData=insumosData.filter(esPend);
    else if(filtroIns==='entregado')insumosData=insumosData.filter(p=>p.estado==='entregado');
    const chips=[['','Todos'],['pendiente','Pendiente'],['entregado','Entregado']].map(([e,l])=>
      `<div class="chip-f ${filtroIns===e?'on':''}" onclick="filtroIns='${e}';go('insumos')">${l}</div>`).join('');
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Pedidos de insumos</div>
      <div class="view-desc">Del pedido del capataz por WhatsApp hasta la entrega en depósito</div></div></div>
    ${tabsIns()}
    <div class="filters">${chips}</div>
    <div class="split">
      <div class="tablewrap"><table><thead><tr><th>Objetivo</th><th>Pedido</th><th style="width:92px">Fecha</th><th style="width:170px">Estado</th></tr></thead>
        <tbody id="ins-body">${insumosData.length?insumosData.map((p,ix)=>{
          const idx=p.estado==='entregado'?1:0;
          const items=(p.pedidos_insumos_items||[]).map(i=>i.item).join(', ');
          const pt=puntualidadInsumo(p);
          return `<tr onclick="selInsumo(${ix})" data-ix="${ix}">
            <td><div style="font-weight:600">${p.objetivos?p.objetivos.nombre:(p.objetivo_texto||'—')}</div><div class="sub">${p.capataces?p.capataces.nombre:''}</div></td>
            <td>${items||'—'}</td>
            <td class="mono" style="font-size:12px">${fechaAR(p.created_at)}</td>
            <td>${p.estado==='cancelado'?'<span class="badge b-red">cancelado</span>':railEstado(idx,2,false)+'<div class="sub mono" style="margin-top:5px">'+(p.estado==='entregado'?'Entregado':'Pendiente')+(pt?' · <span style="color:'+pt.color+';font-weight:600">'+pt.texto+'</span>':'')+'</div>'}</td></tr>`;}).join('')
          :'<tr><td colspan="3"><div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/></svg><div>No hay pedidos.</div></div></td></tr>'}</tbody></table></div>
      <div class="side" id="ins-side"><div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/></svg><div>Elegí un pedido<br>para ver el detalle</div></div></div>
    </div>`;
  }catch(e){view.innerHTML=`<div class="cargando-v">No pude cargar los pedidos.</div>`;}
}
// Puntualidad de un pedido: entregado = días pedido→entrega; pendiente =
// días esperando. Regla: hasta 2 días puntual (verde), 3-5 ámbar, más rojo.
function puntualidadInsumo(p){
  const D=86400000;
  if(p.estado==='entregado'){
    if(!p.entregado_at)return null;   // históricos sin fecha de entrega
    const d=Math.max(0,Math.round((new Date(p.entregado_at)-new Date(p.created_at))/D));
    return {dias:d,texto:d<=2?'en '+d+'d ✓':'en '+d+'d',color:d<=2?'var(--brote-2)':d<=5?'var(--diesel)':'var(--rojo)'};
  }
  if(p.estado==='cancelado')return null;
  const d=Math.floor((Date.now()-new Date(p.created_at))/D);
  if(d<=1)return null;
  return {dias:d,texto:'hace '+d+'d',color:d<=2?'var(--tinta-3)':d<=5?'var(--diesel)':'var(--rojo)'};
}
function selInsumo(ix){
  const p=insumosData[ix];
  document.querySelectorAll('#ins-body tr').forEach(t=>t.classList.toggle('sel',+t.dataset.ix===ix));
  const idx=p.estado==='entregado'?1:0;
  const items=(p.pedidos_insumos_items||[]).map(i=>`<div class="mcard-row"><span>${i.item}</span><b>${i.cantidad||'—'}</b></div>`).join('');
  let acc='';
  if(p.estado!=='cancelado'&&p.estado!=='entregado')
    acc=`<button class="btn" style="width:100%;justify-content:center" onclick="abrirEntrega(${ix})">Marcar entregado →</button>`;
  const cancelar=(p.estado!=='cancelado'&&p.estado!=='entregado')?`<button class="btn ghost" style="width:100%;justify-content:center;margin-top:8px;color:var(--rojo);border-color:var(--rojo-soft)" onclick="cambiarInsumo('${p.id}','cancelado')">Cancelar pedido</button>`:'';
  document.getElementById('ins-side').innerHTML=`
    <div class="side-id">PEDIDO DE INSUMOS</div>
    <div class="side-title">${p.objetivos?p.objetivos.nombre:(p.objetivo_texto||'—')}</div>
    <div class="side-meta">Pedido por ${p.capataces?p.capataces.nombre:'—'} · ${fechaAR(p.created_at)}</div>
    ${(()=>{const pt=puntualidadInsumo(p);
      if(p.estado==='entregado'&&p.entregado_at)return `<div class="side-meta" style="margin-top:2px">Entregado el ${fechaAR(p.entregado_at)} · <b style="color:${pt?pt.color:'inherit'}">${pt?(pt.dias<=2?'puntual ('+pt.dias+'d)':'demorado ('+pt.dias+'d)'):''}</b></div>`;
      if(pt&&p.estado!=='entregado')return `<div class="side-meta" style="margin-top:2px">Esperando <b style="color:${pt.color}">${pt.dias} día(s)</b></div>`;
      return '';})()}
    ${p.estado==='cancelado'?'<span class="badge b-red">cancelado</span>':railEstado(idx,2,false)+railLabels(['Pendiente','Entregado'],idx)}
    <div class="divider"></div>
    <div class="field-l" style="margin-bottom:8px">Materiales</div>${items||'<div class="sub">—</div>'}
    <div class="divider"></div>${acc}${cancelar}`;
}
// Modal de entrega: se entrega lo tildado, con cantidades editables.
// A veces no hay todo lo que pidieron — lo que se guarda (y lo que le llega
// al capataz por WhatsApp) es lo que realmente sale del depósito.
function abrirEntrega(ix){
  const p=insumosData[ix];if(!p)return;
  insumoEntrega=p;
  const items=p.pedidos_insumos_items||[];
  document.getElementById('mm-titulo').textContent='Entregar · '+(p.objetivos?p.objetivos.nombre:(p.objetivo_texto||'—'));
  document.getElementById('mm-campos').innerHTML=`
    <div class="sub" style="margin-bottom:10px">Destildá lo que no tenés y ajustá cantidades. Al capataz le llega el detalle de lo que se entrega.</div>
    ${items.length?items.map((i,n)=>`
      <div style="display:flex;align-items:center;gap:9px;padding:7px 0;border-bottom:1px solid var(--linea)">
        <input type="checkbox" id="ent-ck-${n}" checked style="accent-color:var(--brote)">
        <span style="flex:1;font-size:13px;font-weight:500">${i.item}</span>
        <input id="ent-cant-${n}" value="${(i.cantidad||'').replace(/"/g,'&quot;')}" placeholder="cant." style="width:90px;background:var(--papel);border:1px solid var(--linea);border-radius:8px;padding:7px 9px;font-family:inherit;font-size:12px;outline:none">
      </div>`).join(''):'<div class="sub">El pedido no tiene ítems cargados.</div>'}
    <div class="modal-acciones">
      <button class="btn-salir" onclick="cerrarMaestro()">Cancelar</button>
      <button class="btn" id="ent-btn" onclick="confirmarEntrega()">Entregar y avisar</button>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
}
async function confirmarEntrega(){
  const p=insumoEntrega;if(!p)return;
  const orig=p.pedidos_insumos_items||[];
  const items=orig.map((i,n)=>({
    incluir:document.getElementById('ent-ck-'+n).checked,
    item:i.item,
    cantidad:document.getElementById('ent-cant-'+n).value.trim()||null,
  })).filter(i=>i.incluir).map(({item,cantidad})=>({item,cantidad}));
  if(orig.length&&!items.length){alert('No tildaste ningún material. Si no se entrega nada, cancelá el pedido.');return;}
  const btn=document.getElementById('ent-btn');
  if(btn){btn.disabled=true;btn.textContent='Entregando…';}
  try{
    await api('/api/insumos/'+p.id,{method:'POST',body:JSON.stringify({estado:'entregado',items})});
    cerrarMaestro();insumoEntrega=null;
    go('insumos');refrescarContadores();
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='Entregar y avisar';}
    alert('No pude entregar: '+(e.message||''));
  }
}
async function cambiarInsumo(id,estado){
  try{await api('/api/insumos/'+id,{method:'POST',body:JSON.stringify({estado})});go('insumos');refrescarContadores();}
  catch(e){alert('No pude actualizar: '+e.message);}
}

/* ===== Combustible ===== */
let filtroComb='';
let combTab='cargas';           // 'cargas' | 'analisis'
let combRemStep='';             // '' | 'upload' | 'extract' | 'preview'
let combRemFile=null;
let combRemExtracted=null;
let combAna=null;               // último análisis (para el detalle lateral)
let combRemSel=null;            // selección de listados: null=último | 'todos' | [ids]
let combAnaFiltro='';           // filtro por KPI: '' | 'sin' | 'desvio'
let combAnaBusca='';            // búsqueda por patente
let combAnaOrden={col:'litros_prov',dir:-1}; // orden de la tabla
let combAnaSelKey=null;         // patente seleccionada (clave normalizada)
let combRemVer=null;            // id del listado con el detalle abierto
let combRemFilas={};            // cache de filas por listado {id:[filas]}

async function vCombustible(view){
  const tabs=`<div class="toggle-imp" style="margin-bottom:16px">
    <button class="${combTab==='cargas'?'on':''}" onclick="combTab='cargas';combRemStep='';go('combustible')">Cargas</button>
    <button class="${combTab==='analisis'?'on':''}" onclick="combTab='analisis';go('combustible')">Análisis de consumo</button>
  </div>`;
  if(combTab==='analisis'){return vCombAnalisis(view,tabs);}
  try{
    const params=[];
    if(filtroComb)params.push('estado='+filtroComb);
    if(combMes)params.push('mes='+combMes);
    const cs=await api('/api/combustible'+(params.length?'?'+params.join('&'):''));
    const chips=['','sin_facturar','facturada','anulada'].map(e=>
      `<div class="chip-f ${filtroComb===e?'on':''}" onclick="filtroComb='${e}';go('combustible')">${e?cap(e):'Todas'}</div>`).join('');
    const hoyM=new Date();
    const meses=Array.from({length:12},(_,i)=>{const d=new Date(hoyM.getFullYear(),hoyM.getMonth()-i,1);
      return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');});
    const selMes=`<select class="busca" style="width:auto" onchange="combMes=this.value;go('combustible')">
      <option value="">Últimas 200 cargas</option>
      ${meses.map(m=>`<option value="${m}" ${m===combMes?'selected':''}>${mesStk(m)} (completo)</option>`).join('')}
    </select>`;
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Combustible</div>
      <div class="view-desc">Cargas por unidad y objetivo · destino unidad o bidones</div></div>
      <div class="spacer"></div>${selMes}</div>
    ${tabs}
    <div class="filters">${chips}</div>
    <div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Proveedor</th><th>Capataz</th><th>Objetivo</th><th>Patente</th><th>Productos</th><th class="num">Litros</th><th>Estado</th><th></th></tr></thead>
      <tbody>${cs.length?cs.map(c=>{
        const items=(c.cargas_combustible_items||[]).map(i=>{
          const det=i.destino_detalle?' · '+i.destino_detalle:'';
          const dest=i.destino==='bidon'?`<span class="uni-chip" style="background:var(--diesel-soft);color:var(--diesel)">bidones${det}</span>`
            :i.destino==='equipo'?((i.equipo_id||i.unidad_id)
              ?`<span class="uni-chip" style="background:var(--azul-soft);color:var(--azul)">equipo${det}</span>`
              :`<span class="uni-chip" style="background:var(--papel);color:var(--tinta-2);border:1px solid var(--linea)">sin machear${det}</span>`)
            :'<span class="uni-chip">unidad</span>';
          return `${i.producto}${i.litros?' '+i.litros+'lt':''} ${dest}`;}).join('<br>');
        const anulada=c.estado==='anulada';
        return `<tr style="${anulada?'opacity:.55':''}"><td class="mono">${fechaAR(c.fecha)}</td>
          <td><div style="font-weight:500">${c.proveedores?c.proveedores.nombre:'—'}</div><div class="sub mono">${c.numero_remito||c.numero_factura||''}</div></td>
          <td>${c.capataces?c.capataces.nombre:'—'}</td>
          <td>${c.objetivos?c.objetivos.nombre:'<span class="sub">—</span>'}</td>
          <td><span class="uni-chip">${c.unidades?c.unidades.patente:(c.patente_raw||'—')}</span></td>
          <td style="font-size:12px">${items||'—'}</td>
          <td class="num">${c.litros_total?c.litros_total+' lt':'—'}</td>
          <td><span class="badge ${anulada?'b-red':c.estado==='facturada'?'b-green':'b-gray'}">${cap(c.estado)}</span></td>
          <td class="num">${anulada
            ?`<button class="btn ghost" style="padding:4px 10px;font-size:11.5px" onclick="restaurarCarga('${c.id}')">Restaurar</button>`
            :`<button class="btn ghost" style="padding:4px 10px;font-size:11.5px;color:var(--rojo)" onclick="anularCarga('${c.id}','${(c.numero_remito||c.numero_factura||'s/n').replace(/'/g,'')}',${c.litros_total||0})">✕ Anular</button>`}</td></tr>`;}).join('')
        :'<tr><td colspan="9"><div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 20V5a2 2 0 012-2h6a2 2 0 012 2v15"/></svg><div>No hay cargas registradas.</div></div></td></tr>'}</tbody></table></div>`;
  }catch(e){view.innerHTML=`<div class="cargando-v">No pude cargar el combustible.</div>`;}
}
async function anularCarga(id,num,litros){
  if(!confirm(`¿Anular la carga ${num}${litros?' ('+litros+' lt)':''}?\n\nNo se borra: queda como "anulada" y deja de contar en los análisis. La podés restaurar desde el filtro Anulada.`))return;
  try{await api('/api/combustible/'+id+'/anular',{method:'POST',body:'{}'});go('combustible');}
  catch(e){alert('No pude anular: '+e.message);}
}
async function restaurarCarga(id){
  try{await api('/api/combustible/'+id+'/restaurar',{method:'POST',body:'{}'});go('combustible');}
  catch(e){alert('No pude restaurar: '+e.message);}
}

/* ===== Combustible · Análisis y conciliación ===== */
function combRemPick(input){
  const f=input.files&&input.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=()=>{combRemFile={data:String(r.result).split(',')[1],type:f.type,name:f.name};go('combustible')};
  r.readAsDataURL(f);
}
async function combRemExtraer(){
  if(!combRemFile)return;
  combRemStep='extract';go('combustible');
  try{
    const d=await api('/api/combustible/remito/extract',{method:'POST',body:JSON.stringify({fileData:combRemFile.data,fileType:combRemFile.type})});
    if(d.__error){alert(d.__error);combRemStep='upload';}
    else{combRemExtracted=d;combRemStep='preview';}
  }catch(e){alert('No se pudo extraer el listado.');combRemStep='upload';}
  go('combustible');
}
function combRemSetLitros(ix,val){
  const f=(combRemExtracted.filas||[])[ix];if(!f)return;
  f.litros=Number(val)||0;
  delete f._litros_dudoso;   // el usuario lo corrigió, ya no es dudoso
  const tot=document.getElementById('cr-litros-tot');
  if(tot)tot.innerHTML='<b>'+Math.round((combRemExtracted.filas||[]).reduce((s,x)=>s+(Number(x.litros)||0),0)).toLocaleString('es-AR')+'</b>';
}
async function combRemGuardar(){
  const btn=document.getElementById('cr-save');
  if(btn){btn.disabled=true;btn.textContent='Guardando…';}
  try{
    await api('/api/combustible/remito',{method:'POST',body:JSON.stringify(combRemExtracted)});
    combRemStep='';combRemFile=null;combRemExtracted=null;
    combRemSel=null;combAnaFiltro='';combAnaBusca='';combRemVer=null; // el recién subido pasa a ser el default
    go('combustible');
  }catch(e){if(btn){btn.disabled=false;btn.textContent='Guardar y conciliar';}alert('No se pudo guardar: '+(e.message||''));}
}
/* ── Módulo Bateas (roll off) ── */
let viajesDesde='', viajesHasta='';
async function vBateas(view){
  view.innerHTML='<div class="cargando-v">Cargando…</div>';
  const hoy=new Date().toISOString().slice(0,10);
  const desde=viajesDesde||new Date(Date.now()-30*86400000).toISOString().slice(0,10);
  const hasta=viajesHasta||hoy;
  try{
    const [ind,lista]=await Promise.all([
      api('/api/viajes/indicadores?desde='+desde+'&hasta='+hasta),
      api('/api/viajes?desde='+desde+'&hasta='+hasta),
    ]);
    const k=ind.kpis||{};
    const kpi=(label,val,sub)=>`<div class="kpi plain"><div class="kpi-label">${label}</div><div class="kpi-val">${val}</div><div class="kpi-sub">${sub||''}</div></div>`;
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Bateas</div>
      <div class="view-desc">Traslado de poda en roll off · km, bateas y puntos de bajada por chofer</div></div></div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
      <span class="sub">Desde</span><input type="date" value="${desde}" onchange="viajesDesde=this.value;go('bateas')" style="padding:6px;border:1px solid var(--linea);border-radius:8px">
      <span class="sub">hasta</span><input type="date" value="${hasta}" onchange="viajesHasta=this.value;go('bateas')" style="padding:6px;border:1px solid var(--linea);border-radius:8px">
    </div>
    <div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">
      ${kpi('KM recorridos',k.km_total>0?(k.km_total).toLocaleString('es-AR')+' km':'—',k.km_total>0?k.dias_activos+' día(s) con viajes':'odómetro fuera del flujo · '+k.dias_activos+' día(s) con viajes')}
      ${kpi('Puntos totales',k.puntos_total||0,'descargas en objetivos')}
      ${kpi('M³ transportados',(k.m3_total||0).toLocaleString('es-AR')+' m³',(k.bateas_total||0)+' bateas × 14 m³')}
      ${kpi('Bateas promedio/día',(k.bateas_promedio_dia!=null?k.bateas_promedio_dia:'—'),'por día con actividad')}
    </div>
    <div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
      <div class="panel"><div class="panel-title" style="margin-bottom:10px">Por chofer</div>
        ${(ind.por_chofer||[]).length?`<div class="tablewrap"><table><thead><tr><th>Chofer</th><th class="num">KM</th><th class="num">Bateas</th><th class="num">M³</th><th class="num">Puntos</th><th class="num">Días</th></tr></thead><tbody>
          ${ind.por_chofer.map(c=>`<tr><td>${c.chofer}</td><td class="num mono">${c.km>0?c.km.toLocaleString('es-AR'):'—'}</td><td class="num mono">${c.bateas}</td><td class="num mono">${c.m3.toLocaleString('es-AR')}</td><td class="num mono">${c.puntos}</td><td class="num mono">${c.jornadas}</td></tr>`).join('')}
        </tbody></table></div>`:'<div class="sub" style="padding:10px 0">Sin datos en el período.</div>'}
      </div>
      <div class="panel"><div class="panel-title" style="margin-bottom:10px">Bateas por objetivo</div>
        ${(ind.por_objetivo||[]).length?(function(){const mx=Math.max(...ind.por_objetivo.map(o=>o.bateas),1);
          return ind.por_objetivo.slice(0,10).map(o=>`<div style="margin-bottom:7px"><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px"><span>${o.nombre}</span><span class="mono">${o.bateas} bat · ${o.m3.toLocaleString('es-AR')} m³</span></div><div style="height:7px;background:var(--papel);border-radius:4px"><div style="width:${Math.round(o.bateas*100/mx)}%;height:100%;background:var(--brote);border-radius:4px"></div></div></div>`).join('');})()
          :'<div class="sub" style="padding:10px 0">Sin bateas en el período.</div>'}
      </div>
    </div>
    <div class="panel-title" style="margin-bottom:8px">Detalle de jornadas</div>
    <div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Chofer</th><th>Unidad</th><th class="num">Odóm. ini</th><th class="num">Odóm. fin</th><th class="num">KM</th><th class="num">Bateas</th><th>Paradas</th><th></th></tr></thead>
      <tbody>${lista.length?lista.map(v=>`<tr>
        <td class="mono">${fechaAR(v.fecha)}</td>
        <td>${v.capataces?v.capataces.nombre:'—'}</td>
        <td><span class="uni-chip">${v.unidades?v.unidades.patente:(v.patente_raw||'—')}</span></td>
        <td class="num mono">${v.odometro_inicio!=null?Number(v.odometro_inicio).toLocaleString('es-AR'):'—'}</td>
        <td class="num mono">${v.odometro_fin!=null?Number(v.odometro_fin).toLocaleString('es-AR'):'—'}</td>
        <td class="num mono"><b>${v.km!=null?Number(v.km).toLocaleString('es-AR'):'—'}</b></td>
        <td class="num mono">${v.total_bateas||0}</td>
        <td style="font-size:12px">${(v.paradas||[]).map(p=>p.objetivo_nombre+' ('+p.bateas+')').join(', ')||'—'}</td>
        <td class="num"><button class="btn ghost" style="padding:4px 9px;font-size:11px;color:var(--rojo)" onclick="anularViaje('${v.id}')">✕</button></td>
      </tr>`).join('')
        :'<tr><td colspan="9"><div class="empty" style="height:120px"><div>No hay viajes cargados en el período.<br><span class="sub">Los choferes los cargan por WhatsApp al bot con la opción "Cargar viajes".</span></div></div></td></tr>'}</tbody></table></div>`;
  }catch(e){view.innerHTML=`<div class="view-head"><div><div class="view-title">Bateas</div></div></div><div class="cargando-v">${e.message||'No pude cargar los viajes.'}<br><span class="sub">¿Creaste la tabla viajes_bateas en Supabase?</span></div>`;}
}
async function anularViaje(id){
  if(!await uiConfirm('¿Eliminar esta jornada de viaje?','Eliminar viaje',{ok:'Eliminar',danger:true}))return;
  try{await api('/api/viajes/'+id+'/anular',{method:'POST',body:'{}'});go('bateas');}
  catch(e){toast('No pude eliminar: '+e.message,'error');}
}

async function vCombAnalisis(view,tabs){
  // Flujo de subida del listado
  if(combRemStep==='upload'){
    view.innerHTML=`<div class="view-head"><div><div class="view-title">Subir listado del proveedor</div>
      <div class="view-desc">El resumen de remitos del período (Ferreyra, SERVISUD…)</div></div>
      <button class="btn-salir" onclick="combRemStep='';go('combustible')">← Volver</button></div>
    <div style="max-width:520px">
      <label class="dropzone">
        <input type="file" accept="application/pdf,image/*" style="display:none" onchange="combRemPick(this)">
        <div class="dz-ico">＋</div>
        <div class="dz-t">${combRemFile?combRemFile.name:'Tocá para elegir el listado'}</div>
        <div class="dz-s">PDF, JPG o PNG</div>
      </label>
      ${combRemFile?`<button class="btn" style="margin-top:14px;width:100%" onclick="combRemExtraer()">✦ Extraer con IA</button>`:''}
    </div>`;
    return;
  }
  if(combRemStep==='extract'){
    view.innerHTML=`<div class="view-head"><div class="view-title">Subir listado</div></div>
      <div class="cargando-v">✦ Leyendo el listado con IA…<br><span class="sub">Un listado largo puede tardar 1 a 2 minutos. No cierres esta pantalla.</span></div>`;
    return;
  }
  if(combRemStep==='preview'){
    const d=combRemExtracted||{};const fs=d.filas||[];
    view.innerHTML=`<div class="view-head"><div><div class="view-title">Revisar listado</div>
      <div class="view-desc">${d.proveedor||'—'} · ${fechaAR(d.periodo_desde)} a ${fechaAR(d.periodo_hasta)} · ${fs.length} línea${fs.length===1?'':'s'}</div></div>
      <button class="btn-salir" onclick="combRemStep='upload';go('combustible')">← Atrás</button></div>
    ${d._advertencia?`<div class="aviso-amarillo">⚠ ${d._advertencia} Las filas en rojo tienen un litraje sospechoso — corregilo tocando el número antes de guardar.</div>`:''}
    <div class="sub" style="margin-bottom:10px">Revisá los litros. Si la IA leyó mal alguno, tocá el número y corregilo.</div>
    <div class="tabla-wrap" style="margin-bottom:14px">
      <table><thead><tr><th>Fecha</th><th>N° Remito</th><th>Patente</th><th>Chofer</th><th>Producto</th><th class="tr">Litros</th><th class="tr">Total</th></tr></thead>
      <tbody>${fs.map((f,ix)=>`<tr${f._litros_dudoso?' style="background:var(--rojo-soft)"':''}><td class="mono">${fechaAR(f.fecha)}</td><td class="mono">${f.numero_remito||'—'}</td>
        <td><span class="uni-chip">${f.patente||'—'}</span></td><td>${f.chofer||'—'}</td><td style="font-size:12px">${f.producto||'—'}</td>
        <td class="tr"><input type="number" step="0.01" value="${f.litros!=null?f.litros:''}" onchange="combRemSetLitros(${ix},this.value)" style="width:90px;text-align:right;padding:5px 7px;border:1px solid ${f._litros_dudoso?'var(--rojo)':'var(--linea)'};border-radius:7px;font-family:'JetBrains Mono',monospace;font-size:12px;outline:none"></td>
        <td class="money tr">${money0(f.total)}</td></tr>`).join('')}
      <tr class="tot-row"><td colspan="5"><b>Total general</b></td><td class="tr mono" id="cr-litros-tot"><b>${Math.round(fs.reduce((s,f)=>s+(Number(f.litros)||0),0)).toLocaleString('es-AR')}</b></td><td class="money tr"><b>${money0(d.total_general)}</b></td></tr></tbody></table>
    </div>
    <button class="btn" id="cr-save" onclick="combRemGuardar()">Guardar y conciliar</button>`;
    return;
  }
  // Vista de análisis — maestro-detalle: unidades a la izquierda, detalle al costado
  try{
    const qs=combRemSel==='todos'?'?ids=todos'
      :(Array.isArray(combRemSel)&&combRemSel.length?'?ids='+combRemSel.join(','):'');
    combAna=await api('/api/combustible/analisis'+qs);
    const a=combAna;const k=a.kpis||{};
    combAnaSelKey=null; // el detalle se rearma al tocar una unidad
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Análisis de consumo</div>
      <div class="view-desc">Listados del proveedor vs. tickets de los capataces · tocá una unidad para el detalle</div></div>
      <button class="btn" onclick="combRemStep='upload';combRemFile=null;go('combustible')">＋ Subir listado</button></div>
    ${tabs}
    ${a.remitos.length?'':'<div class="aviso-amarillo">Todavía no hay listados del proveedor cargados. Subí el primero para empezar a conciliar.</div>'}
    <div id="ana-listados"></div>
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Litros s/ proveedor</div><div class="kpi-val">${Math.round(k.litros_prov||0)}</div><div class="kpi-sub">${k.entregas||0} entregas · <span id="ana-lst-count"></span></div></div>
      <div class="kpi plain"><div class="kpi-label">Litros c/ ticket</div><div class="kpi-val">${Math.round(k.litros_ticket||0)}</div><div class="kpi-sub">cobertura ${k.cobertura_pct!=null?k.cobertura_pct+'%':'—'}</div></div>
      <div class="kpi click ${combAnaFiltro==='sin'?'on':''} ${k.sin_ticket?'':'plain'}" id="kpi-sin" onclick="anaSetFiltro('sin')" title="Filtrar unidades sin ticket"><div class="kpi-label">Sin ticket</div><div class="kpi-val">${k.sin_ticket||0}</div><div class="kpi-sub">entregas sin comprobante</div></div>
      <div class="kpi click ${combAnaFiltro==='desvio'?'on':''} ${k.desvios?'':'plain'}" id="kpi-desvio" onclick="anaSetFiltro('desvio')" title="Filtrar unidades con desvío"><div class="kpi-label">Desvíos</div><div class="kpi-val">${k.desvios||0}</div><div class="kpi-sub">litros no coinciden</div></div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <input class="busca" placeholder="Buscar patente…" value="${combAnaBusca.replace(/"/g,'&quot;')}" oninput="combAnaBusca=this.value;renderAnaTabla()">
      <div class="sub" id="ana-count"></div>
    </div>
    <div class="split">
      <div class="tablewrap" id="ana-tabla"></div>
      <div class="side" id="ana-side"><div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 20V5a2 2 0 012-2h6a2 2 0 012 2v15"/><path d="M3 20h12M14 8h2.5a2 2 0 012 2v7a2 2 0 002 2 2 2 0 002-2v-9l-3-3"/></svg><div>Elegí una unidad<br>para ver sus entregas y tickets</div></div></div>
    </div>`;
    renderAnaListados();
    renderAnaTabla();
  }catch(e){view.innerHTML=tabs+`<div class="cargando-v">No pude armar el análisis. ${e.message||''}</div>`;}
}
function renderAnaListados(){
  const cont=document.getElementById('ana-listados');
  const a=combAna;if(!cont||!a)return;
  const cnt=document.getElementById('ana-lst-count');
  if(!a.remitos.length){cont.innerHTML='';if(cnt)cnt.textContent='';return;}
  const aplicados=new Set(a.ids_aplicados||[]);
  const todos=a.remitos.every(r=>aplicados.has(String(r.id)));
  if(cnt)cnt.textContent=aplicados.size+' de '+a.remitos.length+' listado'+(a.remitos.length>1?'s':'');
  cont.innerHTML=`<div class="panel-title" style="margin-bottom:8px">Listados procesados</div>
  <div class="tablewrap" style="margin-bottom:16px"><table>
    <thead><tr>
      <th style="width:34px"><input type="checkbox" ${todos?'checked':''} onchange="anaTodosListados(this.checked)" title="Incluir todos" style="accent-color:var(--brote)"></th>
      <th>Proveedor</th><th>Período</th><th class="num">Registros</th><th class="num">Litros</th><th class="num">Total</th><th style="width:110px"></th>
    </tr></thead>
    <tbody>${a.remitos.map(r=>{
      const id=String(r.id);const on=aplicados.has(id);
      const fila=`<tr style="${on?'':'opacity:.5'}">
        <td><input type="checkbox" ${on?'checked':''} onchange="anaToggleListado('${id}')" style="accent-color:var(--brote)"></td>
        <td style="font-weight:500">${r.proveedor||'—'}</td>
        <td class="mono" style="font-size:12px">${fechaAR(r.periodo_desde)} → ${fechaAR(r.periodo_hasta)}</td>
        <td class="num">${r.filas}</td>
        <td class="num">${Math.round(r.litros||0)}</td>
        <td class="num money">${money0(r.total_general)}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn-salir" style="padding:4px 10px;font-size:11.5px" onclick="anaVerListado('${id}')">${combRemVer===id?'Cerrar':'Ver'}</button>
          <button class="btn-salir" style="padding:4px 8px;font-size:11.5px;color:var(--rojo)" title="Eliminar listado" onclick="combRemBorrar(event,'${id}')">✕</button>
        </td></tr>`;
      if(combRemVer!==id)return fila;
      const fs=combRemFilas[id];
      const det=!fs?'<div class="sub" style="padding:10px 0">Cargando líneas…</div>'
        :`<div style="max-height:320px;overflow:auto"><table style="font-size:11.5px">
          <thead><tr><th>Fecha</th><th>N° Remito</th><th>Patente</th><th>Chofer</th><th>Producto</th><th class="num">Litros</th></tr></thead>
          <tbody>${fs.map(f=>`<tr><td class="mono">${fechaAR(f.fecha)}</td><td class="mono">${f.numero_remito||'—'}</td>
            <td><span class="uni-chip">${f.patente||'—'}</span></td><td>${f.chofer||'—'}</td><td>${f.producto||'—'}</td>
            <td class="num">${f.litros!=null?f.litros:'—'}</td></tr>`).join('')}</tbody></table></div>`;
      return fila+`<tr><td></td><td colspan="6" style="padding:4px 8px 12px">${det}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}
async function anaVerListado(id){
  id=String(id);
  combRemVer=combRemVer===id?null:id;
  renderAnaListados();
  if(combRemVer===id&&!combRemFilas[id]){
    try{
      const d=await api('/api/combustible/remito/'+id);
      combRemFilas[id]=d.filas||[];
    }catch(e){combRemFilas[id]=[];alert('No pude traer las líneas del listado.');}
    if(combRemVer===id)renderAnaListados();
  }
}
function anaTodosListados(marcado){
  combRemSel=marcado?'todos':null; // destildar todos = volver al más reciente
  combRemVer=null;
  go('combustible');
}
function anaToggleListado(id){
  const a=combAna;if(!a)return;
  id=String(id);
  let sel=Array.isArray(combRemSel)?combRemSel.slice():(a.ids_aplicados||[]).slice();
  if(sel.includes(id)){if(sel.length>1)sel=sel.filter(x=>x!==id);} // no dejar el análisis vacío
  else sel.push(id);
  combRemSel=sel;
  combRemVer=null;
  go('combustible');
}
async function combRemBorrar(ev,id){
  ev.stopPropagation();
  if(!confirm('¿Eliminar este listado del proveedor?\nSe quita del análisis. Las cargas de los capataces no se tocan.'))return;
  try{
    await api('/api/combustible/remito/'+id,{method:'DELETE'});
    if(Array.isArray(combRemSel)){
      combRemSel=combRemSel.filter(x=>x!==String(id));
      if(!combRemSel.length)combRemSel=null;
    }
    if(combRemVer===String(id))combRemVer=null;
    delete combRemFilas[String(id)];
    go('combustible');
  }catch(e){alert('No se pudo eliminar: '+(e.message||''));}
}
function anaSetFiltro(f){
  combAnaFiltro=combAnaFiltro===f?'':f;
  const ks=document.getElementById('kpi-sin'),kd=document.getElementById('kpi-desvio');
  if(ks)ks.classList.toggle('on',combAnaFiltro==='sin');
  if(kd)kd.classList.toggle('on',combAnaFiltro==='desvio');
  renderAnaTabla();
}
function anaOrdenar(col){
  if(combAnaOrden.col===col)combAnaOrden.dir=-combAnaOrden.dir;
  else combAnaOrden={col,dir:col==='patente'?1:-1};
  renderAnaTabla();
}
function anaKey(p){const k=String(p||'').toUpperCase().replace(/[^A-Z0-9]/g,'');return k||'SINPAT';}
function renderAnaTabla(){
  const cont=document.getElementById('ana-tabla');
  const a=combAna;if(!cont||!a)return;
  let us=(a.unidades||[]).slice();
  if(combAnaFiltro==='sin')us=us.filter(u=>u.sin_ticket>0);
  if(combAnaFiltro==='desvio')us=us.filter(u=>u.sin_ticket===0&&Math.abs(u.dif)>1);
  if(combAnaBusca.trim()){const b=anaKey(combAnaBusca);us=us.filter(u=>anaKey(u.patente).includes(b));}
  const{col,dir}=combAnaOrden;
  const rk=u=>u.sin_ticket>0?2:Math.abs(u.dif)>1?1:0;
  us.sort((x,y)=>col==='patente'?dir*String(x.patente).localeCompare(String(y.patente))
    :col==='estado'?dir*(rk(x)-rk(y))
    :dir*((x[col]||0)-(y[col]||0)));
  const arr=c=>combAnaOrden.col===c?`<span class="arr">${combAnaOrden.dir>0?'▲':'▼'}</span>`:'';
  const semaforo=u=>u.sin_ticket>0?'<span class="badge b-red">sin ticket</span>':Math.abs(u.dif)>1?'<span class="badge b-amber">desvío</span>':'<span class="badge b-green">ok</span>';
  cont.innerHTML=`<table><thead><tr>
    <th class="sortable" onclick="anaOrdenar('patente')">Patente${arr('patente')}</th>
    <th class="num sortable" onclick="anaOrdenar('litros_prov')">Lt. proveedor${arr('litros_prov')}</th>
    <th class="num sortable" onclick="anaOrdenar('litros_ticket')">Lt. tickets${arr('litros_ticket')}</th>
    <th class="num sortable" onclick="anaOrdenar('dif')">Dif.${arr('dif')}</th>
    <th class="sortable" onclick="anaOrdenar('estado')">Estado${arr('estado')}</th></tr></thead>
  <tbody id="ana-list">${us.length?us.map(u=>{const key=anaKey(u.patente);
    return `<tr onclick="selUniAna('${key}')" data-key="${key}" style="cursor:pointer;${key===combAnaSelKey?'outline:2px solid var(--brote)':''}">
    <td><span class="uni-chip">${u.patente}</span></td>
    <td class="num">${u.litros_prov}</td><td class="num">${u.litros_ticket}</td>
    <td class="num" style="${Math.abs(u.dif)>1?'color:var(--rojo);font-weight:600':''}">${u.dif>0?'+':''}${u.dif}</td>
    <td>${semaforo(u)}</td></tr>`;}).join('')
    :`<tr><td colspan="5"><div class="sub" style="padding:14px">${(a.unidades||[]).length?'Ninguna unidad coincide con el filtro.':'Sin datos aún.'}</div></td></tr>`}</tbody></table>`;
  const cnt=document.getElementById('ana-count');
  if(cnt)cnt.textContent=us.length===(a.unidades||[]).length?us.length+' unidades':us.length+' de '+(a.unidades||[]).length+' unidades';
}
function selUniAna(key){
  const a=combAna;if(!a)return;
  const nP=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const u=(a.unidades||[]).find(x=>anaKey(x.patente)===key);if(!u)return;
  combAnaSelKey=key;
  document.querySelectorAll('#ana-list tr').forEach(t=>t.style.outline=(t.dataset.key===key)?'2px solid var(--brote)':'none');
  const pat=nP(u.patente);
  // Entregas de esta unidad: con ticket, con desvío, y sin ticket
  const entregas=[
    ...a.matcheadas.filter(g=>nP(g.patente)===pat).map(g=>({...g,__st:'ok'})),
    ...a.desvios.filter(g=>nP(g.patente)===pat).map(g=>({...g,__st:'desvio'})),
    ...a.sin_ticket.filter(g=>nP(g.patente)===pat).map(g=>({...g,__st:'sin'})),
  ].sort((x,y)=>String(x.fecha||'').localeCompare(String(y.fecha||'')));
  const sinResp=a.sin_respaldo.filter(c=>nP(c.patente)===pat);
  const chip=e=>e.__st==='ok'?'<span class="badge b-green">✓ ticket</span>'
    :e.__st==='desvio'?`<span class="badge b-amber">⚠ ${e.dif>0?'+':''}${e.dif} lt</span>`
    :'<span class="badge b-red">✕ sin ticket</span>';
  document.getElementById('ana-side').innerHTML=`
    <div class="side-id">ANÁLISIS · unidad</div>
    <div class="side-title"><span class="uni-chip" style="font-size:14px">${u.patente}</span></div>
    <div class="side-meta">${u.entregas} entregas del proveedor · ${u.cargas} tickets subidos</div>
    <div style="display:flex;gap:12px;margin:12px 0">
      <div class="extract-field" style="flex:1"><label>Lt. proveedor</label><div class="val filled">${u.litros_prov}</div></div>
      <div class="extract-field" style="flex:1"><label>Lt. tickets</label><div class="val filled">${u.litros_ticket}</div></div>
      <div class="extract-field" style="flex:1"><label>Dif.</label><div class="val ${Math.abs(u.dif)>1?'filled':''}" style="${Math.abs(u.dif)>1?'color:var(--rojo)':''}">${u.dif>0?'+':''}${u.dif}</div></div>
    </div>
    <div class="divider"></div>
    <div class="panel-title" style="margin-bottom:10px">Entregas del período</div>
    ${entregas.length?entregas.map(e=>`
      <div class="queue-item" style="margin-bottom:8px">
        <div style="flex:1"><div style="font-weight:600;font-size:12px">${fechaAR(e.fecha)} · ${Math.round(e.litros*100)/100} lt</div>
        <div class="sub mono" style="font-size:11px">${e.numero_remito||'s/n'}${e.chofer?' · '+e.chofer:''}</div>
        ${e.capataz||e.objetivo?`<div class="sub" style="font-size:11px">👷 ${e.capataz||'—'}${e.objetivo?' → '+e.objetivo:''}</div>`:''}</div>
        ${chip(e)}
      </div>`).join(''):'<div class="sub" style="padding:8px 0">Sin entregas del proveedor para esta unidad.</div>'}
    ${sinResp.length?`<div class="divider"></div>
    <div class="panel-title" style="margin-bottom:10px">Tickets sin respaldo del proveedor</div>
    ${sinResp.map(c=>`<div class="queue-item" style="margin-bottom:8px">
      <div style="flex:1"><div style="font-weight:600;font-size:12px">${fechaAR(c.fecha)} · ${c.litros||'?'} lt</div>
      <div class="sub mono" style="font-size:11px">${c.numero_remito||'s/n'}</div>
      <div class="sub" style="font-size:11px">👷 ${c.capataz||'—'}${c.objetivo?' → '+c.objetivo:''}</div></div>
      <span class="badge b-amber">revisar</span></div>`).join('')}`:''}`;
}

/* ===== Stock de maquinaria ===== */
let stockTab='censo';    // 'censo' | 'inventario' | 'consolidado'
let stockPeriodo=null;   // null = período actual
let stockData=null;      // último GET /api/stock (para el detalle lateral)
let stockSelId=null;     // censo seleccionado
let stockPedirSel=new Set(); // objetivos tildados en el modal de pedido
let stockInv=null;       // inventario oficial
let stockInvEdit=null;   // línea del inventario en edición

const MESES_STK=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function mesStk(p){const[a,m]=String(p).split('-').map(Number);const n=MESES_STK[(m||1)-1]||'';return n.charAt(0).toUpperCase()+n.slice(1)+' '+(a||'');}
function horaStk(iso){if(!iso)return'';return new Date(iso).toLocaleString('es-AR',{timeZone:'America/Argentina/Cordoba',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}
function tabsStk(){return `<div class="toggle-imp" style="margin-bottom:16px">
  <button class="${stockTab==='censo'?'on':''}" onclick="stockTab='censo';go('stock')">Censo</button>
  <button class="${stockTab==='objetivo'?'on':''}" onclick="stockTab='objetivo';go('stock')">Por objetivo</button>
  <button class="${stockTab==='inventario'?'on':''}" onclick="stockTab='inventario';go('stock')">Inventario</button>
  <button class="${stockTab==='consolidado'?'on':''}" onclick="stockTab='consolidado';go('stock')">Consolidado</button>
</div>`;}
function difStk(d){
  if(d==null)return'<span class="sub">—</span>';
  if(d===0)return'<span class="badge b-green">ok</span>';
  return`<span class="badge ${d<0?'b-red':'b-amber'}">${d>0?'+':''}${d}</span>`;
}

async function vStock(view){
  if(stockTab==='inventario')return vStockInventario(view);
  if(stockTab==='consolidado')return vStockConsolidado(view);
  if(stockTab==='objetivo')return vStockObjetivos(view);
  return vStockCenso(view);
}

/* ── Solapa Por objetivo: ficha completa de cada objetivo ── */
let stockObjs=null,stockObjSel=null,stockFicha=null;
async function vStockObjetivos(view){
  try{
    const per=stockPeriodo||'';
    stockObjs=await api('/api/stock/objetivos'+(per?'?periodo='+encodeURIComponent(per):''));
    const d=stockObjs;
    const sem=o=>o.sin_inventario?'<span class="badge b-gray">sin inventario</span>'
      :o.estado!=='respondido'?'<span class="badge b-red">no censó</span>'
      :o.dif===0?'<span class="badge b-green">ok</span>'
      :`<span class="badge ${o.dif<0?'b-red':'b-amber'}">${o.tipos_desvio} desvío${o.tipos_desvio>1?'s':''}</span>`;
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Stock de maquinaria</div>
      <div class="view-desc">Ficha por objetivo · inventario, censo de ${mesStk(d.periodo)}, desvíos e histórico</div></div></div>
    ${tabsStk()}
    <div class="split">
      <div class="tablewrap">
        <table><thead><tr><th>Objetivo</th><th>Capataz</th><th class="num">Oficial</th><th class="num">Censo</th><th class="num">Dif</th><th>Estado</th></tr></thead>
        <tbody id="obj-list">${d.filas.length?d.filas.map(o=>`<tr onclick="selObjStock('${o.id}')" data-id="${o.id}" style="cursor:pointer;${o.id===stockObjSel?'outline:2px solid var(--brote)':''}">
          <td style="font-weight:500">${o.nombre}</td>
          <td class="sub">${o.capataz||'—'}</td>
          <td class="num">${o.oficial}</td>
          <td class="num">${o.censo!=null?o.censo:'—'}</td>
          <td class="num" style="${o.dif?'color:var(--rojo);font-weight:600':''}">${o.dif!=null?(o.dif>0?'+':'')+o.dif:'—'}</td>
          <td>${sem(o)}</td></tr>`).join('')
          :'<tr><td colspan="6"><div class="sub" style="padding:14px">No hay objetivos operativos.</div></td></tr>'}</tbody></table>
      </div>
      <div class="side" id="obj-ficha"><div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7h16M4 7l2-3h12l2 3M4 7v13h16V7"/><path d="M9 11h6M9 15h6"/></svg><div>Elegí un objetivo<br>para ver su ficha completa</div></div></div>
    </div>`;
    if(stockObjSel)selObjStock(stockObjSel);
  }catch(e){view.innerHTML=tabsStk()+`<div class="cargando-v">No pude cargar los objetivos. ${e.message||''}</div>`;}
}
async function selObjStock(id){
  stockObjSel=String(id);
  document.querySelectorAll('#obj-list tr').forEach(t=>t.style.outline=(t.dataset.id===stockObjSel)?'2px solid var(--brote)':'none');
  const cont=document.getElementById('obj-ficha');
  if(cont)cont.innerHTML='<div class="sub" style="padding:14px">Cargando ficha…</div>';
  try{
    const per=stockPeriodo||'';
    const f=await api('/api/stock/objetivo/'+id+(per?'?periodo='+encodeURIComponent(per):''));
    stockFicha=f;
    const c=f.censo;
    const box=document.getElementById('obj-ficha');
    if(!box||stockObjSel!==String(id))return;
    const totOf=f.filas.reduce((s,x)=>s+x.cantidad,0);
    const totCen=f.filas.reduce((s,x)=>s+(x.censo||0),0);
    box.innerHTML=`
      <div class="side-id">FICHA · objetivo</div>
      <div class="side-title">${f.objetivo.nombre}</div>
      <div class="side-meta">${c?(c.estado==='respondido'
          ?'Censó '+mesStk(f.periodo)+' · '+(c.capataz||'—')+' · '+horaStk(c.respondido_at)
          :'Pedido enviado, sin respuesta')
        :'Sin censo este período'}</div>
      <div style="display:flex;gap:10px;margin:12px 0">
        <div class="extract-field" style="flex:1"><label>Oficial</label><div class="val filled">${totOf}</div></div>
        <div class="extract-field" style="flex:1"><label>Censo</label><div class="val ${c&&c.estado==='respondido'?'filled':''}">${c&&c.estado==='respondido'?totCen:'—'}</div></div>
        <div class="extract-field" style="flex:1"><label>Dif</label><div class="val ${totCen-totOf?'filled':''}" style="${totCen-totOf<0?'color:var(--rojo)':''}">${c&&c.estado==='respondido'?(totCen-totOf>0?'+':'')+(totCen-totOf):'—'}</div></div>
      </div>
      ${c&&c.estado!=='respondido'?`<button class="btn" style="width:100%;margin-bottom:12px" onclick="reenviarStock('${c.id}')">↻ Reenviar pedido</button>`:''}
      <div class="divider"></div>
      <div class="panel-title" style="margin-bottom:10px">Maquinaria</div>
      ${f.filas.length?f.filas.map(x=>`
        <div class="queue-item" style="margin-bottom:8px;${x.huerfano?'background:var(--papel)':''}">
          <div style="flex:1">
            <div style="font-weight:600;font-size:12.5px">${x.tipo_equipo}${x.huerfano?' <span class="badge b-blue" style="font-size:9px">nuevo</span>':''}</div>
            <div class="sub mono" style="font-size:11px">${x.huerfano?'no está en el inventario'
              :'oficial '+x.cantidad+(x.censo!=null?' · informó '+x.censo:'')+((x.numeros||[]).length?' · N° '+x.numeros.join(', '):'')}</div>
          </div>
          ${x.huerfano
            ?`<button class="btn-salir" style="padding:4px 8px;font-size:11px;color:var(--brote-2)" onclick="incorporarInv('${f.objetivo.id}','${String(x.tipo_equipo).replace(/'/g,"\\'")}',${x.censo})">+ Agregar</button>`
            :`${difStk(x.dif)} <button class="btn-salir" style="padding:3px 7px;font-size:11px;margin-left:6px" onclick="editarInvFicha(${x.id})">✎</button>`}
        </div>`).join('')
        :'<div class="sub" style="padding:8px 0">Sin inventario ni censo todavía.</div>'}
      <div class="divider"></div>
      <div class="panel-title" style="margin-bottom:10px">Histórico</div>
      ${f.historico.length?f.historico.map(h=>`
        <div class="queue-item" style="margin-bottom:6px">
          <div style="flex:1"><div style="font-weight:600;font-size:12px">${mesStk(h.periodo)}</div>
          <div class="sub" style="font-size:11px">${h.items.map(i=>i.tipo_equipo+' ×'+i.cantidad).join(' · ')||'sin equipos'}</div></div>
          <div class="mono" style="font-size:13px">${h.total}</div>
        </div>`).join('')
        :'<div class="sub" style="padding:4px 0">Sin censos anteriores.</div>'}`;
  }catch(e){
    const box=document.getElementById('obj-ficha');
    if(box)box.innerHTML='<div class="sub" style="padding:14px">No pude cargar la ficha.</div>';
  }
}
// Editar una línea del inventario desde la ficha (reusa el modal del inventario)
function editarInvFicha(id){
  const x=(stockFicha.filas||[]).find(f=>f.id===id);if(!x)return;
  stockInvEdit={id:x.id,objetivo:stockFicha.objetivo.nombre,tipo_equipo:x.tipo_equipo,
    cantidad:x.cantidad,numeros:x.numeros,observacion:x.observacion,censo:x.censo};
  abrirModalInv(stockInvEdit,stockFicha.periodo);
}

/* ── Solapa Inventario: el stock oficial, editable, con desvío ── */
async function vStockInventario(view){
  try{
    const per=stockPeriodo||'';
    stockInv=await api('/api/stock/inventario'+(per?'?periodo='+encodeURIComponent(per):''));
    const d=stockInv;const k=d.kpis||{};
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Stock de maquinaria</div>
      <div class="view-desc">Inventario oficial de cada objetivo · el censo de ${mesStk(d.periodo)} se compara contra esto</div></div>
      <button class="btn" onclick="sembrarInv()">🌱 Sembrar desde el censo</button></div>
    ${tabsStk()}
    ${k.huerfanos?`<div class="aviso-amarillo">${k.huerfanos} tipo${k.huerfanos>1?'s':''} de equipo que los capataces informaron todavía no está en el inventario oficial. Agregalos con el botón <b>+ Agregar</b> de cada fila, o sembralos todos de una.</div>`:''}
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Coinciden</div><div class="kpi-val green">${k.coinciden||0}</div><div class="kpi-sub">objetivos sin desvío</div></div>
      <div class="kpi ${k.faltantes?'':'plain'}"><div class="kpi-label">Faltantes</div><div class="kpi-val ${k.faltantes?'amber':''}">${k.faltantes||0}</div><div class="kpi-sub">máquinas no informadas</div></div>
      <div class="kpi plain"><div class="kpi-label">Sin inventario</div><div class="kpi-val">${k.sin_inventario||0}</div><div class="kpi-sub">objetivos que nunca censaron</div></div>
    </div>
    <div class="tablewrap">
      <table><thead><tr><th>Objetivo</th><th>Tipo</th><th class="num">Oficial</th><th class="num">Censo</th><th>Dif</th><th>Números</th><th style="width:120px"></th></tr></thead>
      <tbody>${d.filas.length?d.filas.map(f=>f.huerfano?`<tr style="background:var(--papel)">
        <td style="font-weight:500">${f.objetivo}</td>
        <td>${f.tipo_equipo} <span class="badge b-blue" style="font-size:9.5px">nuevo</span></td>
        <td class="num sub">—</td>
        <td class="num">${f.censo}</td>
        <td><span class="badge b-blue">sin inventario</span></td>
        <td class="mono" style="font-size:11px;color:var(--tinta-3)">—</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn-salir" style="padding:4px 9px;font-size:11.5px;color:var(--brote-2)" onclick="incorporarInv('${f.objetivo_id}','${String(f.tipo_equipo).replace(/'/g,"\\'")}',${f.censo})">+ Agregar</button>
        </td></tr>`:`<tr>
        <td style="font-weight:500">${f.objetivo}</td>
        <td>${f.tipo_equipo}</td>
        <td class="num">${f.cantidad}</td>
        <td class="num">${f.censo!=null?f.censo:'—'}</td>
        <td>${difStk(f.dif)}</td>
        <td class="mono" style="font-size:11px;color:var(--tinta-3)">${(f.numeros||[]).join(', ')||'—'}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn-salir" style="padding:4px 9px;font-size:11.5px" onclick="editarInv(${f.id})">Editar</button>
          <button class="btn-salir" style="padding:4px 8px;font-size:11.5px;color:var(--rojo)" onclick="borrarInv(${f.id})" title="Borrar línea">✕</button>
        </td></tr>`).join('')
        :'<tr><td colspan="7"><div class="sub" style="padding:14px">Todavía no hay inventario. Se siembra solo con el primer censo de cada objetivo, o tocá "Sembrar desde el censo".</div></td></tr>'}</tbody></table>
    </div>
    <div class="sub" style="margin-top:10px">🌱 El primer censo de cada objetivo siembra su inventario. Después el censo solo compara: para cambiar el oficial, editalo acá.</div>`;
  }catch(e){view.innerHTML=tabsStk()+`<div class="cargando-v">No pude cargar el inventario. ${e.message||''}</div>`;}
}
async function sembrarInv(){
  if(!confirm('Se crean las líneas de inventario que falten, tomando lo que informaron los capataces en este período.\nNo se pisa nada de lo que ya está cargado. ¿Dale?'))return;
  try{
    const r=await api('/api/stock/inventario/sembrar',{method:'POST',
      body:JSON.stringify({periodo:stockInv?stockInv.periodo:''})});
    alert(r.creadas?`Líneas creadas: ${r.creadas}`:'No había nada nuevo para sembrar.');
    go('stock');
  }catch(e){alert('No pude sembrar: '+(e.message||''));}
}
async function incorporarInv(objetivoId,tipo,cantidad){
  if(!confirm(`Agregar "${tipo}" ×${cantidad} al inventario oficial de este objetivo?\nDespués podés editar la cantidad y los números.`))return;
  try{
    await api('/api/stock/inventario',{method:'POST',
      body:JSON.stringify({objetivo_id:objetivoId,tipo_equipo:tipo,cantidad,numeros:[]})});
    go('stock');
  }catch(e){alert('No pude agregar: '+(e.message||''));}
}
function editarInv(id){
  const f=(stockInv.filas||[]).find(x=>x.id===id);if(!f)return;
  stockInvEdit=f;
  abrirModalInv(f,stockInv.periodo);
}
function abrirModalInv(f,periodo){
  document.getElementById('mm-titulo').textContent='Inventario · '+(f.objetivo||'');
  document.getElementById('mm-campos').innerHTML=`
    <div class="mm-field"><label>Tipo de equipo</label><input value="${f.tipo_equipo}" disabled></div>
    <div class="mm-field"><label>Cantidad oficial</label><input id="inv-cant" type="number" min="0" value="${f.cantidad}"></div>
    <div class="mm-field"><label>Números de máquina</label><input id="inv-nums" value="${(f.numeros||[]).join(', ')}" placeholder="12, 15, 21"></div>
    <div class="mm-field"><label>Observación</label><input id="inv-obs" value="${(f.observacion||'').replace(/"/g,'&quot;')}" placeholder="opcional"></div>
    ${f.censo!=null?`<div class="sub">El capataz informó <b>${f.censo}</b> en ${mesStk(periodo)}.</div>`:''}
    <div class="modal-acciones">
      <button class="btn-salir" onclick="cerrarMaestro()">Cancelar</button>
      <button class="btn" onclick="guardarInv()">Guardar</button>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
}
async function guardarInv(){
  if(!stockInvEdit)return;
  const body={
    cantidad:document.getElementById('inv-cant').value,
    numeros:document.getElementById('inv-nums').value,
    observacion:document.getElementById('inv-obs').value.trim()||null,
  };
  try{
    await api('/api/stock/inventario/'+stockInvEdit.id,{method:'POST',body:JSON.stringify(body)});
    cerrarMaestro();stockInvEdit=null;go('stock');
  }catch(e){alert('No pude guardar: '+(e.message||''));}
}
async function borrarInv(id){
  if(!confirm('¿Borrar esta línea del inventario oficial?'))return;
  try{await api('/api/stock/inventario/'+id,{method:'DELETE'});go('stock');}
  catch(e){alert('No pude borrar: '+(e.message||''));}
}

/* ── Solapa Consolidado: toda la maquinaria de la empresa por tipo ── */
async function vStockConsolidado(view){
  try{
    const per=stockPeriodo||'';
    const d=await api('/api/stock/consolidado'+(per?'?periodo='+encodeURIComponent(per):''));
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Stock de maquinaria</div>
      <div class="view-desc">Toda la maquinaria de EcoService, sumada por tipo · censo de ${mesStk(d.periodo)}</div></div></div>
    ${tabsStk()}
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Total oficial</div><div class="kpi-val">${d.total_oficial||0}</div><div class="kpi-sub">máquinas en inventario</div></div>
      <div class="kpi plain"><div class="kpi-label">Total informado</div><div class="kpi-val">${d.total_informado||0}</div><div class="kpi-sub">lo que censaron los capataces</div></div>
      <div class="kpi ${d.total_informado-d.total_oficial?'':'plain'}"><div class="kpi-label">Diferencia</div><div class="kpi-val ${d.total_informado<d.total_oficial?'amber':''}">${d.total_informado-d.total_oficial>0?'+':''}${d.total_informado-d.total_oficial}</div><div class="kpi-sub">informado − oficial</div></div>
    </div>
    <div class="tablewrap">
      <table><thead><tr><th>Tipo de equipo</th><th class="num">Oficial</th><th class="num">Informado</th><th>Dif</th><th class="num">Objetivos</th></tr></thead>
      <tbody>${d.filas.length?d.filas.map(f=>`<tr>
        <td style="font-weight:500">${f.tipo_equipo}</td>
        <td class="num">${f.oficial}</td><td class="num">${f.informado}</td>
        <td>${difStk(f.dif)}</td>
        <td class="num sub">${f.objetivos}</td></tr>`).join('')
        :'<tr><td colspan="5"><div class="sub" style="padding:14px">Sin datos todavía.</div></td></tr>'}</tbody></table>
    </div>`;
  }catch(e){view.innerHTML=tabsStk()+`<div class="cargando-v">No pude armar el consolidado. ${e.message||''}</div>`;}
}

/* ── Solapa Censo (la original) ── */
async function vStockCenso(view){
  try{
    const qs=stockPeriodo?'?periodo='+encodeURIComponent(stockPeriodo):'';
    stockData=await api('/api/stock'+qs);
    const d=stockData;stockSelId=null;
    const resp=d.censos.filter(c=>c.estado==='respondido');
    const pend=d.censos.filter(c=>c.estado!=='respondido');
    const eqTotal=resp.reduce((s,c)=>s+(c.censos_stock_items||[]).reduce((x,i)=>x+(i.cantidad||0),0),0);
    const tipos=new Set();resp.forEach(c=>(c.censos_stock_items||[]).forEach(i=>tipos.add(i.tipo_equipo)));
    const pct=d.censos.length?Math.round(resp.length*100/d.censos.length):null;
    const sel=`<select class="busca" style="width:auto" onchange="stockPeriodo=this.value;go('stock')">
      ${d.periodos.map(p=>`<option value="${p}" ${p===d.periodo?'selected':''}>${mesStk(p)}</option>`).join('')}</select>`;
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Stock de maquinaria</div>
      <div class="view-desc">Censo por objetivo · los capataces responden por WhatsApp con la palabra <b>stock</b></div></div>
      <div style="display:flex;gap:8px;align-items:center">${sel}
      <button class="btn" onclick="pedirStock()">📤 Pedir stock</button></div></div>
    ${tabsStk()}
    ${d.censos.length?'':'<div class="aviso-amarillo">Todavía no hay censos en este período. Tocá "Pedir stock" para mandarle el pedido por WhatsApp a los capataces.</div>'}
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Respondieron</div><div class="kpi-val green">${resp.length}</div><div class="kpi-sub">de ${d.censos.length} objetivos${pct!=null?' · '+pct+'%':''}</div></div>
      <div class="kpi ${pend.length?'':'plain'}"><div class="kpi-label">Pendientes</div><div class="kpi-val ${pend.length?'amber':''}">${pend.length}</div><div class="kpi-sub">sin respuesta del capataz</div></div>
      <div class="kpi plain"><div class="kpi-label">Equipos informados</div><div class="kpi-val">${eqTotal}</div><div class="kpi-sub">${tipos.size} tipos distintos</div></div>
    </div>
    <div class="split">
      <div class="tablewrap">
        <table><thead><tr><th>Objetivo</th><th>Capataz</th><th class="num">Equipos</th><th>Respondió</th><th>Estado</th><th style="width:100px"></th></tr></thead>
        <tbody id="stk-list">${d.censos.length?d.censos.map(c=>{
          const eq=(c.censos_stock_items||[]).reduce((s,i)=>s+(i.cantidad||0),0);
          return `<tr onclick="selCenso('${c.id}')" data-id="${c.id}" style="cursor:pointer">
            <td style="font-weight:500">${c.objetivos?c.objetivos.nombre:'—'}</td>
            <td>${c.capataces?c.capataces.nombre:'—'}</td>
            <td class="num">${eq||'—'}</td>
            <td class="mono" style="font-size:12px">${horaStk(c.respondido_at)||'—'}</td>
            <td>${c.estado==='respondido'?'<span class="badge b-green">respondido</span>':'<span class="badge b-red">pendiente</span>'}</td>
            <td style="text-align:right">${c.estado!=='respondido'?`<button class="btn-salir" style="padding:4px 9px;font-size:11.5px" onclick="event.stopPropagation();reenviarStock('${c.id}')">↻ Reenviar</button>`:''}</td></tr>`;}).join('')
          :'<tr><td colspan="6"><div class="sub" style="padding:14px">Sin censos en este período.</div></td></tr>'}</tbody></table>
      </div>
      <div class="side" id="stk-side"><div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7h16M4 7l2-3h12l2 3M4 7v13h16V7"/><path d="M9 11h6M9 15h6"/></svg><div>Elegí un objetivo<br>para ver el stock informado</div></div></div>
    </div>`;
  }catch(e){view.innerHTML=`<div class="cargando-v">No pude cargar el stock. ${e.message||''}</div>`;}
}
function selCenso(id){
  const d=stockData;if(!d)return;
  const c=d.censos.find(x=>String(x.id)===String(id));if(!c)return;
  stockSelId=String(id);
  document.querySelectorAll('#stk-list tr').forEach(t=>t.style.outline=(t.dataset.id===stockSelId)?'2px solid var(--brote)':'none');
  const items=c.censos_stock_items||[];
  document.getElementById('stk-side').innerHTML=`
    <div class="side-id">STOCK · objetivo</div>
    <div class="side-title">${c.objetivos?c.objetivos.nombre:'—'}</div>
    <div class="side-meta">${c.capataces?'Capataz '+c.capataces.nombre:'Capataz sin asignar'}${c.respondido_at?' · respondió '+horaStk(c.respondido_at):''}</div>
    <div class="divider"></div>
    ${c.estado!=='respondido'
      ?`<div class="aviso-amarillo" style="margin:0 0 10px">Sin respuesta todavía. El pedido se mandó por WhatsApp${c.reenviado_at?' (último reenvío '+horaStk(c.reenviado_at)+')':''}.</div>
        <button class="btn" style="width:100%" onclick="reenviarStock('${c.id}')">↻ Reenviar pedido</button>`
      :items.length?items.map(i=>`
        <div class="queue-item" style="margin-bottom:8px">
          <div style="flex:1"><div style="font-weight:600;font-size:12.5px">${i.tipo_equipo}</div>
          <div class="sub mono" style="font-size:11px">${i.numeros&&i.numeros.length?'N° '+i.numeros.join(', '):'sin números'}${i.observacion?' · '+i.observacion:''}</div></div>
          <div class="mono" style="font-size:15px;font-weight:600">${i.cantidad}</div>
        </div>`).join('')
      :'<div class="sub" style="padding:8px 0">Respondió sin equipos.</div>'}
    <div class="divider"></div>
    <div class="panel-title" style="margin-bottom:10px">Histórico</div>
    <div id="stk-hist"><div class="sub">Cargando…</div></div>`;
  cargarHistorico(c.objetivo_id);
}
async function cargarHistorico(objetivoId){
  const cont=document.getElementById('stk-hist');
  if(!cont)return;
  try{
    const h=await api('/api/stock/historico/'+objetivoId);
    const c2=document.getElementById('stk-hist');if(!c2)return;
    c2.innerHTML=h.length?h.map(p=>`
      <div class="queue-item" style="margin-bottom:6px">
        <div style="flex:1"><div style="font-weight:600;font-size:12px">${mesStk(p.periodo)}</div>
        <div class="sub" style="font-size:11px">${p.items.map(i=>i.tipo_equipo+' ×'+i.cantidad).join(' · ')||'sin equipos'}</div></div>
        <div class="mono" style="font-size:13px">${p.total}</div>
      </div>`).join('')
      :'<div class="sub" style="padding:4px 0">Sin censos anteriores.</div>';
  }catch(e){
    const c2=document.getElementById('stk-hist');
    if(c2)c2.innerHTML='<div class="sub">No pude cargar el histórico.</div>';
  }
}
// Modal de selección: mostrar exactamente a quién se le va a mandar antes de disparar.
function pedirStock(){
  const d=stockData;if(!d)return;
  const cand=(d.candidatos||[]).filter(c=>c.estado!=='respondido');
  const yaResp=(d.candidatos||[]).filter(c=>c.estado==='respondido').length;
  const enviables=cand.filter(c=>!c.sin_capataz);
  if(!enviables.length){
    alert('No hay objetivos operativos a los que pedirles stock.\n'+
      (yaResp?yaResp+' ya respondieron.\n':'')+
      (cand.length?cand.length+' no tienen capataz con teléfono cargado.':'Revisá Maestros → Objetivos: solo se les pide a los de tipo "operativo".'));
    return;
  }
  stockPedirSel=new Set(enviables.map(c=>c.id)); // por defecto todos los enviables
  const filas=cand.map(c=>`<label class="mm-hab" style="padding:7px 0;border-bottom:1px solid var(--linea);display:flex;align-items:center;gap:9px">
    <input type="checkbox" value="${c.id}" ${c.sin_capataz?'disabled':'checked'} onchange="stockTogglePedir('${c.id}',this.checked)" style="accent-color:var(--brote)">
    <span style="flex:1"><b style="font-weight:600">${c.nombre}</b>
      <span class="sub" style="display:block;font-size:11px">${c.sin_capataz?'⚠ sin capataz con teléfono':c.capataces.join(', ')}${c.estado==='pendiente'?' · ya se le pidió':''}</span></span>
  </label>`).join('');
  document.getElementById('mm-titulo').textContent='Pedir stock · '+mesStk(d.periodo);
  document.getElementById('mm-campos').innerHTML=`
    <div class="sub" style="margin-bottom:10px">Se manda un WhatsApp a los capataces de los objetivos tildados. ${yaResp?'<b>'+yaResp+'</b> ya respondieron y no aparecen.':''}</div>
    <div style="max-height:320px;overflow:auto">${filas}</div>
    <div class="sub" id="stk-pedir-cnt" style="margin-top:10px"></div>
    <div class="modal-acciones">
      <button class="btn-salir" onclick="cerrarMaestro()">Cancelar</button>
      <button class="btn" id="stk-pedir-btn" onclick="confirmarPedirStock()">Enviar</button>
    </div>`;
  document.getElementById('mm-bg').classList.add('abierto');
  document.getElementById('mm-acciones').style.display='none'; // el modal de stock trae sus propios botones
  stockPedirCnt();
}
function stockTogglePedir(id,on){on?stockPedirSel.add(id):stockPedirSel.delete(id);stockPedirCnt();}
function stockPedirCnt(){
  const c=document.getElementById('stk-pedir-cnt');
  if(c)c.textContent=stockPedirSel.size+' objetivo'+(stockPedirSel.size===1?'':'s')+' seleccionado'+(stockPedirSel.size===1?'':'s');
}
async function confirmarPedirStock(){
  if(!stockPedirSel.size){alert('No seleccionaste ningún objetivo.');return;}
  const btn=document.getElementById('stk-pedir-btn');
  if(btn){btn.disabled=true;btn.textContent='Enviando…';}
  try{
    const r=await api('/api/stock/pedir',{method:'POST',
      body:JSON.stringify({periodo:stockData.periodo,objetivo_ids:[...stockPedirSel]})});
    cerrarMaestro();
    alert(`Pedidos enviados: ${r.enviados}`+(r.fallidos?`\n⚠ Fallaron: ${r.fallidos} (revisá Twilio)`:'')+(r.sin_capataz?`\nSin capataz con teléfono: ${r.sin_capataz}`:''));
    go('stock');
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='Enviar';}
    alert('No se pudo pedir el stock: '+(e.message||''));
  }
}
async function reenviarStock(id){
  if(!confirm('¿Reenviar el pedido de stock a los capataces de este objetivo?'))return;
  try{
    const r=await api('/api/stock/reenviar/'+id,{method:'POST'});
    alert(r.enviados?'Pedido reenviado.':'No se pudo enviar (¿capataz sin teléfono o ya respondió?).');
    go('stock');
  }catch(e){alert('No se pudo reenviar: '+(e.message||''));}
}

/* ===== Reparaciones ===== */
/* ===== Reparaciones · Indicadores ===== */
let repTab='resumen', repIndPer='';

// Barras genéricas para paneles de indicadores
function barsGen(lista,color,fmt){
  fmt=fmt||(v=>v);
  return lista.slice(0,10).map(x=>{
    const w=lista[0].valor?Math.max(2,Math.round(x.valor*100/lista[0].valor)):0;
    return `<div style="margin-bottom:9px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
        <b style="font-weight:600">${String(x.nombre).length>42?String(x.nombre).slice(0,42)+'…':x.nombre}</b>
        <span class="mono">${fmt(x.valor)}</span></div>
      <div style="height:5px;background:var(--papel);border-radius:3px"><div style="height:5px;width:${w}%;background:${color};border-radius:3px"></div></div>
    </div>`;}).join('')||'<div class="sub" style="padding:10px 0">Sin datos</div>';
}
function mesDe(iso){return String(iso||'').slice(0,7)||'sin fecha';}
function diasEntre(a,b){if(!a||!b)return null;const d=(new Date(b)-new Date(a))/86400000;return d>=0?d:null;}

function tabsRep(){return `<div class="toggle-imp" style="margin-bottom:16px">
  <button class="${repTab==='resumen'?'on':''}" onclick="repTab='resumen';go('reparaciones')">Resumen</button>
  <button class="${repTab==='services'?'on':''}" onclick="repTab='services';go('reparaciones')">Services</button>
  <button class="${repTab==='preventivo'?'on':''}" onclick="repTab='preventivo';go('reparaciones')">Preventivo</button>
  <button class="${repTab==='indicadores'?'on':''}" onclick="repTab='indicadores';go('reparaciones')">Indicadores</button>
</div>`;}

/* ── Reparaciones · Services (planillas cargadas por foto desde la app) ── */
let svPanelData=null, svPanelSel=null;
async function vRepServices(view){
  view.innerHTML=tabsRep()+'<div class="cargando-v">Cargando…</div>';
  try{
    svPanelData=await api('/api/services');
    const svs=svPanelData||[];
    // Agrupar por unidad (código interno o patente) para el resumen
    const porUni={};
    svs.forEach(s=>{const d=s.data||{};const k=d.unidad||d.patente||'—';(porUni[k]=porUni[k]||[]).push(s);});
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Reparaciones · Services</div>
      <div class="view-desc">Planillas de service cargadas por los mecánicos desde la app (foto + IA)</div></div></div>
    ${tabsRep()}
    <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
      <div class="kpi"><div class="kpi-label">Services cargados</div><div class="kpi-val">${svs.length}</div><div class="kpi-sub">total</div></div>
      <div class="kpi plain"><div class="kpi-label">Unidades con service</div><div class="kpi-val">${Object.keys(porUni).length}</div><div class="kpi-sub">distintas</div></div>
      <div class="kpi plain"><div class="kpi-label">Último service</div><div class="kpi-val" style="font-size:16px">${svs[0]?fechaAR((svs[0].data||{}).fecha_service)||fechaAR(svs[0].created_at):'—'}</div><div class="kpi-sub">${svs[0]?((svs[0].data||{}).unidad||''):''}</div></div>
    </div>
    <div class="split">
      <div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Unidad / Patente</th><th>Km/Hs service</th><th>Próximo service</th><th>Mecánico</th></tr></thead>
      <tbody>${svs.length?svs.map(s=>{const d=s.data||{};return `<tr onclick="selSvPanel('${s.id}',this)" style="cursor:pointer;${svPanelSel===s.id?'outline:2px solid var(--brote)':''}">
        <td class="mono">${fechaAR(d.fecha_service)||fechaAR(s.created_at)}</td>
        <td style="font-weight:600">${d.unidad||d.patente||'—'}${d.patente&&d.unidad?`<div class="sub mono">${d.patente}</div>`:''}</td>
        <td class="mono">${d.km_horas||'—'}</td>
        <td class="mono">${d.proximo_service||'—'}</td>
        <td>${s.mecanico_nombre||d.mecanico||'—'}</td>
      </tr>`;}).join(''):'<tr><td colspan="5"><div class="sub" style="padding:14px">Todavía no hay services cargados. Se cargan desde la app del mecánico (pestaña Service).</div></td></tr>'}</tbody></table></div>
      <div class="side" id="sv-side"><div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg><div>Elegí un service<br>para ver el detalle</div></div></div>
    </div>`;
    if(svPanelSel)pintarSvSide();
  }catch(e){view.innerHTML=tabsRep()+`<div class="cargando-v">No pude cargar los services. ${e.message||''}</div>`;}
}
// PDF del pedido de repuestos de un service (para mandarle al proveedor):
// solo los repuestos, con marca, cantidad y código. Mismo estilo que los
// reportes de Estado de cuenta.
function exportarSvRepuestosPDF(id){
  const s=(svPanelData||[]).find(x=>x.id===id);if(!s)return;
  const d=s.data||{};
  const reps=(d.repuestos_entregados||[]).filter(r=>r.repuesto);
  if(!reps.length){alert('Este service no tiene repuestos cargados.');return;}
  const filas=reps.map(r=>`<tr>
    <td style="font-weight:600">${r.repuesto||'—'}</td>
    <td>${r.marca||'—'}</td>
    <td class="r">${r.cantidad||1}</td>
    <td style="font-family:monospace;font-weight:600">${r.codigo||'—'}</td>
    <td>${r.observaciones||''}</td>
  </tr>`).join('');
  const w=window.open('','_blank');
  if(!w){alert('El navegador bloqueó la ventana del reporte. Habilitá popups para este sitio.');return;}
  w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Pedido de repuestos — ${d.unidad||d.patente||''}</title>${ctaEstiloReporte()}</head><body>
  <div class="letterhead"><div><h1>Pedido de repuestos</h1><div class="sub">EcoService · Logística</div></div>
    <div class="fecha">${new Date().toLocaleString('es-AR',{timeZone:'America/Argentina/Cordoba'})}</div></div>
  <div class="body-pad">
  <div class="kpis" style="margin-top:6px">
    <div class="kpi"><span>Unidad</span><b>${d.unidad||d.patente||'—'}</b></div>
    <div class="kpi"><span>Marca / modelo</span><b>${d.marca_modelo||'—'}</b></div>
    <div class="kpi"><span>Service del</span><b>${fechaAR(d.fecha_service)||'—'}</b></div>
    <div class="kpi"><span>Km / Horas</span><b>${d.km_horas||'—'}</b></div>
  </div>
  <h2>Repuestos solicitados</h2>
  <table><thead><tr><th>Repuesto</th><th>Marca</th><th class="r">Cantidad</th><th>Código</th><th>Observaciones</th></tr></thead>
  <tbody>${filas}</tbody></table>
  <p style="margin-top:22px;font-size:10.5px;color:#777">Solicitado según planilla de service cargada por ${s.mecanico_nombre||d.mecanico||'—'}.</p>
  </div>
  <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script>
  </body></html>`);
  w.document.close();
}
function selSvPanel(id,tr){
  svPanelSel=id;
  document.querySelectorAll('#view .tablewrap tr').forEach(t=>t.style.outline='');
  if(tr)tr.style.outline='2px solid var(--brote)';
  pintarSvSide();
}
function pintarSvSide(){
  const cont=document.getElementById('sv-side');if(!cont)return;
  const s=(svPanelData||[]).find(x=>x.id===svPanelSel);if(!s)return;
  const d=s.data||{};
  cont.innerHTML=`
    <div class="side-id">SERVICE</div>
    <div class="side-title">${d.unidad||d.patente||'—'} ${d.marca_modelo?'· '+d.marca_modelo:''}</div>
    <div class="side-meta">${fechaAR(d.fecha_service)||fechaAR(s.created_at)}${d.tipo_unidad?' · '+d.tipo_unidad:''} · ${s.mecanico_nombre||d.mecanico||'—'}${d.editado_por?' · ✎ editado por '+d.editado_por+(d.editado_at?' ('+fechaAR(d.editado_at)+')':''):''}</div>
    ${d.patente?`<div class="sub mono" style="margin-top:4px">Patente: ${d.patente}</div>`:''}
    <div style="display:flex;gap:10px;margin:12px 0">
      <div class="extract-field" style="flex:1"><label>Km/Hs del service</label><div class="val filled">${d.km_horas||'—'}</div></div>
      <div class="extract-field" style="flex:1"><label>Próximo service</label><div class="val ${d.proximo_service?'filled':''}">${d.proximo_service||'sin definir'}</div></div>
    </div>
    <button class="btn ghost" style="width:100%;justify-content:center;margin-bottom:12px" onclick="exportarSvRepuestosPDF('${s.id}')">⬇ Pedido de repuestos (PDF)</button>
    <div class="divider"></div>
    <div class="panel-title" style="margin-bottom:8px">Tareas realizadas</div>
    ${(d.tareas||[]).length?(d.tareas||[]).map(t=>`<div class="queue-item">
      <div style="flex:1"><div style="font-weight:600;font-size:12.5px">${t.tarea||'—'}</div>
      ${t.repuestos?`<div class="sub" style="font-size:11px">${t.repuestos}</div>`:''}</div>
      <span class="badge ${t.estado==='seguimiento'?'b-amber':'b-green'}">${t.estado==='seguimiento'?'Seguimiento':'OK'}</span>
    </div>`).join(''):'<div class="sub">Sin tareas registradas.</div>'}
    <div class="panel-title" style="margin:12px 0 8px">Repuestos entregados</div>
    ${(d.repuestos_entregados||[]).length?(d.repuestos_entregados||[]).map(r=>`<div class="queue-item">
      <div style="flex:1"><div style="font-weight:600;font-size:12.5px">${r.repuesto||'—'}${r.marca?' · '+r.marca:''}</div>
      ${r.codigo?`<div class="sub mono" style="font-size:11px">${r.codigo}</div>`:''}</div>
      <div class="mono" style="font-size:12px">x${r.cantidad||1}</div>
    </div>`).join(''):'<div class="sub">Sin repuestos registrados.</div>'}
    ${d.observaciones?`<div class="panel-title" style="margin:12px 0 6px">Observaciones</div><div class="sub">${d.observaciones}</div>`:''}`;
}

// Indicadores del taller: miden el servicio sobre toda la maquinaria,
// separando correctivo de preventivo y mostrando dónde se traba el flujo.
async function vRepInd(view){
  const todas=repData||[];
  const meses=[...new Set(todas.map(r=>mesDe(r.created_at)))].filter(m=>m!=='sin fecha').sort().reverse();
  const fs=repIndPer?todas.filter(r=>mesDe(r.created_at)===repIndPer):todas;
  const normU=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const esPrev=r=>r.tipo_mant==='preventivo';
  const activas=fs.filter(r=>r.estado!=='finalizado');
  const finalizadas=fs.filter(r=>r.estado==='finalizado');
  const finPrev=finalizadas.filter(esPrev), finCorr=finalizadas.filter(r=>!esPrev(r));
  const criticasAltas=activas.filter(r=>r.prioridad==='critico'||r.prioridad==='alta').length;

  // Resolución promedio (creada → finalizada)
  const tiempos=finalizadas.map(r=>diasEntre(r.created_at,r.fecha_finalizado)).filter(t=>t!=null);
  const tProm=tiempos.length?tiempos.reduce((s,t)=>s+t,0)/tiempos.length:null;

  // % preventivo del período (sobre finalizadas)
  const pctPrev=finalizadas.length?Math.round(finPrev.length*100/finalizadas.length):null;

  // Cumplimiento preventivo hoy (pestaña Preventivo); si el SQL no corrió, se omite
  let cumpl=null,cumplSub='rodados al día';
  try{
    const pv=await api('/api/reparaciones/preventivo');
    const conInt=(pv.rodados||[]).filter(r=>r.intervalo);
    const alDia=conInt.filter(r=>r.estado==='al_dia'||r.estado==='por_vencer').length;
    if(conInt.length){cumpl=Math.round(alDia*100/conInt.length);cumplSub=alDia+' de '+conInt.length+' rodados sin vencer';}
  }catch(e){}

  // Reincidencia: correctivo sobre la misma unidad dentro de los 30 días de una finalización
  const finConUni=finalizadas.filter(r=>r.fecha_finalizado&&normU(r.numero_unidad));
  let reinc=0;
  finConUni.forEach(f=>{
    const k=normU(f.numero_unidad),ff=new Date(f.fecha_finalizado).getTime();
    if(todas.some(o=>o.id!==f.id&&!esPrev(o)&&normU(o.numero_unidad)===k&&(()=>{const c=new Date(o.created_at).getTime();return c>ff&&c-ff<=30*86400000;})()))reinc++;
  });
  const pctReinc=finConUni.length?Math.round(reinc*100/finConUni.length):null;

  // Espera de repuestos: promedio histórico + cuántas esperan ahora
  const esperas=fs.map(r=>diasEntre(r.fecha_espera_repuestos,r.fecha_en_reparacion||r.fecha_finalizado)).filter(t=>t!=null);
  const espProm=esperas.length?esperas.reduce((s,t)=>s+t,0)/esperas.length:null;
  const espAhora=activas.filter(r=>r.estado==='esperando_repuestos').length;

  // Correctivo vs preventivo por mes (sobre todas, no solo el filtro)
  const porMes={};
  todas.forEach(r=>{
    const mN=mesDe(r.created_at);porMes[mN]=porMes[mN]||{c:0,p:0,fin:0};
    esPrev(r)?porMes[mN].p++:porMes[mN].c++;
    if(r.estado==='finalizado'&&r.fecha_finalizado){const mF=mesDe(r.fecha_finalizado);
      porMes[mF]=porMes[mF]||{c:0,p:0,fin:0};porMes[mF].fin++;}
  });
  const evol=Object.entries(porMes).filter(([m])=>m!=='sin fecha').sort((a,b)=>b[0].localeCompare(a[0])).slice(0,8);
  const tablaEvol=evol.map(([m,v])=>{
    const tot=v.c+v.p,pp=tot?Math.round(v.p*100/tot):0,bal=v.fin-tot;
    return `<tr><td class="mono">${m}</td><td class="num">${v.c}</td><td class="num">${v.p}</td>
      <td class="num" style="color:${pp>=25?'var(--brote-2)':'var(--tinta-2)'}">${pp}%</td>
      <td class="num">${v.fin}</td>
      <td class="num" style="${bal<0?'color:var(--rojo)':'color:var(--brote-2)'}">${bal>0?'+':''}${bal}</td></tr>`;}).join('');

  // Unidades problemáticas: más correctivos en el período (con cuántas veces entró parada)
  const porUni={};
  fs.filter(r=>!esPrev(r)&&normU(r.numero_unidad)).forEach(r=>{
    const k=normU(r.numero_unidad);
    porUni[k]=porUni[k]||{eq:r.tipo_equipo||(r.equipos?r.equipos.nombre:'—'),uni:r.numero_unidad,n:0,paradas:0};
    porUni[k].n++;if(r.equipo_parado)porUni[k].paradas++;
  });
  const topUni=Object.values(porUni).sort((a,b)=>b.n-a.n).slice(0,8);
  const tablaUni=topUni.map((u,i)=>`<tr>
      <td class="sub mono" style="width:24px">${i+1}</td>
      <td><div style="font-weight:500">${u.eq}</div></td>
      <td><span class="uni-num">${u.uni}</span></td>
      <td class="num" style="font-weight:600;${u.n>=3?'color:#A32D2D':''}">${u.n}</td>
      <td class="num sub">${u.paradas||'—'}</td></tr>`).join('');

  // Embudo: promedio de días en cada etapa (entre timestamps consecutivos disponibles)
  const etapa=(a,b)=>{const ts=fs.map(r=>diasEntre(r[a],r[b])).filter(t=>t!=null);
    return ts.length?{v:ts.reduce((s,t)=>s+t,0)/ts.length,n:ts.length}:null;};
  const emb=[
    ['Pendiente → Diagnóstico',etapa('created_at','fecha_diagnostico')],
    ['Diagnóstico → Esp. repuestos',etapa('fecha_diagnostico','fecha_espera_repuestos')],
    ['Esp. repuestos → En reparación',etapa('fecha_espera_repuestos','fecha_en_reparacion')],
    ['En reparación → Finalizado',etapa('fecha_en_reparacion','fecha_finalizado')],
  ];
  const maxEmb=Math.max(...emb.map(([,e])=>e?e.v:0),0.1);
  const htmlEmb=emb.some(([,e])=>e)?emb.map(([l,e])=>{
    if(!e)return `<div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><b style="font-weight:500">${l}</b><span class="sub">sin datos aún</span></div></div>`;
    const w=Math.max(3,Math.round(e.v*100/maxEmb));
    return `<div style="margin-bottom:9px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
        <b style="font-weight:500">${l}</b><span class="mono">${Math.round(e.v*10)/10} d <span class="sub">(${e.n})</span></span></div>
      <div style="height:6px;background:var(--papel);border-radius:3px"><div style="height:6px;width:${w}%;background:var(--azul);border-radius:3px"></div></div>
    </div>`;}).join('')
    :'<div class="sub" style="padding:10px 0">Las fechas por etapa se estampan en cada cambio de estado: este bloque se va llenando solo con el uso.</div>';

  // Por mecánico (con preventivas propias)
  const mecs={};
  fs.forEach(r=>{
    const k=r.mecanicos?r.mecanicos.nombre:'Sin asignar';
    mecs[k]=mecs[k]||{activas:0,finalizadas:0,prev:0,tiempos:[]};
    if(r.estado==='finalizado'){mecs[k].finalizadas++;if(esPrev(r))mecs[k].prev++;
      const t=diasEntre(r.created_at,r.fecha_finalizado);if(t!=null)mecs[k].tiempos.push(t);}
    else mecs[k].activas++;
  });
  const tablaMec=Object.entries(mecs).sort((a,b)=>(b[1].activas+b[1].finalizadas)-(a[1].activas+a[1].finalizadas))
    .map(([n,v])=>{const tp=v.tiempos.length?v.tiempos.reduce((s,t)=>s+t,0)/v.tiempos.length:null;
    return `<tr><td style="font-weight:500">${n}</td><td class="num">${v.activas}</td>
      <td class="num">${v.finalizadas}</td>
      <td class="num" style="${v.prev?'color:var(--brote-2);font-weight:600':''}">${v.prev||'—'}</td>
      <td class="num sub">${tp!=null?Math.round(tp*10)/10+' d':'—'}</td></tr>`;}).join('');

  view.innerHTML=`
  <div class="view-head"><div><div class="view-title">Reparaciones · Indicadores</div>
    <div class="view-desc">Servicio sobre toda la maquinaria: correctivo, preventivo y flujo del taller</div></div>
    <select class="busca" style="width:auto" onchange="repIndPer=this.value;go('reparaciones')">
      <option value="">Todo el período</option>
      ${meses.map(m=>`<option value="${m}" ${m===repIndPer?'selected':''}>${mesStk(m)}</option>`).join('')}
    </select></div>
  ${tabsRep()}
  <div class="kpis" style="grid-template-columns:repeat(6,1fr)">
    <div class="kpi ${activas.length?'amber':''}"><div class="kpi-label">Activas</div><div class="kpi-val ${activas.length?'amber':''}">${activas.length}</div><div class="kpi-sub">${criticasAltas} crítico + alta</div></div>
    <div class="kpi plain"><div class="kpi-label">Resolución prom.</div><div class="kpi-val">${tProm!=null?Math.round(tProm*10)/10:'—'}</div><div class="kpi-sub">días creada → finalizada</div></div>
    <div class="kpi plain"><div class="kpi-label">% Preventivo</div><div class="kpi-val" style="${pctPrev>=25?'color:var(--brote-2)':''}">${pctPrev!=null?pctPrev+'%':'—'}</div><div class="kpi-sub">${finPrev.length} de ${finalizadas.length} finalizadas</div></div>
    <div class="kpi plain"><div class="kpi-label">Cumplimiento prev.</div><div class="kpi-val" style="${cumpl!=null&&cumpl<70?'color:#A32D2D':cumpl!=null?'color:var(--brote-2)':''}">${cumpl!=null?cumpl+'%':'—'}</div><div class="kpi-sub">${cumplSub}</div></div>
    <div class="kpi plain"><div class="kpi-label">Reincidencia 30d</div><div class="kpi-val" style="${pctReinc>=20?'color:#A32D2D':''}">${pctReinc!=null?pctReinc+'%':'—'}</div><div class="kpi-sub">vuelven al taller en 30 días</div></div>
    <div class="kpi plain"><div class="kpi-label">Espera repuestos</div><div class="kpi-val">${espProm!=null?Math.round(espProm*10)/10:'—'}</div><div class="kpi-sub">días prom. · ${espAhora} esperando ahora</div></div>
  </div>
  <div class="grid g-2" style="margin-bottom:18px">
    <div class="panel"><div class="panel-title">Correctivo vs preventivo por mes</div>
      <table style="font-size:12px"><thead><tr><th>Período</th><th class="num">Corr.</th><th class="num">Prev.</th><th class="num">% Prev</th><th class="num">Finalizadas</th><th class="num">Balance</th></tr></thead>
      <tbody>${tablaEvol||'<tr><td colspan="6" class="sub" style="padding:10px">Sin datos</td></tr>'}</tbody></table>
    </div>
    <div class="panel"><div class="panel-title">Unidades problemáticas <span class="sub" style="font-weight:400;font-size:11px">· más correctivos en el período</span></div>
      <table style="font-size:12px"><thead><tr><th></th><th>Equipo</th><th>Unidad</th><th class="num">Correctivos</th><th class="num">Paradas</th></tr></thead>
      <tbody>${tablaUni||'<tr><td colspan="5" class="sub" style="padding:10px">Sin datos</td></tr>'}</tbody></table>
    </div>
  </div>
  <div class="grid g-2" style="margin-bottom:18px">
    <div class="panel"><div class="panel-title">Dónde se traba el taller <span class="sub" style="font-weight:400;font-size:11px">· días promedio por etapa</span></div>${htmlEmb}</div>
    <div class="panel"><div class="panel-title">Por mecánico</div>
      <table style="font-size:12px"><thead><tr><th>Mecánico</th><th class="num">Activas</th><th class="num">Finalizadas</th><th class="num">Prev.</th><th class="num">Resol. prom.</th></tr></thead>
      <tbody>${tablaMec||'<tr><td colspan="5" class="sub" style="padding:10px">Sin datos</td></tr>'}</tbody></table>
    </div>
  </div>
  <div class="grid g-2">
    <div class="panel"><div class="panel-title">Por tipo de equipo</div>${barsGen((l=>{const m={};l.forEach(r=>{const k=r.tipo_equipo||(r.equipos?(r.equipos.tipo||r.equipos.nombre):null)||'Sin asignar';m[k]=(m[k]||0)+1;});return Object.entries(m).map(([nombre,valor])=>({nombre,valor})).sort((a,b)=>b.valor-a.valor);})(fs),'var(--brote)')}</div>
    <div class="panel"><div class="panel-title">Por objetivo</div>${barsGen((l=>{const m={};l.forEach(r=>{const k=r.objetivos?r.objetivos.nombre:'Taller / sin objetivo';m[k]=(m[k]||0)+1;});return Object.entries(m).map(([nombre,valor])=>({nombre,valor})).sort((a,b)=>b.valor-a.valor);})(fs),'var(--diesel)')}</div>
  </div>`;
}

async function vReparaciones(view){
  repDetalleAbierto=false;
  try{
    repData=await api('/api/reparaciones');
    if(repTab==='services'){vRepServices(view);return;}
    if(repTab==='preventivo'){vRepPreventivo(view);return;}
    if(repTab==='indicadores'){vRepInd(view);return;}
    renderReparaciones(view);
  }catch(e){view.innerHTML=`<div class="cargando-v">No pude cargar las reparaciones.</div>`;}
}
/* ── Alta manual de incidencia desde el panel ── */
let repAltaOpen=false,repAltaTipo='correctivo',repObjs=null;
const REP_ALTA_EQUIPOS=['Motoguadaña','Sopladora','Extensible','Camioneta','Tractor','Mini tractor','Giro cero','Desmalezadora','Hidro grúa','Camión','Otro'];
const repAltaTmp={eq:'',uni:'',obj:'',mec:'',prio:'',desc:''};
function repAltaLeer(){['eq','uni','obj','mec','prio','desc'].forEach(k=>{const el=document.getElementById('ra-'+k);if(el)repAltaTmp[k]=el.value;});}
function repAltaToggle(){repAltaOpen=!repAltaOpen;renderReparaciones(document.getElementById('view'));
  if(repAltaOpen&&!repObjs)api('/api/maestros/objetivos').then(d=>{repObjs=(d||[]).filter(o=>o.activo!==false);renderReparaciones(document.getElementById('view'));}).catch(()=>{repObjs=[];});}
function repAltaSetTipo(t){repAltaLeer();repAltaTipo=t;repAltaTmp.prio='';renderReparaciones(document.getElementById('view'));}
function repAltaForm(){
  const co=repAltaTipo==='correctivo';
  const prioDef=repAltaTmp.prio||(co?'media':'baja');
  const inp='padding:8px 10px;border:1px solid var(--linea-2);border-radius:8px;font-size:13px;font-family:\'Sora\';background:#fff';
  return `<div class="card" style="padding:14px 16px;margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <b style="font-size:13.5px">Nueva incidencia ${co?'':' · preventiva'}</b>
      <div style="display:flex;gap:6px">
        <button class="mini-btn" style="${co?'background:var(--rojo-soft);color:#A32D2D;border-color:var(--rojo)':''}" onclick="repAltaSetTipo('correctivo')">🔧 Correctivo</button>
        <button class="mini-btn" style="${co?'':'background:var(--brote-soft);color:var(--brote-2);border-color:var(--brote)'}" onclick="repAltaSetTipo('preventivo')">🛡️ Preventivo</button>
      </div></div>
    <div style="display:grid;grid-template-columns:1.2fr .8fr 1.2fr 1.2fr .8fr;gap:10px;margin-bottom:10px">
      <label style="font-size:11px;color:var(--tinta-2)">Equipo<br><select id="ra-eq" style="${inp};width:100%;margin-top:4px">
        ${REP_ALTA_EQUIPOS.map(e=>`<option ${e===repAltaTmp.eq?'selected':''}>${e}</option>`).join('')}</select></label>
      <label style="font-size:11px;color:var(--tinta-2)">N° / patente<br><input id="ra-uni" value="${(repAltaTmp.uni||'').replace(/"/g,'&quot;')}" style="${inp};width:100%;margin-top:4px;font-family:'JetBrains Mono',monospace"></label>
      <label style="font-size:11px;color:var(--tinta-2)">Objetivo<br><select id="ra-obj" style="${inp};width:100%;margin-top:4px">
        <option value="">Taller / sin objetivo</option>
        ${(repObjs||[]).map(o=>`<option value="${o.id}" ${o.id===repAltaTmp.obj?'selected':''}>${o.nombre}</option>`).join('')}</select></label>
      <label style="font-size:11px;color:var(--tinta-2)">Mecánico<br><select id="ra-mec" style="${inp};width:100%;margin-top:4px">
        <option value="">Sin asignar</option>
        ${mecanicos.map(m=>`<option value="${m.id}" ${m.id===repAltaTmp.mec?'selected':''}>${m.nombre}</option>`).join('')}</select></label>
      <label style="font-size:11px;color:var(--tinta-2)">Prioridad<br><select id="ra-prio" style="${inp};width:100%;margin-top:4px">
        ${['critico','alta','media','baja'].map(p=>`<option value="${p}" ${p===prioDef?'selected':''}>${cap(p)}</option>`).join('')}</select></label>
    </div>
    <div style="display:flex;gap:10px;align-items:flex-end">
      <label style="font-size:11px;color:var(--tinta-2);flex:1">Descripción<br>
        <input id="ra-desc" value="${(repAltaTmp.desc||'').replace(/"/g,'&quot;')}" placeholder="${co?'Qué le pasa o por qué entra…':'Cambio de aceite, filtros, engrase…'}" style="${inp};width:100%;margin-top:4px"></label>
      <button class="btn" onclick="repAltaCrear(this)">Dar de alta</button>
      <button class="mini-btn" style="height:34px" onclick="repAltaOpen=false;renderReparaciones(document.getElementById('view'))">Cancelar</button>
    </div>
    ${co?'':'<div class="sub" style="margin-top:8px;color:var(--brote-2)">Al finalizarla se actualiza el último service de la unidad en la pestaña Preventivo.</div>'}
  </div>`;
}
async function repAltaCrear(btn){
  repAltaLeer();
  if(!repAltaTmp.uni.trim()){toast('Cargá el número de unidad o la patente','error');return;}
  btn.disabled=true;btn.textContent='Guardando…';
  try{
    await api('/api/reparaciones/nueva',{method:'POST',body:JSON.stringify({
      tipo_mant:repAltaTipo,tipo_equipo:repAltaTmp.eq||REP_ALTA_EQUIPOS[0],numero_unidad:repAltaTmp.uni.trim(),
      objetivo_id:repAltaTmp.obj||null,mecanico_id:repAltaTmp.mec||null,
      prioridad:repAltaTmp.prio,descripcion:repAltaTmp.desc.trim()})});
    toast('Incidencia creada');
    repAltaOpen=false;repAltaTmp.uni='';repAltaTmp.desc='';repAltaTipo='correctivo';repAltaTmp.prio='';
    refrescarContadores();go('reparaciones');
  }catch(e){toast(e.message,'error');btn.disabled=false;btn.textContent='Dar de alta';}
}

function renderReparaciones(view){
  const cnt=(campo,val)=>repData.filter(r=>r[campo]===val).length;
  // Por defecto ocultamos las finalizadas (solo activas). El filtro "Finalizadas" las muestra.
  const base = repFEstado==='finalizado' ? repData.filter(r=>r.estado==='finalizado')
             : repFEstado ? repData.filter(r=>r.estado===repFEstado)
             : repData.filter(r=>r.estado!=='finalizado');
  const filtrada=base.filter(r=>
    (!repFPrio||r.prioridad===repFPrio)&&
    (!repFMec||(repFMec==='__sin'?!r.mecanico_id:r.mecanico_id===repFMec)));
  const resumen={critico:cnt('prioridad','critico'),alta:cnt('prioridad','alta'),media:cnt('prioridad','media'),baja:cnt('prioridad','baja')};

  const activas=repData.filter(r=>r.estado!=='finalizado').length;
  const fEstado=[['','Activas',activas],...EST_REP.map(e=>[e,cap(e),cnt('estado',e)])]
    .map(([v,l,c])=>`<div class="frow ${repFEstado===v?'on':''}" onclick="repFEstado='${v}';renderReparaciones(document.getElementById('view'))"><span>${l}</span><span class="fc">${c}</span></div>`).join('');
  const fPrio=[['critico','Crítico','#DC4A5B'],['alta','Alta','#D98A1F'],['media','Media','#3B7DC4'],['baja','Baja','#159B51']]
    .map(([v,l,c])=>`<div class="frow ${repFPrio===v?'on':''}" onclick="repFPrio='${repFPrio===v?'':v}';renderReparaciones(document.getElementById('view'))"><span class="pdot" style="background:${c}"></span><span>${l}</span><span class="fc">${resumen[v]}</span></div>`).join('');
  const mecCount={}; repData.forEach(r=>{if(r.mecanico_id)mecCount[r.mecanico_id]=(mecCount[r.mecanico_id]||0)+1;});
  const fMec=[...mecanicos.map(m=>`<div class="frow ${repFMec===m.id?'on':''}" onclick="repFMec='${repFMec===m.id?'':m.id}';renderReparaciones(document.getElementById('view'))"><span>${m.nombre}</span><span class="fc">${mecCount[m.id]||0}</span></div>`).join(''),
    `<div class="frow ${repFMec==='__sin'?'on':''}" onclick="repFMec='${repFMec==='__sin'?'':'__sin'}';renderReparaciones(document.getElementById('view'))"><span>Sin asignar</span><span class="fc">${repData.filter(r=>!r.mecanico_id).length}</span></div>`].join('');

  const filas=filtrada.map((r,ix)=>{
    const idx=EST_REP.indexOf(r.estado);
    return `<tr onclick="selRep(${ix})" data-ix="${ix}">
      <td><span class="badge ${PRIO_BADGE[r.prioridad]||'b-gray'}">${cap(r.prioridad)}</span></td>
      <td><div style="font-weight:500">${r.equipos?r.equipos.nombre:(r.tipo_equipo||'—')}${r.tipo_mant==='preventivo'?' <span class="badge b-green" style="font-size:9.5px;padding:2px 7px;vertical-align:1px">PREV</span>':''}</div><div class="sub">${r.equipos&&r.equipos.codigo?r.equipos.codigo:''}</div></td>
      <td>${r.numero_unidad?'<span class="uni-num">'+r.numero_unidad+'</span>':'<span class="sub">—</span>'}</td>
      <td>${r.objetivos?r.objetivos.nombre:'—'}</td>
      <td>${r.capataces?r.capataces.nombre:'—'}</td>
      <td>${r.mecanicos?r.mecanicos.nombre:'<span class="sub">sin asignar</span>'}</td>
      <td><span class="badge ${idx>=0?'est-'+idx:'b-gray'}">${EST_REP_LABEL[idx]||r.estado}</span>${r.reclamada?'<div style="margin-top:4px"><span class="badge" style="background:var(--diesel-soft);color:#854F0B;font-size:10px">⏰ reclamada</span></div>':''}</td>
      <td class="mono sub">${hace(r.created_at)}</td></tr>`;}).join('');

  view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Reparaciones</div>
      <div class="view-desc">Incidencias reportadas por los capataces desde WhatsApp</div></div>
      <div class="spacer"></div>
      <div style="display:flex;gap:14px;font-size:12px;align-items:center" class="mono">
        <span style="color:#DC4A5B">● ${resumen.critico} crítico</span><span style="color:#D98A1F">● ${resumen.alta} alta</span>
        <span style="color:#3B7DC4">● ${resumen.media} media</span><span style="color:#159B51">● ${resumen.baja} baja</span>
        <button class="btn" style="font-family:'Sora'" onclick="repAltaToggle()">+ Nueva incidencia</button></div></div>
    ${tabsRep()}
    ${repAltaOpen?repAltaForm():''}
    <div class="repwrap">
      <div class="rep-filters">
        <div class="fgroup-t">Estado</div>${fEstado}
        <div class="fgroup-t">Prioridad</div>${fPrio}
        <div class="fgroup-t">Mecánico</div>${fMec}
      </div>
      <div class="tablewrap"><table><thead><tr><th>Prioridad</th><th>Equipo</th><th>Unidad</th><th>Objetivo</th><th>Capataz</th><th>Mecánico</th><th>Estado</th><th>Hace</th></tr></thead>
        <tbody id="rep-body">${filas||'<tr><td colspan="8"><div class="empty"><div>No hay incidencias con estos filtros.</div></div></td></tr>'}</tbody></table></div>
      <div class="side" id="rep-side"><div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 005.4-5.4l-2.8 2.8-2-2 2.8-2.8z"/></svg><div>Elegí una incidencia<br>para ver el detalle</div></div></div>
    </div>`;
  window._repFiltrada=filtrada;
}
let repDetalleAbierto=false;
async function cambiarTipoRep(id,tipo){
  try{
    await api('/api/reparaciones/'+id,{method:'POST',body:JSON.stringify({tipo_mant:tipo})});
    toast('Marcada como '+tipo);
    const r=(window._repFiltrada||[]).find(x=>x.id===id);if(r)r.tipo_mant=tipo;
    go('reparaciones');
  }catch(e){toast(e.message,'error');}
}
function selRep(ix){
  repDetalleAbierto=true;
  const r=window._repFiltrada[ix];
  document.querySelectorAll('#rep-body tr').forEach(t=>t.classList.toggle('sel',+t.dataset.ix===ix));
  const idx=EST_REP.indexOf(r.estado);
  const habs=(r.mecanicos&&r.mecanicos.habilidades||[]).map(h=>`<span class="hab ${HAB_COLOR[h]||'b-gray'}">${h.toUpperCase()}</span>`).join('');
  const coms=(r.comentarios_incidencias||[]).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  const comHTML=coms.length?coms.map(c=>`<div class="obs" style="margin-bottom:8px"><b>${c.mecanico_nombre||'Mecánico'}:</b> ${c.texto}<div class="sub mono" style="margin-top:4px">${new Date(c.created_at).toLocaleString('es-AR')}</div></div>`).join(''):'<div class="sub">Sin observaciones aún.</div>';
  const selMec=`<select class="reasign" id="rep-mec"><option value="">— sin asignar —</option>${mecanicos.map(m=>`<option value="${m.id}" ${r.mecanico_id===m.id?'selected':''}>${m.nombre}${m.habilidades?' — '+m.habilidades.join(', '):''}</option>`).join('')}</select>`;
  const btnAvanzar=idx<4?`<button class="btn" style="width:100%;justify-content:center;margin-top:14px" onclick="avanzarRep('${r.id}','${EST_REP[idx+1]}')">Avanzar a ${EST_REP_LABEL[idx+1]} →</button>`:'<div class="badge b-green" style="width:100%;justify-content:center;margin-top:14px;padding:9px">✓ Finalizado</div>';
  document.getElementById('rep-side').innerHTML=`
    <div class="side-id">INCIDENCIA${r.equipo_parado?' · EQUIPO PARADO':''}</div>
    <div class="side-title">${r.equipos?r.equipos.nombre:(r.tipo_equipo||'—')}</div>
    ${r.reclamada?`<div style="background:var(--diesel-soft);border:1px solid var(--diesel);border-radius:8px;padding:8px 11px;margin:8px 0;font-size:12px;color:#854F0B"><b>⏰ Reclamada por ${r.reclamada_por||'supervisor'}</b>${r.reclamada_at?' · '+fechaAR(r.reclamada_at):''}<div class="sub" style="margin-top:2px">El supervisor del objetivo pide apurar esta reparación.</div></div>`:''}
    <div class="side-meta">${r.objetivos?r.objetivos.nombre:'Taller / sin objetivo'} · ${r.capataces?r.capataces.nombre:(r.origen==='app'?'Alta del mecánico':'Alta del panel')}</div>
    <div style="margin:10px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="badge ${PRIO_BADGE[r.prioridad]||'b-gray'}">${cap(r.prioridad)}</span>
      <span class="badge ${r.tipo_mant==='preventivo'?'b-green':'b-gray'}">${r.tipo_mant==='preventivo'?'PREVENTIVO':'CORRECTIVO'}</span>
      <button class="mini-btn" style="font-size:10.5px" title="Cambiar tipo de mantenimiento" onclick="cambiarTipoRep('${r.id}','${r.tipo_mant==='preventivo'?'correctivo':'preventivo'}')">⇄ ${r.tipo_mant==='preventivo'?'pasar a correctivo':'pasar a preventivo'}</button></div>
    <div class="field-l" style="margin-bottom:6px">Descripción</div>
    <div class="obs" style="margin-bottom:14px">${r.descripcion||'—'}</div>
    ${railEstado(idx,5,false)}${railLabels(EST_REP_LABEL,idx)}
    <div class="divider"></div>
    <div class="field-l" style="margin-bottom:8px">Mecánico asignado</div>
    ${r.mecanicos?`<div style="font-weight:600;margin-bottom:6px">${r.mecanicos.nombre}</div><div class="habs">${habs}</div>`:'<div class="sub" style="margin-bottom:8px">Sin asignar</div>'}
    ${selMec}
    <button class="btn ghost" style="width:100%;justify-content:center;margin-top:8px" onclick="reasignarRep('${r.id}')">Guardar mecánico</button>
    <div class="divider"></div>
    <div class="field-l" style="margin-bottom:8px">Repuestos necesarios</div>
    ${(function(){const rp=(r.repuestos_taller||[]).find(x=>x.estado!=='entregado')||(r.repuestos_taller||[])[0];
      if(!rp)return '<div class="sub" style="margin-bottom:6px">Sin pedido de repuestos.</div>';
      const est={a_comprar:['A COMPRAR','b-amber'],comprado:['COMPRADO','b-blue'],entregado:['ENTREGADO','b-green']}[rp.estado]||[rp.estado,'b-gray'];
      return `<div style="margin-bottom:6px"><span class="badge ${est[1]}">${est[0]}</span></div>`+
        (rp.items||[]).map(i=>`<div class="sub" style="font-size:12px;padding:2px 0">x${i.cantidad||1} <b>${i.descripcion}</b>${i.codigo?' · <span class="mono">'+i.codigo+'</span>':''}</div>`).join('')+
        (rp.nota?`<div class="sub" style="font-size:11.5px;font-style:italic;margin-top:4px">💬 ${rp.nota}</div>`:'');})()}
    <div id="rep-rep-form" style="display:none;margin-top:8px">
      <div id="rep-rep-hint" class="sub" style="display:none;font-size:11.5px;color:var(--brote-2);margin-bottom:5px"></div>
      <div id="rep-rep-filas"></div>
      <div style="display:flex;gap:6px;margin-top:4px">
        <button class="btn ghost" style="flex:1;justify-content:center;font-size:12px" onclick="repRepAddFila()">＋ otra fila</button>
        <button class="btn ghost" style="flex:1;justify-content:center;font-size:12px" onclick="repRepSugerir('${r.id}')">✨ Sugerir de nuevo</button>
        <button class="btn ghost" style="flex:0 0 auto;justify-content:center;font-size:12px" onclick="document.getElementById('rep-rep-filas').innerHTML=repRepFila()">🗑</button>
      </div>
      <textarea id="rep-rep-nota" placeholder="Nota para quien compra (opcional)" style="width:100%;box-sizing:border-box;margin-top:6px;padding:8px;border:1px solid var(--linea);border-radius:8px;font:inherit;font-size:12px;min-height:44px"></textarea>
      <button class="btn" style="width:100%;justify-content:center;margin-top:6px" onclick="repRepGuardar('${r.id}',${ix})">Guardar pedido de repuestos</button>
    </div>
    <button class="btn ghost" id="rep-rep-toggle" style="width:100%;justify-content:center;margin-top:6px" onclick="repRepAbrir(${ix})">🛒 ${(r.repuestos_taller||[]).some(x=>x.estado!=='entregado')?'Editar':'Cargar'} pedido de repuestos</button>
    <div class="divider"></div>
    <div class="field-l" style="margin-bottom:8px">Observaciones del mecánico</div>${comHTML}
    <textarea id="rep-obs-nueva" placeholder="Agregar una observación… (viaja en el próximo aviso al capataz)" style="width:100%;box-sizing:border-box;margin-top:8px;padding:9px;border:1px solid var(--linea);border-radius:8px;font:inherit;font-size:12.5px;min-height:56px;resize:vertical"></textarea>
    <button class="btn ghost" style="width:100%;justify-content:center;margin-top:6px" onclick="agregarObsRep('${r.id}',${ix})">＋ Agregar observación</button>
    ${btnAvanzar}`;
}
/* Pedido de repuestos desde el detalle de la reparación */
function repRepFila(i){
  i=i||{};
  return `<div style="display:flex;gap:5px;margin-bottom:5px">
    <input class="rr-cant" type="text" inputmode="numeric" value="${i.cantidad||1}" style="width:40px;box-sizing:border-box;padding:7px;border:1px solid var(--linea);border-radius:7px;font-size:12px;text-align:center">
    <input class="rr-desc" type="text" placeholder="Repuesto" value="${(i.descripcion||'').replace(/"/g,'&quot;')}" style="flex:2;box-sizing:border-box;padding:7px;border:1px solid var(--linea);border-radius:7px;font-size:12px">
    <input class="rr-cod" type="text" placeholder="Código" value="${(i.codigo||'').replace(/"/g,'&quot;')}" style="flex:1;box-sizing:border-box;padding:7px;border:1px solid var(--linea);border-radius:7px;font-size:12px">
    <button class="btn ghost" style="padding:4px 9px;flex:0 0 auto" onclick="this.parentElement.remove()">✕</button>
  </div>`;
}
function repRepAddFila(){document.getElementById('rep-rep-filas').insertAdjacentHTML('beforeend',repRepFila());}
function repRepAbrir(ix){
  const r=window._repFiltrada[ix];
  const rp=(r.repuestos_taller||[]).find(x=>x.estado!=='entregado');
  const cont=document.getElementById('rep-rep-filas');
  cont.innerHTML=(rp&&rp.items&&rp.items.length?rp.items:[{},{}]).map(repRepFila).join('');
  document.getElementById('rep-rep-nota').value=rp&&rp.nota||'';
  document.getElementById('rep-rep-form').style.display='';
  document.getElementById('rep-rep-toggle').style.display='none';
  if(!rp)repRepSugerir(r.id);   // sin pedido previo → la IA propone (editable)
}
async function repRepSugerir(id){
  const hint=document.getElementById('rep-rep-hint');
  if(hint){hint.style.display='';hint.textContent='✨ Analizando la falla y los comentarios…';}
  try{
    const s=await api('/api/reparaciones/'+id+'/repuestos/sugerir',{method:'POST',body:'{}'});
    document.getElementById('rep-rep-filas').innerHTML=(s.items||[]).map(repRepFila).join('')||repRepFila();
    if(hint)hint.textContent='✨ '+(s.razon||'Sugerido según la falla')+' — revisá, corregí o agregá lo que falte.';
  }catch(e){if(hint)hint.textContent='No pude sugerir esta vez — cargalo a mano.';}
}
async function repRepGuardar(id,ix){
  const items=[...document.querySelectorAll('#rep-rep-filas > div')].map(f=>({
    cantidad:Number(f.querySelector('.rr-cant').value)||1,
    descripcion:f.querySelector('.rr-desc').value.trim(),
    codigo:f.querySelector('.rr-cod').value.trim(),
  })).filter(i=>i.descripcion);
  if(!items.length){alert('Cargá al menos un repuesto.');return;}
  const nota=document.getElementById('rep-rep-nota').value.trim();
  try{
    const nuevo=await api('/api/reparaciones/'+id+'/repuestos',{method:'POST',body:JSON.stringify({items,nota})});
    const r=window._repFiltrada[ix];
    r.repuestos_taller=(r.repuestos_taller||[]).filter(x=>x.id!==nuevo.id&&x.estado==='entregado');
    r.repuestos_taller.push(nuevo);
    selRep(ix);
  }catch(e){alert('No pude guardar: '+e.message);}
}
async function agregarObsRep(id,ix){
  const ta=document.getElementById('rep-obs-nueva');
  const texto=(ta&&ta.value||'').trim();
  if(!texto){alert('Escribí la observación primero.');return;}
  try{
    const nuevo=await api('/api/reparaciones/'+id+'/comentario',{method:'POST',body:JSON.stringify({texto})});
    // Actualizar en memoria y repintar el detalle sin recargar toda la vista
    const r=window._repFiltrada[ix];
    (r.comentarios_incidencias=r.comentarios_incidencias||[]).push(nuevo);
    selRep(ix);
  }catch(e){alert('No pude guardar: '+e.message);}
}
async function avanzarRep(id,estado){
  try{await api('/api/reparaciones/'+id,{method:'POST',body:JSON.stringify({estado})});await vReparaciones(document.getElementById('view'));refrescarContadores();}
  catch(e){alert('No pude avanzar: '+e.message);}
}
async function reasignarRep(id){
  const mecanico_id=document.getElementById('rep-mec').value||null;
  try{await api('/api/reparaciones/'+id,{method:'POST',body:JSON.stringify({mecanico_id})});await vReparaciones(document.getElementById('view'));}
  catch(e){alert('No pude reasignar: '+e.message);}
}

/* ===== Usuarios del panel (solo admin) ===== */
const MODS_PANEL=[['dashboard','Dashboard'],['insumos','Insumos'],['combustible','Combustible'],['compras','Compras'],['reparaciones','Reparaciones'],['stock','Stock'],['maestros','Maestros']];
let uPanelData=[], uPanelEdit=null;   // null=lista · {}=nuevo · {id,...}=edición
async function vUsuariosPanel(view,tabs){
  view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Maestros · Usuarios del panel</div>
      <div class="view-desc">Quién entra al panel y qué módulos puede ver. La app del mecánico se administra en Mecánicos.</div></div>
      <div class="spacer"></div>
      <button class="btn" onclick="uPanelEdit={};renderUsuariosPanel()">＋ Nuevo usuario</button></div>
    <div class="subtabs">${tabs.map(([v,l])=>`<div class="subtab ${maestroTab===v?'on':''}" onclick="maestroTab='${v}';vMaestros(document.getElementById('view'))">${l}</div>`).join('')}</div>
    <div id="up-lista"><div class="cargando-v">Cargando…</div></div>`;
  try{uPanelData=await api('/api/usuarios');}catch(e){
    document.getElementById('up-lista').innerHTML=`<div class="cargando-v">${e.message||'No pude cargar usuarios.'}<br><span class="sub">¿Creaste la tabla usuarios_panel en Supabase?</span></div>`;return;}
  renderUsuariosPanel();
}
function renderUsuariosPanel(){
  const cont=document.getElementById('up-lista');if(!cont)return;
  if(uPanelEdit){
    const u=uPanelEdit;const esNuevo=!u.id;
    cont.innerHTML=`<div class="panel" style="max-width:560px">
      <div class="panel-title" style="margin-bottom:12px">${esNuevo?'Nuevo usuario':'Editar: '+u.usuario}</div>
      <div class="mm-label">Usuario (para el login)</div>
      <input class="busca" id="up-usuario" style="width:100%;margin-bottom:10px" value="${(u.usuario||'').replace(/"/g,'&quot;')}" ${esNuevo?'':'disabled'} placeholder="ej. soledad">
      <div class="mm-label">Nombre</div>
      <input class="busca" id="up-nombre" style="width:100%;margin-bottom:10px" value="${(u.nombre||'').replace(/"/g,'&quot;')}" placeholder="ej. Soledad — Administración">
      <div class="mm-label">${esNuevo?'Clave':'Nueva clave (dejar vacío para no cambiarla)'}</div>
      <input class="busca" id="up-clave" type="password" style="width:100%;margin-bottom:12px" placeholder="${esNuevo?'clave inicial':'sin cambio'}">
      <div class="mm-label" style="margin-bottom:6px">Módulos que puede ver</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px">
        ${MODS_PANEL.map(([k,l])=>`<label style="display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="up-m-${k}" ${(u.modulos||[]).includes(k)?'checked':''} style="accent-color:var(--brote)">${l}</label>`).join('')}
      </div>
      <label style="display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer;margin-bottom:14px">
        <input type="checkbox" id="up-admin" ${u.admin?'checked':''} style="accent-color:var(--brote)"><b>Administrador</b> <span class="sub">(ve todo y gestiona usuarios)</span></label>
      <div style="display:flex;gap:8px">
        <button class="btn" onclick="guardarUsuarioPanel()">Guardar</button>
        <button class="btn-salir" onclick="uPanelEdit=null;renderUsuariosPanel()">Cancelar</button>
      </div></div>`;
    return;
  }
  cont.innerHTML=uPanelData.length?'<div class="cardgrid">'+uPanelData.map(u=>`
    <div class="mcard ${u.activo?'':'off'}">
      <div class="mcard-head"><div class="avatar">${(u.nombre||u.usuario||'?').split(' ').slice(0,2).map(w=>w[0]||'').join('').toUpperCase()}</div>
        <div><div class="mcard-title">${u.nombre||u.usuario}</div>
        <div class="mcard-sub mono">${u.usuario} · ${u.activo?(u.admin?'Admin':'Activo'):'Desactivado'}</div></div></div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin:8px 0">
        ${u.admin?'<span class="badge b-green">todos los módulos</span>'
          :(u.modulos||[]).map(m=>`<span class="badge b-gray">${m}</span>`).join('')||'<span class="badge b-amber">sin módulos</span>'}
      </div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn-salir" style="padding:5px 10px;font-size:12px" onclick='uPanelEdit=${JSON.stringify({id:u.id,usuario:u.usuario,nombre:u.nombre,modulos:u.modulos||[],admin:u.admin,activo:u.activo}).replace(/'/g,"&#39;")};renderUsuariosPanel()'>✎ Editar</button>
        <button class="btn-salir" style="padding:5px 10px;font-size:12px;${u.activo?'color:var(--rojo)':''}" onclick="toggleUsuarioPanel('${u.id}',${!u.activo})">${u.activo?'Desactivar':'Reactivar'}</button>
      </div>
    </div>`).join('')+'</div>'
    :'<div class="empty" style="height:200px"><div>No hay usuarios. Tocá "Nuevo usuario".<br><span class="sub">Los de PANEL_USERS (Railway) siguen entrando como admin.</span></div></div>';
}
async function guardarUsuarioPanel(){
  const u=uPanelEdit||{};
  const body={
    id:u.id||null,
    usuario:document.getElementById('up-usuario').value.trim(),
    nombre:document.getElementById('up-nombre').value.trim(),
    clave:document.getElementById('up-clave').value||null,
    modulos:MODS_PANEL.map(([k])=>k).filter(k=>document.getElementById('up-m-'+k).checked),
    admin:document.getElementById('up-admin').checked,
    activo:u.activo!==false,
  };
  if(!body.usuario){alert('Falta el usuario');return;}
  if(!u.id&&!body.clave){alert('Falta la clave inicial');return;}
  try{
    await api('/api/usuarios',{method:'POST',body:JSON.stringify(body)});
    uPanelEdit=null;
    vMaestros(document.getElementById('view'));
  }catch(e){alert('No pude guardar: '+(e.message||''));}
}
async function toggleUsuarioPanel(id,activo){
  const u=uPanelData.find(x=>x.id===id);if(!u)return;
  try{
    await api('/api/usuarios',{method:'POST',body:JSON.stringify({id,usuario:u.usuario,nombre:u.nombre,modulos:u.modulos||[],admin:u.admin,activo})});
    vMaestros(document.getElementById('view'));
  }catch(e){alert('No pude actualizar: '+(e.message||''));}
}

/* ===== Reparaciones · Preventivo (rodados por tiempo) ===== */
let pvData=null, pvCfgOpen=false;
const PV_TIPOS=[['camioneta','Camioneta'],['tractor','Tractor'],['desmalezadora','Desmalezadora'],['mini_tractor','Mini tractor'],['giro_cero','Giro cero']];
const PV_ORD={vencido:0,por_vencer:1,al_dia:2,sin_service:3,sin_config:4};
const PV_BADGE={vencido:['Vencido','background:var(--rojo-soft);color:#A32D2D'],por_vencer:['Por vencer','background:var(--diesel-soft);color:#854F0B'],al_dia:['Al día','background:var(--brote-soft);color:var(--brote-2)'],sin_service:['Sin service','background:var(--papel);color:var(--tinta-2);border:1px solid var(--linea)'],sin_config:['Sin intervalo','background:var(--papel);color:var(--tinta-2);border:1px solid var(--linea)']};
async function vRepPreventivo(view){
  view.innerHTML=tabsRep()+'<div class="cargando-v">Cargando…</div>';
  try{pvData=await api('/api/reparaciones/preventivo');renderPreventivo();}
  catch(e){view.innerHTML=tabsRep()+'<div class="cargando-v">No pude cargar el preventivo. ¿Corriste el SQL?</div>';}
}
function renderPreventivo(){
  const view=document.getElementById('view');
  const rs=[...(pvData.rodados||[])].sort((a,b)=>(PV_ORD[a.estado]-PV_ORD[b.estado])||((b.dias||0)-(a.dias||0)));
  const nv=rs.filter(r=>r.estado==='vencido').length,
        np=rs.filter(r=>r.estado==='por_vencer').length,
        na=rs.filter(r=>r.estado==='al_dia').length,
        ns=rs.filter(r=>r.estado==='sin_service').length;
  const cfg={};(pvData.config||[]).forEach(c=>cfg[c.tipo]=c.intervalo_dias);

  const filas=rs.map(r=>{
    const pct=(r.intervalo&&r.dias!=null)?Math.min(100,Math.round(r.dias*100/r.intervalo)):(r.reprogramado?60:0);
    const col=r.estado==='vencido'?'var(--rojo)':r.estado==='por_vencer'?'var(--diesel)':'var(--brote)';
    const pcol=r.estado==='vencido'?'#A32D2D':r.estado==='por_vencer'?'#854F0B':'var(--brote-2)';
    const restanTxt=r.restan==null?'':(r.restan<=0?' · +'+(-r.restan)+' vencido':' · vence en '+r.restan);
    const prog=r.intervalo?((r.dias!=null||r.reprogramado)
      ?`<div class="pv-bar"><i style="width:${pct}%;background:${col}"></i></div>
        <div class="mono" style="font-size:11px;font-weight:500;margin-top:4px;color:${pcol}">${r.dias!=null?r.dias+' / '+r.intervalo+' días':'reprogramado'}${restanTxt}</div>`
      :'<span class="sub">sin service registrado</span>')
      :'<span class="sub">configurá el intervalo</span>';
    const [bl,bs]=PV_BADGE[r.estado]||PV_BADGE.sin_config;
    const ident=r.codigo?`<span class="uni-num">${r.codigo}</span>`:`<span class="mono" style="font-weight:600;font-size:12px">${r.patente||'—'}</span>`;
    const nom=(r.codigo||r.patente||'').replace(/'/g,'');
    const acciones=r.intervalo?`<div style="display:flex;gap:5px;justify-content:flex-end">
        ${(r.estado==='vencido'||r.estado==='por_vencer')&&!r.incidencia_abierta?`<button class="mini-btn" onclick="pvAlta('${r.id}','${nom}')">+ Preventivo</button>`:''}
        <button class="mini-btn" title="Marcar service realizado hoy" onclick="pvRealizado('${r.id}','${nom}')">✓ Realizado</button>
        <button class="mini-btn" title="Correr el vencimiento" onclick="pvReprogramar('${r.id}','${nom}')">↻</button>
      </div>`:'';
    return `<tr>
      <td><div style="font-weight:500">${r.tipo_label}</div><div class="sub">${r.marca_modelo||''}</div></td>
      <td>${ident}${r.codigo&&r.patente?`<div class="sub mono" style="margin-top:3px">${r.patente}</div>`:''}</td>
      <td><span class="sub mono" style="font-size:11px">cada ${r.intervalo||'—'} días</span></td>
      <td class="mono" style="font-size:12px">${r.ultimo?fechaAR(r.ultimo):'—'}</td>
      <td>${prog}</td>
      <td><span class="badge" style="${bs}">${bl}</span>${r.incidencia_abierta?`<div style="margin-top:4px"><span class="badge" style="background:var(--azul-soft);color:var(--azul);font-size:10px">🔧 en taller · ${(EST_REP_LABEL[EST_REP.indexOf(r.incidencia_abierta)]||r.incidencia_abierta)}</span></div>`:''}${r.reprogramado?`<div style="margin-top:4px"><span class="badge" style="background:var(--azul-soft);color:var(--azul);font-size:10px">↻ al ${fechaAR(r.proximo)}</span></div>`:''}</td>
      <td>${acciones}</td>
    </tr>`;}).join('');

  // Proyección: 1 columna "vencido" + 7 semanas
  const hoy=new Date();hoy.setHours(0,0,0,0);
  const wks=[[]];for(let i=0;i<7;i++)wks.push([]);
  rs.forEach(r=>{
    if(!r.proximo)return;
    const p=new Date(r.proximo);
    const dif=Math.floor((p-hoy)/86400000);
    const nom=(r.tipo_label.split(' ')[0])+' '+(r.codigo||String(r.patente||'').slice(0,6));
    if(dif<0){wks[0].push([nom,'c-rojo-pv']);return;}
    const w=Math.min(7,Math.floor(dif/7)+1);
    wks[w].push([nom,dif<=15?'c-ambar-pv':'c-gris-pv']);
  });
  const wkLabel=i=>{if(i===0)return 'Ya vencido';const d=new Date(hoy.getTime()+(i-1)*7*86400000);
    return 'Sem '+String(d.getDate()).padStart(2,'0')+'-'+['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][d.getMonth()];};
  const CHIP={'c-rojo-pv':'background:var(--rojo-soft);color:#A32D2D','c-ambar-pv':'background:var(--diesel-soft);color:#854F0B','c-gris-pv':'background:var(--papel);color:var(--tinta-2);border:1px solid var(--linea)'};
  const proj=wks.map((w,i)=>`<div class="pv-wk"><div class="sub mono" style="font-size:10.5px;margin-bottom:8px">${wkLabel(i)}</div>
    ${w.map(([n,c])=>`<span class="pv-chip" style="${CHIP[c]}">${n}</span>`).join('')}</div>`).join('');

  const cfgHtml=pvCfgOpen?`<div class="card" style="padding:14px 16px;margin-bottom:16px">
      <div style="font-weight:600;font-size:13.5px;margin-bottom:10px">Intervalos por tipo de rodado (días)</div>
      <div style="display:flex;gap:14px;flex-wrap:wrap">
        ${PV_TIPOS.map(([t,l])=>`<label style="font-size:12px;color:var(--tinta-2)">${l}<br>
          <input type="number" min="1" id="pvc-${t}" value="${cfg[t]||''}" style="width:80px;margin-top:4px;padding:7px;border:1px solid var(--linea-2);border-radius:7px;font-family:'JetBrains Mono',monospace"></label>`).join('')}
      </div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn" onclick="pvGuardarCfg()">Guardar</button>
        <button class="mini-btn" onclick="pvCfgOpen=false;renderPreventivo()">Cerrar</button>
      </div>
      <div class="sub" style="margin-top:8px">El tipo de cada rodado se asigna en Maestros → Unidades. El último service sale de las planillas de Services y de las incidencias preventivas finalizadas.</div>
    </div>`:'';

  view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Reparaciones · Preventivo</div>
      <div class="view-desc">Mantenimiento programado por tiempo de los rodados</div></div>
      <div class="spacer"></div>
      <button class="btn" onclick="pvCfgOpen=!pvCfgOpen;renderPreventivo()">⚙ Intervalos</button></div>
    ${tabsRep()}
    ${cfgHtml}
    <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
      <div class="kpi"><div class="kpi-label">Vencidos</div><div class="kpi-val" style="color:#A32D2D">${nv}</div><div class="kpi-sub">necesitan service ya</div></div>
      <div class="kpi plain"><div class="kpi-label">Por vencer</div><div class="kpi-val" style="color:var(--diesel)">${np}</div><div class="kpi-sub">arriba del 75% del intervalo</div></div>
      <div class="kpi plain"><div class="kpi-label">Al día</div><div class="kpi-val" style="color:var(--brote-2)">${na}</div><div class="kpi-sub">dentro del intervalo</div></div>
      <div class="kpi plain"><div class="kpi-label">Sin service</div><div class="kpi-val">${ns}</div><div class="kpi-sub">sin historial cargado</div></div>
    </div>
    ${(pvData.en_curso||[]).length?`<div class="card" style="padding:0;margin-bottom:18px;overflow:hidden">
      <div style="padding:13px 16px;border-bottom:1px solid var(--linea);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <b style="font-size:13.5px">Preventivas en curso</b>
        <span class="sub" style="font-size:11.5px">Incidencias preventivas abiertas · al finalizarlas arranca el contador de la unidad</span></div>
      <div class="tablewrap"><table>
        <thead><tr><th>Equipo</th><th>Unidad</th><th>Mecánico</th><th>Estado</th><th>Hace</th></tr></thead>
        <tbody>${pvData.en_curso.map(i=>{const eidx=EST_REP.indexOf(i.estado);return `<tr style="cursor:pointer" onclick="repTab='resumen';go('reparaciones')">
          <td style="font-weight:500">${i.tipo_equipo||'—'}</td>
          <td>${i.numero_unidad?`<span class="uni-num">${i.numero_unidad}</span>`:'—'}</td>
          <td>${i.mecanicos?i.mecanicos.nombre:'<span class="sub">sin asignar</span>'}</td>
          <td><span class="badge ${eidx>=0?'est-'+eidx:'b-gray'}">${EST_REP_LABEL[eidx]||i.estado}</span></td>
          <td class="sub mono">${hace(i.created_at)}</td></tr>`;}).join('')}</tbody>
      </table></div>
    </div>`:''}
    <div class="card" style="padding:0;margin-bottom:18px;overflow:hidden">
      <div style="padding:13px 16px;border-bottom:1px solid var(--linea);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <b style="font-size:13.5px">Semáforo de flota</b>
        <span class="sub" style="font-size:11.5px">Días desde el último service vs. intervalo del tipo</span></div>
      <div class="tablewrap"><table>
        <thead><tr><th>Rodado</th><th>Unidad</th><th>Intervalo</th><th>Último service</th><th>Progreso</th><th>Estado</th><th></th></tr></thead>
        <tbody>${filas||'<tr><td colspan="7" class="sub" style="padding:20px;text-align:center">No hay rodados con tipo asignado. Andá a Maestros → Unidades y asignales un tipo de rodado.</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <div style="padding:13px 16px;border-bottom:1px solid var(--linea);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <b style="font-size:13.5px">Proyección · próximos 60 días</b>
        <span class="sub" style="font-size:11.5px">Fecha estimada del próximo preventivo</span></div>
      <div style="display:grid;grid-template-columns:repeat(8,1fr);padding:14px 16px 16px">${proj}</div>
    </div>`;
}
async function pvAlta(id,nombre){
  if(!await uiConfirm('Se crea una incidencia preventiva pendiente para '+nombre+' (sin asignar, prioridad baja).','Dar de alta preventivo',{ok:'Dar de alta'}))return;
  try{await api('/api/reparaciones/preventivo/alta',{method:'POST',body:JSON.stringify({unidad_id:id})});
    toast('Preventivo creado para '+nombre);pvData=await api('/api/reparaciones/preventivo');renderPreventivo();refrescarContadores();}
  catch(e){toast(e.message,'error');}
}
async function pvRealizado(id,nombre){
  if(!await uiConfirm('Se registra el service de HOY para '+nombre+' en el historial de Services (sin crear incidencia). El contador arranca de nuevo.','Marcar realizado',{ok:'Registrar'}))return;
  try{await api('/api/reparaciones/preventivo/realizado',{method:'POST',body:JSON.stringify({unidad_id:id})});
    toast('Service registrado para '+nombre);pvData=await api('/api/reparaciones/preventivo');renderPreventivo();}
  catch(e){toast(e.message,'error');}
}
async function pvReprogramar(id,nombre){
  const v=await uiPrompt('¿Cuántos días corrés el preventivo de '+nombre+'? (desde hoy)','7','Reprogramar');
  if(v==null)return;
  const dias=Math.round(Number(v));
  if(!dias||dias<1||dias>365){toast('Ingresá un número de días entre 1 y 365','error');return;}
  try{await api('/api/reparaciones/preventivo/reprogramar',{method:'POST',body:JSON.stringify({unidad_id:id,dias})});
    toast(nombre+' reprogramado '+dias+' días');pvData=await api('/api/reparaciones/preventivo');renderPreventivo();}
  catch(e){toast(e.message,'error');}
}
async function pvGuardarCfg(){
  const tipos=PV_TIPOS.map(([t])=>({tipo:t,intervalo_dias:Number(document.getElementById('pvc-'+t).value)||0})).filter(x=>x.intervalo_dias>0);
  try{await api('/api/reparaciones/preventivo/config',{method:'POST',body:JSON.stringify({tipos})});
    toast('Intervalos guardados');pvCfgOpen=false;pvData=await api('/api/reparaciones/preventivo');renderPreventivo();}
  catch(e){toast(e.message,'error');}
}

/* ===== Maestros (ABM) ===== */
const HABILIDADES=[['motor_2t','Motor 2T'],['motor_4t','Motor 4T'],['hidraulica','Hidráulica'],['electrico','Eléctrico'],['soldadura','Soldadura'],['neumatico','Neumático'],['giro_cero','Giro cero'],['unidades','Unidades'],['tractores','Tractores'],['cortadora','Cortadora de pasto'],['general','General']];
const SINGULAR={mecanicos:'mecánico',objetivos:'objetivo',capataces:'capataz',centros_costo:'centro de costo',unidades:'unidad'};
// Las unidades no tienen columna `nombre`: su título es el código o la patente.
const tituloMaestro=m=>maestroTab==='unidades'?(m.codigo||m.patente||'sin código'):(m.nombre||'—');
let maestroTab='mecanicos', maestrosData=[], maestroEdit=null, unidadesData=[];

async function vMaestros(view){
  const tabs=[['mecanicos','Mecánicos'],['objetivos','Objetivos'],['capataces','Capataces'],
              ['centros_costo','Centros de costo'],['unidades','Unidades']];
  if(misModulos()===null)tabs.push(['usuarios','Usuarios del panel']);   // solo admin
  if(maestroTab==='usuarios'){vUsuariosPanel(view,tabs);return;}
  view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Maestros</div>
      <div class="view-desc">Alta, edición y baja de los datos base del sistema</div></div>
      <div class="spacer"></div>
      <button class="btn" onclick="nuevoMaestro()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>Nuevo ${SINGULAR[maestroTab]}</button></div>
    <div class="subtabs">${tabs.map(([v,l])=>`<div class="subtab ${maestroTab===v?'on':''}" onclick="maestroTab='${v}';vMaestros(document.getElementById('view'))">${l}</div>`).join('')}</div>
    ${maestroTab==='centros_costo'?'<div class="sub" style="margin-bottom:12px">Son las entidades a las que se imputa el gasto en Compras: clientes, consorcios, organismos.</div>':''}
    ${maestroTab==='unidades'?'<div class="sub" style="margin-bottom:12px">La flota. Se usan en Compras (imputación) y en Combustible (el bot las resuelve por patente).</div>':''}
    <div id="mm-lista"><div class="cargando-v">Cargando…</div></div>`;
  cargarMaestros();
}
async function cargarMaestros(){
  try{
    if(maestroTab==='capataces'&&!unidadesData.length){
      try{unidadesData=await api('/api/maestros/unidades');}catch(e){unidadesData=[];}
    }
    if((maestroTab==='capataces'||maestroTab==='mecanicos')&&!objetivos.length){
      try{objetivos=await api('/api/objetivos');}catch(e){objetivos=[];}
    }
    maestrosData=await api('/api/maestros/'+maestroTab);renderMaestros();}
  catch(e){document.getElementById('mm-lista').innerHTML='<div class="cargando-v">No pude cargar.</div>';}
}
function renderMaestros(){
  const cont=document.getElementById('mm-lista');
  if(!maestrosData.length){cont.innerHTML='<div class="empty" style="height:200px"><div>No hay registros. Tocá "Nuevo".</div></div>';return;}
  cont.innerHTML='<div class="cardgrid">'+maestrosData.map((m,ix)=>cardMaestro(m,ix)).join('')+'</div>';
}
function cardMaestro(m,ix){
  const titulo=tituloMaestro(m);
  const ini=String(titulo||'?').split(' ').slice(0,2).map(w=>w[0]||'').join('').toUpperCase();
  let sub='',extra='';
  if(maestroTab==='centros_costo'){
    sub=m.activo?'Activo':'Inactivo';
  }
  if(maestroTab==='unidades'){
    sub=m.marca_modelo||'sin modelo';
    extra=`${m.tipo_activo?`<div class="mcard-row"><span>Tipo</span><b>${m.tipo_activo}</b></div>`:''}
      <div class="mcard-row"><span>Patente</span><b class="mono">${m.patente||'—'}</b></div>
      <div class="mcard-row"><span>Responsable</span><b>${m.responsable||'—'}</b></div>
      ${m.tipo_rodado?`<div class="mcard-row"><span>Preventivo</span><span class="badge b-green" style="font-size:10px">${({camioneta:'Camioneta',tractor:'Tractor',desmalezadora:'Desmalezadora',mini_tractor:'Mini tractor',giro_cero:'Giro cero'})[m.tipo_rodado]||m.tipo_rodado}</span></div>`:''}
      ${m.objetivos?`<div class="mcard-row"><span>Objetivo</span><b>${m.objetivos.nombre}</b></div>`:''}`;
  }
  if(maestroTab==='mecanicos'){
    const esPanol=m.rol_app==='panol';
    const esSup=m.rol_app==='supervisor';
    sub=esPanol?'Pañol · depósito':esSup?'Supervisor · insumos':(m.habilidades||[]).length+' habilidades';
    extra=(esPanol||esSup)?'':'<div class="habs">'+(m.habilidades||[]).map(h=>`<span class="hab ${HAB_COLOR[h]||'b-gray'}`+'">'+h.toUpperCase()+'</span>').join('')+'</div>';
    extra+=`<div class="mcard-row"><span>App</span>${m.usuario
      ?`<span class="badge ${esPanol?'b-blue':'b-green'} mono" style="font-size:10px">${esPanol?'📦 ':''}${m.usuario}</span>`
      :'<span class="badge b-gray">sin acceso</span>'}</div>`;
  }
  if(maestroTab==='centros_costo'){
    extra=m.codigo_flexxus?`<div class="mcard-row"><span>Cód. Flexxus</span><b class="mono">${m.codigo_flexxus}</b></div>`:'<div class="mcard-row"><span>Cód. Flexxus</span><b style="color:var(--diesel)">sin cargar</b></div>';
  }
  if(maestroTab==='objetivos'){
    sub=m.activo?'Activo':'Inactivo';
    const t=m.tipo||'operativo';
    extra=`<div class="mcard-row"><span>Tipo</span><span class="badge ${t==='operativo'?'b-green':'b-gray'}">${t==='operativo'?'operativo':'imputación'}</span></div>${m.codigo_flexxus?`<div class="mcard-row"><span>Cód. Flexxus</span><b class="mono">${m.codigo_flexxus}</b></div>`:'<div class="mcard-row"><span>Cód. Flexxus</span><b style="color:var(--diesel)">sin cargar</b></div>'}`;
  }
  if(maestroTab==='capataces'){
    sub=m.objetivos?m.objetivos.nombre:'sin objetivo';
    extra=`<div class="mcard-row"><span>Teléfono</span><b>${m.telefono||'—'}</b></div>${m.rol?`<div class="mcard-row"><span>Rol</span><b>${m.rol}</b></div>`:''}`;
  }
  return `<div class="mcard" style="${m.activo?'':'opacity:.55'}">
    <div class="mcard-h"><div class="mcard-ini">${ini}</div>
      <div><div class="mcard-name">${titulo}</div><div class="mcard-sub">${sub}</div></div></div>
    ${extra}
    <div class="mcard-actions">
      <button class="mini-btn" onclick="editarMaestro(${ix})">Editar</button>
      <button class="mini-btn ${m.activo?'danger':''}" onclick="toggleMaestro(${ix})">${m.activo?'Desactivar':'Activar'}</button>
    </div></div>`;
}
function nuevoMaestro(){maestroEdit=null;abrirModalMaestro({});}
function editarMaestro(ix){maestroEdit=maestrosData[ix];abrirModalMaestro(maestroEdit);}
function abrirModalMaestro(m){
  document.getElementById('mm-titulo').textContent=(maestroEdit?'Editar ':'Nuevo ')+SINGULAR[maestroTab];
  // Las unidades no tienen `nombre`: tienen código, modelo, patente y responsable.
  let campos = maestroTab==='unidades'
    ? `<div class="mm-field"><label>Código</label><input id="mm-codigo" value="${(m.codigo||'').replace(/"/g,'&quot;')}" placeholder="ej: U12"></div>
       <div class="mm-field"><label>Marca y modelo</label><input id="mm-modelo" value="${(m.marca_modelo||'').replace(/"/g,'&quot;')}" placeholder="ej: Fiat Strada Cab.Simple Mod.2018"></div>
       <div class="mm-field"><label>Patente</label><input id="mm-patente" value="${(m.patente||'').replace(/"/g,'&quot;')}" placeholder="ej: AC770AY"></div>
       <div class="mm-field"><label>Responsable</label><input id="mm-responsable" value="${(m.responsable||'').replace(/"/g,'&quot;')}" placeholder="ej: Agustín Nóbrega"></div>
       <div class="mm-field"><label>Tipo de activo <span style="font-weight:400;color:var(--tinta-3)">(qué es: motoguadaña, bobcat, camioneta…)</span></label>
         <input id="mm-tipo-activo" list="tipos-activo" value="${m.tipo_activo||''}" placeholder="motoguadaña, sopladora, bobcat…">
         <datalist id="tipos-activo">
           ${['motoguadaña','sopladora','extensible','plana','motosierra','tractor','mini tractor','giro cero','desmalezadora','camioneta','camión','hidro grúa','bobcat','carro','otro'].map(t=>`<option value="${t}">`).join('')}
         </datalist></div>
       <div class="mm-field"><label>Tipo de rodado <span style="font-weight:400;color:var(--tinta-3)">(para el preventivo)</span></label><select id="mm-rodado">
         <option value="">— sin preventivo —</option>
         ${[['camioneta','Camioneta'],['tractor','Tractor'],['desmalezadora','Desmalezadora'],['mini_tractor','Mini tractor'],['giro_cero','Giro cero']].map(([v,l])=>`<option value="${v}" ${m.tipo_rodado===v?'selected':''}>${l}</option>`).join('')}
       </select></div>
       <div class="mm-field"><label>Objetivo</label><select id="mm-objetivo">
         <option value="">— sin asignar —</option>
         ${(objetivos||[]).map(o=>`<option value="${o.id}" ${String(m.objetivo_id)===String(o.id)?'selected':''}>${o.nombre}</option>`).join('')}
       </select></div>
       <div class="sub">El <b>objetivo</b> es lo que usa Compras para repartir el gasto de combustible. La <b>patente</b> es lo que usa el bot para reconocer la unidad en el ticket.</div>`
    : `<div class="mm-field"><label>Nombre</label><input id="mm-nombre" value="${(m.nombre||'').replace(/"/g,'&quot;')}"></div>`;
  if(maestroTab==='mecanicos'){
    campos+=`<div class="mm-field"><label>Habilidades</label><div class="mm-habs">${HABILIDADES.map(([v,l])=>`<label class="mm-hab"><input type="checkbox" class="hab-chk" value="${v}" ${(m.habilidades||[]).includes(v)?'checked':''}> ${l}</label>`).join('')}</div></div>`;
    campos+=`<div class="divider"></div>
      <div class="field-l" style="margin-bottom:8px">Acceso a la app</div>
      <div class="mm-field"><label>Rol en la app</label><select id="mm-rolapp" onchange="toggleObjCargo()">
        <option value="mecanico" ${(m.rol_app||'mecanico')!=='panol'&&m.rol_app!=='supervisor'?'selected':''}>Taller — ve sus reparaciones</option>
        <option value="panol" ${m.rol_app==='panol'?'selected':''}>Pañol — ve los pedidos de insumos</option>
        <option value="supervisor" ${m.rol_app==='supervisor'?'selected':''}>Supervisor — ve incidencias de sus objetivos</option>
      </select></div>
      <div id="mm-objcargo-wrap" style="display:${m.rol_app==='supervisor'?'block':'none'}">
        <div class="mm-field"><label>Objetivos a cargo</label>
          <div class="mm-habs" style="max-height:180px;overflow:auto">${objetivos.map(o=>`<label class="mm-hab"><input type="checkbox" class="mm-objcargo" value="${o.id}" ${(m.objetivos_cargo||[]).map(String).includes(String(o.id))?'checked':''}> ${o.nombre}</label>`).join('')}</div>
        </div>
        <div class="sub">El supervisor solo verá las incidencias de estos objetivos.</div>
      </div>
      <div class="mm-field"><label>Usuario</label><input id="mm-usuario" value="${(m.usuario||'').replace(/"/g,'&quot;')}" placeholder="ej: santiago" autocapitalize="none"></div>
      <div class="mm-field"><label>Clave</label><input id="mm-clave" type="text" placeholder="${m.usuario?'dejar vacío para no cambiarla':'clave para entrar a la app'}"></div>
      <div class="sub">La clave se guarda encriptada. Para cambiarla, escribí una nueva; si dejás el campo vacío, se mantiene la actual.</div>`;
  }
  if(maestroTab==='capataces'){
    campos+=`<div class="mm-field"><label>Teléfono</label><input id="mm-telefono" value="${m.telefono||''}" placeholder="549351..."></div>`;
    campos+=`<div class="mm-field"><label>Rol</label><input id="mm-rol" value="${(m.rol||'').replace(/"/g,'&quot;')}" placeholder="Logística, Supervisores..."></div>`;
    campos+=`<div class="mm-field"><label>Objetivo</label><select id="mm-objetivo"><option value="">— sin objetivo (choferes) —</option>${objetivos.map(o=>`<option value="${o.id}" ${m.objetivo_id===o.id?'selected':''}>${o.nombre}</option>`).join('')}</select></div>`;
    campos+=`<div class="divider"></div>
      <label class="mm-hab" style="margin-bottom:8px"><input type="checkbox" id="mm-eschofer" ${m.es_chofer?'checked':''}> Es chofer de roll off (carga viajes/bateas por el bot)</label>
      <div class="mm-field"><label>Camión asignado (opcional)</label><select id="mm-unidad"><option value="">— sin camión fijo —</option>${(unidadesData||[]).map(u=>`<option value="${u.id}" ${String(m.unidad_id)===String(u.id)?'selected':''}>${u.patente||u.codigo||'unidad'} ${u.marca_modelo?'· '+u.marca_modelo:''}</option>`).join('')}</select></div>`;
  }
  if(maestroTab==='centros_costo'){
    campos+=`<div class="mm-field"><label>Código de centro de costo en Flexxus <span style="font-weight:400;color:var(--tinta-3)">(columna centros de costo del diagnóstico ⚙, ej: EPEC = 12)</span></label><input id="mm-cflexxus" value="${(m.codigo_flexxus||'').replace(/"/g,'&quot;')}" placeholder="ej: 12"></div>`;
  }
  if(maestroTab==='objetivos'){
    campos+=`<div class="mm-field"><label>Ubicación</label><input id="mm-ubicacion" value="${(m.ubicacion||'').replace(/"/g,'&quot;')}" placeholder="Córdoba, Río Cuarto..."></div>`;
    campos+=`<div class="mm-field"><label>Tipo</label><select id="mm-tipo"><option value="operativo" ${(m.tipo||'operativo')==='operativo'?'selected':''}>Operativo</option><option value="imputacion" ${m.tipo==='imputacion'?'selected':''}>Imputación</option></select></div>`;
    campos+=`<div class="mm-field"><label>Código de centro de costo en Flexxus <span style="font-weight:400;color:var(--tinta-3)">(el que figura en Flexxus, ej: 012 para EPEC)</span></label><input id="mm-cflexxus" value="${(m.codigo_flexxus||'').replace(/"/g,'&quot;')}" placeholder="ej: 012"></div>`;
  }
  document.getElementById('mm-campos').innerHTML=campos;
  document.getElementById('mm-acciones').style.display='';  // el modal de stock las oculta
  document.getElementById('mm-bg').classList.add('abierto');
}
function cerrarMaestro(){document.getElementById('mm-bg').classList.remove('abierto');maestroEdit=null;}
function toggleObjCargo(){
  const rol=document.getElementById('mm-rolapp').value;
  const wrap=document.getElementById('mm-objcargo-wrap');
  if(wrap)wrap.style.display=rol==='supervisor'?'block':'none';
}
async function guardarMaestro(){
  let body={};
  if(maestroTab==='unidades'){
    const patente=document.getElementById('mm-patente').value.trim();
    if(!patente){alert('La patente es obligatoria: es lo que usa el bot para reconocer la unidad.');return;}
    body={
      codigo:document.getElementById('mm-codigo').value.trim()||null,
      marca_modelo:document.getElementById('mm-modelo').value.trim()||null,
      patente,
      responsable:document.getElementById('mm-responsable').value.trim()||null,
      objetivo_id:document.getElementById('mm-objetivo').value||null,
      tipo_rodado:document.getElementById('mm-rodado').value||null,
      tipo_activo:document.getElementById('mm-tipo-activo').value.trim().toLowerCase()||null,
    };
  }else{
    const nombre=document.getElementById('mm-nombre').value.trim();
    if(!nombre){alert('El nombre es obligatorio');return;}
    body={nombre};
  }
  if(maestroTab==='mecanicos'){
    body.habilidades=[...document.querySelectorAll('#mm-campos .hab-chk:checked')].map(c=>c.value);
    body.usuario=document.getElementById('mm-usuario').value.trim().toLowerCase()||null;
    body.rol_app=document.getElementById('mm-rolapp').value||'mecanico';
    if(body.rol_app==='supervisor'){
      body.objetivos_cargo=[...document.querySelectorAll('.mm-objcargo:checked')].map(c=>c.value);
    }else{
      body.objetivos_cargo=[];
    }
    const cl=document.getElementById('mm-clave').value.trim();
    if(cl)body.clave=cl;   // vacío = no cambiar la clave actual
  }
  if(maestroTab==='capataces'){
    body.telefono=document.getElementById('mm-telefono').value.trim()||null;
    body.rol=document.getElementById('mm-rol').value.trim().toLowerCase()||null;
    body.objetivo_id=document.getElementById('mm-objetivo').value||null;
    const ch=document.getElementById('mm-eschofer');if(ch)body.es_chofer=ch.checked;
    const un=document.getElementById('mm-unidad');if(un)body.unidad_id=un.value||null;
  }
  if(maestroTab==='centros_costo'){
    body.codigo_flexxus=document.getElementById('mm-cflexxus').value.trim()||null;
  }
  if(maestroTab==='objetivos'){
    body.ubicacion=document.getElementById('mm-ubicacion').value.trim()||null;
    body.tipo=document.getElementById('mm-tipo').value||'operativo';
    body.codigo_flexxus=document.getElementById('mm-cflexxus').value.trim()||null;
  }
  try{
    const ruta='/api/maestros/'+maestroTab+(maestroEdit?'/'+maestroEdit.id:'');
    await api(ruta,{method:'POST',body:JSON.stringify(body)});
    cerrarMaestro(); cargarMaestros();
    // Si tocamos centros de costo o unidades, Compras tiene que ver el cambio
    if(maestroTab==='centros_costo'||maestroTab==='unidades')comprasListasOk=false;
    if(maestroTab==='objetivos'){try{objetivos=await api('/api/objetivos');}catch(e){}}
    if(maestroTab==='mecanicos'){try{mecanicos=await api('/api/mecanicos');}catch(e){}}
  }catch(e){alert('No pude guardar: '+e.message);}
}
async function toggleMaestro(ix){
  const m=maestrosData[ix];
  const accion=m.activo?'desactivar':'activar';
  if(!confirm(`¿Seguro que querés ${accion} a "${m.nombre}"?`))return;
  try{
    await api('/api/maestros/'+maestroTab+'/'+m.id,{method:'POST',body:JSON.stringify({activo:!m.activo})});
    cargarMaestros();
    if(maestroTab==='objetivos'){try{objetivos=await api('/api/objetivos');}catch(e){}}
    if(maestroTab==='mecanicos'){try{mecanicos=await api('/api/mecanicos');}catch(e){}}
  }catch(e){alert('No pude actualizar: '+e.message);}
}

/* ===== Compras (segunda base) ===== */
function asignacionInv(inv){
  if(inv.assignmentMode==='total' && inv.totalAssign){
    return {obj:inv.totalAssign.objetivo||'', uni:inv.totalAssign.unidad||''};
  }
  const asigns=Object.values(inv.assignments||{});
  return {
    obj:(asigns.map(x=>x.objetivo).filter(Boolean)[0]||''),
    uni:(asigns.map(x=>x.unidad).filter(Boolean)[0]||''),
  };
}
/* ===== Compras · Indicadores ===== */
let comprasTab='resumen';   // 'resumen' | 'cuenta' | 'indicadores' | 'combustible'
let comprasIndPer=null;     // null = último mes con datos · '' = todo el período
let comprasIndData=null;    // cache de facturas para indicadores/export

/* ===== Compras · Estado de cuenta ===== */
let ctaBusca='';      // buscador de proveedor
let ctaProvSel=null;   // proveedor elegido para el detalle
let ctaSoloPend=false; // filtro: solo proveedores con saldo pendiente
let ctaData=null;      // cache de facturas

function tabsCompras(){return `<div class="toggle-imp" style="margin-bottom:16px">
  <button class="${comprasTab==='resumen'?'on':''}" onclick="comprasTab='resumen';go('compras')">Resumen</button>
  <button class="${comprasTab==='cuenta'?'on':''}" onclick="comprasTab='cuenta';go('compras')">Estado de cuenta</button>
  <button class="${comprasTab==='consumos'?'on':''}" onclick="comprasTab='consumos';go('compras')">Consumos</button>
  <button class="${comprasTab==='repuestos'?'on':''}" onclick="comprasTab='repuestos';go('compras')">Repuestos</button>
  <button class="${comprasTab==='indicadores'?'on':''}" onclick="comprasTab='indicadores';go('compras')">Indicadores</button>
  <button class="${comprasTab==='combustible'?'on':''}" onclick="comprasTab='combustible';go('compras')">Combustible</button>
</div>`;}

/* ===== Compras · Combustible por objetivo ===== */
let cbSel='';        // ids de remitos seleccionados ('' = el más reciente)
let cbData=null;

async function vComprasCombustible(view){
  view.innerHTML=tabsCompras()+'<div class="cargando-v">Consolidando…</div>';
  try{
    const [d,rems]=await Promise.all([
      api('/api/compras/combustible/consolidado'+(cbSel?'?ids='+encodeURIComponent(cbSel):'')),
      api('/api/compras/remitos'),
    ]);
    cbData=d;
    const t=d.totales;
    const objs=d.objetivos_disponibles||[];
    const barra=(x,color)=>`<div style="height:6px;background:var(--papel);border-radius:3px;margin-top:4px">
      <div style="height:6px;width:${Math.max(1,Math.round(x.pct))}%;background:${color};border-radius:3px"></div></div>`;
    // Desplegable de objetivos: al elegir uno, la patente queda asignada para siempre
    const selObj=(s,ix)=>`<select onchange="asignarObjetivo(${ix},this.value)" style="width:100%;font-size:11.5px;padding:6px 8px;border:1px solid var(--linea);border-radius:8px;background:var(--blanco);font-family:inherit">
      <option value="">— elegir objetivo —</option>
      ${objs.map(o=>`<option value="${o.id}">${o.nombre}</option>`).join('')}
    </select>`;

    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Combustible por objetivo</div>
      <div class="view-desc">Reparto del gasto de los remitos del proveedor${d.remitos.length?' · '+[...new Set(d.remitos.map(r=>r.proveedor||'—'))].join(', '):''}</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        <select class="busca" style="width:auto" onchange="cbSel=this.value;go('compras')">
          <option value="">Último listado</option>
          <option value="todos" ${cbSel==='todos'?'selected':''}>Todos los listados</option>
          ${(rems||[]).map(r=>`<option value="${r.id}" ${cbSel===String(r.id)?'selected':''}>${r.proveedor||'—'} · ${r.periodo_desde||''} a ${r.periodo_hasta||''}</option>`).join('')}
        </select>
        <button class="btn" onclick="go('combustible')">＋ Subir remito</button>
      </div></div>
    ${tabsCompras()}

    <div class="panel" style="margin-bottom:18px">
      <div class="panel-title" style="margin-bottom:10px">Listados procesados</div>
      ${(rems||[]).length?`<table style="font-size:12.5px"><thead><tr>
        <th>Proveedor</th><th>Período</th><th class="num">Registros</th><th class="num">Litros</th><th class="num">Total</th><th style="width:80px"></th></tr></thead>
      <tbody>${rems.map(r=>`<tr>
        <td style="font-weight:600">${r.proveedor||'—'}</td>
        <td class="mono sub">${r.periodo_desde||'?'} → ${r.periodo_hasta||'?'}</td>
        <td class="num">${((r.data&&r.data.filas)||[]).length}</td>
        <td class="num mono">${Math.round(((r.data&&r.data.filas)||[]).reduce((s,f)=>s+(Number(f.litros)||0),0)).toLocaleString('es-AR')}</td>
        <td class="num money">${money(r.total_general)}</td>
        <td style="text-align:right"><button class="btn-salir" style="padding:4px 8px;font-size:11.5px;color:var(--rojo)" onclick="borrarRemitoCb('${r.id}','${(r.proveedor||'').replace(/'/g,"\\'")}')" title="Eliminar este listado">✕</button></td>
      </tr>`).join('')}</tbody></table>`
      :'<div class="sub" style="padding:10px 0">No hay listados cargados.</div>'}
    </div>

    ${!d.remitos.length?'<div class="empty" style="height:200px"><div>Elegí un listado para ver el reparto por objetivo.</div></div>':`
    <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
      <div class="kpi"><div class="kpi-label">Total del remito</div>
        <div class="kpi-val" style="font-size:22px">${money(t.monto)}</div>
        <div class="kpi-sub">${Math.round(t.litros).toLocaleString('es-AR')} litros · ${t.filas} cargas</div></div>
      <div class="kpi"><div class="kpi-label">Asignado</div>
        <div class="kpi-val green" style="font-size:22px">${Math.round(t.pct_asignado)}%</div>
        <div class="kpi-sub">${money(t.asignado)} en ${t.objetivos} objetivos</div></div>
      <div class="kpi ${t.sin_asignar?'amber':'plain'}"><div class="kpi-label">Sin objetivo</div>
        <div class="kpi-val ${t.sin_asignar?'amber':''}" style="font-size:22px">${Math.round(t.pct_sin_asignar)}%</div>
        <div class="kpi-sub">${money(t.sin_asignar)} sin identificar</div></div>
      <div class="kpi plain"><div class="kpi-label">Objetivos</div>
        <div class="kpi-val" style="font-size:22px">${t.objetivos}</div>
        <div class="kpi-sub">con consumo en el período</div></div>
    </div>

    <div class="panel" style="margin-bottom:18px">
      <div class="panel-title" style="margin-bottom:12px">Gasto por objetivo</div>
      ${d.objetivos.length?`<table style="font-size:12.5px"><thead><tr>
        <th>Objetivo</th><th class="num">Litros</th><th class="num">Gasto</th><th style="width:170px">% del remito</th><th>Unidades / choferes</th></tr></thead>
      <tbody>${d.objetivos.map(o=>`<tr>
        <td style="font-weight:600">${o.nombre}<div class="sub" style="font-size:11px">${o.cargas} carga${o.cargas===1?'':'s'}</div></td>
        <td class="num mono">${Math.round(o.litros).toLocaleString('es-AR')}</td>
        <td class="num money">${money(o.monto)}</td>
        <td><div style="display:flex;align-items:center;gap:8px">
          <b class="mono" style="min-width:44px">${(Math.round(o.pct*10)/10).toFixed(1)}%</b>
          <div style="flex:1">${barra(o,'var(--brote)')}</div></div></td>
        <td class="sub" style="font-size:11px">${[...o.unidades,...o.choferes].slice(0,3).join(' · ')||'—'}</td>
      </tr>`).join('')}
      <tr style="border-top:2px solid var(--linea)">
        <td><b>Total asignado</b></td>
        <td class="num mono"><b>${Math.round(d.objetivos.reduce((s,o)=>s+o.litros,0)).toLocaleString('es-AR')}</b></td>
        <td class="num money"><b>${money(t.asignado)}</b></td>
        <td><b class="mono">${Math.round(t.pct_asignado)}%</b></td><td></td></tr>
      </tbody></table>`
      :'<div class="sub" style="padding:14px 0">Ninguna carga pudo asignarse todavía. Asignalas abajo.</div>'}
    </div>

    ${d.sin_asignar.length?`
    <div class="panel" style="border-left:3px solid var(--ambar)">
      <div class="panel-title" style="margin-bottom:6px">⚠ Cargas sin objetivo</div>
      <div class="sub" style="margin-bottom:12px">La mayoría ya está en el maestro de Unidades: lo único que les falta es <b>a qué objetivo van</b>. Elegilo acá y queda guardado para siempre.</div>
      <table style="font-size:12.5px"><thead><tr>
        <th>Unidad / patente</th><th>Chofer</th><th class="num">Litros</th><th class="num">Gasto</th><th class="num">%</th><th style="width:240px">Objetivo</th></tr></thead>
      <tbody>${d.sin_asignar.map((s,ix)=>`<tr id="sinobj-${ix}">
        <td>
          <div class="mono" style="font-weight:600">${s.patente||'<span class="sub">sin patente</span>'}</div>
          ${s.unidad_conocida
            ?`<div class="sub" style="font-size:11px;color:var(--brote-2)">✓ ${s.unidad_conocida.codigo||'unidad'} · solo falta el objetivo</div>`
            :'<div class="sub" style="font-size:11px">no está en Unidades · se va a crear</div>'}
        </td>
        <td>${(s.choferes||[]).slice(0,2).join(' / ')||'<span class="sub">sin chofer</span>'}
          <div class="sub" style="font-size:11px">${s.cargas} carga${s.cargas===1?'':'s'}</div></td>
        <td class="num mono">${Math.round(s.litros).toLocaleString('es-AR')}</td>
        <td class="num money">${money(s.monto)}</td>
        <td class="num"><b style="color:var(--ambar)">${(Math.round(s.pct*10)/10).toFixed(1)}%</b></td>
        <td>${s.patente?selObj(s,ix):'<span class="sub" style="font-size:11px">necesita patente</span>'}</td>
      </tr>`).join('')}
      <tr style="border-top:2px solid var(--linea)">
        <td colspan="3"><b>Total sin asignar</b></td>
        <td class="num money"><b style="color:var(--ambar)">${money(t.sin_asignar)}</b></td>
        <td class="num"><b style="color:var(--ambar)">${Math.round(t.pct_sin_asignar)}%</b></td><td></td></tr>
      </tbody></table>
    </div>`:`
    <div class="panel" style="border-left:3px solid var(--brote)">
      <div style="display:flex;align-items:center;gap:10px;padding:4px 0">
        <span style="font-size:19px">✅</span>
        <div><div style="font-weight:600;font-size:14px">Todo el remito está asignado</div>
        <div class="sub">Cada carga se resolvió a un objetivo por patente o por chofer.</div></div>
      </div>
    </div>`}`}`;
  }catch(e){view.innerHTML=tabsCompras()+`<div class="cargando-v">No pude consolidar. ${e.message||''}</div>`;}
}
// Asignar el objetivo de una patente: se guarda en el maestro de unidades,
// así vale para todos los remitos futuros.
async function asignarObjetivo(ix,objetivoId){
  if(!objetivoId)return;
  const s=(cbData.sin_asignar||[])[ix];if(!s)return;
  const fila=document.getElementById('sinobj-'+ix);
  if(fila)fila.style.opacity='.5';
  try{
    await api('/api/compras/combustible/asignar',{method:'POST',
      body:JSON.stringify({patente:s.patente,chofer:s.chofer,objetivo_id:objetivoId})});
    go('compras');   // recalcula: la fila desaparece y el objetivo suma
  }catch(e){
    if(fila)fila.style.opacity='1';
    alert('No pude asignar: '+(e.message||''));
  }
}
async function borrarRemitoCb(id,prov){
  if(!confirm(`¿Eliminar el listado de ${prov||'este proveedor'}?\nSe borran todas sus cargas del consolidado. No se puede deshacer.`))return;
  try{
    await api('/api/combustible/remito/'+id,{method:'DELETE'});
    cbSel='';go('compras');
  }catch(e){alert('No pude eliminar: '+(e.message||''));}
}

// Mes de una factura, tolerante a fechas sucias ('2026-05-11', '03/06/2026', vacío)
function mesInv(f){
  const s=String(f.fecha_factura||'').trim();
  let m=s.match(/^(\d{4})-(\d{2})/);if(m)return m[1]+'-'+m[2];
  m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(m)return m[3]+'-'+String(m[2]).padStart(2,'0');
  return 'sin fecha';
}
// Reparte el total de una factura por objetivo o unidad. Si la imputación es por
// ítem, distribuye proporcional al monto de cada ítem; si es total, va entero.
function repartoInv(inv,campo){
  const total=totalFactura(inv);
  if(inv.assignmentMode==='per-item'&&inv.assignments&&Object.keys(inv.assignments).length){
    const items=inv.items||[];
    const partes=Object.entries(inv.assignments).map(([ix,a])=>({a,peso:Math.abs(Number((items[+ix]||{}).monto_sin_iva))||1}));
    const suma=partes.reduce((s,p)=>s+p.peso,0)||1;
    return partes.map(p=>({clave:(p.a&&p.a[campo])||'Sin asignar',monto:total*p.peso/suma}));
  }
  const a=inv.totalAssign||{};
  return [{clave:a[campo]||'Sin asignar',monto:total}];
}
// Calcula todos los indicadores sobre un set de facturas
// El total de una factura es su bruto MENOS las notas de crédito que tenga.
function ncDe(f){return (f.notas_credito||[]).reduce((s,n)=>s+(Number(n.total_sin_iva)||0)+(Number(n.total_iva)||0),0);}
function calcIndicadores(fs){
  const neto=f=>(Number(f.total_sin_iva)||0),iva=f=>(Number(f.total_iva)||0);
  const tot=f=>totalFactura(f);
  const totNeto=fs.reduce((s,f)=>s+neto(f),0),totIva=fs.reduce((s,f)=>s+iva(f),0);
  const totNC=fs.reduce((s,f)=>s+ncDe(f),0);
  const totOtros=fs.reduce((s,f)=>s+otrosPagables(f),0);
  const totTot=totNeto+totIva+totOtros-totNC;
  const porProv={};fs.forEach(f=>{const k=f.proveedor||'Sin nombre';
    porProv[k]=porProv[k]||{docs:0,total:0};porProv[k].docs++;porProv[k].total+=tot(f);});
  const ranking=Object.entries(porProv).map(([nombre,v])=>({nombre,...v,pct:totTot?v.total*100/totTot:0}))
    .sort((a,b)=>b.total-a.total);
  const conc3=ranking.slice(0,3).reduce((s,r)=>s+r.pct,0);
  const agrupar=campo=>{
    const m={};fs.forEach(f=>repartoInv(f,campo).forEach(r=>{m[r.clave]=(m[r.clave]||0)+r.monto;}));
    return Object.entries(m).map(([nombre,total])=>({nombre,total,pct:totTot?total*100/totTot:0}))
      .sort((a,b)=>b.total-a.total);
  };
  return {docs:fs.length,totNeto,totIva,totNC,totTot,ticket:fs.length?totTot/fs.length:0,conc3,
    ranking,porObjetivo:agrupar('objetivo'),porUnidad:agrupar('unidad')};
}

/* ===== Compras · Estado de cuenta (por proveedor) ===== */
// "pagada" es un campo nuevo que vive en el jsonb `data` de cada factura de
// Compras — no existía hasta ahora, así que toda factura sin el campo cuenta
// como pendiente por defecto (no como "sin dato").
function statsProv(fs){
  const total=fs.reduce((s,f)=>s+totalFactura(f),0);
  const pagado=fs.filter(f=>f.pagada).reduce((s,f)=>s+totalFactura(f),0);
  return {total,pagado,pendiente:total-pagado,docs:fs.length,pendDocs:fs.filter(f=>!f.pagada).length};
}
async function vComprasCuenta(view){
  view.innerHTML=tabsCompras()+'<div class="cargando-v">Cargando…</div>';
  try{
    ctaData=await api('/api/compras/facturas');
    // Shell fijo: el buscador vive ACÁ y nunca se vuelve a pintar, así el
    // input no pierde el foco en cada letra (antes se recreaba el <input>
    // en cada tecla porque todo el view se reescribía). Solo #cta-body se
    // actualiza en cada cambio de filtro/selección.
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Compras · Estado de cuenta</div>
      <div class="view-desc">Saldo por proveedor · qué está pagado y qué falta</div></div>
      <button class="btn" onclick="exportarCtaResumenPDF()">⬇ Exportar resumen</button></div>
    ${tabsCompras()}
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <input class="busca" style="width:280px" placeholder="Buscar proveedor…" value="${ctaBusca.replace(/"/g,'&quot;')}" oninput="ctaBusca=this.value;renderCtaBody()">
      <div class="chip-f ${ctaSoloPend?'on':''}" onclick="ctaSoloPend=!ctaSoloPend;renderCtaBody()">Solo con saldo pendiente</div>
      <div class="sub" id="cta-count"></div>
    </div>
    <div id="cta-body"></div>`;
    renderCtaBody();
  }catch(e){view.innerHTML=tabsCompras()+`<div class="cargando-v">No pude cargar el estado de cuenta. ${e.message||''}</div>`;}
}
function renderCtaBody(){
  const cont=document.getElementById('cta-body');if(!cont)return;
  const todas=ctaData||[];
  const porProv={};
  todas.forEach(f=>{const k=f.proveedor||'Sin nombre';(porProv[k]=porProv[k]||[]).push(f);});
  let provs=Object.entries(porProv).map(([nombre,fs])=>({nombre,fs,...statsProv(fs)}));
  const b=ctaBusca.trim().toLowerCase();
  if(b)provs=provs.filter(p=>p.nombre.toLowerCase().includes(b));
  if(ctaSoloPend)provs=provs.filter(p=>p.pendiente>0.5);
  provs.sort((a,b2)=>b2.pendiente-a.pendiente||b2.total-a.total);
  const totGeneral=provs.reduce((s,p)=>s+p.total,0);
  const totPag=provs.reduce((s,p)=>s+p.pagado,0);
  const totPend=provs.reduce((s,p)=>s+p.pendiente,0);
  const cnt=document.getElementById('cta-count');
  if(cnt)cnt.textContent=provs.length+' proveedor'+(provs.length===1?'':'es');
  cont.innerHTML=`
  <div class="kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
    <div class="kpi"><div class="kpi-label">Total facturado</div><div class="kpi-val" style="font-size:21px">${money(totGeneral)}</div><div class="kpi-sub">${provs.reduce((s,p)=>s+p.docs,0)} facturas · ${provs.length} proveedores</div></div>
    <div class="kpi plain"><div class="kpi-label">Pagado</div><div class="kpi-val green" style="font-size:21px">${money(totPag)}</div><div class="kpi-sub">${totGeneral?Math.round(totPag*100/totGeneral)+'%':'—'}</div></div>
    <div class="kpi ${totPend?'amber':'plain'}"><div class="kpi-label">Pendiente</div><div class="kpi-val ${totPend?'amber':''}" style="font-size:21px">${money(totPend)}</div><div class="kpi-sub">por pagar</div></div>
  </div>
  <div class="split">
    <div class="tablewrap"><table><thead><tr><th>Proveedor</th><th class="num">Facturas</th><th class="num">Total</th><th class="num">Pagado</th><th class="num">Pendiente</th></tr></thead>
    <tbody id="cta-list">${provs.length?provs.map(p=>`<tr onclick="selProvCta('${p.nombre.replace(/'/g,"\\'")}')" style="cursor:pointer;${p.nombre===ctaProvSel?'outline:2px solid var(--brote)':''}">
      <td style="font-weight:600">${p.nombre}</td>
      <td class="num">${p.docs}</td>
      <td class="num money">${money(p.total)}</td>
      <td class="num money" style="color:var(--brote-2)">${p.pagado?money(p.pagado):'—'}</td>
      <td class="num money" style="${p.pendiente>0.5?'color:var(--rojo);font-weight:600':''}">${p.pendiente>0.5?money(p.pendiente):'✓'}</td>
    </tr>`).join(''):'<tr><td colspan="5"><div class="sub" style="padding:14px">Ningún proveedor coincide.</div></td></tr>'}</tbody></table></div>
    <div class="side" id="cta-side">${ctaProvSel?'':'<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5z"/><path d="M14 2v6h6"/></svg><div>Elegí un proveedor<br>para ver sus facturas</div></div>'}</div>
  </div>`;
  if(ctaProvSel)pintarCtaSide();
}
function selProvCta(nombre){ctaProvSel=(ctaProvSel===nombre)?null:nombre;renderCtaBody();}
function pintarCtaSide(){
  const cont=document.getElementById('cta-side');if(!cont)return;
  const fs=(ctaData||[]).filter(f=>(f.proveedor||'Sin nombre')===ctaProvSel)
    .sort((a,b)=>String(b.fecha_factura||'').localeCompare(String(a.fecha_factura||'')));
  const s=statsProv(fs);
  cont.innerHTML=`
    <div class="side-id">PROVEEDOR</div>
    <div class="side-title">${ctaProvSel}</div>
    <div class="side-meta">${s.docs} factura${s.docs===1?'':'s'} · ${s.pendDocs} pendiente${s.pendDocs===1?'':'s'}</div>
    <div style="display:flex;gap:10px;margin:12px 0">
      <div class="extract-field" style="flex:1"><label>Total</label><div class="val filled">${money(s.total)}</div></div>
      <div class="extract-field" style="flex:1"><label>Pendiente</label><div class="val ${s.pendiente>0.5?'filled':''}" style="${s.pendiente>0.5?'color:var(--rojo)':''}">${money(s.pendiente)}</div></div>
    </div>
    <button class="btn ghost" style="width:100%;justify-content:center;margin-bottom:14px" onclick="exportarCtaProveedorPDF('${ctaProvSel.replace(/'/g,"\\'")}')">⬇ Exportar estado de cuenta</button>
    <div class="divider"></div>
    <div class="panel-title" style="margin-bottom:10px">Facturas</div>
    ${fs.map(f=>{
      const bruto=brutoFactura(f);
      const nc=ncFactura(f);
      const neto=bruto-nc;
      return `<div class="queue-item" style="margin-bottom:8px">
        <div style="flex:1;cursor:pointer" onclick="verCompra('${f.id}')"><div style="font-weight:600;font-size:12.5px">${f.numero_factura||'s/n'} · ${fechaAR(f.fecha_factura)}</div>
        <div class="sub mono" style="font-size:11px">${money(neto)}${nc?' (con NC)':''}</div></div>
        <button class="mini-btn" style="flex:0 0 auto;padding:6px 10px;${f.pagada?'color:var(--brote-2);border-color:var(--brote)':''}" onclick="togglePagada('${f.id}',${!f.pagada})">
          ${f.pagada?'✓ Pagada':'Marcar pagada'}
        </button>
      </div>`;
    }).join('')||'<div class="sub" style="padding:8px 0">Sin facturas.</div>'}`;
}
// Marca pagada/pendiente. Reutiliza el PUT de edición: mandar solo {pagada}
// alcanza porque el backend mergea sobre lo que ya existe, no pisa el resto.
async function togglePagada(id,valor){
  try{
    await api('/api/compras/factura/'+id,{method:'PUT',
      body:JSON.stringify({pagada:valor,pagada_at:valor?new Date().toISOString():null})});
    if(document.getElementById('cta-body')){
      const ix=(ctaData||[]).findIndex(f=>String(f.id)===String(id));
      if(ix>-1)ctaData[ix]={...ctaData[ix],pagada:valor,pagada_at:valor?new Date().toISOString():null};
      renderCtaBody();
    }else go('compras');
  }catch(e){alert('No pude actualizar: '+(e.message||''));}
}
// Marca un concepto (percepción/impuesto) como exento o pagable. Guarda toda la
// lista otros_conceptos actualizada (el PUT mergea sobre el resto de la factura).
async function toggleConcepto(id,ix,exento){
  const inv=(comprasVer&&String(comprasVer.id)===String(id))?comprasVer
    :(comprasData||[]).find(f=>String(f.id)===String(id));
  if(!inv||!inv.otros_conceptos||!inv.otros_conceptos[ix])return;
  const nuevos=inv.otros_conceptos.map((o,i)=>i===ix?{...o,exento}:o);
  try{
    const r=await api('/api/compras/factura/'+id,{method:'PUT',
      body:JSON.stringify({otros_conceptos:nuevos})});
    if(comprasVer&&String(comprasVer.id)===String(id))comprasVer=r;
    // refrescar la lista en memoria para que Estado de cuenta/Resumen queden al día
    const j=(comprasData||[]).findIndex(f=>String(f.id)===String(id));
    if(j>-1)comprasData[j]=r;
    go('compras');
  }catch(e){alert('No pude actualizar el concepto: '+(e.message||''));}
}

/* ── Exportar Estado de cuenta a PDF (reporte imprimible, mismo estilo que Compras · Indicadores) ── */
function ctaEstiloReporte(titulo,subtitulo){
  return `<style>
    body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;margin:0;font-size:11px}
    .letterhead{background:#159B51;color:#fff;padding:26px 32px;display:flex;justify-content:space-between;align-items:flex-end}
    .letterhead h1{font-size:20px;margin:0}
    .letterhead .sub{font-size:11.5px;opacity:.9;margin-top:3px}
    .letterhead .fecha{font-size:11px;opacity:.85;text-align:right}
    .body-pad{padding:26px 32px}
    h2{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#0F7E40;border-bottom:2px solid #0F7E40;padding-bottom:4px;margin:22px 0 10px}
    .kpis{display:flex;gap:10px;margin-bottom:6px}
    .kpi{flex:1;border:1px solid #ddd;border-radius:8px;padding:12px 14px}
    .kpi b{display:block;font-size:16px;margin-top:3px}
    .kpi span{font-size:9.5px;letter-spacing:1px;text-transform:uppercase;color:#777}
    table{width:100%;border-collapse:collapse;font-size:10.5px}
    th{text-align:left;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#777;border-bottom:1px solid #ccc;padding:6px 6px}
    td{padding:6px 6px;border-bottom:1px solid #eee;vertical-align:top}
    td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
    tr{page-break-inside:avoid}
    .pill{display:inline-block;padding:2px 8px;border-radius:20px;font-size:9.5px;font-weight:600}
    .pill.ok{background:#E5F5EC;color:#0F7E40}
    .pill.pend{background:#FBF0DC;color:#D98A1F}
    @media print{h2{page-break-after:avoid}}
  </style>`;
}
function exportarCtaResumenPDF(){
  const todas=ctaData||[];
  if(!todas.length){alert('No hay facturas cargadas.');return;}
  const porProv={};
  todas.forEach(f=>{const k=f.proveedor||'Sin nombre';(porProv[k]=porProv[k]||[]).push(f);});
  let provs=Object.entries(porProv).map(([nombre,fs])=>({nombre,...statsProv(fs)}));
  const b=ctaBusca.trim().toLowerCase();
  if(b)provs=provs.filter(p=>p.nombre.toLowerCase().includes(b));
  if(ctaSoloPend)provs=provs.filter(p=>p.pendiente>0.5);
  provs.sort((a,b2)=>b2.pendiente-a.pendiente||b2.total-a.total);
  const totGeneral=provs.reduce((s,p)=>s+p.total,0);
  const totPag=provs.reduce((s,p)=>s+p.pagado,0);
  const totPend=provs.reduce((s,p)=>s+p.pendiente,0);
  const money=n=>'$ '+(Math.round(Number(n)*100)/100).toLocaleString('es-AR',{minimumFractionDigits:2});
  const filas=provs.map(p=>`<tr>
    <td style="font-weight:600">${p.nombre}</td>
    <td class="r">${p.docs}</td>
    <td class="r">${money(p.total)}</td>
    <td class="r">${money(p.pagado)}</td>
    <td class="r">${p.pendiente>0.5?`<b style="color:#D98A1F">${money(p.pendiente)}</b>`:money(0)}</td>
    <td>${p.pendiente>0.5?'<span class="pill pend">Pendiente</span>':'<span class="pill ok">Al día</span>'}</td>
  </tr>`).join('');
  const w=window.open('','_blank');
  if(!w){alert('El navegador bloqueó la ventana del reporte. Habilitá popups para este sitio.');return;}
  w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Estado de cuenta — EcoService</title>${ctaEstiloReporte()}</head><body>
  <div class="letterhead"><div><h1>Estado de cuenta de proveedores</h1><div class="sub">EcoService · resumen general</div></div>
    <div class="fecha">${new Date().toLocaleString('es-AR',{timeZone:'America/Argentina/Cordoba'})}${ctaSoloPend?'<br>Solo con saldo pendiente':''}${b?'<br>Filtro: "'+b+'"':''}</div></div>
  <div class="body-pad">
  <div class="kpis" style="margin-top:6px">
    <div class="kpi"><span>Total facturado</span><b>${money(totGeneral)}</b></div>
    <div class="kpi"><span>Pagado</span><b>${money(totPag)}</b></div>
    <div class="kpi"><span>Pendiente</span><b style="color:#D98A1F">${money(totPend)}</b></div>
    <div class="kpi"><span>Proveedores</span><b>${provs.length}</b></div>
  </div>
  <h2>Por proveedor</h2>
  <table><thead><tr><th>Proveedor</th><th class="r">Facturas</th><th class="r">Total</th><th class="r">Pagado</th><th class="r">Pendiente</th><th>Estado</th></tr></thead>
  <tbody>${filas}</tbody></table>
  </div>
  <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script>
  </body></html>`);
  w.document.close();
}
function exportarCtaProveedorPDF(nombre){
  const fs=(ctaData||[]).filter(f=>(f.proveedor||'Sin nombre')===nombre)
    .sort((a,b)=>String(b.fecha_factura||'').localeCompare(String(a.fecha_factura||'')));
  if(!fs.length){alert('Este proveedor no tiene facturas.');return;}
  const s=statsProv(fs);
  const money=n=>'$ '+(Math.round(Number(n)*100)/100).toLocaleString('es-AR',{minimumFractionDigits:2});
  const filas=fs.map(f=>{
    const bruto=brutoFactura(f);
    const nc=ncFactura(f);
    const neto=bruto-nc;
    return `<tr>
      <td>${fechaAR(f.fecha_factura)}</td>
      <td>${f.numero_factura||'s/n'}</td>
      <td class="r">${money(bruto)}</td>
      <td class="r">${nc?'−'+money(nc):'—'}</td>
      <td class="r"><b>${money(neto)}</b></td>
      <td>${f.pagada?'<span class="pill ok">Pagada'+(f.pagada_at?' · '+fechaAR(f.pagada_at):'')+'</span>':'<span class="pill pend">Pendiente</span>'}</td>
    </tr>`;
  }).join('');
  const w=window.open('','_blank');
  if(!w){alert('El navegador bloqueó la ventana del reporte. Habilitá popups para este sitio.');return;}
  w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Estado de cuenta — ${nombre}</title>${ctaEstiloReporte()}</head><body>
  <div class="letterhead"><div><h1>${nombre}</h1><div class="sub">Estado de cuenta · EcoService</div></div>
    <div class="fecha">${new Date().toLocaleString('es-AR',{timeZone:'America/Argentina/Cordoba'})}</div></div>
  <div class="body-pad">
  <div class="kpis" style="margin-top:6px">
    <div class="kpi"><span>Total facturado</span><b>${money(s.total)}</b></div>
    <div class="kpi"><span>Pagado</span><b>${money(s.pagado)}</b></div>
    <div class="kpi"><span>Saldo pendiente</span><b style="color:${s.pendiente>0.5?'#D98A1F':'#0F7E40'}">${money(s.pendiente)}</b></div>
    <div class="kpi"><span>Facturas</span><b>${s.docs}</b></div>
  </div>
  <h2>Detalle de facturas</h2>
  <table><thead><tr><th>Fecha</th><th>N° Factura</th><th class="r">Bruto</th><th class="r">NC</th><th class="r">Neto</th><th>Estado</th></tr></thead>
  <tbody>${filas}</tbody>
  <tr style="border-top:2px solid #ccc"><td colspan="4"><b>Total</b></td><td class="r"><b>${money(s.total)}</b></td><td></td></tr>
  </table>
  </div>
  <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script>
  </body></html>`);
  w.document.close();
}

/* ── Compras · Consumos por objetivo ─────────────────────────
   Responde "¿cuántas cadenas consumió tal objetivo?" con los datos que ya
   están en las facturas: cada ítem hereda el objetivo de su asignación
   (por ítem si existe, si no la de la factura completa). */
let consObjSel='', consBusca='', consMes='', consArtSel=null;
// Aplana todas las facturas a líneas {obj, uni, desc, cant, monto, fecha, prov, nro, invId}
function consLineas(){
  const out=[];
  (comprasData||[]).forEach(f=>{
    const tot=asignacionInv(f);
    const items=(f.items||[]).length?f.items
      :[{descripcion:'(factura sin detalle de ítems)',cantidad:1,
         monto_sin_iva:Number(f.total_sin_iva)||0,monto_iva:Number(f.total_iva)||0}];
    items.forEach((it,ix)=>{
      const asg=(f.assignmentMode==='per-item'?(f.assignments||{})[ix]:null)||{};
      out.push({
        obj:asg.objetivo||tot.obj||'Sin asignar',
        uni:asg.unidad||tot.uni||'',
        desc:(it.descripcion||'(sin descripción)').trim(),
        cant:Number(it.cantidad)||1,
        monto:(Number(it.monto_sin_iva)||0)+(Number(it.monto_iva)||0),
        fecha:f.fecha_factura||'',prov:f.proveedor||'—',nro:f.numero_factura||'s/n',invId:f.id,
      });
    });
  });
  return out;
}
async function vComprasConsumos(view){
  view.innerHTML=tabsCompras()+'<div class="cargando-v">Cargando…</div>';
  try{
    comprasData=await api('/api/compras/facturas');
    const lineas=consLineas();
    const objetivos=[...new Set(lineas.map(l=>l.obj))].sort((a,b)=>a==='Sin asignar'?1:b==='Sin asignar'?-1:a.localeCompare(b));
    if(!consObjSel||!objetivos.includes(consObjSel))consObjSel=objetivos[0]||'';
    const meses=[...new Set(lineas.map(l=>String(l.fecha).slice(0,7)))].filter(m=>m&&m.length===7).sort().reverse();
    // Shell fija: selector + buscador nunca se re-renderizan (foco a salvo)
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Compras · Consumos por objetivo</div>
      <div class="view-desc">Qué se compró e imputó a cada objetivo, agrupado por artículo</div></div></div>
    ${tabsCompras()}
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <select class="busca" style="width:220px" onchange="consObjSel=this.value;consArtSel=null;renderConsBody()">
        ${objetivos.map(o=>`<option value="${o.replace(/"/g,'&quot;')}" ${o===consObjSel?'selected':''}>${o}</option>`).join('')}
      </select>
      <input class="busca" style="width:240px" placeholder="Buscar artículo (ej. cadena)…" value="${consBusca.replace(/"/g,'&quot;')}" oninput="consBusca=this.value;renderConsBody()">
      <select class="busca" style="width:150px" onchange="consMes=this.value;renderConsBody()">
        <option value="">Todo el período</option>
        ${meses.map(m=>`<option value="${m}" ${m===consMes?'selected':''}>${m}</option>`).join('')}
      </select>
      <div class="sub" id="cons-count"></div>
    </div>
    <div id="cons-body"></div>`;
    renderConsBody();
  }catch(e){view.innerHTML=tabsCompras()+`<div class="cargando-v">No pude cargar consumos. ${e.message||''}</div>`;}
}
function renderConsBody(){
  const cont=document.getElementById('cons-body');if(!cont)return;
  const b=consBusca.trim().toLowerCase();
  let lineas=consLineas().filter(l=>l.obj===consObjSel);
  if(consMes)lineas=lineas.filter(l=>String(l.fecha).startsWith(consMes));
  if(b)lineas=lineas.filter(l=>l.desc.toLowerCase().includes(b));
  // Agrupar por descripción (clave normalizada, se muestra la primera aparición)
  const grupos={};
  lineas.forEach(l=>{const k=l.desc.toLowerCase();
    (grupos[k]=grupos[k]||{desc:l.desc,cant:0,monto:0,lineas:[]});
    grupos[k].cant+=l.cant;grupos[k].monto+=l.monto;grupos[k].lineas.push(l);});
  const arts=Object.entries(grupos).map(([k,g])=>({k,...g,facturas:new Set(g.lineas.map(x=>x.invId)).size}))
    .sort((a,b2)=>b2.monto-a.monto);
  const totMonto=arts.reduce((s,a)=>s+a.monto,0);
  const totFacturas=new Set(lineas.map(l=>l.invId)).size;
  const cnt=document.getElementById('cons-count');
  if(cnt)cnt.textContent=arts.length+' artículo'+(arts.length===1?'':'s');
  if(consArtSel&&!grupos[consArtSel])consArtSel=null;
  cont.innerHTML=`
  <div class="kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
    <div class="kpi"><div class="kpi-label">Consumido en ${consObjSel}</div><div class="kpi-val" style="font-size:21px">${money(totMonto)}</div><div class="kpi-sub">${consMes||'todo el período'}${b?' · "'+b+'"':''}</div></div>
    <div class="kpi plain"><div class="kpi-label">Artículos distintos</div><div class="kpi-val" style="font-size:21px">${arts.length}</div><div class="kpi-sub">agrupados por descripción</div></div>
    <div class="kpi plain"><div class="kpi-label">Facturas</div><div class="kpi-val" style="font-size:21px">${totFacturas}</div><div class="kpi-sub">involucradas</div></div>
  </div>
  <div class="split">
    <div class="tablewrap"><table><thead><tr><th>Artículo</th><th class="num">Cantidad</th><th class="num">Monto</th><th class="num">Facturas</th></tr></thead>
    <tbody>${arts.length?arts.map(a=>`<tr onclick="consArtSel=consArtSel==='${a.k.replace(/'/g,"\\'")}'?null:'${a.k.replace(/'/g,"\\'")}';renderConsBody()" style="cursor:pointer;${consArtSel===a.k?'outline:2px solid var(--brote)':''}">
      <td style="font-weight:600">${a.desc.slice(0,70)}${a.desc.length>70?'…':''}</td>
      <td class="num">${a.cant%1?a.cant.toFixed(2):a.cant}</td>
      <td class="num money">${money(a.monto)}</td>
      <td class="num">${a.facturas}</td>
    </tr>`).join(''):'<tr><td colspan="4"><div class="sub" style="padding:14px">'+(b?'Ningún artículo coincide con "'+consBusca+'" en este objetivo.':'Este objetivo no tiene compras imputadas'+(consMes?' en '+consMes:'')+'.')+'</div></td></tr>'}</tbody></table></div>
    <div class="side" id="cons-side">${consArtSel?'':'<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg><div>Elegí un artículo<br>para ver sus facturas</div></div>'}</div>
  </div>`;
  if(consArtSel)pintarConsSide(grupos[consArtSel]);
}
function pintarConsSide(g){
  const cont=document.getElementById('cons-side');if(!cont||!g)return;
  const ls=g.lineas.slice().sort((a,b)=>String(b.fecha).localeCompare(String(a.fecha)));
  cont.innerHTML=`
    <div class="side-id">ARTÍCULO</div>
    <div class="side-title" style="font-size:14px">${g.desc}</div>
    <div class="side-meta">${consObjSel} · ${g.cant%1?g.cant.toFixed(2):g.cant} unidades · ${money(g.monto)}</div>
    <div class="divider"></div>
    <div class="panel-title" style="margin-bottom:8px">Compras</div>
    ${ls.map(l=>`<div class="queue-item" style="cursor:pointer" onclick="verCompra('${l.invId}')">
      <div style="flex:1"><div style="font-weight:600;font-size:12.5px">${l.prov}</div>
      <div class="sub mono" style="font-size:11px">${l.nro} · ${fechaAR(l.fecha)}${l.uni?' · '+l.uni:''}</div></div>
      <div style="text-align:right"><div class="money" style="font-size:12.5px">${money(l.monto)}</div>
      <div class="sub" style="font-size:11px">x${l.cant%1?l.cant.toFixed(2):l.cant}</div></div>
    </div>`).join('')}`;
}

/* ── Compras · Repuestos de taller ───────────────────────────
   Lo que el taller espera para reparar: pedidos cargados por el mecánico
   (app) o desde el detalle de la reparación (panel). */
let rtData=null, rtEstado='', rtBusca='';
async function vComprasRepuestos(view){
  view.innerHTML=tabsCompras()+'<div class="cargando-v">Cargando…</div>';
  try{
    rtData=await api('/api/compras/repuestos');
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Compras · Repuestos de taller</div>
      <div class="view-desc">Lo que el taller espera para reparar — pedidos de los mecánicos con sus notas</div></div></div>
    ${tabsCompras()}
    <div id="rt-kpis"></div>
    <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div class="toggle-imp" style="margin:0">
        ${[['','Todos'],['a_comprar','A comprar'],['comprado','Comprados'],['entregado','Entregados']].map(([v,l])=>
          `<button class="${rtEstado===v?'on':''}" onclick="rtEstado='${v}';renderRt()">${l}</button>`).join('')}
      </div>
      <input class="busca" style="width:250px" placeholder="Buscar repuesto, unidad o equipo…" value="${rtBusca.replace(/"/g,'&quot;')}" oninput="rtBusca=this.value;renderRt()">
    </div>
    <div id="rt-lista"></div>`;
    renderRt();
  }catch(e){view.innerHTML=tabsCompras()+`<div class="cargando-v">${e.message||'No pude cargar repuestos.'}<br><span class="sub">¿Creaste la tabla repuestos_taller en Supabase?</span></div>`;}
}
function renderRt(){
  const kp=document.getElementById('rt-kpis'),ls=document.getElementById('rt-lista');
  if(!kp||!ls)return;
  const all=rtData||[];
  const cnt=e=>all.filter(p=>p.estado===e);
  const abiertos=all.filter(p=>p.estado!=='entregado');
  const itFaltan=abiertos.reduce((s,p)=>s+(p.items||[]).filter(i=>!i.comprado).length,0);
  const itComprados=abiertos.reduce((s,p)=>s+(p.items||[]).filter(i=>i.comprado).length,0);
  const repFaltan=abiertos.filter(p=>(p.items||[]).some(i=>!i.comprado)).length;
  const sem=Date.now()-7*86400000;
  const entSem=all.filter(p=>p.estado==='entregado'&&p.entregado_at&&new Date(p.entregado_at)>sem);
  kp.innerHTML=`<div class="kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">
    <div class="kpi ${itFaltan?'amber':'plain'}" onclick="rtEstado='a_comprar';renderRt()" style="cursor:pointer">
      <div class="kpi-label">Falta comprar</div><div class="kpi-val" style="${itFaltan?'color:var(--diesel)':''}">${itFaltan} ítems</div>
      <div class="kpi-sub">de ${repFaltan} reparación${repFaltan===1?'':'es'}</div></div>
    <div class="kpi plain" onclick="rtEstado='comprado';renderRt()" style="cursor:pointer">
      <div class="kpi-label">Comprados · en camino</div><div class="kpi-val">${itComprados} ítems</div>
      <div class="kpi-sub">${cnt('comprado').length} pedido${cnt('comprado').length===1?'':'s'} completo${cnt('comprado').length===1?'':'s'}</div></div>
    <div class="kpi plain" onclick="rtEstado='entregado';renderRt()" style="cursor:pointer">
      <div class="kpi-label">Entregados al taller</div><div class="kpi-val">${entSem.reduce((s,p)=>s+(p.items||[]).length,0)} ítems</div>
      <div class="kpi-sub">esta semana</div></div>
  </div>`;
  const b=rtBusca.trim().toLowerCase();
  const lista=all.filter(p=>{
    if(rtEstado&&p.estado!==rtEstado)return false;
    if(!b)return true;
    const inc=p.incidencias||{};
    const txt=[(inc.tipo_equipo||''),(inc.equipos&&inc.equipos.nombre||''),(inc.numero_unidad||''),
      ...(p.items||[]).map(i=>i.descripcion+' '+(i.codigo||''))].join(' ').toLowerCase();
    return txt.includes(b);
  });
  const EST={a_comprar:['A COMPRAR','b-amber'],comprado:['✓ TODO COMPRADO','b-blue'],entregado:['✓ ENTREGADO','b-green']};
  ls.innerHTML=lista.length?lista.map(p=>{
    const inc=p.incidencias||{};
    const eq=[inc.tipo_equipo||(inc.equipos&&(inc.equipos.nombre||inc.equipos.tipo))||'Equipo',
              inc.numero_unidad?'· N° '+inc.numero_unidad:''].join(' ');
    const dias=Math.floor((Date.now()-new Date(p.created_at))/86400000);
    const [etq,cls]=EST[p.estado]||[p.estado,'b-gray'];
    const done=p.estado==='entregado';
    const its=p.items||[];
    const nComp=its.filter(i=>i.comprado).length;
    const parcial=!done&&nComp>0&&nComp<its.length;
    return `<div class="panel" style="margin-bottom:10px;${done?'opacity:.62':''}">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="badge ${PRIO_BADGE[inc.prioridad]||'b-gray'}">${cap(inc.prioridad||'—')}</span>
        <span style="font-weight:700;font-size:13.5px">${eq}</span>
        <span class="sub" style="font-size:12px">${inc.objetivos?inc.objetivos.nombre:''}</span>
        <div style="flex:1"></div>
        ${parcial?`<span class="badge b-amber">PARCIAL · ${nComp}/${its.length} comprados</span>`:`<span class="badge ${cls}">${etq}${done&&p.entregado_at?' · '+fechaAR(p.entregado_at):''}</span>`}
      </div>
      <div class="sub" style="font-size:12px;margin:5px 0 8px">👨‍🔧 ${inc.mecanicos?inc.mecanicos.nombre:(p.pedido_por||'—')} · pedido ${dias===0?'hoy':'hace '+dias+' día'+(dias===1?'':'s')}${!done&&dias>=3?' <b style="color:var(--rojo)">⚠</b>':''}</div>
      ${its.map((i,idx)=>done
        ?`<div style="font-size:12.5px;padding:2px 0"><span class="mono" style="color:var(--tinta-2)">x${i.cantidad||1}</span> <b>${i.descripcion}</b>${i.codigo?' · <span class="mono" style="color:var(--tinta-3)">'+i.codigo+'</span>':''}</div>`
        :`<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding:3px 0;cursor:pointer">
            <input type="checkbox" ${i.comprado?'checked':''} onchange="rtItem('${p.id}',${idx},this.checked)" style="accent-color:var(--brote)">
            <span style="${i.comprado?'':'font-weight:600'}"><span class="mono" style="color:var(--tinta-2)">x${i.cantidad||1}</span> ${i.descripcion}${i.codigo?' · <span class="mono" style="color:var(--tinta-3)">'+i.codigo+'</span>':''}</span>
            ${i.comprado?'<span class="badge b-green" style="font-size:10px">comprado</span>':'<span class="badge b-amber" style="font-size:10px">falta</span>'}
          </label>`).join('')}
      ${p.nota?`<div style="background:var(--papel);border-left:3px solid var(--tinta-3);border-radius:6px;padding:7px 10px;font-size:12px;font-style:italic;margin-top:7px">💬 "${p.nota}" — ${(p.pedido_por||'').replace('Panel · ','')}</div>`:''}
      ${!done?`<div style="display:flex;gap:8px;margin-top:10px;align-items:center">
        ${p.estado!=='comprado'?`<button class="btn ghost" style="padding:7px 14px;font-size:12.5px" onclick="rtAvanzar('${p.id}','comprado')">✓ Marcar todo comprado</button>`:''}
        ${p.estado==='comprado'
          ?`<button class="btn" style="padding:7px 14px;font-size:12.5px" onclick="rtAvanzar('${p.id}','entregado')">📦 Marcar entregado al taller</button>`
          :`<span class="sub" style="font-size:11.5px">Se entrega al taller cuando esté todo comprado</span>`}
        <button class="btn ghost" style="padding:7px 14px;font-size:12.5px" onclick="go('reparaciones')">Ver reparación →</button>
      </div>`:''}
    </div>`;}).join('')
    :`<div class="empty" style="height:160px"><div>${b||rtEstado?'Ningún pedido coincide.':'No hay pedidos de repuestos.<br><span class=\"sub\">Se cargan desde la app del mecánico o desde el detalle de una reparación.</span>'}</div></div>`;
}
async function rtItem(id,idx,comprado){
  try{
    const actualizado=await api('/api/compras/repuestos/'+id+'/item',{method:'POST',body:JSON.stringify({index:idx,comprado})});
    const p=(rtData||[]).find(x=>x.id===id);
    if(p){p.items=actualizado.items;p.estado=actualizado.estado;}
    renderRt();
  }catch(e){alert('No pude actualizar: '+e.message);renderRt();}
}
async function rtAvanzar(id,estado){
  try{
    await api('/api/compras/repuestos/'+id+'/estado',{method:'POST',body:JSON.stringify({estado})});
    const p=(rtData||[]).find(x=>x.id===id);
    if(p){p.estado=estado;if(estado==='entregado')p.entregado_at=new Date().toISOString();}
    renderRt();
  }catch(e){alert('No pude actualizar: '+e.message);}
}

async function vComprasInd(view){
  try{
    comprasIndData=await api('/api/compras/facturas');
    const todas=comprasIndData;
    const meses=[...new Set(todas.map(mesInv))].filter(m=>m!=='sin fecha').sort().reverse();
    if(comprasIndPer===null)comprasIndPer=meses[0]||'';   // arranca en el último mes con datos
    const fs=comprasIndPer?todas.filter(f=>mesInv(f)===comprasIndPer):todas;
    const k=calcIndicadores(fs);
    const M=n=>'$ '+(Number(n||0)/1e6).toLocaleString('es-AR',{minimumFractionDigits:1,maximumFractionDigits:1})+' M';
    const D=86400000, hoyMs=Date.now();
    const normCuit=c=>String(c||'').replace(/\D/g,'');
    const CUIT_PROPIO='30707930299';
    const fechaFactMs=f=>{const s=String(f.fecha_factura||'').trim();
      let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);if(m)return new Date(+m[1],+m[2]-1,+m[3]).getTime();
      m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(m)return new Date(+m[3],+m[2]-1,+m[1]).getTime();
      return null;};
    const esPagada=f=>f.pagada===true||f.pagada==='true';

    // Evolución (todas), para las barras y la variación
    const porMes={};todas.forEach(f=>{const m=mesInv(f);if(m==='sin fecha')return;
      porMes[m]=porMes[m]||{total:0,docs:0};porMes[m].docs++;porMes[m].total+=totalFactura(f);});
    const serie=Object.entries(porMes).sort((a,b)=>a[0].localeCompare(b[0])).slice(-6)
      .map(([m,v])=>({mes:m,...v}));
    const idxRef=serie.findIndex(s=>s.mes===comprasIndPer);
    const totRef=comprasIndPer?(porMes[comprasIndPer]?porMes[comprasIndPer].total:0):k.totTot;
    const totPrev=idxRef>0?serie[idxRef-1].total:null;
    const varGasto=(totPrev&&comprasIndPer)?((totRef-totPrev)*100/totPrev):null;
    const mediana=[...serie.map(s=>s.total)].sort((a,b)=>a-b)[Math.floor(serie.length/2)]||0;
    const maxSerie=Math.max(...serie.map(s=>s.total),1);
    const hayAtipico=serie.some(s=>mediana&&s.total>mediana*2.5);
    const barrasMes=serie.length?`<div style="display:flex;align-items:flex-end;gap:8px;height:96px;margin-top:20px;padding-bottom:18px">
      ${serie.map(s=>{const atip=mediana&&s.total>mediana*2.5;
        const act=s.mes===comprasIndPer;
        return `<div style="flex:1;position:relative;height:${Math.max(8,Math.round(s.total*100/maxSerie))}%;background:${act?'var(--diesel-soft)':atip?'var(--azul-soft)':'var(--brote-soft)'};border-top:3px solid ${act?'var(--diesel)':atip?'var(--azul)':'var(--brote)'};border-radius:3px 3px 0 0">
          <b style="position:absolute;top:-17px;left:0;right:0;text-align:center;font-size:10px;font-family:'JetBrains Mono',monospace;color:var(--tinta-2);font-weight:600">${(s.total/1e6).toLocaleString('es-AR',{maximumFractionDigits:1})}</b>
          <span style="position:absolute;bottom:-16px;left:0;right:0;text-align:center;font-size:9.5px;color:var(--tinta-3)">${s.mes.slice(5)}/${s.mes.slice(2,4)}${atip?'*':''}</span>
        </div>`;}).join('')}</div>
      ${hayAtipico?'<div class="sub" style="font-size:10.5px;margin-top:4px">* pico atípico — puede incluir carga de comprobantes históricos, no solo gasto del mes</div>':''}`
      :'<div class="sub" style="padding:10px 0">Sin datos</div>';

    // Proveedores del período, agrupados por CUIT (mata duplicados de nombre)
    const porProv={};
    fs.forEach(f=>{
      const key=normCuit(f.cuit)||('nom:'+String(f.proveedor||'Sin proveedor').toLowerCase().trim());
      const o=porProv[key]||(porProv[key]={nombres:{},total:0,docs:0,cuit:normCuit(f.cuit)});
      o.total+=totalFactura(f);o.docs++;
      const n=String(f.proveedor||'Sin proveedor').trim();o.nombres[n]=(o.nombres[n]||0)+1;});
    const provs=Object.values(porProv).map(o=>({
      nombre:Object.entries(o.nombres).sort((a,b)=>b[1]-a[1])[0][0],
      total:o.total,docs:o.docs,cuit:o.cuit})).sort((a,b)=>b.total-a.total);
    const totProv=provs.reduce((s,p)=>s+p.total,0)||1;
    let acum=0;
    const topProv=provs.slice(0,4).map(p=>{acum+=p.total;return {...p,pctAcum:acum*100/totProv};});
    const otros=provs.slice(4);
    const maxProv=topProv.length?topProv[0].total:1;

    // Deuda viva (foto de hoy, sobre TODAS) + aging + CUIT propio
    const impagas=todas.filter(f=>!esPagada(f));
    const aging={a:0,b:0,c:0}; let mas60Propio=0, mas60PropioN=0, mas60Resto=0;
    const cuitPropioTotal=todas.filter(f=>normCuit(f.cuit)===CUIT_PROPIO).length;
    impagas.forEach(f=>{
      const t=totalFactura(f), fm=fechaFactMs(f);
      const d=fm==null?999:Math.floor((hoyMs-fm)/D);
      const k2=d<=30?'a':d<=60?'b':'c';
      aging[k2]+=t;
      if(k2==='c'){if(normCuit(f.cuit)===CUIT_PROPIO){mas60Propio+=t;mas60PropioN++;}else mas60Resto+=t;}
    });
    const deudaViva=aging.a+aging.b+aging.c;
    const maxAg=Math.max(aging.a,aging.b,aging.c,1);
    const agFila=(lbl,v,color)=>`<div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">
      <span style="width:86px;font-size:12px;font-weight:500">${lbl}</span>
      <div class="pv-bar" style="max-width:none"><i style="width:${Math.max(3,Math.round(v*100/maxAg))}%;background:${color}"></i></div>
      <span class="mono" style="width:110px;text-align:right;font-size:12px;font-weight:600">${M(v)}</span></div>`;

    // Gasto por objetivo: contratos vs "EMPRESA / sin abrir"
    const esGeneral=n=>/^(empresa|sin asignar|sin imputar|general)$/i.test(String(n||'').trim());
    const objs=(k.porObjetivo||[]);
    const objContratos=objs.filter(o=>!esGeneral(o.nombre)).slice(0,4);
    const objGeneral=objs.filter(o=>esGeneral(o.nombre)).reduce((s,o)=>s+o.total,0);
    const totObj=objs.reduce((s,o)=>s+o.total,0)||1;
    const pctImputado=Math.round((totObj-objGeneral)*100/totObj);
    const maxObj=Math.max(...objContratos.map(o=>o.total),objGeneral,1);
    const objFila=(nom,v,color,sub)=>`<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <span style="width:165px;font-size:12px;font-weight:500;flex-shrink:0">${nom}${sub?'<span style="display:block;font-size:10px;color:var(--tinta-3);font-weight:400">'+sub+'</span>':''}</span>
      <div class="pv-bar" style="max-width:none"><i style="width:${Math.max(3,Math.round(v*100/maxObj))}%;background:${color}"></i></div>
      <span class="mono" style="width:96px;text-align:right;font-size:12px;font-weight:600">${M(v)}</span></div>`;

    // Controles: remitos +30d, CUIT propio, duplicados de número, NC, gasoil
    let fugas=null;
    try{
      const cargas=await api('/api/combustible');
      const sf=(cargas||[]).filter(c=>c.estado==='sin_facturar');
      const viejas=sf.filter(c=>c.fecha&&((hoyMs-new Date(c.fecha).getTime())/D)>30);
      fugas={viejas:viejas.length,litros:viejas.reduce((s,c)=>s+(Number(c.litros_total)||0),0),recientes:sf.length-viejas.length};
    }catch(e){}
    const vistos={},dups=[];
    todas.forEach(f=>{const n=String(f.numero_factura||'').trim();if(!n)return;
      const kk=normCuit(f.cuit)+'|'+n;if(vistos[kk])dups.push(n);else vistos[kk]=1;});
    const RX_GASOIL=/gas\s*oil|gasoil|diesel|di[eé]sel/i;
    let gasLt=0,gasImp=0;
    fs.forEach(f=>(f.items||[]).forEach(it=>{
      if(!RX_GASOIL.test(String(it.descripcion||'')))return;
      const lt=Number(it.cantidad)||0,imp=Number(it.importe)||0;
      if(lt>0&&imp>0){gasLt+=lt;gasImp+=imp;}}));
    const senales=[];
    if(fugas&&fugas.viejas)senales.push(['var(--diesel)',`<b>${fugas.viejas} remito(s) de combustible sin factura hace +30 días</b> (${Math.round(fugas.litros).toLocaleString('es-AR')} lt)${fugas.recientes?' · los '+fugas.recientes+' recientes son flujo normal de facturación':''}.`]);
    else if(fugas)senales.push(['var(--brote)',`<b>Remitos de combustible al día</b>${fugas.recientes?' · '+fugas.recientes+' en ciclo normal de facturación':''}.`]);
    if(cuitPropioTotal)senales.push(['var(--diesel)',`<b>${cuitPropioTotal} factura(s) con el CUIT de EcoService como proveedor</b> — lectura errónea del comprobante: corregirlas desde el Resumen antes de reclamar nada.`]);
    if(dups.length)senales.push(['var(--rojo)',`<b>Posibles duplicadas:</b> ${[...new Set(dups)].slice(0,3).join(', ')} — mismo número y CUIT cargados dos veces.`]);
    senales.push([gasLt?'var(--brote)':'var(--tinta-3)',gasLt
      ?`<b>Gasoil facturado: $ ${Math.round(gasImp/gasLt).toLocaleString('es-AR')}/lt</b> · ${Math.round(gasLt).toLocaleString('es-AR')} lt en el período.`
      :`<b>Sin gasoil facturado por el proveedor en el período</b> — el $/litro aparece acá cuando entren esas facturas.`]);
    senales.push([k.totNC?'var(--brote)':'var(--tinta-3)',k.totNC
      ?`<b>Notas de crédito recuperadas: ${M(k.totNC)}</b> en el período.`
      :`<b>Notas de crédito:</b> $ 0 reclamado en el período.`]);
    const nAlertas=senales.filter(s=>s[0]==='var(--diesel)'||s[0]==='var(--rojo)').length;

    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Compras · Indicadores</div>
      <div class="view-desc">La plata que sale, en una pantalla</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        <select class="busca" style="width:auto" onchange="comprasIndPer=this.value;go('compras')">
          ${meses.map(m=>`<option value="${m}" ${m===comprasIndPer?'selected':''}>${mesStk(m)}</option>`).join('')}
          <option value="" ${comprasIndPer===''?'selected':''}>Todo el período</option>
        </select>
        <button class="btn" onclick="exportarComprasPDF()">⬇ PDF</button>
      </div></div>
    ${tabsCompras()}
    <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
      <div class="kpi"><div class="kpi-label">¿Cuánto gasté?</div><div class="kpi-val" style="font-size:23px">${M(k.totTot)}</div>
        <div class="kpi-sub">${varGasto!=null?'<b style="color:'+(varGasto>=0?'#A32D2D':'var(--brote-2)')+'">'+(varGasto>0?'▲ +':'▼ ')+Math.round(varGasto*10)/10+'% vs mes anterior</b> · ':''}${k.docs} facturas<br>neto ${M(k.totNeto)} · IVA ${M(k.totIva)}</div></div>
      <div class="kpi ${aging.c?'amber':'plain'}"><div class="kpi-label">¿Cuánto debo?</div><div class="kpi-val" style="font-size:23px;color:#A32D2D">${M(deudaViva)}</div>
        <div class="kpi-sub">${impagas.length} facturas sin pagar${aging.c?'<br><b style="color:#A32D2D">'+M(aging.c)+' con más de 60 días</b>':''}</div></div>
      <div class="kpi plain"><div class="kpi-label">¿A quién?</div><div class="kpi-val" style="font-size:23px">${Math.round(k.conc3*10)/10}%</div>
        <div class="kpi-sub">del gasto en 3 proveedores<br>${k.conc3>=50?'<b style="color:#854F0B">alta concentración — dependencia a vigilar</b>':'compra repartida — sin dependencia crítica'}</div></div>
      <div class="kpi ${nAlertas?'amber':'plain'}"><div class="kpi-label">¿Está todo en orden?</div><div class="kpi-val" style="font-size:23px;${nAlertas?'color:#854F0B':'color:var(--brote-2)'}">${nAlertas?nAlertas+' ⚠':'✓'}</div>
        <div class="kpi-sub">${nAlertas?'punto(s) que merecen una mirada — detalle abajo':'controles automáticos sin observaciones'}</div></div>
    </div>
    <div class="grid g-2" style="margin-bottom:14px">
      <div class="panel"><div class="panel-title">El gasto, mes a mes <span class="sub" style="font-weight:400;font-size:11px">· últimos 6 meses, en millones</span></div>${barrasMes}</div>
      <div class="panel"><div class="panel-title">¿A quién se le va la plata? <span class="sub" style="font-weight:400;font-size:11px">· % acumulado · agrupado por CUIT</span></div>
        ${topProv.map(p=>`<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <span style="width:165px;font-size:12px;font-weight:500;flex-shrink:0">${p.nombre.length>26?p.nombre.slice(0,26)+'…':p.nombre}</span>
          <div class="pv-bar" style="max-width:none"><i style="width:${Math.max(3,Math.round(p.total*100/maxProv))}%;background:var(--azul)"></i></div>
          <span class="mono" style="width:88px;text-align:right;font-size:12px;font-weight:600">${M(p.total)}</span>
          <span class="mono sub" style="width:44px;text-align:right;font-size:10.5px">${Math.round(p.pctAcum)}%</span></div>`).join('')}
        ${otros.length?`<div style="display:flex;align-items:center;gap:10px">
          <span style="width:165px;font-size:12px;font-weight:500;flex-shrink:0">Otros ${otros.length} proveedores</span>
          <div class="pv-bar" style="max-width:none"><i style="width:${Math.max(3,Math.round(otros.reduce((s,p)=>s+p.total,0)*100/maxProv))}%;background:var(--linea-2)"></i></div>
          <span class="mono" style="width:88px;text-align:right;font-size:12px;font-weight:600">${M(otros.reduce((s,p)=>s+p.total,0))}</span>
          <span class="mono sub" style="width:44px;text-align:right;font-size:10.5px">100%</span></div>`:''}
      </div>
    </div>
    <div class="grid g-2" style="margin-bottom:14px">
      <div class="panel"><div class="panel-title">¿Cuánto debo y hace cuánto? <span class="sub" style="font-weight:400;font-size:11px">· por antigüedad de factura · foto de hoy</span></div>
        ${agFila('0–30 días',aging.a,'var(--brote)')}${agFila('31–60 días',aging.b,'var(--diesel)')}${agFila('+60 días',aging.c,'var(--rojo)')}
        ${mas60PropioN?`<div class="sub" style="margin-top:9px;font-size:11.5px"><b>${mas60PropioN} factura(s) con CUIT de EcoService</b> en +60 (${M(mas60Propio)}) — probable lectura errónea, <u>revisar antes que reclamar</u>${mas60Resto?' · resto: '+M(mas60Resto):''}</div>`:''}
      </div>
      <div class="panel"><div class="panel-title">¿Dónde se gasta? <span class="sub" style="font-weight:400;font-size:11px">· imputación por objetivo</span></div>
        ${objContratos.map(o=>objFila(o.nombre.length>24?o.nombre.slice(0,24)+'…':o.nombre,o.total,'var(--brote)')).join('')}
        ${objGeneral?objFila('EMPRESA / sin abrir',objGeneral,'var(--linea-2)','gasto general, no imputado a un contrato'):''}
        <div class="sub" style="margin-top:8px;font-size:11px">El ${pctImputado}% del gasto está imputado a contratos — cuanto más se impute al facturar, mejor lee esta vista.</div>
      </div>
    </div>
    <div class="panel"><div class="panel-title">¿Está todo en orden? <span class="sub" style="font-weight:400;font-size:11px">· controles automáticos</span></div>
      ${senales.map(([c,t])=>`<div style="display:flex;gap:9px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--linea);font-size:12.5px">
        <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:4px;background:${c}"></span><div>${t}</div></div>`).join('').replace(/border-bottom:1px solid var\(--linea\);font-size:12\.5px">\s*$/,'')}
    </div>`;
  }catch(e){view.innerHTML=tabsCompras()+`<div class="cargando-v">No pude armar los indicadores. ${e.message||''}</div>`;}
}

// Reporte imprimible: misma estructura que el PDF del sistema anterior.
function exportarComprasPDF(){
  const todas=comprasIndData||[];
  const fs=comprasIndPer?todas.filter(f=>mesInv(f)===comprasIndPer):todas;
  if(!fs.length){alert('No hay facturas en el período elegido.');return;}
  const k=calcIndicadores(fs);
  const perLabel=comprasIndPer?mesStk(comprasIndPer):'Todo el período';
  const money=n=>'$ '+(Math.round(Number(n)*100)/100).toLocaleString('es-AR',{minimumFractionDigits:2});
  const pct=v=>(Math.round(v*10)/10)+'%';
  const porMes={};fs.forEach(f=>{const m=mesInv(f);porMes[m]=porMes[m]||{docs:0,neto:0,total:0};
    porMes[m].docs++;porMes[m].neto+=Number(f.total_sin_iva)||0;
    porMes[m].total+=(Number(f.total_sin_iva)||0)+(Number(f.total_iva)||0);});
  const evol=Object.entries(porMes).sort((a,b)=>a[0].localeCompare(b[0]));
  const tabla=(headers,filas)=>`<table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${filas}</tbody></table>`;
  const detalle=fs.slice().sort((a,b)=>String(b.fecha_factura||'').localeCompare(String(a.fecha_factura||'')))
    .map(f=>{const a=asignacionInv(f);const t=(Number(f.total_sin_iva)||0)+(Number(f.total_iva)||0);
    return `<tr><td>${f.fecha_factura||'—'}</td><td>${f.numero_factura||'—'}</td><td>${f.proveedor||'—'}</td>
      <td>${f.cuit||''}</td><td>${a.obj||'Sin asignar'}</td>
      <td class="r">${money(f.total_sin_iva||0)}</td><td class="r">${money(f.total_iva||0)}</td><td class="r"><b>${money(t)}</b></td></tr>`;}).join('');
  const w=window.open('','_blank');
  if(!w){alert('El navegador bloqueó la ventana del reporte. Habilitá popups para este sitio.');return;}
  w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Reporte Compras EcoService</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;margin:28px;font-size:11px}
    h1{font-size:19px;margin:0 0 2px}
    .sub{color:#666;font-size:11px;margin-bottom:18px}
    h2{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#2e7d32;border-bottom:2px solid #2e7d32;padding-bottom:4px;margin:26px 0 10px}
    .kpis{display:flex;gap:10px;margin-bottom:6px}
    .kpi{flex:1;border:1px solid #ddd;border-radius:6px;padding:10px 12px}
    .kpi b{display:block;font-size:15px;margin-top:3px}
    .kpi span{font-size:9.5px;letter-spacing:1px;text-transform:uppercase;color:#777}
    table{width:100%;border-collapse:collapse;font-size:10.5px}
    th{text-align:left;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#777;border-bottom:1px solid #ccc;padding:5px 6px}
    td{padding:4px 6px;border-bottom:1px solid #eee;vertical-align:top}
    td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
    tr{page-break-inside:avoid}
    @media print{h2{page-break-after:avoid}}
  </style></head><body>
  <h1>Reporte de Compras — EcoService</h1>
  <div class="sub">Período: ${perLabel} · ${k.docs} facturas · ${new Date().toLocaleString('es-AR',{timeZone:'America/Argentina/Cordoba'})}</div>
  <div class="kpis">
    <div class="kpi"><span>Total c/IVA</span><b>${money(k.totTot)}</b></div>
    <div class="kpi"><span>Neto</span><b>${money(k.totNeto)}</b></div>
    <div class="kpi"><span>IVA</span><b>${money(k.totIva)}</b></div>
    <div class="kpi"><span>Ticket promedio</span><b>${money(k.ticket)}</b></div>
    <div class="kpi"><span>Conc. top 3</span><b>${pct(k.conc3)}</b></div>
  </div>
  <h2>Proveedores</h2>
  ${tabla(['#','Proveedor','Docs','Total','%'],k.ranking.map((r,i)=>`<tr><td>${i+1}</td><td>${r.nombre}</td><td class="r">${r.docs}</td><td class="r">${money(r.total)}</td><td class="r">${pct(r.pct)}</td></tr>`).join(''))}
  <h2>Por objetivo</h2>
  ${tabla(['Objetivo','Total','%'],k.porObjetivo.map(o=>`<tr><td>${o.nombre}</td><td class="r">${money(o.total)}</td><td class="r">${pct(o.pct)}</td></tr>`).join(''))}
  <h2>Por unidad</h2>
  ${tabla(['Unidad','Total','%'],k.porUnidad.map(o=>`<tr><td>${o.nombre}</td><td class="r">${money(o.total)}</td><td class="r">${pct(o.pct)}</td></tr>`).join(''))}
  <h2>Evolución mensual</h2>
  ${tabla(['Período','Docs','Neto','Total'],evol.map(([m,v])=>`<tr><td>${m}</td><td class="r">${v.docs}</td><td class="r">${money(v.neto)}</td><td class="r">${money(v.total)}</td></tr>`).join(''))}
  <h2>Detalle completo</h2>
  ${tabla(['Fecha','N° Fac.','Proveedor','CUIT','Objetivo','Neto','IVA','Total'],detalle)}
  <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script>
  </body></html>`);
  w.document.close();
}

async function vCompras(view){
  await cargarListasCompras();   // los desplegables salen de Maestros
  if(comprasMode==='carga'){vComprasCarga(view);return;}
  if(comprasMode==='detalle'){vComprasDetalle(view);return;}
  if(comprasTab==='cuenta'){vComprasCuenta(view);return;}
  if(comprasTab==='consumos'){vComprasConsumos(view);return;}
  if(comprasTab==='repuestos'){vComprasRepuestos(view);return;}
  if(comprasTab==='indicadores'){vComprasInd(view);return;}
  if(comprasTab==='combustible'){vComprasCombustible(view);return;}
  try{
    comprasData=await api('/api/compras/facturas');
    // Shell fijo: el buscador queda ACÁ afuera y nunca se vuelve a pintar
    // (antes se recreaba en cada letra y perdía el foco). Solo #compras-body
    // se actualiza en cada tecla.
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Compras</div>
      <div class="view-desc">Facturas de proveedores · base de compras</div></div>
      <button class="btn-salir" style="margin-right:8px" onclick="probarFlexxus()">⚙ Flexxus</button>
      <button class="btn" onclick="comprasNueva()">＋ Nueva factura</button></div>
    ${tabsCompras()}
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <input class="busca" style="width:280px" placeholder="Buscar proveedor, N° factura, objetivo…" value="${comprasBusca.replace(/"/g,'&quot;')}" oninput="comprasBusca=this.value;renderComprasBody()">
      <div class="sub" id="compras-count"></div>
    </div>
    <div id="compras-body"></div>`;
    renderComprasBody();
  }catch(e){view.innerHTML=`<div class="cargando-v">No pude cargar compras. ${e.message||''}</div>`;}
}
function renderComprasBody(){
  const cont=document.getElementById('compras-body');if(!cont)return;
  const b=comprasBusca.trim().toLowerCase();
  const invs=b?comprasData.filter(i=>{
    const a=asignacionInv(i);
    return [i.proveedor,i.numero_factura,i.cuit,a.obj,a.uni]
      .some(v=>String(v||'').toLowerCase().includes(b));
  }):comprasData;
  const totNeto=invs.reduce((s,i)=>s+(Number(i.total_sin_iva)||0),0);
  const totIva=invs.reduce((s,i)=>s+(Number(i.total_iva)||0),0);
  const cm=new Date().toISOString().slice(0,7);
  const totMes=invs.filter(i=>(i.fecha_factura||'').startsWith(cm)).reduce((s,i)=>s+totalFactura(i),0);
  const porProv={};
  invs.forEach(i=>{const k=i.proveedor||'Sin nombre';porProv[k]=(porProv[k]||0)+totalFactura(i);});
  const ranking=Object.entries(porProv).map(([name,total])=>({name,total})).sort((a,b)=>b.total-a.total);
  const top=ranking[0];
  const cnt=document.getElementById('compras-count');
  if(cnt)cnt.textContent=invs.length+' factura'+(invs.length===1?'':'s');

  const filas=invs.map(inv=>{
    const a=asignacionInv(inv);
    const bruto=brutoFactura(inv);
    const nc=ncFactura(inv);
    const neto=bruto-nc;
    return `<tr class="fila">
      <td class="mono">${inv.fecha_factura||'—'}</td>
      <td class="mono sub">${inv.numero_factura||'—'}</td>
      <td><b>${inv.proveedor||'—'}</b>${inv.cuit?`<div class="sub mono">${inv.cuit}</div>`:''}</td>
      <td class="money">${money(inv.total_sin_iva)}</td>
      <td class="money sub">${money(inv.total_iva)}</td>
      <td class="money">${nc?`<div style="text-decoration:line-through;opacity:.45;font-size:11px">${money(bruto)}</div><b>${money(neto)}</b>`:money(bruto)}
        ${nc?`<div class="badge b-amber" style="font-size:9.5px;margin-top:2px">NC −${money(nc)}</div>`:''}</td>
      <td>${a.obj?a.obj:'<span class="sub">sin asignar</span>'}${a.uni?`<div class="sub">${a.uni}</div>`:''}</td>
      <td>${inv.pagada?'<span class="badge b-green">✓ pagada</span>':'<span class="badge b-gray">pendiente</span>'}
        ${(()=>{const fx=inv.flexxus;if(!fx||!fx.ok)return '<div class="badge b-gray" style="font-size:9.5px;margin-top:3px">sin imputar a Flexxus</div>';
          const cc=fx.centro_costo;
          if(cc&&cc.ok)return '<div class="badge b-green" style="font-size:9.5px;margin-top:3px">✓ Flexxus + centro de costo</div>';
          if(cc&&!cc.ok)return '<div class="badge b-green" style="font-size:9.5px;margin-top:3px">✓ imputada Flexxus</div><div class="badge b-amber" style="font-size:9.5px;margin-top:2px" title="'+String(cc.motivo||'').replace(/"/g,'&quot;')+'">⚠ centro de costo pendiente</div>';
          return '<div class="badge b-green" style="font-size:9.5px;margin-top:3px">✓ imputada Flexxus</div>';})()}</td>
      <td style="text-align:right;white-space:nowrap">
        ${inv.comprobante&&inv.comprobante.ruta?'<span title="Tiene el comprobante adjunto" style="margin-right:5px;opacity:.6">📎</span>':''}
        <button class="btn-salir" style="padding:4px 9px;font-size:11.5px" onclick="verCompra('${inv.id}')">Ver</button>
      </td>
    </tr>`;}).join('');

  cont.innerHTML=`
  <div class="kpis">
    <div class="kpi"><div class="kpi-label">Facturas</div><div class="kpi-val">${invs.length}</div><div class="kpi-sub">cargadas</div></div>
    <div class="kpi plain"><div class="kpi-label">Total del mes</div><div class="kpi-val">${money(totMes)}</div><div class="kpi-sub">${cm}</div></div>
    <div class="kpi"><div class="kpi-label">Neto acumulado</div><div class="kpi-val">${money(totNeto)}</div><div class="kpi-sub">IVA ${money(totIva)}</div></div>
    <div class="kpi plain"><div class="kpi-label">Top proveedor</div><div class="kpi-val" style="font-size:16px;font-weight:700">${top?top.name.slice(0,18):'—'}</div><div class="kpi-sub">${top?money(top.total):''}</div></div>
  </div>
  <div class="grid g-2" style="margin-bottom:18px">
    <div class="panel"><div class="panel-title">Ranking de proveedores</div>
      ${ranking.length?ranking.slice(0,6).map(p=>`<div class="queue-item"><div style="flex:1;font-weight:600;font-size:13px">${p.name}</div><div class="money">${money(p.total)}</div></div>`).join(''):'<div class="sub" style="padding:12px 0">Sin datos</div>'}
    </div>
    <div class="panel"><div class="panel-title">Últimas facturas</div>
      ${invs.length?invs.slice(0,6).map(i=>`<div class="queue-item"><div style="flex:1"><div style="font-weight:600;font-size:13px">${i.proveedor||'—'}</div><div class="sub mono">${i.numero_factura||''} · ${i.fecha_factura||''}</div></div><div class="money">${money(totalFactura(i))}</div></div>`).join(''):'<div class="sub" style="padding:12px 0">Sin facturas</div>'}
    </div>
  </div>
  <div class="tabla-wrap">
    ${invs.length?`<table><thead><tr><th>Fecha</th><th>N° Fac.</th><th>Proveedor</th><th>Neto</th><th>IVA</th><th>Total</th><th>Objetivo / Unidad</th><th>Estado</th><th style="width:70px"></th></tr></thead><tbody>${filas}</tbody></table>`
      :`<div class="empty">${comprasBusca?'Ninguna factura coincide con la búsqueda.':'No hay facturas cargadas en la base de compras.'}</div>`}
  </div>`;
}

/* ===== Compras · detalle, edición y notas de crédito ===== */
let comprasBusca='';
let comprasData=[];
let comprasVer=null;      // factura abierta en detalle
let comprasEdit=false;    // ¿está en modo edición?
let comprasEditMode='total'; // 'total' | 'per-item' (imputación al editar)

function ncTotal(inv){
  return (inv.notas_credito||[]).reduce((s,n)=>s+(Number(n.total_sin_iva)||0)+(Number(n.total_iva)||0),0);
}
/* ── Flexxus ── */
async function imputarFlexxus(id){
  const letra=await uiPrompt('¿Qué letra es la factura? (A, B o C)','A','Imputar a Flexxus');
  if(letra===null)return;
  const L=String(letra).trim().toUpperCase()||'A';
  if(!['A','B','C'].includes(L)){toast('Letra inválida: usá A, B o C','error');return;}
  // Verificación previa: a qué proveedor va y con qué número, ANTES de tocar Flexxus
  let prev=null;
  try{prev=await api('/api/compras/facturas/'+id+'/flexxus-preview?letra='+L);}catch(e){}
  if(prev){
    if(prev.numero==null){toast('La factura no tiene un número válido (PV-NUMERO). Corregilo en el editor.','error');return;}
    if(prev.proveedor){
      if(!await uiConfirm(
        'Proveedor en Flexxus: '+prev.proveedor.razonsocial+' (cód. '+prev.proveedor.codigo+')'+
        (prev.proveedor.cuit?' · CUIT '+prev.proveedor.cuit:'')+
        '\nComprobante: F'+L+' '+prev.numero_formateado+
        '\n\nSi el proveedor no es el correcto, cancelá y corregí el CUIT o la razón social en el editor.',
        '¿Imputar a este proveedor?',{ok:'Imputar'}))return;
      await ejecutarImputacion(id,L,false);return;
    }
    // No existe: alta solo con confirmación explícita
    if(!await uiConfirm(
      'No existe en Flexxus un proveedor con ese CUIT ni una razón social parecida.'+
      '\nSe crearía un proveedor NUEVO con los datos de la factura.'+
      '\n\nSi el proveedor YA existe en Flexxus con otro nombre, cancelá y corregí el CUIT en el editor (es lo que usa el sistema para encontrarlo).',
      '¿Crear proveedor nuevo e imputar?',{ok:'Crear e imputar',danger:true}))return;
    await ejecutarImputacion(id,L,true);return;
  }
  // Sin preview (Flexxus caído u otro error): flujo clásico con aviso genérico
  if(!await uiConfirm('No pude verificar contra Flexxus. Se va a intentar crear el comprobante F'+L+' con los datos de esta factura.','¿Continuar igual?',{ok:'Imputar'}))return;
  await ejecutarImputacion(id,L,false);
}
async function reintentarCentroCosto(id){
  try{
    const r=await api('/api/compras/facturas/'+id+'/flexxus-centrocosto',{method:'POST'});
    const cc=r.centro_costo||{};
    if(cc.ok&&cc.verificado===true)toast('Centro de costo VERIFICADO contra Flexxus ✓ '+(cc.reparto||[]).map(x=>x.objetivo+' '+x.porcentaje+'%').join(' · ')+' (asiento '+cc.numeroasiento+' releído del API)');
    else if(cc.ok)toast('Centro de costo enviado ✓ ('+(cc.reparto||[]).map(x=>x.objetivo+' '+x.porcentaje+'%').join(' · ')+') — no pude releer el asiento para confirmarlo');
    else toast('Sigue pendiente: '+(cc.motivo||''),'error');
    go('compras');
  }catch(e){toast(e.message,'error');}
}
async function ejecutarImputacion(id,L,permitirAlta){
  try{
    const r=await api('/api/compras/facturas/'+id+'/flexxus',{method:'POST',body:JSON.stringify({letra:L,permitir_alta:permitirAlta})});
    const cc=r.flexxus&&r.flexxus.centro_costo;
    if(r.ya_existia)toast('Ya estaba imputada en Flexxus: la marqué como tal');
    else if(cc&&cc.ok&&cc.verificado===true)toast('Imputada ✓ · Centro de costo VERIFICADO contra Flexxus: '+(cc.reparto||[]).map(x=>x.objetivo+' '+x.porcentaje+'%').join(' · ')+' (asiento '+cc.numeroasiento+' releído del API)');
    else if(cc&&cc.ok)toast('Imputada ✓ · centro de costo enviado ('+(cc.reparto||[]).map(x=>x.objetivo+' '+x.porcentaje+'%').join(' · ')+') — no pude releer el asiento para confirmarlo');
    else toast('Imputada en Flexxus ✓');
    if(cc&&!cc.ok)toast('Centro de costo pendiente: '+(cc.motivo||''),'error');
    go('compras');
  }catch(e){
    if(/PROV_NO_EXISTE/.test(e.message)||/No existe en Flexxus/.test(e.message)){
      if(await uiConfirm(e.message+'\n\n¿Crear proveedor nuevo e imputar?','Proveedor inexistente',{ok:'Crear e imputar',danger:true}))
        return ejecutarImputacion(id,L,true);
      return;
    }
    toast(e.message,'error');
  }
}
async function probarFlexxus(){
  toast('Probando conexión con Flexxus…','info');
  try{
    const d=await api('/api/flexxus/estado');
    const tabla=(t,l)=>`<div style="font-weight:600;font-size:12.5px;margin:12px 0 4px">${t}</div>`+((l||[]).length
      ?'<div style="max-height:150px;overflow:auto;border:1px solid var(--linea);border-radius:8px">'+(l||[]).map(x=>`<div style="display:flex;gap:10px;padding:4px 9px;border-bottom:1px solid var(--papel);font-size:12px"><b style="min-width:90px;font-family:var(--mono,monospace)">${x.codigo??x.error??''}</b><span>${x.descripcion||''}</span></div>`).join('')+'</div>'
      :'<div class="sub">—</div>');
    const cfg=Object.entries(d.config||{}).map(([k,v])=>`<div style="display:flex;gap:10px;padding:3px 0;font-size:12px"><span style="min-width:210px">${k}</span><b>${v}</b></div>`).join('');
    const alta=Object.entries(d.alta_proveedor_usaria||{}).map(([k,v])=>`<div style="display:flex;gap:10px;padding:3px 0;font-size:12px"><span style="min-width:180px">${k}</span><b>${v}</b></div>`).join('');
    const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=180;
    bg.innerHTML=`<div class="modal" style="max-width:560px">
      <h3>⚙ Flexxus · diagnóstico</h3>
      <div style="font-size:12.5px;color:var(--brote-2);font-weight:600;margin-bottom:2px">✓ Conexión OK</div>
      <div class="sub" style="font-size:12px">URL: ${d.url}<br>Usuario API: ${d.usuario}</div>
      <div style="font-weight:600;font-size:12.5px;margin:12px 0 4px">Config actual (variables en Railway)</div>${cfg}
      ${tabla('Depósitos (FLEXXUS_DEPOSITO)',d.depositos)}
      ${tabla('Condiciones de pago (FLEXXUS_MULTIPLAZO)',d.multiplazos)}
      ${tabla('Percepciones (FLEXXUS_CODIGO_PERCEPCION)',d.percepciones)}
      ${tabla('Clases de proveedor (FLEXXUS_CLASE_PROVEEDOR)',d.clases_proveedor)}
      ${tabla('Condiciones de IVA (FLEXXUS_CONDICION_IVA)',d.condiciones_iva)}
      <div class="divider"></div>
      <div style="font-weight:600;font-size:12.5px;margin:12px 0 4px">Centro de costo — cómo imputa esta instalación</div>
      <div style="background:${d.centro_costo_via&&d.centro_costo_via.startsWith('no detectado')?'var(--diesel-soft)':'var(--brote-soft)'};border-radius:8px;padding:9px 12px;font-size:12px;margin-bottom:6px"><b>${d.centro_costo_via||'—'}</b></div>
      ${tabla('Centros de costo (GET /centrodecosto)',d.centros_costo)}
      ${tabla('Tipos de asiento (FLEXXUS_CODIGO_ASIENTO — usá el de compras)',d.tipos_asiento)}
      ${tabla('Ejercicios contables (FLEXXUS_CODIGO_EJERCICIO — usá el vigente)',d.ejercicios)}
      ${tabla('Proyectos (GET /compras/gastosporproyecto/proyectos)',d.proyectos)}
      <div style="font-weight:600;font-size:12.5px;margin:12px 0 4px">Alta de proveedor nuevo usaría</div>${alta}
      <div class="modal-acciones"><button class="btn" id="fx-cerrar">Cerrar</button></div>
    </div>`;
    document.body.appendChild(bg);
    bg.querySelector('#fx-cerrar').onclick=()=>bg.remove();
    bg.addEventListener('click',e=>{if(e.target===bg)bg.remove();});
  }catch(e){await uiAlert((e.message||'No pude conectar con Flexxus.'),'✗ Falló la conexión');}
}
function verCompra(id){
  const orig=comprasData.find(i=>String(i.id)===String(id));
  if(!orig)return;
  comprasVer=JSON.parse(JSON.stringify(orig));   // copia: editar no toca la lista
  comprasEdit=false;
  comprasEditMode=comprasVer.assignmentMode==='per-item'?'per-item':'total';
  comprasMode='detalle';go('compras');
}
function volverCompras(){comprasVer=null;comprasEdit=false;comprasMode='lista';go('compras');}
// Cancelar descarta los cambios: se recarga la factura original de la lista,
// porque el toggle de modo va escribiendo en el objeto en memoria.
function cancelarEdicionCompra(){
  const orig=comprasData.find(i=>String(i.id)===String(comprasVer&&comprasVer.id));
  if(orig)comprasVer=JSON.parse(JSON.stringify(orig));
  comprasEdit=false;
  comprasEditMode=comprasVer&&comprasVer.assignmentMode==='per-item'?'per-item':'total';
  go('compras');
}

function vComprasDetalle(view){
  const inv=comprasVer;if(!inv){volverCompras();return;}
  const a=asignacionInv(inv);
  const bruto=brutoFactura(inv);
  const nc=ncTotal(inv);
  const neto=bruto-nc;
  const oo=COMPRAS_OBJ.map(o=>`<option value="${o.replace(/"/g,'&quot;')}" ${o===a.obj?'selected':''}>${o}</option>`).join('');
  const uo=COMPRAS_UNI.map(u=>`<option value="${u.replace(/"/g,'&quot;')}" ${u===a.uni?'selected':''}>${u}</option>`).join('');
  const ed=comprasEdit;
  const campo=(id,val,tipo)=>ed
    ?`<input id="${id}" ${tipo==='num'?'type="number" step="0.01"':''} value="${String(val==null?'':val).replace(/"/g,'&quot;')}" style="background:var(--blanco);border:1px solid var(--linea);border-radius:8px;padding:8px 10px;font-family:inherit;font-size:13px;outline:none;width:100%">`
    :`<span class="${tipo==='num'?'money':''}">${tipo==='num'?money(val):(val||'—')}</span>`;

  view.innerHTML=`
  <div class="view-head"><div>
    <button class="btn-salir" style="margin-bottom:8px;padding:5px 11px;font-size:12px" onclick="volverCompras()">← Volver</button>
    <div class="view-title">${inv.proveedor||'Factura'}</div>
    <div class="view-desc">${inv.numero_factura||'sin número'} · ${inv.fecha_factura||'sin fecha'}</div></div>
    <div style="display:flex;gap:8px">
      ${ed?`<button class="btn-salir" onclick="cancelarEdicionCompra()">Cancelar</button>
            <button class="btn" onclick="guardarEdicionCompra()">Guardar cambios</button>`
        :`<button class="btn-salir" style="${inv.pagada?'color:var(--brote-2);border-color:var(--brote)':''}" onclick="togglePagada('${inv.id}',${!inv.pagada})">${inv.pagada?'✓ Pagada':'Marcar pagada'}</button>
          <button class="btn-salir" onclick="comprasEdit=true;go('compras')">✎ Editar</button>
          ${inv.flexxus&&inv.flexxus.ok
            ?''
            :`<button class="btn-salir" style="color:#7B3FA0;border-color:#C9A6E0" onclick="imputarFlexxus('${inv.id}')">⇪ Imputar a Flexxus</button>`}
          <button class="btn" onclick="abrirNC()">＋ Nota de crédito</button>
          <button class="btn-salir" style="color:var(--rojo)" onclick="borrarCompra('${inv.id}')">Eliminar</button>`}
    </div></div>
    ${!ed&&inv.flexxus&&inv.flexxus.ok?`<div class="hint" style="margin-bottom:12px;border-color:#C9A6E0"><svg viewBox="0 0 24 24" fill="none" stroke="#7B3FA0" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg><div>Imputada en Flexxus · ${inv.flexxus.tipocomprobante||''} ${inv.flexxus.numerocomprobante||''} · ${fechaAR(inv.flexxus.fecha)} por ${inv.flexxus.por||''}${inv.flexxus.proveedor_creado?' · proveedor creado en Flexxus':''}</div></div>`:''}
    ${!ed&&inv.pagada?'<div class="hint" style="margin-bottom:18px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg><div>Factura pagada'+(inv.pagada_at?' · '+fechaAR(inv.pagada_at):'')+'</div></div>':''}

  <div class="grid g-2" style="margin-bottom:18px">
    <div class="panel">
      <div class="panel-title" style="margin-bottom:12px">Factura</div>
      <div class="mcard-row"><span>Fecha</span>${campo('ec-fecha',inv.fecha_factura)}</div>
      <div class="mcard-row"><span>N° Factura</span>${campo('ec-num',inv.numero_factura)}</div>
      <div class="mcard-row"><span>Proveedor</span>${campo('ec-prov',inv.proveedor)}</div>
      <div class="mcard-row"><span>CUIT</span>${campo('ec-cuit',inv.cuit)}</div>
      <div class="mcard-row"><span>Neto</span>${campo('ec-neto',inv.total_sin_iva,'num')}</div>
      <div class="mcard-row"><span>IVA</span>${campo('ec-iva',inv.total_iva,'num')}</div>
      ${(inv.otros_conceptos||[]).length?`<div class="divider" style="margin:8px 0"></div>
        <div class="field-l" style="margin-bottom:6px">Percepciones e impuestos</div>
        ${(inv.otros_conceptos||[]).map((o,ix)=>`
          <div class="mcard-row" style="align-items:center">
            <span style="display:flex;align-items:center;gap:7px">
              <input type="checkbox" ${o.exento?'':'checked'} onchange="toggleConcepto('${inv.id}',${ix},!this.checked)" title="Tildado = se suma al total; destildado = exento" style="accent-color:var(--brote)">
              <span style="${o.exento?'text-decoration:line-through;opacity:.5':''}">${o.concepto||cap(o.tipo||'otro')}${o.exento?' <span class="badge b-gray" style="font-size:9px">exento</span>':''}</span>
            </span>
            <b class="money" style="${o.exento?'opacity:.4;text-decoration:line-through':''}">${money(o.monto)}</b>
          </div>`).join('')}`:''}
      <div class="divider"></div>
      <div class="mcard-row"><span style="font-weight:600">Total a pagar</span><b class="money">${money(bruto)}</b></div>
      ${nc?`<div class="mcard-row"><span style="color:var(--ambar)">Notas de crédito</span><b class="money" style="color:var(--ambar)">− ${money(nc)}</b></div>
        <div class="mcard-row" style="border-top:2px solid var(--linea);padding-top:8px">
          <span style="font-weight:700">Neto a pagar</span><b class="money" style="font-size:16px;color:var(--brote)">${money(neto)}</b></div>`:''}
    </div>
    <div class="panel">
      <div class="panel-title" style="margin-bottom:12px">Imputación</div>
      ${ed?`
        <div class="toggle-imp" style="margin-bottom:14px">
          <button class="${comprasEditMode==='total'?'on':''}" onclick="comprasSetEditMode('total')">Total de factura</button>
          <button class="${comprasEditMode==='per-item'?'on':''}" onclick="comprasSetEditMode('per-item')">Por ítem</button>
        </div>
        ${comprasEditMode==='total'?`
          <div class="mm-field"><label>Objetivo</label><select id="ec-obj"><option value="">— sin asignar —</option>${oo}</select></div>
          <div class="mm-field"><label>Unidad</label><select id="ec-uni"><option value="">— sin asignar —</option>${uo}</select></div>`
        :`<div class="sub">Cada ítem se imputa por separado, abajo en la tabla. El gasto se reparte proporcional al monto de cada línea.</div>`}`
      :`<div class="mcard-row"><span>Objetivo</span><b>${a.obj||'— sin asignar —'}</b></div>
        <div class="mcard-row"><span>Unidad</span><b>${a.uni||'—'}</b></div>
        <div class="sub" style="margin-top:6px">${inv.assignmentMode==='per-item'?'Imputada por ítem':'Total de factura'}</div>
        ${inv.flexxus&&inv.flexxus.centro_costo?(inv.flexxus.centro_costo.ok
          ?`<div class="sub" style="margin-top:4px;color:var(--brote-2)">Centro de costo ${inv.flexxus.centro_costo.verificado===true?'✓✓ VERIFICADO contra Flexxus':'✓ enviado'}: ${(inv.flexxus.centro_costo.reparto||[]).map(x=>x.objetivo+' '+x.porcentaje+'%').join(' · ')} · asiento ${inv.flexxus.centro_costo.numeroasiento}${inv.flexxus.centro_costo.verificado===true?' (releído del API)':' — sin relectura de confirmación'}</div>`
          :`<div class="sub" style="margin-top:4px;color:#854F0B">⚠ Centro de costo pendiente: ${inv.flexxus.centro_costo.motivo||''} <button class="mini-btn" style="margin-left:6px" onclick="reintentarCentroCosto('${inv.id}')">↻ Reintentar</button></div>`):''}
        ${inv.assignmentMode==='per-item'?`<div class="divider"></div>
          ${(inv.items||[]).map((it,ix)=>{const asg=(inv.assignments||{})[ix]||{};
            return `<div class="queue-item" style="margin-bottom:6px">
              <div style="flex:1"><div style="font-size:12px;font-weight:500">${it.descripcion||'—'}</div>
              <div class="sub" style="font-size:11px">${asg.objetivo||'sin asignar'}${asg.unidad?' · '+asg.unidad:''}</div></div>
              <div class="money sub">${money(it.monto_sin_iva||0)}</div></div>`;}).join('')}`:''}`}
      ${nc?`<div class="divider"></div>
        <div class="panel-title" style="margin-bottom:8px">Notas de crédito</div>
        ${(inv.notas_credito||[]).map(n=>`
          <div class="queue-item" style="margin-bottom:7px">
            <div style="flex:1"><div style="font-weight:600;font-size:12.5px">${n.numero||'NC sin número'}</div>
            <div class="sub" style="font-size:11px">${fechaAR(n.fecha)}${n.motivo?' · '+n.motivo:''}</div></div>
            <div class="money" style="color:var(--ambar);font-weight:600">− ${money((Number(n.total_sin_iva)||0)+(Number(n.total_iva)||0))}</div>
            <button class="btn-salir" style="padding:3px 7px;font-size:11px;color:var(--rojo);margin-left:8px" onclick="borrarNC('${inv.id}','${n.id}')">✕</button>
          </div>`).join('')}`:''}
    </div>
  </div>

  <div class="panel" style="margin-bottom:18px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div class="panel-title" style="margin:0">Comprobante</div>
      ${inv.comprobante&&inv.comprobante.ruta?`
        <div style="display:flex;gap:8px">
          <button class="btn-salir" style="padding:5px 11px;font-size:12px" onclick="abrirComprobante('${inv.id}')">↗ Abrir en pestaña</button>
          <button class="btn-salir" style="padding:5px 11px;font-size:12px" onclick="adjuntarComprobante('${inv.id}')">Reemplazar</button>
        </div>`
        :`<button class="btn-salir" style="padding:5px 11px;font-size:12px" onclick="adjuntarComprobante('${inv.id}')">＋ Adjuntar comprobante</button>`}
    </div>
    ${inv.comprobante&&inv.comprobante.ruta?`
      <div id="comp-visor" style="border:1px solid var(--linea);border-radius:10px;overflow:hidden;background:var(--papel);min-height:440px;display:flex;align-items:center;justify-content:center">
        <div class="sub">Cargando comprobante…</div>
      </div>
      <div class="sub" style="margin-top:6px;font-size:11px">${inv.comprobante.nombre||'archivo'} · adjuntado ${fechaAR(inv.comprobante.subido_at)}</div>`
      :`<div class="sub" style="padding:14px 0">Esta factura no tiene el comprobante adjunto. Las que cargues de ahora en más lo guardan solas.</div>`}
  </div>

  <div class="panel">
    <div class="panel-title" style="margin-bottom:10px">Ítems</div>
    ${(()=>{
      const items=inv.items||[];
      if(!items.length)return '<div class="sub" style="padding:10px 0">La factura no tiene ítems cargados.</div>';
      // Muchas facturas traen el IVA solo en el total, no por línea. Si los ítems
      // no lo tienen desglosado, se prorratea proporcional al neto de cada uno,
      // así el desglose cierra con el total de la factura.
      // (`iva` es el nombre viejo del campo; se acepta por compatibilidad.)
      const ivaBruto=i=>Number(i.monto_iva!=null?i.monto_iva:i.iva)||0;
      const ivaItems=items.reduce((s,i)=>s+ivaBruto(i),0);
      const ivaFact=Number(inv.total_iva)||0;
      const netoItems=items.reduce((s,i)=>s+(Number(i.monto_sin_iva)||0),0);
      const prorratear=ivaItems===0&&ivaFact>0&&netoItems>0;
      const ivaDe=i=>prorratear
        ?ivaFact*(Number(i.monto_sin_iva)||0)/netoItems
        :ivaBruto(i);
      const perItem=ed&&comprasEditMode==='per-item';
      const asgDe=ix=>(inv.assignments||{})[ix]||{};
      const selObj=ix=>`<select id="ei-obj-${ix}" style="width:100%;font-size:11.5px;padding:5px 7px">
        <option value="">— sin asignar —</option>
        ${COMPRAS_OBJ.map(o=>`<option value="${o.replace(/"/g,'&quot;')}" ${o===asgDe(ix).objetivo?'selected':''}>${o}</option>`).join('')}</select>`;
      const selUni=ix=>`<select id="ei-uni-${ix}" style="width:100%;font-size:11.5px;padding:5px 7px;margin-top:4px">
        <option value="">— sin unidad —</option>
        ${COMPRAS_UNI.map(u=>`<option value="${u.replace(/"/g,'&quot;')}" ${u===asgDe(ix).unidad?'selected':''}>${u}</option>`).join('')}</select>`;
      return `<table style="font-size:12.5px"><thead><tr><th>Descripción</th><th class="num">Neto</th><th class="num">IVA</th><th class="num">Total</th>${perItem?'<th style="width:260px">Imputación</th>':''}</tr></thead>
      <tbody>${items.map((i,ix)=>{const n=Number(i.monto_sin_iva)||0,v=ivaDe(i);
        return `<tr><td>${i.descripcion||'—'}</td>
        <td class="num money">${money(n)}</td>
        <td class="num money sub">${money(v)}</td>
        <td class="num money">${money(n+v)}</td>
        ${perItem?`<td>${selObj(ix)}${selUni(ix)}</td>`:''}</tr>`;}).join('')}
      <tr style="border-top:2px solid var(--linea)"><td><b>Total</b></td>
        <td class="num money"><b>${money(inv.total_sin_iva||0)}</b></td>
        <td class="num money"><b>${money(ivaFact)}</b></td>
        <td class="num money"><b>${money(bruto)}</b></td>${perItem?'<td></td>':''}</tr></tbody></table>
      ${prorratear?'<div class="sub" style="margin-top:8px">ℹ️ La factura trae el IVA solo en el total, no por línea. Acá se muestra prorrateado según el neto de cada ítem.</div>':''}`;
    })()}
  </div>`;
  if(inv.comprobante&&inv.comprobante.ruta)cargarVisorComprobante(inv.id);
}
// Al cambiar de modo de imputación la vista se re-renderiza: capturamos primero
// lo que el usuario venía editando para no perderlo.
function comprasSetEditMode(modo){
  const inv=comprasVer;if(!inv)return;
  const g=id=>document.getElementById(id);
  if(g('ec-fecha')){
    inv.fecha_factura=g('ec-fecha').value.trim()||null;
    inv.numero_factura=g('ec-num').value.trim()||null;
    inv.proveedor=g('ec-prov').value.trim()||null;
    inv.cuit=g('ec-cuit').value.trim()||null;
    inv.total_sin_iva=Number(g('ec-neto').value)||0;
    inv.total_iva=Number(g('ec-iva').value)||0;
  }
  // Guardar también la imputación del modo que estábamos dejando
  if(comprasEditMode==='total'&&g('ec-obj')){
    inv.totalAssign={objetivo:g('ec-obj').value,unidad:g('ec-uni')?g('ec-uni').value:'',
      comentario:(inv.totalAssign&&inv.totalAssign.comentario)||''};
  }else if(comprasEditMode==='per-item'){
    const asg={};
    (inv.items||[]).forEach((_,ix)=>{
      const o=g('ei-obj-'+ix),u=g('ei-uni-'+ix);
      if(o||u){const objetivo=o?o.value:'',unidad=u?u.value:'';
        if(objetivo||unidad)asg[ix]={objetivo,unidad,comentario:((inv.assignments||{})[ix]||{}).comentario||''};}
    });
    if(Object.keys(asg).length)inv.assignments=asg;
  }
  comprasEditMode=modo;
  go('compras');
}

// El bucket es privado: se pide una URL firmada (vale 1 hora) y se embebe.
async function cargarVisorComprobante(id){
  const cont=document.getElementById('comp-visor');
  if(!cont)return;
  try{
    const d=await api('/api/compras/factura/'+id+'/comprobante');
    const c=document.getElementById('comp-visor');
    if(!c)return;
    const esImg=String(d.tipo||'').startsWith('image/');
    c.innerHTML=esImg
      ?`<img src="${d.url}" style="max-width:100%;height:auto;display:block">`
      :`<iframe src="${d.url}#view=FitH" style="width:100%;height:640px;border:none;display:block"></iframe>`;
    c.style.minHeight='auto';c.style.display='block';
  }catch(e){
    const c=document.getElementById('comp-visor');
    if(c)c.innerHTML=`<div class="sub" style="padding:20px">No pude cargar el comprobante. ${e.message||''}</div>`;
  }
}
async function abrirComprobante(id){
  try{
    const d=await api('/api/compras/factura/'+id+'/comprobante');
    window.open(d.url,'_blank');
  }catch(e){alert('No pude abrir el comprobante: '+(e.message||''));}
}
// Adjuntar o reemplazar el comprobante de una factura ya cargada
function adjuntarComprobante(id){
  const inp=document.createElement('input');
  inp.type='file';inp.accept='application/pdf,image/*';
  inp.onchange=async()=>{
    const f=inp.files[0];if(!f)return;
    if(f.size>25*1024*1024){alert('El archivo supera los 25 MB.');return;}
    const cont=document.getElementById('comp-visor');
    if(cont)cont.innerHTML='<div class="sub" style="padding:20px">Subiendo…</div>';
    try{
      const b64=await new Promise((res,rej)=>{
        const r=new FileReader();
        r.onload=()=>res(String(r.result).split(',')[1]);
        r.onerror=()=>rej(new Error('No pude leer el archivo'));
        r.readAsDataURL(f);
      });
      const r=await api('/api/compras/factura/'+id+'/comprobante',{method:'POST',
        body:JSON.stringify({fileData:b64,fileType:f.type||'application/pdf',fileName:f.name})});
      comprasVer=r;go('compras');
    }catch(e){alert('No pude subir el comprobante: '+(e.message||''));go('compras');}
  };
  inp.click();
}

async function guardarEdicionCompra(){
  const inv=comprasVer;if(!inv)return;
  const g=id=>document.getElementById(id);
  const body={
    fecha_factura:g('ec-fecha').value.trim()||null,
    numero_factura:g('ec-num').value.trim()||null,
    proveedor:g('ec-prov').value.trim()||null,
    cuit:g('ec-cuit').value.trim()||null,
    total_sin_iva:Number(g('ec-neto').value)||0,
    total_iva:Number(g('ec-iva').value)||0,
    assignmentMode:comprasEditMode,
  };
  if(comprasEditMode==='per-item'){
    const asg={};
    (inv.items||[]).forEach((_,ix)=>{
      const o=g('ei-obj-'+ix),u=g('ei-uni-'+ix);
      const objetivo=o?o.value:'',unidad=u?u.value:'';
      if(objetivo||unidad)asg[ix]={objetivo,unidad,
        comentario:((inv.assignments||{})[ix]||{}).comentario||''};
    });
    body.assignments=asg;
    body.totalAssign={objetivo:'',unidad:'',comentario:''};
  }else{
    const obj=g('ec-obj')?g('ec-obj').value:'';
    const uni=g('ec-uni')?g('ec-uni').value:'';
    body.totalAssign={objetivo:obj,unidad:uni,comentario:(inv.totalAssign&&inv.totalAssign.comentario)||''};
    body.assignments={};
  }
  try{
    const r=await api('/api/compras/factura/'+inv.id,{method:'PUT',body:JSON.stringify(body)});
    comprasVer=r;comprasEdit=false;go('compras');
  }catch(e){alert('No pude guardar: '+(e.message||''));}
}
async function borrarCompra(id){
  const inv=comprasData.find(i=>String(i.id)===String(id))||comprasVer;
  if(inv&&inv.flexxus&&inv.flexxus.ok){
    if(!await uiConfirm('Esta factura ya está imputada en Flexxus ('+
      (inv.flexxus.tipocomprobante||'')+' '+(inv.flexxus.numerocomprobante||'')+').\n\n'+
      'Eliminarla acá la saca de tu panel, PERO el comprobante SIGUE en Flexxus — los dos sistemas van a quedar descoordinados.\n\n'+
      'Para anular un comprobante ya cargado se hace una NOTA DE CRÉDITO en el ERP, no se borra.',
      '⚠️ Factura imputada en Flexxus',{ok:'Eliminar igual',danger:true}))return;
  } else {
    if(!await uiConfirm('¿Eliminar esta factura? No se puede deshacer.','Eliminar factura',{ok:'Eliminar',danger:true}))return;
  }
  try{await api('/api/compras/factura/'+id,{method:'DELETE'});volverCompras();}
  catch(e){toast('No pude eliminar: '+(e.message||''),'error');}
}
function abrirNC(){
  const inv=comprasVer;if(!inv)return;
  const bruto=(Number(inv.total_sin_iva)||0)+(Number(inv.total_iva)||0);
  const ya=ncTotal(inv);
  const saldo=bruto-ya;
  document.getElementById('mm-titulo').textContent='Nota de crédito';
  document.getElementById('mm-campos').innerHTML=`
    <div class="sub" style="margin-bottom:12px">Sobre <b>${inv.proveedor||'—'}</b> · factura ${inv.numero_factura||'—'}<br>
      Saldo disponible: <b class="money">${money(saldo)}</b></div>
    <div class="mm-field"><label>N° de nota de crédito</label><input id="nc-num" placeholder="ej: 0001-00000123"></div>
    <div class="mm-field"><label>Fecha</label><input id="nc-fecha" type="date" value="${new Date().toISOString().slice(0,10)}"></div>
    <div class="mm-field"><label>Neto</label><input id="nc-neto" type="number" step="0.01" min="0" placeholder="0.00"></div>
    <div class="mm-field"><label>IVA</label><input id="nc-iva" type="number" step="0.01" min="0" placeholder="0.00"></div>
    <div class="mm-field"><label>Motivo</label><input id="nc-motivo" placeholder="ej: devolución, bonificación"></div>
    <div class="modal-acciones">
      <button class="btn-salir" onclick="cerrarMaestro()">Cancelar</button>
      <button class="btn" id="nc-btn" onclick="guardarNC()">Guardar nota</button>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
}
async function guardarNC(){
  const inv=comprasVer;if(!inv)return;
  const body={
    numero:document.getElementById('nc-num').value.trim()||null,
    fecha:document.getElementById('nc-fecha').value||null,
    total_sin_iva:Number(document.getElementById('nc-neto').value)||0,
    total_iva:Number(document.getElementById('nc-iva').value)||0,
    motivo:document.getElementById('nc-motivo').value.trim()||null,
  };
  if(body.total_sin_iva<=0&&body.total_iva<=0){alert('Poné el monto de la nota de crédito.');return;}
  const btn=document.getElementById('nc-btn');
  if(btn){btn.disabled=true;btn.textContent='Guardando…';}
  try{
    const r=await api('/api/compras/factura/'+inv.id+'/nota-credito',{method:'POST',body:JSON.stringify(body)});
    comprasVer=r;cerrarMaestro();go('compras');
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='Guardar nota';}
    alert(e.message||'No pude guardar la nota de crédito');
  }
}
async function borrarNC(id,ncid){
  if(!confirm('¿Borrar esta nota de crédito?'))return;
  try{
    const r=await api('/api/compras/factura/'+id+'/nota-credito/'+ncid,{method:'DELETE'});
    comprasVer=r;go('compras');
  }catch(e){alert('No pude borrar: '+(e.message||''));}
}

/* ===== Compras · listas y estado de carga ===== */
// Listas de imputación de Compras. Vienen de Maestros (centros de costo y
// unidades); antes estaban escritas a mano acá y no se podían editar.
let COMPRAS_OBJ=[];
let COMPRAS_UNI=[];
let comprasListasOk=false;
async function cargarListasCompras(force){
  if(comprasListasOk&&!force)return;
  try{
    const d=await api('/api/compras/listas');
    COMPRAS_OBJ=d.objetivos||[];
    COMPRAS_UNI=d.unidades||[];
    comprasListasOk=true;
  }catch(e){console.error('No pude cargar las listas de imputación',e);}
}
let comprasMode='lista';       // 'lista' | 'carga'
let comprasStep='upload';      // 'upload' | 'extract' | 'assign'
let comprasFile=null;          // {data, type, name}
let comprasExtracted=null;     // datos extraídos (con items)
let comprasAssignMode='total'; // 'total' | 'per-item'
let comprasAssign={objetivo:'',unidad:'',comentario:''};  // modo total
let comprasAssignments={};     // modo por-ítem: {[i]:{objetivo,unidad,comentario}}
let comprasMsg='';

function comprasNueva(){comprasMode='carga';comprasStep='upload';comprasFile=null;comprasExtracted=null;comprasAssignMode='total';comprasAssign={objetivo:'',unidad:'',comentario:''};comprasAssignments={};comprasMsg='';go('compras');}
function comprasCancelar(){comprasMode='lista';comprasFile=null;comprasExtracted=null;go('compras');}

function comprasPickFile(input){
  const f=input.files&&input.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=()=>{comprasFile={data:String(r.result).split(',')[1],type:f.type,name:f.name};go('compras');};
  r.readAsDataURL(f);
}

async function comprasExtraer(){
  if(!comprasFile)return;
  comprasStep='extract';go('compras');
  try{
    const d=await api('/api/compras/extract',{method:'POST',body:JSON.stringify({fileData:comprasFile.data,fileType:comprasFile.type})});
    if(d.__error){comprasExtracted={fecha_factura:null,numero_factura:null,proveedor:null,cuit:null,items:[],total_sin_iva:0,total_iva:0};comprasMsg=d.__error;}
    else{comprasExtracted=d;comprasMsg='';
      (d.__avisos||[]).forEach(a=>toast('⚠ '+a,'error'));}
  }catch(e){comprasExtracted={fecha_factura:null,numero_factura:null,proveedor:null,cuit:null,items:[],total_sin_iva:0,total_iva:0};comprasMsg='No se pudo extraer. Completá a mano.';}
  comprasAssignMode='total';comprasAssign={objetivo:'',unidad:'',comentario:''};comprasAssignments={};
  comprasStep='assign';go('compras');
}

// Lee lo que hay en el DOM y lo guarda en el estado (para no perderlo al re-renderizar)
function comprasCaptura(){
  const g=id=>document.getElementById(id);
  if(!comprasExtracted)return;
  if(g('cf-fecha')){
    comprasExtracted.fecha_factura=g('cf-fecha').value||null;
    comprasExtracted.numero_factura=g('cf-num').value||null;
    comprasExtracted.proveedor=g('cf-prov').value||null;
    comprasExtracted.cuit=g('cf-cuit').value||null;
    comprasExtracted.total_sin_iva=parseFloat(g('cf-neto').value)||0;
    comprasExtracted.total_iva=parseFloat(g('cf-iva').value)||0;
  }
  if(comprasAssignMode==='total'&&g('cf-obj')){
    comprasAssign={objetivo:g('cf-obj').value||'',unidad:g('cf-uni').value||'',comentario:g('cf-com').value||''};
  }
  if(comprasAssignMode==='per-item'){
    (comprasExtracted.items||[]).forEach((it,i)=>{
      const o=document.querySelector('[data-io="'+i+'"]'),u=document.querySelector('[data-iu="'+i+'"]'),c=document.querySelector('[data-ic="'+i+'"]');
      if(o)comprasAssignments[i]={objetivo:o.value||'',unidad:u?u.value:'',comentario:c?c.value:''};
    });
  }
}
function comprasSetMode(m){comprasCaptura();comprasAssignMode=m;go('compras');}

async function comprasGuardar(){
  comprasCaptura();
  const d=comprasExtracted||{};
  const inv={
    fecha_factura:d.fecha_factura||null,
    numero_factura:d.numero_factura||null,
    proveedor:d.proveedor||null,
    cuit:d.cuit||null,
    total_sin_iva:Number(d.total_sin_iva)||0,
    total_iva:Number(d.total_iva)||0,
    // Otros conceptos detectados por la IA. Default: percepciones se pagan
    // (exento=false), impuestos/tasas arrancan exentos (exento=true) porque
    // en la mayoría de nuestras facturas de seguros estamos exentos — se puede
    // cambiar con el check en el detalle.
    otros_conceptos:(d.otros_conceptos||[]).map(o=>({
      concepto:o.concepto||null, monto:Number(o.monto)||0, tipo:o.tipo||'otro',
      exento: o.exento!=null ? !!o.exento : (o.tipo==='impuesto'),
    })),
    items:d.items||[],
    assignmentMode:comprasAssignMode,
    assignments:comprasAssignMode==='per-item'?comprasAssignments:{},
    totalAssign:comprasAssignMode==='total'?comprasAssign:{objetivo:'',unidad:'',comentario:''},
    createdAt:new Date().toISOString(),
    // El comprobante viaja aparte: el backend lo sube a Storage y guarda solo la ruta
    fileData:comprasFile?comprasFile.data:null,
    fileType:comprasFile?comprasFile.type:null,
    fileName:comprasFile?comprasFile.name:null,
  };
  const btn=document.getElementById('cf-save');
  if(btn){btn.disabled=true;btn.textContent='Verificando…';}
  try{
    // Antes de guardar, chequear que la factura no esté ya cargada
    const dup=await api('/api/compras/duplicado',{method:'POST',
      body:JSON.stringify({numero_factura:inv.numero_factura,cuit:inv.cuit,proveedor:inv.proveedor})});
    if(dup.duplicado){
      const f=dup.factura;
      const seguir=confirm(
        `⚠️ Esta factura YA está cargada:\n\n`+
        `${f.proveedor||'—'}\n`+
        `N° ${f.numero_factura||'—'} · ${f.fecha_factura||'sin fecha'}\n`+
        `Total: ${money(f.total)}\n\n`+
        `¿Querés cargarla igual? (Aceptar = duplicar, Cancelar = no guardar)`);
      if(!seguir){
        if(btn){btn.disabled=false;btn.textContent='Guardar factura';}
        return;
      }
    }
    if(btn)btn.textContent='Guardando…';
    await api('/api/compras/factura',{method:'POST',body:JSON.stringify(inv)});
    comprasMode='lista';comprasFile=null;comprasExtracted=null;go('compras');
  }catch(e){if(btn){btn.disabled=false;btn.textContent='Guardar factura';}alert('No se pudo guardar: '+(e.message||''));}
}

function vComprasCarga(view){
  const oo=COMPRAS_OBJ.map(o=>`<option value="${o.replace(/"/g,'&quot;')}">${o}</option>`).join('');
  const uo=COMPRAS_UNI.map(u=>`<option value="${u.replace(/"/g,'&quot;')}">${u}</option>`).join('');
  const optSel=(v,val)=>v===val?' selected':'';
  if(comprasStep==='upload'){
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Nueva factura</div><div class="view-desc">Subí el PDF o imagen · la IA extrae los datos</div></div>
      <button class="btn-salir" onclick="comprasCancelar()">← Volver</button></div>
    <div style="max-width:520px">
      <label class="dropzone" id="cf-dz">
        <input type="file" accept="application/pdf,image/*" style="display:none" onchange="comprasPickFile(this)">
        <div class="dz-ico">＋</div>
        <div class="dz-t">${comprasFile?comprasFile.name:'Tocá para elegir un archivo'}</div>
        <div class="dz-s">PDF, JPG o PNG</div>
      </label>
      ${comprasFile?`<button class="btn" style="margin-top:14px;width:100%" onclick="comprasExtraer()">✦ Extraer con IA</button>`:''}
    </div>`;
    return;
  }
  if(comprasStep==='extract'){
    view.innerHTML=`<div class="view-head"><div class="view-title">Nueva factura</div></div>
      <div class="cargando-v">✦ Leyendo la factura con IA…</div>`;
    return;
  }
  // assign — dos columnas: datos + ítems | imputación (total o por ítem)
  const d=comprasExtracted||{};
  const items=d.items||[];
  const ooSel=val=>COMPRAS_OBJ.map(o=>`<option value="${o.replace(/"/g,'&quot;')}"${optSel(o,val)}>${o}</option>`).join('');
  const uoSel=val=>COMPRAS_UNI.map(u=>`<option value="${u.replace(/"/g,'&quot;')}"${optSel(u,val)}>${u}</option>`).join('');
  // Tabla de ítems
  const filasItems=items.map(it=>`<tr><td>${it.descripcion||'—'}</td><td class="money tr">${money(it.monto_sin_iva)}</td><td class="money tr">${money(it.iva)}</td></tr>`).join('');
  // Imputación
  let imput;
  if(comprasAssignMode==='total'){
    imput=`
      <div class="mm-field"><label>Objetivo</label><select id="cf-obj"><option value="">— Seleccioná —</option>${ooSel(comprasAssign.objetivo)}</select></div>
      <div class="mm-field"><label>Unidad</label><select id="cf-uni"><option value="">— Seleccioná —</option>${uoSel(comprasAssign.unidad)}</select></div>
      <div class="mm-field"><label>Comentarios</label><textarea id="cf-com" rows="2" class="ta-panel" placeholder="Obs...">${comprasAssign.comentario||''}</textarea></div>`;
  }else{
    imput=items.map((it,i)=>{const a=comprasAssignments[i]||{};return`
      <div class="item-imp">
        <div class="item-imp-head"><span>${it.descripcion||'Ítem '+(i+1)}</span><span class="money">${money((Number(it.monto_sin_iva)||0)+(Number(it.iva)||0))}</span></div>
        <div class="grid g-2">
          <div class="mm-field"><label>Objetivo</label><select data-io="${i}"><option value="">—</option>${ooSel(a.objetivo)}</select></div>
          <div class="mm-field"><label>Unidad</label><select data-iu="${i}"><option value="">—</option>${uoSel(a.unidad)}</select></div>
        </div>
        <div class="mm-field"><label>Comentarios</label><textarea data-ic="${i}" rows="1" class="ta-panel" placeholder="Obs...">${a.comentario||''}</textarea></div>
      </div>`;}).join('') || '<div class="sub" style="padding:12px 0">La factura no tiene ítems detallados. Usá "Total de factura".</div>';
  }
  view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Revisar y asignar</div><div class="view-desc">Verificá los datos e imputá objetivo / unidad</div></div>
      <button class="btn-salir" onclick="comprasCancelar()">← Cancelar</button></div>
    ${comprasMsg?`<div class="aviso-amarillo">${comprasMsg}</div>`:''}
    <div class="grid g-2" style="align-items:start">
      <div>
        <div class="mm-label">Datos extraídos</div>
        <div class="panel" style="margin-bottom:14px">
          <div class="grid g-2">
            <div class="mm-field"><label>Fecha</label><input id="cf-fecha" type="date" value="${d.fecha_factura||''}"></div>
            <div class="mm-field"><label>N° Factura</label><input id="cf-num" value="${(d.numero_factura||'').replace(/"/g,'&quot;')}"></div>
          </div>
          <div class="mm-field"><label>Proveedor</label><input id="cf-prov" value="${(d.proveedor||'').replace(/"/g,'&quot;')}"></div>
          <div class="grid g-2">
            <div class="mm-field"><label>CUIT</label><input id="cf-cuit" value="${(d.cuit||'').replace(/"/g,'&quot;')}"></div>
            <div class="mm-field"><label>Neto (sin IVA)</label><input id="cf-neto" type="number" step="0.01" value="${Number(d.total_sin_iva)||0}"></div>
          </div>
          <div class="mm-field"><label>IVA</label><input id="cf-iva" type="number" step="0.01" value="${Number(d.total_iva)||0}"></div>
        </div>
        <div class="mm-label">Ítems</div>
        <div class="tabla-wrap">
          <table><thead><tr><th>Descripción</th><th class="tr">Neto</th><th class="tr">IVA</th></tr></thead>
          <tbody>${filasItems}<tr class="tot-row"><td><b>Total</b></td><td class="money tr"><b>${money(d.total_sin_iva)}</b></td><td class="money tr"><b>${money(d.total_iva)}</b></td></tr></tbody></table>
        </div>
        ${(d.otros_conceptos||[]).length?`<div class="mm-label" style="margin-top:14px">Percepciones e impuestos</div>
        <div class="tabla-wrap"><table><thead><tr><th>Concepto</th><th>Tipo</th><th class="tr">Monto</th></tr></thead>
          <tbody>${(d.otros_conceptos).map(o=>`<tr><td>${o.concepto||'—'}</td>
            <td><span class="badge ${o.tipo==='percepcion'?'b-blue':o.tipo==='impuesto'?'b-amber':'b-gray'}">${cap(o.tipo||'otro')}</span></td>
            <td class="money tr">${money(o.monto)}</td></tr>`).join('')}</tbody></table></div>
        <div class="sub" style="margin-top:6px">Las <b>percepciones</b> se suman al total; los <b>impuestos/tasas</b> arrancan exentos. Podés cambiar cuáles se pagan con el check en el detalle de la factura, después de guardar.</div>`:''}
      </div>
      <div>
        <div class="mm-label">Imputación</div>
        <div class="toggle-imp">
          <button class="${comprasAssignMode==='total'?'on':''}" onclick="comprasSetMode('total')">Total de factura</button>
          <button class="${comprasAssignMode==='per-item'?'on':''}" onclick="comprasSetMode('per-item')">Por ítem</button>
        </div>
        <div class="panel">${imput}</div>
        <button class="btn" id="cf-save" style="width:100%;margin-top:14px" onclick="comprasGuardar()">Guardar factura</button>
      </div>
    </div>`;
}

/* ===== Kill switch (PIN de control) ===== */
// Chequea el estado antes de dejar operar. Si está bloqueado, muestra una
// pantalla de bloqueo a pantalla completa. Si falta poco, un cartel de aviso.
async function chequearBloqueo(){
  try{
    const r=await fetch('/api/control/estado');
    const st=await r.json();
    if(st.bloqueado){mostrarBloqueo();return true;}
    if(st.activo&&st.en_aviso)mostrarAvisoPin(st.dias_restantes);
    return false;
  }catch(e){return false;}   // fail-open: si no se puede consultar, no bloquea
}
function mostrarBloqueo(){
  document.getElementById('login').classList.remove('show');
  document.getElementById('app').classList.remove('show');
  let bg=document.getElementById('bloqueo-bg');
  if(!bg){
    bg=document.createElement('div');bg.id='bloqueo-bg';
    bg.style.cssText='position:fixed;inset:0;z-index:200;display:grid;place-items:center;background:var(--papel);padding:24px';
    bg.innerHTML=`<div style="max-width:440px;text-align:center;background:var(--blanco);border:1px solid var(--linea);border-radius:var(--r);padding:40px 34px;box-shadow:var(--sombra-lg)">
      <div style="width:56px;height:56px;border-radius:14px;background:var(--rojo-soft);display:grid;place-items:center;margin:0 auto 18px">
        <svg viewBox="0 0 24 24" width="28" fill="none" stroke="var(--rojo)" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div>
      <div style="font-size:20px;font-weight:700;margin-bottom:8px">Sistema bloqueado</div>
      <div style="color:var(--tinta-2);font-size:13.5px;line-height:1.6">El PIN de control venció. El bot y el panel están inactivos hasta que se renueve.<br><br>
        Para reactivar, cambiá la variable <b>SYSTEM_PIN</b> en Railway por un valor nuevo y redeployá.</div>
    </div>`;
    document.body.appendChild(bg);
  }
}
function mostrarAvisoPin(dias){
  if(document.getElementById('aviso-pin'))return;
  const div=document.createElement('div');div.id='aviso-pin';
  div.style.cssText='position:fixed;top:0;left:0;right:0;z-index:80;background:var(--diesel);color:#fff;padding:9px 18px;font-size:13px;text-align:center;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.15)';
  div.innerHTML=`⚠️ Faltan <b>${dias} día${dias===1?'':'s'}</b> para renovar el PIN de control (SYSTEM_PIN en Railway) o el sistema se bloquea.
    <span onclick="this.parentElement.remove()" style="margin-left:14px;cursor:pointer;opacity:.85;text-decoration:underline">ocultar</span>`;
  document.body.appendChild(div);
}

/* ===== Arranque ===== */
(async()=>{
  const bloqueado=await chequearBloqueo();
  if(bloqueado)return;   // no arrancamos nada si está vencido
  if(token){document.getElementById('login').classList.remove('show');iniciar();}
})();
