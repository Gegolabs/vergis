// contract.mjs — `vergis-ops contract`: lo que el NODO declara de sí mismo (`GET /contrato`, CAP-148).
//
//   contract                       resumen: versión, watches, qué envs son de arranque, qué quedó pendiente
//   contract classify <archivo>    la clase del acto de publicar ese archivo del espejo, y su gate
//   contract wait <archivo> [--timeout s]
//                                  ¿el nodo TOMÓ el archivo? sha cargado == sha local y pending=false
//   contract env <VARIABLE>        ¿cambiarla exige arranque?
//
// `/contrato` es admin-only: la sonda forja `X-Forwarded-Email` con `RINGS_ADMIN_EMAIL` y entra POR
// DETRÁS DEL BORDE, desde dentro del anillo. Eso es un privilegio que se ejerce en cada consulta, y solo
// es seguro donde el nodo no está expuesto sin borde. El contrato completo pesa decenas de KB: se
// resume DENTRO del anillo y solo viaja lo que el verbo necesita.

import { resolve, relative, sep } from 'node:path'
import { EXIT, fail, out, sha256File, shq, assertToken } from './util.mjs'
import { resolveInstallation, requireKey, mirrorRoot, localPath } from './declaration.mjs'
import { runRemote } from './transport.mjs'
import { classifyPath, gateFor } from './classify.mjs'

const CONTRACT_JS = String.raw`
const [mode, ...args] = (process.env.VO_ARGS || '').split(' ').filter(Boolean)
const email = process.env.VO_ADMIN || ''
const H = { 'x-forwarded-email': email }
if (process.env.VERGIS_OPS_GATE_TOKEN) H['x-gate-token'] = process.env.VERGIS_OPS_GATE_TOKEN
const b64 = (s) => Buffer.from(String(s)).toString('base64')
async function leer() {
  try {
    const r = await fetch((process.env.VO_NODE_BASE || 'http://127.0.0.1:8080') + '/contrato', { headers: H, signal: AbortSignal.timeout(15000) })
    const t = await r.text()
    let j = null
    try { j = JSON.parse(t) } catch {}
    return { status: r.status, j, t }
  } catch (e) { return { status: null, error: String(e && e.message) } }
}
const under = (p, pre) => { const q = pre.replace(/\/+$/, ''); return p === q || p.startsWith(q + '/') }
let c = await leer()
if (c.status !== 200 || !c.j) {
  console.log('CSTATUS ' + (c.status ?? 'sin-respuesta') + ' ' + b64((c.j && c.j.error) || c.error || String(c.t || '').slice(0, 200)))
  process.exit(0)
}
console.log('CSTATUS 200 ' + b64(''))
console.log('CVERSION ' + (c.j.version ?? '-'))
if (mode === 'summary') {
  for (const w of c.j.watches || []) console.log('WATCH ' + b64(JSON.stringify(w)))
  const env = c.j.env || {}
  console.log('ENV bootOnly=' + (env.bootOnly || []).join(',') + ' reloadableContent=' + (env.reloadableContent || []).join(',') + ' unknown=' + (env.unknown || []).join(','))
  const arts = c.j.artifacts || []
  console.log('ARTS total=' + arts.length + ' pending=' + arts.filter((a) => a.pending).length)
  for (const a of arts.filter((a) => a.pending).slice(0, 20)) console.log('PENDING ' + a.path)
  console.log('CAVEATS ' + (c.j.caveats || []).length)
  const d = c.j.delta || {}
  if (d.unchanged === false || (d.env && ((d.env.nowBootOnly || []).length || (d.env.nowReloadable || []).length))) {
    console.log('DELTA desde=' + (d.from ?? d.desde ?? '?') + ' nowBootOnly=' + ((d.env && d.env.nowBootOnly) || []).join(',') + ' nowReloadable=' + ((d.env && d.env.nowReloadable) || []).join(','))
  } else console.log('DELTA ' + (d.reason ? 'reason=' + d.reason : 'unchanged'))
} else if (mode === 'watches') {
  for (const p of args) {
    const w = (c.j.watches || []).find((x) => (x.paths || []).some((q) => under(p, q)))
    console.log('COVER ' + p + ' ' + (w ? b64(JSON.stringify(w)) : '-'))
  }
} else if (mode === 'env') {
  const env = c.j.env || {}
  const v = args[0]
  const where = (env.bootOnly || []).includes(v) ? 'bootOnly' : (env.reloadableContent || []).includes(v) ? 'reloadableContent' : (env.unknown || []).includes(v) ? 'unknown' : 'absent'
  console.log('ENVCLASS ' + v + ' ' + where)
} else if (mode === 'artifact') {
  const [p, sha, secs] = args
  const hasta = Date.now() + Number(secs || 30) * 1000
  for (;;) {
    const a = (c.j && c.j.artifacts || []).find((x) => x.path === p)
    if (a && a.sha256 === sha && !a.pending) { console.log('ART taken ' + a.loadedAt); break }
    if (Date.now() > hasta) {
      console.log('ART ' + (a ? 'stale loaded=' + a.sha256.slice(0, 16) + ' disk=' + String(a.diskSha256).slice(0, 16) + ' pending=' + a.pending : 'absent'))
      break
    }
    await new Promise((r) => setTimeout(r, 1000))
    c = await leer()
  }
}
`

/** El cuerpo remoto: el programa corre DENTRO del anillo activo. `extra` va antes (mounts, etc.). */
function body(args, extra = '') {
  return String.raw`VO_ACTIVE=$(vo_active_ring || true)
if [ -z "$VO_ACTIVE" ]; then echo NOACTIVE; exit 0; fi
printf 'ACTIVE %s\n' "$VO_ACTIVE"
${extra}
if [ -z "${'$'}{RINGS_ADMIN_EMAIL:-}" ]; then echo NOADMIN; exit 0; fi
VO_ADMIN=$RINGS_ADMIN_EMAIL; export VO_ADMIN
VO_ARGS=${args}; export VO_ARGS
$DOCKER exec -i -e VERGIS_OPS_GATE_TOKEN -e VO_ADMIN -e VO_ARGS "$VO_ACTIVE" node --input-type=module - <<'VO_JS'
${CONTRACT_JS}
VO_JS
`
}

function b(s) {
  return Buffer.from(s, 'base64').toString('utf8')
}

/** Corre el cuerpo y separa lo que el contrato dijo de lo que no pudo decir. */
async function ask(decl, ins, args, extra) {
  const r = await runRemote(decl, ins, body(args, extra))
  const res = { lines: r.lines, active: null, contract: null, status: null, error: null }
  for (const l of r.lines) {
    if (l === 'NOACTIVE') res.error = 'el borde no declara anillo activo (rings/active.caddy sin reverse_proxy): no hay nodo al que preguntarle'
    else if (l === 'NOADMIN') res.error = 'la instalación no declara RINGS_ADMIN_EMAIL: /contrato es admin-only y sin esa identidad no se puede leer'
    else if (l.startsWith('ACTIVE ')) res.active = l.slice(7)
    else if (l.startsWith('CSTATUS ')) {
      const [, st, msg] = l.split(' ')
      res.status = st
      if (st !== '200') res.error = `/contrato respondió ${st}: ${b(msg ?? '')}`
    }
  }
  if (!res.error && res.status === null) {
    res.error = `el script remoto no llegó a leer /contrato (rc=${r.rc}): ${r.lines.slice(-2).join(' | ') || 'sin salida'}`
  }
  return res
}

/** Del archivo local del espejo, su ruta en el host. */
export function hostPathOf(decl, ins, file) {
  const mirror = requireKey(ins, 'mirror.families', 'este verbo')
  const abs = resolve(file)
  const root = mirrorRoot(decl, ins)
  for (const f of mirror) {
    const loc = resolve(root, f.local)
    const hostBase = `${ins.host.root.replace(/\/+$/, '')}/${f.remote}`
    if (f.kind === 'fixed' && abs === loc) return { family: f, host: hostBase, local: abs }
    if (f.kind === 'sweep' && abs.startsWith(loc + sep)) {
      const rel = relative(loc, abs).split(sep).join('/')
      if ((f.exclude ?? []).some((x) => x.path === rel)) fail(EXIT.NOT_RUN, `«${rel}» está excluido de la familia «${f.id}» (${f.exclude.find((x) => x.path === rel).reason}): no se publica`)
      return { family: f, host: `${hostBase}/${rel}`, local: abs }
    }
  }
  fail(EXIT.NOT_RUN, `«${abs}» no pertenece a ninguna familia del espejo (mirror.families): espejo primero — lo que el host corre se declara en el repo antes de publicarse`)
}

/** Clasifica publicar `file` y devuelve `{ cls, why, gate, … }` (lo usa también `publish`). */
export async function classifyFile(decl, ins, file) {
  const hp = hostPathOf(decl, ins, file)
  assertToken(hp.host, 'ruta en el host', /^\/[A-Za-z0-9._/@+=-]+$/)
  const extra = String.raw`VO_P=${shq(hp.host)}
$DOCKER inspect "$VO_ACTIVE" --format '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' 2>/dev/null | while IFS='|' read -r s d; do
  [ -n "$s" ] || continue
  case "$VO_P" in ("$s"|"$s"/*) printf 'RINGMOUNT %s|%s\n' "$s" "$d" ;; esac
done
for c in $($DOCKER ps --format '{{.Names}}'); do
  [ "$c" = "$VO_ACTIVE" ] && continue
  svc=$($DOCKER inspect "$c" --format '{{index .Config.Labels "com.docker.compose.service"}}' 2>/dev/null)
  $DOCKER inspect "$c" --format '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' 2>/dev/null | while IFS='|' read -r s d; do
    [ -n "$s" ] || continue
    case "$VO_P" in ("$s"|"$s"/*) printf 'OMOUNT %s|%s|%s|%s\n' "$c" "${'$'}{svc:--}" "$s" "$d" ;; esac
  done
done
VO_CP=$($DOCKER inspect "$VO_ACTIVE" --format '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' 2>/dev/null | while IFS='|' read -r s d; do
  [ -n "$s" ] || continue
  case "$VO_P" in ("$s") printf '%s\n' "$d"; break ;; ("$s"/*) printf '%s%s\n' "$d" "${'$'}{VO_P#"$s"}"; break ;; esac
done)
[ -n "$VO_CP" ] || VO_CP=/vergis-ops/no-montado`
  const r = await ask(decl, ins, `"watches $VO_CP"`, extra)
  const ringMounts = r.lines.filter((l) => l.startsWith('RINGMOUNT ')).map((l) => { const [s, d] = l.slice(10).split('|'); return { Source: s, Destination: d } })
  const others = r.lines.filter((l) => l.startsWith('OMOUNT ')).map((l) => { const [c, svc, s, d] = l.slice(7).split('|'); return { container: c, service: svc === '-' ? null : svc, Source: s, Destination: d } })
  const cover = r.lines.find((l) => l.startsWith('COVER '))
  let contract = null
  if (!r.error && cover) {
    const w = cover.split(' ')[2]
    contract = { watches: w && w !== '-' ? [JSON.parse(b(w))] : [] }
  }
  const c = classifyPath({ hostPath: hp.host, contract, ringMounts, others, services: ins.services })
  return { ...c, hostPath: hp.host, family: hp.family, local: hp.local, active: r.active, contractError: r.error, gate: gateFor(ins, c.cls) }
}

/** ¿El nodo tomó el archivo? */
export async function waitTaken(decl, ins, file, containerPath, secs) {
  const sha = sha256File(file)
  assertToken(containerPath, 'ruta en el contenedor', /^\/[A-Za-z0-9._/@+=-]+$/)
  const r = await ask(decl, ins, shq(`artifact ${containerPath} ${sha} ${secs}`))
  if (r.error) return { code: EXIT.NOT_RUN, msg: r.error, sha }
  const a = r.lines.find((l) => l.startsWith('ART '))
  if (!a) return { code: EXIT.MUTE, msg: 'el anillo no devolvió el estado del artefacto', sha }
  if (a.startsWith('ART taken')) return { code: EXIT.OK, msg: `el nodo lo tomó (${a.slice(10)}): sha cargado == sha local (${sha.slice(0, 16)}…), pending=false`, sha }
  return { code: EXIT.FINDING, msg: `el nodo NO lo tomó en ${secs} s: ${a.slice(4)} (local ${sha.slice(0, 16)}…)`, sha }
}

export async function runContract(common, o) {
  const { decl, ins } = resolveInstallation(common)
  const [sub, arg] = o._
  if (sub === 'classify') {
    if (!arg) fail(EXIT.NOT_RUN, 'contract classify <archivo del espejo>')
    const c = await classifyFile(decl, ins, localPath({ dir: common.cwd }, arg))
    out(`== vergis-ops contract classify · ${ins.id} ==`)
    out(`   ${c.local} → ${c.hostPath}${c.containerPath ? ` (en el nodo: ${c.containerPath})` : ''}`)
    if (c.contractError) out(`   ⚠ ${c.contractError}`)
    out(`   clase: ${c.cls} — ${c.why}`)
    out(`   gate: ${c.gate.gate}${c.gate.declared ? '' : ' (clase sin gate declarado: rige approval)'}`)
    return EXIT.OK
  }
  if (sub === 'wait') {
    if (!arg) fail(EXIT.NOT_RUN, 'contract wait <archivo del espejo> [--timeout s]')
    const c = await classifyFile(decl, ins, localPath({ dir: common.cwd }, arg))
    if (c.cls !== 'content') fail(EXIT.NOT_RUN, `«${arg}» no es contenido que el nodo recargue (clase ${c.cls}): no hay artefacto que esperar`)
    const w = await waitTaken(decl, ins, c.local, c.containerPath, Number(o.timeout ?? 30))
    out(`${w.code === EXIT.OK ? '✓' : '⚠'} ${w.msg} (exit ${w.code})`)
    return w.code
  }
  if (sub === 'env') {
    if (!arg) fail(EXIT.NOT_RUN, 'contract env <VARIABLE>')
    assertToken(arg, 'variable', /^[A-Z][A-Z0-9_]*$/)
    const r = await ask(decl, ins, shq(`env ${arg}`))
    if (r.error) fail(EXIT.NOT_RUN, r.error)
    const l = r.lines.find((x) => x.startsWith('ENVCLASS '))?.split(' ')
    const where = l?.[2]
    out(`${arg}: ${where} — cambiar su VALOR exige recrear el anillo (clase boot)${where === 'reloadableContent' ? '; lo que se recarga en caliente es el CONTENIDO del archivo al que apunta' : ''}`)
    const g = gateFor(ins, 'boot')
    out(`gate de la clase boot: ${g.gate}`)
    return EXIT.OK
  }
  if (sub) fail(EXIT.NOT_RUN, 'uso: contract [classify <archivo> | wait <archivo> | env <VAR>]')
  const s = await contractSummary(decl, ins)
  out(`== vergis-ops contract · ${ins.id} · anillo ${s.active ?? '—'} ==`)
  for (const l of s.lines) out(l)
  if (s.code === EXIT.OK) out('✓ LEÍDO (exit 0).')
  return s.code
}

/** El resumen del contrato como líneas listas para imprimir (lo usa también `recon`). */
export async function contractSummary(decl, ins) {
  const r = await ask(decl, ins, '"summary"')
  const lines = []
  if (r.error) {
    lines.push(`   ✗ ${r.error}`)
    lines.push('   Sin contrato vivo, todo acto sobre lo que el nodo monta se clasifica como interrupción (ante la duda, corte).')
    return { code: EXIT.NOT_RUN, lines, active: r.active }
  }
  for (const l of r.lines) {
    if (l.startsWith('CVERSION ')) lines.push(`   versión del nodo: ${l.slice(9)}`)
    else if (l.startsWith('WATCH ')) { const w = JSON.parse(b(l.slice(6))); lines.push(`   watch ${(w.envs ?? []).join(',') || '(sin env)'} · ${(w.paths ?? []).join(' ')} → ${w.reloads}`) }
    else if (/^(ENV|ARTS|PENDING|CAVEATS|DELTA) /.test(l)) lines.push(`   ${l.startsWith('PENDING') ? '⚠ ' : ''}${l}`)
  }
  lines.push('   (la sonda entró por detrás del borde con la identidad admin forjada: solo es seguro donde el nodo no está expuesto sin borde)')
  return { code: EXIT.OK, lines, active: r.active }
}

