// Harness de imprimirPlanillaStock (panel.js): la planilla por objetivo tiene que entrar en UNA hoja para privados y depósito. Extrae la función real.

// Verifica que la planilla por objetivo elija bien la densidad según cantidad de máquinas.
const fs=require('fs');const src=fs.readFileSync(__dirname + '/panel.js','utf8');
const ini=src.indexOf('function imprimirPlanillaStock');const fin=src.indexOf('\n}\n',ini)+3;
const fn=src.slice(ini,fin);
let html=null;
const ctx={stkGen:null,window:{_maqPadron:[],open:()=>({document:{write:h=>{html=h;},close(){}}})},alert:m=>{throw new Error(m)}};
const f=new Function('stkGen','window','alert',fn+'\nreturn imprimirPlanillaStock;');
function correr(n){
  html=null;
  const filas=[];let q=0;
  while(q<n){const c=Math.min(3,n-q);filas.push({objetivo_id:'o1',objetivo:'UCC',grupo:'privado',periodo:'2026-09',tipo:'Motoguadaña',cantidad:c,numeros:Array.from({length:c},(_,i)=>String(q+i+1))});q+=c;}
  f({filas},ctx.window,ctx.alert)('o1');
  return html;
}
let ok=0,mal=0;const eq=(n,c,d)=>{if(c){ok++;console.log('✓ '+n);}else{mal++;console.log('✗ '+n+(d?' — '+d:''));}};
let h=correr(10);
eq('10 máquinas: letra normal (12px), una columna',/font-size:12px/.test(h)&&!/class="dos"/.test(h));
eq('dice Máquinas: 10',/Máquinas:<\/b> 10/.test(h));
h=correr(34);
eq('34 máquinas (UCC): compacta (10.5px), una columna',/font-size:10.5px/.test(h)&&!/class="dos"/.test(h));
h=correr(70);
eq('70 máquinas: dos columnas y 9.5px',/class="dos"/.test(h)&&/font-size:9.5px/.test(h));
eq('las dos columnas suman 70 filas',(h.match(/<tr>/g)||[]).length-2===70,String((h.match(/<tr>/g)||[]).length));
h=correr(5);
eq('grupo privado dice "control mensual"',/privado · control mensual/.test(h));
const filasDep=[{objetivo_id:'o2',objetivo:'DEP',grupo:'deposito',periodo:'2026-09',tipo:'Pala',cantidad:2,numeros:[]}];
html=null;f({filas:filasDep},ctx.window,ctx.alert)('o2');
eq('grupo depósito dice "control quincenal"',/depósito · control quincenal/.test(html));
eq('2 sin número → 2 renglones S/N',(html.match(/S\/N/g)||[]).length===2);
console.log(`\n${ok} ok · ${mal} mal`);process.exit(mal?1:0);
