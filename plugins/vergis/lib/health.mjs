// health.mjs — `vergis-ops health`: el predicado canónico POR EL BORDE (lo que ve el tráfico real) y
// la fase viva de cada anillo, leída del sujeto — nunca del registro.
//
// La sonda corre con el `node` de un anillo vivo (el activo si lo hay), contra `RINGS_EDGE_URL` —el
// conmutador visto desde la red interna, el mismo camino que usa el smoke de `botler-rollout`— y
// contra cada anillo por su nombre en la red. Solo viajan conteos y fases: nada que el transporte
// pueda recortar sin que el centinela lo note.

import { EXIT, b64, out, fail } from './util.mjs'
import { resolveInstallation } from './declaration.mjs'
import { runRemote } from './transport.mjs'
import { PREDICATE_JS } from './predicate.mjs'

const PROBE_JS = `${PREDICATE_JS}
const [edgeUrl, ...rings] = (process.env.VO_ARGS || '').split(' ').filter(Boolean)
const H = {}
if (process.env.VERGIS_OPS_GATE_TOKEN) H['x-gate-token'] = process.env.VERGIS_OPS_GATE_TOKEN
async function uno(u) {
  try {
    const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(10000) })
    return juzgar(r.status, await r.text())
  } catch (e) {
    return { ok: false, status: null, error: String(e && e.name) + ':' + String(e && e.message).slice(0, 80) }
  }
}
const edge = await uno(edgeUrl.replace(/\\/$/, '') + '/healthz')
console.log('EDGE ' + JSON.stringify(edge))
for (const r of rings) console.log('RING ' + r + ' ' + JSON.stringify(await uno('http://' + r + ':8080/healthz')))
`

export function healthBody() {
  return String.raw`VO_ACTIVE=$(vo_active_ring || true)
printf 'ACTIVE %s\n' "${'$'}{VO_ACTIVE:--}"
VO_RINGS=$($DOCKER ps --filter label=vergis.ring --format '{{.Names}}' | sort | tr '\n' ' ')
printf 'RINGS %s\n' "${'$'}{VO_RINGS:--}"
VO_HOST=$VO_ACTIVE
[ -n "$VO_HOST" ] || VO_HOST=$(printf '%s' "$VO_RINGS" | cut -d' ' -f1)
if [ -z "$VO_HOST" ]; then
  echo 'NOPROBE sin anillo vivo que aloje la sonda: se mide el borde con su propio wget'
  if b=$($DOCKER exec "$RINGS_EDGE" wget -q -T 5 -O- http://127.0.0.1:8079/healthz 2>/dev/null); then
    printf 'EDGE-RAW %s\n' "$(printf '%s' "$b" | head -c 3000 | vo_b64)"
  else
    echo 'EDGE-RAW-FAIL'
  fi
  exit 0
fi
VO_ARGS="$RINGS_EDGE_URL $VO_RINGS"; export VO_ARGS
$DOCKER exec -i -e VERGIS_OPS_GATE_TOKEN -e VO_ARGS "$VO_HOST" node --input-type=module - <<'VO_JS'
${PROBE_JS}
VO_JS
`
}

/** Mide y devuelve `{ code, edge, rings, active, lines }` sin imprimir. */
export async function measureHealth(decl, ins) {
  const r = await runRemote(decl, ins, healthBody())
  const res = { code: EXIT.OK, edge: null, rings: [], active: null, lines: [] }
  for (const l of r.lines) {
    if (l.startsWith('ACTIVE ')) res.active = l.slice(7) === '-' ? null : l.slice(7)
    else if (l.startsWith('EDGE ')) res.edge = JSON.parse(l.slice(5))
    else if (l.startsWith('RING ')) {
      const [, name, ...rest] = l.split(' ')
      res.rings.push({ name, ...JSON.parse(rest.join(' ')) })
    } else if (l.startsWith('EDGE-RAW ')) {
      const { juzgar } = await import('./predicate.mjs')
      res.edge = { ...juzgar(200, Buffer.from(l.slice(9), 'base64').toString('utf8')), via: 'wget del borde' }
    } else if (l === 'EDGE-RAW-FAIL') res.edge = { ok: false, status: null, error: 'el borde no respondió 2xx a su propio wget', via: 'wget del borde' }
    else if (l.trim()) res.lines.push(l)
  }
  if (!res.edge) {
    fail(EXIT.MUTE, `health: el remoto no devolvió la medición del borde (rc=${r.rc}).\n${r.lines.map((x) => `   | ${x}`).join('\n')}`)
  }
  res.code = res.edge.ok ? EXIT.OK : EXIT.FINDING
  return res
}

export function describe(s) {
  if (!s) return '—'
  if (s.error) return `sin respuesta (${s.error})`
  const blk = s.block ? `${s.block}=${s.serving}/${s.total}` : 'sin bloque de conteos'
  return `${s.status} phase=${s.phase ?? '?'} ${blk}${s.json ? '' : ' · cuerpo NO-JSON'}${s.sueltos ? ' · conteos fuera de bloque' : ''}`
}

export async function runHealth(common) {
  const { decl, ins } = resolveInstallation(common)
  const h = await measureHealth(decl, ins)
  out(`== vergis-ops health · ${ins.id} ==`)
  out(`   borde (${h.edge.via ?? 'RINGS_EDGE_URL'}): ${h.edge.ok ? 'OK ' : 'MAL'} ${describe(h.edge)}`)
  out(`   anillo activo (según el borde): ${h.active ?? 'ninguno declarado en active.caddy'}`)
  for (const r of h.rings) out(`   anillo ${r.name}: ${r.ok ? 'OK ' : '·  '} ${describe(r)}`)
  for (const l of h.lines) out(`   ${l}`)
  if (h.edge.block === 'pis') out('   ℹ el nodo habla el contrato viejo (`pis`, < 0.27.0): se leyó igual y se dice')
  if (h.code === EXIT.OK) out('✓ SANO (exit 0): el borde satisface 200 ∧ phase=serving ∧ lets.serving == lets.total.')
  else out('⚠ HALLAZGO (exit 1): el borde NO satisface el predicado. Si esto es el punto de partida de una promoción, no es una promoción: es un incidente.')
  return h.code
}

// Para que la prueba de «sabe fallar» pueda ver el programa que viaja.
export const _PROBE_JS_B64 = () => b64(PROBE_JS)
