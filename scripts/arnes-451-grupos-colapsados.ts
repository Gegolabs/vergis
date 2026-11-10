// #451 · Arnés de los grupos colapsados: corre el runtime REAL de la tabla (el <script> que emite
// renderHtmlPiece) en un DOM (jsdom) y mide los criterios de aceptación del issue sobre la conducta del
// navegador — agrupar, clic en la cabecera, segundo nivel, Expandir/Colapsar todo, filtrar con grupos
// abiertos, un grupo que aparece después, e ida y vuelta del detalle (#422).
//
// jsdom NO es dependencia del repo: el arnés lo toma de donde se le diga, sin tocar package.json.
//   npm i --prefix /tmp/arnes-jsdom jsdom@24.1.3
//   JSDOM=/tmp/arnes-jsdom/node_modules/jsdom npx tsx scripts/arnes-451-grupos-colapsados.ts
//   CONTROL=1 JSDOM=… npx tsx scripts/arnes-451-grupos-colapsados.ts   # control negativo: debe FALLAR
//
// Con CONTROL=1 el documento lleva el runtime de siempre aunque la tabla declare `collapsed`: los casos
// `collapsed · …` deben caer y los `sin opción · …` seguir en pie. Sale con rc=1 si algún caso falla.
import { createRequire } from 'node:module'
import { renderHtmlPiece, TABLE_RUNTIME_SOURCE, TABLE_RUNTIME_SOURCE_GROUPS_COLLAPSED, type ResolvedNode } from '@vergis/capabilities'
const require = createRequire(import.meta.url)
if (!process.env.JSDOM) throw new Error('JSDOM=<ruta a node_modules/jsdom> (ver la cabecera del arnés)')
const { JSDOM } = require(process.env.JSDOM)

const FILAS = [
  { area: 'Norte', empresa: 'A', monto: 10 },
  { area: 'Norte', empresa: 'A', monto: 5 },
  { area: 'Norte', empresa: 'B', monto: 7 },
  { area: 'Sur', empresa: 'C', monto: 3 },
  { area: 'Sur', empresa: 'C', monto: 2 },
  { area: 'Sur', empresa: 'D', monto: 1 },
  { area: 'Este', empresa: 'E', monto: 4 },
]
function tabla(groupStart?: 'collapsed'): ResolvedNode {
  return {
    type: 'table', title: 'Montos', interactive: true, rows: FILAS,
    columnsSpec: [
      { field: 'area', label: 'Área', groupBy: true },
      { field: 'empresa', label: 'Empresa', groupBy: true },
      { field: 'monto', label: 'Monto', format: 'int_0', align: 'right', total: 'sum' },
    ],
    ...(groupStart ? { groupStart } : {}),
  }
}
async function html(n: ResolvedNode): Promise<string> {
  const out = (await renderHtmlPiece.execute({ piece: n, title: 'X', theme: 'roble', stateKey: 'k' }, { agent: 't' })) as { html: string }
  // CONTROL=1: control negativo — el documento lleva el runtime de siempre aunque la tabla declare collapsed.
  return process.env.CONTROL === '1' ? out.html.split(TABLE_RUNTIME_SOURCE_GROUPS_COLLAPSED).join(TABLE_RUNTIME_SOURCE) : out.html
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function abrir(h: string, url = 'https://x.test/pi/1', storage?: Record<string, string>) {
  const dom = new JSDOM(h, { url, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w: any) { w.__name = (f: unknown) => f /* artefacto de tsx (keepNames), no del runtime */; if (storage) for (const k in storage) w.sessionStorage.setItem(k, storage[k]) } })
  const d = dom.window.document
  const q = (s: string) => d.querySelector(s)
  const st = () => {
    const trs = [...d.querySelectorAll('tbody > tr')] as any[]
    return {
      heads: trs.filter((t) => t.classList.contains('vt-group-head')).map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
      hojas: trs.filter((t) => !t.classList.contains('vt-group-head')).length,
      pie: (q('tfoot .vt-total-row') as any)?.textContent.replace(/\s+/g, ' ').trim(),
    }
  }
  const agrupar = (f: string) => { const s = q('.vt-group-add') as any; s.value = f; s.dispatchEvent(new dom.window.Event('change')) }
  const clic = (sel: string, i = 0) => (d.querySelectorAll(sel)[i] as any).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  const buscar = async (t: string) => { const g = q('.vt-global-search') as any; g.value = t; g.dispatchEvent(new dom.window.Event('input')); await sleep(250) }
  return { dom, d, st, agrupar, clic, buscar }
}
const out: Record<string, unknown> = {}
const fallas: string[] = []
const chk = (n: string, ok: boolean, v: unknown) => { out[n] = { ok, v }; if (!ok) fallas.push(n) }

for (const modo of ['collapsed', 'sin opción'] as const) {
  const col = modo === 'collapsed'
  const t = abrir(await html(tabla(col ? 'collapsed' : undefined)))
  const pie0 = t.st().pie
  t.agrupar('area')
  let s = t.st()
  chk(`${modo} · 1 agrupar`, col ? s.heads.length === 3 && s.hojas === 0 : s.heads.length === 3 && s.hojas === 7, s)
  chk(`${modo} · 1 pie no cambia`, s.pie === pie0, [pie0, s.pie])
  t.clic('tr.vt-group-head', 0) // abre/cierra Este (orden natural: Este, Norte, Sur)
  s = t.st()
  chk(`${modo} · 2 clic invierte un grupo`, col ? s.hojas === 1 : s.hojas === 6, s)
  t.agrupar('empresa')
  s = t.st()
  chk(`${modo} · 2 segundo nivel nace como el defecto`, col ? s.heads.length === 3 && s.hojas === 0 : s.hojas === 7, s)
  if (col) {
    t.clic('tr.vt-group-head', 1) // abre Norte
    s = t.st()
    chk(`${modo} · 2 abrir el 1er nivel muestra cabeceras del 2º colapsadas`, s.heads.length === 5 && s.hojas === 0 && s.heads.some((h) => h.includes('Empresa: A')), s)
  }
  t.clic('.vt-expand-all'); s = t.st()
  chk(`${modo} · 3 expandir todo`, s.hojas === 7, s)
  t.clic('.vt-collapse-all'); s = t.st()
  chk(`${modo} · 3 colapsar todo`, s.hojas === 0 && s.heads.length === 3, s)
  // 3 · filtrar con grupos abiertos: abrir Norte (y su empresa A), buscar 'Norte' → sigue abierto;
  // limpiar → Sur y Este vuelven como dice el defecto.
  t.clic('tr.vt-group-head', 1); t.clic('tr.vt-group-head', 2)
  const abiertoAntes = t.st().hojas
  await t.buscar('Norte'); s = t.st()
  chk(`${modo} · 3 filtrar conserva lo abierto`, s.hojas === abiertoAntes && s.heads[0].includes('Norte'), [abiertoAntes, s])
  await t.buscar(''); s = t.st()
  chk(`${modo} · 3 al limpiar el filtro lo abierto sigue abierto y lo demás vuelve cerrado`, s.hojas === abiertoAntes && s.heads.length === 5, s)
}

// Grupo que aparece DESPUÉS: con 'collapsed', agrupar con un filtro puesto y luego quitarlo.
{
  const t = abrir(await html(tabla('collapsed')))
  await t.buscar('Sur'); t.agrupar('area'); t.clic('tr.vt-group-head', 0)
  await t.buscar('')
  const s = t.st()
  chk('collapsed · grupos que aparecen al quitar el filtro nacen colapsados (Norte, Este)', s.hojas === 3 && s.heads.length === 3, s)
}

// Ida y vuelta del detalle (#422): lo abierto sobrevive.
{
  const h = await html(tabla('collapsed'))
  const t = abrir(h)
  t.agrupar('area'); t.clic('tr.vt-group-head', 1) // abre Norte
  t.dom.window.dispatchEvent(new t.dom.window.Event('pagehide'))
  const ss: Record<string, string> = {}
  for (let i = 0; i < t.dom.window.sessionStorage.length; i++) { const k = t.dom.window.sessionStorage.key(i); ss[k] = t.dom.window.sessionStorage.getItem(k) }
  const v = abrir(h, 'https://x.test/pi/1?vret=1', ss)
  const s = v.st()
  chk('collapsed · al volver del detalle sigue abierto el grupo que se miraba', s.heads.length === 3 && s.hojas === 3, s)
}
console.log(JSON.stringify(out, null, 1))
console.log(fallas.length ? `FALLAS: ${fallas.join(' | ')}` : 'TODO OK')
process.exit(fallas.length ? 1 : 0)
