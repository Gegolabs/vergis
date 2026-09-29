// smoke.mjs — `vergis-ops smoke`: ¿cada Let responde, en cada una de sus vistas, con la identidad de
// sondeo? Núcleo portado del smoke del primer adoptante (la sonda que cerró P-187, P-206 y el cruce de
// P-144), con sus lecciones con nombre intactas:
//
//   · La sonda FORJA `X-Forwarded-Email`/`X-Forwarded-Groups` y pide al nodo desde DENTRO del anillo
//     (`:8080` no está publicado). Mide el tramo del nodo —imagen, spec, gobierno/RLS, dato—, NO el
//     login real del borde: un verde acá es compatible con un SSO roto, y la salida lo dice.
//   · Las vistas se DERIVAN de los specs montados (`pages[].id`), jamás se cablean. La 1ª en `/<slug>`,
//     las demás en `/<slug>?page=<id>`. Un `?page=` desconocido NO da 404: cae en silencio a la 1ª vista
//     con 200 (P-206) ⇒ se coteja QUÉ vista sirvieron, leyendo la nav.
//   · Las vistas de drill (las que declaran `context:`) exigen `?ctx.*`: se LISTAN como no medidas.
//   · La ruta se normaliza (el router quita UN solo `/`: `//pi-01` daba 404 en todos los Lets sanos, P-187).
//   · El inventario se RECONCILIA con `/healthz`: si los Lets probados ≠ `lets.total`, es medición a
//     medias (7), no un verde.
//   · La variable del grupo no se llama `GROUPS` en ningún shell: en bash es un arreglo especial y la
//     asignación se ignora en silencio (la sonda forjaba el gid del usuario).
//
// Inyector `PROBE_FAULT` (solo controles negativos; cada valor solo puede DAÑAR la medición):
//   mute → 5 · nonce → 3 · count → 7 · page → 1

import { EXIT, fail, out, err, b64, worst } from './util.mjs'
import { resolveInstallation, requireKey } from './declaration.mjs'
import { runRemote } from './transport.mjs'

const SMOKE_JS = String.raw`
const cfg = JSON.parse(Buffer.from(process.env.VO_CFG || '', 'base64').toString('utf8'))
const { readdirSync, readFileSync } = await import('node:fs')
// VO_NODE_BASE solo existe en el banco de pruebas del Producto (docker falso): en un anillo real no se pasa.
const BASE = process.env.VO_NODE_BASE || 'http://127.0.0.1:8080'
const headers = (id) => {
  const H = { 'x-forwarded-email': id.email, 'x-forwarded-groups': (id.groups || []).join(',') }
  if (process.env.VERGIS_OPS_GATE_TOKEN) H['x-gate-token'] = process.env.VERGIS_OPS_GATE_TOKEN
  return H
}
const servedPage = (t) => { const am = t.match(/<a href="\?page=([^"&]*)[^"]*" class="active"/); return am ? decodeURIComponent(am[1]) : '' }
async function pedir(url, id) {
  try {
    const r = await fetch(BASE + url, { headers: headers(id), signal: AbortSignal.timeout(120000) })
    return { status: r.status, text: await r.text() }
  } catch (e) { return { status: null, error: String(e && e.message).slice(0, 100) } }
}
if (cfg.mode === 'all') {
  const DIR = process.env.VERGIS_SPECS_DIR || '/specs'
  const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const pagesOf = (txt) => {
    const out = []; let inP = false, cur = null
    for (const ln of txt.split(/\r?\n/)) {
      if (/^pages:/.test(ln)) { inP = true; continue }
      if (!inP) continue
      if (/^[^ \t#]/.test(ln)) break
      const mi = ln.match(/^  - id:[ \t]*["']?([A-Za-z0-9_-]+)/)
      if (mi) { cur = { id: mi[1], ctx: false }; out.push(cur); continue }
      if (cur && /^    context:/.test(ln)) cur.ctx = true
    }
    return out
  }
  let pis = []
  try {
    for (const f of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f) && !f.startsWith('._')).sort()) {
      const txt = readFileSync(DIR + '/' + f, 'utf8')
      const m = txt.match(/^identity:\s*$([\s\S]*?)(?=^\S)/m)
      const c = (m ? m[1] : txt).match(/^\s+code:\s*["']?([^"'\r\n]+)/m)
      if (!c) continue
      const pg = pagesOf(txt)
      pis.push({ slug: slugify(c[1].trim()), nav: pg.filter((p) => !p.ctx).map((p) => p.id), drill: pg.filter((p) => p.ctx).map((p) => p.id) })
    }
  } catch (e) { console.log('SPECS-ERROR ' + String(e).slice(0, 120)) }
  { const seen = new Set(); pis = pis.filter((p) => seen.has(p.slug) ? false : (seen.add(p.slug), true)) }
  let hz = {}; let hzerr = ''
  try { const r = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(10000) }); hz = JSON.parse(await r.text()) } catch (e) { hzerr = String(e) }
  let ok = 0, bad = 0, errs = 0, vistas = 0, drill = 0
  for (const p of pis) {
    const nav = p.nav.length ? p.nav : [null]
    let pok = 0
    for (let i = 0; i < nav.length; i++) {
      const id = nav[i]
      let url = '/' + p.slug + (i === 0 ? '' : '?page=' + encodeURIComponent(id))
      if (cfg.faultPage && i > 0) url = '/' + p.slug + '?page=NO-EXISTE-' + i
      const etiq = p.slug + (i === 0 ? '' : '?page=' + id)
      vistas++
      const r = await pedir(url, cfg.identity)
      if (r.status === null) { console.log('ERR ' + etiq + ' no se pudo pedir: ' + r.error); errs++; continue }
      const served = servedPage(r.text)
      const pedida = id != null ? (cfg.faultPage && i > 0 ? 'NO-EXISTE-' + i : id) : (p.nav.length ? p.nav[0] : '')
      let nota = ''
      if (pedida && served && served !== pedida) nota = ' SIRVIÓ page=' + served + ' (pedí ' + pedida + '; un ?page= desconocido cae en silencio a la 1ª vista)'
      else if (pedida && !served && p.nav.length > 1) nota = ' sin nav en el HTML: no pude cotejar QUÉ vista sirvieron'
      const bien = r.status === 200 && !nota.startsWith(' SIRVIÓ')
      if (bien) { ok++; pok++ } else { bad++; console.log('MAL ' + etiq + ' status=' + r.status + ' bytes=' + r.text.length + nota) }
      if (bien && nota) console.log('NOTA ' + etiq + nota)
    }
    console.log('LET ' + p.slug + ' vistas=' + nav.length + ' ok=' + pok + (p.drill.length ? ' drill-no-medidas=' + p.drill.join(',') : ''))
    drill += p.drill.length
  }
  if (hzerr) console.log('ERR healthz no se pudo leer: ' + hzerr.slice(0, 100))
  const hzb = (hz.lets && hz.lets.total != null) ? hz.lets : hz.pis
  const total = (hzb && hzb.total != null ? hzb.total : -1) + (cfg.faultCount ? 1 : 0)
  const serving = (hzb && hzb.serving != null ? hzb.serving : -1)
  console.log('SMOKE pis=' + pis.length + ' vistas=' + vistas + ' ok=' + ok + ' mal=' + bad + ' err=' + errs + ' drill=' + drill + ' hz_total=' + total + ' hz_serving=' + serving + ' hz_block=' + (hz.lets ? 'lets' : hz.pis ? 'pis' : '-'))
} else if (cfg.mode === 'route') {
  const r = await pedir('/' + cfg.route, cfg.identity)
  if (r.status === null) { console.log('ROUTE-ERR ' + r.error); process.exit(0) }
  const served = cfg.page ? servedPage(r.text) : ''
  console.log('ROUTE status=' + r.status + ' bytes=' + r.text.length + (cfg.page ? ' served=' + (served || '-') : ''))
  for (const n of cfg.needles || []) console.log('NEEDLE ' + Buffer.from(n).toString('base64') + ' ' + (r.text.split(n).length - 1))
} else if (cfg.mode === 'rls') {
  for (const c of cfg.checks) {
    const r = await pedir('/' + c.route, c.id)
    if (r.status === null) { console.log('RLS-ERR ' + c.route + ' ' + c.identity + ' ' + r.error); continue }
    const faltan = (c.present || []).filter((n) => !r.text.includes(n))
    const sobran = (c.absent || []).filter((n) => r.text.includes(n))
    const ok = r.status === 200 && !faltan.length && !sobran.length
    console.log('RLS ' + (ok ? 'OK' : 'MAL') + ' ' + c.route + ' ' + c.identity + ' status=' + r.status + (faltan.length ? ' faltan=' + Buffer.from(JSON.stringify(faltan)).toString('base64') : '') + (sobran.length ? ' sobran=' + Buffer.from(JSON.stringify(sobran)).toString('base64') : ''))
  }
}
`

export function nodeInActive(cfg, js = SMOKE_JS) {
  return String.raw`VO_ACTIVE=$(vo_active_ring || true)
if [ -z "$VO_ACTIVE" ]; then echo NOACTIVE; exit 0; fi
printf 'ACTIVE %s\n' "$VO_ACTIVE"
VO_CFG=${b64(JSON.stringify(cfg))}; export VO_CFG
$DOCKER exec -i -e VERGIS_OPS_GATE_TOKEN -e VO_CFG "$VO_ACTIVE" node --input-type=module - <<'VO_JS'
${js}
VO_JS
`
}

function identity(ins, o) {
  const ids = requireKey(ins, 'probe_identities', 'smoke')
  if (o.identity) {
    const x = ids.find((i) => i.id === o.identity)
    if (!x) fail(EXIT.NOT_RUN, `--identity «${o.identity}» no está en probe_identities (${ids.map((i) => i.id).join(' · ')})`)
    return x
  }
  return ids[0]
}

function normalizeRoute(raw) {
  const [path, q] = raw.split('?')
  const route = path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').toLowerCase()
  if (!route) fail(EXIT.NOT_RUN, `la ruta quedó vacía tras normalizar «${raw}» (la raíz no es un Let; usa smoke sin ruta)`)
  if (/[^a-z0-9/_-]/.test(route)) fail(EXIT.NOT_RUN, `la ruta «${route}» tiene caracteres fuera de [a-z0-9/_-]`)
  let page = ''
  if (q !== undefined) {
    if (!q.startsWith('page=')) fail(EXIT.NOT_RUN, `de la query solo se admite «?page=<id>» (llegó «?${q}»): los drills (?ctx.*) no se pueden inventar`)
    page = q.slice(5)
    if (!/^[A-Za-z0-9_-]+$/.test(page)) fail(EXIT.NOT_RUN, `«?page=${page}»: el id de vista va en [A-Za-z0-9_-]`)
  }
  const norm = route + (page ? `?page=${page}` : '')
  if (norm !== raw) err(`ℹ ruta normalizada: «${raw}» → «${norm}» (el router del nodo no tolera slashes de más — P-187)`)
  return { route: norm, page }
}

const FAULT = () => process.env.PROBE_FAULT || ''

async function remote(decl, ins, cfg) {
  const f = FAULT()
  if (f && !['mute', 'nonce', 'count', 'page'].includes(f)) fail(EXIT.NOT_RUN, `PROBE_FAULT=«${f}» no existe (mute · nonce · count · page)`)
  if (f) err(`!! PROBE_FAULT=${f} — INYECTOR DE FALLAS ACTIVO (solo controles negativos) !!`)
  const r = await runRemote(decl, ins, nodeInActive(cfg), { mute: f === 'mute', crossed: f === 'nonce' })
  if (r.lines.includes('NOACTIVE')) fail(EXIT.NOT_RUN, 'el borde no declara anillo activo (rings/active.caddy): no hay nodo que sondear')
  return r
}

/** Smoke total: todas las vistas de todos los Lets, reconciliado con /healthz. Devuelve el código. */
export async function smokeAll(decl, ins, o, { quiet = false } = {}) {
  const id = identity(ins, o)
  const f = FAULT()
  const r = await remote(decl, ins, { mode: 'all', identity: id, faultCount: f === 'count', faultPage: f === 'page' })
  const say = quiet ? () => {} : out
  const s = r.lines.find((l) => l.startsWith('SMOKE '))
  if (!s) fail(EXIT.MUTE, `smoke: el anillo no devolvió el resumen (¿node reventó dentro del contenedor?)\n${r.lines.slice(-5).map((l) => `   | ${l}`).join('\n')}`)
  const kv = Object.fromEntries(s.slice(6).split(' ').map((p) => p.split('=')))
  const N = Number(kv.pis), V = Number(kv.vistas), OK = Number(kv.ok), MAL = Number(kv.mal), ERR = Number(kv.err), DRILL = Number(kv.drill), HZT = Number(kv.hz_total)
  say(`== vergis-ops smoke · ${ins.id} · anillo ${r.lines.find((l) => l.startsWith('ACTIVE '))?.slice(7)} · identidad ${id.id} <${id.email}> ==`)
  for (const l of r.lines) if (/^(LET|MAL|ERR|NOTA|SPECS-ERROR) /.test(l)) say(`   ${l}`)
  say(`   -- ${N} Let(s) · ${V} vista(s) · ok ${OK} · mal ${MAL} · err ${ERR} · drill no medidas ${DRILL} · /healthz total=${HZT} serving=${kv.hz_serving} (${kv.hz_block}) --`)
  say('   (mide el tramo del NODO con identidad forjada por detrás del borde: el login real del borde queda fuera)')
  if (N === 0 || N !== HZT || ERR > 0) {
    say(`⚠ MEDICIÓN PARCIAL (exit 7): se probaron ${N} Let(s) y /healthz declara ${HZT}${ERR ? `, con ${ERR} vista(s) que no se pudieron pedir` : ''}. Lo no medido no cuenta como OK.`)
    return EXIT.PARTIAL
  }
  if (MAL > 0) {
    say(`⚠ HALLAZGO (exit 1): ${MAL} de ${V} vista(s) no respondieron 200 o sirvieron otra vista. El instrumento midió bien; el terreno está mal.`)
    return EXIT.FINDING
  }
  say(`✓ SMOKE VERDE (exit 0): ${OK}/${V} vistas de ${N} Lets en 200, cada una sirviendo la vista pedida, reconciliado con /healthz.${DRILL ? ` ${DRILL} vista(s) de drill quedaron fuera (exigen ?ctx.*).` : ''}`)
  return EXIT.OK
}

/** Las comprobaciones de RLS declaradas. `null` si la instalación no declara ninguna. */
export async function smokeRls(decl, ins, { quiet = false } = {}) {
  const checks = ins.rls_checks ?? []
  if (!checks.length) return null
  const ids = requireKey(ins, 'probe_identities', 'smoke --rls')
  const full = checks.map((c) => {
    const id = ids.find((i) => i.id === c.identity)
    if (!id) fail(EXIT.NOT_RUN, `rls_checks: la identidad «${c.identity}» no está en probe_identities`)
    return { ...c, id }
  })
  const r = await remote(decl, ins, { mode: 'rls', checks: full })
  const say = quiet ? () => {} : out
  const lines = r.lines.filter((l) => l.startsWith('RLS'))
  let code = EXIT.OK
  for (const l of lines) {
    const dec = l.replace(/(faltan|sobran)=(\S+)/g, (_, k, v) => `${k}=${Buffer.from(v, 'base64').toString('utf8')}`)
    say(`   ${dec}`)
    if (l.startsWith('RLS-ERR')) code = worst([code, EXIT.PARTIAL])
    else if (l.startsWith('RLS MAL')) code = worst([code, EXIT.FINDING])
  }
  if (lines.length !== checks.length) code = worst([code, EXIT.PARTIAL])
  return code
}

export async function runSmoke(common, o) {
  const { decl, ins } = resolveInstallation(common)
  const raw = o._[0]
  if (!raw) {
    let code = await smokeAll(decl, ins, o)
    if (o.rls) {
      out('   -- RLS por identidad (rls_checks) --')
      const c = await smokeRls(decl, ins)
      if (c === null) out('   RLS no verificada: la instalación no declara rls_checks.')
      else code = worst([code, c])
    }
    return code
  }
  const { route, page } = normalizeRoute(raw)
  const needles = [o.needle ?? []].flat()
  for (const n of needles) if (/['`$\\]/.test(n)) fail(EXIT.NOT_RUN, `needle con carácter no admitido (' \` $ \\): «${n}»`)
  const id = identity(ins, o)
  const r = await remote(decl, ins, { mode: 'route', route, page, needles, identity: id })
  const e = r.lines.find((l) => l.startsWith('ROUTE-ERR '))
  if (e) { out(`✗ NO PUDE MEDIR (exit 5): el fetch a :8080 falló — ${e.slice(10)}`); return EXIT.MUTE }
  const st = r.lines.find((l) => l.startsWith('ROUTE '))
  if (!st) fail(EXIT.MUTE, 'el anillo no devolvió el status de la ruta')
  const kv = Object.fromEntries(st.slice(6).split(' ').map((p) => p.split('=')))
  out(`== vergis-ops smoke ${route} · ${ins.id} · identidad ${id.id} ==`)
  out(`   status ${kv.status} · ${kv.bytes} B${page ? ` · vista servida ${kv.served}` : ''}`)
  let code = EXIT.OK
  for (const l of r.lines.filter((x) => x.startsWith('NEEDLE '))) {
    const [, n, c] = l.split(' ')
    const txt = Buffer.from(n, 'base64').toString('utf8')
    out(`   «${txt}»: ${c}`)
    if (Number(c) === 0) code = EXIT.FINDING
  }
  if (kv.status !== '200') { out(`⚠ HALLAZGO (exit 1): ${route} respondió ${kv.status}, no 200.`); return EXIT.FINDING }
  if (page && kv.served !== '-' && kv.served !== page) { out(`⚠ HALLAZGO (exit 1): pedí ?page=${page} y sirvieron ?page=${kv.served} (un id inexistente cae en silencio a la 1ª vista).`); return EXIT.FINDING }
  if (page && kv.served === '-') out('   ℹ el HTML no trae nav: QUÉ vista sirvieron no está medido.')
  out(code === EXIT.OK ? '✓ MEDÍ (exit 0).' : '⚠ HALLAZGO (exit 1): alguna needle no aparece.')
  return code
}
