// Harness del orden de la lista de Reparaciones (panel.js). Extrae el
// comparador REAL del archivo.

// Verifica el orden de la lista de reparaciones (panel.js).
// Decisión 11-sep: crítico → alta → media → baja, y dentro de cada prioridad
// lo MÁS VIEJO primero. Antes ordenaba solo por fecha y lo urgente quedaba
// abajo: "solo se ve lo que está primero".
const fs=require('fs');const src=fs.readFileSync(__dirname + '/panel.js','utf8');
// Se extrae SOLO el cuerpo del comparador, para probar la función real.
const i=src.indexOf('.slice().sort((a,b)=>{')+'.slice().sort('.length;
const j=src.indexOf('});',src.indexOf('return new Date(a.created_at)',i))+1;
const cmp=new Function('return '+src.slice(i,j))();
const ord=arr=>arr.slice().sort(cmp);

let ok=0,mal=0;const eq=(n,c,d)=>{if(c){ok++;console.log('✓ '+n);}else{mal++;console.log('✗ '+n+(d?' — '+d:''));}};
const r=(p,dias,est)=>({prioridad:p,created_at:new Date(Date.now()-dias*86400000).toISOString(),estado:est||'pendiente',id:`${p}-${dias}`});

console.log('— Prioridad primero —');
let l=ord([r('baja',30),r('media',20),r('alta',10),r('critico',1)]);
eq('crítico arriba aunque sea el más nuevo', l[0].prioridad==='critico', l.map(x=>x.prioridad).join(','));
eq('el orden es crítico, alta, media, baja', l.map(x=>x.prioridad).join(',')==='critico,alta,media,baja');

console.log('\n— Dentro de la prioridad, lo más viejo primero —');
l=ord([r('alta',2),r('alta',30),r('alta',15)]);
eq('30d, 15d, 2d', l.map(x=>x.id).join(',')==='alta-30,alta-15,alta-2', l.map(x=>x.id).join(','));

console.log('\n— Las dos reglas juntas —');
l=ord([r('media',60),r('critico',1),r('critico',40),r('alta',5)]);
eq('crítico de 40d primero, después el crítico de 1d, después alta, después media',
  l.map(x=>x.id).join(',')==='critico-40,critico-1,alta-5,media-60', l.map(x=>x.id).join(','));

console.log('\n— Las finalizadas al fondo de su prioridad —');
l=ord([r('alta',50,'finalizado'),r('alta',2)]);
eq('una alta abierta de 2d va antes que una alta finalizada de 50d', l[0].estado!=='finalizado', l.map(x=>x.estado).join(','));

console.log('\n— Bordes —');
l=ord([r(null,10),r('critico',1)]);
eq('sin prioridad va al fondo', l[0].prioridad==='critico');
l=ord([r('rara',10),r('baja',1)]);
eq('una prioridad desconocida va al fondo', l[0].prioridad==='baja');
eq('lista vacía no rompe', ord([]).length===0);
l=ord([r('alta',5),r('alta',5)]);
eq('dos iguales no rompen', l.length===2);

console.log(`\n${ok} ok · ${mal} mal`);process.exit(mal?1:0);
