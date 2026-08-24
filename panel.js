const PANEL_BUILD = '2026-08-21 · filtros de taller y marca';  // escribí PANEL_BUILD en la consola para saber qué versión está corriendo

// ── AUTO-ACTUALIZACIÓN (10-ago) ──────────────────────────────────────────────
// Antes de esto, cada subida al repo obligaba a hacer Ctrl+Shift+R en cada
// máquina. Ahora el panel le pregunta al server cada 60 s qué versión está
// sirviendo (/api/panel-version, la huella cambia con cada redeploy) y, si hay
// una nueva, se recarga SOLO — pero nunca en mal momento: si hay una edición
// abierta, un modal en pantalla o una imputación vigilada en curso, espera y
// reintenta. El server además sirve /panel y /panel.js sin caché, así que la
// recarga trae la versión nueva de verdad (sin hard-refresh).
let _panelVer=null,_verNueva=false;
function panelOcupado(){
  try{
    if(typeof comprasEdit!=='undefined'&&comprasEdit)return true;              // editando una factura
    if(document.querySelector('.modal-bg.abierto'))return true;               // cualquier modal abierto
    if(typeof flxVigias!=='undefined'&&Object.keys(flxVigias).length)return true; // imputación en curso
  }catch(e){}
  return false;
}
async function chequearVersionPanel(){
  try{
    const d=await api('/api/panel-version');
    if(!d||!d.version)return;
    if(_panelVer===null){_panelVer=d.version;return;}   // primera vez: solo anotar
    if(d.version!==_panelVer)_verNueva=true;
  }catch(e){}
  if(_verNueva&&!panelOcupado()){
    try{toast('Actualizando el panel a la versión nueva…');}catch(e){}
    setTimeout(()=>location.reload(),900);
  }
}
setInterval(chequearVersionPanel,60*1000);
setTimeout(chequearVersionPanel,5000);

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
let repFEstado = '', repFPrio = '', repFMec = '', repFObj = '';
let repFQ = '';   // buscador de Reparaciones→Resumen
let repFIngreso = '';   // '' | sin | en  — filtro por ingreso al taller

/* Estados y colores de reparaciones */
const EST_REP = ['pendiente','diagnostico','esperando_repuestos','en_reparacion','finalizado'];
const EST_REP_LABEL = ['Pendiente','Diagnóstico','Esp. repuestos','En reparación','Finalizado'];
// Etiquetas cortas del motivo de cierre, para la columna Estado de la lista
const MOTIVO_CIERRE_CORTO = {
  no_ingreso: 'no ingresó',
  resuelto_en_campo: 'resuelta en campo',
  sin_falla: 'sin falla',
  duplicado: 'repetida',
  otro: 'sin reparar',
};
const PRIO_BADGE = {critico:'b-red',alta:'b-amber',media:'b-blue',baja:'b-green'};
// Badge de prioridad con jerarquía visual real: el crítico tiene que saltar a
// la cara en una lista con 44 "alta". Crítico = rojo pleno + ●, alta = ámbar
// con borde, media/baja quedan suaves para no competir.
const PRIO_STYLE={
  critico:'background:var(--rojo);color:#fff;font-weight:700;box-shadow:0 0 0 3px var(--rojo-soft)',
  alta:'background:var(--diesel-soft);color:var(--diesel);font-weight:700;border:1.5px solid var(--diesel)',
  media:'background:var(--azul-soft);color:var(--azul)',
  baja:'background:var(--brote-soft);color:var(--brote-2)',
};
function prioBadge(p){
  const k=String(p||'').toLowerCase();
  const st=PRIO_STYLE[k]||'background:var(--papel);color:var(--tinta-2)';
  const punto=k==='critico'?'● ':k==='alta'?'▲ ':'';
  return `<span class="badge" style="${st}">${punto}${cap(p||'—')}</span>`;
}
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
/* ── Aviso de preventivos ────────────────────────────────────────
   Al entrar al panel aparece un popup con los preventivos que se
   vencieron o están por vencer. La regla importa más que el diseño: si
   apareciera todos los días con lo mismo, en dos semanas se cierra sin
   leer. Por eso solo salta cuando hay algo NUEVO respecto de la última
   vez, o algo vencido. La campanita queda siempre disponible.

   Todo sale del endpoint que ya existe (/api/reparaciones/preventivo):
   cada rodado trae `estado` (vencido | por_vencer | al_dia | …) y
   `restan` en días. No hace falta nada nuevo en la base. */
let prevAviso=null;                       // {vencidos, porVencer, nuevos}
let prevRodados=[];                       // los rodados tal cual vienen del server
const PREV_VISTOS='eco_prev_vistos';      // {id: estado} de la última vez
const PREV_SILENCIO='eco_prev_silencio';  // firma del set silenciado

function prevClave(r){return `${r.id}:${r.estado}`;}
function prevFirma(lista){return lista.map(prevClave).sort().join('|');}

/* Se piden los preventivos y se decide si corresponde molestar. */
async function chequearPreventivos(){
  let d;
  try{d=await api('/api/reparaciones/preventivo');}
  catch(e){return;}   // si falla, no se muestra nada: es un aviso, no una función crítica
  // Entran los vencidos y los que vencen dentro de 3 días — el aviso tiene
  // que llegar con tiempo de organizar el taller, no el día que venció.
  const AVISO_DIAS=3;
  const rodados=(d.rodados||[]).filter(r=>
    r.estado==='vencido'||(r.restan!=null&&r.restan<=AVISO_DIAS));
  // Se guardan los mecánicos sugeridos para el generador del popup
  prevRodados=rodados;
  if(!rodados.length){
    prevAviso=null;pintarCampana();
    localStorage.removeItem(PREV_SILENCIO);
    return;
  }
  // Qué es NUEVO: un rodado que antes no estaba en la lista, o que empeoró
  // (pasó de por_vencer a vencido). Así el aviso es información, no ruido.
  let vistos={};
  try{vistos=JSON.parse(localStorage.getItem(PREV_VISTOS)||'{}');}catch(e){}
  const nuevos=rodados.filter(r=>vistos[r.id]!==r.estado);
  const vencidos=rodados.filter(r=>r.estado==='vencido');

  prevAviso={
    todos:rodados.sort((a,b)=>(a.restan==null?9999:a.restan)-(b.restan==null?9999:b.restan)),
    nuevos, vencidos,
    porVencer:rodados.filter(r=>r.estado==='por_vencer'),
  };
  pintarCampana();

  // El popup salta si hay algo nuevo o algo vencido… salvo que José haya
  // pedido silencio para EXACTAMENTE este conjunto (si aparece uno más,
  // el silencio se rompe solo).
  const firma=prevFirma(rodados);
  if(localStorage.getItem(PREV_SILENCIO)===firma)return;
  if(nuevos.length||vencidos.length)abrirPopupPreventivos();
}

function pintarCampana(){
  const cont=document.getElementById('prev-campana');
  if(!cont)return;
  if(!prevAviso||!prevAviso.todos.length){cont.innerHTML='';return;}
  const n=prevAviso.todos.length, hayVenc=prevAviso.vencidos.length>0;
  cont.innerHTML=`<button onclick="abrirPopupPreventivos(true)" title="Preventivos que vencen o vencieron"
    style="position:relative;display:inline-flex;align-items:center;gap:6px;background:none;border:1px solid var(--linea);border-radius:9px;padding:6px 11px;font-family:inherit;font-size:12.5px;cursor:pointer;color:var(--tinta-2)">
    🗓 <span>Preventivos</span>
    <span style="position:absolute;top:-6px;right:-6px;background:${hayVenc?'var(--rojo)':'var(--diesel)'};color:#fff;font-size:10px;font-weight:700;border-radius:10px;padding:1px 6px;font-family:ui-monospace,monospace">${n}</span>
  </button>`;
}

function abrirPopupPreventivos(manual){
  const a=prevAviso;if(!a||!a.todos.length)return;
  const fila=r=>{
    const venc=r.estado==='vencido';
    const dias=r.restan==null?null:r.restan;
    const nuevo=a.nuevos.some(x=>x.id===r.id);
    const col=venc?'var(--rojo)':'var(--diesel)';
    const fondo=venc?'var(--rojo-soft)':'var(--diesel-soft)';
    return `<div style="border:1px solid var(--linea);border-left:3px solid ${col};background:${fondo};border-radius:10px;padding:10px 13px;margin-bottom:8px;display:flex;gap:11px;align-items:flex-start">
      <div style="font-size:17px;flex-shrink:0">${venc?'🔴':'🟠'}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:13.5px">${escStk(r.tipo_label||r.tipo||'Equipo')}
          <span class="uni-num">${escStk(r.codigo||r.patente||'S/N')}</span>
          ${nuevo?'<span class="badge" style="background:#EDE7FB;color:#5B3FB8;font-size:10px">nuevo</span>':''}</div>
        <div class="sub" style="font-size:12px">${escStk(r.marca_modelo||'')}${r.intervalo?` · service cada ${r.intervalo} días`:''}</div>
        <div class="sub" style="font-size:11.5px;margin-top:2px">
          ${r.ultimo?`Último service: ${fechaAR(r.ultimo)}${r.dias!=null?` · hace ${r.dias} días`:''}`:'Sin service registrado'}
          ${r.reprogramado?' · <b>reprogramado</b>':''}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        ${venc
          ? `<span class="badge b-rojo">vencido${dias!=null&&dias<0?` hace ${Math.abs(dias)} d`:''}</span>`
          : `<span class="badge b-amber">${dias===0?'vence hoy':`en ${dias} d`}</span>`}
        ${r.incidencia_abierta
          ? `<div class="sub" style="font-size:10.5px;margin-top:3px">ya está en taller</div>`
          : `<button class="mini-btn" style="margin-top:5px;color:var(--brote-2);font-weight:600" onclick="prevGenerar('${r.id}')">+ Generar orden</button>`}
      </div>
    </div>`;
  };
  const muestra=a.todos.slice(0,5), resto=a.todos.length-muestra.length;

  document.getElementById('mm-titulo').innerHTML=`🗓 Preventivos
    <span style="background:var(--violeta,#7C5CD6);color:#fff;font-size:11px;font-weight:700;border-radius:20px;padding:2px 9px;font-family:ui-monospace,monospace;margin-left:6px">${a.todos.length}</span>`;
  document.getElementById('mm-campos').innerHTML=`
    <div class="sub" style="margin-bottom:12px">
      ${a.vencidos.length?`<b style="color:var(--rojo)">${a.vencidos.length} vencido${a.vencidos.length===1?'':'s'}</b>`:''}
      ${a.vencidos.length&&a.porVencer.length?' · ':''}
      ${a.porVencer.length?`${a.porVencer.length} por vencer`:''}
      ${a.nuevos.length?` · <b style="color:#5B3FB8">${a.nuevos.length} desde tu última entrada</b>`:''}
    </div>
    ${muestra.map(fila).join('')}
    ${resto>0?`<div class="sub" style="font-size:12.5px;text-align:center;padding:6px 0">y ${resto} más — vas a verlos todos en Reparaciones → Preventivo</div>`:''}
    <div class="modal-acciones" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <label class="sub" style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
        <input type="checkbox" id="prev-silencio" style="accent-color:var(--brote)">
        No mostrar hasta que aparezca otro
      </label>
      <div style="display:flex;gap:8px">
        <button class="btn-salir" onclick="cerrarPopupPreventivos()">Después</button>
        <button class="btn" onclick="cerrarPopupPreventivos();repTab='preventivo';go('reparaciones')">Ver preventivos →</button>
      </div>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
}

/* Generar la orden desde el popup. José elige el mecánico ANTES de
   crearla: una orden sin dueño en el Resumen no la agarra nadie. */
function prevGenerar(unidadId){
  const r=(prevRodados||[]).find(x=>x.id===unidadId);
  if(!r)return;
  const inp='width:100%;padding:9px 11px;border:1px solid var(--linea);border-radius:9px;font-family:inherit;font-size:13.5px;box-sizing:border-box';
  document.getElementById('mm-titulo').textContent='Generar orden de preventivo';
  document.getElementById('mm-campos').innerHTML=`
    <div class="sub" style="margin-bottom:12px">
      <b style="color:var(--tinta);font-size:14px">${escStk(r.tipo_label||r.tipo||'Equipo')} · ${escStk(r.codigo||r.patente||'S/N')}</b>
      <div style="margin-top:3px">${r.estado==='vencido'
        ?`<span style="color:var(--rojo)">Vencido${r.restan!=null&&r.restan<0?` hace ${Math.abs(r.restan)} días`:''}</span>`
        :`Vence ${r.restan===0?'hoy':`en ${r.restan} días`}`}
        ${r.proximo?` · ${fechaAR(r.proximo)}`:''}</div>
    </div>
    <div class="mm-field"><label>Mecánico que lo va a hacer *</label>
      <select id="pg-mec" style="${inp}">
        <option value="">— elegí —</option>
        ${(mecanicos||[]).map(m=>`<option value="${m.id}" ${r.prev_mecanico_id===m.id?'selected':''}>${escStk(m.nombre)}</option>`).join('')}
      </select>
      ${r.prev_mecanico?`<div class="sub" style="font-size:11.5px;margin-top:3px">Suele hacerlo ${escStk(r.prev_mecanico)}</div>`:''}</div>
    <div class="mm-field"><label>Prioridad</label>
      <select id="pg-prio" style="${inp}">
        <option value="baja">Baja</option>
        <option value="media" selected>Media</option>
        <option value="alta">Alta</option>
      </select></div>
    ${r.prev_tarea?`<div class="sub" style="font-size:12.5px;background:var(--papel);border-radius:8px;padding:9px 12px;margin-top:6px">
      <b>Qué incluye:</b> ${escStk(r.prev_tarea)}</div>`:''}
    <div class="sub" style="font-size:11.5px;margin-top:8px">La orden aparece en Reparaciones → Resumen como cualquier otra incidencia.</div>
    <div class="modal-acciones">
      <button class="btn-salir" onclick="cerrarMaestro();abrirPopupPreventivos(true)">← Volver</button>
      <button class="btn" onclick="prevGenerarConfirmar('${r.id}')">Generar orden</button>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
}
async function prevGenerarConfirmar(unidadId){
  const g=x=>document.getElementById(x);
  const mec=g('pg-mec')?g('pg-mec').value:'';
  if(!mec){toast('Elegí el mecánico','error');return;}
  const r=(prevRodados||[]).find(x=>x.id===unidadId)||{};
  try{
    await api('/api/reparaciones/preventivo/generar',{method:'POST',body:JSON.stringify({
      unidad_id:unidadId, mecanico_id:mec, prioridad:g('pg-prio').value,
      vence:r.proximo?String(r.proximo).slice(0,10):null})});
    cerrarMaestro();
    toast('Orden generada · ya está en Reparaciones');
    repData=null;pvData=null;
    await chequearPreventivos();   // se recalcula: ese ya no debe figurar
  }catch(e){toast('No pude generar: '+(e.message||''),'error');}
}

/* Al cerrar se guarda lo visto: así lo de hoy no vuelve a contar como
   nuevo mañana, pero lo que empeore sí. */
function cerrarPopupPreventivos(){
  const a=prevAviso;
  if(a){
    const vistos={};
    a.todos.forEach(r=>{vistos[r.id]=r.estado;});
    try{localStorage.setItem(PREV_VISTOS,JSON.stringify(vistos));}catch(e){}
    const chk=document.getElementById('prev-silencio');
    if(chk&&chk.checked){
      try{localStorage.setItem(PREV_SILENCIO,prevFirma(a.todos));}catch(e){}
    }else{
      localStorage.removeItem(PREV_SILENCIO);
    }
    a.nuevos=[];pintarCampana();
  }
  cerrarMaestro();
}

function salir(){
  token=null; ['eco_token','eco_user','eco_mods','eco_admin'].forEach(k=>localStorage.removeItem(k));
  prevAviso=null;   // el aviso se recalcula en el próximo ingreso
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
  // El aviso de preventivos va DESPUÉS de pintar la vista: si saltara antes,
  // el popup aparecería sobre una pantalla en blanco. Solo para quien ve
  // Reparaciones — al resto no le sirve de nada.
  if(puedeVer('reparaciones'))setTimeout(chequearPreventivos,600);
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
const CRUMB={dashboard:'Dashboard',bateas:'Bateas',insumos:'Insumos',combustible:'Combustible',reparaciones:'Reparaciones',maestros:'Maestros',compras:'Compras',stock:'Stock',movimientos:'Movimientos'};
let _autoRefreshTimer=null, _vistaActual=null;
// AJUSTE 11-ago (pedido de José): la pantalla se recargaba sola cada 5 minutos
// y era molesto. Ahora cada 4 horas — alcanza de sobra, y si querés datos
// frescos ya, cambiás de módulo o apretás F5.
const AUTO_REFRESH_MS=4*60*60*1000; // 4 horas
const MODULOS_AUTOREFRESH=['reparaciones','compras','insumos','movimientos'];
// Watcher de novedades en Reparaciones: cada 5 min compara una firma liviana
// (estado de cada incidencia + estado de cada pedido de repuestos + cantidad
// de comentarios). Solo repinta si algo CAMBIÓ de verdad —nueva incidencia,
// respuesta de compras, avance de estado—; si no cambió nada, no toca la
// pantalla. Antes chequeaba cada 90s: bajaba el ruido pero pegaba seguido.
let _repFirma=null;
setInterval(async function(){
  if(_vistaActual!=='reparaciones')return;
  try{
    const reps=await api('/api/reparaciones');
    const firma=reps.map(r=>r.id+':'+r.estado
      +':'+((r.repuestos_taller||[]).map(x=>x.id+'-'+x.estado).join('|'))
      +':'+((r.comentarios_incidencias||[]).length)).sort().join(';');
    if(_repFirma===null){_repFirma=firma;return;}
    if(firma===_repFirma)return;
    _repFirma=firma;
    const hayModal=document.querySelector('.modal-bg.abierto');
    if(_vistaActual==='reparaciones'&&!hayModal&&!repDetalleAbierto){
      go('reparaciones');
      toast('Hay novedades en reparaciones — actualizado','info');
    }else{
      toast('Hay novedades en reparaciones (se actualiza al cerrar lo que estás viendo)','info');
    }
  }catch(e){}
},5*60*1000);
function programarAutoRefresh(v){
  clearTimeout(_autoRefreshTimer);
  if(!MODULOS_AUTOREFRESH.includes(v))return;
  _autoRefreshTimer=setTimeout(function tick(){
    // No refrescar si: cambiaste de módulo, hay un modal abierto, o estás
    // mirando/editando un detalle (para no patearte lo que tenés en pantalla)
    const hayModal=document.querySelector('.modal-bg.abierto');
    const hayDetalle=(v==='reparaciones'&&repDetalleAbierto)||(v==='compras'&&(comprasVer!=null||comprasMode==='carga'||comprasMode==='detalle'));
    if(_vistaActual===v&&!hayModal&&!hayDetalle){
      _repFirma=null;              // el watcher rearma su firma tras el refresh
      go(v);                       // recarga el módulo
      toast('Datos actualizados','info');
    }else{
      _autoRefreshTimer=setTimeout(tick,10*60*1000); // ocupado: reintenta en 10 min
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
  if(v==='movimientos')vMovimientos(view);
  if(v==='reportes')vReportes(view);
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
    const dv=d.desvios||{},env=d.envejecimiento||{},rf=d.repuestos_frenados||{};
    const estancadas=d.estancadas||[];
    const alertas=d.alertas||[];
    // El mes en curso está incompleto: comparar contra el mes anterior ENTERO
    // siempre da caída. Se usa el mismo día del mes anterior y la proyección.
    const varDia=dv.var_mismo_dia!=null?Math.round(dv.var_mismo_dia):null;
    const varProm=dv.var_vs_promedio!=null?Math.round(dv.var_vs_promedio):null;
    const flecha=v=>v==null?'':v>0?'▲':v<0?'▼':'=';
    const colorVar=(v,malSube)=>v==null?'var(--tinta-3)':(malSube?(v>8?'var(--rojo)':v<-8?'var(--brote-2)':'var(--tinta-2)')
      :(v>8?'var(--brote-2)':v<-8?'var(--rojo)':'var(--tinta-2)'));

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

    // Números rápidos del mes: bateas, combustible, urgencias y frenado.
    // Todos con la misma lógica que el gasto: comparación a IGUAL DÍA del mes
    // anterior, porque el mes en curso está incompleto.
    const bt=d.bateas||{},cm=d.combustible_mes||{},fr=d.frenado||{};
    const num=n=>Math.round(Number(n)||0).toLocaleString('es-AR');
    const ind=(label,valor,unidad,varPc,detalle,click,malSube)=>{
      const v=varPc!=null?Math.round(varPc):null;
      return `<div style="padding:9px 0;border-bottom:1px solid var(--papel);${click?'cursor:pointer':''}" ${click?`onclick="${click}"`:''}>
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <span style="font-size:12px;font-weight:600">${label}</span>
          <span><span class="mono" style="font-size:17px;font-weight:700">${valor}</span>
            <span class="sub" style="font-size:11px">${unidad||''}</span></span></div>
        <div style="display:flex;justify-content:space-between;gap:8px;margin-top:2px">
          <span class="sub" style="font-size:11px">${detalle||''}</span>
          ${v!=null?`<span style="font-size:11px;font-weight:600;color:${colorVar(v,!!malSube)}">${flecha(v)} ${v>0?'+':''}${v}% vs igual fecha</span>`:'<span class="sub" style="font-size:11px">sin comparación</span>'}</div>
      </div>`;};
    const criticasAltas=(prio.critico||0)+(prio.alta||0);
    const miniInd=
      ind('Bateas',num(bt.bateas),`en ${bt.jornadas||0} jornadas`,bt.var_pct,
        `${(bt.prom_jornada||0).toFixed(1)} por jornada · proyecta ${num(bt.proyectado)} · ${num(bt.m3)} m³`,"go('bateas')",false)
      +ind('Combustible',num(cm.litros),'lt',cm.var_pct,
        `${cm.cargas||0} cargas · proyecta ${num(cm.proyectado)} lt${cm.sin_facturar?' · '+cm.sin_facturar+' sin facturar':''}`,"go('combustible')",true)
      +`<div style="padding:9px 0;border-bottom:1px solid var(--papel);cursor:pointer" onclick="repFPrio='critico';go('reparaciones')">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <span style="font-size:12px;font-weight:600">Críticas y altas abiertas</span>
          <span class="mono" style="font-size:17px;font-weight:700;color:${criticasAltas?'var(--rojo)':'var(--brote-2)'}">${criticasAltas}</span></div>
        <div class="sub" style="font-size:11px;margin-top:2px">${prio.critico||0} crítica(s) · ${prio.alta||0} alta(s) de ${t.activas||0} activas</div></div>`
      +`<div style="padding:9px 0">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <span style="font-size:12px;font-weight:600">Tiempo de máquina frenada</span>
          <span><span class="mono" style="font-size:17px;font-weight:700">${fr.prom_dias!=null?fr.prom_dias.toFixed(1):'—'}</span>
            <span class="sub" style="font-size:11px">días prom.</span></span></div>
        <div class="sub" style="font-size:11px;margin-top:2px">${fr.resueltas_mes||0} resueltas este mes${fr.peor!=null?' · la peor '+fr.peor.toFixed(0)+' d':''}${fr.dias_acumulados_abiertas?' · '+fr.dias_acumulados_abiertas+' días acumulados sin resolver':''}</div></div>`;

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
      ${kpi('Gasto · va del mes',mm(c.gasto_mes),
        varDia!=null?`<span style="color:${colorVar(varDia,true)}">${flecha(varDia)} ${varDia>0?'+':''}${varDia}% vs el día ${d.dia_del_mes} del mes pasado</span>`
          :`día ${d.dia_del_mes} de ${d.dias_del_mes} · sin comparación`,
        null,"go('compras')")}
      ${kpi('Proyección de cierre',mm(dv.gasto_proyectado),
        varProm!=null?`<span style="color:${colorVar(varProm,true)}">${flecha(varProm)} ${varProm>0?'+':''}${varProm}% vs promedio ${mm(dv.promedio_3m)}</span>`
          :'al ritmo de lo que va del mes',
        varProm!=null&&varProm>15?{bg:'var(--rojo-soft)',col:'var(--rojo)',subCol:'var(--rojo)'}:null,"comprasTab='indicadores';go('compras')")}
      ${kpi('Máquinas paradas',paradas.length,
        paradas.length?(paradas.filter(p=>p.dias>=3).length?paradas.filter(p=>p.dias>=3).length+' hace 3 días o más':'la más vieja hace '+paradas[0].dias+' d'):'ninguna ✓',
        paradas.filter(p=>p.dias>=3).length?{bg:'var(--rojo-soft)',col:'var(--rojo)',subCol:'var(--rojo)'}:null,"go('reparaciones')")}
      ${kpi('Trabadas',(estancadas.length||0)+(rf.cotizados||0),
        `${estancadas.length} reparación(es) +7 d · ${rf.cotizados||0} repuesto(s) sin aprobar`,
        (estancadas.length+(rf.cotizados||0))?{bg:'var(--diesel-soft)',col:'var(--diesel)',subCol:'var(--diesel)'}:null,"go('reparaciones')")}
    </div>

    ${alertas.length?`<div class="panel" style="padding:12px 14px;margin-bottom:10px;border-left:3px solid ${alertas[0].nivel==='alto'?'var(--rojo)':'var(--diesel)'}">
      <div style="font-size:13.5px;font-weight:600;margin-bottom:8px">Requiere tu atención</div>
      ${alertas.map(al=>{const col=al.nivel==='alto'?'var(--rojo)':al.nivel==='medio'?'var(--diesel)':'var(--tinta-3)';
        return `<div style="display:flex;gap:9px;align-items:flex-start;padding:5px 0;border-bottom:1px solid var(--papel);cursor:pointer" onclick="go('${al.modulo}')">
          <span style="color:${col};font-size:15px;line-height:1.1">●</span>
          <div style="flex:1;min-width:0"><div style="font-size:12.5px;font-weight:600">${al.texto}</div>
            ${al.detalle?`<div class="sub" style="font-size:11.5px">${al.detalle}</div>`:''}</div>
          <span class="sub" style="font-size:11px;white-space:nowrap">${al.modulo} →</span></div>`;}).join('')}
    </div>`:`<div class="panel" style="padding:12px 14px;margin-bottom:10px;border-left:3px solid var(--brote)">
      <div style="font-size:13px">Nada pendiente que requiera tu atención hoy ✓</div></div>`}

    <div style="display:grid;grid-template-columns:1.35fr 1fr;gap:10px;margin-bottom:10px">
      <div class="panel" style="padding:14px 16px;cursor:pointer" onclick="comprasTab='indicadores';go('compras')">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <div style="font-size:13.5px;font-weight:600"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:15px;height:15px;vertical-align:-2px;margin-right:4px"><circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M3 4h2l2.5 12h10L20 8H6.2"/></svg>Compras · evolución del gasto</div>
          <div class="sub" style="font-size:11px">últimos 6 meses</div></div>
        ${svgEvol}</div>
      <div class="panel" style="padding:14px 16px">
        <div style="font-size:13.5px;font-weight:600;margin-bottom:10px">Cómo venimos este mes</div>
        ${miniInd}</div>
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
        ${(()=>{const E=[['hasta_3','0-3 d','var(--brote)'],['de_4_a_7','4-7 d','#8FBF6A'],['de_8_a_15','8-15 d','#EF9F27'],['mas_15','+15 d','var(--rojo)']];
          const tot=E.reduce((a,[k])=>a+(env[k]||0),0);
          if(!tot)return '';
          return `<div style="font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;color:var(--tinta-3);margin-bottom:4px">Cuánto llevan abiertas</div>
          <div style="display:flex;height:9px;border-radius:5px;overflow:hidden;margin-bottom:5px">
            ${E.map(([k,l,c])=>(env[k]||0)?`<div title="${env[k]} ${l}" style="width:${(env[k]*100/tot)}%;background:${c}"></div>`:'').join('')}
          </div>
          <div style="display:flex;gap:10px;font-size:11px;margin-bottom:11px;flex-wrap:wrap">
            ${E.map(([k,l,c])=>(env[k]||0)?`<span style="color:${c}">■ <span class="mono">${env[k]}</span> ${l}</span>`:'').join('')}
          </div>`;})()}
        <div style="font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;color:var(--tinta-3);margin-bottom:4px">Paradas ahora</div>
        ${listaParadas}
        ${estancadas.length?`<div style="font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;color:var(--tinta-3);margin:11px 0 4px">Abiertas hace más de 7 días</div>
        ${estancadas.slice(0,4).map(e=>`<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--papel);font-size:12.5px">
          <div style="flex:1;min-width:0"><b>${e.equipo}</b> <span class="sub" style="font-size:11px">${e.estado} · ${e.mecanico}</span></div>
          <span class="mono" style="font-size:12px;font-weight:600;color:${e.dias>15?'var(--rojo)':'var(--diesel)'}">${e.dias} d</span></div>`).join('')}
        ${estancadas.length>4?`<div class="sub" style="font-size:11px;margin-top:4px">y ${estancadas.length-4} más</div>`:''}`:''}</div>
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
  <button class="${insTab==='compra'?'on':''}" onclick="insTab='compra';go('insumos')">Qué comprar</button>
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

// "Qué comprar": todos los pedidos pendientes juntos, agrupados por insumo.
// Una sola pasada de compra cubre todo; el ✓ marca el ítem comprado en TODOS
// los pedidos que lo incluyen (el pañol después entrega por objetivo, igual
// que siempre). Los específicos (una sola aparición) quedan como línea propia.
function normIns(t){return String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();}
async function vInsCompra(view,datos){
  const esPend=p=>p.estado==='pendiente'||p.estado==='en_compra';
  const pends=(datos||[]).filter(esPend);
  const grupos={};
  pends.forEach(p=>{
    const obj=p.objetivos?p.objetivos.nombre:(p.objetivo_texto||'—');
    (p.pedidos_insumos_items||[]).forEach(i=>{
      const k=normIns(i.item);if(!k)return;
      const g=grupos[k]=grupos[k]||{nombre:i.item,n:0,objs:[],masViejo:null,comprados:0,cants:[]};
      g.n++;g.objs.push(obj);
      if(i.cantidad&&String(i.cantidad).trim()&&String(i.cantidad).trim()!=='1')g.cants.push(String(i.cantidad).trim());
      if(i.comprado)g.comprados++;
      const d=diasEntre(p.created_at,new Date().toISOString());
      if(d!=null&&(g.masViejo==null||d>g.masViejo))g.masViejo=d;
    });
  });
  const lista=Object.entries(grupos).map(([k,g])=>({k,...g,comprado:g.comprados>=g.n}))
    .sort((a,b)=>(a.comprado?1:0)-(b.comprado?1:0)||b.n-a.n||(b.masViejo||0)-(a.masViejo||0));
  const maxN=lista.length?Math.max(...lista.map(g=>g.n)):1;
  const filas=lista.map(g=>{
    const dias=g.masViejo!=null?Math.round(g.masViejo*10)/10:null;
    const objsU=[...new Set(g.objs)];
    return `<tr style="${g.comprado?'opacity:.5':''}">
      <td><div style="font-weight:600">${g.nombre}${g.n===1?' <span class="badge b-amber" style="font-size:9.5px">específico</span>':''}${g.cants.length?` <span class="sub" style="font-size:11px">(${g.cants.join(' + ')})</span>`:''}</div>
        ${g.n>1?`<div style="height:4px;background:var(--papel);border-radius:2px;margin-top:4px;max-width:140px"><div style="height:4px;width:${Math.max(6,Math.round(g.n*100/maxN))}%;background:var(--brote);border-radius:2px"></div></div>`:''}</td>
      <td class="num mono" style="font-weight:600">${g.n}</td>
      <td><span class="sub" style="font-size:11px">${objsU.slice(0,6).join(' · ')}${objsU.length>6?' <b>+'+(objsU.length-6)+'</b>':''}</span></td>
      <td class="num mono" style="${dias>=3?'color:#854F0B;font-weight:600':''}">${dias!=null?dias+' d':'—'}</td>
      <td class="num"><button class="mini-btn" style="${g.comprado?'color:var(--brote-2);border-color:var(--brote)':''}" onclick="insMarcarComprado('${g.k.replace(/'/g,"\\'")}',${g.comprado?'false':'true'})">${g.comprado?'✓ Comprado':'Marcar comprado'}</button></td>
    </tr>`;}).join('');
  view.innerHTML=`
  <div class="view-head"><div><div class="view-title">Qué comprar</div>
    <div class="view-desc">${pends.length} pedidos abiertos · ${lista.length} ítems distintos · el ✓ tilda el ítem en todos los pedidos que lo incluyen</div></div>
    <button class="btn-salir" onclick="insCopiarLista()">📋 Copiar lista de compra</button></div>
  ${tabsIns()}
  ${lista.length?`<div class="panel"><table style="font-size:12.5px">
    <thead><tr><th>Insumo</th><th class="num">Pedidos</th><th>Lo esperan</th><th class="num">Más viejo</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table></div>`
    :'<div class="empty" style="height:200px"><div>No hay pedidos pendientes 🎉</div></div>'}`;
  window.__insListaCompra=lista.filter(g=>!g.comprado).map(g=>'• '+g.nombre+(g.n>1?' ×'+g.n+' pedidos':'')+(g.cants.length?' ('+g.cants.join(' + ')+')':''));
}
async function insMarcarComprado(clave,marcar){
  try{
    const r=await api('/api/insumos/comprar',{method:'POST',body:JSON.stringify({item:clave,comprado:marcar})});
    toast(marcar?('Marcado comprado en '+r.actualizados+' pedido'+(r.actualizados===1?'':'s')+' ✓'):'Desmarcado');
    go('insumos');
  }catch(e){toast(e.message||'No pude marcar','error');}
}
function insCopiarLista(){
  const l=window.__insListaCompra||[];
  if(!l.length){toast('No queda nada por comprar 🎉');return;}
  navigator.clipboard.writeText('LISTA DE COMPRA · '+fechaAR(new Date().toISOString())+'\n'+l.join('\n'))
    .then(()=>toast('Lista copiada ('+l.length+' ítems) — pegala en WhatsApp o donde quieras'))
    .catch(()=>toast('No pude copiar','error'));
}
async function vInsumos(view){
  try{
    insumosData=await api('/api/insumos');
    if(insTab==='indicadores'){vInsInd(view,insumosData);return;}
    if(insTab==='compra'){vInsCompra(view,insumosData);return;}
    // 'en_compra' quedó como estado legacy: en la UI cuenta como pendiente.
    const esPend=p=>p.estado==='pendiente'||p.estado==='en_compra';
    if(filtroIns==='pendiente')insumosData=insumosData.filter(esPend);
    else if(filtroIns==='entregado')insumosData=insumosData.filter(p=>p.estado==='entregado');
    else if(filtroIns==='faltantes')insumosData=insumosData.filter(p=>p.estado==='entregado'&&p.entrega_completa===false);
    const chips=[['','Todos'],['pendiente','Pendiente'],['entregado','Entregado'],['faltantes','Con faltantes']].map(([e,l])=>
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
            <td>${p.estado==='cancelado'?'<span class="badge b-red">cancelado</span>':railEstado(idx,2,false)+'<div class="sub mono" style="margin-top:5px">'+(p.estado==='entregado'?(p.entrega_completa===false?'<span style="color:var(--diesel);font-weight:600">⚠ Entregado con faltantes</span>':'<span style="color:var(--brote-2);font-weight:600">✓ Entregado completo</span>'):'Pendiente')+(pt?' · <span style="color:'+pt.color+';font-weight:600">'+pt.texto+'</span>':'')+'</div>'}</td></tr>`;}).join('')
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
  const all=p.pedidos_insumos_items||[];
  let items;
  if(p.estado==='entregado'){
    // Una línea por material del pedido: ✓ verde si se entregó (con la cantidad
    // que salió) o ✕ ámbar si faltó. Así se ve pedido vs entregado de un vistazo.
    items=all.map(i=>{
      const ent=i.entregado!==false;
      const cant=ent?(i.cantidad_entregada||i.cantidad||''):(i.cantidad||'');
      return `<div class="mcard-row" style="${ent?'':'color:var(--diesel)'}">
        <span>${ent?'<span style="color:var(--brote-2)">✓</span>':'<span style="color:var(--diesel)">✕</span>'} ${i.item}${ent?'':' <span style="font-size:11px">(faltó)</span>'}</span>
        <b>${cant||(ent?'—':'')}</b></div>`;
    }).join('');
  }else{
    items=all.map(i=>`<div class="mcard-row"><span>${i.item}</span><b>${i.cantidad||'—'}</b></div>`).join('');
  }
  let acc='';
  if(p.estado!=='cancelado'&&p.estado!=='entregado')
    acc=`<button class="btn" style="width:100%;justify-content:center" onclick="abrirEntrega(${ix})">Marcar entregado →</button>`;
  const cancelar=(p.estado!=='cancelado'&&p.estado!=='entregado')?`<button class="btn ghost" style="width:100%;justify-content:center;margin-top:8px;color:var(--rojo);border-color:var(--rojo-soft)" onclick="cambiarInsumo('${p.id}','cancelado')">Cancelar pedido</button>`:'';
  const estadoEntrega=p.estado==='entregado'
    ? (p.entrega_completa===false
        ? '<div style="background:var(--diesel-soft);color:#854F0B;border-radius:9px;padding:8px 12px;font-size:12.5px;font-weight:600;margin:10px 0">⚠ Se entregó con faltantes — revisá qué comprar</div>'
        : '<div style="background:var(--brote-soft);color:var(--brote-2);border-radius:9px;padding:8px 12px;font-size:12.5px;font-weight:600;margin:10px 0">✓ Entregado completo</div>')
    : '';
  document.getElementById('ins-side').innerHTML=`
    <div class="side-id">PEDIDO DE INSUMOS</div>
    <div class="side-title">${p.objetivos?p.objetivos.nombre:(p.objetivo_texto||'—')}</div>
    <div class="side-meta">Pedido por ${p.capataces?p.capataces.nombre:'—'} · ${fechaAR(p.created_at)}</div>
    ${(()=>{const pt=puntualidadInsumo(p);
      if(p.estado==='entregado'&&p.entregado_at)return `<div class="side-meta" style="margin-top:2px">Entregado el ${fechaAR(p.entregado_at)} · <b style="color:${pt?pt.color:'inherit'}">${pt?(pt.dias<=2?'puntual ('+pt.dias+'d)':'demorado ('+pt.dias+'d)'):''}</b></div>`;
      if(pt&&p.estado!=='entregado')return `<div class="side-meta" style="margin-top:2px">Esperando <b style="color:${pt.color}">${pt.dias} día(s)</b></div>`;
      return '';})()}
    ${estadoEntrega}
    ${p.estado==='cancelado'?'<span class="badge b-red">cancelado</span>':railEstado(idx,2,false)+railLabels(['Pendiente','Entregado'],idx)}
    <div class="divider"></div>
    <div class="field-l" style="margin-bottom:8px">${p.estado==='entregado'?'Pedido y entrega':'Materiales pedidos'}</div>${items||'<div class="sub">—</div>'}
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
    item:i.item,
    cantidad:document.getElementById('ent-cant-'+n).value.trim()||null,
    entregado:document.getElementById('ent-ck-'+n).checked,
  }));
  const algunoEntregado=items.some(i=>i.entregado);
  if(orig.length&&!algunoEntregado){alert('No tildaste ningún material. Si no se entrega nada, cancelá el pedido.');return;}
  const faltan=items.filter(i=>!i.entregado).length;
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
let combCargas=[];              // cache de cargas para el modal de detalle
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

// Quién hizo la carga cuando no hay capataz vinculado (pañol, mecánicos y
// supervisores sin ficha de capataz): se lee del texto "Cargado por rol: X · …"
function quienCargoCombus(c){
  const m=/^Cargado por ([^:]+): ([^·]+)/.exec(String(c.respuesta_capataz||''));
  return m?`<div>${m[2].trim()}</div><div class="sub" style="font-size:10.5px">${m[1].trim()}</div>`:'—';
}
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
    combCargas=cs;
    // ---- Indicadores del período (sobre cargas no anuladas) ----
    const vivas=cs.filter(c=>c.estado!=='anulada');
    let litTot=0,litUni=0,litBid=0,nFact=0,nSf=0;
    const porObj={},porTipo={},bidObj={};
    vivas.forEach(c=>{
      const its=c.cargas_combustible_items||[];
      const objC=c.objetivos?c.objetivos.nombre:'Sin objetivo';
      if(c.estado==='facturada')nFact++;else nSf++;
      if(its.length){
        its.forEach(i=>{
          const l=Number(i.litros)||0;litTot+=l;
          if(i.destino==='bidon'){litBid+=l;const o=i.destino_detalle||objC;bidObj[o]=(bidObj[o]||0)+l;porObj[o]=(porObj[o]||0)+l;}
          else{litUni+=l;porObj[objC]=(porObj[objC]||0)+l;}
          const t=(i.producto||'—').trim().toUpperCase();porTipo[t]=(porTipo[t]||0)+l;
        });
      }else{const l=Number(c.litros_total)||0;litTot+=l;litUni+=l;porObj[objC]=(porObj[objC]||0)+l;}
    });
    const fmtL=n=>Math.round(n).toLocaleString('es-AR')+' lt';
    const pct=(n,t)=>t?Math.round(n*100/t):0;
    const barras=(obj,color,max)=>{const ents=Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,7);
      const mx=max||Math.max(...ents.map(([,v])=>v),1);
      return ents.length?ents.map(([n,v])=>`<div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">
        <span style="width:180px;font-size:12px;font-weight:500;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${n}</span>
        <div style="flex:1;height:15px;background:var(--papel);border-radius:5px;overflow:hidden"><div style="width:${Math.round(v*100/mx)}%;height:100%;background:${color}"></div></div>
        <span class="mono" style="width:80px;text-align:right;font-size:12px;font-weight:600;flex-shrink:0">${fmtL(v)}</span></div>`).join('')
        :'<div class="sub" style="padding:8px 0">Sin datos en el período.</div>';};
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
    <div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">
      <div class="kpi"><div class="kpi-label">Litros totales</div><div class="kpi-val" style="color:var(--brote-2)">${fmtL(litTot)}</div><div class="kpi-sub">${vivas.length} cargas</div></div>
      <div class="kpi plain"><div class="kpi-label">A unidades</div><div class="kpi-val">${fmtL(litUni)}</div><div class="kpi-sub">${pct(litUni,litTot)}% · al tanque</div></div>
      <div class="kpi plain"><div class="kpi-label">A bidones</div><div class="kpi-val">${fmtL(litBid)}</div><div class="kpi-sub">${pct(litBid,litTot)}% · a objetivos</div></div>
      <div class="kpi plain"><div class="kpi-label">Estado</div><div class="kpi-val">${nFact}/${nSf}</div><div class="kpi-sub">facturadas / sin facturar</div></div>
    </div>
    <div class="grid g-2" style="margin-bottom:14px">
      <div class="panel"><div class="panel-title">Litros por objetivo <span class="sub" style="font-weight:400;font-size:11px">· dónde se consumió</span></div>
        <div style="margin-top:10px">${barras(porObj,'var(--diesel)')}</div></div>
      <div class="panel"><div class="panel-title">Litros por tipo de combustible <span class="sub" style="font-weight:400;font-size:11px">· qué se cargó</span></div>
        <div style="margin-top:10px">${barras(porTipo,'var(--brote)')}</div></div>
    </div>
    <div class="panel" style="margin-bottom:14px"><div class="panel-title">Bidones por objetivo <span class="sub" style="font-weight:400;font-size:11px">· litros en bidones y a dónde fueron</span></div>
      <div style="margin-top:10px">${barras(bidObj,'#7C5CBF')}</div></div>
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
        return `<tr class="click-row" style="cursor:pointer;${anulada?'opacity:.55':''}" onclick="verCarga('${c.id}')"><td class="mono">${fechaAR(c.fecha)}</td>
          <td><div style="font-weight:500">${c.proveedores?c.proveedores.nombre:'—'}</div><div class="sub mono">${c.numero_remito||c.numero_factura||''}</div></td>
          <td>${c.capataces?c.capataces.nombre:quienCargoCombus(c)}</td>
          <td>${c.objetivos?c.objetivos.nombre:'<span class="sub">—</span>'}</td>
          <td><span class="uni-chip">${c.unidades?c.unidades.patente:(c.patente_raw||'—')}</span></td>
          <td style="font-size:12px">${items||'—'}</td>
          <td class="num">${c.litros_total?c.litros_total+' lt':'—'}</td>
          <td><span class="badge ${anulada?'b-red':c.estado==='facturada'?'b-green':'b-gray'}">${cap(c.estado)}</span></td>
          <td class="num">${anulada
            ?`<button class="btn ghost" style="padding:4px 10px;font-size:11.5px" onclick="event.stopPropagation();restaurarCarga('${c.id}')">Restaurar</button>`
            :`<button class="btn ghost" style="padding:4px 10px;font-size:11.5px;color:var(--rojo)" onclick="event.stopPropagation();anularCarga('${c.id}','${(c.numero_remito||c.numero_factura||'s/n').replace(/'/g,'')}',${c.litros_total||0})">✕ Anular</button>`}</td></tr>`;}).join('')
        :'<tr><td colspan="9"><div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 20V5a2 2 0 012-2h6a2 2 0 012 2v15"/></svg><div>No hay cargas registradas.</div></div></td></tr>'}</tbody></table></div>`;
  }catch(e){view.innerHTML=`<div class="cargando-v">No pude cargar el combustible.</div>`;}
}
function verCarga(id){
  const c=(combCargas||[]).find(x=>String(x.id)===String(id));
  if(!c)return;
  const items=c.cargas_combustible_items||[];
  const litrosTot=items.reduce((s,i)=>s+(Number(i.litros)||0),0)||c.litros_total||0;
  const esFactura=c.estado==='facturada';
  const prodCards=items.map(i=>{
    const destTag=i.destino==='bidon'
      ?`<span class="badge" style="background:var(--diesel-soft);color:#854F0B">bidones</span> <span style="font-size:11.5px;color:var(--diesel)">→ ${i.destino_detalle||c.objetivos&&c.objetivos.nombre||'objetivo sin especificar'}</span>`
      :i.destino==='equipo'
      ?`<span class="badge" style="background:var(--azul-soft);color:var(--azul)">equipo</span> <span style="font-size:11.5px;color:var(--azul)">→ ${i.destino_detalle||'—'}</span>`
      :`<span class="badge" style="background:var(--azul-soft);color:var(--azul)">unidad</span> <span style="font-size:11.5px;color:var(--azul)">→ ${c.unidades?c.unidades.patente:(c.patente_raw||'tanque')} (al tanque)</span>`;
    return `<div style="border:1px solid var(--linea);border-radius:10px;padding:11px 13px;margin-top:9px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
        <span style="font-weight:600;font-size:13px">${i.producto||'—'}</span>
        <span class="mono" style="font-weight:700">${i.litros?Number(i.litros).toLocaleString('es-AR')+' lt':'—'}</span></div>
      <div>${destTag}</div></div>`;}).join('');
  const totBox=esFactura
    ? `<div style="background:var(--papel);border-radius:10px;padding:12px 14px;margin-top:14px">
        <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px"><span>Litros totales</span><span class="mono">${Number(litrosTot).toLocaleString('es-AR')} lt</span></div>
        <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px"><span>Neto gravado</span><span class="mono">${c.neto!=null?money(c.neto):'—'}</span></div>
        <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px"><span>IVA 21%</span><span class="mono">${c.iva!=null?money(c.iva):'—'}</span></div>
        <div style="display:flex;justify-content:space-between;padding:8px 0 0;margin-top:5px;border-top:1px solid var(--linea-2);font-size:15px;font-weight:700"><span>Total</span><span class="mono">${c.total!=null?money(c.total):'—'}</span></div>
       </div>
       ${c.iva==null?'<div style="font-size:11px;color:var(--tinta-3);margin-top:8px;text-align:center">Esta carga está facturada pero el IVA no está cargado en el sistema todavía. El dato fiscal para ARCA vive en el módulo Compras.</div>':''}`
    : `<div style="background:var(--papel);border-radius:10px;padding:12px 14px;margin-top:14px">
        <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px"><span>Litros totales</span><span class="mono">${Number(litrosTot).toLocaleString('es-AR')} lt</span></div>
        <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px;color:var(--tinta-3)"><span>IVA</span><span class="mono">— al facturar</span></div>
       </div>
       <div style="font-size:11px;color:var(--tinta-3);margin-top:8px;text-align:center">Remito sin facturar — el IVA (crédito fiscal para ARCA) se discrimina cuando llega la factura A del proveedor.</div>`;
  const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=200;
  bg.innerHTML=`<div class="modal" style="max-width:560px">
    <div style="padding:18px 22px;border-bottom:1px solid var(--linea);display:flex;justify-content:space-between;align-items:flex-start">
      <div><div style="font-size:16px;font-weight:700">${c.proveedores?c.proveedores.nombre:'—'}</div>
        <div class="sub">${esFactura?'Factura':'Remito'} ${c.numero_factura||c.numero_remito||'s/n'} · ${fechaAR(c.fecha)} · ${c.capataces?c.capataces.nombre:'—'}</div></div>
      <button class="m-close" style="cursor:pointer;font-size:20px;color:var(--tinta-3);background:none;border:none" onclick="this.closest('.modal-bg').remove()">✕</button></div>
    <div style="padding:18px 22px">
      <div style="display:flex;justify-content:space-between;padding:7px 0;font-size:13px;border-bottom:1px solid var(--linea)"><span style="color:var(--tinta-2)">Patente</span><span style="font-weight:600" class="mono">${c.unidades?c.unidades.patente:(c.patente_raw||'—')}</span></div>
      <div style="display:flex;justify-content:space-between;padding:7px 0;font-size:13px;border-bottom:1px solid var(--linea)"><span style="color:var(--tinta-2)">Comprobante</span><span style="font-weight:600">${esFactura?'Factura · Facturada':'Remito · Sin facturar'}</span></div>
      <div style="display:flex;justify-content:space-between;padding:7px 0;font-size:13px;border-bottom:1px solid var(--linea)"><span style="color:var(--tinta-2)">Objetivo</span><span style="font-weight:600">${c.objetivos?c.objetivos.nombre:'—'}</span></div>
      <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--tinta-3);font-weight:600;margin:16px 0 4px">Productos cargados</div>
      ${prodCards||'<div class="sub">Sin productos detallados.</div>'}
      ${totBox}
    </div></div>`;
  document.body.appendChild(bg);
  bg.addEventListener('click',e=>{if(e.target===bg)bg.remove();});
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
/* ── Carga manual de un viaje ─────────────────────────────────
   El bot ya carga los viajes por WhatsApp, pero el chofer a veces no lo
   hace o hay que completar días viejos. Un viaje = una fecha + un camión
   + las paradas con sus bateas; el total se suma solo. */
let viajeOpc=null, viajeEdit=null;
async function viajeNuevo(fecha){
  if(!viajeOpc){
    try{viajeOpc=await api('/api/viajes/opciones');}
    catch(e){return alert('No pude traer choferes y camiones: '+(e.message||''));}
  }
  viajeEdit={fecha:fecha||new Date().toLocaleDateString('sv-SE'),chofer_id:'',unidad_id:'',
    paradas:[{objetivo_id:'',objetivo_nombre:'',bateas:1}]};
  pintarViajeModal();
}
function pintarViajeModal(){
  const v=viajeEdit;if(!v)return;
  const o=viajeOpc||{choferes:[],unidades:[],objetivos:[]};
  const inp='width:100%;padding:8px 10px;border:1px solid var(--linea);border-radius:8px;font-family:inherit;font-size:13.5px;box-sizing:border-box';
  const total=v.paradas.reduce((a,p)=>a+(Number(p.bateas)||0),0);
  document.getElementById('mm-titulo').textContent='Cargar viaje de bateas';
  document.getElementById('mm-campos').innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="mm-field"><label>Fecha *</label>
        <input id="vj-fecha" type="date" value="${v.fecha}" max="${new Date().toLocaleDateString('sv-SE')}" style="${inp}"></div>
      <div class="mm-field"><label>Camión *</label>
        <select id="vj-uni" style="${inp}" onchange="viajeEdit.unidad_id=this.value">
          <option value="">— elegí —</option>
          ${o.unidades.map(u=>`<option value="${u.id}" ${v.unidad_id===u.id?'selected':''}>${escStk(u.patente||'')}${u.marca_modelo?' · '+escStk(u.marca_modelo):''}</option>`).join('')}
        </select></div>
    </div>
    <div class="mm-field"><label>Chofer</label>
      <select id="vj-chofer" style="${inp}" onchange="viajeChoferCambio()">
        <option value="">— sin especificar —</option>
        ${o.choferes.map(c=>`<option value="${c.id}" ${v.chofer_id===c.id?'selected':''}>${escStk(c.nombre)}</option>`).join('')}
      </select></div>

    <div class="mm-field" style="margin-bottom:4px"><label>Paradas · dónde bajó y cuántas bateas</label></div>
    <div style="max-height:38vh;overflow-y:auto;margin:0 -4px;padding:0 4px">
    ${v.paradas.map((p,ix)=>`
      <div style="display:grid;grid-template-columns:1fr 74px 30px;gap:6px;margin-bottom:6px;align-items:center">
        <input list="vj-objs" value="${escStk(p.objetivo_nombre)}" placeholder="Objetivo" style="${inp}"
          onchange="viajeParadaObj(${ix},this.value)">
        <input type="number" min="1" value="${p.bateas}" title="bateas" style="${inp};text-align:right"
          onchange="viajeEdit.paradas[${ix}].bateas=Number(this.value)||0;pintarViajeTotal()">
        <button class="btn-salir" style="padding:5px 0;color:var(--rojo)" onclick="viajeEdit.paradas.splice(${ix},1);pintarViajeModal()">✕</button>
      </div>`).join('')}
    </div>
    <datalist id="vj-objs">${o.objetivos.map(x=>`<option value="${escStk(x.nombre)}">`).join('')}</datalist>
    <button class="btn-salir" style="padding:5px 10px;font-size:12px;margin-top:2px"
      onclick="viajeCapturar();viajeEdit.paradas.push({objetivo_id:'',objetivo_nombre:'',bateas:1});pintarViajeModal()">＋ Agregar parada</button>
    <div id="vj-total" style="margin-top:12px;padding:9px 12px;background:var(--brote-soft);border-radius:9px;font-size:13.5px">
      Total: <b>${total} batea${total===1?'':'s'}</b> en ${v.paradas.length} parada${v.paradas.length===1?'':'s'}</div>
    <div class="modal-acciones">
      <button class="btn-salir" onclick="cerrarMaestro();viajeEdit=null">Cancelar</button>
      <button class="btn" onclick="viajeGuardar()">Guardar viaje</button>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
}
/* El objetivo se escribe con datalist: si coincide con uno de la lista se
   guarda su id, si no queda el texto (así se puede cargar un lugar nuevo). */
function viajeParadaObj(ix,valor){
  const o=viajeOpc||{objetivos:[]};
  const norm=t=>String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
  const m=o.objetivos.find(x=>norm(x.nombre)===norm(valor));
  viajeEdit.paradas[ix].objetivo_nombre=valor.trim();
  viajeEdit.paradas[ix].objetivo_id=m?m.id:null;
}
function viajeChoferCambio(){
  const g=x=>document.getElementById(x);
  const id=g('vj-chofer').value;
  viajeEdit.chofer_id=id;
  // Si el chofer tiene camión fijo y todavía no se eligió uno, se completa
  const o=viajeOpc||{choferes:[]};
  const c=o.choferes.find(x=>x.id===id);
  if(c&&c.unidad_id&&!g('vj-uni').value){g('vj-uni').value=c.unidad_id;viajeEdit.unidad_id=c.unidad_id;}
}
function pintarViajeTotal(){
  const t=viajeEdit.paradas.reduce((a,p)=>a+(Number(p.bateas)||0),0);
  const el=document.getElementById('vj-total');
  if(el)el.innerHTML=`Total: <b>${t} batea${t===1?'':'s'}</b> en ${viajeEdit.paradas.length} parada${viajeEdit.paradas.length===1?'':'s'}`;
}
function viajeCapturar(){
  const g=x=>document.getElementById(x);
  if(g('vj-fecha'))viajeEdit.fecha=g('vj-fecha').value;
  if(g('vj-uni'))viajeEdit.unidad_id=g('vj-uni').value;
  if(g('vj-chofer'))viajeEdit.chofer_id=g('vj-chofer').value;
}
async function viajeGuardar(){
  viajeCapturar();
  const v=viajeEdit;
  if(!v.fecha)return alert('Poné la fecha.');
  if(!v.unidad_id)return alert('Elegí el camión.');
  const paradas=v.paradas.filter(p=>p.objetivo_nombre&&Number(p.bateas)>0);
  if(!paradas.length)return alert('Cargá al menos una parada con bateas.');
  try{
    const r=await api('/api/viajes',{method:'POST',body:JSON.stringify({...v,paradas})});
    cerrarMaestro();viajeEdit=null;
    toast(`Viaje cargado · ${r.total_bateas} bateas`);
    go('bateas');
  }catch(e){alert('No pude guardar: '+(e.message||''));}
}

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
      <div class="view-desc">Traslado de poda en roll off · km, bateas y puntos de bajada por chofer</div></div>
      <button class="btn" onclick="viajeNuevo()">+ Cargar viaje</button></div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
      <span class="sub">Desde</span><input type="date" value="${desde}" onchange="viajesDesde=this.value;go('bateas')" style="padding:6px;border:1px solid var(--linea);border-radius:8px">
      <span class="sub">hasta</span><input type="date" value="${hasta}" onchange="viajesHasta=this.value;go('bateas')" style="padding:6px;border:1px solid var(--linea);border-radius:8px">
    </div>
    <div class="kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">
      ${kpi('Promedio de bateas / jornada',(k.bateas_promedio_jornada!=null?k.bateas_promedio_jornada:'—'),(k.bateas_total||0)+' bateas ÷ '+(k.jornadas_total||0)+' jornadas trabajadas')}
      ${kpi('Bateas totales',(k.bateas_total||0),(k.m3_total||0).toLocaleString('es-AR')+' m³ · '+(k.bateas_total||0)+' × 14 m³')}
      ${kpi('Puntos de bajada',(k.puntos_total||0),'descargas en objetivos')}
    </div>
    <div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
      <div class="panel"><div class="panel-title" style="margin-bottom:10px">Rendimiento por chofer <span class="sub" style="font-weight:400;font-size:11px">· bateas por jornada</span></div>
        ${(ind.por_chofer||[]).length?`<div class="tablewrap"><table><thead><tr><th>Chofer</th><th class="num">Bateas</th><th class="num">Jornadas</th><th class="num">Prom/jornada</th></tr></thead><tbody>
          ${ind.por_chofer.map(c=>`<tr><td>${c.chofer}</td><td class="num mono">${c.bateas}</td><td class="num mono">${c.jornadas}</td><td class="num mono" style="color:var(--brote-2);font-weight:700;font-size:14px">${c.prom_jornada}</td></tr>`).join('')}
        </tbody></table></div>`:'<div class="sub" style="padding:10px 0">Sin datos en el período.</div>'}
      </div>
      <div class="panel"><div class="panel-title" style="margin-bottom:10px">Rendimiento por camión <span class="sub" style="font-weight:400;font-size:11px">· bateas por jornada</span></div>
        ${(ind.por_unidad||[]).length?`<div class="tablewrap"><table><thead><tr><th>Unidad</th><th class="num">Bateas</th><th class="num">Jornadas</th><th class="num">Prom/jornada</th></tr></thead><tbody>
          ${ind.por_unidad.map(u=>`<tr><td><span class="uni-chip">${u.unidad}</span></td><td class="num mono">${u.bateas}</td><td class="num mono">${u.jornadas}</td><td class="num mono" style="color:var(--brote-2);font-weight:700;font-size:14px">${u.prom_jornada}</td></tr>`).join('')}
        </tbody></table></div>`:'<div class="sub" style="padding:10px 0">Sin datos en el período.</div>'}
      </div>
    </div>
    ${(ind.sin_objetivo||[]).length?`
    <div class="panel" style="margin-bottom:14px;border-left:3px solid var(--ambar,#d99000)">
      <div class="panel-title" style="margin-bottom:4px">⚠ Paradas sin objetivo <span class="sub" style="font-weight:400;font-size:11px">· ${ind.sin_objetivo.length} para asignar</span></div>
      <div class="sub" style="font-size:11.5px;margin-bottom:10px">El chofer escribió algo que no coincide con ningún objetivo. Asignalo y, si tildás recordar, la próxima vez entra solo.</div>
      <div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Chofer</th><th>Escribió</th><th class="num">Bateas</th><th style="width:120px"></th></tr></thead><tbody>
        ${ind.sin_objetivo.map(x=>`<tr>
          <td class="mono" style="font-size:12px">${fechaAR(x.fecha)}</td>
          <td style="font-size:12.5px">${x.chofer||'—'}</td>
          <td><span class="uni-chip" style="background:var(--papel)">${(x.texto||'—').replace(/</g,'&lt;')}</span></td>
          <td class="num mono">${x.bateas}</td>
          <td style="text-align:right"><button class="btn" style="padding:4px 10px;font-size:11.5px" onclick="corregirParada('${x.viaje_id}',${x.idx})">Asignar</button></td>
        </tr>`).join('')}
      </tbody></table></div>
    </div>`:''}
    <div class="panel" style="margin-bottom:16px"><div class="panel-title" style="margin-bottom:10px">Bateas por objetivo
      <button class="btn-salir" style="padding:3px 9px;font-size:11px;float:right" onclick="verAliasObjetivos()">🏷 Alias</button></div>
      ${(ind.por_objetivo||[]).length?(function(){const mx=Math.max(...ind.por_objetivo.map(o=>o.bateas),1);
        return ind.por_objetivo.slice(0,10).map(o=>`<div style="margin-bottom:7px"><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px"><span>${o.nombre}</span><span class="mono">${o.bateas} bat · ${o.m3.toLocaleString('es-AR')} m³</span></div><div style="height:7px;background:var(--papel);border-radius:4px"><div style="width:${Math.round(o.bateas*100/mx)}%;height:100%;background:var(--brote);border-radius:4px"></div></div></div>`).join('');})()
        :'<div class="sub" style="padding:10px 0">Sin bateas en el período.</div>'}
    </div>
    <div class="panel-title" style="margin-bottom:8px">Detalle de jornadas</div>
    <div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Chofer</th><th>Unidad</th><th class="num">Bateas</th><th>Paradas</th><th></th></tr></thead>
      <tbody>${lista.length?lista.map(v=>`<tr>
        <td class="mono">${fechaAR(v.fecha)}</td>
        <td>${v.capataces?v.capataces.nombre:'—'}</td>
        <td><span class="uni-chip">${v.unidades?v.unidades.patente:(v.patente_raw||'—')}</span></td>
        <td class="num mono">${v.total_bateas||0}</td>
        <td style="font-size:12px">${(v.paradas||[]).length?(v.paradas||[]).map((p,ix)=>`<span class="uni-chip" title="Tocá para cambiar el objetivo" style="cursor:pointer;margin:0 3px 3px 0;display:inline-block;${p.objetivo_id?'':'background:var(--papel);border:1px dashed var(--linea)'}" onclick="corregirParada('${v.id}',${ix})">${(p.objetivo_nombre||'—').replace(/</g,'&lt;')} (${p.bateas})${p.objetivo_id?'':' ⚠'}</span>`).join(''):'—'}</td>
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

/* ── Corregir el objetivo de una parada de bateas ──────────────
   El chofer escribe libre por WhatsApp; acá se reasigna contra la lista
   real de objetivos. Con "recordar" tildado, el texto queda como alias y
   la próxima carga matchea sola. */
async function corregirParada(viajeId,idx){
  if(!objetivos.length){try{objetivos=await api('/api/objetivos');}catch(e){}}
  const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=190;
  bg.innerHTML=`<div class="modal" style="max-width:460px">
    <h3>Asignar objetivo</h3>
    <div class="sub" style="font-size:12.5px;margin-bottom:12px">Elegí a qué objetivo corresponde esta parada.</div>
    <label class="sub" style="font-size:11px;display:block;margin-bottom:4px">OBJETIVO</label>
    <input id="cp-obj" list="cp-obj-list" class="busca" style="width:100%;box-sizing:border-box" placeholder="Escribí para buscar…" autocomplete="off">
    <datalist id="cp-obj-list">${objetivos.map(o=>`<option value="${String(o.nombre).replace(/"/g,'&quot;')}">`).join('')}</datalist>
    <label style="display:flex;align-items:center;gap:7px;margin-top:14px;font-size:12.5px;cursor:pointer">
      <input type="checkbox" id="cp-recordar" checked>
      <span>Recordar: la próxima vez que escriban lo mismo, asignarlo solo</span></label>
    <div class="modal-acciones">
      <button class="btn ghost" id="cp-no">Cancelar</button>
      <button class="btn" id="cp-si">Asignar</button>
    </div></div>`;
  document.body.appendChild(bg);
  const inp=bg.querySelector('#cp-obj');inp.focus();
  const cerrar=()=>bg.remove();
  bg.querySelector('#cp-no').onclick=cerrar;
  bg.addEventListener('click',e=>{if(e.target===bg)cerrar();});
  inp.addEventListener('keydown',e=>{if(e.key==='Enter')bg.querySelector('#cp-si').click();});
  bg.querySelector('#cp-si').onclick=async()=>{
    const nom=(inp.value||'').trim();
    const o=objetivos.find(x=>String(x.nombre).toLowerCase()===nom.toLowerCase());
    if(!o){toast('Elegí un objetivo de la lista','error');inp.focus();return;}
    const recordar=bg.querySelector('#cp-recordar').checked;
    const btn=bg.querySelector('#cp-si');btn.disabled=true;btn.textContent='Guardando…';
    try{
      const r=await api('/api/viajes/'+viajeId+'/parada',{method:'POST',
        body:JSON.stringify({idx,objetivo_id:o.id,recordar})});
      cerrar();
      toast(r.alias?('Asignado a '+o.nombre+' · alias "'+r.alias+'" guardado')
        :r.alias_error?('Asignado a '+o.nombre+', pero no pude guardar el alias: '+r.alias_error)
        :('Asignado a '+o.nombre));
      go('bateas');
    }catch(e){
      btn.disabled=false;btn.textContent='Asignar';
      toast('No pude asignar: '+e.message,'error');
    }
  };
}

/* Lista de alias aprendidos, para revisar y borrar los que estén mal. */
async function verAliasObjetivos(){
  const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=190;
  bg.innerHTML=`<div class="modal" style="max-width:520px">
    <h3>Alias de objetivos</h3>
    <div class="sub" style="font-size:12.5px;margin-bottom:12px">Cómo nombran los choferes cada objetivo. El bot los usa para reconocer lo que escriben.</div>
    <div id="al-body"><div class="sub">Cargando…</div></div>
    <div class="modal-acciones"><button class="btn ghost" id="al-no">Cerrar</button></div></div>`;
  document.body.appendChild(bg);
  const cerrar=()=>bg.remove();
  bg.querySelector('#al-no').onclick=cerrar;
  bg.addEventListener('click',e=>{if(e.target===bg)cerrar();});
  const pintar=async()=>{
    const box=bg.querySelector('#al-body');if(!box)return;
    try{
      const list=await api('/api/viajes/alias');
      box.innerHTML=list.length?`<div class="tablewrap" style="max-height:320px;overflow:auto"><table><thead><tr><th>Escriben</th><th>Es</th><th style="width:40px"></th></tr></thead><tbody>
        ${list.map(a=>`<tr>
          <td><span class="uni-chip">${(a.alias_original||a.alias).replace(/</g,'&lt;')}</span></td>
          <td style="font-size:12.5px">${a.objetivos?a.objetivos.nombre:'—'}</td>
          <td style="text-align:right"><button class="btn ghost" style="padding:3px 7px;font-size:11px;color:var(--rojo)" data-del="${a.id}">✕</button></td>
        </tr>`).join('')}</tbody></table></div>`
        :'<div class="sub" style="padding:8px 0">Todavía no hay alias. Se guardan cuando asignás una parada con "recordar" tildado.</div>';
      box.querySelectorAll('[data-del]').forEach(b=>{b.onclick=async()=>{
        try{await api('/api/viajes/alias/'+b.dataset.del,{method:'DELETE'});pintar();}
        catch(e){toast('No pude borrar: '+e.message,'error');}
      };});
    }catch(e){box.innerHTML='<div class="sub">'+(e.message||'No pude cargar los alias')+'</div>';}
  };
  pintar();
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
let stockTab='general'; // 'general' | 'maquinas' | 'panol' | 'censo'
let stockPeriodo=null;   // null = período actual
let stockData=null;      // último GET /api/stock (para el detalle lateral)
let stockSelId=null;     // censo seleccionado
let stockPedirSel=new Set(); // objetivos tildados en el modal de pedido
let stockInv=null;       // inventario oficial
let stockInvEdit=null;   // línea del inventario en edición
let stockTipoFil='';     // filtro por tipo de equipo en la solapa Detalle ('' = todos)
let maqData=null;        // padrón de máquinas
let maqFil={tipo:'',estado:'activa',busca:'',marca:''};
let stockDetBusca='';    // buscador de la solapa Detalle

const MESES_STK=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function mesStk(p){const[a,m]=String(p).split('-').map(Number);const n=MESES_STK[(m||1)-1]||'';return n.charAt(0).toUpperCase()+n.slice(1)+' '+(a||'');}
function horaStk(iso){if(!iso)return'';return new Date(iso).toLocaleString('es-AR',{timeZone:'America/Argentina/Cordoba',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}
/* Tres pestañas, no seis. Máquinas = qué tenemos (padrón), Censo = qué
   informaron los capataces, Control = las dos cosas comparadas.
   Las vistas viejas (Por objetivo, Inventario, Consolidado, Detalle) siguen
   en el código y se llegan desde Control mientras el padrón se termina de
   cargar: no se perdió nada, dejaron de ser pestañas de primer nivel. */
const STOCK_TABS=[['general','General'],['maquinas','Máquinas'],['panol','Pañol'],['censo','Censo']];
const STOCK_SUB={};   // las subvistas colgaban de Control, que se sacó
function tabsStk(){
  return `<div class="toggle-imp" style="margin-bottom:16px">
  ${STOCK_TABS.map(([k,t])=>`<button class="${stockTab===k?'on':''}" onclick="stockTab='${k}';go('stock')">${t}</button>`).join('')}
</div>`;}
function difStk(d){
  if(d==null)return'<span class="sub">—</span>';
  if(d===0)return'<span class="badge b-green">ok</span>';
  return`<span class="badge ${d<0?'b-red':'b-amber'}">${d>0?'+':''}${d}</span>`;
}

async function vStock(view){
  if(stockTab==='general')return vStockGeneral(view);
  if(stockTab==='panol')return vStockPanol(view);
  if(stockTab==='maquinas')return vMaquinas(view);
  // Control y sus subvistas se sacaron: si quedó guardado el tab viejo en
  // una pestaña abierta, cae al General en vez de mostrar nada.
  if(['control','inventario','consolidado','objetivo','detalle'].includes(stockTab)){
    stockTab='general';
    return vStockGeneral(view);
  }
  return vStockCenso(view);
}

/* ── General: toda la flota con filtros ───────────────────────
   La pregunta "¿cuántas motoguadañas tenemos y dónde?" en una sola
   pantalla: el último censo respondido de cada objetivo, con grupo,
   números, marca y los faltantes abiertos. Cada N° abre la ficha de la
   máquina si está en el padrón. */
let stkGen=null, stkGenF={tipo:'',objetivo:'',grupo:'',q:''};
async function vStockGeneral(view){
  if(!stkGen){
    view.innerHTML=tabsStk()+'<div class="cargando-v">Cargando…</div>';
    try{stkGen=await api('/api/stock/general');}
    catch(e){view.innerHTML=tabsStk()+`<div class="cargando-v">${escStk(e.message||'No pude cargar')}</div>`;return;}
    // El padrón para linkear cada número a su ficha (si falla, sin links).
    // OJO: /api/maquinas devuelve {maquinas, objetivos}, no un array.
    try{
      if(!Array.isArray(window._maqPadron)){
        const r=await api('/api/maquinas');
        window._maqPadron=Array.isArray(r)?r:(r&&Array.isArray(r.maquinas)?r.maquinas:[]);
      }
    }catch(e){window._maqPadron=[];}
    if(!Array.isArray(window._maqPadron))window._maqPadron=[];
  }
  const filas=stkGen.filas||[], faltantes=stkGen.faltantes||[];
  const F=stkGenF;
  const tipos=[...new Set(filas.map(f=>f.tipo).filter(Boolean))].sort();
  const objetivos=[...new Set(filas.map(f=>f.objetivo))].sort();
  const norm=t=>String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const vis=filas.filter(f=>
    // Los objetivos sin censo se ocultan al filtrar por tipo: no tienen
    // tipo, y mostrarlos ahí confundiría más que ayudar.
    (!F.tipo||f.tipo===F.tipo)&&(!F.objetivo||f.objetivo===F.objetivo)&&
    (!F.grupo||f.grupo===F.grupo)&&
    (!F.q||norm(f.numeros.join(' ')+' '+(f.observacion||'')+' '+f.objetivo+' '+f.tipo).includes(norm(F.q))));
  const total=vis.reduce((a,f)=>a+(Number(f.cantidad)||0),0);
  // Los objetivos sin censo no cuentan como "objetivos con equipos"
  const nObjs=new Set(vis.filter(f=>!f.sin_censo).map(f=>f.objetivo)).size;
  const nSinCenso=vis.filter(f=>f.sin_censo).length;
  const enDep=vis.filter(f=>f.grupo==='deposito').reduce((a,f)=>a+(Number(f.cantidad)||0),0);
  // faltantes que aplican al filtro actual
  const faltVis=faltantes.filter(fa=>{
    const fila=filas.find(f=>f.objetivo_id===fa.objetivo_id);
    return (!F.tipo||fa.tipo_equipo===F.tipo)&&(!F.objetivo||(fila&&fila.objetivo===F.objetivo));
  });
  const padronPorNum={};
  (window._maqPadron||[]).forEach(m=>{if(m.codigo_interno)padronPorNum[norm(m.codigo_interno)]=m.id;});
  const fFecha=p=>{const[a,m]=String(p||'').split('-');return m?`${m}/${a}`:p;};
  const hoyMs=Date.now();
  const filasPorObj={};
  vis.forEach(f=>{(filasPorObj[f.objetivo]=filasPorObj[f.objetivo]||[]).push(f);});

  view.innerHTML=`
  <div class="view-head"><div><div class="view-title">Stock de maquinaria</div>
    <div class="view-desc">General · qué hay y dónde, según el último censo de cada objetivo</div></div></div>
  ${tabsStk()}
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
    <select onchange="stkGenF.tipo=this.value;go('stock')" style="padding:6px 10px;border:1px solid var(--linea);border-radius:8px;font-size:12.5px">
      <option value="">Todos los tipos</option>
      ${tipos.map(t=>`<option ${F.tipo===t?'selected':''}>${escStk(t)}</option>`).join('')}
    </select>
    <select onchange="stkGenF.objetivo=this.value;go('stock')" style="padding:6px 10px;border:1px solid var(--linea);border-radius:8px;font-size:12.5px">
      <option value="">Todos los objetivos</option>
      ${objetivos.map(o=>`<option ${F.objetivo===o?'selected':''}>${escStk(o)}</option>`).join('')}
    </select>
    <select onchange="stkGenF.grupo=this.value;go('stock')" style="padding:6px 10px;border:1px solid var(--linea);border-radius:8px;font-size:12.5px">
      <option value="">Todos los grupos</option>
      <option value="deposito" ${F.grupo==='deposito'?'selected':''}>Depósito</option>
      <option value="privado" ${F.grupo==='privado'?'selected':''}>Privado</option>
    </select>
    <input placeholder="Buscar N°, marca, texto…" value="${escStk(F.q)}" onchange="stkGenF.q=this.value;go('stock')"
      style="flex:1;min-width:150px;padding:6px 10px;border:1px solid var(--linea);border-radius:8px;font-size:12.5px">
    <button class="btn-salir" style="padding:6px 10px;font-size:11.5px" onclick="stkGen=null;go('stock')">↻</button>
  </div>

  <div class="kpis" style="grid-template-columns:repeat(3,minmax(160px,1fr))">
    <div class="kpi"><div class="kpi-label">${F.tipo?escStk(F.tipo):'Equipos'}</div><div class="kpi-val">${total}</div><div class="kpi-sub">en ${nObjs} objetivo${nObjs===1?'':'s'}</div></div>
    <div class="kpi"><div class="kpi-label">En depósito</div><div class="kpi-val">${enDep}</div><div class="kpi-sub">del grupo depósito</div></div>
    <div class="kpi"><div class="kpi-label">Faltantes abiertos</div><div class="kpi-val" style="color:${faltVis.length?'var(--rojo)':'inherit'}">${faltVis.length}</div><div class="kpi-sub">${faltVis.length?'revisar abajo':'sin faltantes'}</div></div>
    ${nSinCenso?`<div class="kpi"><div class="kpi-label">Sin stock cargado</div><div class="kpi-val" style="color:var(--diesel)">${nSinCenso}</div><div class="kpi-sub">objetivos por cargar</div></div>`:''}
  </div>

  ${faltVis.length?`<div class="panel" style="border-left:3px solid var(--rojo);margin-bottom:14px">
    <div class="panel-title" style="color:var(--rojo)">⚠ Faltantes sin resolver</div>
    <table><thead><tr><th>Objetivo</th><th>Equipo</th><th>Visto por última vez</th><th>Detectado</th><th></th></tr></thead><tbody>
    ${faltVis.map(fa=>{
      const fila=filas.find(f=>f.objetivo_id===fa.objetivo_id);
      const dias=Math.ceil((hoyMs-new Date(fa.created_at).getTime())/86400000);
      return `<tr>
        <td>${escStk(fila?fila.objetivo:'—')}</td>
        <td><b>${escStk(fa.tipo_equipo||'')}</b> ${fa.numero?`<span class="uni-chip" style="background:var(--rojo-soft);color:var(--rojo)">N° ${escStk(fa.numero)}</span>`:`<span class="sub">(${escStk(fa.detalle||'')})</span>`}</td>
        <td class="mono" style="font-size:12px">${fa.visto_en?fFecha(fa.visto_en):'—'}</td>
        <td class="sub" style="font-size:12px">hace ${dias} d</td>
        <td><button class="mini-btn" onclick="resolverFaltante('${fa.id}')">✓ Resolver</button></td></tr>`;}).join('')}
    </tbody></table></div>`:''}

  <div class="panel">
    <div class="panel-title" style="display:flex;justify-content:space-between;align-items:center">
      <span>Stock por objetivo <span class="sub" style="font-weight:400">· último censo respondido de cada uno</span></span>
    </div>
    <table><thead><tr><th>Objetivo</th><th>Grupo</th><th>Tipo</th><th style="text-align:right">Cant.</th><th>N° de máquina</th><th>Observación</th><th>Último censo</th><th></th></tr></thead><tbody>
    ${Object.keys(filasPorObj).sort().map(obj=>{
      const fs=filasPorObj[obj];
      // Objetivo sin censo: una sola fila que invita a cargarlo
      if(fs.length===1&&fs[0].sin_censo){
        const f=fs[0];
        return `<tr style="background:var(--hueso)">
          <td style="font-weight:600">${escStk(obj)}</td>
          <td>${f.grupo==='deposito'?'<span class="badge b-amber">depósito</span>':f.grupo==='privado'?'<span class="badge" style="background:var(--azul-soft);color:var(--azul)">privado</span>':'<span class="badge b-gray">—</span>'}</td>
          <td colspan="4" class="sub" style="font-style:italic">Todavía no informó stock</td>
          <td class="sub" style="font-size:11.5px">—</td>
          <td><button class="mini-btn" style="color:var(--brote);font-weight:600" onclick="editarStockObjetivo('${f.objetivo_id}')">＋ Cargar stock</button></td>
        </tr>`;
      }
      return fs.map((f,ix)=>{
        const chips=(f.numeros||[]).map(n=>{
          const id=padronPorNum[norm(n)];
          return id?`<span class="uni-chip" style="cursor:pointer" onclick="fichaMaquina('${id}')" title="ver ficha">${escStk(n)}</span>`
                   :`<span class="uni-chip">${escStk(n)}</span>`;}).join('');
        return `<tr>
          ${ix===0?`<td rowspan="${fs.length}" style="font-weight:600;vertical-align:top">${escStk(obj)}</td>
          <td rowspan="${fs.length}" style="vertical-align:top">${f.grupo==='deposito'?'<span class="badge b-amber">depósito</span>':f.grupo==='privado'?'<span class="badge" style="background:var(--azul-soft);color:var(--azul)">privado</span>':'<span class="badge b-gray">—</span>'}</td>`:''}
          <td>${escStk(f.tipo)}</td>
          <td class="mono" style="text-align:right">${f.cantidad}</td>
          <td><div style="display:flex;gap:3px;flex-wrap:wrap;max-width:340px">${chips||'<span class="sub">—</span>'}</div></td>
          <td class="sub" style="font-size:12px">${escStk(f.observacion||'')}</td>
          ${ix===0?`<td rowspan="${fs.length}" class="mono" style="font-size:11.5px;vertical-align:top">${fFecha(f.periodo)}</td>
          <td rowspan="${fs.length}" style="vertical-align:top"><div style="display:flex;flex-direction:column;gap:5px">
            <button class="mini-btn" onclick="editarStockObjetivo('${f.objetivo_id}')" title="corregir el stock de este objetivo">✏️ Editar</button>
            ${f.grupo==='deposito'?`<button class="mini-btn" onclick="imprimirPlanillaStock('${f.objetivo_id}')" title="planilla de control físico">🖨 Planilla</button>`:''}
          </div></td>`:''}
        </tr>`;}).join('');
    }).join('')}
    ${!vis.length?'<tr><td colspan="8" class="sub" style="padding:18px">Nada que mostrar con estos filtros.</td></tr>':''}
    </tbody></table>
  </div>`;
}

/* ── Reportes ─────────────────────────────────────────────────
   Reporte mensual para gerencia: reparaciones, criticidad, tiempos de
   resolución, reingresos y estado del pañol. Los gráficos son SVG hecho
   a mano — sin librerías, así imprimen igual en el PDF (una librería por
   CDN además puede no cargar y dejar el informe sin gráficos). */
let repMes=null, repDatos=null;
function mesActualISO(){return new Date().toLocaleDateString('sv-SE',{timeZone:'America/Argentina/Cordoba'}).slice(0,7);}
function mesNombre(iso){
  const M=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const [a,m]=String(iso||'').split('-').map(Number);
  return (m>=1&&m<=12)?`${M[m-1]} de ${a}`:iso;
}
/* Barras horizontales. Sirve para rankings (fallas, objetivos, equipos). */
function svgBarras(datos,opts){
  const o=Object.assign({ancho:520,alto:null,color:'#159B51',etiqueta:d=>d.nombre,valor:d=>d.cantidad,sufijo:''},opts||{});
  const d=datos.slice(0,o.max||10);
  if(!d.length)return '<div class="sub">Sin datos en el período.</div>';
  const max=Math.max(...d.map(o.valor),1);
  const fila=26, alto=d.length*fila+6, anchoEtiq=Math.min(190,o.anchoEtiq||170);
  const util=o.ancho-anchoEtiq-52;
  return `<svg viewBox="0 0 ${o.ancho} ${alto}" style="width:100%;height:auto;max-height:${alto}px" role="img">
    ${d.map((x,i)=>{
      const v=o.valor(x), w=Math.max(2,(v/max)*util), y=i*fila+3;
      const col=typeof o.color==='function'?o.color(x):o.color;
      return `<text x="0" y="${y+14}" font-size="12" fill="#4A5A51" font-family="system-ui,sans-serif">${escStk(String(o.etiqueta(x)).slice(0,28))}</text>
        <rect x="${anchoEtiq}" y="${y+3}" width="${w}" height="15" rx="3" fill="${col}"/>
        <text x="${anchoEtiq+w+6}" y="${y+15}" font-size="11.5" font-weight="600" fill="#16221C" font-family="ui-monospace,monospace">${v}${o.sufijo}</text>`;
    }).join('')}
  </svg>`;
}
/* Dona para composiciones (criticidad, categorías del pañol). */
function svgDona(datos,opts){
  const o=Object.assign({tam:170,colores:['#DC4A5B','#D98A1F','#3B7DC4','#159B51','#7C5CD6','#8A968E']},opts||{});
  const tot=datos.reduce((a,d)=>a+d.cantidad,0);
  if(!tot)return '<div class="sub">Sin datos.</div>';
  const r=o.tam/2, ri=r*0.58; let ang=-Math.PI/2;
  const arcos=datos.map((d,i)=>{
    const frac=d.cantidad/tot, fin=ang+frac*Math.PI*2;
    const x1=r+r*Math.cos(ang), y1=r+r*Math.sin(ang), x2=r+r*Math.cos(fin), y2=r+r*Math.sin(fin);
    const xi1=r+ri*Math.cos(fin), yi1=r+ri*Math.sin(fin), xi2=r+ri*Math.cos(ang), yi2=r+ri*Math.sin(ang);
    const grande=frac>0.5?1:0;
    ang=fin;
    // Un solo dato = círculo completo: el arco degenera y no se dibuja
    if(frac>=0.999)return `<circle cx="${r}" cy="${r}" r="${(r+ri)/2}" fill="none" stroke="${o.colores[i%o.colores.length]}" stroke-width="${r-ri}"/>`;
    return `<path d="M${x1} ${y1} A${r} ${r} 0 ${grande} 1 ${x2} ${y2} L${xi1} ${yi1} A${ri} ${ri} 0 ${grande} 0 ${xi2} ${yi2} Z" fill="${o.colores[i%o.colores.length]}"/>`;
  }).join('');
  return `<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
    <svg viewBox="0 0 ${o.tam} ${o.tam}" style="width:${o.tam}px;height:${o.tam}px;flex-shrink:0">${arcos}
      <text x="${r}" y="${r-2}" text-anchor="middle" font-size="26" font-weight="700" fill="#16221C" font-family="ui-monospace,monospace">${tot}</text>
      <text x="${r}" y="${r+14}" text-anchor="middle" font-size="10" fill="#8A968E" font-family="system-ui,sans-serif">${escStk(o.centro||'total')}</text></svg>
    <div style="font-size:12.5px">${datos.map((d,i)=>`<div style="display:flex;align-items:center;gap:7px;padding:2px 0">
      <span style="width:11px;height:11px;border-radius:3px;background:${o.colores[i%o.colores.length]};flex-shrink:0"></span>
      <span>${escStk(d.nombre)}</span>
      <b style="font-family:ui-monospace,monospace">${d.cantidad}</b>
      <span style="color:#8A968E">${Math.round(d.cantidad/tot*100)}%</span></div>`).join('')}</div>
  </div>`;
}
const COLOR_PRIO={critico:'#DC4A5B',alta:'#D98A1F',media:'#3B7DC4',baja:'#8A968E'};
const LABEL_PRIO={critico:'Crítica',alta:'Alta',media:'Media',baja:'Baja'};

/* Bateas por camión: lo del mes, el promedio mensual histórico y el
   mantenimiento de ese mismo camión. La comparación que importa es
   "este mes vs su propio promedio" — un camión que hace 40 y otro que
   hace 90 no son comparables entre sí, sí contra sí mismos. */
function bloqueBateas(b){
  if(!b)return '';
  if(!b.camiones||!b.camiones.length)
    return `<div class="panel" style="margin-bottom:14px"><div class="panel-title">Bateas</div>
      <div class="sub">No hay viajes cargados en el período.</div></div>`;
  const conMes=b.camiones.filter(c=>c.bateas_mes>0);
  const mesNom=x=>{const[a,m]=String(x).split('-');const M=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];return `${M[Number(m)-1]||m} ${String(a).slice(2)}`;};
  return `<div class="panel" style="margin-bottom:14px">
    <div class="panel-title">Bateas</div>
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:14px">
      <div class="kpi"><div class="kpi-label">Bateas del mes</div><div class="kpi-val">${b.total_mes}</div><div class="kpi-sub">${b.viajes_mes} viajes${b.m3_mes?' · '+b.m3_mes+' m³':''}</div></div>
      <div class="kpi"><div class="kpi-label">Camiones activos</div><div class="kpi-val">${conMes.length}</div><div class="kpi-sub">de ${b.camiones.length} con historia</div></div>
      <div class="kpi"><div class="kpi-label">Prom. por viaje</div><div class="kpi-val">${b.viajes_mes?Math.round((b.total_mes/b.viajes_mes)*10)/10:0}</div><div class="kpi-sub">bateas por viaje</div></div>
    </div>
    ${b.evolucion&&b.evolucion.length>1?`<div style="margin-bottom:14px">
      <div class="sub" style="font-weight:600;margin-bottom:8px">Últimos meses</div>
      ${svgBarras(b.evolucion.map(x=>({nombre:mesNom(x.nombre),cantidad:x.cantidad})),{max:6,color:'#3B7DC4',anchoEtiq:80})}
    </div>`:''}
    <table><thead><tr><th>Camión</th><th>Chofer</th><th style="text-align:right">Bateas del mes</th>
      <th style="text-align:right">Viajes</th><th style="text-align:right">Prom. mensual</th><th style="text-align:right">vs su promedio</th>
      <th style="text-align:right">Mantenimiento</th></tr></thead>
    <tbody>${b.camiones.map(c=>{
      const dif=c.prom_mensual?Math.round(((c.bateas_mes/c.prom_mensual)-1)*100):null;
      const col=dif==null?'inherit':dif<=-20?'var(--rojo)':dif>=20?'var(--brote)':'inherit';
      return `<tr>
        <td><b class="mono">${escStk(c.patente)}</b>${c.modelo?`<div class="sub" style="font-size:11.5px">${escStk(c.modelo)}</div>`:''}</td>
        <td class="sub" style="font-size:12px">${escStk(c.chofer||'—')}</td>
        <td class="mono" style="text-align:right;font-weight:600">${c.bateas_mes}</td>
        <td class="mono" style="text-align:right">${c.viajes_mes}</td>
        <td class="mono" style="text-align:right">${c.prom_mensual}<div class="sub" style="font-size:11px">${c.meses_activo} ${c.meses_activo===1?'mes':'meses'}</div></td>
        <td class="mono" style="text-align:right;color:${col}">${dif==null?'—':(dif>0?'+':'')+dif+'%'}</td>
        <td style="text-align:right">${c.mant_cantidad
          ?`<span class="badge ${c.mant_abiertas?'b-amber':'b-gray'}">${c.mant_cantidad} rep.</span>
             <div class="sub" style="font-size:11px">${c.mant_dias!=null?c.mant_dias+' d prom':''}${c.mant_parado?' · '+c.mant_parado+' parado':''}${c.mant_abiertas?' · '+c.mant_abiertas+' abierta'+(c.mant_abiertas===1?'':'s'):''}</div>`
          :'<span class="sub">sin entradas</span>'}</td></tr>`;}).join('')}
    </tbody></table>
    <div class="sub" style="font-size:11.5px;margin-top:8px">
      "vs su promedio" compara las bateas del mes contra el promedio mensual de ese mismo camión: verde si superó el 20%, rojo si quedó 20% abajo. El mantenimiento son las incidencias del mes de ese camión.
    </div>
  </div>`;
}

async function vReportes(view){
  if(!repMes)repMes=mesActualISO();
  if(!repDatos||repDatos.__mes!==repMes){
    view.innerHTML=`<div class="view-head"><div><div class="view-title">Reportes</div>
      <div class="view-desc">Informe mensual para gerencia</div></div></div><div class="cargando-v">Armando el reporte…</div>`;
    try{repDatos=await api('/api/reportes/mensual?mes='+repMes);repDatos.__mes=repMes;}
    catch(e){view.innerHTML=`<div class="view-head"><div><div class="view-title">Reportes</div></div></div>
      <div class="cargando-v">${escStk(e.message||'No pude armar el reporte')}</div>`;return;}
  }
  const d=repDatos, r=d.reparaciones, p=d.panol;
  // últimos 12 meses para el selector
  const meses=[];const hoy=new Date();
  for(let i=0;i<12;i++){const x=new Date(hoy.getFullYear(),hoy.getMonth()-i,1);
    meses.push(x.toLocaleDateString('sv-SE').slice(0,7));}

  const prioDona=r.por_prioridad.map(x=>({nombre:LABEL_PRIO[x.prioridad]||x.prioridad,cantidad:x.cantidad,__p:x.prioridad}));
  view.innerHTML=`
  <div class="view-head"><div><div class="view-title">Reportes</div>
    <div class="view-desc">Informe mensual · ${escStk(mesNombre(d.mes))}</div></div>
    <div style="display:flex;gap:8px;align-items:center">
      <select onchange="repMes=this.value;repDatos=null;go('reportes')" style="padding:7px 11px;border:1px solid var(--linea);border-radius:8px;font-size:13px">
        ${meses.map(m=>`<option value="${m}" ${m===repMes?'selected':''}>${escStk(mesNombre(m))}</option>`).join('')}
      </select>
      <button class="btn" onclick="imprimirReporte()">📄 Exportar PDF</button>
    </div></div>

  <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">
    <div class="kpi"><div class="kpi-label">Reparaciones</div><div class="kpi-val">${r.total}</div>
      <div class="kpi-sub">${r.finalizadas} finalizadas · ${r.abiertas} abiertas</div></div>
    <div class="kpi"><div class="kpi-label">Resolución promedio</div><div class="kpi-val">${r.dias_prom}<span style="font-size:15px"> d</span></div>
      <div class="kpi-sub">mediana ${r.dias_mediana} d · peor ${r.dias_peor} d</div></div>
    <div class="kpi"><div class="kpi-label">Reingresos</div><div class="kpi-val" style="color:${r.reingresos.porcentaje>10?'var(--rojo)':'inherit'}">${r.reingresos.porcentaje}%</div>
      <div class="kpi-sub">${r.reingresos.cantidad} volvieron · ${r.reingresos.misma_falla} misma falla</div></div>
    ${r.sin_reparar?`<div class="kpi"><div class="kpi-label">Cerradas sin reparar</div>
      <div class="kpi-val" style="color:var(--diesel)">${r.sin_reparar}</div>
      <div class="kpi-sub">${r.no_ingreso?r.no_ingreso+' nunca llegaron al taller':'no cuentan como reparación'}</div></div>`:''}
    <div class="kpi"><div class="kpi-label">Paradas hoy</div><div class="kpi-val" style="color:${r.parados_ahora?'var(--rojo)':'inherit'}">${r.parados_ahora!=null?r.parados_ahora:'—'}</div>
      <div class="kpi-sub">${r.parados} estuvieron paradas en el mes</div></div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
    <div class="panel"><div class="panel-title">Por criticidad</div>
      ${svgDona(prioDona,{centro:'incidencias',colores:prioDona.map(x=>COLOR_PRIO[x.__p]||'#8A968E')})}
      <table style="margin-top:12px"><thead><tr><th>Prioridad</th><th style="text-align:right">Cant.</th><th style="text-align:right">Días prom.</th><th style="text-align:right">Paradas</th></tr></thead>
      <tbody>${r.por_prioridad.map(x=>`<tr><td><span class="badge" style="background:${COLOR_PRIO[x.prioridad]}22;color:${COLOR_PRIO[x.prioridad]}">${LABEL_PRIO[x.prioridad]||x.prioridad}</span></td>
        <td class="mono" style="text-align:right">${x.cantidad}</td>
        <td class="mono" style="text-align:right">${x.dias_prom!=null?x.dias_prom+' d':'—'}</td>
        <td class="mono" style="text-align:right">${x.parados||''}</td></tr>`).join('')}</tbody></table>
    </div>
    <div class="panel"><div class="panel-title">Tipos de falla · de más crítico a menos</div>
      ${svgBarras(r.por_falla,{max:9,etiqueta:f=>f.falla,valor:f=>f.cantidad,
        color:f=>f.criticas>0?'#DC4A5B':'#3B7DC4'})}
      <div class="sub" style="font-size:11.5px;margin-top:6px">En rojo las que tuvieron incidencias críticas o altas.</div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
    <div class="panel"><div class="panel-title">Dónde se rompe · por objetivo</div>
      ${svgBarras(r.por_objetivo,{max:8})}</div>
    <div class="panel"><div class="panel-title">Qué se rompe · por equipo</div>
      ${svgBarras(r.por_equipo,{max:8,color:'#7C5CD6'})}</div>
  </div>

  ${r.reingresos.cantidad?`<div class="panel" style="border-left:3px solid var(--rojo);margin-bottom:14px">
    <div class="panel-title" style="color:var(--rojo)">Reingresos · máquinas que volvieron dentro de los 30 días</div>
    <table><thead><tr><th>Equipo</th><th>N°</th><th>Falla anterior</th><th>Falla ahora</th><th style="text-align:right">Días</th><th>Reparó antes</th></tr></thead>
    <tbody>${r.reingresos.detalle.map(x=>`<tr>
      <td>${escStk(x.equipo||'—')}</td><td class="mono">${escStk(x.unidad||'—')}</td>
      <td class="sub">${escStk(x.falla_previa||'—')}</td>
      <td>${escStk(x.falla_ahora||'—')}${x.misma_falla?' <span class="badge b-rojo">misma</span>':''}</td>
      <td class="mono" style="text-align:right">${x.dias}</td>
      <td class="sub">${escStk(x.mecanico||'—')}</td></tr>`).join('')}</tbody></table>
  </div>`:''}

  <div class="panel" style="margin-bottom:14px">
    <div class="panel-title">Tiempo de resolución · las 12 que más tardaron</div>
    ${svgBarras(r.detalle_tiempos.slice(0,12),{max:12,sufijo:' d',
      etiqueta:x=>`${x.equipo||''} ${x.unidad?'N° '+x.unidad:''}`.trim()||'—',valor:x=>x.dias,
      color:x=>({critico:'#DC4A5B',alta:'#D98A1F'})[String(x.prioridad||'').toLowerCase()]||'#3B7DC4'})}
  </div>

  ${r.sin_reparar?`<div class="panel" style="border-left:3px solid var(--diesel);margin-bottom:14px">
    <div class="panel-title" style="color:var(--diesel)">📭 Cerradas sin pasar por el taller (${r.sin_reparar})</div>
    <div class="sub" style="font-size:12px;margin-bottom:10px">
      No se cuentan como reparaciones: no entran en el total, ni en los días promedio, ni en los reingresos.</div>
    ${svgBarras(r.sin_reparar_por_motivo,{max:5,color:'#D98A1F',anchoEtiq:190})}
    ${r.no_ingreso?`<div class="sub" style="font-size:12px;margin-top:8px">
      <b>${r.no_ingreso}</b> se reportaron y el equipo nunca bajó al taller. Si el número es alto, el cuello de botella está en el traslado, no en el taller.</div>`:''}
  </div>`:''}

  ${r.parados_detalle&&r.parados_detalle.length?`<div class="panel" style="border-left:3px solid var(--rojo);margin-bottom:14px">
    <div class="panel-title" style="color:var(--rojo)">⛔ Paradas en este momento (${r.parados_detalle.length})</div>
    <div class="sub" style="font-size:12px;margin-bottom:10px">Máquinas sin poder trabajar hoy, sin importar de qué mes sea la incidencia.</div>
    <table><thead><tr><th>Equipo</th><th>N°</th><th>Objetivo</th><th>Prioridad</th><th style="text-align:right">Días parada</th></tr></thead>
    <tbody>${r.parados_detalle.map(x=>`<tr>
      <td>${escStk(x.equipo||'—')}</td><td class="mono">${escStk(x.unidad||'—')}</td>
      <td class="sub">${escStk(x.objetivo||'—')}</td>
      <td><span class="badge" style="background:${COLOR_PRIO[String(x.prioridad||'').toLowerCase()]||'#8A968E'}22;color:${COLOR_PRIO[String(x.prioridad||'').toLowerCase()]||'#8A968E'}">${LABEL_PRIO[String(x.prioridad||'').toLowerCase()]||x.prioridad||'—'}</span></td>
      <td class="mono" style="text-align:right;color:${x.dias>=7?'var(--rojo)':x.dias>=3?'var(--diesel)':'inherit'}">${x.dias}</td></tr>`).join('')}
    </tbody></table>
  </div>`:''}

  ${bloqueBateas(d.bateas)}

  <div class="panel">
    <div class="panel-title">Pañol</div>
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:14px">
      <div class="kpi"><div class="kpi-label">Ítems</div><div class="kpi-val">${p.items}</div><div class="kpi-sub">${p.unidades} unidades</div></div>
      <div class="kpi"><div class="kpi-label">Salidas del mes</div><div class="kpi-val">${p.salidas_mes}</div><div class="kpi-sub">${p.afuera} sin devolver</div></div>
      <div class="kpi"><div class="kpi-label">Bajo mínimo</div><div class="kpi-val" style="color:${p.bajo_minimo?'var(--diesel)':'inherit'}">${p.bajo_minimo}</div><div class="kpi-sub">${p.agotados} agotados</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div><div class="sub" style="font-weight:600;margin-bottom:8px">Lo que más salió</div>
        ${svgBarras(p.top_consumo,{max:8,color:'#D98A1F'})}</div>
      <div><div class="sub" style="font-weight:600;margin-bottom:8px">A qué objetivo fue</div>
        ${svgBarras(p.salidas_por_objetivo,{max:8,color:'#159B51'})}</div>
    </div>
  </div>`;
}

/* PDF: ventana nueva + print(), el usuario elige "Guardar como PDF".
   Mismo camino que el informe por mecánico — sin librerías externas. */
function imprimirReporte(){
  if(!repDatos)return alert('Esperá a que cargue el reporte.');
  const d=repDatos, r=d.reparaciones, p=d.panol;
  const prioDona=r.por_prioridad.map(x=>({nombre:LABEL_PRIO[x.prioridad]||x.prioridad,cantidad:x.cantidad,__p:x.prioridad}));
  const hoy=new Date().toLocaleDateString('es-AR');
  const kpi=(l,v,s,c)=>`<div class="k"><div class="kl">${l}</div><div class="kv"${c?` style="color:${c}"`:''}>${v}</div><div class="ks">${s||''}</div></div>`;
  const html=`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Reporte ${escStk(mesNombre(d.mes))} · EcoService</title><style>
    *{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,sans-serif;color:#16221C;margin:0;padding:26px 30px;font-size:12.5px;line-height:1.5}
    h1{font-size:23px;margin:0 0 2px;letter-spacing:-.4px}
    h2{font-size:14px;margin:0 0 12px;padding-bottom:6px;border-bottom:2px solid #16221C;letter-spacing:-.2px}
    .cab{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #159B51;padding-bottom:12px;margin-bottom:20px}
    .sub{color:#4A5A51;font-size:12px}
    .mini{color:#8A968E;font-size:11px}
    .sec{margin-bottom:22px;page-break-inside:avoid}
    .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
    .k{border:1px solid #E6EBE4;border-radius:9px;padding:11px 13px;background:#FBFCFA}
    .kl{font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:#8A968E;font-weight:600}
    .kv{font-family:ui-monospace,monospace;font-size:25px;font-weight:700;margin-top:5px;letter-spacing:-1px}
    .ks{font-size:11px;color:#4A5A51;margin-top:3px}
    .dos{display:grid;grid-template-columns:1fr 1fr;gap:18px}
    table{width:100%;border-collapse:collapse;font-size:11.5px}
    th{text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.7px;color:#8A968E;padding:6px 8px;border-bottom:1px solid #E6EBE4}
    td{padding:6px 8px;border-bottom:1px solid #F2F5F0}
    .mono{font-family:ui-monospace,monospace}
    .der{text-align:right}
    .rojo{color:#DC4A5B}
    .badge{display:inline-block;font-size:10px;font-weight:700;border-radius:5px;padding:1px 6px}
    .pie{margin-top:26px;padding-top:10px;border-top:1px solid #E6EBE4;font-size:10.5px;color:#8A968E;display:flex;justify-content:space-between}
    @media print{body{padding:12mm 10mm}.sec{page-break-inside:avoid}}
  </style></head><body>
    <div class="cab">
      <div><h1>Reporte mensual de mantenimiento</h1>
        <div class="sub">${escStk(mesNombre(d.mes))} · EcoService S.R.L.</div></div>
      <div class="mini">Emitido el ${hoy}</div>
    </div>

    <div class="sec">
      <div class="kpis">
        ${kpi('Reparaciones',r.total,`${r.finalizadas} finalizadas · ${r.abiertas} abiertas`)}
        ${kpi('Resolución promedio',r.dias_prom+' d',`mediana ${r.dias_mediana} d · peor ${r.dias_peor} d`)}
        ${kpi('Reingresos',r.reingresos.porcentaje+'%',`${r.reingresos.cantidad} volvieron · ${r.reingresos.misma_falla} misma falla`,r.reingresos.porcentaje>10?'#DC4A5B':'')}
        ${kpi('Paradas hoy',r.parados_ahora!=null?r.parados_ahora:'—',`${r.parados} estuvieron paradas en el mes`,r.parados_ahora?'#DC4A5B':'')}
      </div>
    </div>

    <div class="sec dos">
      <div><h2>Por criticidad</h2>
        ${svgDona(prioDona,{tam:150,centro:'incidencias',colores:prioDona.map(x=>COLOR_PRIO[x.__p]||'#8A968E')})}
        <table style="margin-top:10px"><thead><tr><th>Prioridad</th><th class="der">Cant.</th><th class="der">Días prom.</th></tr></thead>
        <tbody>${r.por_prioridad.map(x=>`<tr><td><span class="badge" style="background:${COLOR_PRIO[x.prioridad]}22;color:${COLOR_PRIO[x.prioridad]}">${LABEL_PRIO[x.prioridad]||x.prioridad}</span></td>
          <td class="der mono">${x.cantidad}</td><td class="der mono">${x.dias_prom!=null?x.dias_prom+' d':'—'}</td></tr>`).join('')}</tbody></table>
      </div>
      <div><h2>Tipos de falla</h2>
        ${svgBarras(r.por_falla,{ancho:420,max:9,etiqueta:f=>f.falla,valor:f=>f.cantidad,color:f=>f.criticas>0?'#DC4A5B':'#3B7DC4'})}
        <div class="mini">En rojo las que tuvieron incidencias críticas o altas.</div>
      </div>
    </div>

    <div class="sec dos">
      <div><h2>Por objetivo</h2>${svgBarras(r.por_objetivo,{ancho:420,max:8})}</div>
      <div><h2>Por tipo de equipo</h2>${svgBarras(r.por_equipo,{ancho:420,max:8,color:'#7C5CD6'})}</div>
    </div>

    <div class="sec">
      <h2>Tiempo de resolución · las que más tardaron</h2>
      ${svgBarras(r.detalle_tiempos.slice(0,12),{ancho:900,max:12,sufijo:' d',anchoEtiq:230,
        etiqueta:x=>`${x.equipo||''} ${x.unidad?'N° '+x.unidad:''}`.trim()||'—',valor:x=>x.dias,
        color:x=>({critico:'#DC4A5B',alta:'#D98A1F'})[String(x.prioridad||'').toLowerCase()]||'#3B7DC4'})}
    </div>

    ${r.reingresos.cantidad?`<div class="sec">
      <h2>Reingresos · volvieron dentro de los 30 días</h2>
      <table><thead><tr><th>Equipo</th><th>N°</th><th>Falla anterior</th><th>Falla ahora</th><th class="der">Días</th><th>Reparó antes</th></tr></thead>
      <tbody>${r.reingresos.detalle.map(x=>`<tr><td>${escStk(x.equipo||'—')}</td><td class="mono">${escStk(x.unidad||'—')}</td>
        <td>${escStk(x.falla_previa||'—')}</td><td>${escStk(x.falla_ahora||'—')}${x.misma_falla?' <span class="badge" style="background:#FCEBED;color:#DC4A5B">misma falla</span>':''}</td>
        <td class="der mono">${x.dias}</td><td>${escStk(x.mecanico||'—')}</td></tr>`).join('')}</tbody></table>
      <div class="mini" style="margin-top:6px">El reingreso con la misma falla es el indicador de calidad de la reparación.</div>
    </div>`:''}

    ${r.sin_reparar?`<div class="sec">
      <h2>Cerradas sin pasar por el taller</h2>
      <div class="mini" style="margin-bottom:8px">No se cuentan como reparaciones: quedan fuera del total, de los días promedio y de los reingresos.</div>
      ${svgBarras(r.sin_reparar_por_motivo,{ancho:520,max:5,color:'#D98A1F',anchoEtiq:190})}
      ${r.no_ingreso?`<div class="mini" style="margin-top:6px"><b>${r.no_ingreso}</b> se reportaron y el equipo nunca bajó al taller.</div>`:''}
    </div>`:''}

    ${r.parados_detalle&&r.parados_detalle.length?`<div class="sec">
      <h2>Paradas en este momento</h2>
      <table><thead><tr><th>Equipo</th><th>N°</th><th>Objetivo</th><th>Prioridad</th><th class="der">Días parada</th></tr></thead>
      <tbody>${r.parados_detalle.map(x=>`<tr><td>${escStk(x.equipo||'—')}</td><td class="mono">${escStk(x.unidad||'—')}</td>
        <td>${escStk(x.objetivo||'—')}</td><td>${LABEL_PRIO[String(x.prioridad||'').toLowerCase()]||x.prioridad||'—'}</td>
        <td class="der mono"${x.dias>=7?' style="color:#DC4A5B;font-weight:700"':''}>${x.dias}</td></tr>`).join('')}</tbody></table>
      <div class="mini" style="margin-top:6px">Máquinas sin poder trabajar al momento de emitir el reporte, sin importar de qué mes es la incidencia.</div>
    </div>`:''}

    ${d.bateas&&d.bateas.camiones&&d.bateas.camiones.length?`<div class="sec">
      <h2>Bateas</h2>
      <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
        ${kpi('Bateas del mes',d.bateas.total_mes,`${d.bateas.viajes_mes} viajes${d.bateas.m3_mes?' · '+d.bateas.m3_mes+' m³':''}`)}
        ${kpi('Camiones activos',d.bateas.camiones.filter(c=>c.bateas_mes>0).length,`de ${d.bateas.camiones.length} con historia`)}
        ${kpi('Prom. por viaje',d.bateas.viajes_mes?Math.round((d.bateas.total_mes/d.bateas.viajes_mes)*10)/10:0,'bateas por viaje')}
      </div>
      <table><thead><tr><th>Camión</th><th>Chofer</th><th class="der">Bateas mes</th><th class="der">Viajes</th>
        <th class="der">Prom. mensual</th><th class="der">vs promedio</th><th class="der">Mantenimiento</th></tr></thead>
      <tbody>${d.bateas.camiones.map(c=>{
        const dif=c.prom_mensual?Math.round(((c.bateas_mes/c.prom_mensual)-1)*100):null;
        return `<tr><td class="mono"><b>${escStk(c.patente)}</b>${c.modelo?`<br><span style="font-size:10px;color:#8A968E">${escStk(c.modelo)}</span>`:''}</td>
          <td>${escStk(c.chofer||'—')}</td>
          <td class="der mono">${c.bateas_mes}</td><td class="der mono">${c.viajes_mes}</td>
          <td class="der mono">${c.prom_mensual}</td>
          <td class="der mono"${dif!=null&&dif<=-20?' class="rojo"':''}>${dif==null?'—':(dif>0?'+':'')+dif+'%'}</td>
          <td class="der">${c.mant_cantidad?`${c.mant_cantidad} rep.${c.mant_dias!=null?' · '+c.mant_dias+' d':''}`:'—'}</td></tr>`;}).join('')}
      </tbody></table>
      <div class="mini" style="margin-top:6px">El promedio mensual toma solo los meses con actividad de cada camión. "vs promedio" compara el mes contra ese promedio propio.</div>
    </div>`:''}

    <div class="sec">
      <h2>Pañol</h2>
      <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
        ${kpi('Ítems en pañol',p.items,p.unidades+' unidades')}
        ${kpi('Salidas del mes',p.salidas_mes,p.afuera+' sin devolver')}
        ${kpi('Bajo mínimo',p.bajo_minimo,p.agotados+' agotados',p.bajo_minimo?'#D98A1F':'')}
        ${kpi('Categorías',p.por_categoria.length,p.por_categoria.map(c=>c.nombre).slice(0,3).join(', '))}
      </div>
      <div class="dos">
        <div><div class="sub" style="font-weight:600;margin-bottom:6px">Lo que más salió</div>
          ${svgBarras(p.top_consumo,{ancho:420,max:8,color:'#D98A1F'})}</div>
        <div><div class="sub" style="font-weight:600;margin-bottom:6px">A qué objetivo fue</div>
          ${svgBarras(p.salidas_por_objetivo,{ancho:420,max:8,color:'#159B51'})}</div>
      </div>
    </div>

    <div class="pie"><span>EcoService S.R.L. · Reporte de mantenimiento</span><span>${escStk(mesNombre(d.mes))}</span></div>
    <script>window.print()<\/script></body></html>`;
  const w=window.open('','_blank');
  if(!w)return alert('El navegador bloqueó la ventana. Permití pop-ups para exportar el PDF.');
  w.document.write(html);w.document.close();
}

/* ── Pañol ────────────────────────────────────────────────────
   El alta de lo que se guarda en el pañol: herramientas, insumos, todo.
   Las salidas las registra el pañolero desde la app; acá se ve qué hay,
   qué está afuera y qué se pasó de fecha. */
let pnlData=null, pnlTab='items', pnlQ='', pnlCat='', pnlEstado='';
async function vStockPanol(view){
  if(!pnlData){
    view.innerHTML=tabsStk()+'<div class="cargando-v">Cargando el pañol…</div>';
    try{pnlData=await api('/api/panol');}
    catch(e){view.innerHTML=tabsStk()+`<div class="cargando-v">${escStk(e.message||'No pude cargar')}</div>`;return;}
  }
  const items=pnlData.items||[], afuera=pnlData.afuera||[];
  const dias=f=>f?Math.ceil((new Date(f)-new Date())/86400000):null;
  const vencidos=afuera.filter(m=>m.retorno_previsto&&dias(m.retorno_previsto)<0);
  const bajos=items.filter(i=>Number(i.disponible)<=Number(i.minimo||0));
  const vis=pnlFiltrar(items);
  const itemDe=id=>items.find(x=>x.id===id);
  const fFecha=f=>f?new Date(f).toLocaleDateString('es-AR'):'—';
  // Lo que está afuera también se filtra: por vencidas y por texto (ítem,
  // objetivo o quién retiró).
  const normA=t=>String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const afueraVis=afuera.filter(m=>{
    if(pnlEstado==='vencidas'&&!(m.retorno_previsto&&dias(m.retorno_previsto)<0))return false;
    if(!pnlQ)return true;
    const it=itemDe(m.item_id);
    const blob=normA(`${it?it.nombre:''} ${m.objetivo_nombre||''} ${m.retira||''}`);
    return normA(pnlQ).split(/\s+/).filter(Boolean).every(w=>blob.includes(w));
  });

  view.innerHTML=`
  <div class="view-head"><div><div class="view-title">Pañol</div>
    <div class="view-desc">Lo que se guarda y lo que sale · las salidas las registra el pañolero desde la app</div></div>
    <button class="btn" onclick="pnlNuevo()">+ Nuevo ítem</button></div>
  ${tabsStk()}
  <div class="kpis" style="grid-template-columns:repeat(3,minmax(160px,1fr))">
    <div class="kpi"><div class="kpi-label">En el pañol</div><div class="kpi-val">${items.length}</div><div class="kpi-sub">tipos cargados</div></div>
    <div class="kpi"><div class="kpi-label">Afuera</div><div class="kpi-val">${afuera.length}</div><div class="kpi-sub">${afuera.length?'sin devolver':'todo en el pañol'}</div></div>
    <div class="kpi"><div class="kpi-label">Vencidas</div><div class="kpi-val" style="color:${vencidos.length?'var(--rojo)':'inherit'}">${vencidos.length}</div><div class="kpi-sub">pasaron la fecha de vuelta</div></div>
    ${(()=>{const ing=(pnlData.movimientos||[]).filter(m=>m.tipo==='ingreso');
      const mesAct=new Date().toISOString().slice(0,7);
      const delMes=ing.filter(m=>String(m.created_at||'').slice(0,7)===mesAct);
      return `<div class="kpi"><div class="kpi-label">Ingresos del mes</div><div class="kpi-val">${delMes.length}</div><div class="kpi-sub">${ing.length} en total</div></div>`;})()}
  </div>

  <div class="toggle-imp" style="margin-bottom:14px">
    <button class="${pnlTab==='items'?'on':''}" onclick="pnlTab='items';go('stock')">Lo que hay (${items.length})</button>
    <button class="${pnlTab==='afuera'?'on':''}" onclick="pnlTab='afuera';go('stock')">Afuera (${afuera.length})</button>
    <button class="${pnlTab==='comprar'?'on':''}" onclick="pnlTab='comprar';go('stock')">Qué comprar</button>
    <button class="${pnlTab==='movs'?'on':''}" onclick="pnlTab='movs';go('stock')">Movimientos</button>
  </div>
  ${pnlTab==='comprar'?'<div id="pnl-repo"><div class="cargando-v">Calculando el consumo…</div></div>':''}

  ${pnlTab==='comprar'?(()=>{setTimeout(cargarReposicion,0);return '';})():''}
  ${pnlTab==='items'?`
    ${(()=>{setTimeout(pintarPanol,0);return '';})()}
    ${(()=>{const rev=items.filter(i=>String(i.notas||'').startsWith('REVISAR'));
      return rev.length?`<div class="panel" style="border-left:3px solid var(--azul);margin-bottom:14px">
        <div class="panel-title" style="color:var(--azul)">📋 ${rev.length} ítem${rev.length===1?'':'s'} de la carga inicial para revisar</div>
        <div class="sub" style="font-size:12.5px">Se cargaron con lo que se entendió del cuaderno. Editá cada uno y borrá la nota cuando esté confirmado.</div>
      </div>`:'';})()}
    ${bajos.length?`<div class="panel" style="border-left:3px solid var(--diesel);margin-bottom:14px">
      <div class="panel-title" style="color:var(--diesel)">⚠ Stock bajo o agotado</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${bajos.map(i=>`<span class="uni-chip">${escStk(i.nombre)} · ${i.disponible} ${escStk(i.unidad||'u')}</span>`).join('')}</div>
    </div>`:''}
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:10px;flex-wrap:wrap">
        <div class="panel-title" style="margin:0">Lo que hay en el pañol</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <select onchange="pnlCat=this.value;pintarPanol()" style="padding:6px 10px;border:1px solid var(--linea);border-radius:8px;font-size:12.5px">
            <option value="">Todas las categorías</option>
            ${['herramienta','insumo','repuesto','otro'].map(c=>{
              const n=items.filter(i=>i.categoria===c).length;
              return n?`<option value="${c}" ${pnlCat===c?'selected':''}>${c} (${n})</option>`:'';}).join('')}
          </select>
          <select onchange="pnlEstado=this.value;pintarPanol()" style="padding:6px 10px;border:1px solid var(--linea);border-radius:8px;font-size:12.5px">
            <option value="">Todos</option>
            <option value="bajo" ${pnlEstado==='bajo'?'selected':''}>Stock bajo o agotado (${bajos.length})</option>
            <option value="revisar" ${pnlEstado==='revisar'?'selected':''}>Para revisar (${items.filter(i=>String(i.notas||'').startsWith('REVISAR')).length})</option>
            <option value="afuera" ${pnlEstado==='afuera'?'selected':''}>Con unidades afuera (${items.filter(i=>Number(i.afuera)>0).length})</option>
            <option value="vuelve" ${pnlEstado==='vuelve'?'selected':''}>Solo lo que vuelve (${items.filter(i=>i.retornable).length})</option>
          </select>
          <input id="pnl-q" placeholder="Buscar nombre, código, marca, ubicación…" value="${escStk(pnlQ)}" oninput="pnlQ=this.value;pintarPanol()"
            style="width:250px;padding:6px 10px;border:1px solid var(--linea);border-radius:8px;font-size:12.5px">
          ${pnlQ||pnlCat||pnlEstado?`<button class="btn-salir" style="padding:5px 9px;font-size:11.5px" onclick="pnlQ='';pnlCat='';pnlEstado='';go('stock')">✕ limpiar</button>`:''}
        </div>
      </div>
      <div class="sub" id="pnl-cuenta" style="font-size:12px;margin-bottom:8px"></div>
      <table><thead><tr><th>Ítem</th><th>Categoría</th><th>Código</th><th>Ubicación</th>
        <th style="text-align:right">Hay</th><th style="text-align:right">Afuera</th><th style="text-align:right">Disponible</th><th></th></tr></thead>
      <tbody id="pnl-body">${pnlFilas(vis)}</tbody></table>
    </div>`:pnlTab==='afuera'?`
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:10px;flex-wrap:wrap">
        <div class="panel-title" style="margin:0">Lo que está afuera</div>
        <div style="display:flex;gap:6px;align-items:center">
          <select onchange="pnlEstado=this.value;go('stock')" style="padding:6px 10px;border:1px solid var(--linea);border-radius:8px;font-size:12.5px">
            <option value="">Todas</option>
            <option value="vencidas" ${pnlEstado==='vencidas'?'selected':''}>Solo vencidas (${vencidos.length})</option>
          </select>
          <input placeholder="Buscar ítem, objetivo, quién retiró…" value="${escStk(pnlQ)}" oninput="pnlQ=this.value;clearTimeout(window.__pnlT);window.__pnlT=setTimeout(()=>go('stock'),350)"
            style="width:250px;padding:6px 10px;border:1px solid var(--linea);border-radius:8px;font-size:12.5px">
          ${pnlQ||pnlEstado?`<button class="btn-salir" style="padding:5px 9px;font-size:11.5px" onclick="pnlQ='';pnlEstado='';go('stock')">✕</button>`:''}
        </div>
      </div>
      <table><thead><tr><th>Ítem</th><th style="text-align:right">Cant.</th><th>Objetivo</th><th>Retiró</th><th>Salió</th><th>Vuelve</th><th></th></tr></thead>
      <tbody>${afueraVis.map(m=>{
        const d=dias(m.retorno_previsto), venc=d!=null&&d<0;
        const it=itemDe(m.item_id);
        return `<tr>
          <td><b>${escStk(it?it.nombre:'—')}</b></td>
          <td class="mono" style="text-align:right">${m.cantidad}</td>
          <td>${escStk(m.objetivo_nombre||(m.objetivos&&m.objetivos.nombre)||'—')}</td>
          <td class="sub" style="font-size:12px">${escStk(m.retira||'—')}</td>
          <td class="mono" style="font-size:11.5px">${fFecha(m.fecha_salida)}</td>
          <td class="mono" style="font-size:11.5px;color:${venc?'var(--rojo)':d===0?'var(--diesel)':'inherit'}">
            ${m.retorno_previsto?`${fFecha(m.retorno_previsto)}${venc?` <b>(+${Math.abs(d)}d)</b>`:d===0?' <b>(hoy)</b>':''}`:'sin fecha'}</td>
          <td><button class="mini-btn" onclick="pnlDevolver('${m.id}')">✓ Volvió</button></td></tr>`;}).join('')
        ||`<tr><td colspan="7" class="sub" style="padding:18px">${pnlQ||pnlEstado?'Nada con estos filtros.':'No hay nada afuera. Todo está en el pañol.'}</td></tr>`}
      </tbody></table>
    </div>`:pnlTab==='movs'?`
    <div class="panel">
      <div class="panel-title">Últimos movimientos <span class="sub" style="font-weight:400">· entradas y salidas del pañol</span></div>
      <table><thead><tr><th>Cuándo</th><th>Qué</th><th style="text-align:right">Cant.</th><th>Tipo</th><th>Objetivo / origen</th><th>Quién</th><th>Detalle</th></tr></thead>
      <tbody>${(pnlData.movimientos||[]).map(m=>{
        const it=itemDe(m.item_id);
        const esIng=m.tipo==='ingreso';
        const badge=esIng?'<span class="badge b-green">↓ ingreso</span>'
          :m.estado==='consumido'?'<span class="badge b-gray">↑ consumido</span>'
          :m.estado==='devuelto'?'<span class="badge" style="background:var(--azul-soft);color:var(--azul)">↩ devuelto</span>'
          :'<span class="badge b-amber">↑ afuera</span>';
        return `<tr>
          <td class="mono" style="font-size:11.5px">${fFecha(m.created_at||m.fecha_salida)}</td>
          <td><b>${escStk(it?it.nombre:'—')}</b></td>
          <td class="mono" style="text-align:right;color:${esIng?'var(--brote)':'inherit'}">${esIng?'+':'−'}${m.cantidad}</td>
          <td>${badge}</td>
          <td class="sub" style="font-size:12px">${escStk(m.objetivo_nombre||(m.objetivos&&m.objetivos.nombre)||m.retira||'—')}</td>
          <td class="sub" style="font-size:12px">${escStk(m.entrego||m.recibio||'—')}</td>
          <td class="sub" style="font-size:11.5px">${escStk(m.nota||m.nota_devolucion||'')}</td></tr>`;}).join('')
        ||'<tr><td colspan="7" class="sub" style="padding:18px">Todavía no hay movimientos.</td></tr>'}
      </tbody></table>
    </div>`:''}`;
}

/* ── Gráficos de reposición ───────────────────────────────────
   Dos lecturas distintas: el NIVEL dice qué comprar ya, el PARETO dice
   sobre qué vale la pena poner atención todo el año. */

/* Barra por ítem con la marca del punto de pedido. La barra se dibuja
   sobre una escala de 2× el punto de pedido, así el punto queda siempre
   en el medio y se compara de un vistazo aunque las cantidades sean muy
   distintas (163 carreteles contra 5 litros de aceite). */
function svgNivel(filas){
  if(!filas.length)return '<div class="sub">Sin datos.</div>';
  const ancho=560, fila=30, alto=filas.length*fila+18, etiq=170, util=ancho-etiq-70;
  return `<svg viewBox="0 0 ${ancho} ${alto}" style="width:100%;height:auto;max-height:${alto}px">
    ${filas.map((f,i)=>{
      const pp=f.punto_pedido!=null?Number(f.punto_pedido):(Number(f.minimo)||1);
      const disp=Number(f.disponible)||0;
      const esc=pp*2||1;
      const w=Math.max(2,Math.min(1,disp/esc)*util);
      const xp=etiq+(pp/esc)*util;
      const y=i*fila+6;
      const col=disp<=pp?'#DC4A5B':disp<=pp*1.3?'#D98A1F':'#159B51';
      return `<text x="0" y="${y+15}" font-size="12" fill="#4A5A51" font-family="system-ui,sans-serif">${escStk(String(f.nombre).slice(0,24))}</text>
        <rect x="${etiq}" y="${y+3}" width="${util}" height="17" rx="4" fill="#F2F5F0"/>
        <rect x="${etiq}" y="${y+3}" width="${w}" height="17" rx="4" fill="${col}"/>
        <line x1="${xp}" y1="${y}" x2="${xp}" y2="${y+23}" stroke="#16221C" stroke-width="1.5" stroke-dasharray="3 2"/>
        <text x="${etiq+util+7}" y="${y+16}" font-size="11.5" font-weight="600" fill="${col}" font-family="ui-monospace,monospace">${Math.round(disp*10)/10}</text>`;
    }).join('')}
    <text x="${etiq}" y="${alto-2}" font-size="10" fill="#8A968E" font-family="system-ui,sans-serif">0</text>
    <text x="${etiq+util}" y="${alto-2}" font-size="10" fill="#8A968E" text-anchor="end" font-family="system-ui,sans-serif">2× el punto de pedido</text>
  </svg>`;
}

/* Pareto: barras de consumo + línea de acumulado con la marca del 80%. */
function svgPareto(filas,total){
  if(!filas.length||!total)return '<div class="sub">Sin consumo registrado.</div>';
  const ancho=620, alto=210, base=alto-42, izq=34, util=ancho-izq-30;
  const paso=util/filas.length, maxV=Math.max(...filas.map(f=>Number(f.consumo_90d)),1);
  let acum=0;
  const puntos=[], barras=filas.map((f,i)=>{
    const v=Number(f.consumo_90d)||0;
    acum+=v;
    const pct=acum/total;
    const h=Math.max(2,(v/maxV)*(base-24));
    const x=izq+i*paso+paso*0.15, w=paso*0.7;
    puntos.push([x+w/2, 18+(1-pct)*(base-24)]);
    const col=pct<=0.8?'#DC4A5B':pct<=0.95?'#D98A1F':'#8A968E';
    return `<rect x="${x}" y="${base-h}" width="${w}" height="${h}" rx="3" fill="${col}"/>
      <text x="${x+w/2}" y="${base-h-4}" font-size="10" text-anchor="middle" fill="#4A5A51" font-family="ui-monospace,monospace">${Math.round(v)}</text>
      <text x="${x+w/2}" y="${base+13}" font-size="9.5" text-anchor="middle" fill="#8A968E" font-family="system-ui,sans-serif"
        transform="rotate(-18 ${x+w/2} ${base+13})">${escStk(String(f.nombre).slice(0,13))}</text>`;
  }).join('');
  const y80=18+0.2*(base-24);   // el 80% acumulado, medido desde arriba
  return `<svg viewBox="0 0 ${ancho} ${alto}" style="width:100%;height:auto">
    <line x1="${izq}" y1="${y80}" x2="${izq+util}" y2="${y80}" stroke="#159B51" stroke-width="1.5" stroke-dasharray="4 3"/>
    <text x="${izq+util}" y="${y80-5}" font-size="10" text-anchor="end" fill="#159B51" font-family="system-ui,sans-serif">80% del consumo</text>
    ${barras}
    <polyline points="${puntos.map(p=>p.join(',')).join(' ')}" fill="none" stroke="#3B7DC4" stroke-width="2"/>
    ${puntos.map(p=>`<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="#3B7DC4"/>`).join('')}
    <line x1="${izq}" y1="${base}" x2="${izq+util}" y2="${base}" stroke="#E6EBE4"/>
  </svg>`;
}

/* Filtro + búsqueda del pañol. Con 80 ítems hace falta llegar rápido a uno.
   El buscador entra por nombre, código, marca y ubicación. */
function pnlFiltrar(items){
  const norm=t=>String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const q=norm(pnlQ).split(/\s+/).filter(Boolean);   // varias palabras = todas tienen que estar
  return (items||[]).filter(i=>{
    if(pnlCat&&i.categoria!==pnlCat)return false;
    if(pnlEstado==='bajo'&&!(Number(i.disponible)<=Number(i.minimo||0)))return false;
    if(pnlEstado==='revisar'&&!String(i.notas||'').startsWith('REVISAR'))return false;
    if(pnlEstado==='afuera'&&!(Number(i.afuera)>0))return false;
    if(pnlEstado==='vuelve'&&!i.retornable)return false;
    if(!q.length)return true;
    const blob=norm(`${i.nombre} ${i.codigo||''} ${i.marca||''} ${i.ubicacion||''} ${i.categoria||''} ${i.notas||''}`);
    return q.every(w=>blob.includes(w));
  });
}
function pnlFilas(vis){
  if(!vis.length)return '<tr><td colspan="8" class="sub" style="padding:18px">Nada con estos filtros.</td></tr>';
  return vis.map(i=>{
    const disp=Number(i.disponible)||0, bajo=disp<=Number(i.minimo||0);
    return `<tr>
      <td><b>${escStk(i.nombre)}</b>${i.marca?`<div class="sub" style="font-size:11.5px">${escStk(i.marca)}</div>`:''}
        ${String(i.notas||'').startsWith('REVISAR')?`<div style="font-size:11px;color:var(--diesel);margin-top:2px">⚠ ${escStk(i.notas.replace(/^REVISAR:\s*/,''))}</div>`:''}</td>
      <td><span class="badge ${i.retornable?'b-green':'b-gray'}">${escStk(i.categoria)}${i.retornable?'':' · consumible'}</span></td>
      <td class="mono" style="font-size:12px">${escStk(i.codigo||'—')}</td>
      <td class="sub" style="font-size:12px">${escStk(i.ubicacion||'—')}</td>
      <td class="mono" style="text-align:right">${i.cantidad} ${escStk(i.unidad||'u')}</td>
      <td class="mono" style="text-align:right;color:${Number(i.afuera)?'var(--diesel)':'inherit'}">${i.afuera||0}</td>
      <td class="mono" style="text-align:right;font-weight:600;color:${disp<=0?'var(--rojo)':bajo?'var(--diesel)':'inherit'}">${disp}</td>
      <td><div style="display:flex;gap:4px">
        <button class="mini-btn" onclick="pnlEditar('${i.id}')" title="modificar">✏️</button>
        <button class="mini-btn" style="color:var(--rojo)" onclick="pnlBorrar('${i.id}')" title="eliminar">🗑</button>
      </div></td></tr>`;}).join('');
}
/* Repinta SOLO el tbody: si re-renderizara la vista entera, el input pierde
   el foco y no se puede escribir de corrido. */
function pintarPanol(){
  const tb=document.getElementById('pnl-body');
  if(!tb||!pnlData)return;
  const vis=pnlFiltrar(pnlData.items||[]);
  tb.innerHTML=pnlFilas(vis);
  const c=document.getElementById('pnl-cuenta');
  if(c){
    const tot=(pnlData.items||[]).length;
    const un=vis.reduce((a,i)=>a+(Number(i.cantidad)||0),0);
    c.textContent=vis.length===tot
      ? `${tot} ítems · ${un} unidades`
      : `${vis.length} de ${tot} ítems · ${un} unidades`;
  }
}

/* ── Qué comprar · el 80/20 del pañol ─────────────────────────
   José: "hay niveles de cuándo comprar en bolsas, tanzas, carreteles,
   tapas — eso el 80% es de ahí, el otro 20% es general". El ABC lo
   calcula con los movimientos reales: A = las que acumulan el primer
   80% del consumo. Sobre esas tiene sentido poner punto de pedido. */
let pnlRepo=null, pnlRepoClase='';
async function cargarReposicion(){
  const cont=document.getElementById('pnl-repo');
  if(!cont)return;
  if(!pnlRepo){
    try{pnlRepo=await api('/api/panol/reposicion');}
    catch(e){cont.innerHTML=`<div class="cargando-v">${escStk(e.message||'No pude calcular')}</div>`;return;}
  }
  pintarReposicion();
}
function pintarReposicion(){
  const cont=document.getElementById('pnl-repo');
  if(!cont||!pnlRepo)return;
  const R=pnlRepo.resumen||{};
  const todas=pnlRepo.filas||[];
  const comprar=todas.filter(f=>f.hay_que_comprar);
  const vis=(pnlRepoClase?todas.filter(f=>f.clase===pnlRepoClase):todas)
    .slice().sort((a,b)=>Number(b.consumo_90d)-Number(a.consumo_90d));
  const num=v=>v==null?'—':(Math.round(Number(v)*100)/100);
  const badgeClase=c=>c==='A'?'<span class="badge" style="background:var(--rojo-soft);color:var(--rojo)">A · alta rotación</span>'
    :c==='B'?'<span class="badge b-amber">B</span>'
    :c==='C'?'<span class="badge b-gray">C</span>'
    :'<span class="badge b-gray" style="opacity:.6">sin movimiento</span>';

  // Gráficos: el Pareto muestra de un vistazo que unas pocas cosas se llevan
  // casi todo el consumo, y las barras de nivel dónde está cada una respecto
  // de su punto de compra.
  const topCons=todas.filter(f=>Number(f.consumo_90d)>0)
    .sort((a,b)=>Number(b.consumo_90d)-Number(a.consumo_90d)).slice(0,10);
  const criticos=todas.filter(f=>{
    const pp=f.punto_pedido!=null?Number(f.punto_pedido):(Number(f.minimo)>0?Number(f.minimo):null);
    return pp!=null&&Number(f.disponible)<=pp*2;   // ya llegó, o está por llegar
  }).sort((a,b)=>{
    const pa=a.punto_pedido!=null?Number(a.punto_pedido):Number(a.minimo)||1;
    const pb=b.punto_pedido!=null?Number(b.punto_pedido):Number(b.minimo)||1;
    return (Number(a.disponible)/pa)-(Number(b.disponible)/pb);
  }).slice(0,12);

  cont.innerHTML=`
  <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:14px">
    <div class="kpi"><div class="kpi-label">Hay que comprar</div><div class="kpi-val" style="color:${comprar.length?'var(--rojo)':'inherit'}">${comprar.length}</div><div class="kpi-sub">llegaron al punto de pedido</div></div>
    <div class="kpi"><div class="kpi-label">Clase A</div><div class="kpi-val">${R.A||0}</div><div class="kpi-sub">son el 80% del consumo</div></div>
    <div class="kpi"><div class="kpi-label">Clase B y C</div><div class="kpi-val">${(R.B||0)+(R.C||0)}</div><div class="kpi-sub">el 20% restante</div></div>
    <div class="kpi"><div class="kpi-label">Sin movimiento</div><div class="kpi-val">${R.sin_movimiento||0}</div><div class="kpi-sub">no salieron en 90 días</div></div>
  </div>

  ${comprar.length?`<div class="panel" style="border-left:3px solid var(--rojo);margin-bottom:14px">
    <div class="panel-title" style="color:var(--rojo);display:flex;justify-content:space-between;align-items:center">
      <span>🛒 Lista de compra</span>
      <button class="btn-salir" style="padding:5px 10px;font-size:11.5px" onclick="copiarListaCompra()">📋 Copiar</button></div>
    <table><thead><tr><th>Ítem</th><th>Clase</th><th style="text-align:right">Disponible</th><th style="text-align:right">Punto de pedido</th><th style="text-align:right">Pedir</th><th style="text-align:right">Alcanza</th></tr></thead>
    <tbody>${comprar.map(f=>`<tr>
      <td><b>${escStk(f.nombre)}</b>${f.marca?`<div class="sub" style="font-size:11.5px">${escStk(f.marca)}</div>`:''}</td>
      <td>${badgeClase(f.clase)}</td>
      <td class="mono" style="text-align:right;color:var(--rojo);font-weight:600">${num(f.disponible)} ${escStk(f.unidad||'u')}</td>
      <td class="mono" style="text-align:right">${f.punto_pedido!=null?num(f.punto_pedido):`<span class="sub">mín ${num(f.minimo)}</span>`}</td>
      <td class="mono" style="text-align:right">${f.cantidad_compra!=null?num(f.cantidad_compra):'<span class="sub">—</span>'}</td>
      <td class="mono" style="text-align:right">${f.cobertura_dias!=null?f.cobertura_dias+' d':'—'}</td></tr>`).join('')}</tbody></table>
  </div>`:'<div class="panel" style="margin-bottom:14px"><div class="sub">Nada llegó al punto de pedido. Todo con stock.</div></div>'}

  ${criticos.length?`<div class="panel" style="margin-bottom:14px">
    <div class="panel-title">Nivel de stock · qué tan cerca está de tener que comprarse</div>
    <div class="sub" style="font-size:12px;margin-bottom:12px">
      La línea punteada es el punto de pedido. Lo que la cruza hacia la izquierda hay que comprarlo.</div>
    ${svgNivel(criticos)}
  </div>`:''}

  ${topCons.length>1?`<div class="panel" style="margin-bottom:14px">
    <div class="panel-title">Dónde se va el consumo · últimos 90 días</div>
    <div class="sub" style="font-size:12px;margin-bottom:12px">
      Las barras son lo que salió de cada ítem; la línea es el acumulado. Donde la línea llega al 80% termina la clase A.</div>
    ${svgPareto(topCons,pnlRepo.total_consumo)}
  </div>`:''}

  <div class="panel">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:10px;flex-wrap:wrap">
      <div class="panel-title" style="margin:0">Consumo de los últimos 90 días</div>
      <select onchange="pnlRepoClase=this.value;pintarReposicion()" style="padding:6px 10px;border:1px solid var(--linea);border-radius:8px;font-size:12.5px">
        <option value="">Todas (${todas.length})</option>
        <option value="A" ${pnlRepoClase==='A'?'selected':''}>Solo clase A (${R.A||0})</option>
        <option value="B" ${pnlRepoClase==='B'?'selected':''}>Solo clase B (${R.B||0})</option>
        <option value="C" ${pnlRepoClase==='C'?'selected':''}>Solo clase C (${R.C||0})</option>
        <option value="sin movimiento" ${pnlRepoClase==='sin movimiento'?'selected':''}>Sin movimiento (${R.sin_movimiento||0})</option>
      </select>
    </div>
    <div class="sub" style="font-size:12px;margin-bottom:10px">
      La clase la calcula el sistema con las salidas reales: <b>A</b> son las que acumulan el primer 80% del consumo — ahí conviene tener punto de pedido. El resto se mira de vez en cuando.
    </div>
    <table><thead><tr><th>Ítem</th><th>Clase</th><th style="text-align:right">Salió 90d</th><th style="text-align:right">Por mes</th>
      <th style="text-align:right">Disponible</th><th style="text-align:right">Alcanza</th><th style="text-align:right">Punto de pedido</th><th></th></tr></thead>
    <tbody>${vis.map(f=>{
      const cob=f.cobertura_dias;
      return `<tr${f.hay_que_comprar?' style="background:var(--rojo-soft)"':''}>
      <td><b>${escStk(f.nombre)}</b></td>
      <td>${badgeClase(f.clase)}</td>
      <td class="mono" style="text-align:right">${num(f.consumo_90d)}</td>
      <td class="mono" style="text-align:right">${num(f.consumo_mes)}</td>
      <td class="mono" style="text-align:right">${num(f.disponible)} ${escStk(f.unidad||'u')}</td>
      <td class="mono" style="text-align:right;color:${cob!=null&&cob<15?'var(--rojo)':cob!=null&&cob<30?'var(--diesel)':'inherit'}">${cob!=null?cob+' d':'—'}</td>
      <td class="mono" style="text-align:right">${f.punto_pedido!=null?num(f.punto_pedido)
        :f.sugerido?`<span class="sub" title="sugerido según el consumo">~${f.sugerido}</span>`:'<span class="sub">—</span>'}</td>
      <td><button class="mini-btn" onclick="pnlNivel('${f.id}')" title="definir cuándo comprar">⚙</button></td></tr>`;}).join('')
      ||'<tr><td colspan="8" class="sub" style="padding:18px">Nada con ese filtro.</td></tr>'}
    </tbody></table>
  </div>`;
}
function copiarListaCompra(){
  const comprar=(pnlRepo&&pnlRepo.filas||[]).filter(f=>f.hay_que_comprar);
  const txt='LISTA DE COMPRA · PAÑOL\n'+new Date().toLocaleDateString('es-AR')+'\n\n'+
    comprar.map(f=>`• ${f.nombre}: pedir ${f.cantidad_compra!=null?f.cantidad_compra:(f.sugerido||'?')} ${f.unidad||'u'} (quedan ${f.disponible})`).join('\n');
  navigator.clipboard.writeText(txt).then(()=>toast('Lista copiada'),()=>alert(txt));
}
/* Definir el punto de pedido de un ítem. Se propone el consumo de un mes
   y medio, pero lo decide el usuario: el sistema no sabe cuánto tarda el
   proveedor. */
function pnlNivel(id){
  const f=(pnlRepo&&pnlRepo.filas||[]).find(x=>x.id===id);
  if(!f)return;
  const inp='width:100%;padding:8px 10px;border:1px solid var(--linea);border-radius:8px;font-family:inherit;font-size:13.5px;box-sizing:border-box';
  document.getElementById('mm-titulo').textContent='Cuándo comprar · '+f.nombre;
  document.getElementById('mm-campos').innerHTML=`
    <div class="sub" style="margin-bottom:12px">
      Sale <b>${Math.round(Number(f.consumo_mes)*100)/100} ${escStk(f.unidad||'u')}</b> por mes en promedio (últimos 90 días).
      ${f.cobertura_dias!=null?`Con lo que hay alcanza para <b>${f.cobertura_dias} días</b>.`:''}
    </div>
    <div class="mm-field"><label>Comprar cuando el disponible llegue a</label>
      <input id="pl-pp" type="number" step="0.01" value="${f.punto_pedido!=null?f.punto_pedido:(f.sugerido||'')}" placeholder="${f.sugerido||''}" style="${inp}">
      ${f.sugerido?`<div class="sub" style="font-size:11.5px;margin-top:4px">Sugerido ${f.sugerido} — un mes y medio de consumo. Subilo si el proveedor tarda.</div>`:''}
    </div>
    <div class="mm-field"><label>Cuánto pedir cada vez</label>
      <input id="pl-cc" type="number" step="0.01" value="${f.cantidad_compra!=null?f.cantidad_compra:''}" style="${inp}"></div>
    <div class="mm-field"><label>Proveedor habitual</label>
      <input id="pl-prov" value="${escStk(f.proveedor||'')}" style="${inp}"></div>
    <div class="modal-acciones">
      <button class="btn-salir" onclick="cerrarMaestro()">Cancelar</button>
      <button class="btn" onclick="pnlGuardarNivel('${f.id}')">Guardar</button>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
}
async function pnlGuardarNivel(id){
  const g=x=>document.getElementById(x);
  const f=(pnlRepo&&pnlRepo.filas||[]).find(x=>x.id===id);
  if(!f)return;
  const v=x=>{const e=g(x);return e&&e.value!==''?Number(e.value):null;};
  try{
    await api('/api/panol/items',{method:'POST',body:JSON.stringify({
      id, nombre:f.nombre, categoria:f.categoria, retornable:f.retornable,
      cantidad:f.cantidad, unidad:f.unidad,
      punto_pedido:v('pl-pp'), cantidad_compra:v('pl-cc'),
      proveedor:g('pl-prov')?g('pl-prov').value.trim():null})});
    cerrarMaestro();pnlRepo=null;pnlData=null;go('stock');
  }catch(e){alert('No pude guardar: '+(e.message||''));}
}

function pnlNuevo(){pnlAbrirModal({categoria:'herramienta',retornable:true,cantidad:1,unidad:'u',minimo:0});}
function pnlEditar(id){
  const it=(pnlData.items||[]).find(x=>x.id===id);
  if(it)pnlAbrirModal(it);
}
let pnlEdit=null;
function pnlAbrirModal(it){
  pnlEdit={...it};
  const inp='width:100%;padding:8px 10px;border:1px solid var(--linea);border-radius:8px;font-family:inherit;font-size:13.5px;box-sizing:border-box';
  document.getElementById('mm-titulo').textContent=it.id?'Editar ítem del pañol':'Nuevo ítem del pañol';
  document.getElementById('mm-campos').innerHTML=`
    <div class="mm-field"><label>Nombre *</label><input id="pl-nom" value="${escStk(it.nombre||'')}" placeholder="Amoladora, tanza, guantes…" style="${inp}"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="mm-field"><label>Categoría</label><select id="pl-cat" style="${inp}" onchange="pnlCatCambio()">
        ${['herramienta','insumo','repuesto','otro'].map(c=>`<option value="${c}" ${it.categoria===c?'selected':''}>${c}</option>`).join('')}
      </select></div>
      <div class="mm-field"><label>Código / N° interno</label><input id="pl-cod" value="${escStk(it.codigo||'')}" style="${inp}"></div>
    </div>
    <div class="mm-field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
      <input type="checkbox" id="pl-ret" ${it.retornable!==false?'checked':''} style="width:auto">
      <span>Vuelve al pañol <span style="font-weight:400;color:var(--tinta-3)">— destildá para lo que se consume (aceite, tanza, guantes)</span></span>
    </label></div>
    <div style="display:grid;grid-template-columns:1fr 90px 1fr;gap:8px">
      <div class="mm-field"><label>Cantidad</label><input id="pl-cant" type="number" step="0.01" value="${it.cantidad!=null?it.cantidad:1}" style="${inp}"></div>
      <div class="mm-field"><label>Unidad</label><input id="pl-uni" value="${escStk(it.unidad||'u')}" style="${inp}"></div>
      <div class="mm-field"><label>Avisar bajo</label><input id="pl-min" type="number" step="0.01" value="${it.minimo||0}" style="${inp}"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="mm-field"><label>Marca</label><input id="pl-marca" value="${escStk(it.marca||'')}" style="${inp}"></div>
      <div class="mm-field"><label>Ubicación</label><input id="pl-ubi" value="${escStk(it.ubicacion||'')}" placeholder="Estante 3, cajón A…" style="${inp}"></div>
    </div>
    <div class="mm-field"><label>Notas ${String(it.notas||'').startsWith('REVISAR')?'<span style="font-weight:400;color:var(--diesel)">— borrá el texto cuando lo confirmes</span>':''}</label><input id="pl-notas" value="${escStk(it.notas||'')}" style="${inp}"></div>
    ${it.id?`<div class="mm-field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
      <input type="checkbox" id="pl-activo" ${it.activo!==false?'checked':''} style="width:auto"><span>Activo</span></label></div>`:''}
    <div class="modal-acciones">
      <button class="btn-salir" onclick="cerrarMaestro();pnlEdit=null">Cancelar</button>
      <button class="btn" onclick="pnlGuardar()">Guardar</button>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
  pnlCatCambio();
}
/* Un insumo se consume: por defecto no vuelve. Igual se puede forzar. */
function pnlCatCambio(){
  const c=document.getElementById('pl-cat'),r=document.getElementById('pl-ret');
  if(!c||!r||!pnlEdit||pnlEdit.id)return;   // al editar respetamos lo guardado
  r.checked=c.value!=='insumo';
}
async function pnlGuardar(){
  const g=id=>document.getElementById(id);
  const body={id:pnlEdit&&pnlEdit.id,
    nombre:g('pl-nom').value.trim(),categoria:g('pl-cat').value,
    retornable:g('pl-ret').checked,codigo:g('pl-cod').value.trim(),
    cantidad:Number(g('pl-cant').value)||0,unidad:g('pl-uni').value.trim()||'u',
    minimo:Number(g('pl-min').value)||0,marca:g('pl-marca').value.trim(),
    ubicacion:g('pl-ubi').value.trim(),notas:g('pl-notas').value.trim()};
  if(g('pl-activo'))body.activo=g('pl-activo').checked;
  if(!body.nombre)return alert('Poné el nombre del ítem.');
  try{
    await api('/api/panol/items',{method:'POST',body:JSON.stringify(body)});
    cerrarMaestro();pnlEdit=null;pnlData=null;go('stock');
  }catch(e){alert('No pude guardar: '+(e.message||''));}
}
async function pnlBorrar(id){
  const it=(pnlData.items||[]).find(x=>x.id===id);
  if(!it)return;
  if(!confirm(`¿Eliminar "${it.nombre}" del pañol?\n\nSi ya tuvo salidas se archiva en vez de borrarse, para no perder el historial.`))return;
  try{
    const r=await api('/api/panol/items/'+id,{method:'DELETE'});
    pnlData=null;go('stock');
    toast(r.archivado?`Archivado (tenía ${r.movimientos} movimiento${r.movimientos===1?'':'s'})`:'Eliminado');
  }catch(e){alert(e.message||'No pude eliminarlo');}
}

async function pnlDevolver(movId){
  if(!confirm('¿Registrar que volvió al pañol?'))return;
  try{
    await api('/api/panol/movimientos/'+movId+'/devolver',{method:'POST',body:JSON.stringify({recibio:'panel'})});
    pnlData=null;go('stock');
  }catch(e){alert('No pude registrarlo: '+(e.message||''));}
}

/* ── Edición del stock desde el panel ─────────────────────────
   Administración corrige el censo de un objetivo: cambiar cantidades y
   números, sacar una máquina (baja real) o sumar una (alta que el capataz
   no informó). Pisa los ítems del ÚLTIMO censo respondido — el mismo
   listado que precarga el bot y el que muestra el General. */
let stkEdit=null;   // { objetivo, censo_id, items:[{tipo,cantidad,numeros,observacion}] }
function editarStockObjetivo(objetivoId){
  const filas=(stkGen&&stkGen.filas||[]).filter(f=>f.objetivo_id===objetivoId);
  if(!filas.length)return alert('No encontré ese objetivo.');
  // Un objetivo sin censo (recién creado, o que nunca respondió) arranca
  // con un renglón vacío: es el alta del stock desde el panel.
  const sinCenso=!filas[0].censo_id;
  stkEdit={
    objetivo:filas[0].objetivo, objetivo_id:objetivoId,
    censo_id:filas[0].censo_id||null, nuevo:sinCenso,
    items:sinCenso?[{tipo:'',cantidad:1,numeros:[],observacion:''}]
      :filas.map(f=>({tipo:f.tipo,cantidad:f.cantidad,numeros:(f.numeros||[]).slice(),observacion:f.observacion||''})),
  };
  pintarEditorStock();
}
function pintarEditorStock(){
  const e=stkEdit;if(!e)return;
  document.getElementById('mm-titulo').textContent=(e.nuevo?'Cargar stock · ':'Editar stock · ')+e.objetivo;
  document.getElementById('mm-campos').innerHTML=`
    <div class="sub" style="margin-bottom:10px">${e.nuevo
      ?'Este objetivo todavía no informó stock. Lo que cargues acá queda como su censo del mes y es lo que el capataz va a ver precargado en el bot.'
      :'Esto pisa el último censo del objetivo: es lo que va a ver el capataz precargado en el bot y lo que muestra el General.'} Los números van separados por coma.</div>
    <div style="max-height:52vh;overflow-y:auto;margin:0 -4px;padding:0 4px">
    ${e.items.map((i,ix)=>`
      <div style="border:1px solid var(--linea);border-radius:9px;padding:8px 9px;margin-bottom:7px;background:var(--hueso)">
        <div style="display:grid;grid-template-columns:1fr 70px 30px;gap:6px;align-items:center;margin-bottom:5px">
          <input value="${(i.tipo||'').replace(/"/g,'&quot;')}" placeholder="Tipo de equipo" onchange="stkEdit.items[${ix}].tipo=this.value" style="min-width:0">
          <input type="number" min="1" value="${i.cantidad}" title="cantidad" onchange="stkEdit.items[${ix}].cantidad=this.value" style="min-width:0">
          <button class="btn-salir" style="padding:5px 0;color:var(--rojo)" title="sacar este equipo" onclick="stkEdit.items.splice(${ix},1);pintarEditorStock()">✕</button>
        </div>
        <input value="${(i.numeros||[]).join(', ').replace(/"/g,'&quot;')}" placeholder="N° de máquina separados por coma" onchange="stkEdit.items[${ix}].numeros=this.value.split(',').map(x=>x.trim()).filter(Boolean)" style="width:100%;margin-bottom:5px">
        <input value="${(i.observacion||'').replace(/"/g,'&quot;')}" placeholder="Observación (marca, detalle…)" onchange="stkEdit.items[${ix}].observacion=this.value" style="width:100%">
      </div>`).join('')}
    </div>
    <button class="btn-salir" style="padding:5px 10px;font-size:12px" onclick="stkEdit.items.push({tipo:'',cantidad:1,numeros:[],observacion:''});pintarEditorStock()">＋ Agregar equipo</button>
    <div class="modal-acciones">
      <button class="btn-salir" onclick="cerrarMaestro();stkEdit=null">Cancelar</button>
      <button class="btn" onclick="guardarStockEditado()">Guardar</button>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
}
async function guardarStockEditado(){
  const e=stkEdit;if(!e)return;
  const items=e.items.map(i=>({tipo:String(i.tipo||'').trim(),cantidad:Number(i.cantidad)||0,
    numeros:i.numeros||[],observacion:String(i.observacion||'').trim()||null}))
    .filter(i=>i.tipo&&i.cantidad>0);
  if(!items.length)return alert('Dejá al menos un equipo con tipo y cantidad.');
  // Aviso si los números no cuadran con la cantidad (se puede guardar igual:
  // hay equipos sin numerar, pero conviene verlo antes de confirmar)
  const raros=items.filter(i=>i.numeros.length>i.cantidad);
  if(raros.length&&!confirm(`Ojo: ${raros.map(i=>i.tipo).join(', ')} tiene más números que cantidad. ¿Guardar igual?`))return;
  try{
    if(e.censo_id){
      await api('/api/stock/censos/'+e.censo_id+'/items',{method:'PUT',body:JSON.stringify({items})});
    }else{
      // Sin censo previo: se crea el del período con estos ítems
      await api('/api/stock/censos',{method:'POST',body:JSON.stringify({objetivo_id:e.objetivo_id,items})});
    }
    cerrarMaestro();stkEdit=null;stkGen=null;go('stock');
    toast(e.nuevo?'Stock cargado':'Stock actualizado');
  }catch(err){alert('No pude guardar: '+(err.message||''));}
}

async function resolverFaltante(id){
  const nota=prompt('¿Cómo se resolvió? (apareció / se trasladó a X / se dio de baja…)');
  if(nota===null)return;
  try{
    await api('/api/stock/faltantes/'+id+'/resolver',{method:'POST',body:JSON.stringify({nota})});
    stkGen=null;go('stock');
  }catch(e){alert('No pude marcarlo: '+e.message);}
}

/* Planilla de control físico: UNA HOJA por objetivo, para imprimir y
   recorrer el depósito tildando máquina por máquina. Lo que no cierra se
   anota a mano y después se carga en el sistema. */
function imprimirPlanillaStock(objetivoId){
  const filas=(stkGen&&stkGen.filas||[]).filter(f=>f.objetivo_id===objetivoId);
  if(!filas.length)return alert('Ese objetivo no tiene censo cargado.');
  const obj=filas[0];
  const norm=t=>String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const marcaDe={};
  (window._maqPadron||[]).forEach(m=>{if(m.codigo_interno)marcaDe[norm(m.codigo_interno)]=[m.marca,m.modelo].filter(Boolean).join(' ');});
  const esc=t=>String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const hoy=new Date().toLocaleDateString('es-AR');
  let renglones='';
  filas.forEach(f=>{
    if(f.numeros&&f.numeros.length){
      f.numeros.forEach(n=>{renglones+=`<tr><td class="cas"><span class="c"></span></td><td>${esc(f.tipo)}</td><td class="mono">${esc(n)}</td><td class="sub">${esc(marcaDe[norm(n)]||f.observacion||'')}</td><td class="raya"></td></tr>`;});
      const sinNum=(Number(f.cantidad)||0)-f.numeros.length;
      for(let i=0;i<sinNum;i++)renglones+=`<tr><td class="cas"><span class="c"></span></td><td>${esc(f.tipo)}</td><td class="mono">S/N</td><td class="sub">${esc(f.observacion||'')}</td><td class="raya"></td></tr>`;
    }else{
      for(let i=0;i<(Number(f.cantidad)||0);i++)renglones+=`<tr><td class="cas"><span class="c"></span></td><td>${esc(f.tipo)}</td><td class="mono">S/N</td><td class="sub">${esc(f.observacion||'')}</td><td class="raya"></td></tr>`;
    }
  });
  const html=`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Control físico · ${esc(obj.objetivo)}</title><style>
    body{font-family:system-ui,sans-serif;color:#16221C;margin:24px;font-size:12px}
    h1{font-size:17px;margin:0;border-bottom:2px solid #16221C;padding-bottom:6px}
    .meta{display:flex;gap:18px;padding:8px 0 12px;font-size:11px;color:#4A5A51}
    table{width:100%;border-collapse:collapse}
    th{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:#8A968E;text-align:left;padding:4px 6px;border-bottom:1px solid #E6EBE4}
    td{padding:5px 6px;border-bottom:1px solid #F0F3EE}
    .mono{font-family:ui-monospace,monospace}
    .sub{color:#4A5A51;font-size:11px}
    .cas{width:22px}.c{display:inline-block;width:13px;height:13px;border:1.5px solid #4A5A51;border-radius:3px}
    .raya{width:130px;border-bottom:1px dotted #B8C2BA!important}
    .extra{margin-top:12px;font-size:11px;color:#4A5A51}
    .pie{display:flex;justify-content:space-between;margin-top:28px;font-size:11px;color:#4A5A51}
    .firma{border-top:1px solid #4A5A51;padding-top:3px;min-width:160px;text-align:center}
    @media print{body{margin:10mm}}
  </style></head><body>
    <h1>Control físico de maquinaria</h1>
    <div class="meta"><span><b>Objetivo:</b> ${esc(obj.objetivo)}</span><span><b>Grupo:</b> depósito · control quincenal</span><span><b>Según sistema al:</b> ${hoy} (censo de ${esc(obj.periodo)})</span></div>
    <table><thead><tr><th></th><th>Tipo</th><th>N°</th><th>Marca / observación</th><th>No está → ¿dónde?</th></tr></thead><tbody>${renglones}</tbody></table>
    <div class="extra">Máquinas encontradas que NO figuran arriba: _______________________________________________________________</div>
    <div class="pie"><span class="firma">Controló</span><span class="firma">Capataz</span><span>Fecha: ____ / ____ / ______</span></div>
    <script>window.print()<\/script></body></html>`;
  const w=window.open('','_blank');
  if(!w)return alert('El navegador bloqueó la ventana. Permití pop-ups para imprimir.');
  w.document.write(html);w.document.close();
}

/* ── Control: padrón contra censo ─────────────────────────────
   La pregunta que ninguna de las vistas viejas contestaba: de las máquinas
   que figuran en un objetivo, ¿cuáles informó el capataz y cuáles no?
   El cruce es por NÚMERO, no por cantidad — así aparece la máquina puntual
   que falta, no un total que no cierra. */
function ctrlCruce(maquinas,censos){
  const norm=v=>String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  const porObj={};
  const nombreObj=id=>{const o=((maqData&&maqData.objetivos)||[]).find(x=>x.id===id);return o?o.nombre:null;};
  const slot=(id,nombre)=>{
    const k=id||('txt:'+norm(nombre));
    return porObj[k]||(porObj[k]={id,nombre:nombre||'— sin objetivo —',padron:[],censadas:new Set(),
      censoTotal:0,respondio:false,capataz:null,tiposCenso:{}});
  };
  // Padrón: solo activas — una máquina de baja no tiene por qué estar en el objetivo.
  (maquinas||[]).filter(m=>m.estado==='activa').forEach(m=>{
    slot(m.objetivo_id,nombreObj(m.objetivo_id)||m.objetivo_texto).padron.push(m);
  });
  (censos||[]).forEach(c=>{
    if(c.estado!=='respondido')return;
    const sl=slot(c.objetivo_id,c.objetivos?c.objetivos.nombre:null);
    sl.respondio=true;sl.capataz=c.capataces?c.capataces.nombre:null;
    (c.censos_stock_items||[]).forEach(i=>{
      sl.censoTotal+=Number(i.cantidad)||0;
      sl.tiposCenso[i.tipo_equipo]=(sl.tiposCenso[i.tipo_equipo]||0)+(Number(i.cantidad)||0);
      (i.numeros||[]).forEach(n=>{const nn=norm(n);if(nn&&nn!=='sn')sl.censadas.add(nn);});
    });
  });
  return Object.values(porObj).map(o=>{
    const faltan=o.padron.filter(m=>!o.censadas.has(m.codigo_norm));
    const codigosPadron=new Set(o.padron.map(m=>m.codigo_norm));
    const sobran=[...o.censadas].filter(n=>!codigosPadron.has(n));
    return Object.assign(o,{faltan,sobran,dif:o.censoTotal-o.padron.length});
  }).sort((a,b)=>b.padron.length-a.padron.length||String(a.nombre).localeCompare(String(b.nombre)));
}

async function vStockControl(view){
  try{
    const qs=stockPeriodo?'?periodo='+encodeURIComponent(stockPeriodo):'';
    const [d,mq]=await Promise.all([api('/api/stock'+qs),api('/api/maquinas')]);
    stockData=d;maqData=mq;
    const filas=ctrlCruce(mq.maquinas||[],d.censos||[]);
    const conPadron=filas.filter(f=>f.padron.length);
    const totalPadron=conPadron.reduce((a,f)=>a+f.padron.length,0);
    const totalFaltan=conPadron.reduce((a,f)=>a+(f.respondio?f.faltan.length:0),0);
    const sinResponder=filas.filter(f=>!f.respondio&&f.padron.length).length;
    const selPer=`<select class="busca" style="width:auto" onchange="stockPeriodo=this.value;go('stock')">
      ${d.periodos.map(p=>`<option value="${p}" ${p===d.periodo?'selected':''}>${mesStk(p)}</option>`).join('')}</select>`;

    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Stock de maquinaria</div>
      <div class="view-desc">Control · lo que figura en el padrón contra lo que informó cada capataz</div></div>
      <div>${selPer}</div></div>
    ${tabsStk()}
    ${!totalPadron?`<div class="aviso-amarillo" style="margin-bottom:14px">Todavía no hay máquinas con objetivo asignado en el padrón, así que no hay con qué comparar. Cargalas en <b>Máquinas</b> y volvé acá.</div>`:''}
    <div class="kpis" style="margin-bottom:14px">
      <div class="kpi"><div class="kpi-label">Máquinas en el padrón</div><div class="kpi-val">${totalPadron}</div>
        <div class="kpi-sub">activas y con objetivo</div></div>
      <div class="kpi"><div class="kpi-label">No informadas</div><div class="kpi-val" style="color:${totalFaltan?'var(--rojo)':'var(--brote-2)'}">${totalFaltan}</div>
        <div class="kpi-sub">están en el padrón y el capataz no las listó</div></div>
      <div class="kpi"><div class="kpi-label">Objetivos sin responder</div><div class="kpi-val">${sinResponder}</div>
        <div class="kpi-sub">con máquinas asignadas</div></div>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>Objetivo</th><th class="num">Padrón</th><th class="num">Censó</th><th class="num">Dif</th><th>No informadas</th><th>Informó de más</th></tr></thead>
      <tbody>${filas.length?filas.map(f=>`<tr>
        <td style="font-weight:500">${escStk(f.nombre)}${f.capataz?`<div class="sub" style="font-size:11px">${escStk(f.capataz)}</div>`:''}</td>
        <td class="num mono">${f.padron.length||'—'}</td>
        <td class="num mono">${f.respondio?f.censoTotal:'<span class="sub">sin responder</span>'}</td>
        <td class="num">${f.respondio&&f.padron.length?difStk(f.dif):'<span class="sub">—</span>'}</td>
        <td>${f.respondio&&f.faltan.length?`<div style="display:flex;gap:3px;flex-wrap:wrap">${f.faltan.map(m=>`<span class="uni-chip" style="background:var(--rojo-soft);color:var(--rojo);cursor:pointer" onclick="fichaMaquina('${m.id}')" title="${escStk(m.maquina||'')} · ver ficha">${escStk(m.codigo_interno)}</span>`).join('')}</div>`
          :f.respondio?'<span class="sub">todas informadas</span>':'<span class="sub">—</span>'}</td>
        <td>${f.sobran.length?`<div style="display:flex;gap:3px;flex-wrap:wrap">${f.sobran.map(n=>`<span class="uni-chip" style="background:var(--diesel-soft);color:var(--diesel)" title="El capataz la informó pero no está en el padrón">${escStk(n)}</span>`).join('')}</div>`:'<span class="sub">—</span>'}</td>
      </tr>`).join(''):'<tr><td colspan="6"><div class="sub" style="padding:14px">Sin datos para este período.</div></td></tr>'}
      </tbody></table></div>
    <div class="panel" style="margin-top:14px">
      <div class="panel-title" style="margin-bottom:4px">Vistas anteriores</div>
      <div class="sub" style="font-size:12px;margin-bottom:10px">Siguen disponibles mientras se termina de cargar el padrón.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${Object.entries(STOCK_SUB).map(([k,t])=>`<button class="btn-salir" onclick="stockTab='${k}';go('stock')">${t}</button>`).join('')}
      </div>
    </div>`;
  }catch(e){view.innerHTML=tabsStk()+`<div class="cargando-v">${e.message||'No pude cargar el control'}</div>`;}
}

/* ── Padrón de máquinas ───────────────────────────────────────
   Una fila por máquina física, con su número interno, cuándo se compró y
   cuánta vida lleva. Es lo que permite responder "cuáles son" y no solo
   "cuántas hay", y engancha cada máquina con sus reparaciones. */
/* La marca se escribe de mil formas: "STIHL", "Sthil", "stihl ", "Husq",
   "Husqvarna". Sin unificarlas, contar por marca no sirve de nada. */
const MARCA_ALIAS={sthil:'Stihl',stihl:'Stihl',still:'Stihl',
  husq:'Husqvarna',husqvarna:'Husqvarna',husqvarnas:'Husqvarna',
  hond:'Honda',honda:'Honda',kawa:'Kawasaki',kawasaki:'Kawasaki',
  echo:'Echo',shindaiwa:'Shindaiwa',tuya:'Toyama',toyama:'Toyama'};
function maqMarca(m){
  const raw=String(m.marca||'').trim();
  if(!raw)return '';
  const k=raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z]/g,'');
  if(MARCA_ALIAS[k])return MARCA_ALIAS[k];
  // Sin alias conocido: se respeta lo escrito pero con mayúscula inicial,
  // así "stihl pro" y "Stihl Pro" no cuentan como dos marcas distintas.
  return raw.charAt(0).toUpperCase()+raw.slice(1).toLowerCase();
}

function maqFilas(){
  const t=(maqFil.busca||'').toLowerCase().split(/\s+/).filter(Boolean);
  return ((maqData&&maqData.maquinas)||[]).filter(m=>{
    if(maqFil.tipo&&m.tipo_equipo!==maqFil.tipo)return false;
    if(maqFil.estado&&m.estado!==maqFil.estado)return false;
    if(maqFil.marca&&maqMarca(m)!==maqFil.marca)return false;
    if(!t.length)return true;
    const txt=[m.codigo_interno,m.maquina,m.marca,m.modelo,m.tipo_equipo,m.objetivo_texto,
      objNombre(m.objetivo_id),m.motivo_baja,m.notas].filter(Boolean).join(' ').toLowerCase();
    return t.every(w=>txt.includes(w));
  });
}
function objNombre(id){
  if(!id)return '';
  const o=((maqData&&maqData.objetivos)||[]).find(x=>x.id===id);
  return o?o.nombre:'';
}
function vidaChip(m){
  if(m.vida_anios==null)return '<span class="sub">sin fecha de compra</span>';
  const v=Number(m.vida_anios);
  const col=m.dada_de_baja?'var(--tinta-2)':v>=2.5?'var(--rojo)':v>=2?'var(--diesel)':'var(--brote-2)';
  return `<span class="mono" style="color:${col};font-weight:600">${v.toFixed(2)} años</span>`;
}

async function vMaquinas(view){
  try{
    maqData=await api('/api/maquinas');
    const todas=maqData.maquinas||[];
    const tipos=[...new Set(todas.map(m=>m.tipo_equipo).filter(Boolean))].sort();
    const filas=maqFilas();
    const activas=todas.filter(m=>m.estado==='activa').length;
    const bajas=todas.filter(m=>m.estado==='baja').length;
    const conBaja=todas.filter(m=>m.dada_de_baja&&m.vida_anios!=null);
    const vidaProm=conBaja.length?(conBaja.reduce((a,m)=>a+Number(m.vida_anios),0)/conBaja.length).toFixed(2):null;

    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Stock de maquinaria</div>
      <div class="view-desc">Padrón · una ficha por máquina, con su vida útil</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn-salir" onclick="importarMaquinas()">📋 Importar planilla</button>
        <button class="btn" onclick="altaMaquina()">+ Nueva máquina</button>
      </div></div>
    ${tabsStk()}
    <div class="kpis" style="margin-bottom:14px">
      <div class="kpi"><div class="kpi-label">Activas</div><div class="kpi-val">${activas}</div>
        <div class="kpi-sub">${todas.length} en el padrón</div></div>
      <div class="kpi"><div class="kpi-label">Dadas de baja</div><div class="kpi-val">${bajas}</div>
        <div class="kpi-sub">${conBaja.length} con fecha cargada</div></div>
      <div class="kpi"><div class="kpi-label">Vida útil promedio</div><div class="kpi-val">${vidaProm||'—'}</div>
        <div class="kpi-sub">${vidaProm?'años, sobre las dadas de baja':'falta cargar bajas para saberlo'}</div></div>
    </div>
    <div class="panel" style="margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <select class="busca" style="width:auto;min-width:170px" onchange="maqFil.tipo=this.value;go('stock')">
        <option value="">Todos los tipos</option>
        ${tipos.map(t=>`<option value="${escStk(t)}" ${t===maqFil.tipo?'selected':''}>${escStk(t)} · ${todas.filter(m=>m.tipo_equipo===t).length}</option>`).join('')}
      </select>
      <select class="busca" style="width:auto;min-width:150px" onchange="maqFil.marca=this.value;go('stock')">
        <option value="">Todas las marcas</option>
        ${(()=>{
          // Las marcas del universo que ya filtró tipo y estado: así el
          // conteo de cada opción es el que uno va a ver al elegirla.
          const univ=todas.filter(m=>(!maqFil.tipo||m.tipo_equipo===maqFil.tipo)&&(!maqFil.estado||m.estado===maqFil.estado));
          const cnt={};univ.forEach(m=>{const k=maqMarca(m);if(k)cnt[k]=(cnt[k]||0)+1;});
          const sinMarca=univ.filter(m=>!maqMarca(m)).length;
          return Object.keys(cnt).sort((a,b)=>cnt[b]-cnt[a])
            .map(k=>`<option value="${escStk(k)}" ${k===maqFil.marca?'selected':''}>${escStk(k)} · ${cnt[k]}</option>`).join('')
            +(sinMarca?`<option disabled>— ${sinMarca} sin marca cargada —</option>`:'');
        })()}
      </select>
      <select class="busca" style="width:auto" onchange="maqFil.estado=this.value;go('stock')">
        <option value="activa" ${maqFil.estado==='activa'?'selected':''}>Activas</option>
        <option value="baja" ${maqFil.estado==='baja'?'selected':''}>Dadas de baja</option>
        <option value="" ${maqFil.estado===''?'selected':''}>Todas</option>
      </select>
      <input class="busca" style="flex:1;min-width:180px" placeholder="Buscar N° interno, modelo, objetivo…"
        value="${escStk(maqFil.busca)}" oninput="maqFil.busca=this.value;pintarMaquinas()">
      <button class="btn-salir" onclick="exportarMaquinas()">⬇ Exportar</button>
      <div class="sub" id="maq-res" style="font-size:12px">${filas.length} máquina${filas.length===1?'':'s'}</div>
    </div>
    ${(()=>{
      /* Cuadro tipo × marca: responde de un vistazo "cuántas motoguadañas
         Stihl tenemos", "cuántas Husqvarna" y "cuántas en total", que hasta
         ahora había que contar a mano. Respeta el filtro de estado. */
      const univ=todas.filter(m=>!maqFil.estado||m.estado===maqFil.estado);
      if(!univ.length)return '';
      const marcas=[...new Set(univ.map(maqMarca).filter(Boolean))];
      const porTipo={};
      univ.forEach(m=>{
        const t=m.tipo_equipo||'Sin tipo', k=maqMarca(m)||'__sin';
        porTipo[t]=porTipo[t]||{__total:0};
        porTipo[t][k]=(porTipo[t][k]||0)+1;porTipo[t].__total++;
      });
      const totMarca=k=>univ.filter(m=>(maqMarca(m)||'__sin')===k).length;
      marcas.sort((a,b)=>totMarca(b)-totMarca(a));
      const cols=marcas.slice(0,6), otras=marcas.slice(6);
      const sinMarca=univ.filter(m=>!maqMarca(m)).length;
      const tipos2=Object.keys(porTipo).sort((a,b)=>porTipo[b].__total-porTipo[a].__total);
      const cel=(t,k)=>{const n=porTipo[t][k]||0;
        return `<td class="num" style="${n?'':'color:var(--tinta-3)'}">${n||'·'}</td>`;};
      return `<div class="tablewrap" style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;flex-wrap:wrap;gap:8px">
          <b style="font-size:13.5px">Cuánto hay de cada cosa</b>
          <span class="sub" style="font-size:11.5px">${maqFil.estado==='activa'?'solo activas':maqFil.estado==='baja'?'solo dadas de baja':'activas y de baja'} · tocá una fila para filtrar por ese tipo</span>
        </div>
        <table><thead><tr><th>Tipo</th>
          ${cols.map(k=>`<th class="num">${escStk(k)}</th>`).join('')}
          ${otras.length?'<th class="num">Otras</th>':''}
          ${sinMarca?'<th class="num">Sin marca</th>':''}
          <th class="num">Total</th></tr></thead>
        <tbody>
          ${tipos2.map(t=>`<tr style="cursor:pointer" onclick="maqFil.tipo='${escStk(t).replace(/'/g,"\\'")}';maqFil.marca='';go('stock')">
            <td style="font-weight:500">${escStk(t)}</td>
            ${cols.map(k=>cel(t,k)).join('')}
            ${otras.length?`<td class="num">${otras.reduce((a,k)=>a+(porTipo[t][k]||0),0)||'·'}</td>`:''}
            ${sinMarca?cel(t,'__sin'):''}
            <td class="num" style="font-weight:700">${porTipo[t].__total}</td></tr>`).join('')}
          <tr style="border-top:2px solid var(--linea)">
            <td style="font-weight:700">Total</td>
            ${cols.map(k=>`<td class="num" style="font-weight:700">${totMarca(k)}</td>`).join('')}
            ${otras.length?`<td class="num" style="font-weight:700">${otras.reduce((a,k)=>a+totMarca(k),0)}</td>`:''}
            ${sinMarca?`<td class="num" style="font-weight:700">${sinMarca}</td>`:''}
            <td class="num" style="font-weight:800">${univ.length}</td></tr>
        </tbody></table>
        ${sinMarca?`<div class="sub" style="font-size:11.5px;margin-top:7px;color:var(--diesel)">⚠ ${sinMarca} máquina${sinMarca===1?'':'s'} sin marca cargada — no entran en ninguna columna de marca.</div>`:''}
      </div>`;
    })()}
    <div class="tablewrap"><table>
      <thead><tr><th>N° int.</th><th>Máquina</th><th>Tipo</th><th>Objetivo</th><th>Compra</th><th>Vida</th><th>Estado</th><th></th></tr></thead>
      <tbody id="maq-body">${maqFilasHTML(filas)}</tbody></table></div>`;
  }catch(e){view.innerHTML=tabsStk()+`<div class="cargando-v">${e.message||'No pude cargar el padrón'}</div>`;}
}

function maqFilasHTML(filas){
  if(!filas.length)return '<tr><td colspan="8"><div class="sub" style="padding:14px">No hay máquinas con este filtro. Si es la primera vez, usá <b>📋 Importar planilla</b>.</div></td></tr>';
  return filas.map(m=>`<tr style="cursor:pointer" onclick="fichaMaquina('${m.id}')">
    <td class="mono" style="font-weight:600">${escStk(m.codigo_interno)}</td>
    <td>${escStk(m.maquina||[m.marca,m.modelo].filter(Boolean).join(' ')||'—')}</td>
    <td class="sub" style="font-size:12px">${escStk(m.tipo_equipo||'—')}</td>
    <td class="sub" style="font-size:12px">${escStk(objNombre(m.objetivo_id)||m.objetivo_texto||'—')}</td>
    <td class="mono" style="font-size:11.5px">${m.fecha_compra?String(m.fecha_compra).split('-').reverse().join('/'):'—'}</td>
    <td>${vidaChip(m)}</td>
    <td>${m.estado==='baja'?`<span class="badge" style="background:var(--rojo-soft);color:var(--rojo)">baja</span>`
      :m.estado==='taller'?`<span class="badge b-amber">taller</span>`
      :`<span class="badge" style="background:var(--brote-soft);color:var(--brote-2)">activa</span>`}
      ${m.motivo_baja?`<div class="sub" style="font-size:10.5px">${escStk(m.motivo_baja)}</div>`:''}</td>
    <td style="text-align:right"><button class="btn-salir" style="padding:2px 8px;font-size:11px" onclick="event.stopPropagation();editarMaquina('${m.id}')">✏️</button></td>
  </tr>`).join('');
}
function pintarMaquinas(){
  const filas=maqFilas();
  const b=document.getElementById('maq-body');if(b)b.innerHTML=maqFilasHTML(filas);
  const r=document.getElementById('maq-res');if(r)r.textContent=`${filas.length} máquina${filas.length===1?'':'s'}`;
}

/* Ficha: la máquina y TODO su historial de taller. Acá se une el padrón con
   Reparaciones, que hasta ahora eran dos mundos separados. */
async function fichaMaquina(id){
  const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=190;
  bg.innerHTML=`<div class="modal" style="max-width:720px"><div id="fm-body"><div class="sub">Cargando…</div></div>
    <div class="modal-acciones"><button class="btn ghost" id="fm-no">Cerrar</button></div></div>`;
  document.body.appendChild(bg);
  const cerrar=()=>bg.remove();
  bg.querySelector('#fm-no').onclick=cerrar;
  bg.addEventListener('click',e=>{if(e.target===bg)cerrar();});
  try{
    const d=await api('/api/maquinas/'+id);
    const m=d.maquina,R=d.resumen;
    const box=bg.querySelector('#fm-body');if(!box)return;
    box.innerHTML=`
      <h3>${escStk(m.codigo_interno)} · ${escStk(m.maquina||m.tipo_equipo||'')}</h3>
      <div class="sub" style="font-size:12.5px;margin-bottom:12px">
        ${escStk(objNombre(m.objetivo_id)||m.objetivo_texto||'sin objetivo')} ·
        comprada ${m.fecha_compra?String(m.fecha_compra).split('-').reverse().join('/'):'sin fecha'} ·
        ${vidaChip(m)}${m.dada_de_baja?` · <b style="color:var(--rojo)">baja: ${escStk(m.motivo_baja||'sin motivo')}</b>`:''}</div>
      <div class="kpis" style="margin-bottom:12px">
        <div class="kpi"><div class="kpi-label">Entradas al taller</div><div class="kpi-val">${R.total}</div></div>
        <div class="kpi"><div class="kpi-label">Horas de taller</div><div class="kpi-val">${R.horas_taller||0}</div></div>
        <div class="kpi"><div class="kpi-label">Repuestos</div><div class="kpi-val">${R.gasto_repuestos?'$'+R.gasto_repuestos.toLocaleString('es-AR'):'—'}</div>
          <div class="kpi-sub">${R.repuestos_con_precio} con precio cargado</div></div>
      </div>
      <div class="field-l" style="margin-bottom:6px">Historial de taller</div>
      ${d.reparaciones.length?`<div style="max-height:280px;overflow:auto">${d.reparaciones.map(r=>`
        <div style="padding:5px 0;border-bottom:1px dotted var(--linea);font-size:12.5px">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <span><b>${escStk(r.tipo_falla||'sin falla')}</b> <span class="sub">${escStk(r.descripcion||'')}</span></span>
            <span class="mono sub" style="white-space:nowrap;font-size:11px">${String(r.created_at).slice(0,10).split('-').reverse().join('/')}</span></div>
          <div class="sub" style="font-size:11px">${escStk(r.mecanicos?r.mecanicos.nombre:'sin asignar')} · ${escStk(r.estado)}${r.puntos_ia_horas!=null?' · '+r.puntos_ia_horas+' h':''}</div>
        </div>`).join('')}</div>`
      :'<div class="sub" style="padding:6px 0">Sin reparaciones registradas con este número interno. Si tuvo, puede ser que en el taller la cargaran con otro número.</div>'}`;
  }catch(e){const box=bg.querySelector('#fm-body');if(box)box.innerHTML=`<div class="sub">${e.message||'No pude cargar la ficha'}</div>`;}
}

function maqCampos(m){
  const objs=(maqData&&maqData.objetivos)||[];
  const v=k=>m&&m[k]!=null?String(m[k]).replace(/"/g,'&quot;'):'';
  return `
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <label style="flex:1;min-width:120px"><span class="field-l">N° interno *</span>
        <input class="busca" id="mq-cod" value="${v('codigo_interno')}" placeholder="h13"></label>
      <label style="flex:2;min-width:160px"><span class="field-l">Máquina</span>
        <input class="busca" id="mq-maq" value="${v('maquina')}" placeholder="HUSQ 143"></label>
      <label style="flex:1;min-width:140px"><span class="field-l">Tipo</span>
        <input class="busca" id="mq-tipo" list="mq-tipos" value="${v('tipo_equipo')}" placeholder="Motoguadaña"></label>
    </div>
    <datalist id="mq-tipos">${['Motoguadaña','Motosierra','Extensible','Sopladora','Mini tractor / Giro cero','Tractor','Hidrolavadora','Cortadora de pasto','Plana','Toyota / Camioneta','Camión','Hidro grúa'].map(t=>`<option value="${t}">`).join('')}</datalist>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <label style="flex:1;min-width:120px"><span class="field-l">Fecha de compra</span>
        <input class="busca" id="mq-compra" type="date" value="${v('fecha_compra').slice(0,10)}"></label>
      <label style="flex:1;min-width:120px"><span class="field-l">Precio</span>
        <input class="busca" id="mq-precio" value="${v('precio_compra')}" placeholder="1150000"></label>
      <label style="flex:1;min-width:140px"><span class="field-l">Alimentación</span>
        <input class="busca" id="mq-alim" list="mq-alims" value="${v('alimentacion')}" placeholder="nafta"></label>
      <datalist id="mq-alims"><option value="nafta"><option value="batería"><option value="eléctrica"><option value="diésel"></datalist>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <label style="flex:2;min-width:160px"><span class="field-l">Objetivo</span>
        <select class="busca" id="mq-obj"><option value="">— sin asignar —</option>
        ${objs.map(o=>`<option value="${o.id}" ${m&&m.objetivo_id===o.id?'selected':''}>${escStk(o.nombre)}</option>`).join('')}</select></label>
      <label style="flex:1;min-width:120px"><span class="field-l">Estado</span>
        <select class="busca" id="mq-estado">
          ${['activa','taller','baja'].map(e=>`<option value="${e}" ${m&&m.estado===e?'selected':''}>${e}</option>`).join('')}</select></label>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <label style="flex:2;min-width:160px"><span class="field-l">Motivo de baja</span>
        <input class="busca" id="mq-motivo" value="${v('motivo_baja')}" placeholder="pistón rayado"></label>
      <label style="flex:1;min-width:120px"><span class="field-l">Fecha de baja</span>
        <input class="busca" id="mq-fbaja" type="date" value="${v('fecha_baja').slice(0,10)}"></label>
    </div>
    <label style="display:block;margin-top:8px"><span class="field-l">Notas</span>
      <input class="busca" id="mq-notas" value="${v('notas')}"></label>`;
}
function maqLeer(){
  const g=id=>{const e=document.getElementById(id);return e?e.value.trim():'';};
  return {codigo_interno:g('mq-cod'),maquina:g('mq-maq'),tipo_equipo:g('mq-tipo'),
    fecha_compra:g('mq-compra'),precio_compra:g('mq-precio'),alimentacion:g('mq-alim'),
    objetivo_id:g('mq-obj')||null,estado:g('mq-estado'),motivo_baja:g('mq-motivo'),
    fecha_baja:g('mq-fbaja'),notas:g('mq-notas')};
}
function modalMaquina(m){
  const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=190;
  bg.innerHTML=`<div class="modal" style="max-width:640px">
    <h3>${m?'Editar máquina':'Nueva máquina'}</h3>
    ${maqCampos(m)}
    <div class="modal-acciones">
      ${m?`<button class="btn ghost" id="mq-del" style="color:var(--rojo);margin-right:auto">Eliminar</button>`:''}
      <button class="btn ghost" id="mq-no">Cancelar</button>
      <button class="btn" id="mq-si">Guardar</button></div></div>`;
  document.body.appendChild(bg);
  const cerrar=()=>bg.remove();
  bg.querySelector('#mq-no').onclick=cerrar;
  bg.addEventListener('click',e=>{if(e.target===bg)cerrar();});
  const del=bg.querySelector('#mq-del');
  if(del)del.onclick=async()=>{
    if(!await uiConfirm(`Se borra la máquina <b>${escStk(m.codigo_interno)}</b> del padrón. Su historial de taller no se toca.`,'Eliminar máquina',{ok:'Eliminar',danger:true}))return;
    try{await api('/api/maquinas/'+m.id,{method:'DELETE'});cerrar();toast('Máquina eliminada');go('stock');}
    catch(e){toast('No pude eliminar: '+e.message,'error');}
  };
  bg.querySelector('#mq-si').onclick=async()=>{
    const body=maqLeer();
    if(!body.codigo_interno){toast('Falta el N° interno','error');return;}
    const btn=bg.querySelector('#mq-si');btn.disabled=true;btn.textContent='Guardando…';
    try{
      await api('/api/maquinas'+(m?'/'+m.id:''),{method:m?'PATCH':'POST',body:JSON.stringify(body)});
      cerrar();toast(m?'Máquina actualizada':'Máquina dada de alta');go('stock');
    }catch(e){btn.disabled=false;btn.textContent='Guardar';toast('No pude guardar: '+e.message,'error');}
  };
}
function altaMaquina(){modalMaquina(null);}
function editarMaquina(id){
  const m=((maqData&&maqData.maquinas)||[]).find(x=>x.id===id);
  if(m)modalMaquina(m);
}

/* Importar la planilla de Excel pegada. Primero previsualiza (no escribe
   nada) y muestra qué leyó y qué no entendió; recién después inserta. */
function importarMaquinas(){
  const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=190;
  bg.innerHTML=`<div class="modal" style="max-width:720px">
    <h3>Importar planilla de máquinas</h3>
    <div class="sub" style="font-size:12.5px;margin-bottom:10px">Copiá las filas desde Excel <b>con la fila de títulos incluida</b> y pegalas acá. Reconoce las columnas por nombre: MAQUINA, N° INT, Objetivo, COMPRA, RECTIFICACIONES, FECHA REP., MOTIVO DE BAJA, FECHA BAJA, ESTADO.</div>
    <label style="display:block;margin-bottom:8px"><span class="field-l">Tipo de equipo (si la planilla no trae columna Tipo)</span>
      <input class="busca" id="im-tipo" placeholder="Motoguadaña"></label>
    <textarea class="busca" id="im-txt" style="width:100%;height:190px;font-family:ui-monospace,monospace;font-size:11.5px" placeholder="MAQUINA	N° INT	Objetivo	COMPRA	..."></textarea>
    <div id="im-res"></div>
    <div class="modal-acciones">
      <button class="btn ghost" id="im-no">Cancelar</button>
      <button class="btn" id="im-ver">Previsualizar</button>
      <button class="btn" id="im-si" style="display:none">Importar</button></div></div>`;
  document.body.appendChild(bg);
  const cerrar=()=>bg.remove();
  bg.querySelector('#im-no').onclick=cerrar;
  bg.addEventListener('click',e=>{if(e.target===bg)cerrar();});
  const cuerpo=()=>({texto:bg.querySelector('#im-txt').value,tipo_equipo:bg.querySelector('#im-tipo').value});
  bg.querySelector('#im-ver').onclick=async()=>{
    const out=bg.querySelector('#im-res');out.innerHTML='<div class="sub">Leyendo…</div>';
    try{
      const r=await api('/api/maquinas/importar',{method:'POST',body:JSON.stringify(Object.assign({previsualizar:true},cuerpo()))});
      out.innerHTML=`<div class="aviso-amarillo" style="margin:10px 0">
        Leí <b>${r.leidas}</b> filas · <b>${r.nuevas}</b> se van a dar de alta · ${r.ya_estaban} ya estaban en el padrón.
        ${r.duplicadas_en_lo_pegado.length?`<div style="margin-top:4px">⚠ repetidas en lo pegado: ${r.duplicadas_en_lo_pegado.join(', ')}</div>`:''}
        ${r.errores.length?`<div style="margin-top:6px"><b>${r.errores.length} avisos:</b><div style="max-height:110px;overflow:auto;font-size:11.5px">${r.errores.map(e=>'· '+escStk(e)).join('<br>')}</div></div>`:''}
      </div>`;
      bg.querySelector('#im-si').style.display=r.nuevas?'':'none';
    }catch(e){out.innerHTML=`<div class="sub" style="color:var(--rojo);margin:8px 0">${e.message||'No pude leer'}</div>`;}
  };
  bg.querySelector('#im-si').onclick=async()=>{
    const btn=bg.querySelector('#im-si');btn.disabled=true;btn.textContent='Importando…';
    try{
      const r=await api('/api/maquinas/importar',{method:'POST',body:JSON.stringify(cuerpo())});
      cerrar();toast(`${r.insertadas} máquinas importadas`);stockTab='maquinas';go('stock');
    }catch(e){btn.disabled=false;btn.textContent='Importar';toast('No pude importar: '+e.message,'error');}
  };
}

function exportarMaquinas(){
  const filas=maqFilas();
  if(!filas.length){toast('No hay nada para exportar','error');return;}
  const cols=['N° interno','Máquina','Tipo','Marca','Modelo','Alimentación','Objetivo','Compra','Precio','Estado','Rectificaciones','Motivo de baja','Fecha de baja','Vida (años)','Notas'];
  const celda=v=>{const t=String(v==null?'':v);return /[";\n]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t;};
  const l=[cols.join(';')];
  filas.forEach(m=>l.push([m.codigo_interno,m.maquina,m.tipo_equipo,m.marca,m.modelo,m.alimentacion,
    objNombre(m.objetivo_id)||m.objetivo_texto,m.fecha_compra,m.precio_compra,m.estado,
    m.rectificaciones,m.motivo_baja,m.fecha_baja,m.vida_anios,m.notas].map(celda).join(';')));
  const blob=new Blob(['\ufeff'+l.join('\r\n')],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download='padron_maquinas.csv';document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},0);
  toast(`Exporté ${filas.length} máquinas`);
}

/* ── Solapa Detalle: una fila por máquina informada, filtrable por tipo
      y exportable. Se arma con el MISMO GET /api/stock que usa el Censo,
      así que no agrega llamadas al server. ── */

// Escape para meter texto del capataz en el HTML de la tabla.
function escStk(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// Aplana los censos: una fila por ítem informado.
function stockFilasDetalle(d){
  const filas=[];
  (d.censos||[]).forEach(c=>{
    if(c.estado!=='respondido')return;
    (c.censos_stock_items||[]).forEach(i=>{
      filas.push({
        objetivo:c.objetivos?c.objetivos.nombre:'—',
        capataz:c.capataces?c.capataces.nombre:'',
        tipo:i.tipo_equipo||'—',
        cantidad:i.cantidad||0,
        numeros:(i.numeros||[]).join(', '),
        observacion:i.observacion||'',
        respondio:horaStk(c.respondido_at)||'',
      });
    });
  });
  filas.sort((a,b)=>a.tipo.localeCompare(b.tipo)||a.objetivo.localeCompare(b.objetivo));
  return filas;
}

function stockFilasFiltradas(){
  const d=stockData;if(!d)return[];
  const q=(stockDetBusca||'').toLowerCase().split(/\s+/).filter(Boolean);
  return stockFilasDetalle(d).filter(f=>{
    if(stockTipoFil&&f.tipo!==stockTipoFil)return false;
    if(!q.length)return true;
    const txt=(f.objetivo+' '+f.capataz+' '+f.tipo+' '+f.numeros+' '+f.observacion).toLowerCase();
    return q.every(w=>txt.includes(w));
  });
}

async function vStockDetalle(view){
  try{
    const qs=stockPeriodo?'?periodo='+encodeURIComponent(stockPeriodo):'';
    stockData=await api('/api/stock'+qs);
    const d=stockData;
    const todas=stockFilasDetalle(d);
    const tipos=[...new Set(todas.map(f=>f.tipo))].sort();
    if(stockTipoFil&&!tipos.includes(stockTipoFil))stockTipoFil='';
    const filas=stockFilasFiltradas();
    const total=filas.reduce((s,f)=>s+f.cantidad,0);
    const objs=new Set(filas.map(f=>f.objetivo)).size;
    const selPer=`<select class="busca" style="width:auto" onchange="stockPeriodo=this.value;go('stock')">
      ${d.periodos.map(p=>`<option value="${p}" ${p===d.periodo?'selected':''}>${mesStk(p)}</option>`).join('')}</select>`;
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Stock de maquinaria</div>
      <div class="view-desc">Detalle máquina por máquina · censo de ${mesStk(d.periodo)}</div></div>
      <div style="display:flex;gap:8px;align-items:center">${selPer}
      <button class="btn" onclick="exportarStock()">⬇ Exportar</button></div></div>
    ${tabsStk()}
    <div class="panel" style="margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <select class="busca" style="width:auto;min-width:190px" onchange="stockTipoFil=this.value;go('stock')">
        <option value="">Todos los tipos (${todas.length} líneas)</option>
        ${tipos.map(t=>{const n=todas.filter(f=>f.tipo===t).reduce((s,f)=>s+f.cantidad,0);
          return `<option value="${String(t).replace(/"/g,'&quot;')}" ${t===stockTipoFil?'selected':''}>${t} · ${n}</option>`;}).join('')}
      </select>
      <input class="busca" style="flex:1;min-width:180px" placeholder="Buscar objetivo, capataz, N° de máquina…"
        value="${(stockDetBusca||'').replace(/"/g,'&quot;')}" oninput="stockDetBusca=this.value;pintarDetalleStock()">
      <div class="sub" id="stk-det-res" style="font-size:12px">${total} máquina${total===1?'':'s'} · ${objs} objetivo${objs===1?'':'s'}</div>
    </div>
    <div class="tablewrap">
      <table><thead><tr><th>Objetivo</th><th>Tipo</th><th class="num">Cant.</th><th>N° de máquina</th><th>Observación</th><th>Capataz</th></tr></thead>
      <tbody id="stk-det-body">${filasDetalleHTML(filas)}</tbody></table>
    </div>`;
  }catch(e){view.innerHTML=tabsStk()+`<div class="cargando-v">No pude cargar el detalle. ${e.message||''}</div>`;}
}

function filasDetalleHTML(filas){
  if(!filas.length)return '<tr><td colspan="6"><div class="sub" style="padding:14px">Nada para mostrar con este filtro.</div></td></tr>';
  return filas.map(f=>`<tr>
    <td style="font-weight:500">${escStk(f.objetivo)}</td>
    <td>${escStk(f.tipo)}</td>
    <td class="num mono">${f.cantidad}</td>
    <td class="mono" style="font-size:11.5px;word-break:break-word;max-width:280px">${escStk(f.numeros)||'<span class="sub">—</span>'}</td>
    <td class="sub" style="font-size:12px">${escStk(f.observacion)||'—'}</td>
    <td class="sub" style="font-size:12px">${escStk(f.capataz)||'—'}</td></tr>`).join('');
}

// Repinta solo el cuerpo, para no perder el foco del buscador al tipear.
function pintarDetalleStock(){
  const filas=stockFilasFiltradas();
  const body=document.getElementById('stk-det-body');
  if(body)body.innerHTML=filasDetalleHTML(filas);
  const res=document.getElementById('stk-det-res');
  if(res){const t=filas.reduce((s,f)=>s+f.cantidad,0);const o=new Set(filas.map(f=>f.objetivo)).size;
    res.textContent=`${t} máquina${t===1?'':'s'} · ${o} objetivo${o===1?'':'s'}`;}
}

/* Exporta lo que se está viendo (tipo + búsqueda aplicados) a CSV con BOM y
   separador ';' — Excel en español lo abre en columnas con doble click. */
function exportarStock(){
  const filas=stockFilasFiltradas();
  if(!filas.length){toast('No hay nada para exportar con este filtro','error');return;}
  const cols=['Objetivo','Tipo','Cantidad','N° de máquina','Observación','Capataz','Respondió'];
  const celda=v=>{const t=String(v==null?'':v);return /[";\n]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t;};
  const lineas=[cols.join(';')];
  filas.forEach(f=>lineas.push([f.objetivo,f.tipo,f.cantidad,f.numeros,f.observacion,f.capataz,f.respondio].map(celda).join(';')));
  lineas.push('');
  lineas.push(['TOTAL','',filas.reduce((s,f)=>s+f.cantidad,0),'','','',''].map(celda).join(';'));
  const per=(stockData&&stockData.periodo)||'';
  const tipo=stockTipoFil?'_'+stockTipoFil.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-'):'';
  const blob=new Blob(['\ufeff'+lineas.join('\r\n')],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`stock_${per}${tipo}.csv`;
  document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},0);
  toast(`Exporté ${filas.length} línea${filas.length===1?'':'s'}`);
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
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:12.5px">${x.tipo_equipo}${x.huerfano?' <span class="badge b-blue" style="font-size:9px">nuevo</span>':''}</div>
            <div class="sub mono" style="font-size:11px">${x.huerfano?'no está en el inventario'
              :'oficial '+x.cantidad+(x.censo!=null?' · informó '+x.censo:'')}</div>
            ${detalleCenso(x)}
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
// Detalle de lo que informó el capataz para un tipo de equipo, línea por
// línea (un capataz puede mandar el mismo tipo en varias tandas separadas por
// marca o modelo). Antes esto no se mostraba en ninguna parte de la ficha:
// solo se veían los números del inventario oficial, que suele estar vacío.
function detalleCenso(x){
  const det=x.censo_detalle||[];
  const nums=x.censo_numeros||[];
  if(!det.length&&!nums.length){
    // Sin números informados: al menos mostramos los del inventario oficial.
    return (x.numeros||[]).length
      ?`<div class="sub mono" style="font-size:11px;word-break:break-word">N° ${x.numeros.join(', ')}</div>`:'';
  }
  const lineas=det.length?det:[{cantidad:nums.length,numeros:nums,observacion:null}];
  return `<div style="margin-top:5px;padding-left:8px;border-left:2px solid var(--linea)">
    ${lineas.map(l=>`<div style="margin-bottom:3px">
      <div style="font-size:11.5px"><b>${l.cantidad}</b>${l.observacion?' <span class="sub">· '+String(l.observacion).replace(/</g,'&lt;')+'</span>':''}</div>
      ${(l.numeros||[]).length?`<div class="sub mono" style="font-size:11px;word-break:break-word">N° ${l.numeros.join(', ')}</div>`:''}
    </div>`).join('')}
    ${nums.length?`<div class="sub" style="font-size:10.5px;margin-top:2px">${nums.length} máquina${nums.length===1?'':'s'} con número</div>`:''}
  </div>`;
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
        <button class="btn" style="width:100%" onclick="reenviarStock('${c.id}')">↻ Reenviar pedido</button>
        <button class="btn-salir" style="width:100%;margin-top:6px" onclick="cargarStockManual('${c.id}')">✏️ Cargarlo yo</button>`
      :items.length?items.map(i=>`
        <div class="queue-item" style="margin-bottom:8px">
          <div style="flex:1"><div style="font-weight:600;font-size:12.5px">${i.tipo_equipo}</div>
          <div class="sub mono" style="font-size:11px">${i.numeros&&i.numeros.length?'N° '+i.numeros.join(', '):'sin números'}${i.observacion?' · '+i.observacion:''}</div></div>
          <div class="mono" style="font-size:15px;font-weight:600">${i.cantidad}</div>
        </div>`).join('')
      :'<div class="sub" style="padding:8px 0">Respondió sin equipos.</div>'}
    ${c.estado==='respondido'?`<button class="btn-salir" style="width:100%;margin-top:6px" onclick="cargarStockManual('${c.id}')">✏️ Editar el stock</button>
      <button class="btn-salir" style="width:100%;margin-top:6px;color:var(--rojo)"
      onclick="borrarCenso('${c.id}')">🗑 Borrar esta respuesta</button>`:''}
    <div class="divider"></div>
    <div class="panel-title" style="margin-bottom:10px">Histórico</div>
    <div id="stk-hist"><div class="sub">Cargando…</div></div>`;
  cargarHistorico(c.objetivo_id);
}
/* Cargar el stock de un objetivo a mano, sin esperar al capataz.
   Filas libres: tipo (con sugerencias de los tipos ya usados), cantidad,
   números y observación. Si el censo ya tenía respuesta, la precarga para
   corregirla. */
function stockTiposConocidos(){
  const t=new Set();
  (stockData&&stockData.censos||[]).forEach(c=>(c.censos_stock_items||[]).forEach(i=>{if(i.tipo_equipo)t.add(i.tipo_equipo);}));
  ['Motoguadaña','Motosierra','Extensible','Sopladora','Mini tractor / Giro cero','Tractor','Hidrolavadora','Cortadora de pasto','Pala','Carro / Remolque']
    .forEach(x=>t.add(x));
  return [...t].sort();
}
function filaStockManual(i){
  return `<div class="cs-fila" style="display:flex;gap:6px;margin-bottom:6px;align-items:flex-start">
    <input class="busca cs-tipo" list="cs-tipos" placeholder="Tipo de equipo" style="flex:2;min-width:0" value="${(i&&i.tipo_equipo||'').replace(/"/g,'&quot;')}">
    <input class="busca cs-cant" type="number" min="0" placeholder="Cant." style="width:70px" value="${i?i.cantidad:''}">
    <input class="busca cs-nums" placeholder="N° 12, 15, 21" style="flex:2;min-width:0" value="${((i&&i.numeros||[]).join(', ')).replace(/"/g,'&quot;')}">
    <input class="busca cs-obs" placeholder="Observación" style="flex:2;min-width:0" value="${(i&&i.observacion||'').replace(/"/g,'&quot;')}">
    <button class="btn-salir" style="padding:6px 9px;color:var(--rojo)" onclick="this.closest('.cs-fila').remove()" title="Quitar">✕</button>
  </div>`;
}
function cargarStockManual(id){
  const d=stockData;const c=d&&d.censos.find(x=>String(x.id)===String(id));if(!c)return;
  const items=c.censos_stock_items||[];
  const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=190;
  bg.innerHTML=`<div class="modal" style="max-width:820px">
    <h3>Stock de ${c.objetivos?c.objetivos.nombre:'—'}</h3>
    <div class="sub" style="font-size:12.5px;margin-bottom:12px">Cargalo vos, sin esperar la respuesta del capataz. Si ponés los números, la cantidad se ajusta sola.</div>
    <datalist id="cs-tipos">${stockTiposConocidos().map(t=>`<option value="${String(t).replace(/"/g,'&quot;')}">`).join('')}</datalist>
    <div id="cs-filas" style="max-height:340px;overflow:auto">${items.length?items.map(filaStockManual).join(''):filaStockManual(null)}</div>
    <button class="btn-salir" style="margin-top:4px" id="cs-add">＋ Agregar equipo</button>
    <div class="modal-acciones">
      <button class="btn ghost" id="cs-no">Cancelar</button>
      <button class="btn" id="cs-si">Guardar</button>
    </div></div>`;
  document.body.appendChild(bg);
  const cerrar=()=>bg.remove();
  bg.querySelector('#cs-no').onclick=cerrar;
  bg.addEventListener('click',e=>{if(e.target===bg)cerrar();});
  bg.querySelector('#cs-add').onclick=()=>{
    bg.querySelector('#cs-filas').insertAdjacentHTML('beforeend',filaStockManual(null));
    bg.querySelector('#cs-filas').scrollTop=bg.querySelector('#cs-filas').scrollHeight;
  };
  bg.querySelector('#cs-si').onclick=async()=>{
    const filas=[...bg.querySelectorAll('.cs-fila')].map(f=>({
      tipo:f.querySelector('.cs-tipo').value.trim(),
      cantidad:f.querySelector('.cs-cant').value,
      numeros:f.querySelector('.cs-nums').value,
      observacion:f.querySelector('.cs-obs').value,
    })).filter(f=>f.tipo);
    if(!filas.length){toast('Cargá al menos un equipo','error');return;}
    const btn=bg.querySelector('#cs-si');btn.disabled=true;btn.textContent='Guardando…';
    try{
      const r=await api('/api/stock/censo/'+id+'/items',{method:'POST',body:JSON.stringify({items:filas})});
      cerrar();
      toast(`Guardado · ${r.equipos} equipo${r.equipos===1?'':'s'} en ${r.tipos} tipo${r.tipos===1?'':'s'}`);
      go('stock');
    }catch(e){
      btn.disabled=false;btn.textContent='Guardar';
      toast('No pude guardar: '+e.message,'error');
    }
  };
}

/* Borra lo que informó el capataz y deja el censo pendiente otra vez.
   Sirve para limpiar pruebas. No borra la fila del censo: si desapareciera,
   el objetivo saldría del listado del período y no se le podría reenviar. */
async function borrarCenso(id){
  const d=stockData;const c=d&&d.censos.find(x=>String(x.id)===String(id));
  const nom=c&&c.objetivos?c.objetivos.nombre:'este objetivo';
  const eq=c?(c.censos_stock_items||[]).reduce((s,i)=>s+(i.cantidad||0),0):0;
  if(!await uiConfirm(`Se borra lo que informó el capataz de <b>${nom}</b>${eq?' ('+eq+' equipos)':''} y el censo queda pendiente de nuevo.`,
    'Borrar respuesta',{ok:'Borrar',danger:true}))return;
  try{
    await api('/api/stock/censo/'+id,{method:'DELETE'});
    toast('Respuesta borrada · el censo quedó pendiente');
    go('stock');
  }catch(e){toast('No pude borrar: '+e.message,'error');}
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
let repTab='resumen', repIndPer='', repIndMec='';   // repIndMec: filtro por mecánico en Indicadores
let repIndObj='', repIndPrio='', repIndQ='';        // filtros de Indicadores: objetivo, criticidad, búsqueda
let repIndEst='abiertas';                           // abiertas | finalizadas | todas
let repIndD1='', repIndD2='';                       // rango de fechas de cierre
let repTrz=null;                                    // incidencia abierta en el detalle de trazabilidad

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

function tabsRep(){
  // El circuito de repuestos se mudó a Compras→Repuestos (21-ago): si algún
  // navegador tenía guardada esa pestaña, cae al resumen.
  if(repTab==='repuestos')repTab='resumen';
  return `<div class="toggle-imp" style="margin-bottom:16px">
  <button class="${repTab==='resumen'?'on':''}" onclick="repTab='resumen';go('reparaciones')">Resumen</button>
  <button class="${repTab==='services'?'on':''}" onclick="repTab='services';go('reparaciones')">Services</button>
  <button class="${repTab==='preventivo'?'on':''}" onclick="repTab='preventivo';go('reparaciones')">Preventivo</button>
  <button class="${repTab==='indicadores'?'on':''}" onclick="repTab='indicadores';go('reparaciones')">Indicadores</button>
  ${localStorage.getItem('eco_admin')==='1'?`<button class="${repTab==='performance'?'on':''}" onclick="repTab='performance';go('reparaciones')">Performance</button>`:''}
</div>`;}

/* Exporta a CSV lo que se está viendo (respeta los filtros: estado,
   prioridad, mecánico, objetivo). Pensado para "finalizadas por objetivo":
   se filtra Finalizadas + el objetivo y sale la planilla de ese objetivo.
   Excel en español lee CSV con ; y coma decimal. */
function exportarIncidencias(){
  const filas=window._repFiltrada||[];
  if(!filas.length)return alert('No hay incidencias para exportar con estos filtros.');
  const dias=(a,b)=>{if(!a||!b)return '';const d=(new Date(b)-new Date(a))/86400000;return d>=0?Math.ceil(d):'';};
  const fecha=v=>v?new Date(v).toLocaleDateString('es-AR'):'';
  const q=v=>{const t=String(v==null?'':v).replace(/"/g,'""').replace(/[\r\n]+/g,' ');return /[;"]/.test(t)?`"${t}"`:t;};
  // Campos según el select real de /api/reparaciones: tipo_equipo,
  // numero_unidad, tipo_falla y comentarios_incidencias.
  const cab=['Objetivo','Equipo','N° unidad','Falla','Descripción','Prioridad','Tipo','Estado',
    'Capataz','Mecánico','Alta','Finalizada','Días en taller','Equipo parado','Repuestos','Lo que hizo el taller'];
  const lineas=[cab.join(';')];
  filas.forEach(r=>{
    const obs=(r.comentarios_incidencias||[])
      .slice().sort((a,b)=>new Date(a.created_at)-new Date(b.created_at))
      .map(c=>`${c.mecanico_nombre?c.mecanico_nombre+': ':''}${c.texto||''}`).filter(Boolean).join(' · ');
    const rep=(r.repuestos_taller||[]).map(x=>{
      const its=Array.isArray(x.items)?x.items:[];
      return its.map(i=>`${i.cantidad||1}× ${i.item||i.nombre||''}`).join(', ');
    }).filter(Boolean).join(' · ');
    lineas.push([
      r.objetivos?r.objetivos.nombre:'',
      r.equipos&&r.equipos.nombre?r.equipos.nombre:(r.tipo_equipo||''),
      r.numero_unidad||'', r.tipo_falla||'',
      r.descripcion||'', r.prioridad||'', r.tipo_mant||'correctivo', r.estado||'',
      r.capataces?r.capataces.nombre:'', r.mecanicos?r.mecanicos.nombre:'',
      fecha(r.created_at), fecha(r.fecha_finalizado),
      dias(r.created_at,r.fecha_finalizado||new Date().toISOString()),
      r.equipo_parado?'SÍ':'', rep, obs,
    ].map(q).join(';'));
  });
  const est=repFEstado==='finalizado'?'finalizadas':(repFEstado||'activas');
  const obj=repFObj?'_'+repFObj.toLowerCase().replace(/[^a-z0-9]+/gi,'-').slice(0,28):'';
  const blob=new Blob(['\ufeff'+lineas.join('\r\n')],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=`incidencias_${est}${obj}_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  toast(`${filas.length} incidencia${filas.length===1?'':'s'} exportada${filas.length===1?'':'s'}`);
}

/* ── Reparaciones · Performance (SOLO ADMIN): ranking para el bono ──
   Cada mecánico suma puntos por trabajo ponderado por dificultad; la calidad
   (reincidencia) no suma puntos: HABILITA o bloquea el bono. El detalle de
   cada punto se muestra al expandir la card — el sistema tiene que poder
   explicarse solo, si no nadie le cree. Los pesos y umbrales están acá
   arriba para ajustarlos cuando haya 2-3 meses de datos reales. */
const PERF_OBJETIVO=30;            // puntos del mes para cobrar (provisorio)
const PERF_REINC_MAX=15;           // % de reincidencia (90 días) que bloquea
const PERF_DORMIDA_DIAS=7;         // abierta sin justificar más de esto descuenta
/* ── Puntaje = horas de taller estimadas (matriz equipo × falla) ──────────
   Rediseño 13-ago: la escala vieja (pesado 5 / mediano 3 / liviano 1) no medía
   tiempo — una hidráulica de giro cero (una jornada) valía 3 y una motoguadaña
   con extras podía valer lo mismo. Además el extensible estaba como "mediano"
   siendo una 2T de pértiga que se hace en la misma tanda que las motoguadañas.
   Regla de calibración de José: un día pleno de taller ≈ 5-6 pts con cualquier
   fierro (5-6 chicas por día, o una hidráulica grande = 8).
   Importante: mide MANO DE OBRA, no calendario — la espera de repuestos no
   puntúa (la dormida −2 ya la contempla aparte).
   Piloto: mirar el primer mes y ajustar la matriz con lo que se vea. */
const PERF_CAT_EQUIPO=[            // [regex sobre tipo de equipo, categoría, etiqueta]
  // 'grande' va PRIMERO: "Mini tractor" contiene "tractor" y caería en vehículo
  [/giro|mini|desmalezadora/i,'grande','grande'],
  [/cami[oó]n|tractor|hidro *gr|camioneta|toyota|atego/i,'vehiculo','vehículo'],
  [/hidrolavadora|cortadora|plana/i,'media','media'],
  [/motoguada|sopladora|motosierra|extensible|bordeadora/i,'chica','2T chica'],
];
// Gravedad por tipo_falla (catálogo del bot). Lo que no matchea = 'media'
// (incluye "Otro" e "Ingreso taller": no se sabe qué fue, se asume promedio).
const PERF_FALLAS=[                // [regex sobre tipo_falla, gravedad]
  [/service|mantenimiento/i,'service'],
  [/pist[oó]n|motor rot|hidr[aá]ulic|p[eé]rdida hidr|transmisi[oó]n|soldadura|estructura/i,'pesada'],
  [/buj[ií]a|piola|soga|cable|tanza|regulaci[oó]n|correa|bater[ií]a|luces|llanta|cubierta/i,'rapida'],
];
// Puntos ≈ horas de mano de obra por (categoría, gravedad).
const PERF_MATRIZ={
  chica:    {rapida:1, media:2, pesada:4, service:1},
  media:    {rapida:1, media:3, pesada:6, service:2},
  grande:   {rapida:2, media:4, pesada:8, service:3},
  vehiculo: {rapida:2, media:4, pesada:8, service:2},
  otro:     {rapida:1, media:2, pesada:4, service:1},   // equipo no clasificado
};
function perfCatEquipo(tipo){
  for(const [rx,cat,et] of PERF_CAT_EQUIPO)if(rx.test(String(tipo||'')))return {cat,et};
  return {cat:'otro',et:'otro'};
}
function perfGravedadFalla(falla){
  for(const [rx,g] of PERF_FALLAS)if(rx.test(String(falla||'')))return g;
  return 'media';
}
// Compatibilidad: misma firma que antes ({p, et}), ahora con la matriz.
function perfPesoEquipo(tipo,falla){
  const {cat,et}=perfCatEquipo(tipo);
  const g=perfGravedadFalla(falla);
  const p=(PERF_MATRIZ[cat]||PERF_MATRIZ.otro)[g]||2;
  const etG=g==='rapida'?'rápida':g==='pesada'?'pesada':g==='service'?'service':'media';
  return {p,et:et+' · '+etG};
}
let perfPer='', perfOpen=null;   // mes filtrado y card expandida
// Candado extra: los mecánicos también entran al panel, así que además de ser
// admin la vista pide el PIN de súper admin (env PERFORMANCE_PIN en Railway).
// El OK dura lo que dure la pestaña del navegador (sessionStorage).
/* Informe imprimible de un mecánico: una ficha por incidencia con lo que
   hizo, los repuestos, el puntaje y por qué. Se abre en una ventana y se
   imprime — desde ahí "Guardar como PDF". Sin librerías en el panel. */
function informeMecanico(nombre){
  const todas=repData||[];
  const mesDeF=r=>r.fecha_finalizado?String(r.fecha_finalizado).slice(0,7):'';
  const suyas=todas.filter(r=>r.estado==='finalizado'&&r.fecha_finalizado
    &&mesDeF(r)===perfPer&&(r.mecanicos?r.mecanicos.nombre:'Sin asignar')===nombre)
    .sort((a,b)=>String(a.fecha_finalizado).localeCompare(String(b.fecha_finalizado)));
  if(!suyas.length){toast('No tiene reparaciones finalizadas en el mes','error');return;}

  const esc=v=>String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fecha=d=>d?String(d).slice(0,10).split('-').reverse().join('/'):'—';
  const total=suyas.reduce((a,r)=>a+(r.puntos_manual!=null?Number(r.puntos_manual):r.puntos_ia!=null?Number(r.puntos_ia):0),0);

  const fichas=suyas.map((r,i)=>{
    const pts=r.puntos_manual!=null?Number(r.puntos_manual):r.puntos_ia!=null?Number(r.puntos_ia):null;
    const coms=(r.comentarios_incidencias||[]).map(c=>`<li><b>${esc(c.mecanico_nombre||'?')}:</b> ${esc(c.texto)}</li>`).join('');
    const reps=(r.repuestos_taller||[]).map(x=>(Array.isArray(x.items)?x.items:[]).map(i=>i.descripcion||i.nombre||'').filter(Boolean).join(', ')).filter(Boolean).join(' · ');
    const dias=r.created_at&&r.fecha_finalizado?Math.round((new Date(r.fecha_finalizado)-new Date(r.created_at))/86400000):null;
    return `<div class="ficha">
      <div class="fh"><span class="num">${i+1}</span>
        <span class="eq">${esc(r.tipo_equipo||'—')} ${esc(r.numero_unidad||'')}</span>
        <span class="prio p-${esc(r.prioridad||'')}">${esc(r.prioridad||'—')}</span>
        ${r.equipo_parado?'<span class="parada">máquina parada</span>':''}
        <span class="pts">${pts!=null?pts+' pts':'—'}</span></div>
      <table class="datos">
        <tr><th>Objetivo</th><td>${esc(r.objetivos?r.objetivos.nombre:'—')}</td>
            <th>Capataz</th><td>${esc(r.capataces?r.capataces.nombre:'—')}</td></tr>
        <tr><th>Falla</th><td>${esc(r.tipo_falla||'sin especificar')}</td>
            <th>Ingresó / salió</th><td>${fecha(r.created_at)} → ${fecha(r.fecha_finalizado)}${dias!=null?` (${dias} d)`:''}</td></tr>
      </table>
      ${r.descripcion?`<p class="desc"><b>Reportó:</b> ${esc(r.descripcion)}</p>`:''}
      <div class="bloque"><b>Qué se hizo</b>${coms?`<ul>${coms}</ul>`:'<p class="vacio">Sin comentarios cargados por el taller.</p>'}</div>
      ${reps?`<p class="reps"><b>Repuestos:</b> ${esc(reps)}</p>`:''}
      ${r.puntos_ia_motivo?`<p class="analisis"><b>Puntaje:</b> ${esc(r.puntos_ia_motivo)}${r.puntos_ia_horas!=null?` · ${Math.round(Number(r.puntos_ia_horas)*10)/10} h estimadas`:''}${r.puntos_ia_confianza?` · confianza ${esc(r.puntos_ia_confianza)}`:''}${r.puntos_manual!=null?' · <i>corregido a mano</i>':''}</p>`:''}
      <div class="firma"><span>Comentarios de la charla:</span><div class="lineas"></div></div>
    </div>`;}).join('');

  const w=window.open('','_blank');
  if(!w){toast('El navegador bloqueó la ventana — permití pop-ups','error');return;}
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Informe ${esc(nombre)} · ${mesStk(perfPer)}</title>
  <style>
    *{box-sizing:border-box}
    body{font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;margin:0;padding:26px 30px;background:#fff}
    h1{font-size:21px;margin:0 0 2px}
    .sub{color:#666;font-size:12.5px;margin-bottom:14px}
    .resumen{background:#f4f7f4;border-left:4px solid #2f7d4f;padding:9px 13px;margin-bottom:18px;font-size:13px}
    .ficha{border:1px solid #ddd;border-radius:7px;padding:11px 13px;margin-bottom:11px;page-break-inside:avoid}
    .fh{display:flex;align-items:center;gap:9px;flex-wrap:wrap;border-bottom:1px solid #eee;padding-bottom:7px;margin-bottom:8px}
    .num{background:#eee;border-radius:50%;width:21px;height:21px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
    .eq{font-weight:700;font-size:14px;flex:1}
    .pts{font-weight:700;font-size:15px;color:#2f7d4f}
    .prio{font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;padding:2px 7px;border-radius:9px;background:#eee}
    .p-critico{background:#c0392b;color:#fff;font-weight:700}
    .p-alta{background:#fdf0dc;color:#9a6212;border:1px solid #d99000;font-weight:700}
    .p-media{background:#e8eff8;color:#31618f}
    .p-baja{background:#eaf3ec;color:#2f7d4f}
    .parada{font-size:10.5px;color:#c0392b;border:1px solid #c0392b;padding:1px 6px;border-radius:9px}
    table.datos{width:100%;border-collapse:collapse;margin-bottom:6px}
    table.datos th{text-align:left;color:#777;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.3px;padding:2px 8px 2px 0;width:1%;white-space:nowrap;vertical-align:top}
    table.datos td{padding:2px 16px 2px 0;font-size:12.5px;vertical-align:top}
    .desc{margin:5px 0;font-size:12.5px}
    .bloque{margin:7px 0}
    .bloque b{font-size:11px;text-transform:uppercase;letter-spacing:.3px;color:#777}
    .bloque ul{margin:3px 0 0;padding-left:18px;font-size:12.5px}
    .vacio{color:#b00;font-size:12.5px;margin:3px 0 0;font-style:italic}
    .reps,.analisis{font-size:12.5px;margin:5px 0 0}
    .analisis{color:#555;background:#fafafa;padding:5px 8px;border-radius:5px}
    .firma{margin-top:9px;border-top:1px dashed #ccc;padding-top:6px;font-size:11px;color:#888}
    .lineas{height:34px;border-bottom:1px solid #ddd}
    @media print{body{padding:12px}.ficha{border-color:#ccc}}
  </style></head><body>
  <h1>${esc(nombre)}</h1>
  <div class="sub">Informe de reparaciones · ${mesStk(perfPer)} · EcoService</div>
  <div class="resumen"><b>${suyas.length} reparaciones finalizadas</b> · ${total} puntos ·
    1 punto ≈ 1 hora de mano de obra. El puntaje sale de la criticidad, la falla, lo que se cargó
    que se hizo y los repuestos pedidos.</div>
  ${fichas}
  <div class="sub" style="margin-top:16px">Generado el ${new Date().toLocaleDateString('es-AR')} desde EcoService Gestión.</div>
  </body></html>`);
  w.document.close();
  setTimeout(()=>{try{w.print();}catch(e){}},400);
}

/* Corregir a mano el puntaje de una reparación. Manda sobre el de la IA. */
async function editarPuntaje(id,actual){
  const v=prompt('Puntos de esta reparación (1 punto ≈ 1 hora de taller).\nDejalo vacío para volver al análisis automático:',actual||'');
  if(v===null)return;
  try{
    await api('/api/reparaciones/'+id+'/puntaje-manual',{method:'POST',body:JSON.stringify({puntos:String(v).trim()===''?null:String(v).trim()})});
    toast(String(v).trim()===''?'Vuelve al puntaje analizado':'Puntaje corregido');
    repData=null;go('reparaciones');
  }catch(e){toast('No pude guardar: '+e.message,'error');}
}

/* Analiza las finalizadas que todavía no tienen puntaje (de a 40 por tanda). */
async function recalcularPuntajes(){
  if(!await uiConfirm('Voy a analizar las reparaciones finalizadas que todavía no tienen puntaje. Puede tardar un rato.','Analizar pendientes',{ok:'Analizar'}))return;
  toast('Analizando… puede tardar');
  try{
    const r=await api('/api/reparaciones/puntaje-lote',{method:'POST',body:JSON.stringify({desde:perfPer?perfPer+'-01':''})});
    toast(`Listo · ${r.analizadas} analizada${r.analizadas===1?'':'s'}${r.fallaron?' · '+r.fallaron+' fallaron':''}`);
    repData=null;go('reparaciones');
  }catch(e){toast('No pude recalcular: '+e.message,'error');}
}

/* Qué se hizo vs por qué volvió: los datos ya están en repData (comentarios
   del taller y repuestos de cada incidencia), solo se muestran lado a lado. */
function fichaRebote(inc,rol,color){
  if(!inc)return `<div class="sub">${rol}: no la encontré en la carga actual</div>`;
  const coms=(inc.comentarios_incidencias||[]).map(c=>`<div style="padding:1px 0">💬 <b>${c.mecanico_nombre||'?'}</b>: ${String(c.texto||'').replace(/</g,'&lt;')}</div>`).join('')||'<div style="opacity:.7">sin comentarios del taller</div>';
  const reps=(inc.repuestos_taller||[]).map(r=>(Array.isArray(r.items)?r.items:[]).map(i=>i.descripcion||i.nombre||'').filter(Boolean).join(', ')).filter(Boolean).join(' · ');
  return `<div style="flex:1;min-width:240px;border-left:3px solid ${color};padding:6px 10px;background:var(--papel);border-radius:0 8px 8px 0">
    <div style="font-weight:600;font-size:11px;letter-spacing:.3px">${rol}</div>
    <div style="padding:2px 0">Falla: <b>${inc.tipo_falla||'sin especificar'}</b>${inc.mecanicos?' · mec. '+inc.mecanicos.nombre:''}</div>
    ${inc.descripcion?`<div style="padding:1px 0">📝 ${String(inc.descripcion).replace(/</g,'&lt;')}</div>`:''}
    ${coms}
    ${reps?`<div style="padding:1px 0">🔩 ${String(reps).replace(/</g,'&lt;')}</div>`:''}
  </div>`;
}
function toggleRebote(idBase,idVuelta){
  const box=document.getElementById('reb-det-'+idVuelta);if(!box)return;
  if(box.style.display!=='none'){box.style.display='none';return;}
  const todas=repData||[];
  const base=todas.find(r=>String(r.id)===String(idBase));
  const vuelta=todas.find(r=>String(r.id)===String(idVuelta));
  box.innerHTML=`<div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 4px">
    ${fichaRebote(base,'LO QUE SE HIZO (reparación anterior)','var(--brote)')}
    ${fichaRebote(vuelta,'POR QUÉ VOLVIÓ','#C25B5B')}
  </div>`;
  box.style.display='block';
}

/* La IA compara lo hecho con el motivo de la vuelta y SUGIERE si se atribuye.
   La decisión sigue siendo del usuario: el dictamen trae el botón para aplicar. */
async function analizarRebote(btn,idBase,idVuelta){
  const out=()=>document.getElementById('reb-ia-'+idVuelta);
  if(!out())return;
  btn.disabled=true;const txt=btn.textContent;btn.textContent='Analizando…';
  try{
    const r=await api('/api/reparaciones/rebote-analisis',{method:'POST',body:JSON.stringify({base_id:idBase,vuelta_id:idVuelta})});
    const col=r.atribuible==='no'?'var(--brote-2)':r.atribuible==='si'?'#A32D2D':'#8a6d1a';
    const label=r.atribuible==='no'?'NO se atribuye':r.atribuible==='si'?'SÍ se atribuye':'Dudoso';
    const html=`<div style="margin:4px 0 6px;padding:7px 10px;border-radius:8px;background:var(--papel);font-size:11.5px">
      🤖 <b style="color:${col}">${label}</b> <span class="sub">(confianza ${r.confianza})</span> — ${String(r.motivo||'').replace(/</g,'&lt;')}
      ${r.atribuible==='no'?`<button class="btn-salir" style="padding:2px 8px;font-size:10.5px;margin-left:8px" onclick="descartarReboteConMotivo('${idVuelta}',this)" data-motivo="${String(r.motivo||'').replace(/"/g,'&quot;')}">Aplicar: no atribuir</button>`:''}
    </div>`;
    const o=out();if(o)o.innerHTML=html;else toast(`🤖 ${label} — ${r.motivo||''}`);
  }catch(e){
    const o=out();const msg=e.message||'No pude analizar';
    if(o)o.innerHTML=`<div class="sub" style="font-size:11px;color:var(--rojo);margin:3px 0">${String(msg).replace(/</g,'&lt;')}</div>`;
    else toast(msg,'error');
  }
  btn.disabled=false;btn.textContent=txt;
}
async function descartarReboteConMotivo(id,btn){
  try{
    await api('/api/reparaciones/'+id+'/rebote',{method:'POST',body:JSON.stringify({descartar:true,motivo:'IA: '+(btn.dataset.motivo||'')})});
    toast('Listo, esa vuelta ya no cuenta contra la calidad');
    repData=null;go('reparaciones');
  }catch(e){toast('No pude guardar: '+e.message,'error');}
}

/* La vuelta no es atribuible al arreglo anterior (volvió por otra cosa).
   Se marca en la incidencia de la vuelta y deja de contar contra la calidad. */
async function descartarRebote(id){
  const motivo=prompt('¿Por qué no cuenta? (opcional — ej: "volvió por pistón, entró por trinquete")')
  if(motivo===null)return;
  try{
    await api('/api/reparaciones/'+id+'/rebote',{method:'POST',body:JSON.stringify({descartar:true,motivo})});
    toast('Listo, esa vuelta ya no cuenta contra la calidad');
    repData=null;go('reparaciones');
  }catch(e){toast('No pude guardar: '+e.message,'error');}
}
async function restaurarRebote(id){
  try{
    await api('/api/reparaciones/'+id+'/rebote',{method:'POST',body:JSON.stringify({descartar:false})});
    toast('Restaurado · vuelve a contar');
    repData=null;go('reparaciones');
  }catch(e){toast('No pude guardar: '+e.message,'error');}
}

async function perfValidarPin(){
  const inp=document.getElementById('perf-pin'),msg=document.getElementById('perf-pin-msg');
  const pin=inp?inp.value:'';
  try{
    const r=await api('/api/reparaciones/performance-pin',{method:'POST',body:JSON.stringify({pin})});
    if(r&&r.ok){
      sessionStorage.setItem('eco_perf_ok','1');
      if(r.sin_pin)toast('PERFORMANCE_PIN no está configurada en Railway: la vista queda abierta para admins. Sételo para el candado.','error');
      go('reparaciones');
    }
  }catch(e){if(msg)msg.textContent=e.message||'PIN incorrecto';if(inp){inp.value='';inp.focus();}}
}
async function vRepPerf(view){
  if(sessionStorage.getItem('eco_perf_ok')!=='1'){
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Reparaciones · Performance</div>
      <div class="view-desc">Ranking para el bono · requiere PIN de súper admin</div></div></div>
    ${tabsRep()}
    <div class="panel" style="max-width:380px;margin:40px auto;text-align:center">
      <div style="font-size:26px;margin-bottom:8px">🔒</div>
      <div style="font-weight:600;margin-bottom:4px">Vista protegida</div>
      <div class="sub" style="margin-bottom:14px">Ingresá el PIN de súper admin para ver el ranking del bono.</div>
      <input type="password" id="perf-pin" class="busca" style="width:100%;text-align:center;font-size:16px;letter-spacing:3px" placeholder="PIN" onkeydown="if(event.key==='Enter')perfValidarPin()">
      <div class="sub" id="perf-pin-msg" style="min-height:16px;margin-top:6px;color:var(--rojo)"></div>
      <button class="btn" style="width:100%;justify-content:center;margin-top:8px" onclick="perfValidarPin()">Entrar</button>
    </div>`;
    setTimeout(()=>{const i=document.getElementById('perf-pin');if(i)i.focus();},50);
    return;
  }
  const todas=repData||[];
  // Los meses salen de la fecha de FINALIZACIÓN (es lo que puntúa): una
  // reparación creada en julio y finalizada en agosto puntúa en agosto.
  const meses=[...new Set(todas.filter(r=>r.fecha_finalizado).map(r=>mesDe(r.fecha_finalizado)))].filter(m=>m!=='sin fecha').sort().reverse();
  if(!perfPer)perfPer=meses[0]||'';
  const normU=v=>String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const esPrev=r=>r.tipo_mant==='preventivo';
  const nomMec=r=>r.mecanicos?r.mecanicos.nombre:null;
  const fin=todas.filter(r=>r.estado==='finalizado'&&r.fecha_finalizado);
  const finMes=fin.filter(r=>mesDe(r.fecha_finalizado)===perfPer);

  // Reincidencia 90 días rodantes (no solo el mes): finalizadas de los últimos
  // 90 días cuya unidad volvió como correctivo dentro de los 30 días siguientes.
  const hoy=Date.now(), MS90=90*86400000, MS30=30*86400000;
  const base90=fin.filter(r=>!esPrev(r)&&normU(r.numero_unidad)&&hoy-new Date(r.fecha_finalizado).getTime()<=MS90);
  // Una vuelta cuenta contra la calidad SOLO si puede ser el mismo problema.
  // Si las DOS fallas son específicas y DISTINTAS (entró por trinquete,
  // volvió por pistón), no es atribuible al arreglo → se descarta sola.
  // Las genéricas ("Otro", "Ingreso taller"…) no permiten comparar: cuentan,
  // y José puede descartarlas a mano (rebote_descartado en la vuelta).
  const FALLA_GENERICA=['','otro','ingreso taller','preventivo','service / mantenimiento','service/mantenimiento'];
  const normFalla=v=>String(v||'').toLowerCase().trim();
  const fallaEspecifica=v=>!FALLA_GENERICA.includes(normFalla(v));
  const rebotes={};      // mecánico → [{eq,uni,dias,idVuelta,fallaBase,fallaVuelta}] · cuentan
  const descartes={};    // mecánico → los que NO cuentan, para mostrarlos igual
  base90.forEach(f=>{
    const k=normU(f.numero_unidad), ff=new Date(f.fecha_finalizado).getTime();
    const m=nomMec(f)||'Sin asignar';
    const cands=todas.filter(o=>o.id!==f.id&&!esPrev(o)&&normU(o.numero_unidad)===k)
      .map(o=>({o,c:new Date(o.created_at).getTime()}))
      .filter(x=>x.c>ff&&x.c-ff<=MS30).sort((a,b)=>a.c-b.c);
    let contado=false;
    for(const x of cands){
      const base={eq:f.tipo_equipo||'—',uni:f.numero_unidad||'',dias:Math.round((x.c-ff)/86400000),
        idBase:f.id,idVuelta:x.o.id,fallaBase:f.tipo_falla||'',fallaVuelta:x.o.tipo_falla||''};
      if(x.o.rebote_descartado){
        (descartes[m]=descartes[m]||[]).push(Object.assign({por:'manual',motivo:x.o.rebote_motivo||''},base));
        continue;
      }
      if(fallaEspecifica(f.tipo_falla)&&fallaEspecifica(x.o.tipo_falla)&&normFalla(f.tipo_falla)!==normFalla(x.o.tipo_falla)){
        (descartes[m]=descartes[m]||[]).push(Object.assign({por:'auto'},base));
        continue;
      }
      (rebotes[m]=rebotes[m]||[]).push(base);
      contado=true;break;   // como antes: un rebote por reparación base
    }
  });
  const base90PorMec={};
  base90.forEach(f=>{const m=nomMec(f)||'Sin asignar';base90PorMec[m]=(base90PorMec[m]||0)+1;});

  // Dormidas HOY: abiertas hace más de N días que no esperan repuestos
  const dormidas={};
  todas.filter(r=>r.estado!=='finalizado'&&r.estado!=='esperando_repuestos').forEach(r=>{
    const d=diasEntre(r.created_at,new Date().toISOString());
    if(d!=null&&d>PERF_DORMIDA_DIAS){const m=nomMec(r)||'Sin asignar';(dormidas[m]=dormidas[m]||[]).push({eq:r.tipo_equipo||'—',uni:r.numero_unidad||'',dias:Math.round(d*10)/10});}
  });

  // Puntaje del mes, con el detalle línea por línea (el "por qué").
  // Arrancan TODOS los mecánicos que aparecen en el sistema (con abiertas o
  // finalizadas), aunque tengan 0 puntos: si no, el que no finalizó nada este
  // mes desaparece del ranking y no se ve que está en cero.
  const mecs={};
  const vacio=()=>({lineas:[],trabajo:0,urgencia:0,prev:0,total:0,nFin:0,nPrev:0});
  todas.forEach(r=>{const m=nomMec(r);if(m&&!mecs[m])mecs[m]=vacio();});
  finMes.forEach(r=>{
    const m=nomMec(r);if(!m)return;
    const M=mecs[m]=mecs[m]||vacio();
    M.nFin++;
    if(esPrev(r)){M.prev+=2;M.total+=2;M.nPrev++;
      M.lineas.push({tit:(r.tipo_equipo||'Preventivo')+' '+(r.numero_unidad||''),det:'preventivo realizado',pts:'+2'});return;}
    // Precedencia del puntaje:
    //   1. puntos_manual  → corrección de José, manda siempre
    //   2. puntos_ia      → análisis de la reparación (1 pto ≈ 1 hora de taller)
    //   3. matriz equipo×falla → fallback mientras no se analizó
    // Los extras fijos por prioridad SOLO se aplican en el fallback: el
    // análisis ya pondera criticidad y máquina parada, sumarlos otra vez
    // sería contar dos veces lo mismo.
    const manual=r.puntos_manual!=null?Number(r.puntos_manual):null;
    const ia=r.puntos_ia!=null?Number(r.puntos_ia):null;
    let p,extra=0,origen;const motivos=[];
    if(manual!=null){
      p=manual;origen='manual';motivos.push('puntaje corregido a mano');
    }else if(ia!=null){
      p=ia;origen='ia';
      const h=r.puntos_ia_horas!=null?(Math.round(Number(r.puntos_ia_horas)*10)/10):null;
      motivos.push((h!=null?h+' h de taller':'analizada')+(r.puntos_ia_confianza?' · confianza '+r.puntos_ia_confianza:''));
    }else{
      const w=perfPesoEquipo(r.tipo_equipo||(r.equipos?r.equipos.nombre:''),r.tipo_falla);
      p=w.p;origen='tabla';motivos.push(w.et+' +'+w.p);
      if(r.prioridad==='critico'){extra+=2;motivos.push('crítica +2');}
      else if(r.prioridad==='alta'){extra+=1;motivos.push('alta +1');}
      if(r.equipo_parado){extra+=1;motivos.push('destrabó parada +1');}
    }
    M.trabajo+=p;M.urgencia+=extra;M.total+=p+extra;
    if(origen==='tabla')M.sinAnalizar=(M.sinAnalizar||0)+1;
    if(origen==='ia'&&r.puntos_ia_confianza==='baja')M.flojas=(M.flojas||0)+1;
    M.lineas.push({tit:(r.tipo_equipo||'—')+' '+(r.numero_unidad||''),det:motivos.join(' · '),
      pts:'+'+(p+extra),origen,motivoIA:r.puntos_ia_motivo||'',conf:r.puntos_ia_confianza||'',id:r.id});
  });
  // Descuento por dormidas (presente, no del mes)
  Object.entries(dormidas).forEach(([m,ds])=>{
    const M=mecs[m];if(!M)return;
    ds.forEach(d=>{M.total-=2;M.lineas.push({tit:d.eq+' '+d.uni,det:'abierta hace '+d.dias+' d sin esperar repuestos',pts:'−2',mal:true});});
  });

  const filas=Object.entries(mecs).map(([n,M])=>{
    const nBase=base90PorMec[n]||0, nReb=(rebotes[n]||[]).length;
    const pctR=nBase?Math.round(nReb*100/nBase):null;
    const pocaMuestra=nBase<8;
    const habilitado=pctR==null||pctR<=PERF_REINC_MAX;
    return {n,M,pctR,nBase,nReb,pocaMuestra,habilitado,cumple:M.total>=PERF_OBJETIVO&&habilitado};
  }).sort((a,b)=>b.M.total-a.M.total);

  const cardPerf=(f,i)=>{
    const ini=f.n.split(' ').filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase();
    const abierto=perfOpen===f.n;
    const estado=f.cumple?'<span class="badge b-green">✓ cobra el bono</span>'
      :!f.habilitado?'<span class="badge" style="background:#FCEBED;color:#A32D2D">✕ no cobra: calidad</span>'
      :`<span class="badge b-gray">faltan ${Math.max(0,PERF_OBJETIVO-f.M.total)} pts</span>`;
    // Franja de MOTIVO: el veredicto explicado sin tener que expandir
    const faltan=Math.max(0,PERF_OBJETIVO-f.M.total);
    const rebs=(rebotes[f.n]||[]);
    let motivo;
    if(f.cumple){
      motivo=`<div style="margin-top:8px;background:var(--brote-soft);border-radius:8px;padding:8px 12px;font-size:12.5px;color:var(--brote-2)"><b>Cumplió las dos condiciones:</b> llegó a los puntos (${f.M.total} de ${PERF_OBJETIVO} ✓) y su calidad está dentro del límite (reincidencia ${f.pctR==null?'—':f.pctR+'%'}, tope ${PERF_REINC_MAX}% ✓).</div>`;
    }else if(!f.habilitado){
      motivo=`<div style="margin-top:8px;background:#FCEBED;border-radius:8px;padding:8px 12px;font-size:12.5px;color:#7C2222"><b>Motivo — calidad:</b> ${f.nReb} de sus ${f.nBase} reparaciones volvieron al taller (${f.pctR}%, el tope es ${PERF_REINC_MAX}%). ${f.M.total>=PERF_OBJETIVO?'Llegó a los puntos, pero la calidad bloquea el bono.':'Además le faltaron '+faltan+' pts.'}${f.pocaMuestra?' ⚠ Muestra chica: con pocas reparaciones un solo rebote pesa mucho.':''}
        ${rebs.length?`<div style="margin-top:5px;font-size:11.5px">${rebs.map(x=>'↩ '+x.eq+' '+x.uni+' volvió a los '+x.dias+' d').join(' · ')}</div>`:''}</div>`;
    }else{
      motivo=`<div style="margin-top:8px;background:var(--diesel-soft);border-radius:8px;padding:8px 12px;font-size:12.5px;color:#6B4A0E"><b>Motivo — puntos:</b> le faltaron ${faltan} pts para el objetivo (${f.M.total} de ${PERF_OBJETIVO}). Su calidad está bien (${f.pctR==null?'sin base aún':f.pctR+'% ✓'}${f.pocaMuestra&&f.pctR!=null?' · ⚠ muestra chica':''}).</div>`;
    }
    const barra=Math.min(100,Math.max(2,Math.round(f.M.total*100/PERF_OBJETIVO)));
    const colBarra=f.cumple?'var(--brote)':!f.habilitado?'#B4B2A9':'var(--diesel)';
    const calidad=f.pctR==null?'<span class="sub">sin base de cálculo aún</span>'
      :`reincidencia 90d: <b style="color:${f.habilitado?'var(--brote-2)':'#A32D2D'}">${f.pctR}%</b> (${f.nReb} de ${f.nBase})${f.pocaMuestra?' <span class="sub" title="Con menos de 8 reparaciones en 90 días el % salta mucho con un solo caso">⚠ muestra chica</span>':''} — límite ${PERF_REINC_MAX}%`;
    const detalle=!abierto?'':`
      <div style="border-top:1px solid var(--linea);margin-top:10px;padding-top:10px">
        <div class="field-l" style="margin-bottom:6px">Por qué ${f.M.total} puntos</div>
        ${f.M.lineas.map(l=>{
          const marca=l.origen==='ia'?(l.conf==='baja'?'<span title="Analizada con pocos datos">🤖⚠</span> ':'🤖 ')
            :l.origen==='manual'?'✏️ ':l.origen==='tabla'?'<span title="Todavía sin analizar: puntúa por la tabla de pesos" style="opacity:.7">📋</span> ':'';
          return `<div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px dashed var(--linea);font-size:12px">
          <div>${marca}<b style="font-weight:600">${l.tit}</b> <span class="sub">· ${l.det}</span>${l.motivoIA?`<div class="sub" style="font-size:11px;opacity:.85;padding-left:2px">${String(l.motivoIA).replace(/</g,'&lt;')}</div>`:''}</div>
          <b class="mono" style="color:${l.mal?'#A32D2D':'var(--brote-2)'};white-space:nowrap">${l.pts}${l.id?` <button class="btn-salir" style="padding:1px 6px;font-size:10px;font-weight:400" onclick="event.stopPropagation();editarPuntaje('${l.id}','${String(l.pts||'').replace('+','')}')" title="Corregir el puntaje a mano">✏️</button>`:''}</b></div>`;}).join('')||'<div class="sub">Sin reparaciones finalizadas en el período.</div>'}
        ${(rebotes[f.n]||[]).length?`<div class="field-l" style="margin:10px 0 4px">Rebotes que cuentan contra la calidad (90 d)</div>
          ${rebotes[f.n].map(x=>`<div class="sub" style="font-size:11.5px;padding:2px 0" onclick="event.stopPropagation()">
            <div style="display:flex;gap:8px;align-items:center">
              <span style="flex:1;cursor:pointer" onclick="toggleRebote('${x.idBase}','${x.idVuelta}')" title="Tocá para ver qué se hizo">▸ ↩ ${x.eq} ${x.uni} volvió a los ${x.dias} d${x.fallaBase?` · ${x.fallaBase} → ${x.fallaVuelta||'s/falla'}`:''}</span>
              <button class="btn-salir" style="padding:2px 8px;font-size:10.5px" onclick="analizarRebote(this,'${x.idBase}','${x.idVuelta}')" title="La IA compara lo que se hizo con el motivo de la vuelta">🤖 Analizar</button>
              <button class="btn-salir" style="padding:2px 8px;font-size:10.5px" onclick="descartarRebote('${x.idVuelta}')" title="La vuelta no es atribuible a este arreglo">No atribuir</button>
            </div>
            <div id="reb-det-${x.idVuelta}" style="display:none"></div>
            <div id="reb-ia-${x.idVuelta}"></div>
          </div>`).join('')}`:''}
        ${(descartes[f.n]||[]).length?`<div class="field-l" style="margin:10px 0 4px">Vueltas que NO cuentan</div>
          ${descartes[f.n].map(x=>`<div class="sub" style="font-size:11.5px;padding:2px 0;display:flex;gap:8px;align-items:center;opacity:.75" onclick="event.stopPropagation()">
            <span style="flex:1">↩̶ ${x.eq} ${x.uni} a los ${x.dias} d · ${x.por==='auto'?`otra falla (${x.fallaBase} ≠ ${x.fallaVuelta})`:`descartado a mano${x.motivo?': '+x.motivo:''}`}</span>
            ${x.por==='manual'?`<button class="btn-salir" style="padding:2px 8px;font-size:10.5px" onclick="restaurarRebote('${x.idVuelta}')">Restaurar</button>`:''}
          </div>`).join('')}`:''}
        <div class="sub" style="font-size:11px;margin-top:8px">🤖 Cada reparación se analiza al finalizarla: criticidad, falla, lo que hizo el taller y los repuestos → <b>1 punto ≈ 1 hora de mano de obra</b> (la espera de repuestos no cuenta). ✏️ podés corregir cualquier puntaje a mano. 📋 = sin analizar todavía, puntúa por la tabla de pesos. Aparte: preventivo +2 · dormida &gt;${PERF_DORMIDA_DIAS}d −2. La calidad no suma: habilita (≤${PERF_REINC_MAX}% en 90 d).</div>
      </div>`;
    return `<div class="panel" style="cursor:pointer;margin-bottom:10px${f.cumple?';border:1.5px solid var(--brote)':''}" onclick="perfOpen=perfOpen==='${f.n.replace(/'/g,"\\'")}'?null:'${f.n.replace(/'/g,"\\'")}';go('reparaciones')">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          <span class="sub mono">${i+1}</span>
          <div style="width:34px;height:34px;border-radius:50%;background:var(--brote-soft);color:var(--brote-2);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">${ini}</div>
          <div style="min-width:0"><div style="font-weight:600;font-size:13.5px">${f.n}</div>
            <div class="sub" style="font-size:11px">${f.M.nFin} finalizada${f.M.nFin===1?'':'s'}${f.M.nPrev?' · '+f.M.nPrev+' preventivo'+(f.M.nPrev===1?'':'s'):''} · ${abierto?'▲ cerrar detalle':'▼ ver por qué'}</div></div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="mono" style="font-weight:700;font-size:20px">${f.M.total} pts</div>${estado}
          <button class="btn-salir" style="padding:3px 9px;font-size:11px;margin-top:5px" onclick="event.stopPropagation();informeMecanico('${String(f.n).replace(/'/g,"\\'")}')" title="Informe imprimible para hablar con el mecánico">📄 Informe</button></div>
      </div>
      <div style="height:6px;background:var(--papel);border-radius:3px;margin:9px 0 6px"><div style="height:6px;width:${barra}%;background:${colBarra};border-radius:3px"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--tinta-2);flex-wrap:wrap;gap:4px">
        <span>Trabajo ${f.M.trabajo} · urgencias +${f.M.urgencia} · preventivos +${f.M.prev}</span>
        <span>${calidad}</span>
      </div>${motivo}${detalle}</div>`;};
  const cobran=filas.filter(f=>f.cumple), noCobran=filas.filter(f=>!f.cumple);
  const cards=`
  <div style="display:flex;gap:10px;margin-bottom:14px">
    <div style="flex:1;background:var(--brote-soft);border-radius:10px;padding:10px 14px;text-align:center">
      <div class="mono" style="font-size:22px;font-weight:700;color:var(--brote-2)">${cobran.length}</div>
      <div class="sub" style="font-size:11.5px">cobra${cobran.length===1?'':'n'} el bono</div></div>
    <div style="flex:1;background:#FCEBED;border-radius:10px;padding:10px 14px;text-align:center">
      <div class="mono" style="font-size:22px;font-weight:700;color:#A32D2D">${noCobran.length}</div>
      <div class="sub" style="font-size:11.5px">no cobra${noCobran.length===1?'':'n'} este mes</div></div>
  </div>
  ${cobran.length?`<div class="field-l" style="margin-bottom:8px;color:var(--brote-2)">✓ Cobran el bono</div>${cobran.map((f,i)=>cardPerf(f,i)).join('')}`:''}
  ${noCobran.length?`<div class="field-l" style="margin:${cobran.length?'14px':'0'} 0 8px;color:#A32D2D">✕ No cobran este mes</div>${noCobran.map((f,i)=>cardPerf(f,cobran.length+i)).join('')}`:''}`;

  view.innerHTML=`
  <div class="view-head"><div><div class="view-title">Reparaciones · Performance</div>
    <div class="view-desc">Ranking para el bono · solo administradores · click en cada mecánico para ver el porqué</div></div>
    <select class="busca" style="width:auto" onchange="perfPer=this.value;perfOpen=null;go('reparaciones')">
      ${meses.map(m=>`<option value="${m}" ${m===perfPer?'selected':''}>${mesStk(m)}</option>`).join('')}
    </select></div>
  ${tabsRep()}
  ${(()=>{const sa=filas.reduce((a,f)=>a+(f.M.sinAnalizar||0),0),fl=filas.reduce((a,f)=>a+(f.M.flojas||0),0);
    if(!sa&&!fl)return '';
    return `<div class="aviso-amarillo" style="margin-bottom:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span style="flex:1">${sa?`<b>${sa}</b> reparación/es todavía sin analizar (puntúan por la tabla de pesos). `:''}${fl?`<b>${fl}</b> se analizaron con pocos datos 🤖⚠ — conviene que el taller cargue qué hizo.`:''}</span>
      ${sa?`<button class="btn" style="padding:5px 12px;font-size:12px" onclick="event.stopPropagation();recalcularPuntajes()">🤖 Analizar pendientes</button>`:''}
    </div>`;})()}
  <div class="sub" style="margin-bottom:12px">Objetivo del mes: <b>${PERF_OBJETIVO} pts</b> (provisorio — se ajusta con 2-3 meses de datos) · para cobrar además la reincidencia de 90 días tiene que ser ≤ ${PERF_REINC_MAX}%.</div>
  ${cards||'<div class="empty" style="height:200px"><div>Sin reparaciones finalizadas en el período.</div></div>'}`;
}

/* ── Reparaciones · Repuestos: SEGUIMIENTO del circuito con Referente ──
   Acá se mira el circuito completo y la trazabilidad repuesto↔reparación↔
   unidad. SIN botón de aprobar: la decisión de gastar vive en Compras →
   Repuestos, para que la plata quede en un solo lugar. */
const REP_CIRC_EST={pedido:['pedido','#A32D2D','#FCEBED'],en_cotizacion:['en cotización','#B9770E','#FBF0DC'],
  cotizado:['cotizado','#3B7DC4','#E8F1FA'],a_comprar:['a comprar','#586B60','#F0F2EF'],
  comprado:['comprado','#586B60','#F0F2EF'],entregado:['entregado','#0F7E40','#E5F5EC']};
async function vRepRepuestos(view){
  view.innerHTML=tabsRep()+'<div class="cargando-v">Cargando circuito…</div>';
  let all=[];
  try{all=await api('/api/compras/repuestos');}
  catch(e){view.innerHTML=tabsRep()+`<div class="cargando-v">${e.message||'No pude cargar.'}</div>`;return;}
  circData=all;   // para los modales de edición/nota
  const dias=iso=>iso?Math.ceil((Date.now()-new Date(iso))/86400000):null;
  const MS30=30*86400000;
  const visibles=all.filter(p=>p.estado!=='entregado'||(p.entregado_at&&Date.now()-new Date(p.entregado_at)<MS30));
  const cnt=e=>visibles.filter(p=>p.estado===e).length;
  const activos=visibles.filter(p=>['pedido','en_cotizacion','cotizado'].includes(p.estado));
  const cotProm=(()=>{const xs=visibles.filter(p=>p.cotizado_at).map(p=>(new Date(p.cotizado_at)-new Date(p.created_at))/86400000).filter(x=>x>=0);
    return xs.length?Math.ceil(xs.reduce((a,b)=>a+b,0)/xs.length*10)/10&&Math.ceil(xs.reduce((a,b)=>a+b,0)/xs.length):null;})();
  const paradas=activos.filter(p=>(p.incidencias||{}).equipo_parado).length;
  const PESO={critico:3,alta:2,media:1,baja:0};
  const orden=[...visibles].sort((a,b)=>{
    const ORD={pedido:0,en_cotizacion:1,cotizado:2,a_comprar:3,comprado:4,entregado:5};
    const ia=a.incidencias||{},ib=b.incidencias||{};
    return (ORD[a.estado]-ORD[b.estado])||((ib.equipo_parado?1:0)-(ia.equipo_parado?1:0))||((PESO[ib.prioridad]||0)-(PESO[ia.prioridad]||0));
  });
  const filas=orden.map(p=>{
    const i=p.incidencias||{};
    const [etq,col,bg]=REP_CIRC_EST[p.estado]||[p.estado,'#586B60','#F0F2EF'];
    const d=dias(p.estado_desde||p.created_at);
    const it=(p.items||[])[0]||{};
    const urg=i.equipo_parado||i.prioridad==='critico'||i.prioridad==='alta';
    const tope=!urg&&['pedido','en_cotizacion'].includes(p.estado)&&d>3;
    const sub=p.estado==='cotizado'?'esperando aprobación'
      :p.pieza_en_proveedor?'🏪 pieza en el proveedor desde el '+p.pieza_en_proveedor.slice(8,10)+'/'+p.pieza_en_proveedor.slice(5,7)
      :p.estado==='pedido'?'esperando cotización'
      :tope?'⚠ pasó el tope de 3 días hábiles':'';
    const aprob=p.aprobado_at?`<div style="margin-top:3px"><span class="badge b-green">✓ APROBADO</span> <span class="sub" style="font-size:10.5px">por ${p.aprobado_por||'—'} · ${fechaAR(p.aprobado_at)}</span></div>`:'';
    const txtBusca=[(p.items||[]).map(x=>(x.descripcion||'')+' '+(x.codigo||'')).join(' '),p.marca_modelo,i.numero_unidad,i.tipo_equipo,(i.equipos&&i.equipos.nombre),(i.mecanicos&&i.mecanicos.nombre),p.pedido_por,p.nota_proveedor,p.cotizado_por,p.estado,p.nota,p.observacion].filter(Boolean).join(' ').toLowerCase();
    return `<tr class="circ-fila" data-busca="${txtBusca.replace(/"/g,'&quot;')}">
      <td style="${urg?'border-left:4px solid var(--rojo);padding-left:10px':tope?'border-left:4px solid #E8B96A;padding-left:10px':''}"><b>${it.descripcion||'—'}</b>${(p.items||[]).length>1?` <span class="sub">+${p.items.length-1}</span>`:''}
        <div class="sub" style="font-size:11px">${p.marca_modelo?p.marca_modelo+' · ':''}${p.foto_ruta?'📷 ✓':p.sin_foto_motivo?'identificado sin foto':''}${it.codigo?' · '+it.codigo:''}
        ${p.foto_ruta?` <a href="#" onclick="event.preventDefault();rtVerArchivo('${p.id}','foto')" style="color:var(--azul)">ver foto</a>`:''}</div>
        ${p.nota?`<div class="sub" style="font-size:11px;font-style:italic;margin-top:2px">💬 ${p.nota}</div>`:''}</td>
      <td><span class="uni-num">${i.numero_unidad||'—'}</span> ${i.tipo_equipo||(i.equipos&&i.equipos.nombre)||''}
        ${i.equipo_parado?'<span class="badge" style="background:#FCEBED;color:#A32D2D;font-size:9.5px">⛔ parada</span>':''}
        <div class="sub" style="font-size:11px">${i.id?'rep. #'+String(i.id).slice(0,6):''}</div></td>
      <td style="font-size:12.5px;font-weight:500">${i.mecanicos?i.mecanicos.nombre:(p.pedido_por||'—')}</td>
      <td><span class="badge" style="background:${bg};color:${col}">${etq}</span>
        ${aprob}
        ${p.observacion&&['pedido','en_cotizacion'].includes(p.estado)?`<div class="sub" style="font-size:10.5px;margin-top:2px;color:#854F0B">↩ Observado: ${p.observacion}</div>`:''}
        ${sub?`<div class="sub" style="font-size:10.5px;margin-top:2px;${tope?'color:#854F0B':''}">${sub}</div>`:''}
        ${p.nota_proveedor?`<div class="sub" style="font-size:10.5px;margin-top:2px">📝 ${p.nota_proveedor} · <b class="mono">${money(p.nota_precio||0)}</b> · ${p.nota_plazo||''}${p.cotizado_por?' · cotizó '+p.cotizado_por:''}</div>`:''}</td>
      <td class="num mono" style="${d>3?'color:#A32D2D;font-weight:600':''}">${d!=null?d+' d':'—'}</td>
      <td class="num" style="white-space:nowrap">
        ${p.estado==='pedido'?`<button class="mini-btn" onclick="circAccion('${p.id}','tomar')">▶ Tomar</button>`:''}
        ${['en_cotizacion','cotizado'].includes(p.estado)?`<button class="mini-btn" onclick="circNota('${p.id}')">📝 ${p.nota_proveedor?'Corregir nota':'Nota'}</button>`:''}
        ${p.estado==='en_cotizacion'?`<button class="mini-btn" title="${p.pieza_en_proveedor?'Quitar la marca':'La pieza quedó en el proveedor'}" onclick="circAccion('${p.id}','pieza_proveedor'${p.pieza_en_proveedor?",true":""})">🏪</button>`:''}
        ${p.estado!=='entregado'?`<button class="mini-btn" title="Editar repuestos" onclick="circEditar('${p.id}')">✏️</button>
          <button class="mini-btn" title="Eliminar pedido" style="color:var(--rojo)" onclick="circEliminar('${p.id}')">🗑</button>`:''}
      </td>
    </tr>`;}).join('');
  view.innerHTML=`
  <div class="view-head"><div><div class="view-title">Reparaciones · Repuestos</div>
    <div class="view-desc">El circuito del taller: del pedido del mecánico a la entrega · la aprobación vive en Compras → Repuestos</div></div></div>
  ${tabsRep()}
  <div class="panel" style="margin-bottom:14px">
    <div style="display:flex;gap:7px;flex-wrap:wrap">
      ${[['pedido','#A32D2D','#FCEBED'],['en_cotizacion','#B9770E','#FBF0DC'],['cotizado','#3B7DC4','#E8F1FA'],['a_comprar','',''],['comprado','',''],['entregado','#0F7E40','#E5F5EC']].map(([e,col,bg])=>`
        <div style="flex:1;min-width:76px;border-radius:9px;padding:9px 6px;text-align:center;background:${bg||'var(--hueso)'};border:1px solid var(--linea)">
          <div class="mono" style="font-weight:700;font-size:18px;${col?'color:'+col:''}">${cnt(e)}</div>
          <div style="font-size:10px;color:${col||'var(--tinta-3)'}">${(REP_CIRC_EST[e]||[e])[0]}${e==='entregado'?' 30d':''}</div>
        </div>`).join('')}
    </div>
    <div class="sub" style="font-size:11.5px;margin-top:8px">⏱ pedido→cotizado prom.: <b class="mono">${cotProm!=null?cotProm+' d':'—'}</b> · máquinas paradas esperando repuesto: <b class="mono" style="${paradas?'color:#A32D2D':''}">${paradas}</b></div>
  </div>
  ${(()=>{  // 💰 Presupuesto: lo aprobado (con su mes) para dimensionar el gasto futuro
    const conPrecio=all.filter(p=>p.nota_precio&&p.aprobado_at);
    if(!conPrecio.length)return '';
    const porMes={};
    conPrecio.forEach(p=>{const m=String(p.aprobado_at).slice(0,7);porMes[m]=porMes[m]||{n:0,total:0};porMes[m].n++;porMes[m].total+=Number(p.nota_precio)||0;});
    const meses=Object.entries(porMes).sort((a,b)=>b[0].localeCompare(a[0]));
    const cotSin=all.filter(p=>p.estado==='cotizado'&&p.nota_precio).reduce((s,p)=>s+(Number(p.nota_precio)||0),0);
    return `<div class="panel" style="margin-bottom:14px">
      <div class="panel-title">💰 Gasto en repuestos por mes <span class="sub" style="font-weight:400;font-size:11px">· órdenes aprobadas por mes de aprobación · base para el presupuesto</span></div>
      <table style="font-size:12.5px;max-width:520px"><thead><tr><th>Mes</th><th class="num">Órdenes</th><th class="num">Total aprobado</th></tr></thead>
      <tbody>${meses.map(([m,v])=>`<tr><td>${mesStk(m)}</td><td class="num mono">${v.n}</td><td class="num mono" style="font-weight:600">${money(v.total)}</td></tr>`).join('')}</tbody></table>
      ${cotSin?`<div class="sub" style="font-size:11.5px;margin-top:7px">Además hay <b class="mono">${money(cotSin)}</b> cotizados esperando tu aprobación (no suman hasta que apruebes).</div>`:''}
    </div>`;})()}
  <div class="panel">
    <div class="panel-title" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <span>Circuito en curso <span class="sub" style="font-weight:400;font-size:11px">· ordenado por etapa y urgencia</span></span>
      <input class="busca" type="text" placeholder="Buscar repuesto, unidad, mecánico, proveedor…" style="width:290px;font-size:12.5px" oninput="circBuscar(this.value)">
    </div>
    ${visibles.length?`<table style="font-size:12.5px">
      <thead><tr><th>Repuesto</th><th>Máquina</th><th>Mecánico</th><th>Estado</th><th class="num">Días en estado</th><th></th></tr></thead>
      <tbody>${filas}</tbody></table>`:'<div class="sub" style="padding:12px 0">No hay repuestos en el circuito.</div>'}
  </div>`;
}
// Buscador del circuito: filtra las filas ya renderizadas (no pierde el foco)
function circBuscar(q){
  q=String(q||'').toLowerCase().trim();
  document.querySelectorAll('.circ-fila').forEach(tr=>{
    tr.style.display=!q||tr.dataset.busca.includes(q)?'':'none';
  });
}
// Acciones del Referente desde el panel: tomar → en cotización; nota → cotizado
async function circAccion(id,accion,quitar){
  try{
    await api('/api/compras/repuestos/'+id+'/referente',{method:'POST',body:JSON.stringify({accion,quitar:!!quitar})});
    toast('Listo ✓');go('reparaciones');
  }catch(e){toast(e.message||'No pude','error');}
}
// Editar los repuestos del pedido (por si se confundieron al cargar)
let circData=null;   // cache de la última carga de /api/compras/repuestos en esta vista
function circEditar(id){
  const p=(circData||[]).find(x=>String(x.id)===String(id));if(!p)return;
  const filas=(p.items&&p.items.length?p.items:[{}]).map(x=>`<div style="display:flex;gap:5px;margin-bottom:5px">
    <input class="ce-cant" type="text" inputmode="numeric" value="${x.cantidad||1}" style="width:46px;text-align:center">
    <input class="ce-desc" type="text" placeholder="Repuesto" value="${String(x.descripcion||'').replace(/"/g,'&quot;')}" style="flex:2">
    <input class="ce-cod" type="text" placeholder="Código" value="${String(x.codigo||'').replace(/"/g,'&quot;')}" style="flex:1">
    <button class="mini-btn" onclick="this.parentElement.remove()">✕</button>
  </div>`).join('');
  const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=210;
  bg.innerHTML=`<div class="modal" style="max-width:480px">
    <div class="modal-tit">✏️ Editar pedido</div>
    <div class="sub" style="margin:4px 0 10px;font-size:12px">Corregí lo que haga falta — los tildes de comprado se conservan por descripción.</div>
    <div id="ce-filas">${filas}</div>
    <button class="mini-btn" onclick="document.getElementById('ce-filas').insertAdjacentHTML('beforeend','<div style=\'display:flex;gap:5px;margin-bottom:5px\'><input class=ce-cant type=text value=1 style=\'width:46px;text-align:center\'><input class=ce-desc type=text placeholder=Repuesto style=flex:2><input class=ce-cod type=text placeholder=Código style=flex:1><button class=mini-btn onclick=this.parentElement.remove()>✕</button></div>')">＋ otra fila</button>
    <div class="mm-field" style="margin-top:8px"><label>Marca / modelo del equipo</label><input id="ce-marca" type="text" value="${String(p.marca_modelo||'').replace(/"/g,'&quot;')}" style="width:100%"></div>
    <div class="modal-acciones">
      <button class="btn-salir" id="ce-cancel">Cancelar</button>
      <button class="btn" id="ce-ok">Guardar cambios</button>
    </div></div>`;
  document.body.appendChild(bg);
  bg.querySelector('#ce-cancel').onclick=()=>bg.remove();
  bg.querySelector('#ce-ok').onclick=async()=>{
    const items=[...bg.querySelectorAll('#ce-filas > div')].map(f=>({
      cantidad:Number(f.querySelector('.ce-cant').value)||1,
      descripcion:f.querySelector('.ce-desc').value.trim(),
      codigo:f.querySelector('.ce-cod').value.trim(),
      comprado:(p.items||[]).some(x=>x.comprado&&String(x.descripcion||'').toLowerCase()===f.querySelector('.ce-desc').value.trim().toLowerCase()),
    })).filter(x=>x.descripcion);
    if(!items.length){toast('Tiene que quedar al menos un repuesto','error');return;}
    try{
      await api('/api/compras/repuestos/'+id+'/referente',{method:'POST',body:JSON.stringify({accion:'descripcion',items,marca_modelo:bg.querySelector('#ce-marca').value})});
      bg.remove();toast('Pedido corregido ✓');go('reparaciones');
    }catch(e){toast(e.message||'No pude guardar','error');}
  };
}
async function circEliminar(id){
  if(!await uiConfirm('Se elimina del circuito y no se puede deshacer. Si la reparación sigue necesitando el repuesto, el mecánico lo vuelve a pedir.','🗑 ¿Eliminar el pedido?',{ok:'Eliminar',danger:true}))return;
  try{
    await api('/api/compras/repuestos/'+id,{method:'DELETE'});
    toast('Pedido eliminado');go('reparaciones');
  }catch(e){toast(e.message||'No pude eliminar','error');}
}
function circNota(id){
  const p=(circData||[]).find(x=>String(x.id)===String(id))||{};
  const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=210;
  bg.innerHTML=`<div class="modal" style="max-width:400px">
    <div class="modal-tit">📝 Nota de pedido</div>
    <div class="sub" style="margin:4px 0 12px;font-size:12px">Proveedor + precio + plazo. La carga acá ES la cotización válida (de palabra vale). Al guardar pasa a COTIZADO y queda esperando la aprobación.</div>
    <div class="mm-field"><label>Proveedor recomendado</label><input id="cn-prov" type="text" value="${String(p.nota_proveedor||'').replace(/"/g,'&quot;')}" style="width:100%"></div>
    <div style="display:flex;gap:8px">
      <div class="mm-field" style="flex:1"><label>Precio final $</label><input id="cn-precio" type="text" inputmode="decimal" value="${p.nota_precio!=null?String(p.nota_precio).replace('.',','):''}" style="width:100%"></div>
      <div class="mm-field" style="flex:1"><label>Plazo</label><input id="cn-plazo" type="text" placeholder="ej: 48 hs" value="${String(p.nota_plazo||'').replace(/"/g,'&quot;')}" style="width:100%"></div>
    </div>
    <div class="modal-acciones">
      <button class="btn-salir" id="cn-cancel">Cancelar</button>
      <button class="btn" id="cn-ok">Guardar → COTIZADO</button>
    </div></div>`;
  document.body.appendChild(bg);
  setTimeout(()=>{const i=bg.querySelector('#cn-prov');if(i)i.focus();},50);
  bg.querySelector('#cn-cancel').onclick=()=>bg.remove();
  bg.querySelector('#cn-ok').onclick=async()=>{
    const v=k=>(bg.querySelector('#cn-'+k).value||'').trim();
    if(!v('prov')||!v('precio')||!v('plazo')){toast('Completá proveedor, precio y plazo','error');return;}
    try{
      await api('/api/compras/repuestos/'+id+'/referente',{method:'POST',body:JSON.stringify({accion:'nota',proveedor:v('prov'),precio:v('precio'),plazo:v('plazo')})});
      bg.remove();toast('Nota guardada → COTIZADO ✓');go('reparaciones');
    }catch(e){toast(e.message||'No pude guardar','error');}
  };
}
async function rtVerArchivo(id,tipo){
  try{const r=await api('/api/compras/repuestos/'+id+'/archivo?tipo='+tipo);window.open(r.url,'_blank');}
  catch(e){toast('No pude abrir el archivo','error');}
}

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

  // Resolución promedio (creada → finalizada), SOLO correctivas: las preventivas
  // se programan con anticipación y distorsionarían el tiempo real de taller.
  const tiempos=finCorr.map(r=>diasEntre(r.created_at,r.fecha_finalizado)).filter(t=>t!=null);
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

  // Reincidencia: la misma unidad vuelve como correctivo dentro de 30 días de
  // una finalización. Se busca la vuelta DENTRO DEL MISMO PERÍODO filtrado (fs),
  // no contra toda la base, para que el % sea coherente con lo que se mira.
  // OJO: cuenta cualquier regreso de la unidad, sea o no la misma falla.
  const finConUni=finalizadas.filter(r=>r.fecha_finalizado&&normU(r.numero_unidad));
  let reinc=0;
  finConUni.forEach(f=>{
    const k=normU(f.numero_unidad),ff=new Date(f.fecha_finalizado).getTime();
    if(fs.some(o=>o.id!==f.id&&!esPrev(o)&&normU(o.numero_unidad)===k&&(()=>{const c=new Date(o.created_at).getTime();return c>ff&&c-ff<=30*86400000;})()))reinc++;
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

  // ── TALLER AHORA: lo accionable. Sobre TODAS las activas del presente
  // (no el filtro de mes): una máquina abierta hace 20 días es un problema de
  // hoy aunque se haya creado en otro período.
  const ETIQ_EST={pendiente:'Pendiente',diagnostico:'Diagnóstico',esperando_repuestos:'Esp. repuestos',en_reparacion:'En reparación'};
  const fechaEstado=r=>({diagnostico:r.fecha_diagnostico,esperando_repuestos:r.fecha_espera_repuestos,en_reparacion:r.fecha_en_reparacion}[r.estado])||r.created_at;
  const hoyMs=Date.now();
  // Filtro por mecánico: aplica a "Qué atender hoy" y "Trabado ahora"
  const mecsAbiertas=[...new Set(todas.map(r=>r.mecanicos?r.mecanicos.nombre:'Sin asignar'))].sort();
  // La base cambia según el filtro: para ver la trazabilidad de una
  // reparación TERMINADA hay que poder listarla, no solo las abiertas.
  // Atajos de fecha sobre las finalizadas: "hoy" es el caso más pedido
  // (¿qué salió del taller hoy?), y el rango libre para lo demás.
  const hoyISO=new Date().toLocaleDateString('sv-SE');
  const cerroEn=(r,d1,d2)=>{
    if(!r.fecha_finalizado)return false;
    const f=String(r.fecha_finalizado).slice(0,10);
    return (!d1||f>=d1)&&(!d2||f<=d2);
  };
  let baseInd;
  if(repIndEst==='hoy')            baseInd=todas.filter(r=>r.estado==='finalizado'&&cerroEn(r,hoyISO,hoyISO));
  else if(repIndEst==='finalizadas')baseInd=todas.filter(r=>r.estado==='finalizado'&&cerroEn(r,repIndD1,repIndD2));
  else if(repIndEst==='todas')      baseInd=todas;
  else                              baseInd=todas.filter(r=>r.estado!=='finalizado');
  const objsAbiertas=[...new Set(baseInd.map(r=>r.objetivos?r.objetivos.nombre:'Sin objetivo'))].sort();
  // El buscador entra por equipo, unidad, descripción, falla, objetivo,
  // mecánico y capataz: cualquier cosa que uno recuerde de la incidencia.
  const qInd=repIndQ.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/\s+/).filter(Boolean);
  const matchInd=r=>{
    if(!qInd.length)return true;
    const blob=`${r.tipo_equipo||''} ${r.equipos?r.equipos.nombre:''} ${r.numero_unidad||''} ${r.descripcion||''} ${r.tipo_falla||''} ${r.objetivos?r.objetivos.nombre:''} ${r.mecanicos?r.mecanicos.nombre:''} ${r.capataces?r.capataces.nombre:''}`
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    return qInd.every(w=>blob.includes(w));
  };
  const abiertas=baseInd
    .filter(r=>!repIndMec||(r.mecanicos?r.mecanicos.nombre:'Sin asignar')===repIndMec)
    .filter(r=>!repIndObj||(r.objetivos?r.objetivos.nombre:'Sin objetivo')===repIndObj)
    .filter(r=>!repIndPrio||(repIndPrio==='parada'?r.equipo_parado:String(r.prioridad||'').toLowerCase()===repIndPrio))
    .filter(matchInd).map(r=>{
    // En una finalizada los días se cuentan hasta el CIERRE, no hasta hoy:
    // si no, una reparación de enero figuraría como "abierta hace 200 días".
    const fin=r.estado==='finalizado'&&r.fecha_finalizado?r.fecha_finalizado:new Date().toISOString();
    const dAb=diasEntre(r.created_at,fin);
    const dEst=diasEntre(fechaEstado(r),fin);
    return {r,dAb:dAb!=null?dAb:0,dEst:dEst!=null?dEst:0};
  });
  // Orden de ataque: parada > prioridad > días abierta
  const PESO_PRIO={critico:3,alta:2,media:1,baja:0};
  // Abiertas: se ordenan por urgencia (parada > prioridad > días).
  // Finalizadas: por fecha de cierre, las últimas primero — lo urgente ya pasó.
  if(repIndEst==='finalizadas'||repIndEst==='hoy'){
    abiertas.sort((a,b)=>new Date(b.r.fecha_finalizado||0)-new Date(a.r.fecha_finalizado||0));
  }else{
    abiertas.sort((a,b)=>((b.r.equipo_parado?1:0)-(a.r.equipo_parado?1:0))||((PESO_PRIO[b.r.prioridad]||0)-(PESO_PRIO[a.r.prioridad]||0))||(b.dAb-a.dAb));
  }
  const colDias=d=>d>=7?'color:#A32D2D;font-weight:700':d>=3?'color:#854F0B;font-weight:600':'';
  const tablaAbiertas=abiertas.map(({r,dAb,dEst})=>{
    const prio=r.prioridad==='critico'?'<span class="badge" style="background:#FCEBED;color:#A32D2D">crítico</span>'
      :r.prioridad==='alta'?'<span class="badge b-amber">alta</span>'
      :`<span class="badge b-gray">${r.prioridad||'—'}</span>`;
    return `<tr class="fila" onclick="abrirTrazabilidad('${r.id}')" style="cursor:pointer" title="ver la trazabilidad">
      <td><div style="font-weight:600">${r.tipo_equipo||(r.equipos?r.equipos.nombre:'—')}</div>
        <div class="sub" style="font-size:11px;max-width:230px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.descripcion||r.falla||''}</div></td>
      <td><span class="uni-num">${r.numero_unidad||'—'}</span></td>
      <td>${prio}${r.equipo_parado?'<div class="badge" style="background:#FCEBED;color:#A32D2D;font-size:9.5px;margin-top:3px">⛔ parada</div>':''}</td>
      <td>${r.estado==='finalizado'
        ?(r.motivo_cierre
          ?`<span class="badge b-amber" style="font-size:10px">📭 ${escStk(MOTIVO_CIERRE_CORTO[r.motivo_cierre]||'sin reparar')}</span>`
          :'<span class="badge b-green" style="font-size:10px">✓ finalizada</span>')
        :(ETIQ_EST[r.estado]||r.estado)}</td>
      <td class="num mono" style="${r.estado==='finalizado'?'':colDias(dEst)}">${r.estado==='finalizado'?(r.fecha_finalizado?fechaAR(r.fecha_finalizado):'—'):Math.ceil(dEst)+' d'}</td>
      <td class="num mono" style="${r.estado==='finalizado'?'':colDias(dAb)}">${Math.ceil(dAb)} d</td>
      <td style="font-size:12px">${r.mecanicos?r.mecanicos.nombre:'<span class="sub">sin asignar</span>'}</td>
    </tr>`;}).join('');

  // Trabas por estado AHORA: cuántas hay en cada etapa y hace cuánto están ahí
  const trabas=Object.keys(ETIQ_EST).map(est=>{
    const enEst=abiertas.filter(x=>x.r.estado===est);
    if(!enEst.length)return null;
    const prom=enEst.reduce((s,x)=>s+x.dEst,0)/enEst.length;
    const peor=enEst.reduce((m,x)=>x.dEst>m.dEst?x:m,enEst[0]);
    return {est,n:enEst.length,prom,peor};
  }).filter(Boolean);
  const maxTraba=Math.max(...trabas.map(t=>t.prom),0.1);
  const htmlTrabas=trabas.length?trabas.map(t=>{
    const w=Math.max(3,Math.round(t.prom*100/maxTraba));
    const rojo=t.prom>=5;
    return `<div style="margin-bottom:11px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
        <b style="font-weight:500">${ETIQ_EST[t.est]} <span class="sub">(${t.n})</span></b>
        <span class="mono" style="${rojo?'color:#A32D2D;font-weight:700':''}">${Math.ceil(t.prom)} d prom.</span></div>
      <div style="height:6px;background:var(--papel);border-radius:3px"><div style="height:6px;width:${w}%;background:${rojo?'#A32D2D':'var(--diesel)'};border-radius:3px"></div></div>
      <div class="sub" style="font-size:10.5px;margin-top:2px">Peor: ${peorTxt(t.peor)}</div>
    </div>`;}).join('')
    :'<div class="sub" style="padding:10px 0">No hay máquinas abiertas ahora 🎉</div>';
  function peorTxt(x){return (x.r.tipo_equipo||'—')+' '+(x.r.numero_unidad||'')+' · '+Math.ceil(x.dEst)+' d en este estado';}

  // Detalle de máquinas que volvieron al taller (misma unidad en 30 días, en el período)
  const reincidencias=[];
  finConUni.forEach(f=>{
    const k=normU(f.numero_unidad),ff=new Date(f.fecha_finalizado).getTime();
    const vuelta=fs.filter(o=>o.id!==f.id&&!esPrev(o)&&normU(o.numero_unidad)===k)
      .map(o=>({o,c:new Date(o.created_at).getTime()}))
      .filter(x=>x.c>ff&&x.c-ff<=30*86400000)
      .sort((a,b)=>a.c-b.c)[0];
    if(vuelta)reincidencias.push({
      eq:f.tipo_equipo||(f.equipos?f.equipos.nombre:'—'), uni:f.numero_unidad,
      falla:vuelta.o.descripcion||vuelta.o.falla||'—',
      dias:Math.round((vuelta.c-ff)/86400000),
      mec:f.mecanicos?f.mecanicos.nombre:'Sin asignar'});
  });
  reincidencias.sort((a,b)=>a.dias-b.dias);
  const tablaReinc=reincidencias.slice(0,10).map(x=>`<tr>
    <td><div style="font-weight:500">${x.eq}</div></td>
    <td><span class="uni-num">${x.uni}</span></td>
    <td style="font-size:11.5px;max-width:200px">${x.falla.length>50?x.falla.slice(0,50)+'…':x.falla}</td>
    <td class="num">${x.dias} d</td>
    <td style="font-size:12px">${x.mec}</td></tr>`).join('');

  // Incidencias por objetivo: qué objetivo genera más taller. Días de taller =
  // resolución real de las finalizadas + lo que llevan abiertas las activas.
  const porObj={};
  fs.filter(r=>!esPrev(r)).forEach(r=>{
    const k=r.objetivos?r.objetivos.nombre:'Taller / sin objetivo';
    porObj[k]=porObj[k]||{n:0,unis:new Set(),paradas:0,dias:0,peor:null};
    const o=porObj[k];o.n++;
    if(r.numero_unidad)o.unis.add(normU(r.numero_unidad));
    if(r.equipo_parado)o.paradas++;
    const d=r.estado==='finalizado'?diasEntre(r.created_at,r.fecha_finalizado):diasEntre(r.created_at,new Date().toISOString());
    if(d!=null){o.dias+=d;if(!o.peor||d>o.peor.d)o.peor={d,eq:r.tipo_equipo||'—',uni:r.numero_unidad||''};}
  });
  const objsTop=Object.entries(porObj).sort((a,b)=>b[1].n-a[1].n||b[1].dias-a[1].dias);
  const maxObjN=objsTop.length?objsTop[0][1].n:1;
  const tablaObj=objsTop.map(([nom,v],i)=>`<tr>
    <td class="sub mono" style="width:24px">${i+1}</td>
    <td><div style="font-weight:500">${nom}</div>
      <div style="height:4px;background:var(--papel);border-radius:2px;margin-top:4px;max-width:220px"><div style="height:4px;width:${Math.max(4,Math.round(v.n*100/maxObjN))}%;background:var(--diesel);border-radius:2px"></div></div></td>
    <td class="num" style="font-weight:600;${v.n>=5?'color:#A32D2D':''}">${v.n}</td>
    <td class="num sub">${v.unis.size||'—'}</td>
    <td class="num sub" style="${v.paradas?'color:#A32D2D':''}">${v.paradas||'—'}</td>
    <td class="num mono">${Math.ceil(v.dias)} d</td>
    <td class="sub" style="font-size:11px">${v.peor?v.peor.eq+' '+v.peor.uni+' · '+Math.ceil(v.peor.d)+' d':'—'}</td>
  </tr>`).join('');

  view.innerHTML=`
  <div class="view-head"><div><div class="view-title">Reparaciones · Indicadores</div>
    <div class="view-desc">Servicio sobre toda la maquinaria: correctivo, preventivo y flujo del taller</div></div>
    <select class="busca" style="width:auto" onchange="repIndPer=this.value;go('reparaciones')">
      <option value="">Todo el período</option>
      ${meses.map(m=>`<option value="${m}" ${m===repIndPer?'selected':''}>${mesStk(m)}</option>`).join('')}
    </select></div>
  ${tabsRep()}
  <div class="grid" style="display:grid;grid-template-columns:2fr 1fr;gap:13px;margin-bottom:18px">
    <div class="panel"><div class="panel-title" style="display:flex;justify-content:space-between;align-items:center;gap:10px">
      <span>${repIndEst==='hoy'?'Terminadas hoy':repIndEst==='finalizadas'?'Reparaciones terminadas':repIndEst==='todas'?'Todas las reparaciones':'Qué atender hoy'}
        <span class="sub" style="font-weight:400;font-size:11px">· ${abiertas.length} ${
          repIndEst==='hoy'?'salieron del taller hoy'
          :repIndEst==='finalizadas'?(repIndD1||repIndD2?`en el rango elegido`:'finalizadas · las últimas primero')
          :repIndEst==='todas'?'en total':'abiertas · paradas y críticas primero'} · tocá una fila para ver su trazabilidad</span></span>
      ${repIndMec||repIndObj||repIndPrio||repIndQ?`<button class="btn ghost" style="padding:4px 10px;font-size:11.5px" onclick="repIndMec='';repIndObj='';repIndPrio='';repIndQ='';go('reparaciones')">✕ limpiar filtros</button>`:''}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        <select class="busca" style="width:auto;font-size:12px;padding:5px 8px" onchange="repIndEst=this.value;go('reparaciones')">
          <option value="abiertas" ${repIndEst==='abiertas'?'selected':''}>Abiertas</option>
          <option value="hoy" ${repIndEst==='hoy'?'selected':''}>✓ Finalizadas hoy</option>
          <option value="finalizadas" ${repIndEst==='finalizadas'?'selected':''}>Finalizadas · elegir fechas</option>
          <option value="todas" ${repIndEst==='todas'?'selected':''}>Todas</option>
        </select>
        ${repIndEst==='finalizadas'?`
          <span class="sub" style="font-size:12px;align-self:center">del</span>
          <input type="date" class="busca" style="width:auto;font-size:12px;padding:5px 8px" value="${repIndD1}" max="${hoyISO}"
            onchange="repIndD1=this.value;go('reparaciones')">
          <span class="sub" style="font-size:12px;align-self:center">al</span>
          <input type="date" class="busca" style="width:auto;font-size:12px;padding:5px 8px" value="${repIndD2}" max="${hoyISO}"
            onchange="repIndD2=this.value;go('reparaciones')">
          ${repIndD1||repIndD2?`<button class="btn ghost" style="padding:4px 9px;font-size:11.5px" onclick="repIndD1='';repIndD2='';go('reparaciones')">✕ fechas</button>`:''}
        `:''}
        <select class="busca" style="width:auto;font-size:12px;padding:5px 8px" onchange="repIndMec=this.value;go('reparaciones')">
          <option value="">Todos los mecánicos</option>
          ${mecsAbiertas.map(m=>`<option value="${m.replace(/"/g,'&quot;')}" ${repIndMec===m?'selected':''}>${m}</option>`).join('')}
        </select>
        <select class="busca" style="width:auto;font-size:12px;padding:5px 8px" onchange="repIndObj=this.value;go('reparaciones')">
          <option value="">Todos los objetivos</option>
          ${objsAbiertas.map(o=>`<option value="${o.replace(/"/g,'&quot;')}" ${repIndObj===o?'selected':''}>${o}</option>`).join('')}
        </select>
        <select class="busca" style="width:auto;font-size:12px;padding:5px 8px" onchange="repIndPrio=this.value;go('reparaciones')">
          <option value="">Toda criticidad</option>
          <option value="parada" ${repIndPrio==='parada'?'selected':''}>⛔ Solo máquinas paradas</option>
          <option value="critico" ${repIndPrio==='critico'?'selected':''}>Crítica</option>
          <option value="alta" ${repIndPrio==='alta'?'selected':''}>Alta</option>
          <option value="media" ${repIndPrio==='media'?'selected':''}>Media</option>
          <option value="baja" ${repIndPrio==='baja'?'selected':''}>Baja</option>
        </select>
        <input id="ind-q" class="busca" style="flex:1;min-width:170px;font-size:12px;padding:5px 9px"
          placeholder="Buscar equipo, unidad, falla, objetivo…" value="${escStk(repIndQ)}" oninput="indBuscar(this.value)">
      </div>
      ${abiertas.length?`<table style="font-size:12px"><thead><tr><th>Equipo</th><th>Unidad</th><th>Prioridad</th><th>Estado</th><th class="num">${repIndEst==='finalizadas'||repIndEst==='hoy'?'Cerró el':'En este estado'}</th><th class="num">${repIndEst==='finalizadas'||repIndEst==='hoy'?'Tardó':'Abierta hace'}</th><th>Mecánico</th></tr></thead>
      <tbody>${tablaAbiertas}</tbody></table>`:`<div class="sub" style="padding:12px 0">${repIndMec||repIndObj||repIndPrio||repIndQ?'Nada con esos filtros.':(repIndEst==='hoy'?'Todavía no se terminó ninguna hoy.':repIndEst==='finalizadas'?(repIndD1||repIndD2?'Ninguna se cerró en esas fechas.':'Todavía no hay reparaciones terminadas.'):'No hay máquinas abiertas 🎉')}</div>`}
      ${bloqueHistorialMaquinas(todas)}
    </div>
    <div class="panel"><div class="panel-title">Trabado ahora <span class="sub" style="font-weight:400;font-size:11px">· abiertas por etapa y hace cuánto</span></div>${htmlTrabas}
      ${(()=>{  // Máquinas con más de 7 días abiertas: lo que ya no puede esperar
        const viejas=abiertas.filter(x=>x.dAb>7).sort((a,b)=>b.dAb-a.dAb);
        if(!viejas.length)return '';
        return `<div class="divider" style="margin:12px 0 8px"></div>
        <div class="field-l" style="margin-bottom:6px;color:#A32D2D">⏰ Más de 7 días abiertas (${viejas.length})</div>
        ${viejas.map(({r,dAb})=>`<div onclick="abrirTrazabilidad('${r.id}')" style="padding:6px 0;border-bottom:1px dashed var(--linea);font-size:12px;cursor:pointer" title="ver la trazabilidad">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <b style="font-weight:600">${r.tipo_equipo||'—'} ${r.numero_unidad||''}</b>
            <b class="mono" style="color:#A32D2D;white-space:nowrap">${Math.ceil(dAb)} d</b></div>
          <div class="sub" style="font-size:11px;margin-top:1px">${(r.descripcion||r.falla||'—').slice(0,60)}</div>
          <div class="sub" style="font-size:11px">${ETIQ_EST[r.estado]||r.estado} · ${r.mecanicos?r.mecanicos.nombre:'sin asignar'}</div>
        </div>`).join('')}`;})()}
      ${(()=>{  // Abiertas por mecánico: siempre sobre TODAS (ignora el filtro de arriba)
        const cnt={};
        todas.filter(r=>r.estado!=='finalizado').forEach(r=>{const k=r.mecanicos?r.mecanicos.nombre:'Sin asignar';cnt[k]=(cnt[k]||0)+1;});
        const lista=Object.entries(cnt).sort((a,b)=>b[1]-a[1]);
        if(!lista.length)return '';
        const max=lista[0][1];
        return `<div class="divider" style="margin:12px 0 8px"></div>
        <div class="field-l" style="margin-bottom:6px">Abiertas por mecánico</div>
        ${lista.map(([n,c])=>`<div style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px">
            <span style="${n==='Sin asignar'?'color:#854F0B':''}">${n}</span>
            <b class="mono" style="${c>=6?'color:#A32D2D':''}">${c}</b></div>
          <div style="height:5px;background:var(--papel);border-radius:3px"><div style="height:5px;width:${Math.max(4,Math.round(c*100/max))}%;background:${c>=6?'#A32D2D':'var(--brote)'};border-radius:3px"></div></div>
        </div>`).join('')}`;})()}
    </div>
  </div>
  <div class="panel" style="margin-bottom:18px"><div class="panel-title">Máquinas que volvieron al taller <span class="sub" style="font-weight:400;font-size:11px">· misma unidad en 30 días · verificá que sea la misma falla</span></div>
    <table style="font-size:12px"><thead><tr><th>Equipo</th><th>Unidad</th><th>Falla anterior</th><th class="num">Días entre visitas</th><th>Reparó (1ª vez)</th></tr></thead>
    <tbody>${tablaReinc||'<tr><td colspan="5" class="sub" style="padding:10px">Sin reincidencias en el período 🎉</td></tr>'}</tbody></table>
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
  <div class="panel"><div class="panel-title">Incidencias por objetivo <span class="sub" style="font-weight:400;font-size:11px">· correctivos del período · dónde se genera el taller</span></div>
    <table style="font-size:12px"><thead><tr><th></th><th>Objetivo</th><th class="num">Correctivos</th><th class="num">Unidades</th><th class="num">Paradas</th><th class="num">Días de taller</th><th>La más larga</th></tr></thead>
    <tbody>${tablaObj||'<tr><td colspan="7" class="sub" style="padding:10px">Sin datos</td></tr>'}</tbody></table>
  </div>
`;
}

async function vReparaciones(view){
  repDetalleAbierto=false;
  try{
    repData=await api('/api/reparaciones');
    if(repTab==='services'){vRepServices(view);return;}
    if(repTab==='preventivo'){vRepPreventivo(view);return;}
    if(repTab==='indicadores'){vRepInd(view);return;}
    if(repTab==='performance'){if(localStorage.getItem('eco_admin')==='1'){vRepPerf(view);return;}repTab='resumen';}
    // Repuestos se mudó a Compras→Repuestos: vRepRepuestos queda sin acceso
    // (no se borró, por si hace falta volver).
    renderReparaciones(view);
  }catch(e){view.innerHTML=`<div class="cargando-v">No pude cargar las reparaciones.</div>`;}
}
/* ── Alta manual de incidencia desde el panel ── */
let repAltaOpen=false,repAltaTipo='correctivo',repObjs=null;
const REP_ALTA_EQUIPOS=['Motoguadaña','Sopladora','Extensible','Camioneta','Tractor','Mini tractor','Giro cero','Desmalezadora','Hidro grúa','Camión','Otro'];
const repAltaTmp={eq:'',uni:'',obj:'',mec:'',prio:'',desc:''};
function repAltaLeer(){['eq','uni','obj','mec','prio','desc'].forEach(k=>{const el=document.getElementById('ra-'+k);if(el)repAltaTmp[k]=el.value;});}
/* Buscador de Reparaciones. Re-renderiza la vista entera (los contadores
   de la barra lateral tienen que seguir el filtro), así que hay que
   devolverle el foco al input o se pierde a cada letra. */
function repBuscar(v){
  repFQ=v;
  renderReparaciones(document.getElementById('view'));
  setTimeout(()=>{const i=document.getElementById('rep-q');
    if(i){i.focus();i.setSelectionRange(i.value.length,i.value.length);}},0);
}
function repLimpiarFiltros(){
  repFQ='';repFPrio='';repFMec='';repFObj='';repFIngreso='';
  renderReparaciones(document.getElementById('view'));
}

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
  // Buscador: entra por todo lo que uno puede recordar de una incidencia —
  // equipo, unidad, lo que describió el capataz, la falla, el objetivo y los
  // nombres. Multi-palabra y sin acentos.
  const nrm=t=>String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const qRep=nrm(repFQ).split(/\s+/).filter(Boolean);
  const matchRep=r=>{
    if(!qRep.length)return true;
    const blob=nrm(`${r.tipo_equipo||''} ${r.equipos?r.equipos.nombre:''} ${r.numero_unidad||''} ${r.descripcion||''} ${r.tipo_falla||''} ${r.objetivos?r.objetivos.nombre:''} ${r.mecanicos?r.mecanicos.nombre:''} ${r.capataces?r.capataces.nombre:''} ${r.nota_cierre||''}`);
    return qRep.every(w=>blob.includes(w));
  };
  const filtrada=base.filter(r=>
    (!repFIngreso||(repFIngreso==='sin'?!r.fecha_ingreso_taller:!!r.fecha_ingreso_taller))&&
    (!repFPrio||r.prioridad===repFPrio)&&
    (!repFMec||(repFMec==='__sin'?!r.mecanico_id:r.mecanico_id===repFMec))&&
    (!repFObj||(r.objetivos&&r.objetivos.nombre===repFObj))&&
    matchRep(r));
  const resumen={critico:cnt('prioridad','critico'),alta:cnt('prioridad','alta'),media:cnt('prioridad','media'),baja:cnt('prioridad','baja')};

  const activas=repData.filter(r=>r.estado!=='finalizado').length;
  // Cuántas máquinas están esperando bajar al taller: es la primera pregunta
  // de la mañana y hasta ahora había que contarlas a ojo.
  const fTaller=[['','Todas',base.length],
      ['sin','⇥ Sin ingresar',base.filter(r=>!r.fecha_ingreso_taller).length],
      ['en','🔧 Ya en el taller',base.filter(r=>!!r.fecha_ingreso_taller).length]]
    .map(([v,l,c])=>`<div class="frow ${repFIngreso===v?'on':''}" onclick="repFIngreso='${v}';renderReparaciones(document.getElementById('view'))"><span>${l}</span><span class="fc">${c}</span></div>`).join('');
  const fEstado=[['','Activas',activas],...EST_REP.map(e=>[e,cap(e),cnt('estado',e)])]
    .map(([v,l,c])=>`<div class="frow ${repFEstado===v?'on':''}" onclick="repFEstado='${v}';renderReparaciones(document.getElementById('view'))"><span>${l}</span><span class="fc">${c}</span></div>`).join('');
  const fPrio=[['critico','Crítico','#DC4A5B'],['alta','Alta','#D98A1F'],['media','Media','#3B7DC4'],['baja','Baja','#159B51']]
    .map(([v,l,c])=>`<div class="frow ${repFPrio===v?'on':''}" onclick="repFPrio='${repFPrio===v?'':v}';renderReparaciones(document.getElementById('view'))"><span class="pdot" style="background:${c}"></span><span>${l}</span><span class="fc">${resumen[v]}</span></div>`).join('');
  // Filtro por objetivo: se cuenta sobre la MISMA base que el filtro de
  // estado, así al mirar "Finalizadas" los números son de finalizadas.
  const objCount={};
  base.forEach(r=>{const o=r.objetivos&&r.objetivos.nombre;if(o)objCount[o]=(objCount[o]||0)+1;});
  const fObj=Object.keys(objCount).sort().map(o=>
    `<div class="frow ${repFObj===o?'on':''}" onclick="repFObj='${repFObj===o?'':o.replace(/'/g,"\\'")}';renderReparaciones(document.getElementById('view'))"><span>${o}</span><span class="fc">${objCount[o]}</span></div>`).join('')
    ||'<div class="sub" style="font-size:11.5px;padding:4px 2px">sin objetivos en esta vista</div>';
  const mecCount={}; repData.forEach(r=>{if(r.mecanico_id)mecCount[r.mecanico_id]=(mecCount[r.mecanico_id]||0)+1;});
  const fMec=[...mecanicos.map(m=>`<div class="frow ${repFMec===m.id?'on':''}" onclick="repFMec='${repFMec===m.id?'':m.id}';renderReparaciones(document.getElementById('view'))"><span>${m.nombre}</span><span class="fc">${mecCount[m.id]||0}</span></div>`).join(''),
    `<div class="frow ${repFMec==='__sin'?'on':''}" onclick="repFMec='${repFMec==='__sin'?'':'__sin'}';renderReparaciones(document.getElementById('view'))"><span>Sin asignar</span><span class="fc">${repData.filter(r=>!r.mecanico_id).length}</span></div>`].join('');

  const filas=filtrada.map((r,ix)=>{
    const idx=EST_REP.indexOf(r.estado);
    return `<tr onclick="selRep(${ix})" data-ix="${ix}">
      <td style="${r.prioridad==='critico'?'box-shadow:inset 3px 0 0 var(--rojo)':''}">${prioBadge(r.prioridad)}</td>
      <td><div style="font-weight:500">${r.equipos?r.equipos.nombre:(r.tipo_equipo||'—')}${r.tipo_mant==='preventivo'?' <span class="badge b-green" style="font-size:9.5px;padding:2px 7px;vertical-align:1px">PREV</span>':''}</div><div class="sub">${r.equipos&&r.equipos.codigo?r.equipos.codigo:''}</div></td>
      <td>${r.numero_unidad?'<span class="uni-num">'+r.numero_unidad+'</span>':'<span class="sub">—</span>'}</td>
      <td>${r.objetivos?r.objetivos.nombre:'—'}</td>
      <td>${r.capataces?r.capataces.nombre:'—'}</td>
      <td>${r.mecanicos?r.mecanicos.nombre:'<span class="sub">sin asignar</span>'}</td>
      <td><span class="badge ${idx>=0?'est-'+idx:'b-gray'}">${EST_REP_LABEL[idx]||r.estado}</span>${r.reclamada?'<div style="margin-top:4px"><span class="badge" style="background:var(--diesel-soft);color:#854F0B;font-size:10px">⏰ reclamada</span></div>':''}${
        // Una cerrada sin reparar no es lo mismo que una reparada: se
        // distingue en la lista, sin tener que abrir el detalle.
        r.motivo_cierre?`<div style="margin-top:4px" title="${escStk(r.nota_cierre||'')}"><span class="badge" style="background:var(--diesel-soft);color:#854F0B;font-size:10px">📭 ${escStk(MOTIVO_CIERRE_CORTO[r.motivo_cierre]||'sin reparar')}</span></div>`:''}</td>
      <td class="mono sub">${hace(r.created_at)}</td></tr>`;}).join('');

  view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Reparaciones</div>
      <div class="view-desc">Incidencias reportadas por los capataces desde WhatsApp</div></div>
      <div class="spacer"></div>
      <div style="display:flex;gap:14px;font-size:12px;align-items:center" class="mono">
        <span style="color:#DC4A5B">● ${resumen.critico} crítico</span><span style="color:#D98A1F">● ${resumen.alta} alta</span>
        <span style="color:#3B7DC4">● ${resumen.media} media</span><span style="color:#159B51">● ${resumen.baja} baja</span>
        <button class="btn-salir" style="font-family:'Sora'" onclick="exportarIncidencias()" title="descarga lo que estás viendo, con los filtros aplicados">⬇ Exportar</button>
        <button class="btn" style="font-family:'Sora'" onclick="repAltaToggle()">+ Nueva incidencia</button></div></div>
    ${tabsRep()}
    ${repAltaOpen?repAltaForm():''}
    <div class="repwrap">
      <div class="rep-filters">
        <div class="fgroup-t">Estado</div>${fEstado}
        <div class="fgroup-t">Taller</div>${fTaller}
        <div class="fgroup-t">Prioridad</div>${fPrio}
        <div class="fgroup-t">Mecánico</div>${fMec}
        <div class="fgroup-t">Objetivo</div>${fObj}
      </div>
      <div class="tablewrap">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
          <input id="rep-q" class="busca" style="flex:1;min-width:200px;font-size:12.5px;padding:7px 11px"
            placeholder="Buscar equipo, unidad, falla, objetivo, capataz o mecánico…" value="${escStk(repFQ)}" oninput="repBuscar(this.value)">
          <span class="sub" style="font-size:12px;white-space:nowrap">${filtrada.length} de ${base.length}</span>
          ${repFQ||repFPrio||repFMec||repFObj||repFIngreso?`<button class="btn ghost" style="padding:5px 11px;font-size:11.5px" onclick="repLimpiarFiltros()">✕ limpiar</button>`:''}
        </div>
        <table><thead><tr><th>Prioridad</th><th>Equipo</th><th>Unidad</th><th>Objetivo</th><th>Capataz</th><th>Mecánico</th><th>Estado</th><th>Hace</th></tr></thead>
        <tbody id="rep-body">${filas||`<tr><td colspan="8"><div class="empty"><div>${repFQ?'Nada con esa búsqueda.':'No hay incidencias con estos filtros.'}</div></div></td></tr>`}</tbody></table></div>
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
  // Junto al avance normal va el cierre SIN REPARAR: muchas incidencias se
  // reportan y el equipo nunca baja al taller. Cerrarlas como "finalizado"
  // las contaría como reparaciones hechas.
  // EL INGRESO AL TALLER va antes que todo: mientras la máquina no llegó,
  // el reloj del taller no corre. Separarlo es lo que permite distinguir
  // "tarda el traslado" de "tarda el taller".
  const espera=r.fecha_ingreso_taller?Math.max(0,Math.round((new Date(r.fecha_ingreso_taller)-new Date(r.created_at))/86400000)):null;
  const bloqueIngreso=r.fecha_ingreso_taller
    ?`<div style="background:var(--brote-soft);border-radius:9px;padding:10px 13px;margin-top:12px;font-size:12.5px;color:var(--brote-2)">
        ✓ Ingresó el ${new Date(r.fecha_ingreso_taller).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}${r.ingreso_por?' · lo recibió '+escStk(r.ingreso_por):''}
        <div style="margin-top:2px">${espera?`Esperó ${espera} día${espera===1?'':'s'} desde que la reportaron`:'Entró el mismo día del reporte'}</div>
      </div>`
    :`<div style="background:var(--azul-soft);border-radius:9px;padding:10px 13px;margin-top:12px;font-size:12.5px;color:var(--azul)">
        <b>La máquina todavía no llegó al taller</b>
        <div style="margin-top:2px">Reportada ${hace(r.created_at)}. El reloj del taller arranca cuando entra.</div>
      </div>
      <button class="btn" style="width:100%;justify-content:center;margin-top:9px;background:var(--azul)" onclick="ingresoTaller('${r.id}')">⇥ Dar ingreso al taller</button>`;

  const btnAvanzar=idx<4
    ?`${bloqueIngreso}
      ${r.fecha_ingreso_taller?`<button class="btn" style="width:100%;justify-content:center;margin-top:12px" onclick="avanzarRep('${r.id}','${EST_REP[idx+1]}')">Avanzar a ${EST_REP_LABEL[idx+1]} →</button>`:''}
      <button class="btn ghost" style="width:100%;justify-content:center;margin-top:7px;color:var(--diesel);border-color:#E8D5A8" onclick="cerrarSinRepararPanel('${r.id}')">📭 Cerrar sin reparar</button>`
    :(r.motivo_cierre
      ?`<div class="badge b-amber" style="width:100%;justify-content:center;margin-top:14px;padding:9px">📭 Cerrada sin reparar · ${MOTIVO_CIERRE_LABEL[r.motivo_cierre]||r.motivo_cierre}</div>
        ${r.nota_cierre?`<div class="sub" style="font-size:12px;margin-top:6px;padding:8px 11px;background:var(--diesel-soft);border-radius:8px;font-style:italic">💬 "${escStk(r.nota_cierre)}"${r.cerrado_por?' — '+escStk(r.cerrado_por):''}</div>`:''}`
      :'<div class="badge b-green" style="width:100%;justify-content:center;margin-top:14px;padding:9px">✓ Finalizado</div>');
  document.getElementById('rep-side').innerHTML=`
    <div class="side-id">INCIDENCIA${r.equipo_parado?' · EQUIPO PARADO':''}</div>
    <div class="side-title">${r.equipos?r.equipos.nombre:(r.tipo_equipo||'—')}</div>
    ${r.reclamada?`<div style="background:var(--diesel-soft);border:1px solid var(--diesel);border-radius:8px;padding:8px 11px;margin:8px 0;font-size:12px;color:#854F0B"><b>⏰ Reclamada por ${r.reclamada_por||'supervisor'}</b>${r.reclamada_at?' · '+fechaAR(r.reclamada_at):''}<div class="sub" style="margin-top:2px">El supervisor del objetivo pide apurar esta reparación.</div></div>`:''}
    <div class="side-meta">${r.objetivos?r.objetivos.nombre:'Taller / sin objetivo'} · ${r.capataces?r.capataces.nombre:(r.origen==='app'?'Alta del mecánico':'Alta del panel')}</div>
    <div style="margin:10px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap">${prioBadge(r.prioridad)}
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
        (rp.items||[]).map(i=>`<div class="sub" style="font-size:12px;padding:2px 0;display:flex;justify-content:space-between;gap:8px">
          <span>x${i.cantidad||1} <b>${i.descripcion}</b></span>
          ${i.proveedor||i.precio!=null?`<span style="white-space:nowrap;font-size:11.5px">${i.proveedor?escStk(i.proveedor):''}${i.precio!=null?' · <b class="mono">'+money(i.precio*(Number(i.cantidad)||1))+'</b>':''}</span>`:''}</div>`).join('')+
        (rp.nota?`<div class="sub" style="font-size:11.5px;font-style:italic;margin-top:4px">💬 ${rp.nota}</div>`:'');})()}
    <button class="btn" style="width:100%;justify-content:center;margin-top:6px" onclick="repRepAbrir(${ix})">🛒 ${(r.repuestos_taller||[]).some(x=>x.estado!=='entregado')?'Editar':'Cargar'} pedido de repuestos</button>
    <div class="divider"></div>
    <div class="field-l" style="margin-bottom:8px">Observaciones del mecánico</div>${comHTML}
    <textarea id="rep-obs-nueva" placeholder="Agregar una observación… (viaja en el próximo aviso al capataz)" style="width:100%;box-sizing:border-box;margin-top:8px;padding:9px;border:1px solid var(--linea);border-radius:8px;font:inherit;font-size:12.5px;min-height:56px;resize:vertical"></textarea>
    <button class="btn ghost" style="width:100%;justify-content:center;margin-top:6px" onclick="agregarObsRep('${r.id}',${ix})">＋ Agregar observación</button>
    ${btnAvanzar}`;
}
/* Pedido de repuestos desde el detalle de la reparación */
/* Cada repuesto se cotiza POR SEPARADO: el cable puede venir de un lado y
   el reloj de otro. Por eso proveedor y precio van por fila, no al pie. */
function repRepFila(i){
  i=i||{};
  const inp='box-sizing:border-box;padding:7px;border:1px solid var(--linea);border-radius:7px;font-size:12px';
  return `<div style="display:flex;gap:5px;margin-bottom:5px;align-items:center">
    <input class="rr-cant" type="text" inputmode="numeric" value="${i.cantidad||1}" style="width:40px;${inp};text-align:center">
    <input class="rr-desc" type="text" placeholder="Repuesto" value="${(i.descripcion||'').replace(/"/g,'&quot;')}" style="flex:2.2;${inp}">
    <input class="rr-prov" type="text" placeholder="Proveedor" value="${(i.proveedor||'').replace(/"/g,'&quot;')}" style="flex:1.4;${inp}" onchange="repRepTotal()">
    <input class="rr-precio" type="text" inputmode="decimal" placeholder="Precio $" value="${i.precio!=null&&i.precio!==''?String(i.precio).replace('.',','):''}" style="flex:1;${inp};text-align:right" onchange="repRepTotal()">
    <button class="btn ghost" style="padding:4px 9px;flex:0 0 auto" onclick="this.parentElement.remove();repRepTotal()">✕</button>
  </div>`;
}
/* Total en vivo y cuántos están cotizados: sirve para saber si el pedido
   ya se puede mandar a aprobar o falta averiguar precios. */
function repRepTotal(){
  const filas=[...document.querySelectorAll('#rep-rep-filas > div')];
  let total=0,cotizados=0,conDesc=0;
  filas.forEach(f=>{
    const d=(f.querySelector('.rr-desc')||{}).value||'';
    if(!d.trim())return;
    conDesc++;
    const p=repRepNum((f.querySelector('.rr-precio')||{}).value);
    const prov=((f.querySelector('.rr-prov')||{}).value||'').trim();
    if(p>0&&prov){cotizados++;total+=p*(Number((f.querySelector('.rr-cant')||{}).value)||1);}
  });
  const el=document.getElementById('rep-rep-total');
  if(!el)return;
  el.innerHTML=conDesc
    ? `<b>${cotizados} de ${conDesc}</b> cotizado${cotizados===1?'':'s'}${total?` · total <b>${money(total)}</b>`:''}`
      +(cotizados&&cotizados<conDesc?' <span style="color:var(--diesel)">· falta cotizar el resto</span>':'')
      +(cotizados===conDesc&&conDesc?' <span style="color:var(--brote-2)">· listo para aprobar</span>':'')
    : '';
}
function repRepNum(v){
  const n=Number(String(v==null?'':v).replace(/[^\d.,-]/g,'').replace(/\./g,'').replace(',','.'));
  return isNaN(n)?0:n;
}
function repRepAddFila(){document.getElementById('rep-rep-filas').insertAdjacentHTML('beforeend',repRepFila());}
// El pedido se carga en un MODAL GRANDE (el form en el drawer quedaba cortado)
// e incluye la ORDEN DE COMPRA: el mecánico cotiza sus propios repuestos
// (proveedor + precio + plazo) y el pedido queda directo esperando aprobación.
function repRepAbrir(ix){
  const r=window._repFiltrada[ix];
  const rp=(r.repuestos_taller||[]).find(x=>x.estado!=='entregado');
  const eq=(r.equipos?r.equipos.nombre:(r.tipo_equipo||'Equipo'))+(r.numero_unidad?' · N° '+r.numero_unidad:'');
  const bg=document.createElement('div');bg.className='modal-bg abierto';bg.id='rep-rep-modal';bg.style.zIndex=210;
  bg.innerHTML=`<div class="modal" style="max-width:620px;width:94vw;max-height:92vh;overflow-y:auto">
    <div class="modal-tit" style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
      <span>🛒 Pedido de repuestos</span><span class="sub" style="font-weight:400;font-size:12px">${eq}${r.mecanicos?' · '+r.mecanicos.nombre:''}</span></div>
    <div id="rep-rep-hint" class="sub" style="display:none;font-size:11.5px;color:var(--brote-2);margin:6px 0"></div>
    <div class="field-l" style="margin:10px 0 6px">Repuestos</div>
    <div id="rep-rep-filas"></div>
    <div style="display:flex;gap:6px;margin-top:4px">
      <button class="btn ghost" style="flex:1;justify-content:center;font-size:12px" onclick="repRepAddFila();repRepTotal()">＋ otra fila</button>
      <button class="btn ghost" style="flex:1;justify-content:center;font-size:12px" onclick="repRepSugerir('${r.id}')">✨ Sugerir de nuevo</button>
      <button class="btn ghost" style="flex:0 0 auto;justify-content:center;font-size:12px" onclick="document.getElementById('rep-rep-filas').innerHTML=repRepFila()">🗑</button>
    </div>
    <div style="display:flex;gap:8px">
      <div class="mm-field" style="flex:1;margin-top:10px"><label>Marca / modelo del equipo</label>
        <input id="rep-rep-marca" type="text" placeholder="ej: Husqvarna 545" value="${String(rp&&rp.marca_modelo||'').replace(/"/g,'&quot;')}" style="width:100%"></div>
      <div class="mm-field" style="flex:1;margin-top:10px"><label>Mecánico que solicita</label>
        <select id="rep-rep-solicita" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--linea);border-radius:8px;font:inherit;font-size:12.5px">
          <option value="">— elegir —</option>
          ${mecanicos.map(m=>`<option value="${m.nombre.replace(/"/g,'&quot;')}" ${(r.mecanicos&&r.mecanicos.nombre===m.nombre)?'selected':''}>${m.nombre}</option>`).join('')}
        </select></div>
    </div>

    <div id="rep-rep-total" class="sub" style="font-size:12.5px;margin-top:10px;padding:9px 12px;background:var(--hueso);border-radius:9px"></div>
    <div class="sub" style="font-size:11.5px;margin-top:8px">Cargá proveedor y precio de cada repuesto si ya lo averiguaste — cada uno puede venir de un lugar distinto. Lo que quede sin cotizar se resuelve después desde el circuito de Compras.</div>
    <textarea id="rep-rep-nota" placeholder="Nota para quien compra (opcional)" style="width:100%;box-sizing:border-box;margin-top:6px;padding:9px;border:1px solid var(--linea);border-radius:8px;font:inherit;font-size:12.5px;min-height:48px">${rp&&rp.nota||''}</textarea>
    <div class="modal-acciones">
      <button class="btn-salir" onclick="document.getElementById('rep-rep-modal').remove()">Cancelar</button>
      <button class="btn" onclick="repRepGuardar('${r.id}',${ix})">Guardar pedido</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  document.getElementById('rep-rep-filas').innerHTML=((rp&&rp.items&&rp.items.length)?rp.items:[{},{}]).map(repRepFila).join('');
  repRepTotal();
  if(!rp)repRepSugerir(r.id);   // sin pedido previo → la IA propone (editable)
}
async function repRepSugerir(id){
  const hint=document.getElementById('rep-rep-hint');
  if(hint){hint.style.display='';hint.textContent='✨ Analizando la falla y los comentarios…';}
  try{
    const s=await api('/api/reparaciones/'+id+'/repuestos/sugerir',{method:'POST',body:'{}'});
    document.getElementById('rep-rep-filas').innerHTML=(s.items||[]).map(repRepFila).join('')||repRepFila();
    repRepTotal();
    if(hint)hint.textContent='✨ '+(s.razon||'Sugerido según la falla')+' — revisá, corregí o agregá lo que falte.';
  }catch(e){if(hint)hint.textContent='No pude sugerir esta vez — cargalo a mano.';}
}
async function repRepGuardar(id,ix){
  const items=[...document.querySelectorAll('#rep-rep-filas > div')].map(f=>({
    cantidad:Number(f.querySelector('.rr-cant').value)||1,
    descripcion:f.querySelector('.rr-desc').value.trim(),
    proveedor:f.querySelector('.rr-prov').value.trim(),
    precio:repRepNum(f.querySelector('.rr-precio').value)||null,
  })).filter(i=>i.descripcion);
  if(!items.length){alert('Cargá al menos un repuesto.');return;}
  // Cada repuesto se cotiza por separado, así que un ítem con precio pero
  // sin proveedor (o al revés) es un dato a medias: se avisa.
  const aMedias=items.filter(i=>(i.proveedor&&!i.precio)||(i.precio&&!i.proveedor));
  if(aMedias.length&&!confirm(`${aMedias.map(i=>i.descripcion).join(', ')}: falta el proveedor o el precio. ¿Guardar igual?`))return;
  const nota=document.getElementById('rep-rep-nota').value.trim();
  const v=k=>((document.getElementById('rep-rep-'+k)||{}).value||'').trim();
  try{
    const solicita=((document.getElementById('rep-rep-solicita')||{}).value||'').trim();
    const nuevo=await api('/api/reparaciones/'+id+'/repuestos',{method:'POST',body:JSON.stringify({items,nota,marca_modelo:v('marca'),solicitante:solicita})});
    const m=document.getElementById('rep-rep-modal');if(m)m.remove();
    const r=window._repFiltrada[ix];
    r.repuestos_taller=(r.repuestos_taller||[]).filter(x=>x.id!==nuevo.id&&x.estado==='entregado');
    r.repuestos_taller.push(nuevo);
    selRep(ix);
    // El estado lo decide el server (cotizado solo si TODOS los ítems
    // tienen proveedor y precio), así que el mensaje se lee de la respuesta
    // en vez de recalcularlo acá.
    const cot=items.filter(i=>i.proveedor&&i.precio).length;
    toast(nuevo&&nuevo.estado==='cotizado'
      ? 'Pedido cotizado ✓ — esperando aprobación en Compras'
      : cot ? `Pedido guardado ✓ — ${cot} de ${items.length} cotizado${cot===1?'':'s'}`
            : 'Pedido guardado ✓');
  }catch(e){toast('No pude guardar: '+e.message,'error');}
}
async function agregarObsRep(id,ix){
  const ta=document.getElementById('rep-obs-nueva');
  const texto=(ta&&ta.value||'').trim();
  if(!texto){toast('Escribí la observación primero','error');return;}
  const btn=ta&&ta.parentElement?ta.parentElement.querySelector('button.btn.ghost'):null;
  if(btn){btn.disabled=true;btn.textContent='Guardando…';}
  let nuevo=null;
  // El guardado va en su propio try: antes, si fallaba el repintado de abajo
  // (índice desincronizado tras un refresh, por ejemplo) el catch decía
  // "No pude guardar" aunque la observación SÍ se había guardado.
  try{
    nuevo=await api('/api/reparaciones/'+id+'/comentario',{method:'POST',body:JSON.stringify({texto})});
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='＋ Agregar observación';}
    toast('No pude guardar: '+(e.message||''),'error');
    return;
  }
  if(ta)ta.value='';
  toast('Observación guardada');
  // Repintado: si algo sale mal acá, la observación ya está a salvo en la base.
  try{
    // Se busca por ID y no por índice: la lista se repinta sola cada 90 s.
    const lista=window._repFiltrada||[];
    let pos=lista.findIndex(x=>String(x.id)===String(id));
    if(pos<0)pos=ix;
    const r=lista[pos];
    if(r){(r.comentarios_incidencias=r.comentarios_incidencias||[]).push(nuevo);selRep(pos);}
    else{repData=null;go('reparaciones');}
  }catch(e){repData=null;go('reparaciones');}
}
/* ── Historial por máquina ───────────────────────────────────────
   El nivel de arriba de la trazabilidad: no "qué pasó con este ticket"
   sino "qué viene pasando con esta máquina". Una motoguadaña que entró
   6 veces en 3 meses es una decisión de reposición, no de taller. */
let repMaqFiltro='abiertas', repMaqQ='', repMaqSel=null;
function claveMaquina(r){
  // equipo + unidad normalizados: "AE 466 VW" y "ae466vw" son la misma máquina.
  // OJO con los prefijos: el capataz escribe "45", "N° 45" o "nro 45" para la
  // misma unidad — sin sacarlos, la máquina aparece tres veces en el historial.
  const eq=String(r.tipo_equipo||(r.equipos?r.equipos.nombre:'')||'—')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
  const un=String(r.numero_unidad||'').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g,'')
    // El orden importa: las alternativas largas van PRIMERO, si no "n" come
    // la N de "nro" y deja "ro45"
    .replace(/^\s*(numero|num|nro|unidad|interno|n[°ºo]|n)\s*\.?\s*/,'')
    .replace(/[^a-z0-9]/g,'')||'sn';
  return eq+'|'+un;
}
function agruparMaquinas(lista){
  const m={};
  (lista||[]).forEach(r=>{
    const k=claveMaquina(r);
    if(!m[k])m[k]={clave:k,equipo:r.tipo_equipo||(r.equipos?r.equipos.nombre:'—'),
      unidad:r.numero_unidad||'S/N',objetivo:r.objetivos?r.objetivos.nombre:null,incidencias:[]};
    m[k].incidencias.push(r);
    // El objetivo más reciente manda: la máquina puede haber cambiado de obra
    if(!m[k].objetivo&&r.objetivos)m[k].objetivo=r.objetivos.nombre;
  });
  return Object.values(m).map(x=>{
    x.incidencias.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
    const abiertas=x.incidencias.filter(r=>r.estado!=='finalizado');
    const cerradas=x.incidencias.filter(r=>r.estado==='finalizado'&&r.fecha_finalizado&&!r.motivo_cierre);
    const diasTaller=cerradas.reduce((a,r)=>a+Math.max(0,(new Date(r.fecha_finalizado)-new Date(r.created_at))/86400000),0);
    return {...x,
      total:x.incidencias.length,
      abiertas:abiertas.length,
      parada:abiertas.some(r=>r.equipo_parado),
      sinReparar:x.incidencias.filter(r=>r.motivo_cierre).length,
      ultima:x.incidencias[0],
      dias_taller:Math.round(diasTaller*10)/10,
      prom_dias:cerradas.length?Math.round((diasTaller/cerradas.length)*10)/10:null,
    };
  }).sort((a,b)=>(b.abiertas-a.abiertas)||(b.total-a.total));
}
function repMaqBuscar(v){
  repMaqQ=v;go('reparaciones');
  setTimeout(()=>{const i=document.getElementById('maq-q');
    if(i){i.focus();i.setSelectionRange(i.value.length,i.value.length);}},0);
}
function bloqueHistorialMaquinas(todas){
  const maqs=agruparMaquinas(todas);
  const q=repMaqQ.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/\s+/).filter(Boolean);
  const vis=maqs
    .filter(m=>repMaqFiltro==='todas'||(repMaqFiltro==='abiertas'?m.abiertas>0:(repMaqFiltro==='paradas'?m.parada:m.abiertas===0)))
    .filter(m=>!q.length||q.every(w=>`${m.equipo} ${m.unidad} ${m.objetivo||''}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').includes(w)));
  const conAbierta=maqs.filter(m=>m.abiertas>0).length;
  return `<div class="panel" style="margin-top:14px">
    <div class="panel-title" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <span>Historial por máquina <span class="sub" style="font-weight:400;font-size:11px">· ${maqs.length} máquinas pasaron por el taller · tocá una para ver todas sus entradas</span></span>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
      <select class="busca" style="width:auto;font-size:12px;padding:5px 8px" onchange="repMaqFiltro=this.value;go('reparaciones')">
        <option value="abiertas" ${repMaqFiltro==='abiertas'?'selected':''}>Con reparación abierta (${conAbierta})</option>
        <option value="paradas" ${repMaqFiltro==='paradas'?'selected':''}>⛔ Paradas ahora (${maqs.filter(m=>m.parada).length})</option>
        <option value="cerradas" ${repMaqFiltro==='cerradas'?'selected':''}>Al día (${maqs.length-conAbierta})</option>
        <option value="todas" ${repMaqFiltro==='todas'?'selected':''}>Todas (${maqs.length})</option>
      </select>
      <input id="maq-q" class="busca" style="flex:1;min-width:160px;font-size:12px;padding:5px 9px"
        placeholder="Buscar máquina, unidad u objetivo…" value="${escStk(repMaqQ)}" oninput="repMaqBuscar(this.value)">
    </div>
    ${vis.length?`<table style="font-size:12px"><thead><tr>
      <th>Máquina</th><th>Unidad</th><th>Objetivo</th><th class="num">Entradas</th>
      <th class="num">Días en taller</th><th class="num">Prom.</th><th>Última</th><th>Estado</th></tr></thead>
      <tbody>${vis.map(m=>`<tr class="fila" onclick="verHistorialMaquina('${m.clave}')" style="cursor:pointer" title="ver el historial completo">
        <td style="font-weight:600">${escStk(m.equipo)}</td>
        <td><span class="uni-num">${escStk(m.unidad)}</span></td>
        <td class="sub" style="font-size:11.5px">${escStk(m.objetivo||'—')}</td>
        <td class="num mono" style="${m.total>=4?'color:#A32D2D;font-weight:700':m.total>=3?'color:#854F0B;font-weight:600':''}">${m.total}</td>
        <td class="num mono">${m.dias_taller||'—'}</td>
        <td class="num mono">${m.prom_dias!=null?m.prom_dias+' d':'—'}</td>
        <td class="sub" style="font-size:11.5px">${fechaAR(m.ultima.created_at)}</td>
        <td>${m.parada?'<span class="badge" style="background:#FCEBED;color:#A32D2D;font-size:10px">⛔ parada</span>'
          :m.abiertas?`<span class="badge b-amber" style="font-size:10px">${m.abiertas} abierta${m.abiertas===1?'':'s'}</span>`
          :'<span class="badge b-green" style="font-size:10px">al día</span>'}</td>
      </tr>`).join('')}</tbody></table>
      <div class="sub" style="font-size:11.5px;margin-top:8px">
        En rojo las máquinas con 4 o más entradas: ahí conviene preguntarse si sigue siendo negocio repararla.</div>`
      :`<div class="sub" style="padding:12px 0">${repMaqQ?'Nada con esa búsqueda.':'Sin máquinas en este filtro.'}</div>`}
  </div>`;
}
function verHistorialMaquina(clave){
  const m=agruparMaquinas(repData||[]).find(x=>x.clave===clave);
  if(!m)return toast('No encontré esa máquina','error');
  repMaqSel=m;
  const inc=m.incidencias;
  document.getElementById('mm-titulo').textContent='Historial · '+m.equipo+' · N° '+m.unidad;
  document.getElementById('mm-campos').innerHTML=`
    <div class="kpis" style="grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
      <div class="kpi"><div class="kpi-label">Entradas</div><div class="kpi-val" style="font-size:22px">${m.total}</div></div>
      <div class="kpi"><div class="kpi-label">Días en taller</div><div class="kpi-val" style="font-size:22px">${m.dias_taller||0}</div></div>
      <div class="kpi"><div class="kpi-label">Promedio</div><div class="kpi-val" style="font-size:22px">${m.prom_dias!=null?m.prom_dias:'—'}<span style="font-size:13px"> d</span></div></div>
      <div class="kpi"><div class="kpi-label">Sin reparar</div><div class="kpi-val" style="font-size:22px;color:${m.sinReparar?'var(--diesel)':'inherit'}">${m.sinReparar}</div></div>
    </div>
    ${m.objetivo?`<div class="sub" style="margin-bottom:12px">📍 ${escStk(m.objetivo)}</div>`:''}
    ${m.total>=4?`<div style="background:var(--rojo-soft);border-radius:9px;padding:10px 13px;margin-bottom:12px;font-size:12.5px">
      <b style="color:var(--rojo)">${m.total} entradas al taller.</b> Con ${m.dias_taller} días acumulados fuera de servicio, vale comparar contra lo que cuesta una unidad nueva.</div>`:''}
    <div class="field-l" style="margin-bottom:8px">Cada entrada al taller</div>
    ${inc.map(r=>{
      const cerrada=r.estado==='finalizado';
      const d=cerrada&&r.fecha_finalizado?Math.ceil((new Date(r.fecha_finalizado)-new Date(r.created_at))/86400000)
        :Math.ceil((Date.now()-new Date(r.created_at))/86400000);
      return `<div onclick="abrirTrazabilidad('${r.id}')" style="border:1px solid var(--linea);border-radius:9px;padding:10px 13px;margin-bottom:7px;cursor:pointer" title="ver la trazabilidad de esta entrada">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline">
          <b style="font-size:13px">${fechaAR(r.created_at)}${cerrada&&r.fecha_finalizado?' → '+fechaAR(r.fecha_finalizado):''}</b>
          <span class="mono ${d>=7?'':''}" style="font-size:12px;${d>=7?'color:#A32D2D;font-weight:700':''}">${d} d</span>
        </div>
        <div class="sub" style="font-size:12px;margin-top:2px">${escStk((r.descripcion||r.tipo_falla||'Sin descripción').slice(0,110))}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px;align-items:center">
          ${r.motivo_cierre?`<span class="badge b-amber" style="font-size:10px">📭 ${escStk(MOTIVO_CIERRE_CORTO[r.motivo_cierre]||'sin reparar')}</span>`
            :cerrada?'<span class="badge b-green" style="font-size:10px">✓ reparada</span>'
            :`<span class="badge b-gray" style="font-size:10px">${escStk(EST_REP_LABEL[EST_REP.indexOf(r.estado)]||r.estado)}</span>`}
          ${r.equipo_parado?'<span class="badge" style="background:#FCEBED;color:#A32D2D;font-size:10px">⛔ parada</span>':''}
          <span class="sub" style="font-size:11px">${r.mecanicos?escStk(r.mecanicos.nombre):'sin asignar'}</span>
        </div>
      </div>`;}).join('')}
    <div class="modal-acciones">
      <button class="btn-salir" onclick="cerrarMaestro();repMaqSel=null">Cerrar</button>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
}

/* ── Trazabilidad de una incidencia ──────────────────────────────
   Toda la vida del ticket en una línea de tiempo: cuándo se reportó,
   cuánto estuvo en cada etapa, qué dijo el taller, qué repuestos se
   pidieron y cómo se cerró. La pregunta que contesta es "¿dónde se
   fueron los 13 días?" — y el que más tarda casi nunca es el que uno
   cree. */
const TRZ_ETAPAS=[
  ['created_at','Reportada','#8A968E','📝'],
  ['fecha_ingreso_taller','Ingresó al taller','#2471A3','⇥'],
  ['fecha_diagnostico','Diagnóstico','#3B7DC4','🔍'],
  ['fecha_espera_repuestos','Esperando repuestos','#D98A1F','⏳'],
  ['fecha_en_reparacion','En reparación','#7C5CD6','🛠'],
  ['fecha_finalizado','Cerrada','#159B51','✅'],
];
function indBuscar(v){
  // Se re-renderiza entero, así que hay que devolver el foco al input
  repIndQ=v;
  go('reparaciones');
  setTimeout(()=>{const i=document.getElementById('ind-q');
    if(i){i.focus();i.setSelectionRange(i.value.length,i.value.length);}},0);
}
function abrirTrazabilidad(id){
  const r=(repData||[]).find(x=>String(x.id)===String(id))
    ||(window._repFiltrada||[]).find(x=>String(x.id)===String(id));
  if(!r)return toast('No encontré esa incidencia','error');
  repTrz=r;
  pintarTrazabilidad();
}
function pintarTrazabilidad(){
  const r=repTrz;if(!r)return;
  const hoy=new Date();
  // Se arman los hitos que REALMENTE tienen fecha: si una etapa se salteó
  // (pasó de pendiente a reparación), no se inventa.
  const hitos=TRZ_ETAPAS.map(([campo,etiqueta,color,icono])=>({campo,etiqueta,color,icono,fecha:r[campo]}))
    .filter(h=>h.fecha);
  // Duración de cada etapa = hasta el próximo hito (o hasta hoy si es la última y sigue abierta)
  const abierta=r.estado!=='finalizado';
  hitos.forEach((h,i)=>{
    const sig=hitos[i+1];
    const fin=sig?new Date(sig.fecha):(abierta?hoy:null);
    h.dias=fin?Math.max(0,(fin-new Date(h.fecha))/86400000):null;
    h.enCurso=!sig&&abierta;
  });
  const totalDias=hitos.length?((abierta?hoy:new Date(r.fecha_finalizado||hoy))-new Date(r.created_at))/86400000:0;
  const masLarga=hitos.filter(h=>h.dias!=null).sort((a,b)=>b.dias-a.dias)[0];

  const coms=(r.comentarios_incidencias||[]).slice().sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  const rps=(r.repuestos_taller||[]);
  const eq=`${r.tipo_equipo||(r.equipos?r.equipos.nombre:'Equipo')}${r.numero_unidad?' · N° '+r.numero_unidad:''}`;

  document.getElementById('mm-titulo').textContent='Trazabilidad · '+eq;
  document.getElementById('mm-campos').innerHTML=`
    <div class="sub" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      ${r.objetivos?`<span>📍 ${escStk(r.objetivos.nombre)}</span>`:''}
      ${r.capataces?`<span>· reportó ${escStk(r.capataces.nombre)}</span>`:''}
      ${r.mecanicos?`<span>· 👨‍🔧 ${escStk(r.mecanicos.nombre)}</span>`:''}
      ${r.equipo_parado?'<span class="badge" style="background:var(--rojo-soft);color:var(--rojo)">⛔ parada</span>':''}
      <span class="badge ${r.prioridad==='critico'?'b-rojo':r.prioridad==='alta'?'b-amber':'b-gray'}">${escStk(r.prioridad||'—')}</span>
    </div>

    <div style="background:var(--hueso);border-radius:10px;padding:11px 14px;margin-bottom:14px;font-size:13px">
      <b>${Math.ceil(totalDias)} días</b> ${abierta?'abierta hasta hoy':'de punta a punta'}
      ${masLarga&&masLarga.dias>=1?` · la etapa más larga fue <b style="color:${masLarga.color}">${masLarga.etiqueta}</b> con ${Math.round(masLarga.dias*10)/10} d`:''}
    </div>

    <div class="field-l" style="margin-bottom:10px">Línea de tiempo</div>
    <div style="position:relative;padding-left:26px">
      <div style="position:absolute;left:8px;top:6px;bottom:16px;width:2px;background:var(--linea)"></div>
      ${hitos.map(h=>`
        <div style="position:relative;margin-bottom:14px">
          <div style="position:absolute;left:-25px;top:1px;width:18px;height:18px;border-radius:50%;background:${h.color};display:flex;align-items:center;justify-content:center;font-size:10px">${h.icono}</div>
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
            <b style="font-size:13.5px;color:${h.color}">${h.etiqueta}</b>
            <span class="mono sub" style="font-size:11.5px">${fFechaHora(h.fecha)}</span>
          </div>
          ${h.dias!=null?`<div class="sub" style="font-size:12px">
            ${h.enCurso?`<span style="color:var(--diesel)">acá está hace <b>${Math.round(h.dias*10)/10} d</b></span>`
              :`estuvo <b>${Math.round(h.dias*10)/10} d</b> en esta etapa`}</div>`:''}
        </div>`).join('')}
      ${abierta&&!hitos.some(h=>h.enCurso)?`<div style="position:relative">
        <div style="position:absolute;left:-25px;top:1px;width:18px;height:18px;border-radius:50%;border:2px dashed var(--linea)"></div>
        <div class="sub" style="font-size:12.5px">Sigue abierta</div></div>`:''}
    </div>

    ${r.motivo_cierre?`<div style="background:var(--diesel-soft);border-left:3px solid var(--diesel);border-radius:8px;padding:10px 13px;margin:14px 0;font-size:12.5px">
      <b style="color:var(--diesel)">📭 Cerrada sin reparar · ${MOTIVO_CIERRE_LABEL[r.motivo_cierre]||r.motivo_cierre}</b>
      ${r.nota_cierre?`<div style="margin-top:4px;font-style:italic">"${escStk(r.nota_cierre)}"</div>`:''}
      ${r.cerrado_por?`<div class="sub" style="font-size:11.5px;margin-top:3px">— ${escStk(r.cerrado_por)}</div>`:''}
    </div>`:''}

    <div class="field-l" style="margin:14px 0 6px">Lo que reportó el capataz</div>
    <div class="sub" style="font-size:12.5px;background:var(--papel);border-radius:8px;padding:9px 12px">${escStk(r.descripcion||r.tipo_falla||'Sin descripción')}</div>

    <div class="field-l" style="margin:14px 0 6px">Lo que dijo el taller (${coms.length})</div>
    ${coms.length?coms.map(c=>`<div style="border-left:2px solid var(--linea);padding:3px 0 3px 10px;margin-bottom:7px;font-size:12.5px">
      ${escStk(c.texto)}
      <div class="sub" style="font-size:11px;margin-top:2px">${escStk(c.mecanico_nombre||'—')} · ${fFechaHora(c.created_at)}</div>
    </div>`).join(''):'<div class="sub" style="font-size:12.5px">Sin observaciones cargadas.</div>'}

    ${rps.length?`<div class="field-l" style="margin:14px 0 6px">Repuestos</div>
    ${rps.map(p=>`<div style="border:1px solid var(--linea);border-radius:8px;padding:9px 12px;margin-bottom:7px;font-size:12.5px">
      <div style="display:flex;justify-content:space-between;gap:8px">
        <b>${p.items?p.items.length:0} ítem${(p.items&&p.items.length)===1?'':'s'}</b>
        <span class="badge b-gray">${escStk(p.estado||'')}</span></div>
      ${(p.items||[]).map(i=>`<div class="sub" style="font-size:12px;display:flex;justify-content:space-between;gap:8px">
        <span>x${i.cantidad||1} ${escStk(i.descripcion)}</span>
        ${i.proveedor||i.precio!=null?`<span style="white-space:nowrap">${i.proveedor?escStk(i.proveedor):''}${i.precio!=null?' · '+money(i.precio*(Number(i.cantidad)||1)):''}</span>`:''}</div>`).join('')}
      <div class="sub" style="font-size:11px;margin-top:3px">pedido ${fFechaHora(p.created_at)}${p.entregado_at?` · entregado ${fFechaHora(p.entregado_at)}`:''}</div>
    </div>`).join('')}`:''}

    <div class="modal-acciones">
      <button class="btn ghost" onclick="verHistorialMaquina('${claveMaquina(r)}')">📋 Historial de esta máquina</button>
      <button class="btn-salir" onclick="cerrarMaestro();repTrz=null">Cerrar</button>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
}
function fFechaHora(f){
  if(!f)return '—';
  const d=new Date(f);
  return d.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'})+' '+d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});
}

/* ── Cerrar sin reparar (desde el panel) ─────────────────────────
   El mismo cierre que hace el mecánico desde la app, pero para José.
   El capataz recibe el aviso igual. */
const MOTIVO_CIERRE_LABEL={
  no_ingreso:'el equipo no llegó al taller',
  resuelto_en_campo:'se resolvió en el objetivo',
  sin_falla:'no se encontró la falla',
  duplicado:'estaba repetida',
  otro:'otro motivo',
};
const MOTIVO_CIERRE_OPC=[
  ['no_ingreso','📭 Nunca llegó al taller','La reportaron pero el equipo no bajó'],
  ['resuelto_en_campo','🔧 Se arregló en el objetivo','Se resolvió ahí, sin taller'],
  ['sin_falla','🔎 No se encontró la falla','Se revisó y estaba bien'],
  ['duplicado','📄 Estaba repetida','Ya había otro reporte igual'],
  ['otro','📁 Otro motivo',''],
];
let cierreRep=null;
async function ingresoTaller(id){
  const r=(repData||[]).find(x=>String(x.id)===String(id))||{};
  const nom=`${r.tipo_equipo||'Equipo'} ${r.numero_unidad||''}`.trim();
  if(!await uiConfirm(`Se registra que ${nom} entró al taller ahora. Desde este momento corre el tiempo del taller.`,'¿Dar ingreso al taller?',{ok:'Sí, ingresó'}))return;
  try{
    const res=await api(`/api/reparaciones/${id}/ingreso-taller`,{method:'POST',body:JSON.stringify({})});
    toast(res.espera_dias?`Ingreso registrado ✓ — esperó ${res.espera_dias} día${res.espera_dias===1?'':'s'}`:'Ingreso registrado ✓');
    repData=null;go('reparaciones');
  }catch(e){toast('No pude registrar el ingreso: '+(e.message||''),'error');}
}

function cerrarSinRepararPanel(id){
  const r=(window._repFiltrada||[]).find(x=>String(x.id)===String(id));
  if(!r)return;
  cierreRep={id,motivo:'no_ingreso',
    equipo:(r.equipos&&r.equipos.nombre)||r.tipo_equipo||'Equipo',
    unidad:r.numero_unidad,capataz:r.capataces?r.capataces.nombre:null};
  pintarCierreRep();
}
function pintarCierreRep(){
  const c=cierreRep;if(!c)return;
  document.getElementById('mm-titulo').textContent='Cerrar sin reparar';
  document.getElementById('mm-campos').innerHTML=`
    <div class="sub" style="margin-bottom:12px">${escStk(c.equipo)}${c.unidad?' · N° '+escStk(c.unidad):''}${c.capataz?` — lo reportó ${escStk(c.capataz)}`:''}</div>
    <div class="field-l" style="margin-bottom:7px">¿Por qué se cierra?</div>
    ${MOTIVO_CIERRE_OPC.map(([v,t,d])=>`
      <div onclick="cierreRep.motivo='${v}';pintarCierreRep()" style="display:flex;align-items:flex-start;gap:9px;padding:9px 12px;margin-bottom:5px;border:1.5px solid ${c.motivo===v?'var(--brote)':'var(--linea)'};border-radius:10px;background:${c.motivo===v?'var(--brote-soft)':'#fff'};cursor:pointer">
        <div style="width:15px;height:15px;border-radius:50%;border:2px solid ${c.motivo===v?'var(--brote)':'var(--linea)'};flex-shrink:0;margin-top:2px;display:flex;align-items:center;justify-content:center">
          ${c.motivo===v?'<div style="width:7px;height:7px;border-radius:50%;background:var(--brote)"></div>':''}</div>
        <div><div style="font-size:13.5px;font-weight:600">${t}</div>
          ${d?`<div class="sub" style="font-size:11.5px">${d}</div>`:''}</div>
      </div>`).join('')}
    <div class="mm-field" style="margin-top:12px"><label>Nota para el capataz *</label>
      <textarea id="cr-nota" placeholder="Ej: se avisó tres veces y la máquina nunca bajó al taller."
        style="width:100%;box-sizing:border-box;padding:9px;border:1px solid var(--linea);border-radius:8px;font:inherit;font-size:13px;min-height:70px"></textarea>
      <div class="sub" style="font-size:11.5px;margin-top:4px">Le llega por WhatsApp junto con el motivo.</div></div>
    <div class="modal-acciones">
      <button class="btn-salir" onclick="cerrarMaestro();cierreRep=null">Cancelar</button>
      <button class="btn" onclick="confirmarCierreRep()">📭 Cerrar y avisar</button>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
}
async function confirmarCierreRep(){
  const c=cierreRep;if(!c)return;
  const nota=((document.getElementById('cr-nota')||{}).value||'').trim();
  if(nota.length<5){toast('Escribí la nota para el capataz: qué pasó con el equipo','error');return;}
  try{
    const r=await api('/api/reparaciones/'+c.id+'/cerrar-sin-reparar',
      {method:'POST',body:JSON.stringify({motivo:c.motivo,nota})});
    cerrarMaestro();cierreRep=null;
    toast(r._notificado?'Cerrada · le avisamos al capataz':'Cerrada sin reparar');
    repData=null;go('reparaciones');
  }catch(e){toast('No pude cerrar: '+(e.message||''),'error');}
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

/* ═══════════════ MOVIMIENTOS DE MAQUINARIA (trazabilidad) ═══════════════
   Los supervisores marcan egreso/ingreso desde la app; acá se ve dónde está
   cada máquina, qué salió y nadie recibió, el hilo de cada una y el cruce por
   objetivo. Lo accionable (viajes sin cerrar) va arriba de todo. */
let movTab='flota', movData=null, movBusca='', movFiltroObj='', movFiltroEst='', movFicha=null, movDias=30;
function tabsMov(){return `<div class="toggle-imp" style="margin-bottom:16px">
  <button class="${movTab==='flota'?'on':''}" onclick="movTab='flota';renderMov()">Dónde está cada una</button>
  <button class="${movTab==='movs'?'on':''}" onclick="movTab='movs';renderMov()">Movimientos</button>
  <button class="${movTab==='objetivo'?'on':''}" onclick="movTab='objetivo';renderMov()">Por objetivo</button>
</div>`;}
async function vMovimientos(view){
  view.innerHTML=tabsMov()+'<div class="cargando-v">Cargando maquinaria…</div>';
  try{movData=await api('/api/movimientos?dias='+movDias);}
  catch(e){view.innerHTML=tabsMov()+`<div class="card" style="padding:20px">${e.message}</div>`;return;}
  renderMov();
}
const movFecha=iso=>iso?new Date(iso).toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'}):'—';
const movFechaH=iso=>iso?new Date(iso).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
function movBadgeUbic(f){
  if(f.situacion==='en_transito')return `<span class="badge b-amber">🚚 en viaje → ${f.hacia||'?'}</span>`;
  if(f.situacion==='sin_registrar')return '<span class="badge b-gray">sin registrar</span>';
  return `<span class="badge ${f.donde_tipo==='taller'?'b-blue':'b-green'}">${f.donde_tipo==='taller'?'🔧':'📍'} ${f.donde||'—'}</span>`;
}
const movBadgeEst=e=>e==='con_falla'?'<span class="badge b-red">⚠ con falla</span>'
  :e==='anda'?'<span class="badge b-green">anda</span>':'<span class="sub">—</span>';
function renderMov(){
  const view=document.getElementById('view');
  if(!movData){view.innerHTML=tabsMov()+'<div class="cargando-v">Cargando…</div>';return;}
  const r=movData.resumen||{};
  const kpis=`<div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">
    <div class="kpi"><div class="kpi-label">Ubicadas</div><div class="kpi-val green">${r.ubicadas||0}</div><div class="kpi-sub">con ingreso confirmado</div></div>
    <div class="kpi amber"><div class="kpi-label">En viaje</div><div class="kpi-val" style="color:var(--diesel)">${r.en_viaje||0}</div><div class="kpi-sub">salieron, todavía no llegaron</div></div>
    <div class="kpi ${r.demoradas?'':'plain'}"><div class="kpi-label">Sin recibir hace +2 días</div><div class="kpi-val" style="color:${r.demoradas?'var(--rojo)':'var(--tinta-3)'}">${r.demoradas||0}</div><div class="kpi-sub">hay que preguntar dónde están</div></div>
    <div class="kpi plain"><div class="kpi-label">Sin registrar</div><div class="kpi-val" style="color:var(--tinta-3)">${r.sin_registrar||0}</div><div class="kpi-sub">nadie las cargó todavía</div></div>
  </div>`;
  // Lo accionable primero: salió y nadie marcó la llegada
  const sr=movData.sin_recibir||[];
  const alerta=sr.length?`<div class="card" style="padding:14px 16px;margin-bottom:14px;border-left:3px solid var(--rojo);background:var(--rojo-soft)">
    <div style="font-weight:600;color:#A62F3E;margin-bottom:2px">Salieron y nadie marcó la llegada</div>
    <div class="sub" style="color:#A62F3E;opacity:.85;margin-bottom:9px">Puede ser que el supervisor no la marcó al recibirla, o que la máquina no esté donde se cree.</div>
    ${sr.map(f=>`<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid rgba(220,74,91,.16)">
      <div style="flex:1;min-width:230px"><b>${f.rotulo}</b> <span class="sub">${f.detalle||''}</span><br>
        <span class="sub">${f.donde||'—'} → ${f.hacia||'—'}</span></div>
      <span class="mono" style="color:${f.dias>2?'var(--rojo)':'var(--diesel)'}"><b>${f.dias||0} d</b> en viaje</span>
      <span class="sub">sacó ${f.quien||'—'}${f.retira?' · lleva '+f.retira:''}</span>
      <button class="btn-salir" style="padding:5px 10px;font-size:12px" onclick="movRecibir('${f.unidad_id}')">Marcar llegada</button>
    </div>`).join('')}
  </div>`:'';
  let cuerpo='';
  if(movTab==='flota')cuerpo=movVistaFlota();
  if(movTab==='movs')cuerpo=movVistaMovs();
  if(movTab==='objetivo')cuerpo=movVistaObjetivo();
  view.innerHTML=tabsMov()+kpis+alerta+cuerpo;
}
function movVistaFlota(){
  const objs=[...new Set((movData.flota||[]).map(f=>f.donde).filter(Boolean))].sort();
  const q=movBusca.toLowerCase().split(/\s+/).filter(Boolean);
  const filas=(movData.flota||[]).filter(f=>{
    if(movFiltroObj&&f.donde!==movFiltroObj)return false;
    if(movFiltroEst==='falla'&&f.estado_maquina!=='con_falla')return false;
    if(movFiltroEst==='viaje'&&f.situacion!=='en_transito')return false;
    if(movFiltroEst==='sin'&&f.situacion!=='sin_registrar')return false;
    if(!q.length)return true;
    const blob=[f.rotulo,f.detalle,f.donde,f.hacia,f.quien,f.obs].join(' ').toLowerCase();
    return q.every(w=>blob.includes(w));
  });
  return `<div class="card" style="padding:16px">
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <input id="mov-q" placeholder="Buscar máquina, patente, objetivo…" value="${movBusca.replace(/"/g,'&quot;')}"
        oninput="movBusca=this.value;renderMov();setTimeout(()=>{const i=document.getElementById('mov-q');if(i){i.focus();i.setSelectionRange(i.value.length,i.value.length)}},0)"
        style="flex:1;min-width:220px;padding:8px 11px;border:1px solid var(--linea-2);border-radius:var(--r-s);font-family:inherit;font-size:13px">
      <select onchange="movFiltroObj=this.value;renderMov()" style="padding:8px 11px;border:1px solid var(--linea-2);border-radius:var(--r-s);font-family:inherit;font-size:13px">
        <option value="">Todos los lugares</option>
        ${objs.map(o=>`<option ${movFiltroObj===o?'selected':''}>${o}</option>`).join('')}
      </select>
      <select onchange="movFiltroEst=this.value;renderMov()" style="padding:8px 11px;border:1px solid var(--linea-2);border-radius:var(--r-s);font-family:inherit;font-size:13px">
        <option value="">Todos los estados</option>
        <option value="falla" ${movFiltroEst==='falla'?'selected':''}>Solo con falla</option>
        <option value="viaje" ${movFiltroEst==='viaje'?'selected':''}>Solo en viaje</option>
        <option value="sin" ${movFiltroEst==='sin'?'selected':''}>Sin registrar</option>
      </select>
    </div>
    <table><thead><tr><th>Máquina</th><th>Dónde está</th><th>Desde</th><th>Estado</th><th>Último movimiento</th></tr></thead><tbody>
    ${filas.map(f=>`<tr style="cursor:pointer" onclick="movVerFicha('${f.unidad_id}')">
      <td><b>${f.rotulo}</b>${f.detalle?`<div class="sub" style="font-size:11px">${f.detalle}</div>`:''}</td>
      <td>${movBadgeUbic(f)}</td>
      <td class="mono" style="${f.situacion==='en_transito'&&f.dias>2?'color:var(--rojo)':''}">${f.dias!=null?f.dias+' d':'—'}</td>
      <td>${movBadgeEst(f.estado_maquina)}</td>
      <td class="sub">${f.situacion==='sin_registrar'?'Nadie la cargó todavía'
        :`${f.situacion==='en_transito'?'sacó':'recibió'} ${f.quien||'—'}<div class="mono" style="font-size:10.5px;color:var(--tinta-3)">${movFecha(f.desde_at)}${f.obs?' · '+f.obs.slice(0,40):''}</div>`}</td>
    </tr>`).join('')||'<tr><td colspan="5" class="sub" style="padding:18px;text-align:center">Nada con ese filtro.</td></tr>'}
    </tbody></table>
    <div class="sub" style="font-size:11.5px;margin-top:9px">${filas.length} de ${(movData.flota||[]).length} máquinas · las “sin registrar” aparecen hasta que un supervisor las dé de alta desde la app.</div>
  </div>`;
}
function movVistaMovs(){
  const ms=movData.movimientos||[];
  return `<div class="card" style="padding:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
      <div style="font-weight:600">Movimientos de los últimos ${movData.dias} días</div>
      <select onchange="movDias=Number(this.value);go('movimientos')" style="padding:7px 10px;border:1px solid var(--linea-2);border-radius:var(--r-s);font-family:inherit;font-size:13px">
        ${[7,30,90,365].map(d=>`<option value="${d}" ${movDias===d?'selected':''}>${d===365?'Último año':'Últimos '+d+' días'}</option>`).join('')}
      </select>
    </div>
    <table><thead><tr><th>Máquina</th><th>Recorrido</th><th>Salida</th><th>Llegada</th><th>Estado</th><th>Observaciones</th></tr></thead><tbody>
    ${ms.map(m=>`<tr style="cursor:pointer" onclick="movVerFicha('${m.unidad_id}')">
      <td><b>${m.unidad}</b></td>
      <td>${m.desde} → ${m.hasta}</td>
      <td class="sub"><span class="mono">${movFecha(m.salida_at)}</span><div style="font-size:11px">${m.salida_por||'—'}${m.retira?' · lleva '+m.retira:''}</div></td>
      <td class="sub">${m.estado==='en_transito'?'<span class="badge b-amber">en viaje</span>'
        :`<span class="mono">${movFecha(m.llegada_at)}</span><div style="font-size:11px">${m.llegada_por||'—'}</div>`}</td>
      <td>${movBadgeEst(m.llegada_estado||m.salida_estado)}</td>
      <td class="sub" style="font-size:11.5px">${[m.salida_obs,m.llegada_obs].filter(Boolean).join(' · ')||'—'}</td>
    </tr>`).join('')||'<tr><td colspan="6" class="sub" style="padding:18px;text-align:center">Todavía no hay movimientos registrados.</td></tr>'}
    </tbody></table>
  </div>`;
}
function movVistaObjetivo(){
  const fs=movData.por_objetivo||[];
  return `<div class="card" style="padding:16px">
    <div style="font-weight:600;margin-bottom:3px">Por objetivo · últimos ${movData.dias} días</div>
    <div class="sub" style="margin-bottom:11px">“Llegaron con falla” sale del estado que marca el supervisor al recibirla: si un objetivo devuelve todo roto, aparece acá sin que nadie lo cuente aparte.</div>
    <table><thead><tr><th>Objetivo</th><th>Máquinas hoy</th><th>Entraron</th><th>Salieron</th><th>Llegaron con falla</th></tr></thead><tbody>
    ${fs.map(o=>{
      const pct=o.entraron?o.llegaron_falla/o.entraron:0;
      const cls=!o.entraron?'b-gray':pct>=.6?'b-red':pct>0?'b-amber':'b-green';
      return `<tr><td><b>${o.objetivo}</b></td><td class="mono">${o.hoy}</td><td class="mono">${o.entraron}</td><td class="mono">${o.salieron}</td>
        <td><span class="badge ${cls}">${o.entraron?o.llegaron_falla+' de '+o.entraron:'—'}</span></td></tr>`;
    }).join('')||'<tr><td colspan="5" class="sub" style="padding:18px;text-align:center">Sin movimientos en el período.</td></tr>'}
    </tbody></table>
  </div>`;
}
// Ficha de una máquina: el hilo completo de viajes
async function movVerFicha(unidadId){
  movFicha={cargando:true};
  movModal();
  try{movFicha=await api('/api/movimientos/unidad/'+unidadId);}
  catch(e){movFicha={error:e.message};}
  movModal();
}
function movModal(){
  // Usa las clases del panel (.modal-bg/.modal): la primera versión usaba
  // class="card", que en el panel NO existe — quedaba una caja transparente
  // encima de la tabla, ilegible.
  let ovl=document.getElementById('mov-modal');
  if(!ovl){
    ovl=document.createElement('div');
    ovl.id='mov-modal';ovl.className='modal-bg abierto';
    ovl.onclick=e=>{if(e.target===ovl)movCerrarFicha();};
    document.body.appendChild(ovl);
  }
  const f=movFicha||{};
  if(f.cargando){ovl.innerHTML='<div class="modal" style="max-width:420px">Cargando historial…</div>';return;}
  if(f.error){ovl.innerHTML=`<div class="modal" style="max-width:420px"><h3>No pude abrir la ficha</h3><div class="sub">${f.error}</div>
    <div style="margin-top:16px;text-align:right"><button class="btn-salir" onclick="movCerrarFicha()">Cerrar</button></div></div>`;return;}
  const t=f.totales||{}, h=f.historial||[];
  ovl.innerHTML=`<div class="modal" style="max-width:540px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:4px">
      <div><div style="font-size:17px;font-weight:600">${f.unidad.rotulo}</div>
        <div class="sub">${f.unidad.detalle||''}</div></div>
      <button class="btn-salir" style="padding:5px 10px;font-size:12px" onclick="movCerrarFicha()">✕</button>
    </div>
    <div class="sub" style="margin:14px 0 18px;padding:10px 12px;background:var(--papel);border:1px solid var(--linea);border-radius:var(--r-s)">
      ${t.movimientos} movimiento${t.movimientos===1?'':'s'} · ${t.objetivos} lugar${t.objetivos===1?'':'es'} distinto${t.objetivos===1?'':'s'} · <b>${t.dias_taller} día${t.dias_taller===1?'':'s'}</b> en taller
    </div>
    <div style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:var(--tinta-3);font-weight:600;margin-bottom:12px">Historial</div>
    ${h.length?`<div style="position:relative;padding-left:22px;border-left:2px solid var(--linea-2);margin-left:5px">
    ${h.map(m=>{
      const enViaje=m.estado==='en_transito';
      const col=enViaje?'var(--diesel)':'var(--brote)';
      const dias=enViaje?Math.ceil((Date.now()-new Date(m.salida_at).getTime())/864e5):null;
      return `<div style="position:relative;padding-bottom:18px">
        <div style="position:absolute;left:-29px;top:3px;width:10px;height:10px;border-radius:50%;background:${col};border:2px solid var(--blanco);box-shadow:0 0 0 1.5px ${col}"></div>
        <div style="font-size:13.5px;font-weight:600">${m.desde} → ${m.hasta}</div>
        <div class="sub" style="font-size:12px">${enViaje?'Salió':'Recibió'} ${enViaje?(m.salida_por||'—'):(m.llegada_por||'—')}${m.retira?' · lleva '+m.retira:''} · ${(m.llegada_estado||m.salida_estado)==='con_falla'?'<b style="color:var(--rojo)">con falla</b>':'anda bien'}</div>
        ${[m.salida_obs,m.llegada_obs].filter(Boolean).length?`<div class="sub" style="font-size:12px;font-style:italic">“${[m.salida_obs,m.llegada_obs].filter(Boolean).join(' · ')}”</div>`:''}
        ${enViaje?`<div class="sub" style="font-size:12px;color:var(--rojo)">Sin llegada hace ${dias} día${dias===1?'':'s'}</div>`:''}
        <div class="mono" style="font-size:10.5px;color:var(--tinta-3);margin-top:2px">${movFechaH(m.llegada_at||m.salida_at)}</div>
      </div>`;
    }).join('')}
    </div>`:'<div class="sub">Todavía no hay movimientos registrados de esta máquina.</div>'}
  </div>`;
}
function movCerrarFicha(){const o=document.getElementById('mov-modal');if(o)o.remove();movFicha=null;}
// Cerrar un viaje desde el panel (cuando el supervisor no marcó la llegada)
async function movRecibir(unidadId){
  const f=(movData.sin_recibir||[]).find(x=>String(x.unidad_id)===String(unidadId));
  if(!f)return;
  const det=await api('/api/movimientos/unidad/'+unidadId).catch(()=>null);
  const abierto=det&&(det.historial||[]).find(m=>m.estado==='en_transito');
  if(!abierto){alert('Ese viaje ya está cerrado. Recargá la vista.');return;}
  if(!confirm('¿Marcar que '+f.rotulo+' llegó a '+(f.hacia||'destino')+'?\n\nQueda registrado como cerrado desde el panel, no por el supervisor.'))return;
  try{
    await api('/api/movimientos/'+abierto.id+'/recibir',{method:'POST',body:JSON.stringify({estado:'anda',observaciones:'Llegada marcada desde el panel'})});
    go('movimientos');
  }catch(e){alert(e.message||'No pude marcar la llegada');}
}

const MODS_PANEL=[['dashboard','Dashboard'],['insumos','Insumos'],['combustible','Combustible'],['compras','Compras'],['reparaciones','Reparaciones'],['stock','Stock'],['movimientos','Movimientos'],['maestros','Maestros']];
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
    const acciones=`<div style="display:flex;gap:5px;justify-content:flex-end;flex-wrap:wrap">
        ${r.intervalo&&(r.estado==='vencido'||r.estado==='por_vencer')&&!r.incidencia_abierta?`<button class="mini-btn" onclick="pvAlta('${r.id}','${nom}')">+ Preventivo</button>`:''}
        <button class="mini-btn" title="Frecuencia propia de esta unidad" onclick="pvPlan('${r.id}')">🗓 Plan</button>
        ${r.intervalo?`<button class="mini-btn" title="Marcar service realizado hoy" onclick="pvRealizado('${r.id}','${nom}')">✓ Realizado</button>
        <button class="mini-btn" title="Correr el vencimiento" onclick="pvReprogramar('${r.id}','${nom}')">↻</button>`:''}
      </div>`;
    return `<tr>
      <td><div style="font-weight:500">${r.tipo_label}</div><div class="sub">${r.marca_modelo||''}</div></td>
      <td>${ident}${r.codigo&&r.patente?`<div class="sub mono" style="margin-top:3px">${r.patente}</div>`:''}</td>
      <td><span class="sub mono" style="font-size:11px">cada ${r.intervalo||'—'} días${r.plan_propio&&r.habiles?' hábiles':''}</span>
        ${r.plan_propio?'<div style="margin-top:3px"><span class="badge" style="background:#EDE7FB;color:#5B3FB8;font-size:9.5px">plan propio</span></div>':''}</td>
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
        <thead><tr><th>Equipo</th><th>Unidad</th><th>Mecánico</th><th>Estado</th><th>Hace</th><th>Cada cuánto</th><th></th></tr></thead>
        <tbody>${pvData.en_curso.map(i=>{
          const eidx=EST_REP.indexOf(i.estado);
          // Se busca la unidad de esta preventiva para mostrar (y cargar) su
          // frecuencia acá mismo: es donde uno se pregunta cuándo se repite.
          const pl=pvPlanDe(i);
          return `<tr>
          <td style="font-weight:500;cursor:pointer" onclick="repTab='resumen';go('reparaciones')">${i.tipo_equipo||'—'}</td>
          <td>${i.numero_unidad?`<span class="uni-num">${i.numero_unidad}</span>`:'—'}</td>
          <td>${i.mecanicos?i.mecanicos.nombre:'<span class="sub">sin asignar</span>'}</td>
          <td><span class="badge ${eidx>=0?'est-'+eidx:'b-gray'}">${EST_REP_LABEL[eidx]||i.estado}</span></td>
          <td class="sub mono">${hace(i.created_at)}</td>
          <td>${pl
            ? `<span class="mono" style="font-size:12px">cada ${pl.intervalo_dias} días${pl.habiles?' hábiles':''}</span>
               ${pl.proximo?`<div class="sub" style="font-size:10.5px">próximo ${fechaAR(pl.proximo)}</div>`:''}`
            : '<span class="sub" style="font-size:11.5px;color:var(--diesel)">sin frecuencia</span>'}</td>
          <td><button class="mini-btn" style="${pl?'':'color:var(--brote);font-weight:600'}"
            onclick="event.stopPropagation();pvPlanMaq('${String(i.tipo_equipo||'').replace(/'/g,"\\'")}','${String(i.numero_unidad||'').replace(/'/g,"\\'")}')">
            🗓 ${pl?'Editar plan':'Programar'}</button></td></tr>`;}).join('')}</tbody>
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
/* ── Plan de preventivo de UNA unidad ────────────────────────────
   La frecuencia propia manda sobre el intervalo del tipo. Se cuenta en
   días HÁBILES por defecto (sin sábados ni domingos) y, si la fecha cae
   fin de semana, se adelanta al viernes: el taller no trabaja el finde
   y adelantar es más seguro que atrasar. */
function pvSumarHabiles(desde,n){
  const d=new Date(desde);let q=Math.max(0,Math.round(n));
  while(q>0){d.setDate(d.getDate()+1);const w=d.getDay();if(w!==0&&w!==6)q--;}
  return d;
}
function pvADiaHabil(f){
  const d=new Date(f),w=d.getDay();
  if(w===6)d.setDate(d.getDate()-1);else if(w===0)d.setDate(d.getDate()-2);
  return d;
}
function pvProximo(ultimo,intervalo,habiles){
  if(!ultimo||!intervalo)return null;
  const base=new Date(ultimo);if(isNaN(base))return null;
  return pvADiaHabil(habiles?pvSumarHabiles(base,intervalo):new Date(base.getTime()+intervalo*86400000));
}
/* Cruza una incidencia preventiva con su unidad del semáforo. La
   incidencia guarda `numero_unidad` como texto, así que se compara
   normalizado contra código y patente. */
function pvNormU(t){
  return String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/^\s*(numero|num|nro|unidad|interno|n[°ºo]|n)\s*\.?\s*/,'')
    .replace(/[^a-z0-9]/g,'')||'sn';
}
/* Busca el PLAN de una máquina. Antes buscaba en los rodados del semáforo
   y por eso la Hidro grúa G1 quedaba sin botón: no es un rodado. Los
   planes son independientes — cualquier equipo puede tener el suyo. */
function pvPlanDe(inc){
  const eq=String(inc.tipo_equipo||'').toLowerCase().trim();
  const un=pvNormU(inc.numero_unidad);
  return (pvData&&pvData.planes||[]).find(p=>
    String(p.equipo||'').toLowerCase().trim()===eq&&p.unidad_norm===un)||null;
}

/* Modal del plan de CUALQUIER máquina — no depende de la tabla unidades. */
let pvPlanM=null;
function pvPlanMaq(equipo,unidad){
  const existente=(pvData&&pvData.planes||[]).find(p=>
    String(p.equipo||'').toLowerCase().trim()===String(equipo||'').toLowerCase().trim()
    &&p.unidad_norm===pvNormU(unidad));
  pvPlanM=existente?{...existente}:{equipo,unidad,intervalo_dias:'',habiles:true,
    desde:new Date().toLocaleDateString('sv-SE'),ultimo:null,mecanico_id:null,tarea:'',activo:true};
  pintarPvPlanM();
}
function pintarPvPlanM(){
  const p=pvPlanM;if(!p)return;
  const inp='width:100%;padding:9px 11px;border:1px solid var(--linea);border-radius:9px;font-family:inherit;font-size:13.5px;box-sizing:border-box';
  document.getElementById('mm-titulo').textContent=(p.id?'Editar plan · ':'Programar preventivo · ')+
    (p.equipo||'')+(p.unidad?' · '+p.unidad:'');
  document.getElementById('mm-campos').innerHTML=`
    <div style="display:grid;grid-template-columns:110px 1fr;gap:8px">
      <div class="mm-field"><label>Cada</label>
        <input id="pm-dias" type="number" min="1" value="${p.intervalo_dias||''}" placeholder="30" style="${inp}" oninput="pvPlanMPreview()"></div>
      <div class="mm-field"><label>Contando</label>
        <select id="pm-hab" style="${inp}" onchange="pvPlanMPreview()">
          <option value="1" ${p.habiles!==false?'selected':''}>días hábiles (sin sábado ni domingo)</option>
          <option value="0" ${p.habiles===false?'selected':''}>días corridos</option>
        </select></div>
    </div>
    <div class="mm-field"><label>Último service (o desde cuándo contar)</label>
      <input id="pm-desde" type="date" value="${String(p.ultimo||p.desde||new Date().toLocaleDateString('sv-SE')).slice(0,10)}" style="${inp}" oninput="pvPlanMPreview()"></div>
    <div id="pm-preview" style="background:var(--brote-soft);border-radius:9px;padding:10px 13px;font-size:13px;margin:10px 0"></div>
    <div class="mm-field"><label>Mecánico que suele hacerlo</label>
      <select id="pm-mec" style="${inp}">
        <option value="">— elegir al generar la orden —</option>
        ${(mecanicos||[]).map(m=>`<option value="${m.id}" ${p.mecanico_id===m.id?'selected':''}>${escStk(m.nombre)}</option>`).join('')}
      </select></div>
    <div class="mm-field"><label>Qué incluye el service</label>
      <textarea id="pm-tarea" placeholder="ej: cambio de aceite y filtros, engrase, control de mangueras"
        style="${inp};min-height:60px">${escStk(p.tarea||'')}</textarea></div>
    <div class="modal-acciones" style="justify-content:space-between">
      ${p.id?`<button class="btn-salir" style="color:var(--rojo)" onclick="pvPlanMBorrar('${p.id}')">Quitar plan</button>`:'<span></span>'}
      <div style="display:flex;gap:8px">
        <button class="btn-salir" onclick="cerrarMaestro();pvPlanM=null">Cancelar</button>
        <button class="btn" onclick="pvPlanMGuardar()">Guardar</button>
      </div>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
  pvPlanMPreview();
}
function pvPlanMPreview(){
  const g=x=>document.getElementById(x),el=g('pm-preview');if(!el)return;
  const dias=Number(g('pm-dias').value)||0, hab=g('pm-hab').value==='1', desde=g('pm-desde').value;
  if(!dias||!desde){el.innerHTML='<span class="sub">Cargá la frecuencia para ver cuándo cae el próximo.</span>';return;}
  const px=pvProximo(desde,dias,hab);if(!px){el.innerHTML='<span class="sub">Revisá la fecha.</span>';return;}
  const corridos=Math.round((px-new Date(desde))/86400000);
  const D=['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  el.innerHTML=`Próximo service: <b>${D[px.getDay()]} ${px.toLocaleDateString('es-AR')}</b>
    <div class="sub" style="font-size:12px;margin-top:3px">
      ${hab?`${dias} días hábiles = <b>${corridos} días corridos</b>`:`${dias} días corridos`}
      ${px.getDay()===5&&!hab?' · adelantado al viernes':''}</div>`;
}
async function pvPlanMGuardar(){
  const g=x=>document.getElementById(x);
  const dias=Number(g('pm-dias').value)||0;
  if(!dias){toast('Poné cada cuántos días','error');return;}
  try{
    await api('/api/reparaciones/preventivo/plan-maquina',{method:'POST',body:JSON.stringify({
      equipo:pvPlanM.equipo, unidad:pvPlanM.unidad, intervalo_dias:dias,
      habiles:g('pm-hab').value==='1', ultimo:g('pm-desde').value||null, desde:g('pm-desde').value||null,
      mecanico_id:g('pm-mec').value||null, tarea:g('pm-tarea').value.trim(), activo:true})});
    cerrarMaestro();pvPlanM=null;pvData=null;go('reparaciones');
    toast('Plan guardado');
  }catch(e){toast('No pude guardar: '+(e.message||''),'error');}
}
async function pvPlanMBorrar(id){
  if(!await uiConfirm('La máquina deja de tener frecuencia programada.','¿Quitar el plan?',{ok:'Quitar'}))return;
  try{
    await api('/api/reparaciones/preventivo/plan-maquina/'+id,{method:'DELETE'});
    cerrarMaestro();pvPlanM=null;pvData=null;go('reparaciones');
    toast('Plan quitado');
  }catch(e){toast('No pude: '+(e.message||''),'error');}
}

let pvPlanU=null;
function pvPlan(id){
  const r=(pvData&&pvData.rodados||[]).find(x=>x.id===id);
  if(!r)return;
  pvPlanU={...r};
  pintarPvPlan();
}
function pintarPvPlan(){
  const r=pvPlanU;if(!r)return;
  const inp='width:100%;padding:9px 11px;border:1px solid var(--linea);border-radius:9px;font-family:inherit;font-size:13.5px;box-sizing:border-box';
  const base=r.ultimo||r.prev_desde||new Date().toLocaleDateString('sv-SE');
  document.getElementById('mm-titulo').textContent='Plan de preventivo · '+(r.codigo||r.patente||r.tipo_label);
  document.getElementById('mm-campos').innerHTML=`
    <div class="sub" style="margin-bottom:12px">${escStk(r.tipo_label||'')}${r.marca_modelo?' · '+escStk(r.marca_modelo):''}
      ${r.intervalo&&!r.plan_propio?`<div style="margin-top:4px">Hoy usa el intervalo del tipo: <b>cada ${r.intervalo} días corridos</b></div>`:''}</div>

    <div style="display:grid;grid-template-columns:110px 1fr;gap:8px">
      <div class="mm-field"><label>Cada</label>
        <input id="pv-dias" type="number" min="1" value="${r.plan_propio?r.intervalo:''}" placeholder="${r.intervalo||30}" style="${inp}" oninput="pvPlanPreview()"></div>
      <div class="mm-field"><label>Contando</label>
        <select id="pv-hab" style="${inp}" onchange="pvPlanPreview()">
          <option value="1" ${r.habiles!==false?'selected':''}>días hábiles (sin sábado ni domingo)</option>
          <option value="0" ${r.habiles===false?'selected':''}>días corridos</option>
        </select></div>
    </div>

    <div class="mm-field"><label>Contar desde</label>
      <input id="pv-desde" type="date" value="${String(base).slice(0,10)}" style="${inp}" oninput="pvPlanPreview()">
      <div class="sub" style="font-size:11.5px;margin-top:3px">${r.ultimo?'Último service registrado: '+fechaAR(r.ultimo):'Esta unidad no tiene service registrado'}</div></div>

    <div id="pv-preview" style="background:var(--brote-soft);border-radius:9px;padding:10px 13px;font-size:13px;margin:10px 0"></div>

    <div class="mm-field"><label>Mecánico que suele hacerlo</label>
      <select id="pv-mec" style="${inp}">
        <option value="">— elegir al generar la orden —</option>
        ${(mecanicos||[]).map(m=>`<option value="${m.id}" ${r.prev_mecanico_id===m.id?'selected':''}>${escStk(m.nombre)}</option>`).join('')}
      </select></div>

    <div class="mm-field"><label>Qué incluye el service (opcional)</label>
      <textarea id="pv-tarea" placeholder="ej: cambio de aceite y filtros, engrase, control de correas"
        style="${inp};min-height:60px">${escStk(r.prev_tarea||'')}</textarea>
      <div class="sub" style="font-size:11.5px;margin-top:3px">Va como descripción de la orden cuando se genere.</div></div>

    <label class="sub" style="display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer;margin-top:6px">
      <input type="checkbox" id="pv-activo" ${r.prev_activo!==false?'checked':''} style="accent-color:var(--brote)">
      Esta unidad entra en el plan de preventivo
    </label>

    <div class="modal-acciones" style="justify-content:space-between">
      <button class="btn-salir" style="color:var(--rojo)" onclick="pvPlanBorrar()">Quitar plan propio</button>
      <div style="display:flex;gap:8px">
        <button class="btn-salir" onclick="cerrarMaestro();pvPlanU=null">Cancelar</button>
        <button class="btn" onclick="pvPlanGuardar()">Guardar</button>
      </div>
    </div>`;
  document.getElementById('mm-acciones').style.display='none';
  document.getElementById('mm-bg').classList.add('abierto');
  pvPlanPreview();
}
/* La fecha resultante EN VIVO. Es lo más importante del modal: contar en
   hábiles estira bastante (40 hábiles ≈ 56 corridos) y hay que verlo
   antes de guardar, no descubrirlo después. */
function pvPlanPreview(){
  const g=x=>document.getElementById(x);
  const el=g('pv-preview');if(!el)return;
  const dias=Number(g('pv-dias').value)||0;
  const hab=g('pv-hab').value==='1';
  const desde=g('pv-desde').value;
  if(!dias||!desde){el.innerHTML='<span class="sub">Cargá la frecuencia para ver cuándo caería el próximo.</span>';return;}
  const px=pvProximo(desde,dias,hab);
  if(!px){el.innerHTML='<span class="sub">Revisá la fecha.</span>';return;}
  const corridos=Math.round((px-new Date(desde))/86400000);
  const D=['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  el.innerHTML=`Próximo service: <b>${D[px.getDay()]} ${px.toLocaleDateString('es-AR')}</b>
    <div class="sub" style="font-size:12px;margin-top:3px">
      ${hab?`${dias} días hábiles = <b>${corridos} días corridos</b>`:`${dias} días corridos`}
      ${px.getDay()===5?' · adelantado al viernes para no caer fin de semana':''}</div>`;
}
async function pvPlanGuardar(){
  const g=x=>document.getElementById(x);
  const dias=Number(g('pv-dias').value)||null;
  if(!dias){toast('Poné cada cuántos días','error');return;}
  try{
    await api('/api/reparaciones/preventivo/plan',{method:'POST',body:JSON.stringify({
      unidad_id:pvPlanU.id, intervalo_dias:dias, habiles:g('pv-hab').value==='1',
      desde:g('pv-desde').value||null, mecanico_id:g('pv-mec').value||null,
      tarea:g('pv-tarea').value.trim(), activo:g('pv-activo').checked})});
    cerrarMaestro();pvPlanU=null;pvData=null;go('reparaciones');
    toast('Plan guardado');
  }catch(e){toast('No pude guardar: '+(e.message||''),'error');}
}
async function pvPlanBorrar(){
  if(!await uiConfirm('La unidad vuelve a usar el intervalo de su tipo de rodado.','¿Quitar el plan propio?',{ok:'Quitar'}))return;
  try{
    await api('/api/reparaciones/preventivo/plan',{method:'POST',body:JSON.stringify({
      unidad_id:pvPlanU.id, intervalo_dias:null})});
    cerrarMaestro();pvPlanU=null;pvData=null;go('reparaciones');
    toast('Plan quitado');
  }catch(e){toast('No pude: '+(e.message||''),'error');}
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
let ccFiltro='todos';  // filtro activos/inactivos en Centros de costo
// Códigos de centro de costo de Flexxus: el GET plano trae solo los activos,
// por eso algunos (LA DESEADA, PROVINCIA…) figuran sin número. Esto sondea
// todas las variantes del API y cruza con la tabla del panel.
async function ccVerFlexxus(){
  const box=document.getElementById('cc-flexxus');if(!box)return;
  box.innerHTML='<div class="panel" style="margin-bottom:12px"><div class="sub">Consultando Flexxus…</div></div>';
  try{
    const d=await api('/api/compras/centroscosto-flexxus');
    const filas=(d.centros||[]).map(c=>`<tr>
      <td class="mono">${c.codigo}</td>
      <td>${c.descripcion}</td>
      <td>${c.en_panel?(c.codigo_en_panel==null?'<span class="badge" style="background:var(--diesel-soft);color:#854F0B">falta cargar</span>':(c.coincide?'<span class="badge b-green">✓ ok</span>':`<span class="badge" style="background:#FCEBED;color:#A32D2D">panel: ${c.codigo_en_panel}</span>`)):'<span class="sub">no está en el panel</span>'}</td>
    </tr>`).join('');
    box.innerHTML=`<div class="panel" style="margin-bottom:12px">
      <div class="panel-title">Centros de costo en Flexxus (${d.total_flexxus})</div>
      <div class="sub" style="font-size:11.5px;margin-bottom:8px">Rutas que respondieron: ${(d.intentos||[]).filter(i=>i.ok).map(i=>i.ruta+' ('+i.n+')').join(' · ')||'ninguna'}</div>
      <table style="font-size:12.5px"><thead><tr><th>Código</th><th>Descripción en Flexxus</th><th>Estado en el panel</th></tr></thead><tbody>${filas}</tbody></table>
      ${(d.solo_en_panel||[]).length?`<div class="sub" style="margin-top:10px;font-size:11.5px"><b>Están en el panel pero no en esta respuesta de Flexxus (${d.solo_en_panel.length}):</b> ${d.solo_en_panel.map(x=>x.nombre+(x.codigo_flexxus!=null?' ('+x.codigo_flexxus+')':' — sin código')).join(' · ')}</div>`:''}
    </div>`;
  }catch(e){box.innerHTML=`<div class="panel" style="margin-bottom:12px"><div class="sub">No pude consultar: ${e.message}</div></div>`;}
}
async function ccSincronizar(){
  if(!await uiConfirm('Completa el código de Flexxus en los centros del panel que no lo tengan, matcheando por nombre. No pisa los que ya tienen código.','↻ Traer códigos faltantes'))return;
  try{
    const r=await api('/api/compras/centroscosto-sincronizar',{method:'POST',body:'{}'});
    toast(r.actualizados?('Actualizados '+r.actualizados+' centros ✓'):'No había códigos nuevos para traer','info');
    cargarMaestros();ccVerFlexxus();
  }catch(e){toast(e.message||'No pude sincronizar','error');}
}
let ccBusca='';
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
    ${maestroTab==='centros_costo'?`<div class="sub" style="margin-bottom:10px">Son las entidades a las que se imputa el gasto en Compras: clientes, consorcios, organismos.</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <div class="subtabs" style="margin:0">
          ${[['todos','Todos'],['activos','Activos'],['inactivos','Inactivos'],['sin_codigo','Sin código Flexxus']].map(([v,l])=>`<div class="subtab ${ccFiltro===v?'on':''}" onclick="ccFiltro='${v}';renderMaestros()">${l}</div>`).join('')}
        </div>
        <input class="busca" style="width:200px" placeholder="Buscar…" value="${(ccBusca||'').replace(/"/g,'&quot;')}" oninput="ccBusca=this.value;renderMaestros()">
        <div class="spacer"></div>
        <button class="btn ghost" onclick="ccVerFlexxus()">🔍 Ver códigos en Flexxus</button>
        <button class="btn ghost" onclick="ccSincronizar()">↻ Traer códigos faltantes</button>
      </div>
      <div id="cc-flexxus"></div>`:''}
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
  if(!cont)return;
  let datos=maestrosData.map((m,ix)=>({m,ix}));
  if(maestroTab==='centros_costo'){
    if(ccFiltro==='activos')datos=datos.filter(d=>d.m.activo);
    else if(ccFiltro==='inactivos')datos=datos.filter(d=>!d.m.activo);
    else if(ccFiltro==='sin_codigo')datos=datos.filter(d=>!d.m.codigo_flexxus);
    const q=(ccBusca||'').trim().toLowerCase();
    if(q)datos=datos.filter(d=>String(d.m.nombre||'').toLowerCase().includes(q));
  }
  if(!datos.length){cont.innerHTML='<div class="empty" style="height:160px"><div>Sin resultados para este filtro.</div></div>';return;}
  cont.innerHTML='<div class="cardgrid">'+datos.map(d=>cardMaestro(d.m,d.ix)).join('')+'</div>';
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
    sub=`<span class="badge ${m.activo?'b-green':'b-gray'}" style="font-size:10px">${m.activo?'Activo':'Inactivo'}</span>`;
    extra=m.codigo_flexxus?`<div class="mcard-row"><span>Cód. Flexxus</span><b class="mono">${m.codigo_flexxus}</b></div>`:'<div class="mcard-row"><span>Cód. Flexxus</span><b style="color:var(--diesel)">sin cargar</b></div>';
  }
  if(maestroTab==='objetivos'){
    sub=m.activo?'Activo':'Inactivo';
    const t=m.tipo||'operativo';
    // Grupo de stock: define cada cuánto el bot pide el censo (depósito 15
    // días / privado mensual). Se edita en el modal.
    const g=m.grupo_stock;
    const gBadge=g==='deposito'?'<span class="badge b-amber">depósito · 15d</span>'
      :g==='privado'?'<span class="badge" style="background:var(--azul-soft);color:var(--azul)">privado · mensual</span>'
      :'<span class="badge b-gray">sin grupo</span>';
    extra=`<div class="mcard-row"><span>Tipo</span><span class="badge ${t==='operativo'?'b-green':'b-gray'}">${t==='operativo'?'operativo':'imputación'}</span></div>
      <div class="mcard-row"><span>Grupo de stock</span>${gBadge}</div>
      ${m.codigo_flexxus?`<div class="mcard-row"><span>Cód. Flexxus</span><b class="mono">${m.codigo_flexxus}</b></div>`:'<div class="mcard-row"><span>Cód. Flexxus</span><b style="color:var(--diesel)">sin cargar</b></div>'}`;
  }
  if(maestroTab==='capataces'){
    sub=m.objetivos?m.objetivos.nombre:'sin objetivo';
    // Estado de acceso a la app de un vistazo: qué le falta a cada uno para
    // poder cargar combustible desde el celular.
    // El camión NO es requisito: la mayoría son capataces de objetivo y no
    // tienen uno fijo (la app les pide la patente escrita). Sí hacen falta
    // usuario, clave y objetivo — la carga se cuelga del objetivo.
    const listo=!!(m.usuario&&m.tiene_clave&&m.objetivo_id);
    const falta=!m.usuario?'falta usuario':!m.tiene_clave?'falta clave'
      :!m.objetivo_id?'falta objetivo':'';
    extra=`<div class="mcard-row"><span>Teléfono</span><b>${m.telefono||'—'}</b></div>${m.rol?`<div class="mcard-row"><span>Rol</span><b>${m.rol}</b></div>`:''}
      <div class="mcard-row"><span>App</span>${listo
        ?`<span class="badge b-green" style="font-size:10px">✓ ${m.usuario}</span>`
        :`<span class="badge b-amber" style="font-size:10px">${falta}</span>`}</div>`;
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
    // Acceso a la app (11-ago): cada capataz entra con su usuario y carga el
    // combustible desde el celular. La carga sale con SU objetivo y SU unidad,
    // así que las dos cosas de arriba tienen que estar completas.
    campos+=`<div class="divider"></div>
      <div class="dl" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--tinta-3);font-weight:600;margin-bottom:8px">Acceso a la app</div>
      <div class="mm-field"><label>Usuario</label><input id="mm-usuario" value="${(m.usuario||'').replace(/"/g,'&quot;')}" placeholder="ej: claudio" autocapitalize="none"></div>
      <div class="mm-field"><label>Clave</label><input id="mm-clave" type="text" placeholder="${m.tiene_clave?'dejar vacío para no cambiarla':'clave para entrar a la app'}"></div>
      <div class="sub">La clave se guarda encriptada. Con usuario y clave, el capataz entra a ${location.origin}/app y carga el combustible con la foto del remito.</div>
      ${!m.objetivo_id?'<div class="sub" style="color:var(--diesel);margin-top:6px">⚠ Sin objetivo asignado acá arriba, la carga queda sin objetivo en el panel. El camión sí es opcional: si no tiene uno fijo, la app le pide la patente.</div>':''}`;
  }
  if(maestroTab==='centros_costo'){
    campos+=`<div class="mm-field"><label>Código de centro de costo en Flexxus <span style="font-weight:400;color:var(--tinta-3)">(columna centros de costo del diagnóstico ⚙, ej: EPEC = 12)</span></label><input id="mm-cflexxus" value="${(m.codigo_flexxus||'').replace(/"/g,'&quot;')}" placeholder="ej: 12"></div>`;
  }
  if(maestroTab==='objetivos'){
    campos+=`<div class="mm-field"><label>Ubicación</label><input id="mm-ubicacion" value="${(m.ubicacion||'').replace(/"/g,'&quot;')}" placeholder="Córdoba, Río Cuarto..."></div>`;
    campos+=`<div class="mm-field"><label>Tipo</label><select id="mm-tipo"><option value="operativo" ${(m.tipo||'operativo')==='operativo'?'selected':''}>Operativo</option><option value="imputacion" ${m.tipo==='imputacion'?'selected':''}>Imputación</option></select></div>`;
    campos+=`<div class="mm-field"><label>Código de centro de costo en Flexxus <span style="font-weight:400;color:var(--tinta-3)">(el que figura en Flexxus, ej: 012 para EPEC)</span></label><input id="mm-cflexxus" value="${(m.codigo_flexxus||'').replace(/"/g,'&quot;')}" placeholder="ej: 012"></div>`;
    campos+=`<div class="mm-field"><label>Grupo de stock <span style="font-weight:400;color:var(--tinta-3)">(depósito: la máquina sale cada día, control cada 15 días · privado: vive en el objetivo, control mensual)</span></label><select id="mm-grupo-stock">
      <option value="" ${!m.grupo_stock?'selected':''}>— sin grupo (el bot no le pide solo) —</option>
      <option value="deposito" ${m.grupo_stock==='deposito'?'selected':''}>Depósito · cada 15 días</option>
      <option value="privado" ${m.grupo_stock==='privado'?'selected':''}>Privado · 1 vez por mes</option>
    </select></div>`;
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
    const us=document.getElementById('mm-usuario');
    if(us)body.usuario=us.value.trim().toLowerCase()||null;
    const cl=document.getElementById('mm-clave');
    if(cl&&cl.value.trim())body.clave=cl.value.trim();   // vacío = no cambiar
  }
  if(maestroTab==='centros_costo'){
    body.codigo_flexxus=document.getElementById('mm-cflexxus').value.trim()||null;
  }
  if(maestroTab==='objetivos'){
    body.ubicacion=document.getElementById('mm-ubicacion').value.trim()||null;
    body.tipo=document.getElementById('mm-tipo').value||'operativo';
    body.codigo_flexxus=document.getElementById('mm-cflexxus').value.trim()||null;
    body.grupo_stock=document.getElementById('mm-grupo-stock').value||null;
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
    <div id="rt-aprobacion"></div>
    <div id="rt-encurso"></div>
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
// Cotizados pendientes de la aprobación de José. El PIN de súper admin se pide
// en el momento de aprobar (mismo mecanismo que Performance): los mecánicos
// también entran al panel y esta es la decisión de gastar.
/* Cotización EN CURSO: pedidos que ya tienen algún precio cargado pero
   todavía les falta cotizar alguno. Antes desaparecían — la lista de
   Compras arranca en la aprobación, y estos no llegan ahí hasta estar
   completos. Compras necesita verlos para saber qué falta averiguar. */
function renderRtEnCurso(){
  const cont=document.getElementById('rt-encurso');if(!cont)return;
  const enCurso=(rtData||[]).filter(p=>
    ['pedido','en_cotizacion'].includes(p.estado)&&
    (p.items||[]).some(i=>i.precio!=null||i.proveedor));
  if(!enCurso.length){cont.innerHTML='';return;}
  cont.innerHTML=`<div class="panel" style="border:1.5px solid var(--diesel);margin-bottom:14px">
    <div class="panel-title" style="color:var(--diesel)">🕐 Cotización en curso (${enCurso.length})</div>
    <div class="sub" style="font-size:12px;margin-bottom:10px">
      Ya tienen algún precio pero falta cotizar el resto. Cuando estén todos, pasan a tu aprobación.</div>
    ${enCurso.map(p=>{
      const i=p.incidencias||{};
      const its=p.items||[];
      const cot=its.filter(x=>x.precio!=null&&x.proveedor);
      const total=cot.reduce((a,x)=>a+x.precio*(Number(x.cantidad)||1),0);
      const dias=Math.ceil((Date.now()-new Date(p.created_at))/86400000);
      return `<div style="border:1px solid var(--linea);border-radius:11px;padding:12px 14px;margin-bottom:10px;background:var(--hueso)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
          <div style="font-weight:700;font-size:13.5px">${escStk(i.tipo_equipo||(i.equipos&&i.equipos.nombre)||'Equipo')}
            <span class="uni-num">${escStk(i.numero_unidad||'—')}</span>
            <span class="sub" style="font-weight:400">${i.objetivos?'· '+escStk(i.objetivos.nombre):''}</span></div>
          <span class="badge b-amber">${cot.length} de ${its.length} cotizado${cot.length===1?'':'s'}</span>
        </div>
        <div class="sub" style="font-size:11.5px;margin:4px 0 7px">👨‍🔧 ${escStk(p.pedido_por||'—')} · pedido hace ${dias} día${dias===1?'':'s'}</div>
        ${its.map(x=>`<div style="display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:2px 0">
          <span><span class="mono" style="color:var(--tinta-2)">x${x.cantidad||1}</span> ${escStk(x.descripcion)}</span>
          ${x.precio!=null&&x.proveedor
            ?`<span class="sub" style="white-space:nowrap">🏪 ${escStk(x.proveedor)} · <b class="mono" style="color:var(--tinta)">${money(x.precio*(Number(x.cantidad)||1))}</b></span>`
            :'<span style="color:var(--diesel);font-size:11.5px;white-space:nowrap">falta cotizar</span>'}</div>`).join('')}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid var(--linea);font-size:12.5px">
          <span class="sub">Parcial · faltan ${its.length-cot.length}</span>
          <span>Cotizado hasta ahora <b class="mono">${money(total)}</b></span></div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn" style="padding:7px 14px;font-size:12.5px" onclick="rtAprobarParcial('${p.id}')">✓ Aprobar lo cotizado</button>
          <button class="btn-salir" style="padding:7px 14px;font-size:12.5px" onclick="rtObservar('${p.id}')">Observar ↩</button>
        </div>
      </div>`;}).join('')}
  </div>`;
}

function renderRtAprobacion(){
  const cont=document.getElementById('rt-aprobacion');if(!cont)return;
  const cots=(rtData||[]).filter(p=>p.estado==='cotizado');
  if(!cots.length){cont.innerHTML='';return;}
  cont.innerHTML=`<div class="panel" style="border:1.5px solid var(--azul);margin-bottom:14px">
    <div class="panel-title" style="color:var(--azul)">✍️ Pendientes de tu aprobación (${cots.length})</div>
    ${cots.map(p=>{
      const i=p.incidencias||{};
      const dCot=p.cotizado_at?Math.ceil((new Date(p.cotizado_at)-new Date(p.created_at))/86400000):null;
      return `<div style="border:1px solid var(--linea);border-radius:11px;padding:12px 14px;margin-bottom:10px;background:var(--hueso)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:260px">
            <div style="font-weight:700;font-size:14px">🧾 Orden de compra — ${i.tipo_equipo||(i.equipos&&i.equipos.nombre)||'Equipo'} <span class="uni-num">${i.numero_unidad||'—'}</span>
              ${i.equipo_parado?`<span class="badge" style="background:#FCEBED;color:#A32D2D">⛔ parada</span>`:''}</div>
            <div class="sub" style="font-size:11.5px;margin:2px 0 8px">Solicita: <b>${i.mecanicos?i.mecanicos.nombre:(p.pedido_por||'—')}</b> · rep. #${String(i.id||'').slice(0,6)}${p.marca_modelo?' · '+p.marca_modelo:''}${dCot!=null?' · pedido→cotizado: '+dCot+' d':''}${p.foto_ruta?` · <a href="#" onclick="event.preventDefault();rtVerArchivo('${p.id}','foto')" style="color:var(--azul)">📷 foto</a>`:''}</div>
            <div style="background:#fff;border:1px solid var(--linea);border-radius:9px;padding:8px 11px;margin-bottom:8px">
              ${(p.items||[]).map(x=>`<div style="font-size:12.5px;padding:2px 0">x${x.cantidad||1} ${x.descripcion}${x.codigo?' <span class="sub">· '+x.codigo+'</span>':''}</div>`).join('')||'<div class="sub">Sin ítems</div>'}
              ${p.nota?`<div class="sub" style="font-size:11.5px;border-top:1px dashed var(--linea);margin-top:5px;padding-top:5px">📝 ${p.nota}</div>`:''}
            </div>
            <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px">
              <span>Proveedor: <b>${p.nota_proveedor||'—'}</b></span>
              <span>Precio: <b class="mono">${money(p.nota_precio||0)}</b></span>
              <span>Entrega: <b>${p.nota_plazo||'—'}</b></span>
              <span class="sub">cotizó ${p.cotizado_por||'—'}${p.cotizado_at?' · '+fechaAR(p.cotizado_at):''}${p.nota_adjunto?` · <a href="#" onclick="event.preventDefault();rtVerArchivo('${p.id}','adjunto')" style="color:var(--azul)">📎 adjunto</a>`:''}</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:7px;flex-shrink:0">
            <button class="btn" onclick="rtAprobar('${p.id}')">✓ Aprobar → a comprar</button>
            <button class="btn-salir" onclick="rtObservar('${p.id}')">Observar ↩</button>
          </div>
        </div>
      </div>`;}).join('')}
    <div class="sub" style="font-size:11px">"Observar" devuelve el pedido al Referente con tu comentario (vuelve a en cotización).</div>
  </div>`;
}
/* Aprobar un pedido al que todavía le faltan precios. Pasa igual a "a
   comprar": lo cotizado se compra ya y lo que falta se resuelve sobre la
   marcha. Esperar a tener los 4 precios puede dejar una máquina parada
   por un tornillo. */
async function rtAprobarParcial(id){
  const p=(rtData||[]).find(x=>String(x.id)===String(id));
  if(!p)return;
  const its=p.items||[];
  const cot=its.filter(i=>i.precio!=null&&i.proveedor);
  const faltan=its.length-cot.length;
  const total=cot.reduce((a,i)=>a+i.precio*(Number(i.cantidad)||1),0);
  const detalle=cot.map(i=>`• ${i.descripcion} — ${i.proveedor} ${money(i.precio*(Number(i.cantidad)||1))}`).join('\n');
  const sinCot=its.filter(i=>!(i.precio!=null&&i.proveedor)).map(i=>`• ${i.descripcion}`).join('\n');
  if(!await uiConfirm(
    `Se aprueban ${cot.length} de ${its.length} por ${money(total)}:\n${detalle}`+
    (faltan?`\n\nQuedan sin precio (se compran igual, se cotizan sobre la marcha):\n${sinCot}`:''),
    '¿Aprobar lo cotizado?',{ok:'✓ Aprobar'}))return;
  try{
    await api('/api/compras/repuestos/'+id+'/estado',{method:'POST',body:JSON.stringify({estado:'a_comprar'})});
    rtData=await api('/api/compras/repuestos');renderRt();
    toast(faltan?`Aprobado · ${faltan} sin cotizar van igual`:'Aprobado · pasa a comprar');
  }catch(e){toast('No pude aprobar: '+(e.message||''),'error');}
}

async function rtAprobar(id){
  const p=(rtData||[]).find(x=>String(x.id)===String(id))||{};
  if(!await uiConfirm('Nota: '+(p.nota_proveedor||'—')+' · '+money(p.nota_precio||0)+' · '+(p.nota_plazo||'—')+'\n\nAl aprobar pasa a A COMPRAR y Compras la ejecuta.','¿Aprobar la compra?',{ok:'✓ Aprobar'}))return;
  try{
    await api('/api/compras/repuestos/'+id+'/aprobar',{method:'POST',body:'{}'});
    toast('Aprobado ✓ — pasó a A COMPRAR');
    rtData=await api('/api/compras/repuestos');renderRt();
  }catch(e){toast(e.message||'No pude aprobar','error');}
}
async function rtObservar(id){
  const c=prompt('¿Qué hay que revisar? (vuelve al Referente con este comentario)');
  if(!c||!c.trim())return;
  try{
    await api('/api/compras/repuestos/'+id+'/observar',{method:'POST',body:JSON.stringify({comentario:c.trim()})});
    toast('Devuelto al Referente ↩');
    rtData=await api('/api/compras/repuestos');renderRt();
  }catch(e){toast(e.message||'No pude','error');}
}
function renderRt(){
  const kp=document.getElementById('rt-kpis'),ls=document.getElementById('rt-lista');
  if(!kp||!ls)return;
  renderRtAprobacion();
  renderRtEnCurso();
  // La lista clásica de Compras muestra SOLO desde la aprobación en adelante:
  // lo anterior (pedido / en cotización) es del Referente y se sigue en
  // Reparaciones → Repuestos.
  const all=(rtData||[]).filter(p=>!['pedido','en_cotizacion','cotizado'].includes(p.estado));
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
      ...(p.items||[]).map(i=>i.descripcion+' '+(i.codigo||'')+' '+(i.proveedor||''))].join(' ').toLowerCase();
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
        ${prioBadge(inc.prioridad)}
        <span style="font-weight:700;font-size:13.5px">${eq}</span>
        <span class="sub" style="font-size:12px">${inc.objetivos?inc.objetivos.nombre:''}</span>
        <div style="flex:1"></div>
        ${parcial?`<span class="badge b-amber">PARCIAL · ${nComp}/${its.length} comprados</span>`:`<span class="badge ${cls}">${etq}${done&&p.entregado_at?' · '+fechaAR(p.entregado_at):''}</span>`}
      </div>
      <div class="sub" style="font-size:12px;margin:5px 0 8px">👨‍🔧 ${inc.mecanicos?inc.mecanicos.nombre:(p.pedido_por||'—')} · pedido ${dias===0?'hoy':'hace '+dias+' día'+(dias===1?'':'s')}${!done&&dias>=3?' <b style="color:var(--rojo)">⚠</b>':''}</div>
      ${(()=>{
        // Cada repuesto puede venir de un proveedor distinto: se muestra
        // dónde y a cuánto se cotizó cada uno, no solo el nombre.
        const cot=i=>i.proveedor||i.precio!=null
          ?`<span class="sub" style="font-size:11.5px;white-space:nowrap">${i.proveedor?'🏪 '+escStk(i.proveedor):''}${i.precio!=null?` · <b class="mono" style="color:var(--tinta)">${money(i.precio*(Number(i.cantidad)||1))}</b>`:''}</span>`
          :'<span class="sub" style="font-size:11.5px;color:var(--diesel);white-space:nowrap">sin cotizar</span>';
        return its.map((i,idx)=>done
        ?`<div style="display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:3px 0">
            <span><span class="mono" style="color:var(--tinta-2)">x${i.cantidad||1}</span> <b>${escStk(i.descripcion)}</b></span>${cot(i)}</div>`
        :`<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding:3px 0;cursor:pointer">
            <input type="checkbox" ${i.comprado?'checked':''} onchange="rtItem('${p.id}',${idx},this.checked)" style="accent-color:var(--brote)">
            <span style="${i.comprado?'':'font-weight:600'};flex:1"><span class="mono" style="color:var(--tinta-2)">x${i.cantidad||1}</span> ${escStk(i.descripcion)}</span>
            ${cot(i)}
            ${i.comprado?'<span class="badge b-green" style="font-size:10px">comprado</span>':'<span class="badge b-amber" style="font-size:10px">falta</span>'}
          </label>`).join('');})()}
      ${(()=>{
        const conPrecio=its.filter(i=>i.precio!=null);
        if(!conPrecio.length)return '';
        const total=conPrecio.reduce((a,i)=>a+i.precio*(Number(i.cantidad)||1),0);
        const provs=[...new Set(its.filter(i=>i.proveedor).map(i=>i.proveedor))];
        const faltan=its.length-conPrecio.length;
        return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:7px;padding-top:7px;border-top:1px solid var(--linea);font-size:12.5px">
          <span class="sub">${provs.length===1?'1 proveedor':provs.length+' proveedores'}${faltan?` · <span style="color:var(--diesel)">${faltan} sin cotizar</span>`:''}</span>
          <span>Total cotizado <b class="mono">${money(total)}</b></span></div>`;})()}
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

/* ===== Compras · Reporte financiero contable (para Soledad) ===== */
let comprasFinMes=new Date().toISOString().slice(0,7);  // YYYY-MM

async function vComprasFinanciero(view){
  view.innerHTML=tabsCompras()+'<div class="cargando-v">Armando el reporte…</div>';
  try{
    const r=await api('/api/compras/reporte-financiero?mes='+encodeURIComponent(comprasFinMes));
    const k=r.kpis||{};
    const kpi=(l,v,sub)=>`<div class="kpi plain"><div class="kpi-label">${l}</div><div class="kpi-val" style="font-size:19px">${v}</div>${sub?`<div class="kpi-sub">${sub}</div>`:''}</div>`;
    const fila3=(n,a,b,c)=>`<tr><td>${n}</td><td class="money tr">${money(a)}</td><td class="money tr">${money(b)}</td><td class="money tr"><b>${money(c)}</b></td></tr>`;
    const tclase=(r.por_clase||[]).map(x=>fila3(x.nombre,x.neto,x.iva,x.total)).join('')||'<tr><td colspan="4" class="sub">Sin datos del período</td></tr>';
    const tobj=(r.por_objetivo||[]).map(x=>`<tr><td>${x.nombre}</td><td class="tr mono">${x.cant}</td><td class="money tr"><b>${money(x.total)}</b></td></tr>`).join('')||'<tr><td colspan="3" class="sub">Sin datos</td></tr>';
    const tprov=(r.por_proveedor||[]).map(x=>`<tr><td>${x.nombre}${x.clase?` <span class="badge b-green" style="font-size:9px">${x.clase}</span>`:' <span class="badge b-amber" style="font-size:9px">sin clase</span>'}</td><td class="tr mono">${x.cant}</td><td class="money tr"><b>${money(x.total)}</b></td></tr>`).join('')||'<tr><td colspan="3" class="sub">Sin datos</td></tr>';
    // Selector de mes: últimos 13
    const meses=[];const hoy=new Date();
    for(let i=0;i<13;i++){const d0=new Date(hoy.getFullYear(),hoy.getMonth()-i,1);meses.push(d0.toISOString().slice(0,7));}
    const selMes=`<select onchange="comprasFinMes=this.value;go('compras')" style="padding:8px 11px;border:1px solid var(--linea-2);border-radius:9px;font-family:inherit;font-size:13px">
      ${meses.map(m=>`<option value="${m}"${m===comprasFinMes?' selected':''}>${m}</option>`).join('')}
      <option value=""${comprasFinMes===''?' selected':''}>Todo el histórico</option></select>`;

    view.innerHTML=tabsCompras()+`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div><div style="font-weight:700;font-size:16px">Reporte financiero contable</div>
        <div class="sub">Compras del período · para conciliar con Flexxus</div></div>
      ${selMes}</div>

    <div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">
      ${kpi('Facturado (neto)',money(k.neto),k.cantidad+' factura(s)')}
      ${kpi('IVA',money(k.iva),'crédito fiscal F.A: '+money(k.iva_credito_a))}
      ${kpi('Otros conceptos',money(k.otros),'percepciones/tributos no exentos')}
      ${kpi('TOTAL',money(k.total),'pagado '+money(k.pagado)+' · pendiente '+money(k.pendiente))}
    </div>

    <div class="kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
      ${kpi('Imputadas en Flexxus',(k.imputadas_flexxus||0)+' / '+(k.cantidad||0),(k.sin_imputar||0)+' sin imputar')}
      ${kpi('Centro de costo OK',String(k.cc_ok||0),(k.cc_pendiente||0)+' pendiente(s) de apropiar')}
      ${kpi('IVA crédito fiscal (F.A)',money(k.iva_credito_a),'el que se recupera vía ARCA')}
    </div>

    <div class="panel" style="margin-bottom:14px"><div class="panel-title">Por clase contable <span class="sub" style="font-weight:400;font-size:11px">· a qué cuenta va en Flexxus</span></div>
      <table><thead><tr><th>Clase</th><th class="tr">Neto</th><th class="tr">IVA</th><th class="tr">Total</th></tr></thead><tbody>${tclase}</tbody></table></div>

    <div class="grid g-2" style="gap:14px">
      <div class="panel"><div class="panel-title">Por objetivo (centro de costo)</div>
        <table><thead><tr><th>Objetivo</th><th class="tr">Fact.</th><th class="tr">Total</th></tr></thead><tbody>${tobj}</tbody></table></div>
      <div class="panel"><div class="panel-title">Por proveedor</div>
        <table><thead><tr><th>Proveedor</th><th class="tr">Fact.</th><th class="tr">Total</th></tr></thead><tbody>${tprov}</tbody></table></div>
    </div>`;
  }catch(e){view.innerHTML=tabsCompras()+`<div class="cargando-v">No pude armar el reporte. ${e.message||''}</div>`;}
}

async function vCompras(view){
  await cargarListasCompras();   // los desplegables salen de Maestros
  if(comprasMode==='carga'){vComprasCarga(view);return;}
  if(comprasMode==='detalle'){vComprasDetalle(view);return;}
  if(comprasTab==='cuenta'){vComprasCuenta(view);return;}
  if(comprasTab==='consumos'){vComprasConsumos(view);return;}
  if(comprasTab==='repuestos'){vComprasRepuestos(view);return;}
  if(comprasTab==='indicadores'){vComprasInd(view);return;}
  // Pestañas retiradas — caen al resumen (las funciones quedan en el código)
  if(comprasTab==='financiero'||comprasTab==='combustible'){comprasTab='resumen';}
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
      <input class="busca" style="width:380px" placeholder="Buscar por proveedor, N° factura, objetivo, unidad, fecha, CUIT, ítem…" value="${comprasBusca.replace(/"/g,'&quot;')}" oninput="comprasBusca=this.value;renderComprasBody()">
      <div class="sub" id="compras-count"></div>
    </div>
    <div id="compras-body"></div>`;
    renderComprasBody();
  }catch(e){view.innerHTML=`<div class="cargando-v">No pude cargar compras. ${e.message||''}</div>`;}
}
// Todo lo buscable de una factura en un solo texto: proveedor, CUIT, número,
// fecha (ISO y dd/mm/aaaa), objetivos y unidades (TODOS, no solo el primero),
// observaciones, descripciones de ítems y el estado.
function textoBuscableFactura(i){
  if(i.__busca)return i.__busca;
  const partes=[i.proveedor,i.cuit,i.numero_factura,i.letra,i.fecha_factura];
  const f=String(i.fecha_factura||'');
  if(/^\d{4}-\d{2}-\d{2}$/.test(f))partes.push(f.slice(8,10)+'/'+f.slice(5,7)+'/'+f.slice(0,4));
  const ta=i.totalAssign||{};
  partes.push(ta.objetivo,ta.unidad,ta.comentario);
  Object.values(i.assignments||{}).forEach(a=>partes.push(a&&a.objetivo,a&&a.unidad,a&&a.comentario));
  (i.items||[]).forEach(it=>partes.push(it.descripcion));
  (i.otros_conceptos||[]).forEach(o=>partes.push(o.concepto));
  (i.notas_credito||[]).forEach(n=>partes.push(n.numero,n.motivo,'nota de credito'));
  partes.push(i.pagada?'pagada':'pendiente');
  const fx=i.flexxus;
  if(fx&&fx.ok){
    partes.push('imputada flexxus',fx.numerocomprobante_fmt,fx.numerocomprobante,fx.tipocomprobante);
    const cc=fx.centro_costo;
    if(cc)partes.push(cc.ok?'centro de costo ok':'centro de costo pendiente',cc.numeroasiento);
    if(fx.anulada)partes.push('anulada');
  }else partes.push('sin imputar');
  i.__busca=partes.filter(v=>v!=null&&v!=='').join(' ').toLowerCase();
  return i.__busca;
}
function renderComprasBody(){
  const cont=document.getElementById('compras-body');if(!cont)return;
  // Búsqueda sobre TODO el contenido de la factura. Varias palabras = todas
  // tienen que aparecer (ej. "tecno riego 2026-07" o "epec pendiente").
  const terminos=comprasBusca.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const invs=terminos.length?comprasData.filter(i=>{
    const t=textoBuscableFactura(i);
    return terminos.every(x=>t.includes(x));
  }):comprasData;
  const totNeto=invs.reduce((s,i)=>s+(Number(i.total_sin_iva)||0),0);
  const totIva=invs.reduce((s,i)=>s+(Number(i.total_iva)||0),0);
  const cm=new Date().toISOString().slice(0,7);
  const totMes=invs.filter(i=>(i.fecha_factura||'').startsWith(cm)).reduce((s,i)=>s+totalFactura(i),0);
  const cnt=document.getElementById('compras-count');
  if(cnt)cnt.textContent=invs.length+' factura'+(invs.length===1?'':'s')+
    (invs.length?' · neto '+money(totNeto)+' · IVA '+money(totIva)+' · '+cm+' '+money(totMes):'');

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
        ${(()=>{const fx=inv.flexxus;
          if((!fx||!fx.ok)&&inv.flexxus_job&&inv.flexxus_job.estado==='en_proceso')return '<div class="badge b-gray" style="font-size:9.5px;margin-top:3px;color:#7B3FA0;border-color:#C9A6E0">⚡ imputando…</div>';
          if(!fx||!fx.ok)return '<div class="badge b-gray" style="font-size:9.5px;margin-top:3px">sin imputar a Flexxus</div>';
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
// PRECARGA (10-ago): todo lo que hay que preguntarle a Flexxus antes de imputar
// (proveedor, ficha contable, rubros, plan de cuentas y centro de costo) se pide
// EN UN SOLO VIAJE apenas se abre el detalle de la factura. Cuando el usuario
// aprieta "Imputar", la respuesta ya está en memoria y el modal abre al toque.
let flxPre={};                     // id → { t, p:Promise }
const FLX_PRE_TTL=3*60*1000;       // 3 min: después se vuelve a pedir
function precargarFlexxus(id,letra){
  if(!id)return null;
  const k=String(id), ya=flxPre[k];
  if(ya&&Date.now()-ya.t<FLX_PRE_TTL)return ya.p;
  const p=api('/api/compras/facturas/'+id+'/flexxus-previo'+(letra?'?letra='+letra:'')).catch(()=>null);
  flxPre[k]={t:Date.now(),p};
  return p;
}
// La precarga se hace con la letra del OCR; si el usuario termina imputando con
// otra letra hay que rehacerla (el número de comprobante depende de la letra).
function flxPreDe(id,letra){
  const k=String(id), ya=flxPre[k];
  if(!ya||Date.now()-ya.t>=FLX_PRE_TTL){delete flxPre[k];return precargarFlexxus(id,letra);}
  return ya.p;
}
function flxOlvidarPre(id){delete flxPre[String(id)];}

// Muestra la clase contable del proveedor y permite fijarla antes de imputar.
// La clase deriva la cuenta contable en Flexxus (MAQUINAS/EQUIPOS → Bienes de
// Uso; INSUMOS/COMBUSTIBLES → gasto). Queda guardada como fija por proveedor.
// Muestra u oculta la sub-selección de cuenta según la clase elegida y ajusta
// la etiqueta: Bienes de uso habla de "rubro", el resto de "cuenta contable".
function cpCambioClase(v){
  const w=document.getElementById('cp-rubro-wrap'), l=document.getElementById('cp-rubro-lbl');
  if(!w)return;
  w.style.display=(Number(v)>=1)?'block':'none';
  if(l)l.textContent=(v==='1')?'RUBRO DE BIENES DE USO (define la cuenta 121…)':'CUENTA CONTABLE (sub-selección)';
}
async function elegirClaseProveedor(prev,prog,pre){
  // La ficha COMPLETA del proveedor (el preview trae uno resumido sin
  // clasecomprobante): de acá salen la CLASE DE COMPROBANTE y el RUBRO, que
  // son los que definen a qué cuenta contable va el asiento en Flexxus.
  let pf=prev.proveedor||{};
  let rubros=[],planCuentas=[],planInfo=null;
  // Si viene de la precarga (flexxus-previo) ya está todo: cero espera.
  if(pre){
    if(pre.ficha)pf=pre.ficha;
    if(Array.isArray(pre.rubros))rubros=pre.rubros;
    if(pre.plan&&Array.isArray(pre.plan.cuentas))planCuentas=pre.plan.cuentas;
  }
  try{
    const [fi,ru]=pre?[null,null]:await Promise.all([
      api('/api/compras/proveedor-ficha?cuit='+encodeURIComponent(prev.cuit_norm)),
      api('/api/compras/rubros-bienes-uso'),
    ]);
    if(fi&&fi.existe&&fi.lista)pf=fi.lista;
    if(Array.isArray(ru))rubros=ru;
    // El plan de cuentas completo se pide APARTE y no bloquea la apertura del
    // modal (tardaba ~24s la primera vez): llega solo y rellena el buscador.
    if(!pre)api('/api/compras/plan-cuentas').then(pl=>{
      if(!pl||!Array.isArray(pl.cuentas))return;
      const dl=document.getElementById('cp-cuenta-list');if(!dl)return;
      const ya=new Set([...dl.options].map(o=>o.value));
      dl.insertAdjacentHTML('beforeend',pl.cuentas.filter(c=>!ya.has(c.codigo))
        .map(c=>`<option value="${c.codigo}">${c.descripcion} (${c.codigo})</option>`).join(''));
      const nota=document.getElementById('cp-plan-nota');
      if(nota)nota.textContent='Plan de cuentas: '+pl.cuentas.length+' cuentas'+(pl.por_grupo?' ('+Object.entries(pl.por_grupo).map(([g,n])=>g+'…: '+n).join(' · ')+')':'');
    }).catch(()=>{});
  }catch(e){}
  if(prog)prog.cerrar();
  return new Promise(resolve=>{
    const actual=prev.clase_asignada;
    const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=210;
    bg.innerHTML=`<div class="modal" style="max-width:460px">
      <div class="modal-tit">Clase de comprobante del proveedor</div>
      <div class="sub" style="margin:6px 0 4px">${prev.proveedor.razonsocial}${prev.proveedor.cuit?' · CUIT '+prev.proveedor.cuit:''}</div>
      <div class="sub" style="margin-bottom:12px;font-size:12px">La clase de comprobante define a qué cuenta contable va la factura en Flexxus. <b>Bienes de uso</b> + rubro → cuenta 121…; <b>Bienes de cambio</b> → Mercaderías.</div>
      ${actual?`<div class="sub" style="font-size:11.5px;margin-bottom:10px">Clase del proveedor en Flexxus: <b>${actual.codigo_clase} · ${actual.clase_descripcion||''}</b></div>`:''}
      ${(()=>{
        // Los dos desplegables COMO EN FLEXXUS, siempre editables: "Clase de
        // Comp." y, cuando es Bienes de uso, el rubro que define la cuenta.
        // Vienen preseleccionados con lo que hoy tiene la ficha del proveedor.
        const CLASES=[[0,'BIENES DE CAMBIO'],[1,'BIENES DE USO'],[2,'SERVICIOS'],[3,'OTROS'],[4,'LOCACIONES'],[5,'NACIONALIZACIONES']];
        const claseNum=('clasecomprobante' in pf)?Number(pf.clasecomprobante):
          (CLASES.find(c=>c[1]===String(pf.tipocomprobante||'').toUpperCase())||[null])[0];
        const leida=claseNum!=null;
        const esBU=claseNum===1;
        const rubroActual=String(pf.cuenta||'');
        // Respaldo si el plan de cuentas no responde (mismos rubros que Flexxus)
        // Cuentas fuera de los rubros 121 (para Servicios/Otros/Locaciones/etc.)
        const OTRAS=planCuentas.filter(c=>!String(c.codigo).startsWith('121'));
        const RUB=rubros.length?rubros:[
          {codigo:'12101001',descripcion:'HARDWARE Y SOFTWARE'},{codigo:'12101002',descripcion:'INMUEBLES'},
          {codigo:'12101003',descripcion:'INSTALACIONES'},{codigo:'12101005',descripcion:'MAQUINAS Y HERRAMIENTAS'},
          {codigo:'12101006',descripcion:'MARCAS Y PATENTES'},{codigo:'12101004',descripcion:'MUEBLES Y UTILES'},
          {codigo:'12101007',descripcion:'RODADOS'}];
        return `
        <div style="background:var(--hueso);border:1px solid var(--linea);border-radius:9px;padding:11px 13px;margin-bottom:10px">
          <div style="font-size:11px;color:var(--tinta-3);margin-bottom:3px">CLASE DE COMP.</div>
          <select id="cp-comp" onchange="cpCambioClase(this.value)"
            style="width:100%;padding:9px;border:1px solid var(--linea-2);border-radius:8px;font-family:inherit;font-size:12.5px;background:#fff">
            ${CLASES.map(([v,t])=>`<option value="${v}"${claseNum===v?' selected':''}>${t}</option>`).join('')}
          </select>
          <div id="cp-rubro-wrap" style="display:${claseNum>=1?'block':'none'};margin-top:9px">
            <div id="cp-rubro-lbl" style="font-size:11px;color:var(--tinta-3);margin-bottom:3px">${esBU?'RUBRO DE BIENES DE USO (define la cuenta 121…)':'CUENTA CONTABLE (sub-selección)'}</div>
            <input list="cp-cuenta-list" id="cp-rubro" placeholder="Escribí para buscar…" value="${rubroActual&&rubroActual!=='0'?rubroActual:''}"
              style="width:100%;box-sizing:border-box;padding:9px;border:1px solid var(--linea-2);border-radius:8px;font-family:inherit;font-size:12.5px;background:#fff">
            <datalist id="cp-cuenta-list">
              ${RUB.map(r=>`<option value="${r.codigo}">${r.descripcion} (${r.codigo})</option>`).join('')}
              ${OTRAS.map(r=>`<option value="${r.codigo}">${r.descripcion} (${r.codigo})</option>`).join('')}
            </datalist>
            <div id="cp-plan-nota" class="sub" style="font-size:10.5px;margin-top:3px">${planCuentas.length?('Plan de cuentas: '+(RUB.length+OTRAS.length)+' cuentas de Flexxus'):'Cargando el plan de cuentas de Flexxus… (mientras tanto podés escribir el código a mano)'}</div>
          </div>
          <div class="sub" style="font-size:11px;margin-top:8px">
            ${leida?`Hoy en la ficha: <b>${(CLASES.find(c=>c[0]===claseNum)||[0,'—'])[1]}</b>${esBU?' · rubro '+(rubroActual&&rubroActual!=='0'?rubroActual:'sin definir (toma Hardware y software)'):''}`
                   :'No pude leer la clase de la ficha (¿proveedor nuevo? se crea al imputar). Elegí la que corresponda.'}
          </div>
        </div>
        <input type="hidden" id="cp-clase-actual" value="${claseNum==null?'':claseNum}">
        <input type="hidden" id="cp-rubro-actual" value="${rubroActual}">`;
      })()}
      <div class="modal-acciones">
        <button class="btn-salir" id="cp-cancel">Cancelar</button>
        <button class="btn" id="cp-ok">Guardar y seguir →</button>
      </div></div>`;
    document.body.appendChild(bg);
    bg.querySelector('#cp-cancel').onclick=()=>{bg.remove();resolve('cancelar');};
    bg.querySelector('#cp-ok').onclick=async()=>{
      const claseComp=(bg.querySelector('#cp-comp')||{}).value||'';
      const rubro=(bg.querySelector('#cp-rubro')||{}).value||'';
      const claseAntes=(bg.querySelector('#cp-clase-actual')||{}).value||'';
      const rubroAntes=(bg.querySelector('#cp-rubro-actual')||{}).value||'';
      // Se manda a Flexxus solo si el usuario CAMBIÓ algo respecto de la ficha
      const cambioClase=claseComp!==''&&claseComp!==claseAntes;
      const cambioRubro=Number(claseComp)>=1&&rubro&&rubro!==rubroAntes;
      if(!cambioClase&&!cambioRubro){bg.remove();resolve('seguir');return;}
      const car=flxCargando('Cargando información en Flexxus…','Colocando la clase de comprobante y el rubro en la ficha del proveedor.',230);
      try{
        const rc=await api('/api/compras/proveedor-clase-comprobante',{method:'POST',body:JSON.stringify({
          cuit:prev.cuit_norm,clase:Number(claseComp!==''?claseComp:claseAntes||0),cuenta:(Number(claseComp)>=1)?(rubro||null):null})});
        car.cerrar();
        if(rc&&rc.ok)toast(rc.motivo||'Clase de comprobante colocada ✓');
        else toast('Clase de comprobante: '+(rc&&rc.motivo||'no se pudo colocar'),'error');
        bg.remove();resolve('seguir');
      }catch(e){car.cerrar();toast('No pude guardar la clase: '+e.message,'error');}
    };
  });
}
// PASO DE REVISIÓN del centro de costo, antes de imputar. Una vez imputada la
// factura no se puede editar, así que acá se ve el reparto exacto que se va a
// mandar y si cada objetivo tiene su código y existe en Flexxus.
async function revisarCentroCosto(id,pre){
  let d=null;
  // Si vino en la precarga no se pide de nuevo: el modal abre sin espera.
  if(pre&&pre.centrocosto)d=pre.centrocosto;
  else{
    const esp=flxCargando('Revisando el centro de costo…','Contrastando los códigos de Maestros contra Flexxus.',210);
    try{d=await api('/api/compras/facturas/'+id+'/centrocosto-preview');}catch(e){d={error:e.message};}
    esp.cerrar();
  }
  return new Promise(resolve=>{
    const problema=!d||d.error||!d.ok||Math.abs((d.suma||0)-100)>0.001||(d.reparto||[]).some(x=>x.existe===false);
    const filas=(d&&d.reparto||[]).map(x=>{
      const mal=!x.codigo||x.existe===false;
      return `<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;padding:8px 12px;border-bottom:1px solid var(--linea);font-size:12.5px">
        <div style="flex:1">
          <div style="font-weight:600">${x.objetivo}</div>
          <div class="sub" style="font-size:11px;color:${mal?'#A32D2D':'#586B60'}">${
            !x.codigo?'⚠ sin código de Flexxus cargado en Maestros'
            :x.existe===false?'✕ el código '+x.codigo+' NO existe en Flexxus'
            :'cód. '+x.codigo+(x.nombre_flexxus?' · en Flexxus: '+x.nombre_flexxus:'')}</div>
        </div>
        <div style="text-align:right;white-space:nowrap">
          <div class="mono" style="font-weight:600;color:${mal?'#A32D2D':'var(--brote-2)'}">${x.porcentaje}%</div>
          <div class="sub mono" style="font-size:11px">${money(x.monto)}</div>
        </div></div>`;}).join('');
    const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=210;
    bg.innerHTML=`<div class="modal" style="max-width:520px">
      <div class="modal-tit">Revisá el centro de costo</div>
      <div class="sub" style="margin:6px 0 12px;font-size:12px">Una vez imputada en Flexxus, la factura <b>ya no se puede editar</b>. Confirmá que el reparto sea el correcto.</div>
      ${d&&d.error?`<div style="background:#FCEBED;border:1px solid #EFB9C0;color:#A32D2D;border-radius:9px;padding:10px 13px;font-size:12.5px;margin-bottom:10px">No pude armar la vista previa: ${d.error}</div>`:''}
      ${filas?`<div style="border:1px solid var(--linea);border-radius:10px;overflow:hidden;margin-bottom:8px">
        <div style="background:var(--papel);padding:7px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--tinta-3);font-weight:600">Reparto · ${d.modo==='per-item'?'por ítem':'total de factura'}</div>
        ${filas}
        <div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--papel);font-size:12.5px;font-weight:600">
          <span>Suma</span><span class="mono" style="color:${Math.abs((d.suma||0)-100)<0.001?'var(--brote-2)':'#A32D2D'}">${d.suma}%</span></div>
      </div>`:''}
      ${d&&(d.sin_codigo||[]).length?`<div style="background:var(--diesel-soft);color:#854F0B;border-radius:9px;padding:10px 13px;font-size:12.5px;margin-bottom:10px">
        ⚠ Sin código de Flexxus: <b>${d.sin_codigo.join(', ')}</b><br>Cargalo en <b>Maestros → Centros de costo</b> y volvé a imputar, o imputá igual y el centro de costo queda pendiente.</div>`:''}
      ${d&&d.flexxus_leido===false?`<div class="sub" style="font-size:11.5px;margin-bottom:10px">No pude leer los centros de costo de Flexxus para contrastarlos${d.motivo_flexxus?' ('+d.motivo_flexxus+')':''}. Los códigos se muestran sin verificar.</div>`:''}
      <div class="modal-acciones">
        <button class="btn-salir" id="cc-cancel">Cancelar</button>
        ${problema?`<button class="btn-salir" id="cc-igual" style="color:var(--rojo);border-color:#EFB9C0">Imputar igual</button>`
                  :`<button class="btn" id="cc-ok">Confirmar e imputar →</button>`}
      </div></div>`;
    document.body.appendChild(bg);
    const fin=v=>{bg.remove();resolve(v);};
    bg.querySelector('#cc-cancel').onclick=()=>fin('cancelar');
    const ok=bg.querySelector('#cc-ok');if(ok)ok.onclick=()=>fin('seguir');
    const ig=bg.querySelector('#cc-igual');
    if(ig)ig.onclick=async()=>{
      if(await uiConfirm('El centro de costo va a quedar PENDIENTE y la factura ya no se va a poder editar. Podés corregir los códigos en Maestros y usar "↻ Reintentar" después.','¿Imputar igual?',{ok:'Imputar igual',danger:true}))fin('seguir');
    };
  });
}
async function imputarFlexxus(id){
  // La letra sale del OCR (inv.letra); solo se pregunta si no vino.
  const inv=(comprasVer&&String(comprasVer.id)===String(id))?comprasVer:null;
  let L=String((inv&&inv.letra)||'').trim().toUpperCase();
  if(!['A','B','C'].includes(L)){
    const letra=await uiPrompt('No pude leer la letra de la factura. ¿Cuál es? (A, B o C)','A','Imputar a Flexxus');
    if(letra===null)return;
    L=String(letra).trim().toUpperCase()||'A';
    if(!['A','B','C'].includes(L)){toast('Letra inválida: usá A, B o C','error');return;}
  }
  // Verificación previa: a qué proveedor va y con qué número, ANTES de tocar Flexxus.
  // Normalmente ya está precargado desde que se abrió el detalle → sale al toque.
  let pre=null;
  try{pre=await Promise.race([flxPreDe(id,L),new Promise(r=>setTimeout(()=>r(undefined),80))]);}catch(e){}
  const busca=pre?null:flxCargando('Buscando datos en Flexxus…','Traigo el proveedor, su ficha contable y el número de comprobante.',200);
  if(pre===undefined){                       // la precarga sigue en vuelo: esperarla con cartel
    try{pre=await flxPreDe(id,L);}catch(e){pre=null;}
  }
  // La letra manda: si el usuario imputó con otra distinta a la precargada, se rehace.
  if(pre&&pre.letra&&pre.letra!==L){flxOlvidarPre(id);pre=null;try{pre=await precargarFlexxus(id,L);}catch(e){}}
  let prev=pre?pre.preview:null;
  if(!prev){try{prev=await api('/api/compras/facturas/'+id+'/flexxus-preview?letra='+L);}catch(e){}}
  if(prev){
    if(prev.numero==null){if(busca)busca.cerrar();toast('La factura no tiene un número válido (PV-NUMERO). Corregilo en el editor.','error');return;}
    // Paso de CLASE DE COMPROBANTE + RUBRO: es lo que define la cuenta contable
    // del asiento (Bienes de uso + rubro → 121…; en blanco → Mercaderías).
    if(prev.proveedor){
      // Sin cuit_norm el paso se salteaba y la factura se iba con la clase por
      // defecto (Bienes de cambio → Mercaderías): se cae al CUIT de la ficha.
      if(!prev.cuit_norm&&prev.proveedor.cuit)prev.cuit_norm=String(prev.proveedor.cuit).replace(/\D/g,'');
      if(busca)busca.paso('Leyendo la ficha del proveedor…','Clase de comprobante y rubro contable.');
      const sigue=await elegirClaseProveedor(prev,busca,pre);  // cierra la ventana de espera
      if(sigue==='cancelar'){flxOlvidarPre(id);return;}
    }
    if(busca)busca.cerrar();
    // Antes de tocar Flexxus: revisar el centro de costo (después no se edita)
    if(await revisarCentroCosto(id,pre)==='cancelar')return;
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
  if(busca)busca.cerrar();
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
// Ventana de espera con spinner. Se usa en todos los pasos que hablan con
// Flexxus (buscar datos, guardar la clase, imputar) para que nunca quede la
// pantalla quieta sin explicación.
function flxCargando(titulo,detalle,z){
  const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=z||200;
  bg.innerHTML=`<div class="modal" style="max-width:440px;text-align:center;padding:30px 26px">
    <div class="flx-spin" style="width:44px;height:44px;border:4px solid var(--linea);border-top-color:var(--brote);border-radius:50%;margin:0 auto 16px;animation:flxgira .8s linear infinite"></div>
    <div style="font-weight:600;font-size:15px" data-flx="paso">${titulo||'Conectando con Flexxus…'}</div>
    <div class="sub" style="margin-top:6px;font-size:12.5px" data-flx="detalle">${detalle||'No cierres esta ventana.'}</div>
  </div>`;
  if(!document.getElementById('flx-spin-style')){const st=document.createElement('style');st.id='flx-spin-style';st.textContent='@keyframes flxgira{to{transform:rotate(360deg)}}';document.head.appendChild(st);}
  document.body.appendChild(bg);
  const set=(k,t)=>{const e=bg.querySelector('[data-flx="'+k+'"]');if(e)e.textContent=t;};
  return {cerrar:()=>{if(bg.parentNode)bg.remove();}, paso:(t,d)=>{set('paso',t);if(d)set('detalle',d);}};
}
function flxProgreso(){
  return flxCargando('Imputando en Flexxus…','Creando el comprobante y apropiando el centro de costo. No cierres esta ventana.',200);
}
function flxResultadoModal(r){
  const cc=r.flexxus&&r.flexxus.centro_costo;
  const advCta=r.flexxus&&r.flexxus.advertencia_cuenta;
  const num=r.flexxus&&r.flexxus.numerocomprobante_fmt||(r.flexxus&&('F'+(r.flexxus.tipocomprobante||'').slice(-1)+' '+(r.flexxus.numerocomprobante||'')));
  let filas='';
  if(cc&&cc.ok&&(cc.reparto||[]).length){
    filas=cc.reparto.map(x=>`<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 12px;border-bottom:1px solid var(--linea);font-size:13px">
      <span><b>${x.objetivo}</b></span>
      <span class="mono" style="color:var(--brote-2);font-weight:600">${x.porcentaje}% ✓</span></div>`).join('');
  }
  const okCC=cc&&cc.ok;
  const verif=cc&&cc.verificado===true;
  const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=200;
  bg.innerHTML=`<div class="modal" style="max-width:480px">
    <div style="text-align:center;margin-bottom:14px">
      <div style="font-size:34px;line-height:1">${okCC?'✅':(cc?'⚠️':'✅')}</div>
      <h3 style="margin:8px 0 2px">${r.ya_existia?'Ya estaba imputada':'Imputación realizada'}</h3>
      <div class="sub" style="font-size:12.5px">${num?'Comprobante '+num+' · ':''}asiento ${cc&&cc.numeroasiento||'—'}</div>
    </div>
    ${advCta?`<div style="background:var(--rojo-soft,#FCEBED);border:1px solid #EFB9C0;color:#A32D2D;border-radius:10px;padding:10px 13px;font-size:12.5px;font-weight:500;margin-bottom:10px">🔴 ${advCta}</div>`:''}
    <div style="border:1px solid var(--linea);border-radius:10px;overflow:hidden;margin-bottom:6px">
      <div style="background:var(--papel);padding:8px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--tinta-3);font-weight:600">Centro de costo apropiado</div>
      ${okCC?filas:`<div style="padding:11px 12px;font-size:12.5px;color:#854F0B">${cc?cc.motivo:'No se registró apropiación de centro de costo.'}</div>`}
      ${okCC?`<div style="padding:8px 12px;font-size:11.5px;color:${verif?'var(--brote-2)':'var(--tinta-3)'}">${verif?'✓✓ Verificado contra Flexxus (asiento releído del API)':'✓ Enviado — no pude releer el asiento para confirmarlo'}</div>`:''}
    ${okCC&&cc.variante&&cc.variante!=='decimales'?`<div style="padding:8px 12px;font-size:11.5px;color:#854F0B;background:var(--diesel-soft)">⚠ Flexxus rechazó el reparto con decimales. Se aplicó con <b>${cc.variante}</b> — revisá los porcentajes en el asiento.</div>`:''}
    </div>
    <div class="modal-acciones"><button class="btn primary" id="flx-ok">Listo</button></div>
  </div>`;
  document.body.appendChild(bg);
  bg.querySelector('#flx-ok').onclick=()=>{bg.remove();go('compras');};
  bg.addEventListener('click',e=>{if(e.target===bg){bg.remove();go('compras');}});
}
// MOTOR EN SEGUNDO PLANO (10-ago): la confirmación del usuario dispara
// /flexxus-encolar, que responde AL INSTANTE y deja el POST + la apropiación +
// la verificación corriendo en el server. El usuario recupera la pantalla al
// toque y sigue trabajando; un vigía consulta el estado cada 2,5 s y, cuando el
// server termina, muestra EL MISMO modal de resultado de siempre (con el
// ✓✓ VERIFICADO real: la verificación no se sacrifica, solo deja de bloquear).
let flxVigias={};   // id → true (para no duplicar vigías de la misma factura)
async function ejecutarImputacion(id,L,permitirAlta){
  flxOlvidarPre(id);   // la factura queda imputada: la precarga ya no sirve
  try{
    await api('/api/compras/facturas/'+id+'/flexxus-encolar',{method:'POST',body:JSON.stringify({letra:L,permitir_alta:permitirAlta})});
  }catch(e){toast(e.message,'error');return;}
  toast('⚡ Imputación en marcha en Flexxus. Podés seguir trabajando: te aviso acá cuando esté verificada.');
  if(comprasVer&&String(comprasVer.id)===String(id)){comprasVer.flexxus_job={estado:'en_proceso'};go('compras');}
  flxVigilar(id,L);
}
async function flxVigilar(id,L){
  if(flxVigias[id])return;
  flxVigias[id]=true;
  const t0=Date.now();
  try{
    while(Date.now()-t0<3*60*1000){                 // techo 3 min de vigilancia
      await new Promise(r=>setTimeout(r,2500));
      let est=null;
      try{est=await api('/api/compras/facturas/'+id+'/flexxus-estado');}catch(e){continue;}
      const j=est&&est.job;
      if(!j||j.estado==='en_proceso')continue;
      if(j.estado==='ok'&&j.resultado){
        // Mismo modal de siempre, con el resultado real (asiento, ✓✓, reparto)
        flxResultadoModal(j.resultado);
        if(comprasVer&&String(comprasVer.id)===String(id)){comprasVer.flexxus=j.resultado.flexxus;delete comprasVer.flexxus_job;go('compras');}
        else go('compras');
        return;
      }
      if(j.estado==='error'){
        if(j.code==='PROV_NO_EXISTE'||/No existe en Flexxus/.test(j.error||'')){
          delete flxVigias[id];
          if(await uiConfirm((j.error||'')+'\n\n¿Crear proveedor nuevo e imputar?','Proveedor inexistente',{ok:'Crear e imputar',danger:true}))
            return ejecutarImputacion(id,L,true);
        }else{
          uiAlert((j.error||'Error imputando')+'\n\nLa factura NO quedó imputada. Podés reintentar desde el detalle.','No se pudo imputar');
          if(comprasVer&&String(comprasVer.id)===String(id)){delete comprasVer.flexxus_job;go('compras');}
        }
        return;
      }
    }
    toast('La imputación sigue en proceso en el server. Refrescá la factura en un rato para ver el resultado.','info');
  }finally{delete flxVigias[id];}
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
      <div class="divider"></div>
      <div style="font-weight:600;font-size:12.5px;margin:12px 0 4px">Cuenta contable — la palanca real es la CLASE DE COMPROBANTE</div>
      ${tabla('Clases de comprobante (Bienes de cambio / Bienes de uso / Servicios…)',d.clases_comprobante)}
      ${tabla('Rubros de bienes de uso (Maquinas y herramientas, Rodados…)',d.rubros_bienes_uso)}
      ${tabla('Plan de cuentas contables',d.plan_cuentas)}
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
            :inv.flexxus_job&&inv.flexxus_job.estado==='en_proceso'
              ?`<button class="btn-salir" style="color:#7B3FA0;border-color:#C9A6E0;opacity:.6" disabled>⚡ Imputando…</button>`
              :`<button class="btn-salir" style="color:#7B3FA0;border-color:#C9A6E0" onclick="imputarFlexxus('${inv.id}')">⇪ Imputar a Flexxus</button>`}
          <button class="btn" onclick="abrirNC()">＋ Nota de crédito</button>
          <button class="btn-salir" style="color:var(--rojo)" onclick="borrarCompra('${inv.id}')">Eliminar</button>`}
    </div></div>
    ${!ed&&!(inv.flexxus&&inv.flexxus.ok)&&inv.flexxus_job&&inv.flexxus_job.estado==='en_proceso'?(flxVigilar(inv.id,String(inv.letra||'A').toUpperCase()),`<div class="hint" style="margin-bottom:12px;border-color:#C9A6E0"><svg viewBox="0 0 24 24" fill="none" stroke="#7B3FA0" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg><div>⚡ Imputación en marcha en Flexxus. Te aviso acá cuando esté verificada — mientras podés seguir trabajando.</div></div>`):''}
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
      ${(()=>{const al=(inv.ivas||[]).filter(x=>Number(x.monto));
        if(!al.length)return '';
        const suma=Math.round(al.reduce((a,x)=>a+(Number(x.monto)||0),0)*100)/100;
        const ivaTot=Number(inv.total_iva)||0;
        const dif=Math.abs(suma-ivaTot);
        // Las alícuotas mandan: si difieren por centavos se imputan igual y
        // el total se ajusta a su suma. Solo se descartan si la diferencia es
        // grande (falta una alícuota o se leyó mal).
        const tol=Math.max(100,ivaTot*0.02);
        return `<div style="padding:2px 0 6px 12px">
          ${al.map(x=>`<div class="mcard-row" style="font-size:12px;padding:1px 0">
            <span class="sub">IVA ${x.porcentaje}%</span><span class="money sub">${money(x.monto)}</span></div>`).join('')}
          ${dif<=0.01?`<div class="sub" style="font-size:11px">se imputan por separado en Flexxus</div>`
            :dif<=tol?`<div class="sub" style="font-size:11px;color:var(--diesel)">se imputan por separado · el IVA total se ajusta a ${money(suma)} (decía ${money(ivaTot)})</div>`
            :`<div class="sub" style="font-size:11px;color:var(--rojo)">⚠ las alícuotas suman ${money(suma)} y el IVA dice ${money(ivaTot)} — hay demasiada diferencia, se imputa todo al 21%. Corregilo con ✏️ Editar</div>`}
        </div>`;})()}
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
      :`${inv.assignmentMode==='per-item'
          ?`<div class="mcard-row"><span>Modo</span><b>Imputada por ítem</b></div>`
          :`<div class="mcard-row"><span>Objetivo</span><b>${a.obj||'— sin asignar —'}</b></div>
            <div class="mcard-row"><span>Unidad</span><b>${a.uni||'—'}</b></div>
            ${(inv.totalAssign&&inv.totalAssign.comentario)?`<div class="mcard-row" style="align-items:flex-start"><span>Observaciones</span><b style="text-align:right;font-weight:500;max-width:62%">${inv.totalAssign.comentario}</b></div>`:''}
            <div class="sub" style="margin-top:6px">Total de factura</div>`}
        <div class="divider" style="margin:10px 0 8px"></div>
        <div class="field-l" style="margin-bottom:6px">Reparto por centro de costo</div>
        <div id="imp-reparto" class="sub" style="font-size:12px">Calculando el reparto…</div>
        ${inv.flexxus&&inv.flexxus.centro_costo&&!inv.flexxus.centro_costo.ok
          ?`<div class="sub" style="margin-top:4px;color:#854F0B">⚠ Centro de costo pendiente: ${inv.flexxus.centro_costo.motivo||''} <button class="mini-btn" style="margin-left:6px" onclick="reintentarCentroCosto('${inv.id}')">↻ Reintentar</button></div>`:''}
        <div class="divider" style="margin:10px 0 8px"></div>
        <div class="field-l" style="margin-bottom:6px">Destino contable en Flexxus</div>
        <div id="imp-destino" class="sub" style="font-size:12px">Leyendo la ficha del proveedor…</div>`}
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
      return `<table style="font-size:12.5px"><thead><tr><th>Descripción</th><th class="num">Cant.</th><th class="num">Neto</th><th class="num">IVA</th><th class="num">Total</th>${perItem?'<th style="width:260px">Imputación</th>':''}</tr></thead>
      <tbody>${items.map((i,ix)=>{const n=Number(i.monto_sin_iva)||0,v=ivaDe(i);
        const cant=Number(i.cantidad)||1;
        return `<tr><td>${ed
          ?`<input id="ei-desc-${ix}" value="${String(i.descripcion||'').replace(/"/g,'&quot;')}" style="width:100%;font-size:12px;padding:4px 6px">`
          :(i.descripcion||'—')}</td>
        <td class="num">${ed
          ?`<input id="ei-cant-${ix}" type="number" min="1" step="1" value="${cant}" style="width:58px;font-size:12px;padding:4px 6px;text-align:right">`
          :`<span class="mono">${cant}</span>`}</td>
        <td class="num money">${ed
          ?`<input id="ei-neto-${ix}" type="number" step="0.01" value="${n}" style="width:110px;font-size:12px;padding:4px 6px;text-align:right" onchange="comprasItemCambio()">`
          :money(n)}</td>
        <td class="num money sub">${money(v)}</td>
        <td class="num money">${money(n+v)}</td>
        ${perItem?`<td>${selObj(ix)}${selUni(ix)}</td>`:''}</tr>`;}).join('')}
      <tr style="border-top:2px solid var(--linea)"><td><b>Total</b></td><td></td>
        <td class="num money"><b>${money(inv.total_sin_iva||0)}</b></td>
        <td class="num money"><b>${money(ivaFact)}</b></td>
        <td class="num money"><b>${money(bruto)}</b></td>${perItem?'<td></td>':''}</tr></tbody></table>
      ${prorratear?'<div class="sub" style="margin-top:8px">ℹ️ La factura trae el IVA solo en el total, no por línea. Acá se muestra prorrateado según el neto de cada ítem.</div>':''}
      <div id="ec-aviso-items" style="margin-top:8px;font-size:12px">${(()=>{
        const dif=Math.round((netoItems-(Number(inv.total_sin_iva)||0))*100)/100;
        if(Math.abs(dif)<0.02)return '';
        return `<span style="color:var(--rojo)">⚠ Los ítems suman ${money(netoItems)} y el neto dice ${money(inv.total_sin_iva||0)} (diferencia ${money(Math.abs(dif))}). Al imputar mando el NETO, reescalando los ítems. Corregí el que esté mal.</span>`;
      })()}</div>`;
    })()}
  </div>`;
  if(inv.comprobante&&inv.comprobante.ruta)cargarVisorComprobante(inv.id);
  if(!comprasEdit){cargarDestinoContable(inv.id);pintarRepartoCC(inv);
    // Adelanta el trabajo pesado de Flexxus mientras el usuario mira la factura
    if(!(inv.flexxus&&inv.flexxus.ok))precargarFlexxus(inv.id,String(inv.letra||'').toUpperCase()||null);}
}
/* Recalcula en vivo el aviso de "los ítems no cierran con el neto". */
function comprasItemCambio(){
  const inv=comprasVer;if(!inv)return;
  const g=id=>document.getElementById(id);
  let suma=0;
  (inv.items||[]).forEach((_,ix)=>{const n=g('ei-neto-'+ix);if(n)suma+=Number(n.value)||0;});
  suma=Math.round(suma*100)/100;
  const neto=Number((g('ec-neto')||{}).value||inv.total_sin_iva)||0;
  const av=g('ec-aviso-items');if(!av)return;
  const dif=Math.round((suma-neto)*100)/100;
  av.innerHTML=Math.abs(dif)<0.02
    ?'<span style="color:var(--brote)">✓ Los ítems cierran con el neto.</span>'
    :`<span style="color:var(--rojo)">⚠ Los ítems suman ${money(suma)} y el neto dice ${money(neto)} (diferencia ${money(Math.abs(dif))}). Al imputar mando el NETO, reescalando los ítems.</span>`;
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
  // Los ítems también son editables: si no se capturan, Flexxus recibe la
  // lectura vieja del OCR aunque el neto esté corregido.
  (inv.items||[]).forEach((it,ix)=>{
    const d=g('ei-desc-'+ix),nn=g('ei-neto-'+ix),c=g('ei-cant-'+ix);
    if(d)it.descripcion=d.value.trim()||it.descripcion;
    if(nn&&nn.value!=='')it.monto_sin_iva=Number(nn.value)||0;
    if(c&&c.value!=='')it.cantidad=Number(c.value)||1;
  });
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

// Reparto por centro de costo: qué porcentaje se llevó cada objetivo. Si la
// factura YA se imputó se muestra el reparto REAL que quedó en el asiento; si
// todavía no, el que se va a mandar (mismo cálculo que usa la apropiación).
async function pintarRepartoCC(inv){
  const pinta=html=>{const c=document.getElementById('imp-reparto');if(c)c.innerHTML=html;};
  const fila=(obj,pct,monto,ok)=>`<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--linea)">
    <span style="font-weight:600;font-size:12.5px">${obj}</span>
    <span style="white-space:nowrap;text-align:right">
      <b class="mono" style="color:${ok===false?'#854F0B':'var(--brote-2)'}">${pct}%${ok===true?' ✓':''}</b>
      ${monto!=null?`<span class="sub mono" style="font-size:11px;margin-left:8px">${money(monto)}</span>`:''}
    </span></div>`;
  const cc=inv.flexxus&&inv.flexxus.centro_costo;
  if(cc&&cc.ok&&(cc.reparto||[]).length){
    const verif=cc.verificado===true;
    pinta(cc.reparto.map(x=>fila(x.objetivo,x.porcentaje,null,verif)).join('')+
      `<div class="sub" style="margin-top:6px;font-size:11.5px;color:${verif?'var(--brote-2)':'var(--tinta-3)'}">${verif?'✓✓ Verificado contra Flexxus (asiento releído)':'✓ Enviado — sin relectura de confirmación'} · asiento ${cc.numeroasiento||'—'}${cc.variante&&cc.variante!=='decimales'?' · aplicado con '+cc.variante:''}</div>`);
    return;
  }
  try{
    const d=await api('/api/compras/facturas/'+inv.id+'/centrocosto-preview');
    if(!(d.reparto||[]).length){pinta(d.motivo||'La factura no tiene imputación por objetivo.');return;}
    pinta(d.reparto.map(x=>fila(x.objetivo,x.porcentaje,x.monto,x.codigo?undefined:false)).join('')+
      `<div class="sub" style="margin-top:6px;font-size:11.5px">Suma ${d.suma}% · ${inv.flexxus&&inv.flexxus.ok?'sin apropiar en el asiento':'todavía sin imputar'}${(d.sin_codigo||[]).length?' · ⚠ sin código de Flexxus: '+d.sin_codigo.join(', '):''}</div>`);
  }catch(e){pinta('No pude calcular el reparto: '+e.message);}
}

// Destino contable: a qué cuenta de Flexxus va (o fue) esta factura. Antes de
// imputar sale de la ficha del proveedor (clase de comprobante + rubro);
// después de imputar se muestran las cuentas REALES releídas del asiento.
// Abre el modal de clase/rubro desde la card del detalle (sin imputar).
// Usa el mismo preview que la imputación para tener la ficha del proveedor.
async function abrirClaseDesdeDetalle(id){
  const inv=(comprasVer&&String(comprasVer.id)===String(id))?comprasVer:null;
  const L=String((inv&&inv.letra)||'A').trim().toUpperCase();
  // Misma precarga que la imputación: si ya está, el modal abre sin espera.
  let pre=null;
  try{pre=await Promise.race([flxPreDe(id,L),new Promise(r=>setTimeout(()=>r(undefined),80))]);}catch(e){}
  const car=pre?null:flxCargando('Leyendo la ficha del proveedor…','Clase de comprobante y rubro contable.',200);
  if(pre===undefined){try{pre=await flxPreDe(id,L);}catch(e){pre=null;}}
  let prev=pre?pre.preview:null;
  if(!prev){try{prev=await api('/api/compras/facturas/'+id+'/flexxus-preview?letra='+L);}catch(e){}}
  if(!prev||!prev.proveedor){if(car)car.cerrar();toast('No encontré el proveedor en Flexxus: revisá el CUIT en el editor','error');return;}
  if(!prev.cuit_norm&&prev.proveedor.cuit)prev.cuit_norm=String(prev.proveedor.cuit).replace(/\D/g,'');
  await elegirClaseProveedor(prev,car,pre);
  flxOlvidarPre(id);           // la ficha cambió: la próxima se relee
  cargarDestinoContable(id);   // refresca la card con lo que quedó
}
async function cargarDestinoContable(id){
  const pinta=html=>{const c=document.getElementById('imp-destino');if(c)c.innerHTML=html;};
  try{
    const d=await api('/api/compras/facturas/'+id+'/destino-contable');
    const fila=(et,val,color)=>`<div class="mcard-row" style="padding:4px 0"><span>${et}</span><b style="${color?'color:'+color:''};text-align:right;max-width:62%">${val}</b></div>`;
    let h='';
    if(d.clase){
      const esBU=/BIENES DE USO/i.test(d.clase);
      h+=fila('Clase de comprobante',d.clase,esBU?'var(--brote-2)':'');
      if(esBU)h+=fila('Rubro',d.rubro?((d.rubro_desc?d.rubro_desc+' · ':'')+d.rubro):'⚠ sin definir (cae en Hardware y software)',d.rubro?'':'#854F0B');
      else if(/BIENES DE CAMBIO/i.test(d.clase))h+=`<div class="sub" style="font-size:11.5px;margin-top:2px">Va a <b>MERCADERIAS</b>. Si no es mercadería, cambiale la clase acá abajo.</div>`;
      // Desplegables de clase/rubro a mano, sin tener que entrar a imputar
      if(!d.imputada)h+=`<button class="btn ghost" style="width:100%;justify-content:center;margin-top:7px;font-size:12px" onclick="abrirClaseDesdeDetalle('${id}')">✏️ Cambiar clase de comprobante / rubro</button>`;
    }else{
      h+=`<div class="sub" style="font-size:11.5px">No pude leer la clase de comprobante del proveedor${d.motivo_ficha?' ('+d.motivo_ficha+')':''}.</div>`;
      if(!d.imputada)h+=`<button class="btn ghost" style="width:100%;justify-content:center;margin-top:7px;font-size:12px" onclick="abrirClaseDesdeDetalle('${id}')">✏️ Elegir clase de comprobante / rubro</button>`;
    }
    if(d.imputada){
      h+=`<div class="divider" style="margin:8px 0"></div>`;
      h+=fila('Comprobante',d.comprobante||'—');
      h+=fila('Asiento',d.asiento||'—');
      if((d.cuentas||[]).length){
        h+=`<div style="font-size:11px;color:#586B60;margin:6px 0 3px">Cuentas del asiento (releídas de Flexxus):</div>`;
        h+=(d.cuentas||[]).map(c=>`<div style="font-size:11.5px;padding:2px 0 2px 8px;border-left:2px solid var(--linea)">${c}</div>`).join('');
      }else if(d.motivo_asiento){
        h+=`<div class="sub" style="font-size:11px">No pude releer el asiento: ${d.motivo_asiento}</div>`;
      }
      if(d.advertencia)h+=`<div style="background:#FCEBED;border:1px solid #EFB9C0;color:#A32D2D;border-radius:8px;padding:7px 10px;font-size:11.5px;margin-top:7px">🔴 ${d.advertencia}</div>`;
    }else{
      h+=`<div class="sub" style="font-size:11.5px;margin-top:5px">Todavía sin imputar en Flexxus.</div>`;
    }
    pinta(h);
  }catch(e){pinta('No pude leer el destino contable: '+e.message);}
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
  // Ítems editados: descripción, cantidad Y MONTO. El monto faltaba, así que
  // una corrección del neto no llegaba al detalle y Flexxus imputaba el
  // importe viejo del OCR (caso RAGAGLIA: $27.722,02 en vez de $33.466,23).
  if((inv.items||[]).length){
    body.items=(inv.items||[]).map((it,ix)=>{
      const c=g('ei-cant-'+ix),d=g('ei-desc-'+ix),n=g('ei-neto-'+ix);
      return {...it,
        descripcion:d?(d.value.trim()||it.descripcion):it.descripcion,
        cantidad:c?Math.max(1,Math.round(Number(c.value)||1)):(Number(it.cantidad)||1),
        monto_sin_iva:(n&&n.value!=='')?Number(n.value)||0:(Number(it.monto_sin_iva)||0)};
    });
  }
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
  const borrarLocal=async()=>{
    try{await api('/api/compras/factura/'+id,{method:'DELETE'});volverCompras();}
    catch(e){toast('No pude eliminar: '+(e.message||''),'error');}
  };
  // Sin imputar: se borra y listo
  if(!(inv&&inv.flexxus&&inv.flexxus.ok&&!inv.flexxus.anulada)){
    if(!await uiConfirm('¿Eliminar esta factura? No se puede deshacer.','Eliminar factura',{ok:'Eliminar',danger:true}))return;
    return borrarLocal();
  }
  // Imputada en Flexxus: hay que decidir qué pasa con el comprobante del ERP
  const num=inv.flexxus.numerocomprobante_fmt||((inv.flexxus.tipocomprobante||'')+' '+(inv.flexxus.numerocomprobante||''));
  const opcion=await new Promise(resolve=>{
    const bg=document.createElement('div');bg.className='modal-bg abierto';bg.style.zIndex=210;
    bg.innerHTML=`<div class="modal" style="max-width:470px">
      <div class="modal-tit">Eliminar factura imputada</div>
      <div class="sub" style="margin:6px 0 12px;font-size:12.5px">Esta factura está imputada en Flexxus como <b>${num}</b>${inv.flexxus.centro_costo&&inv.flexxus.centro_costo.numeroasiento?' · asiento '+inv.flexxus.centro_costo.numeroasiento:''}. Si la borrás solo del panel, el comprobante <b>sigue vivo en el ERP</b> y los dos sistemas quedan descoordinados.</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" id="an-anular" style="width:100%">Anular en Flexxus y eliminar acá</button>
        <button class="btn-salir" id="an-solo" style="width:100%;color:var(--rojo);border-color:#EFB9C0">Eliminar solo del panel</button>
        <button class="btn-salir" id="an-cancel" style="width:100%">Cancelar</button>
      </div></div>`;
    document.body.appendChild(bg);
    const fin=v=>{bg.remove();resolve(v);};
    bg.querySelector('#an-anular').onclick=()=>fin('anular');
    bg.querySelector('#an-solo').onclick=()=>fin('solo');
    bg.querySelector('#an-cancel').onclick=()=>fin('cancelar');
  });
  if(opcion==='cancelar')return;
  if(opcion==='solo'){
    if(!await uiConfirm('El comprobante '+num+' va a QUEDAR en Flexxus y vas a tener que anularlo a mano en el ERP.','¿Eliminar solo del panel?',{ok:'Eliminar igual',danger:true}))return;
    return borrarLocal();
  }
  const prog=flxCargando('Anulando en Flexxus…','Pidiendo la anulación del comprobante y verificando el asiento.',220);
  let r=null;
  try{r=await api('/api/compras/facturas/'+id+'/flexxus-anular',{method:'POST'});}
  catch(e){r={ok:false,motivo:e.message};}
  prog.cerrar();
  if(r&&r.ok){
    toast('Comprobante anulado en Flexxus ✓');
    return borrarLocal();
  }
  // No se pudo: se muestra el motivo y se decide si igual se borra del panel
  if(await uiConfirm((r&&r.motivo||'No pude anular el comprobante en Flexxus.')+
    '\n\nPodés anularlo a mano en el ERP. ¿Querés eliminar igual la factura del panel?',
    'No pude anular en Flexxus',{ok:'Eliminar igual',danger:true}))return borrarLocal();
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
// La clase contable del proveedor YA NO se toca acá: la palanca real de la
// cuenta contable es la CLASE DE COMPROBANTE + RUBRO de bienes de uso, que se
// revisa en el modal al imputar a Flexxus.
let comprasMsg='';

function comprasNueva(){comprasMode='carga';comprasStep='upload';comprasFile=null;comprasExtracted=null;comprasAssignMode='total';comprasAssign={objetivo:'',unidad:'',comentario:''};comprasAssignments={};comprasMsg='';go('compras');}
function comprasCancelar(){comprasMode='lista';comprasFile=null;comprasPaginas=[];comprasExtracted=null;comprasOCRVuelo=null;go('compras');}

// Las fotos de factura se ACHICAN antes de subirlas (máx 1300px, JPEG 0.82):
// una foto de celular de 4000px no se lee mejor y hace que la extracción tarde
// mucho más. Los PDF viajan tal cual.
// Prepara UN archivo (achica las imágenes en el navegador para que suban
// livianas). Devuelve una promesa con {data,type,name}.
function comprasPrepararArchivo(f){
  return new Promise(resolve=>{
    const r=new FileReader();
    r.onload=()=>{
      const dataUrl=String(r.result);
      if(!(f.type||'').startsWith('image/')){
        resolve({data:dataUrl.split(',')[1],type:f.type,name:f.name});return;
      }
      const img=new Image();
      img.onload=()=>{
        const esc=Math.min(1,1300/Math.max(img.width,img.height));
        const cv=document.createElement('canvas');
        cv.width=Math.round(img.width*esc);cv.height=Math.round(img.height*esc);
        cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
        resolve({data:cv.toDataURL('image/jpeg',0.82).split(',')[1],type:'image/jpeg',name:f.name});
      };
      img.onerror=()=>resolve({data:dataUrl.split(',')[1],type:f.type,name:f.name});
      img.src=dataUrl;
    };
    r.readAsDataURL(f);
  });
}

/* Facturas de VARIAS PÁGINAS: se pueden elegir varias fotos juntas (o sumarlas
   de a una con "＋ Agregar página"). Van todas al mismo pedido de lectura y el
   modelo devuelve un solo JSON con la factura completa. */
async function comprasPickFile(input,sumar){
  const fs=[...(input.files||[])];if(!fs.length)return;
  const nuevos=[];
  for(const f of fs.slice(0,6))nuevos.push(await comprasPrepararArchivo(f));
  if(sumar&&comprasPaginas.length)comprasPaginas=comprasPaginas.concat(nuevos).slice(0,6);
  else comprasPaginas=nuevos.slice(0,6);
  comprasFile=comprasPaginas[0];   // la 1ª es la que se ve en la vista previa
  input.value='';
  comprasPrefetchOCR();go('compras');
}
function comprasQuitarPagina(ix){
  comprasPaginas.splice(ix,1);
  comprasFile=comprasPaginas[0]||null;
  if(!comprasPaginas.length)comprasStep='pick';
  comprasOCRVuelo=null;
  if(comprasPaginas.length)comprasPrefetchOCR();
  go('compras');
}

// PREFETCH DEL OCR (11-ago): la lectura arranca EN EL MOMENTO en que se elige
// el archivo, en segundo plano, mientras el usuario todavía mira la vista
// previa. Cuando aprieta "Extraer con IA", la respuesta ya viene en camino (o
// ya llegó) — el tiempo de la IA corre en paralelo con el tiempo humano.
let comprasOCRVuelo=null;   // { clave, p:Promise }
let comprasPaginas=[];      // páginas de la MISMA factura (1 o varias)
function comprasPrefetchOCR(){
  if(!comprasFile||!comprasFile.data)return;
  const pgs=comprasPaginas.length?comprasPaginas:[comprasFile];
  // La clave incluye la cantidad de páginas: si se agrega una, el prefetch
  // anterior queda obsoleto y se vuelve a pedir con la factura completa.
  const clave=comprasFile.data.slice(0,80)+'|'+comprasFile.data.length+'|'+pgs.length;
  if(comprasOCRVuelo&&comprasOCRVuelo.clave===clave)return;
  comprasOCRVuelo={clave,
    p:api('/api/compras/extract',{method:'POST',body:JSON.stringify({
        fileData:comprasFile.data,fileType:comprasFile.type,
        paginas:pgs.map(x=>({data:x.data,type:x.type}))})})
      .catch(e=>({__error:e.message||'No se pudo extraer. Completá a mano.'}))};
}
async function comprasExtraer(){
  if(!comprasFile)return;
  comprasStep='extract';go('compras');
  try{
    comprasPrefetchOCR();   // por si el prefetch no corrió (archivo raro)
    const d=await comprasOCRVuelo.p;
    if(d.__error){comprasExtracted={fecha_factura:null,numero_factura:null,proveedor:null,cuit:null,items:[],total_sin_iva:0,total_iva:0};comprasMsg=d.__error;}
    else{comprasExtracted=d;comprasMsg='';
      (d.__avisos||[]).forEach(a=>toast('⚠ '+a,'error'));}
  }catch(e){comprasExtracted={fecha_factura:null,numero_factura:null,proveedor:null,cuit:null,items:[],total_sin_iva:0,total_iva:0};comprasMsg='No se pudo extraer. Completá a mano.';}
  comprasOCRVuelo=null;
  comprasAssignMode='total';comprasAssign={objetivo:'',unidad:'',comentario:''};comprasAssignments={};
  comprasStep='assign';go('compras');
}

/* Al tocar una alícuota se recalcula el IVA total: son la misma plata vista
   de dos formas, y si no cierran Flexxus recibe todo al 21%. */
function comprasAlicuotaCambio(){
  const g=id=>document.getElementById(id);
  const al=(comprasExtracted&&comprasExtracted.ivas)||[];
  let suma=0,n=0;
  al.forEach((x,ix)=>{const m=g('cf-alic-m-'+ix);if(m){suma+=parseFloat(m.value)||0;n++;}});
  if(!n)return;
  const iva=g('cf-iva');
  if(iva)iva.value=Math.round(suma*100)/100;
  const av=g('cf-alic-aviso');
  if(av)av.textContent=`Suman ${money(suma)} — es lo que va como IVA total.`;
}

// Lee lo que hay en el DOM y lo guarda en el estado (para no perderlo al re-renderizar)
function comprasCaptura(){
  const g=id=>document.getElementById(id);
  if(!comprasExtracted)return;
  if(g('cf-fecha')){
    comprasExtracted.fecha_factura=g('cf-fecha').value||null;
    comprasExtracted.numero_factura=g('cf-num').value||null;
    if(g('cf-letra'))comprasExtracted.letra=g('cf-letra').value||null;
    comprasExtracted.proveedor=g('cf-prov').value||null;
    comprasExtracted.cuit=g('cf-cuit').value||null;
    comprasExtracted.total_sin_iva=parseFloat(g('cf-neto').value)||0;
    comprasExtracted.total_iva=parseFloat(g('cf-iva').value)||0;
    // Alícuotas editadas a mano en el paso de revisión
    if((comprasExtracted.ivas||[]).length){
      comprasExtracted.ivas=comprasExtracted.ivas.map((x,ix)=>{
        const p=g('cf-alic-p-'+ix),m=g('cf-alic-m-'+ix);
        return {porcentaje:p?parseFloat(p.value)||0:x.porcentaje,
                monto:m?parseFloat(m.value)||0:x.monto};
      }).filter(x=>x.monto);
    }
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

// Aviso de fecha futura: Flexxus rechaza comprobantes posteriores a hoy y el
// OCR a veces invierte día y mes (08/10 → 8 de octubre).
function cfAvisoFecha(){
  const inp=document.getElementById('cf-fecha'), av=document.getElementById('cf-fecha-aviso');
  if(!inp||!av)return;
  const hoy=new Date().toISOString().slice(0,10);
  if(inp.value&&inp.value>hoy){
    const [a,m,d]=inp.value.split('-');
    av.textContent='⚠ Fecha futura: Flexxus la va a rechazar. ¿No será '+m+'/'+d+'/'+a+' (día y mes invertidos)?';
  }else av.textContent='';
}
async function comprasGuardar(){
  comprasCaptura();
  const d=comprasExtracted||{};
  // Objetivo y observaciones son obligatorios
  if(comprasAssignMode==='total'){
    if(!comprasAssign.objetivo){toast('Elegí un objetivo (centro de costo) antes de guardar.','error');return;}
    if(!String(comprasAssign.comentario||'').trim()){toast('Las observaciones son obligatorias. Escribí qué es este gasto.','error');return;}
  }else{
    const asigs=Object.values(comprasAssignments||{});
    const conObj=asigs.filter(a=>a&&a.objetivo);
    if(!conObj.length){toast('Asigná al menos un ítem a un objetivo.','error');return;}
    if(conObj.some(a=>!String(a.comentario||'').trim())){toast('Cada ítem asignado necesita observaciones. Completalas antes de guardar.','error');return;}
  }
  const inv={
    fecha_factura:d.fecha_factura||null,
    numero_factura:d.numero_factura||null,
    letra:(d.letra||'').toString().trim().toUpperCase()||null,
    proveedor:d.proveedor||null,
    cuit:d.cuit||null,
    total_sin_iva:Number(d.total_sin_iva)||0,
    total_iva:Number(d.total_iva)||0,
    // Alícuotas discriminadas (21% y 10,5% en la misma factura). Sin esto se
    // acreditaba todo al 21% en Flexxus.
    ivas:(d.ivas||[]).filter(x=>Number(x.monto))
      .map(x=>({porcentaje:Number(x.porcentaje)||0,monto:Number(x.monto)||0})),
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
    // Páginas 2 en adelante: se suben también, así el comprobante queda
    // completo y no solo la primera hoja.
    paginasExtra:comprasPaginas.length>1
      ? comprasPaginas.slice(1).map(p=>({data:p.data,type:p.type,name:p.name}))
      : [],
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
    const nPg=comprasPaginas.length;
    view.innerHTML=`
    <div class="view-head"><div><div class="view-title">Nueva factura</div><div class="view-desc">Subí el PDF o las fotos · la IA extrae los datos</div></div>
      <button class="btn-salir" onclick="comprasCancelar()">← Volver</button></div>
    <div style="max-width:520px">
      <label class="dropzone" id="cf-dz">
        <input type="file" accept="application/pdf,image/*" multiple style="display:none" onchange="comprasPickFile(this)">
        <div class="dz-ico">＋</div>
        <div class="dz-t">${comprasFile?comprasFile.name:'Tocá para elegir el archivo'}</div>
        <div class="dz-s">PDF, JPG o PNG · si la factura tiene varias hojas, elegilas todas juntas</div>
      </label>
      ${nPg?`<div class="panel" style="margin-top:12px;padding:10px 12px">
        <div style="font-size:12px;font-weight:600;margin-bottom:6px">${nPg} página${nPg===1?'':'s'} de esta factura</div>
        ${comprasPaginas.map((p,ix)=>`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:3px 0;font-size:12.5px">
          <span><b>${ix+1}.</b> ${String(p.name||'página '+(ix+1)).slice(0,42)}</span>
          <button class="btn-salir" style="padding:2px 8px;font-size:11px;color:var(--rojo)" onclick="comprasQuitarPagina(${ix})">✕</button>
        </div>`).join('')}
        ${nPg<6?`<label class="btn-salir" style="display:inline-block;margin-top:6px;padding:4px 10px;font-size:11.5px;cursor:pointer">
          ＋ Agregar página
          <input type="file" accept="application/pdf,image/*" multiple style="display:none" onchange="comprasPickFile(this,true)">
        </label>`:'<div class="sub" style="font-size:11px;margin-top:4px">Máximo 6 páginas</div>'}
      </div>`:''}
      ${comprasFile?`<button class="btn" style="margin-top:14px;width:100%" onclick="comprasExtraer()">✦ Extraer con IA${nPg>1?` (${nPg} páginas)`:''}</button>`:''}
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
  const filasItems=items.map(it=>`<tr><td>${it.descripcion||'—'}</td><td class="tr mono">${Number(it.cantidad)||1}</td><td class="money tr">${money(it.monto_sin_iva)}</td><td class="money tr">${money(it.iva)}</td></tr>`).join('');
  // Imputación (la clase contable se revisa al imputar a Flexxus, no acá)
  let imput;
  if(comprasAssignMode==='total'){
    imput=`
      <div class="mm-field"><label>Objetivo</label>
        <input id="cf-obj" list="cf-obj-list" class="busca" style="width:100%" placeholder="Escribí para buscar…" value="${(comprasAssign.objetivo||'').replace(/"/g,'&quot;')}" autocomplete="off">
        <datalist id="cf-obj-list">${COMPRAS_OBJ.map(o=>`<option value="${o.replace(/"/g,'&quot;')}">`).join('')}</datalist></div>
      <div class="mm-field"><label>Unidad</label><select id="cf-uni"><option value="">— Seleccioná —</option>${uoSel(comprasAssign.unidad)}</select></div>
      <div class="mm-field"><label>Comentarios / observaciones <span style="color:var(--rojo)">*</span></label><textarea id="cf-com" rows="2" class="ta-panel" placeholder="Obligatorio: qué es, para qué, N° de orden, etc.">${comprasAssign.comentario||''}</textarea></div>`;
  }else{
    imput=`<datalist id="cf-obj-list">${COMPRAS_OBJ.map(o=>`<option value="${o.replace(/"/g,'&quot;')}">`).join('')}</datalist>`+items.map((it,i)=>{const a=comprasAssignments[i]||{};return`
      <div class="item-imp">
        <div class="item-imp-head"><span>${it.descripcion||'Ítem '+(i+1)}</span><span class="money">${money((Number(it.monto_sin_iva)||0)+(Number(it.iva)||0))}</span></div>
        <div class="grid g-2">
          <div class="mm-field"><label>Objetivo</label><input list="cf-obj-list" data-io="${i}" class="busca" style="width:100%" placeholder="Buscar…" value="${(a.objetivo||'').replace(/"/g,'&quot;')}" autocomplete="off"></div>
          <div class="mm-field"><label>Unidad</label><select data-iu="${i}"><option value="">—</option>${uoSel(a.unidad)}</select></div>
        </div>
        <div class="mm-field"><label>Comentarios / observaciones <span style="color:var(--rojo)">*</span></label><textarea data-ic="${i}" rows="1" class="ta-panel" placeholder="Obligatorio">${a.comentario||''}</textarea></div>
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
            <div class="mm-field"><label>Fecha</label><input id="cf-fecha" type="date" max="${new Date().toISOString().slice(0,10)}" value="${d.fecha_factura||''}" oninput="cfAvisoFecha()">
              <div id="cf-fecha-aviso" class="sub" style="font-size:11px;color:#A32D2D"></div></div>
            <div class="mm-field"><label>N° Factura</label><input id="cf-num" value="${(d.numero_factura||'').replace(/"/g,'&quot;')}"></div>
            <div class="mm-field"><label>Letra ${d.letra?'<span style="color:var(--brote-2);font-weight:400">· leída ✓</span>':'<span style="color:var(--diesel);font-weight:400">· revisá</span>'}</label>
              <select id="cf-letra"><option value="">—</option>${['A','B','C'].map(x=>`<option value="${x}" ${(d.letra||'')===x?'selected':''}>${x}</option>`).join('')}</select></div>
          </div>
          <div class="mm-field"><label>Proveedor</label><input id="cf-prov" value="${(d.proveedor||'').replace(/"/g,'&quot;')}"></div>
          <div class="grid g-2">
            <div class="mm-field"><label>CUIT</label><input id="cf-cuit" value="${(d.cuit||'').replace(/"/g,'&quot;')}"></div>
            <div class="mm-field"><label>Neto (sin IVA)</label><input id="cf-neto" type="number" step="0.01" value="${Number(d.total_sin_iva)||0}"></div>
          </div>
          <div class="mm-field"><label>IVA${(d.ivas||[]).length>1?' (suma de las alícuotas)':''}</label><input id="cf-iva" type="number" step="0.01" value="${Number(d.total_iva)||0}"></div>
          ${(()=>{const al=(d.ivas||[]).filter(x=>Number(x.monto));
            if(!al.length)return '';
            return `<div class="mm-field" style="grid-column:1/-1">
              <label>Alícuotas · van discriminadas a Flexxus</label>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                ${al.map((x,ix)=>`<div style="display:flex;align-items:center;gap:5px;background:var(--papel);padding:4px 8px;border-radius:7px">
                  <input id="cf-alic-p-${ix}" type="number" step="0.5" value="${x.porcentaje}" style="width:62px;padding:3px 5px" onchange="comprasAlicuotaCambio()">
                  <span class="sub" style="font-size:12px">%</span>
                  <input id="cf-alic-m-${ix}" type="number" step="0.01" value="${x.monto}" style="width:130px;padding:3px 5px" onchange="comprasAlicuotaCambio()">
                </div>`).join('')}
              </div>
              <div class="sub" id="cf-alic-aviso" style="font-size:11.5px;margin-top:4px"></div>
            </div>`;})()}
        </div>
        <div class="mm-label">Ítems</div>
        <div class="tabla-wrap">
          <table><thead><tr><th>Descripción</th><th class="tr">Cant.</th><th class="tr">Neto</th><th class="tr">IVA</th></tr></thead>
          <tbody>${filasItems}<tr class="tot-row"><td><b>Total</b></td><td></td><td class="money tr"><b>${money(d.total_sin_iva)}</b></td><td class="money tr"><b>${money(d.total_iva)}</b></td></tr></tbody></table>
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
