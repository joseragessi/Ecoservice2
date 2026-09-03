// Harness de normalizarNumeroOC (panel_api.js) — el número de orden como lo escribe el proveedor en la factura.
// Extrae la función REAL del archivo. Si el proveedor escribe "O/C 2026-41" y no encuentra la OC-2026-0041, la imputación no se hereda.

const fs=require('fs');const src=fs.readFileSync(__dirname + '/panel_api.js','utf8');
const ini=src.indexOf('function normalizarNumeroOC');const fin=src.indexOf('async function buscarOrdenParaFactura');
const f=new Function(src.slice(ini,fin)+'\nreturn normalizarNumeroOC;')();
let ok=0,mal=0;const eq=(n,a,b)=>{if(a===b){ok++;console.log('✓ '+n);}else{mal++;console.log('✗ '+n+' — dio '+JSON.stringify(a));}};
eq('OC-2026-0041 tal cual', f('OC-2026-0041',2026), 'OC-2026-0041');
eq('O/C 2026-41', f('O/C 2026-41',2026), 'OC-2026-0041');
eq('oc 2026 0041 con espacios', f('oc 2026 0041',2026), 'OC-2026-0041');
eq('Orden de compra N° 41 (solo correlativo → año actual)', f('Orden de compra N° 41',2026), 'OC-2026-0041');
eq('OC: 0041', f('OC: 0041',2026), 'OC-2026-0041');
eq('Su pedido OC-2025-0388 (año anterior se respeta)', f('Su pedido OC-2025-0388',2026), 'OC-2025-0388');
eq('202641 pegado', f('202641',2026), 'OC-2026-0041');
eq('vacío → null', f('',2026), null);
eq('null → null', f(null,2026), null);
eq('texto sin números → null', f('sin orden',2026), null);
eq('OC 7 → 0007', f('OC 7',2026), 'OC-2026-0007');
console.log(`\n${ok} ok · ${mal} mal`);process.exit(mal?1:0);
