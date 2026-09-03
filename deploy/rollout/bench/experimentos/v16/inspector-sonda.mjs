const list = await (await fetch('http://127.0.0.1:9229/json')).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
let id = 0; const pend = new Map(); const events = [];
const send = (method, params={}) => new Promise((res, rej) => { const i = ++id; pend.set(i, {res, rej}); ws.send(JSON.stringify({id:i, method, params})); });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); } else events.push(d); };
await new Promise(r => ws.onopen = r);
await send('Runtime.enable'); await send('Debugger.enable');
const scripts = []; ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method==='Debugger.scriptParsed' && /serve-rls\.mjs$/.test(d.params.url)) scripts.push(d.params); });
await new Promise(r => setTimeout(r, 1500));
const sc = events.filter(e => e.method==='Debugger.scriptParsed' && /serve-rls\.mjs$/.test(e.params.url)).map(e=>e.params).concat(scripts);
if (!sc.length) { console.log('script no encontrado'); process.exit(2); }
const LINE = Number(process.argv[2]) - 1;
const bp = await send('Debugger.setBreakpointByUrl', { lineNumber: LINE, url: sc[0].url });
console.log('breakpoint en', sc[0].url, 'línea', LINE+1, 'locs', bp.locations.length);
process.kill(1, 'SIGUSR2');
let paused = null;
for (let i=0; i<40 && !paused; i++) { await new Promise(r=>setTimeout(r,100)); paused = events.find(e => e.method==='Debugger.paused'); }
if (!paused) { console.log('NO se pausó (el handler no llegó al breakpoint)'); await send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId}); process.exit(3); }
const cf = paused.params.callFrames[0].callFrameId;
for (const expr of ['typeof soltando', 'soltando && soltando.constructor && soltando.constructor.name', 'plane.hasControl()', 'loops.armed()', 'JSON.stringify(loops.status().map(s=>s.name+":"+s.armed))', 'noAspirarHasta', 'typeof loops.disarm']) {
  try { const r = await send('Debugger.evaluateOnCallFrame', { callFrameId: cf, expression: expr, returnByValue: true }); console.log(expr, '=>', JSON.stringify(r.result.value ?? r.result.description)); }
  catch (e) { console.log(expr, '=> ERROR', e.message.slice(0,200)); }
}
// seguir paso a paso: stepInto hasta 6 veces y reportar la línea
for (let s=0; s<8; s++) { events.length = 0; await send('Debugger.stepOver'); let p=null; for (let i=0;i<30&&!p;i++){ await new Promise(r=>setTimeout(r,100)); p=events.find(e=>e.method==='Debugger.paused'); } if(!p){console.log('paso',s,'no volvió a pausar (await?)'); break;} const f=p.params.callFrames[0]; console.log('paso',s,'→ línea',f.location.lineNumber+1,f.functionName); }
await send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});
await send('Debugger.resume');
console.log('resumido'); process.exit(0);
