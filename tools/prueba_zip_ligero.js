// Prueba del "modo ligero": ejecuta el js de cada widget ZIP real dentro del
// mismo ámbito que crea ZipLigero.tsx (copiado aquí en JS plano) sobre jsdom.
const fs = require('fs'); const path = require('path');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom; const { document } = window;
global.window = window; global.document = document;
for (const k of ['HTMLElement','Element','Node','Event','CustomEvent','getComputedStyle','requestAnimationFrame','cancelAnimationFrame','setTimeout','clearTimeout','MutationObserver','SVGElement','navigator','Promise'])
  if (window[k] !== undefined) global[k] = window[k];
global.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
window.ResizeObserver = global.ResizeObserver;
window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 10, height: 10 });
window.SVGElement.prototype.getComputedTextLength = () => 10;
window.SVGElement.prototype.getScreenCTM = () => ({ a:1,b:0,c:0,d:1,e:0,f:0, inverse(){return this;} });
document.fonts = { ready: Promise.resolve(), check: () => true };

function htmlEstatico(html){ return html.replace(/\{\{label\}\}/g,'<span data-w-label></span>').replace(/\{\{value\}\}/g,'<span data-w-value></span>').replace(/\{\{name\}\}/g,'<span data-w-name></span>'); }

function crearAmbito(host, root, puente) {
  const doc = new Proxy(document, { get(real, k) {
    switch (k) {
      case 'querySelector': case 'querySelectorAll': case 'getElementById': return root[k].bind(root);
      case 'readyState': return 'complete';
      case 'activeElement': return root.activeElement;
      case 'documentElement': case 'body': return host;
      case 'addEventListener': return (tipo, fn, opts) => { if (tipo==='DOMContentLoaded'||tipo==='readystatechange') { Promise.resolve().then(()=>fn.call(doc,new window.Event(tipo))); return; } if (tipo==='visibilitychange') { real.addEventListener(tipo,fn,opts); return;} root.addEventListener(tipo,fn,opts); };
      case 'removeEventListener': return (tipo, fn, opts) => { root.removeEventListener(tipo,fn,opts); real.removeEventListener(tipo,fn,opts); };
      default: { const v = real[k]; return typeof v === 'function' ? v.bind(real) : v; }
    } } });
  const base = { document: doc, onWidgetUpdate: null, onWidgetEscrito: null,
    escribir: (valor, variable) => puente.escribir(valor, variable),
    addEventListener: (tipo, fn, opts) => { if (tipo==='message') puente.mensajes.add(fn); else if (tipo==='resize') puente.redimension.add(fn); else window.addEventListener(tipo, fn, opts); },
    removeEventListener: (tipo, fn, opts) => { if (tipo==='message') puente.mensajes.delete(fn); else if (tipo==='resize') puente.redimension.delete(fn); else window.removeEventListener(tipo, fn, opts); },
    postMessage: () => undefined };
  Object.defineProperty(base, 'WIDGET', { get: () => puente.widget, set: () => undefined, enumerable: true });
  Object.defineProperty(base, 'innerWidth', { get: () => host.clientWidth });
  Object.defineProperty(base, 'innerHeight', { get: () => host.clientHeight });
  const win = new Proxy(base, { get(t, k) { if (k==='window'||k==='self'||k==='globalThis'||k==='parent'||k==='top') return win; if (k in t) return t[k]; const v = window[k]; return typeof v === 'function' ? v.bind(window) : v; }, set(t,k,v){ t[k]=v; return true; } });
  const DESVIADOS = new Set(['window','self','globalThis','document','WIDGET','onWidgetUpdate','onWidgetEscrito','escribir','innerWidth','innerHeight']);
  const ambito = new Proxy({}, { has: (_t,k) => typeof k==='string' && (DESVIADOS.has(k) || k in base), get: (_t,k) => (k==='document' ? doc : win[k]), set: (_t,k,v) => { base[k]=v; return true; } });
  return { win, ambito };
}

const dir = process.argv[2];
let ok=0, fallos=[], sinUpdate=[], usan=0;
for (const f of fs.readdirSync(dir).filter(f=>f.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = htmlEstatico(d.html||'');
  const puente = { widget: { value:'', on:false, frac:0, label:'', name:'', color:'#009999', bg:'transparent', borderColor:'#94a3b8', fontSize:14, bold:false, opacity:1, escritura:false, unidad:'', vars:{} }, mensajes:new Set(), redimension:new Set(), escribir:()=>{} };
  const { win, ambito } = crearAmbito(host, root, puente);
  try {
    const correr = new Function('__w', `with (__w) {\n${d.js||''}\n}`);
    correr(ambito);
    // simular una lectura
    const w = { ...puente.widget, value: 12.5, label: '12.5 °C', name: 'TIRC-01', on: true, frac: 0.5, vars: { temp: { value: 1, on: true, frac: 0.1, label: '1' } } };
    puente.widget = w;
    if (typeof win.onWidgetUpdate === 'function') { win.onWidgetUpdate(w); usan++; } else sinUpdate.push(d.kind);
    for (const fn of puente.mensajes) fn({ data: { type: 'widget-update', clicable: false, widget: w } });
    for (const fn of puente.redimension) fn();
    ok++;
  } catch (e) { fallos.push(d.kind + ': ' + (e && e.message)); }
}
// deja que corran los DOMContentLoaded diferidos y rAF
setTimeout(() => { console.log('OK:', ok, ' con onWidgetUpdate:', usan, ' sin:', sinUpdate.length, sinUpdate.slice(0,8)); console.log('FALLOS:', fallos.length); fallos.forEach(x=>console.log('  ', x)); }, 300);
process.on('uncaughtException', e => { console.log('EXC diferida:', e.message); });
