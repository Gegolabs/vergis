// rollout.mjs — `vergis-ops exec rollout <acto>`: la ceremonia de anillos, con lo que el RUNBOOK exige
// convertido en construcción.
//
//   status                       el registro + la fase viva (botler-rollout status)
//   tool <versión> [--no-pull]   extrae botler-rollout DE LA IMAGEN candidata, por digest, verifica su sha
//                                contra el label `vergis.rollout.sha256` y lo instala con respaldo (D9)
//   install <versión> [--no-pull] [--redigest]
//   promote <versión> [--timeout s] [--tail s]
//   rollback [<versión>] [--tail s]
//   retire <versión> [--rmi] · prune [--retain N] [--dry-run] [--rmi]
//   ring-args [<versión>] [--service s] [--memory 2g] [--apply]
//                                deriva `ring.args` del compose VIVO con el generador de la imagen, y lo
//                                muestra contra el vigente; `--apply` lo instala con respaldo
//
// LA PROMOCIÓN VA INSTRUMENTADA POR CONSTRUCCIÓN (D10): `promote` y `rollback` se niegan sin un poller
// corriendo hace ≥ baseline_seconds y sin un CN-1 rojo-como-debe contra el anillo destino, tomado en la
// última media hora. Así «promoción verificada» deja de ser una disciplina y pasa a ser la única forma
// de promover. Lo que la herramienta no hace —editar ring.args o active.caddy a mano, tocar el lease,
// tags móviles— tampoco lo hace este verbo.

import { EXIT, fail, out, err, shq, assertToken, sleep } from './util.mjs'
import { runRemote } from './transport.mjs'
import { readRecord } from './state.mjs'
import { pollerStatus } from './poller.mjs'
import { gate, evidenceLine } from './exec.mjs'
import { pluginVersion } from './declaration.mjs'

// Lo mismo que acepta botler-rollout: una versión exacta (y su `-rN` de --redigest) o un commit exacto `sha-…`.
const VERSION_RE = /^([0-9]+\.[0-9]+\.[0-9]+(-r[0-9]+)?|sha-[A-Za-z0-9]+)$/
const CN1_MAX_AGE_MS = 30 * 60_000

const ringName = (v) => `vergis-${v.replace(/\./g, '-')}`

function cmpVer(a, b) {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

async function tool(decl, ins, args, { lines = [] } = {}) {
  const r = await runRemote(decl, ins, `if [ ! -f "$VO_TOOL" ]; then echo "NOTOOL $VO_TOOL"; exit 0; fi\nsh "$VO_TOOL" ${args}`)
  if (r.lines.some((l) => l.startsWith('NOTOOL '))) {
    fail(EXIT.NOT_RUN, `la herramienta de anillos no está en el host (${r.lines.find((l) => l.startsWith('NOTOOL ')).slice(7)}): instálala desde la imagen con \`vergis-ops exec rollout tool <versión>\` (o declara rings.tool).`)
  }
  for (const l of r.lines) lines.push(l)
  return r
}

async function registry(decl, ins) {
  const r = await tool(decl, ins, 'status --json')
  const txt = r.lines.join('\n')
  const active = /"active":\s*"([^"]*)"/.exec(txt)?.[1] ?? ''
  const previous = /"previous":\s*"([^"]*)"/.exec(txt)?.[1] ?? ''
  return { active, previous }
}

/** Las precondiciones del acto que MUEVE el tráfico. Sale con 2 nombrando lo que falta. */
async function instrumented(decl, ins, targetVersion) {
  const st = await pollerStatus(decl, ins)
  const baseline = ins.instrument?.baseline_seconds ?? 60
  if (!st.running) fail(EXIT.NOT_RUN, `no hay un poller corriendo para «${ins.id}». Un acto de anillos se MIDE: \`vergis-ops poller start\`, ${baseline} s de línea base, y \`vergis-ops poller cn1 --ring ${targetVersion}\`.`)
  const c = st.count
  const have = c && c.n ? c.now - c.first : 0
  if (!(have >= baseline)) fail(EXIT.NOT_RUN, `el poller lleva ${have.toFixed ? have.toFixed(1) : have} s de línea base y la instalación exige ${baseline} s (instrument.baseline_seconds). Sin línea base no hay intervalo que medir: espera y reintenta.`)
  if (c.ok === 0) fail(EXIT.NOT_RUN, `la línea base del poller no tiene NI UNA muestra OK: el punto de partida no está sano. No es una promoción: es un incidente.`)
  const cn = readRecord(decl.path, ins.id, 'cn1')
  const want = ringName(targetVersion)
  if (!cn || cn.ring !== want) fail(EXIT.NOT_RUN, `falta el CN-1 contra el anillo destino ${want}: \`vergis-ops poller cn1 --ring ${targetVersion}\`. Sin el rojo del control negativo, «no vi el corte» y «no puedo ver el corte» son indistinguibles.`)
  if (!cn.passed) fail(EXIT.NOT_RUN, `el último CN-1 contra ${want} NO salió rojo-como-debe (${cn.at}): el instrumento no demostró saber ver el fallo. No se promueve con él.`)
  const age = Date.now() - Date.parse(cn.at)
  if (age > CN1_MAX_AGE_MS) fail(EXIT.NOT_RUN, `el CN-1 contra ${want} tiene ${Math.round(age / 60000)} min: se exige uno de la última media hora (el instrumento se prueba antes del acto, no de memoria).`)
  return { poller: st.rec, cn1: cn, baseline: have }
}

async function tail(decl, ins, secs) {
  if (secs > 0) {
    out(`   · ${secs} s de cierre con el poller corriendo, para que los retenidos terminen…`)
    await sleep(secs * 1000)
  }
  const st = await pollerStatus(decl, ins)
  return st.count
}

function reportCut(c, since) {
  if (!c) return 'sin cuenta del poller'
  const bad = (c.mal ?? 0) + (c.sinmedir ?? 0)
  return `${c.n} muestras desde el inicio de la línea base · ${bad} fuera de predicado${c.firstbad !== null ? ` (tramo máximo ${c.maxrun.toFixed(2)} s)` : ''}${since ? ` · el acto empezó a +${since.toFixed(1)} s` : ''}`
}

async function moveTraffic(decl, ins, act, version, o) {
  const target = version
  const pre = await instrumented(decl, ins, target)
  const g = await gate(decl, ins, 'version', o)
  const flags = []
  if (o.timeout) { assertToken(o.timeout, '--timeout', /^[0-9]+$/); flags.push('--timeout', o.timeout) }
  if (o['no-schema-gate']) fail(EXIT.NOT_RUN, '--no-schema-gate no se ejerce desde el plugin: existe para instancias SIN bloque de gobierno, y esa decisión es del operador a mano, con la herramienta, gritándola en pantalla.')
  const c0 = (await pollerStatus(decl, ins)).count
  out(`== vergis-ops exec rollout ${act}${version ? ` ${version}` : ''} · ${ins.id} ==`)
  out(`   ${evidenceLine(g)}`)
  out(`   instrumento: poller ${pre.poller.id} en «${pre.poller.container}» → ${pre.poller.target} · línea base ${pre.baseline.toFixed(1)} s · CN-1 rojo-como-debe contra ${pre.cn1.ring} (${pre.cn1.at})`)
  const lines = []
  const r = await tool(decl, ins, `${act}${act === 'rollback' && !o._explicit ? '' : ` ${shq(version)}`} ${flags.join(' ')}`, { lines })
  for (const l of lines) out(`   | ${l}`)
  const c = await tail(decl, ins, Number(o.tail ?? 10))
  const since = c0 && c0.n ? c0.now - c0.first : null
  out(`   corte medido: ${reportCut(c, since)}`)
  out(`   fila para ${ins.governance?.cuts_log ?? 'el registro de cortes (sin governance.cuts_log: queda en esta salida)'}: ${new Date().toISOString()} · ${act} → ${version} · ${reportCut(c, since)} · instrumento ${pre.poller.instrument} en ${pre.poller.container} · CN-1 contra ${pre.cn1.ring}`)
  out('   detén el poller cuando cierres la medición: `vergis-ops poller stop` (da la cuenta final).')
  if (r.rc !== 0) {
    out(`⚠ botler-rollout ${act} salió ${r.rc} (exit 1): mira arriba qué paso se negó y si volvió atrás; confírmalo con \`exec rollout status\` y con el poller, no con el mensaje.`)
    return EXIT.FINDING
  }
  const bad = c ? (c.mal ?? 0) + (c.sinmedir ?? 0) : null
  out(`✓ ${act} hecho (exit 0)${bad === 0 ? ': 0 muestras fuera de predicado.' : `: ${bad} muestra(s) fuera de predicado — ESE es el corte.`}`)
  return EXIT.OK
}

export async function execRollout(decl, ins, args, o) {
  const [act, v] = args
  if (v !== undefined) assertToken(v, 'versión', VERSION_RE)
  switch (act) {
    case 'status': {
      const lines = []
      const r = await tool(decl, ins, 'status', { lines })
      for (const l of lines) out(l)
      const pv = pluginVersion()
      const reg = await registry(decl, ins)
      if (pv && reg.active && cmpVer(pv, reg.active) !== 0) out(`ℹ el plugin es ${pv} y el anillo activo corre ${reg.active}: la distancia es normal (lo posterior se lee del nodo), pero una actualización pendiente del plugin no debería pasar inadvertida.`)
      return r.rc === 0 ? EXIT.OK : EXIT.FINDING
    }
    case 'install': {
      if (!v) fail(EXIT.NOT_RUN, 'exec rollout install <versión exacta>')
      if (ins.min_version && /^[0-9]/.test(v) && cmpVer(v, ins.min_version) < 0) fail(EXIT.NOT_RUN, `${v} es menor que el piso que la instalación admite (min_version ${ins.min_version})`)
      const g = await gate(decl, ins, 'version', o)
      out(`== vergis-ops exec rollout install ${v} · ${ins.id} ==`)
      out(`   ${evidenceLine(g)}`)
      const flags = [o['no-pull'] ? '--no-pull' : '', o.redigest ? '--redigest' : ''].filter(Boolean).join(' ')
      const lines = []
      const r = await tool(decl, ins, `install ${shq(v)} ${flags}`, { lines })
      for (const l of lines) out(`   | ${l}`)
      out(r.rc === 0 ? `✓ instalado en espera (exit 0). Rollback de este paso: \`vergis-ops exec rollout retire ${v} --rmi\`.` : `⚠ install salió ${r.rc} (exit 1).`)
      return r.rc === 0 ? EXIT.OK : EXIT.FINDING
    }
    case 'promote':
      if (!v) fail(EXIT.NOT_RUN, 'exec rollout promote <versión exacta>')
      return moveTraffic(decl, ins, 'promote', v, { ...o, _explicit: true })
    case 'rollback': {
      const reg = await registry(decl, ins)
      const target = v ?? reg.previous
      if (!target) fail(EXIT.NOT_RUN, 'no hay anillo previo registrado: nombra la versión destino (exec rollout rollback <versión>)')
      return moveTraffic(decl, ins, 'rollback', target, { ...o, _explicit: !!v })
    }
    case 'retire':
    case 'prune': {
      if (act === 'retire' && !v) fail(EXIT.NOT_RUN, 'exec rollout retire <versión>')
      const dry = act === 'prune' && o['dry-run']
      const g = await gate(decl, ins, dry ? 'read' : 'version', o)
      const flags = [o.rmi ? '--rmi' : '', dry ? '--dry-run' : '', o.retain ? `--retain ${assertToken(o.retain, '--retain', /^[0-9]+$/)}` : ''].filter(Boolean).join(' ')
      out(`== vergis-ops exec rollout ${act}${v ? ` ${v}` : ''} · ${ins.id} ==`)
      out(`   ${evidenceLine(g)}`)
      const lines = []
      const r = await tool(decl, ins, `${act}${v ? ` ${shq(v)}` : ''} ${flags}`, { lines })
      for (const l of lines) out(`   | ${l}`)
      return r.rc === 0 ? EXIT.OK : EXIT.FINDING
    }
    case 'tool':
      if (!v) fail(EXIT.NOT_RUN, 'exec rollout tool <versión>')
      return installTool(decl, ins, v, o)
    case 'ring-args':
      return ringArgs(decl, ins, v, o)
    default:
      err('uso: exec rollout status|tool <v>|install <v>|promote <v>|rollback [<v>]|retire <v>|prune|ring-args [<v>] [--apply]')
      return EXIT.NOT_RUN
  }
}

// ─── D9 · la herramienta sale de la imagen, por digest ───────────────────────────────────────────
async function installTool(decl, ins, v, o) {
  const g = await gate(decl, ins, 'version', o)
  const body = String.raw`REF="$RINGS_IMAGE:${v}"
${o['no-pull'] ? '' : `$DOCKER pull -q "$REF" >/dev/null 2>&1 || { echo "PULLFAIL $REF"; exit 0; }`}
DIG=$($DOCKER image inspect --format '{{index .RepoDigests 0}}' "$REF" 2>/dev/null)
case "$DIG" in *@sha256:*) BYREF=$DIG; echo "DIGEST $DIG" ;; *) BYREF=$($DOCKER image inspect --format '{{.Id}}' "$REF" 2>/dev/null); echo "IMAGEID $BYREF" ;; esac
[ -n "$BYREF" ] || { echo "NOIMAGE $REF"; exit 0; }
LBL=$($DOCKER image inspect --format '{{index .Config.Labels "vergis.rollout.sha256"}}' "$BYREF" 2>/dev/null)
[ -n "$LBL" ] && [ "$LBL" != "<no value>" ] || { echo "NOLABEL"; exit 0; }
echo "LABEL $LBL"
C=vergis-ops-tool-$$
$DOCKER create --name "$C" "$BYREF" >/dev/null 2>&1 || { echo "NOCREATE"; exit 0; }
X=$VO_T/x; mkdir -p "$X"
for f in botler-rollout vergis-rollout ring-args-from-compose.mjs; do
  $DOCKER cp "$C:/app/deploy/rollout/$f" "$X/$f" >/dev/null 2>&1 || echo "NOCOPY $f"
done
$DOCKER rm "$C" >/dev/null 2>&1
for f in botler-rollout vergis-rollout ring-args-from-compose.mjs; do
  [ -f "$X/$f" ] && printf 'SHA %s %s\n' "$f" "$(vo_sha "$X/$f")"
done
# Instalar SOLO si el label y los tres sha coinciden (el script lo decide abajo con VO_OK).
VO_OK=1
for f in botler-rollout vergis-rollout ring-args-from-compose.mjs; do
  want=$(printf '%s' "$LBL" | tr ',' '\n' | sed -n "s/^$f=//p")
  got=$(vo_sha "$X/$f" 2>/dev/null)
  [ -n "$want" ] && [ "$want" = "$got" ] || { VO_OK=0; echo "MISMATCH $f label=$want got=$got"; }
done
[ "$VO_OK" = 1 ] || exit 0
D=$(dirname "$VO_TOOL")
TS=$(date +%s)
if [ -f "$VO_TOOL" ]; then cp -p "$VO_TOOL" "$VO_TOOL.bak-$TS" && echo "BACKUP $VO_TOOL.bak-$TS"; fi
cp "$X/botler-rollout" "$VO_TOOL" && chmod 755 "$VO_TOOL"
cp "$X/vergis-rollout" "$D/vergis-rollout" && chmod 755 "$D/vergis-rollout"
echo "INSTALLED $VO_TOOL $(vo_sha "$VO_TOOL")"`
  const r = await runRemote(decl, ins, body)
  out(`== vergis-ops exec rollout tool ${v} · ${ins.id} ==`)
  out(`   ${evidenceLine(g)}`)
  for (const l of r.lines) out(`   | ${l}`)
  const bad = r.lines.find((l) => /^(PULLFAIL|NOIMAGE|NOLABEL|NOCREATE|NOCOPY|MISMATCH)/.test(l))
  if (bad) {
    if (bad.startsWith('NOLABEL')) out('✗ la imagen no declara vergis.rollout.sha256: es anterior a que la herramienta viajara en la imagen. Para esas versiones, la herramienta se toma del repo del Producto EN SU TAG.')
    else out(`✗ no se instaló nada (${bad.split(' ')[0]}): la herramienta y el nodo tienen que ser el mismo objeto, y esto no lo pudo garantizar.`)
    return EXIT.FINDING
  }
  const inst = r.lines.find((l) => l.startsWith('INSTALLED '))
  if (!inst) fail(EXIT.MUTE, 'el host no confirmó la instalación de la herramienta')
  out(`✓ herramienta de ${v} instalada (exit 0), sha verificado contra el label de la imagen${r.lines.some((l) => l.startsWith('IMAGEID')) ? ' (imagen local sin digest de registro: se usó su Id, que también es de contenido)' : ''}. Rollback: restaurar el .bak-<ts> de arriba.`)
  return EXIT.OK
}

// ─── ring.args derivado del compose vivo, con el generador de la imagen ──────────────────────────
async function ringArgs(decl, ins, v, o) {
  if (!ins.host.compose_project || !ins.host.compose_file) fail(EXIT.NOT_RUN, 'ring-args: la instalación no declara host.compose_project y host.compose_file, y el generador los necesita para leer el compose vivo')
  const svc = o.service ?? 'vergis'
  assertToken(svc, '--service', /^[A-Za-z0-9._-]+$/)
  const g = await gate(decl, ins, o.apply ? 'version' : 'read', o)
  const body = String.raw`P=${shq(ins.host.compose_project)}; F=${shq(ins.host.compose_file)}
${v ? `IMG="$RINGS_IMAGE:${v}"` : 'IMG=$($DOCKER inspect --format "{{.Image}}" "$(vo_active_ring)" 2>/dev/null)'}
[ -n "$IMG" ] || { echo "NOIMG"; exit 0; }
PROF=""; for p in $($DOCKER compose -p "$P" -f "$F" config --profiles 2>/dev/null); do PROF="$PROF --profile $p"; done
# shellcheck disable=SC2086
$DOCKER compose -p "$P" -f "$F" $PROF config --no-env-resolution --format json > "$VO_T/compose.json" 2>"$VO_T/e" || { echo "NOCONFIG"; sed 's/^/  /' "$VO_T/e" | head -5; exit 0; }
$DOCKER run --rm -i --entrypoint node "$IMG" /app/deploy/rollout/ring-args-from-compose.mjs --host-root ${shq(ins.host.root)} --service ${shq(svc)}${o.memory ? ` --memory ${shq(assertToken(o.memory, '--memory', /^[0-9]+[kmgKMG]?$/))}` : ''} < "$VO_T/compose.json" > "$VO_T/ring.args.new" 2>"$VO_T/e" || { echo "GENFAIL"; sed 's/^/  /' "$VO_T/e" | head -5; exit 0; }
if [ -f "$RINGS_DIR/ring.args" ] && diff "$RINGS_DIR/ring.args" "$VO_T/ring.args.new" | grep -v '^[<>] # Generado:' | grep '^[<>]' > "$VO_T/d"; then
  echo "DRIFT $(wc -l < "$VO_T/d" | tr -d ' ')"; head -20 "$VO_T/d"
elif [ -f "$RINGS_DIR/ring.args" ]; then echo "NODRIFT"; else echo "NOCURRENT"; fi
${o.apply ? String.raw`TS=$(date +%s)
[ -f "$RINGS_DIR/ring.args" ] && cp -p "$RINGS_DIR/ring.args" "$RINGS_DIR/ring.args.bak-$TS" && echo "BACKUP $RINGS_DIR/ring.args.bak-$TS"
cat "$VO_T/ring.args.new" > "$RINGS_DIR/ring.args" && echo "APPLIED"` : ''}`
  const r = await runRemote(decl, ins, body)
  out(`== vergis-ops exec rollout ring-args · ${ins.id} · servicio ${svc} ==`)
  out(`   ${evidenceLine(g)}`)
  for (const l of r.lines) out(`   | ${l}`)
  const bad = r.lines.find((l) => /^(NOIMG|NOCONFIG|GENFAIL)/.test(l))
  if (bad) { out(`✗ no se pudo derivar (${bad}).`); return EXIT.FINDING }
  if (o.apply) return r.lines.includes('APPLIED') ? EXIT.OK : EXIT.MUTE
  if (r.lines.some((l) => l.startsWith('DRIFT'))) { out('⚠ HAY DRIFT (exit 1): ring.args no es lo que el compose vivo declara. Los anillos NUEVOS se crearían con otro contrato que el del compose: `--apply` lo regenera con respaldo (los anillos vivos no cambian).'); return EXIT.FINDING }
  out('✓ ring.args coincide con el compose vivo (exit 0).')
  return EXIT.OK
}
