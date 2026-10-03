// poller.mjs — `vergis-ops poller start|stop|count|cn1`: el instrumento con que se mide un corte.
//
// Un solo poller para todo el plugin: `instruments/poller.sh`, el del RUNBOOK §0.3, y su hermano
// `instruments/poller-node.mjs` para el contenedor que trae `node` y no `wget`/`sed` (#376) — misma línea,
// mismo predicado; los elige la SONDA, en el host. Vive en el borde (`RINGS_EDGE`) o en
// `instrument.container` si la instalación declara otro de vida larga. Lo que el CLI agrega es lo que la
// memoria de un operador no garantiza:
//   · el CONTROL NEGATIVO (`cn1`): el mismo poller contra un anillo en espera tiene que dar TODO
//     `MAL phase=standby` — si sale verde, el instrumento está ciego y no se promueve;
//   · la LÍNEA BASE: `exec rollout promote` se niega sin un poller corriendo hace ≥ baseline_seconds;
//   · la CUENTA se hace en el host con awk y solo viaja el resumen: un log de miles de líneas por un
//     transporte que recorta a 4 KB sería una medición a medias con cara de completa.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT, OpsExit, fail, out, shq, assertToken, worst } from './util.mjs'
import { gate, evidenceLine } from './exec.mjs'
import { resolveInstallation, PLUGIN_ROOT } from './declaration.mjs'
import { runRemote } from './transport.mjs'
import { PREDICATE_JS } from './predicate.mjs'
import { readRecord, writeRecord } from './state.mjs'

const POLLER = () => readFileSync(join(PLUGIN_ROOT, 'instruments', 'poller.sh'), 'utf8')
// El hermano node lleva el predicado del plugin antepuesto: una sola implementación, también adentro.
const POLLER_NODE = () => `${PREDICATE_JS}\n${readFileSync(join(PLUGIN_ROOT, 'instruments', 'poller-node.mjs'), 'utf8')}`
export const POLLER_VERSION = 'poller.sh (RUNBOOK §0.3, plugin vergis)'
export const POLLER_VERSIONS = { sh: POLLER_VERSION, node: 'poller-node.mjs (hermano de poller.sh, plugin vergis · #376)' }
const instrumentText = (flavor) => (flavor === 'node' ? POLLER_NODE() : POLLER())
/** El timeout por muestra, en segundos: 10 por omisión, el del instrumento de referencia (#367). */
export const DEFAULT_TIMEOUT = '10'
// Lo que `poller.sh` usa del contenedor, además de `sh` y sus builtins.
const SH_TOOLS = 'wget sed cut tr grep head date sleep cat'

/**
 * La SONDA del instrumento, en el host: ¿con qué sabor de poller puede vivir el contenedor?
 *   INSTR <ct> sh      trae sh y las herramientas de `poller.sh` (el de siempre; gana si están las dos)
 *   INSTR <ct> node    no las trae, pero trae node ≥ 18 (fetch + AbortSignal.timeout): `poller-node.mjs`
 *   NOTOOLS <ct> <faltan…>        MEDÍ y no puede vivir ahí, ni con uno ni con otro
 *   NOCT <ct> · STOPPEDCT <ct> · NODOCKER   NO PUDE sondearlo (no existe, está detenido, no hay docker)
 * La usan `check` (antes del acto, #376), `poller start` y `cn1` (en el mismo viaje que el arranque).
 */
export const PROBE_SH = String.raw`vo_instr_probe() {
  if ! command -v "$DOCKER" >/dev/null 2>&1; then echo "NODOCKER $DOCKER"; return 1; fi
  if ! $DOCKER inspect "$VO_CT" >/dev/null 2>&1; then echo "NOCT $VO_CT"; return 1; fi
  if [ "$($DOCKER inspect --format '{{.State.Running}}' "$VO_CT" 2>/dev/null)" != true ]; then echo "STOPPEDCT $VO_CT"; return 1; fi
  VO_MISS=$($DOCKER exec "$VO_CT" sh -c 'for t in ${SH_TOOLS}; do command -v $t >/dev/null 2>&1 || printf "%s " $t; done' 2>/dev/null) || VO_MISS="sh "
  if [ -z "$VO_MISS" ]; then VO_FLAVOR=sh; echo "INSTR $VO_CT sh"; return 0; fi
  if $DOCKER exec "$VO_CT" node -e 'if (typeof fetch !== "function" || !AbortSignal.timeout) process.exit(3)' >/dev/null 2>&1; then
    VO_FLAVOR=node; echo "INSTR $VO_CT node"; return 0
  fi
  echo "NOTOOLS $VO_CT $VO_MISS(y no trae node ≥ 18)"; return 1
}`

/**
 * Las operaciones sobre el contenedor del instrumento, por sabor. Las de `node` no usan NINGUNA
 * herramienta del contenedor fuera de `node`: un contenedor solo-node puede no traer ni `sh`.
 * Todas reciben rutas fijas del CLI (`/tmp/vergis-ops-…`), nunca texto de la declaración.
 */
// «vo_i_node_in» es la única con stdin (-i): una -i en las demás se tragaría el resto del script.
const NODE_IO = String.raw`vo_i_node() { $DOCKER exec "$VO_CT" node -e "$1" -- "${'$'}{2:-}"; }
vo_i_node_in() { $DOCKER exec -i "$VO_CT" node -e "$1" -- "${'$'}{2:-}"; }`
export const INSTR_SH = String.raw`${NODE_IO}
vo_i_put() { if [ "$VO_FLAVOR" = node ]; then vo_i_node_in 'require("fs").writeFileSync(process.argv[1], require("fs").readFileSync(0))' "$1"; else $DOCKER exec -i "$VO_CT" sh -c "cat > $1"; fi; }
vo_i_cat() { if [ "$VO_FLAVOR" = node ]; then vo_i_node 'process.stdout.write(require("fs").readFileSync(process.argv[1]))' "$1"; else $DOCKER exec "$VO_CT" cat "$1"; fi; }
vo_i_has() { if [ "$VO_FLAVOR" = node ]; then vo_i_node 'require("fs").accessSync(process.argv[1])' "$1" 2>/dev/null; else $DOCKER exec "$VO_CT" test -f "$1"; fi; }
vo_i_head1() { if [ "$VO_FLAVOR" = node ]; then vo_i_node 'try { process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8").split("\n")[0]) } catch {}' "$1"; else $DOCKER exec "$VO_CT" sh -c "head -1 $1 2>/dev/null"; fi; }
vo_i_rm() { if [ "$VO_FLAVOR" = node ]; then vo_i_node 'require("fs").rmSync(process.argv[1], { force: true })' "$1"; else $DOCKER exec "$VO_CT" rm -f "$1"; fi; }
vo_i_now() { if [ "$VO_FLAVOR" = node ]; then vo_i_node 'try { process.stdout.write(require("fs").readFileSync("/proc/uptime", "utf8").split(" ")[0]) } catch { process.stdout.write(require("os").uptime().toFixed(2)) }' 2>/dev/null; else $DOCKER exec "$VO_CT" cut -d' ' -f1 /proc/uptime 2>/dev/null; fi; }
vo_i_alive() { if [ "$VO_FLAVOR" = node ]; then vo_i_node 'process.kill(Number(require("fs").readFileSync(process.argv[1], "utf8")), 0)' "$1" >/dev/null 2>&1; else $DOCKER exec "$VO_CT" sh -c "kill -0 \"\$(cat $1)\" 2>/dev/null"; fi; }
vo_i_kill() { if [ "$VO_FLAVOR" = node ]; then vo_i_node 'const f = require("fs"); try { process.kill(Number(f.readFileSync(process.argv[1], "utf8"))) } catch {} f.rmSync(process.argv[1], { force: true })' "$1"; else $DOCKER exec "$VO_CT" sh -c "kill \"\$(cat $1)\" 2>/dev/null; rm -f $1"; fi; }
# La fase de un anillo por la ruta del instrumento (la espera del standby del CN-1).
vo_i_phase() { if [ "$VO_FLAVOR" = node ]; then vo_i_node 'fetch(process.argv[1], { signal: AbortSignal.timeout(2000) }).then((r) => r.text()).then((b) => { try { const p = JSON.parse(b).phase; if (typeof p === "string") process.stdout.write(p) } catch {} }, () => {})' "$1" 2>/dev/null; else $DOCKER exec "$VO_CT" wget -q -T 2 -O- "$1" 2>/dev/null | tr -d '\r\n' | sed -n 's/.*"phase"[[:space:]]*:[[:space:]]*"\([a-z-]*\)".*/\1/p'; fi; }
# El poller en segundo plano: <url> <intervalo> <timeout> <log> <pid>.
vo_i_start() { if [ "$VO_FLAVOR" = node ]; then $DOCKER exec -d "$VO_CT" node /tmp/vergis-ops-poller.mjs "$1" "$2" "$3" --log "$4" --pid "$5"; else $DOCKER exec -d "$VO_CT" sh -c "echo \$\$ > $5; exec sh /tmp/vergis-ops-poller.sh $1 $2 $3 > $4 2>&1"; fi; }
# El poller en primer plano durante <s> segundos: <url> <intervalo> <timeout> <log> <s>.
vo_i_run() { if [ "$VO_FLAVOR" = node ]; then $DOCKER exec "$VO_CT" node /tmp/vergis-ops-poller.mjs "$1" "$2" "$3" --log "$4" --for "$5"; else $DOCKER exec "$VO_CT" sh -c "sh /tmp/vergis-ops-poller.sh $1 $2 $3 > $4 2>&1 & p=\$!; sleep $5; kill \$p 2>/dev/null; wait \$p 2>/dev/null; true"; fi; }`

/** Copia el instrumento del sabor elegido al contenedor (`$VO_FLAVOR` ya resuelto en el host). */
function putInstrument() {
  return String.raw`if [ "$VO_FLAVOR" = node ]; then
vo_i_put /tmp/vergis-ops-poller.mjs <<'VO_POLLER_EOF'
${POLLER_NODE()}
VO_POLLER_EOF
else
vo_i_put /tmp/vergis-ops-poller.sh <<'VO_POLLER_EOF'
${POLLER()}
VO_POLLER_EOF
fi`
}

/** El contenedor del instrumento y su destino por omisión, resueltos EN EL HOST, y su sonda. */
function whereSh(ins, target) {
  const ct = ins.instrument?.container ? shq(ins.instrument.container) : '"$RINGS_EDGE"'
  const tgt = target ? shq(target) : `"$VO_DEFAULT_TARGET"`
  return String.raw`VO_CT=${ct}
if [ "$VO_CT" = "$RINGS_EDGE" ]; then VO_DEFAULT_TARGET=http://127.0.0.1:8079/healthz; else VO_DEFAULT_TARGET="$RINGS_EDGE_URL/healthz"; fi
VO_TARGET=${tgt}
${PROBE_SH}
${INSTR_SH}
vo_instr_probe || exit 0`
}

/** El contenedor de un poller ya registrado, con su sabor (un registro anterior a #376 es `sh`). */
function recordSh(rec) {
  return String.raw`VO_CT=${shq(rec.container)}
VO_FLAVOR=${rec.flavor === 'node' ? 'node' : 'sh'}
${INSTR_SH}`
}

/** El rechazo de la sonda, nombrado. `null` si el instrumento puede vivir ahí. */
export function probeRefusal(lines) {
  const l = lines.find((x) => /^(NOTOOLS|NOCT|STOPPEDCT|NODOCKER) /.test(x))
  if (!l) return null
  const [kind, ct, ...rest] = l.split(' ')
  if (kind === 'NOTOOLS') return { measured: true, text: `el contenedor del instrumento «${ct}» no trae ${rest.join(' ')}: ni \`poller.sh\` ni \`poller-node.mjs\` pueden vivir ahí. Declara otro de vida larga en instrument.container.` }
  if (kind === 'NOCT') return { measured: false, text: `el contenedor del instrumento «${ct}» no existe en el host: no pude sondear sus herramientas.` }
  if (kind === 'STOPPEDCT') return { measured: false, text: `el contenedor del instrumento «${ct}» está detenido: no pude sondear sus herramientas.` }
  return { measured: false, text: `no hay docker en el host («${ct}»): no pude sondear el contenedor del instrumento.` }
}

// El «ahora» se lee del reloj del CONTENEDOR (el mismo /proc/uptime con que el poller estampa cada
// muestra): el host puede no tener /proc (un Docker Desktop corre en su propia VM).
// La LATENCIA (#367): `okmaxms` es la mayor de las OK, y `over2s` cuántas OK tardaron más de 2 s — las que
// el poller con timeout de 2 s habría registrado SINMEDIR. Una línea sin `ms=` (poller anterior) no aporta.
const COUNT_AWK = String.raw`awk -v now="$(vo_i_now)" '
  { t=$1+0; c=$3; n++; if (n==1) first=t; last=t
    ms=-1; if ($NF ~ /^ms=[0-9]+$/) ms=substr($NF,4)+0
    if (c=="OK") { ok++; if (ms>okmax) { okmax=ms; okms=1 } if (ms>2000) o2++ }
    else if (c=="MAL") { mal++; if ($5=="phase=standby") stb++ } else if (c=="SINMEDIR") sm++
    if (c!="OK") { bad++; if (!fbs) { fb=t; fbs=1 } lb=t; if (nex<3) { ex[nex++]=substr($0,1,160) }
                   if (!inrun) { rs=t; inrun=1 } re=t }
    else if (inrun) { d=re-rs; if (d>maxd) maxd=d; inrun=0 }
  }
  END { if (inrun) { d=re-rs; if (d>maxd) maxd=d }
        printf "COUNT n=%d ok=%d mal=%d standby=%d sinmedir=%d first=%.2f last=%.2f now=%.2f firstbad=%s lastbad=%s maxrun=%.2f okmaxms=%s over2s=%d\n", n, ok, mal, stb, sm, first, last, now, (fbs?sprintf("%.2f",fb):"-"), (fbs?sprintf("%.2f",lb):"-"), maxd, (okms?okmax:"-"), o2
        for (i=0;i<nex;i++) print "EX " ex[i] }'`

function parseCount(lines) {
  const c = lines.find((l) => l.startsWith('COUNT '))
  if (!c) return null
  const kv = Object.fromEntries(c.slice(6).split(' ').map((p) => p.split('=')))
  const num = (k) => (kv[k] === '-' || kv[k] === undefined ? null : Number(kv[k]))
  return {
    n: num('n'), ok: num('ok'), mal: num('mal'), standby: num('standby'), sinmedir: num('sinmedir'),
    first: num('first'), last: num('last'), now: num('now'), firstbad: num('firstbad'), lastbad: num('lastbad'), maxrun: num('maxrun'), okmaxms: num('okmaxms'), over2s: num('over2s'),
    examples: lines.filter((l) => l.startsWith('EX ')).map((l) => l.slice(3)),
  }
}

/** ¿Hay un poller corriendo para esta instalación? Se pregunta al HOST, no al registro local. */
export async function pollerStatus(decl, ins) {
  const rec = readRecord(decl.path, ins.id, 'poller')
  if (!rec || rec.state !== 'running') return { running: false, rec }
  const body = String.raw`${recordSh(rec)}
if vo_i_alive ${rec.pidFile}; then echo ALIVE; else echo DEAD; fi
vo_i_cat ${rec.logFile} 2>/dev/null | ${COUNT_AWK}`
  const r = await runRemote(decl, ins, body)
  return { running: r.lines.includes('ALIVE'), rec, count: parseCount(r.lines) }
}

export async function pollerRunning(decl, ins) {
  return (await pollerStatus(decl, ins)).running
}

function report(label, c, extra = '') {
  if (!c || !c.n) return `${label}: sin muestras${extra}`
  const corte = c.firstbad === null ? '0 muestras sin OK' : `sin OK desde +${(c.firstbad - c.first).toFixed(2)} s hasta +${(c.lastbad - c.first).toFixed(2)} s (tramo continuo máximo ${c.maxrun.toFixed(2)} s)`
  const lat = c.okmaxms === null || c.okmaxms === undefined ? '' : ` · latencia OK máx ${c.okmaxms} ms${c.over2s ? ` (${c.over2s} OK sobre 2 s: retenidas, no cortadas)` : ''}`
  return `${label}: ${c.n} muestras en ${(c.last - c.first).toFixed(1)} s · OK ${c.ok} · MAL ${c.mal} (standby ${c.standby}) · SINMEDIR ${c.sinmedir} · ${corte}${lat}${extra}`
}

async function start(decl, ins, o) {
  const cur = await pollerStatus(decl, ins)
  if (cur.running) fail(EXIT.NOT_RUN, `ya hay un poller corriendo en «${cur.rec.container}» desde ${cur.rec.startedAt} (id ${cur.rec.id}). Uno por instalación: detenlo con \`poller stop\` antes de arrancar otro.`)
  const id = `p${Date.now()}`
  const iv = o.interval ?? '0.25'
  assertToken(iv, '--interval', /^[0-9]+(\.[0-9]+)?$/)
  if (o.target) assertToken(o.target, '--target', /^https?:\/\/[A-Za-z0-9._:/-]+$/)
  const to = o.timeout ?? DEFAULT_TIMEOUT
  assertToken(to, '--timeout', /^[0-9]+(\.[0-9]+)?$/)
  if (!(Number(to) >= 1 && Number(to) <= 60)) fail(EXIT.NOT_RUN, '--timeout: segundos entre 1 y 60 (10 por omisión: la sala de espera RETIENE, #367)')
  const pidFile = `/tmp/vergis-ops-poller-${id}.pid`
  const logFile = `/tmp/vergis-ops-poller-${id}.log`
  // La primera muestra puede tardar el timeout entero (un request retenido): se la espera ese tiempo + 5 s.
  const waits = Math.ceil((Number(to) + 5) * 4)
  const body = String.raw`${whereSh(ins, o.target)}
${putInstrument()}
vo_i_start "$VO_TARGET" ${iv} ${to} ${logFile} ${pidFile}
i=0; while [ $i -lt ${waits} ]; do
  if [ -n "$(vo_i_head1 ${logFile})" ]; then break; fi
  sleep 0.25; i=$((i+1))
done
printf 'WHERE %s %s %s\n' "$VO_CT" "$VO_TARGET" "$VO_FLAVOR"
printf 'FIRST %s\n' "$(vo_i_head1 ${logFile})"`
  const r = await runRemote(decl, ins, body)
  const pr = probeRefusal(r.lines)
  if (pr) fail(pr.measured ? EXIT.NOT_RUN : EXIT.PARTIAL, `poller start: ${pr.text}`)
  const where = r.lines.find((l) => l.startsWith('WHERE '))?.split(' ') ?? []
  const first = r.lines.find((l) => l.startsWith('FIRST ') && l.length > 6)
  if (!first) fail(EXIT.MUTE, `el poller no escribió su primera muestra en ${waits / 4} s en «${where[1]}»: no hay instrumento corriendo. Nada que venga después se puede medir con él.`)
  const flavor = where[3] === 'node' ? 'node' : 'sh'
  const rec = { id, state: 'running', container: where[1], target: where[2], pidFile, logFile, interval: iv, timeout: to, flavor, startedAt: new Date().toISOString(), instrument: POLLER_VERSIONS[flavor] }
  writeRecord(decl.path, ins.id, 'poller', rec)
  out(`== vergis-ops poller start · ${ins.id} ==`)
  out(`   poller ${id} en «${rec.container}» → ${rec.target} cada ${iv} s · timeout ${to} s · ${rec.instrument}`)
  out(`   primera muestra: ${first.slice(6)}`)
  out(`✓ CORRIENDO (exit 0). Línea base mínima antes de promover: ${ins.instrument?.baseline_seconds ?? 60} s. Y antes del acto, su control negativo: \`vergis-ops poller cn1 --ring <versión del anillo en espera>\`.`)
  return EXIT.OK
}

async function count(decl, ins, { stop = false } = {}) {
  const rec = readRecord(decl.path, ins.id, 'poller')
  if (!rec) fail(EXIT.NOT_RUN, 'no hay registro de un poller de esta instalación en esta máquina: arráncalo con `vergis-ops poller start`.')
  const body = String.raw`${recordSh(rec)}
${stop ? `vo_i_kill ${rec.pidFile} && echo STOPPED` : ''}
if ! vo_i_has ${rec.logFile}; then echo NOLOG; exit 0; fi
vo_i_cat ${rec.logFile} | ${COUNT_AWK}`
  const r = await runRemote(decl, ins, body)
  if (r.lines.includes('NOLOG')) fail(EXIT.MUTE, `el log del poller (${rec.logFile}) no está en «${rec.container}»: ¿se recreó el contenedor del instrumento? La medición no existe.`)
  const c = parseCount(r.lines)
  if (!c) fail(EXIT.MUTE, 'el host no devolvió la cuenta del poller.')
  if (stop) writeRecord(decl.path, ins.id, 'poller', { ...rec, state: 'stopped', stoppedAt: new Date().toISOString(), final: c })
  out(`== vergis-ops poller ${stop ? 'stop' : 'count'} · ${ins.id} · ${rec.id} en «${rec.container}» → ${rec.target} ==`)
  out(`   ${report('medición', c)}`)
  for (const e of c.examples) out(`   | ${e}`)
  out(`   instrumento: ${rec.instrument} · intervalo ${rec.interval} s · timeout ${rec.timeout ?? '2'} s`)
  const mal = c.mal ?? 0
  const sm = c.sinmedir ?? 0
  if (!c.n) { out('✗ NO PUDE MEDIR (exit 5): el log está vacío.'); return EXIT.MUTE }
  if (c.sinmedir) out(`⚠ ${c.sinmedir} muestra(s) SINMEDIR: en ese tramo el instrumento no obtuvo respuesta — se cuentan aparte, no como verde.`)
  const cuts = ins.governance?.cuts_log
  out(`   fila para ${cuts ?? 'el registro de cortes (la instalación no declara governance.cuts_log: no hay dónde registrarla — la fila queda en esta salida)'}: ` +
    `${new Date().toISOString().slice(0, 10)} · ${c.n} muestras · ${mal} fuera de predicado · ${sm} sin medir · tramo máximo sin OK ${c.maxrun.toFixed(2)} s · latencia OK máx ${c.okmaxms ?? '-'} ms · instrumento ${rec.instrument} (timeout ${rec.timeout ?? '2'} s) en ${rec.container} · CN-1 ${cn1Line(decl, ins)}`)
  if (mal + sm === 0) { out(`✓ MEDÍ (exit 0): 0 muestras fuera de predicado en ${c.n}.`); return EXIT.OK }
  if (sm) {
    // El exit es 7, y el texto lo dice: «medí a medias» no es «medí un corte». Un SINMEDIR es una
    // muestra sin respuesta HTTP en el timeout: la fila lo cuenta aparte, como «sin medir» (#367).
    const short = Number(rec.timeout ?? 2) < 10 ? ` — con timeout de ${rec.timeout ?? '2'} s, compatible con una retención de la sala de espera (#367)` : ''
    out(`⚠ MEDÍ A MEDIAS (exit 7): ${mal} muestra(s) MAL — ESE es el corte, no la duración del comando — y ${sm} SINMEDIR, que en la fila van como «sin medir», no como corte${short}.`)
    return EXIT.PARTIAL
  }
  out(`⚠ MEDÍ (exit 1): ${mal} muestra(s) fuera de predicado — ESE es el corte, no la duración del comando.`)
  return EXIT.FINDING
}

function cn1Line(decl, ins) {
  const cn = readRecord(decl.path, ins.id, 'cn1')
  if (!cn) return 'no corrido'
  return `${cn.passed ? 'rojo-como-debe' : 'FALLÓ'} contra ${cn.ring} (${cn.at})`
}

/**
 * Control negativo del instrumento: el poller contra un anillo EN ESPERA debe dar todo MAL phase=standby.
 *
 * El anillo destino puede estar RETENIDO (detenido): es el caso del rollback a un anillo frío, la maniobra
 * de emergencia. Contra un contenedor detenido no hay control negativo posible —el poller no obtiene
 * respuesta y cuenta SINMEDIR—, y `promote`/`rollback` exigen el CN-1 ANTES de invocar a la herramienta,
 * que es quien lo habría arrancado en su pre-flight. Así que el arranque es de este verbo: un retenido se
 * arranca (acto de clase `version`, con su gate, el mismo que `install`, que también deja un anillo en
 * espera) y se espera a que declare `phase=standby` por la MISMA ruta que se va a medir. Queda caliente:
 * es el candidato del acto que sigue. Si el operador NO sigue con el acto, lo devuelve a retenido él
 * (`exec run --class version -- 'docker stop <anillo>'`); la próxima promoción también lo haría, pero no
 * se puede prometer que haya una.
 *
 * Si el retenido que ESTE verbo arrancó no llega a standby, lo vuelve a detener en el mismo viaje: un
 * tercer anillo vivo es un aspirante más al lease, una carrera cuyo ganador nadie eligió (la misma razón
 * por la que la herramienta deja CALIENTES = 2 al cerrar una promoción). Un anillo que ya estaba corriendo
 * no se toca: no lo arrancó este verbo.
 */
export async function cn1(decl, ins, o) {
  const ringArg = o.ring ?? o._[1]
  if (!ringArg) fail(EXIT.NOT_RUN, 'cn1: nombra el anillo en espera con --ring <versión> (o <contenedor>). Es el que vas a promover.')
  assertToken(ringArg, '--ring', /^[A-Za-z0-9._-]+$/)
  const secs = Number(o.seconds ?? 20)
  if (!Number.isFinite(secs) || secs < 5 || secs > 600) fail(EXIT.NOT_RUN, '--seconds entre 5 y 600')
  const standbyWait = Number(o['standby-timeout'] ?? 90)
  if (!Number.isInteger(standbyWait) || standbyWait < 1 || standbyWait > 600) fail(EXIT.NOT_RUN, '--standby-timeout: segundos enteros entre 1 y 600')
  // El gate del arranque se evalúa ANTES del viaje (la clase `version` no mide nada en el host): si falta
  // su evidencia, el cuerpo remoto no arranca nada y el CLI lo dice después, sin un segundo viaje.
  let startGate = null
  let startRefusal = null
  try { startGate = await gate(decl, ins, 'version', o) } catch (e) { if (e instanceof OpsExit) startRefusal = e; else throw e }
  const body = String.raw`${whereSh(ins, null)}
VO_RING=${shq(ringArg)}
case "$VO_RING" in vergis-*) : ;; *) VO_RING=$(vo_ring_name "$VO_RING") ;; esac
if ! $DOCKER inspect "$VO_RING" >/dev/null 2>&1; then echo "NORING $VO_RING"; exit 0; fi
VO_ACT=$(vo_active_ring || true)
if [ "$VO_ACT" = "$VO_RING" ]; then echo "ISACTIVE $VO_RING"; exit 0; fi
VO_STARTED=0
if [ "$($DOCKER inspect --format '{{.State.Running}}' "$VO_RING" 2>/dev/null)" != true ]; then
  ${startGate ? String.raw`$DOCKER start "$VO_RING" >/dev/null 2>&1 || { echo "STARTFAIL $VO_RING"; exit 0; }
  VO_STARTED=1; echo "STARTED $VO_RING"` : String.raw`echo "STOPPED $VO_RING"; exit 0`}
fi
# La fase, por la MISMA ruta que va a medir el control (el contenedor del instrumento → el anillo).
i=0; VO_PH=
while [ $i -lt ${standbyWait} ]; do
  VO_PH=$(vo_i_phase "http://$VO_RING:8080/healthz")
  [ "$VO_PH" = standby ] && break
  i=$((i+1)); sleep 1
done
if [ "$VO_PH" != standby ]; then
  echo "NOTSTANDBY $VO_RING ${'$'}{VO_PH:-sin-respuesta} $i"
  # Lo arrancó este verbo y no sirve de candidato: vuelve a retenido, no queda compitiendo por el lease.
  if [ "$VO_STARTED" = 1 ]; then
    if $DOCKER stop "$VO_RING" >/dev/null 2>&1; then echo "RESTOPPED $VO_RING"; else echo "RESTOPFAIL $VO_RING"; fi
  fi
  exit 0
fi
echo "STANDBY $VO_RING $i"
${putInstrument()}
L=/tmp/vergis-ops-cn1-$$.log
vo_i_run "http://$VO_RING:8080/healthz" 0.25 ${DEFAULT_TIMEOUT} "$L" ${secs}
printf 'WHERE %s %s %s\n' "$VO_CT" "$VO_RING" "$VO_FLAVOR"
vo_i_cat "$L" | ${COUNT_AWK}
vo_i_rm "$L"`
  const r = await runRemote(decl, ins, body)
  const nr = r.lines.find((l) => l.startsWith('NORING '))
  if (nr) fail(EXIT.NOT_RUN, `cn1: no existe el anillo «${nr.slice(7)}» en el host.`)
  const ia = r.lines.find((l) => l.startsWith('ISACTIVE '))
  if (ia) fail(EXIT.NOT_RUN, `cn1: «${ia.slice(9)}» es el anillo ACTIVO. El control negativo se corre contra uno EN ESPERA: contra el activo daría verde y no probaría nada.`)
  const pr = probeRefusal(r.lines)
  if (pr) fail(pr.measured ? EXIT.NOT_RUN : EXIT.PARTIAL, `cn1: ${pr.text}`)
  const stopped = r.lines.find((l) => l.startsWith('STOPPED '))
  if (stopped) fail(EXIT.NOT_RUN, `cn1: «${stopped.slice(8)}» está RETENIDO (detenido), y contra un contenedor detenido no hay control negativo. Arrancarlo es un acto de clase «version» y su gate no se cumplió: ${startRefusal?.message ?? 'sin evidencia'}. Nada se arrancó.`)
  const sf = r.lines.find((l) => l.startsWith('STARTFAIL '))
  if (sf) fail(EXIT.FINDING, `cn1: \`docker start ${sf.slice(10)}\` falló: el anillo retenido no arranca. Tampoco se podría promover; el previo caliente sigue siendo la red.`)
  const started = r.lines.find((l) => l.startsWith('STARTED '))
  const ns = r.lines.find((l) => l.startsWith('NOTSTANDBY '))
  if (ns) {
    const [, ring, ph, waited] = ns.split(' ')
    writeRecord(decl.path, ins.id, 'cn1', { ring, passed: false, at: new Date().toISOString(), notStandby: ph })
    out(`== vergis-ops poller cn1 · ${ins.id} · → ${ring} ==`)
    if (started) out(`   ${ring} estaba retenido: lo arranqué (${evidenceLine(startGate)}).`)
    if (r.lines.some((l) => l.startsWith('RESTOPPED '))) out(`   y lo volví a detener (\`docker stop ${ring}\`): queda RETENIDO como estaba — un tercer anillo vivo sería un aspirante más al lease.`)
    if (r.lines.some((l) => l.startsWith('RESTOPFAIL '))) out(`   ⚠ \`docker stop ${ring}\` FALLÓ: el anillo que arranqué sigue vivo y compite por el lease. Detenlo: \`vergis-ops exec run --class version -- 'docker stop ${ring}'\`, y confirma con \`vergis-ops exec rollout status\`.`)
    out(`✗ CN-1 NO CORRIÓ (exit 1): ${ring} no declaró phase=standby en ${waited} s (última fase vista: ${ph}). Sin un standby no hay rojo que exigirle al instrumento — y la herramienta tampoco lo promovería.`)
    return EXIT.FINDING
  }
  const where = r.lines.find((l) => l.startsWith('WHERE '))?.split(' ') ?? []
  const c = parseCount(r.lines)
  if (!c) fail(EXIT.MUTE, 'cn1: el host no devolvió la cuenta.')
  let code
  let verdict
  if (!c.n) { code = EXIT.MUTE; verdict = '✗ NO PUDE MEDIR (exit 5): el poller no dejó muestras.' }
  else if (c.ok > 0) { code = EXIT.FINDING; verdict = `✗ EL INSTRUMENTO ESTÁ CIEGO (exit 1): ${c.ok} muestra(s) OK contra un anillo en espera. Un poller que ve sano a un standby no puede ver un corte: no se promueve con él.` }
  else if (c.sinmedir > 0) { code = EXIT.PARTIAL; verdict = `⚠ MEDÍ A MEDIAS (exit 7): ${c.sinmedir} muestra(s) SINMEDIR — el control no se da por pasado.` }
  else if (c.standby !== c.n) { code = EXIT.FINDING; verdict = `✗ CN-1 NO CONCLUYENTE (exit 1): ${c.n - c.standby} muestra(s) MAL con otra fase que standby. ¿El anillo está en espera?` }
  else { code = EXIT.OK; verdict = `✓ CN-1 ROJO-COMO-DEBE (exit 0): ${c.n}/${c.n} muestras MAL phase=standby. El instrumento sabe ver el fallo.` }
  const instrument = POLLER_VERSIONS[where[3] === 'node' ? 'node' : 'sh']
  writeRecord(decl.path, ins.id, 'cn1', { ring: where[2], container: where[1], passed: code === EXIT.OK, at: new Date().toISOString(), count: c, instrument })
  out(`== vergis-ops poller cn1 · ${ins.id} · ${where[1]} → ${where[2]} (${secs} s · ${instrument}) ==`)
  if (started) {
    const sb = r.lines.find((l) => l.startsWith('STANDBY '))?.split(' ')[2]
    out(`   ${where[2]} estaba RETENIDO (detenido): lo arranqué y declaró phase=standby a los ${sb ?? '?'} s · ${evidenceLine(startGate)}`)
    out('   queda caliente: es el candidato del acto que sigue (la herramienta lo habría arrancado igual en su pre-flight).')
    out(`   si NO sigues con el acto, devuélvelo a retenido: \`vergis-ops exec run --class version -- 'docker stop ${where[2]}'\` — vivo, es un aspirante más al lease.`)
  }
  out(`   ${report('control negativo', c)}`)
  for (const e of c.examples) out(`   | ${e}`)
  out(verdict)
  return code
}

export async function runPoller(common, o) {
  const [act] = o._
  const { decl, ins } = resolveInstallation(common)
  if (act === 'start') return start(decl, ins, o)
  if (act === 'count') return count(decl, ins)
  if (act === 'stop') return count(decl, ins, { stop: true })
  if (act === 'cn1') return cn1(decl, ins, o)
  if (act === 'status') {
    const s = await pollerStatus(decl, ins)
    out(s.running ? `corriendo: ${s.rec.id} en «${s.rec.container}» desde ${s.rec.startedAt} · ${report('hasta ahora', s.count)}` : 'no hay poller corriendo para esta instalación')
    return EXIT.OK
  }
  fail(EXIT.NOT_RUN, 'uso: vergis-ops poller start [--target <url>] [--interval s] [--timeout s] · count · stop · status · cn1 --ring <versión> [--seconds n] [--standby-timeout s] [--approval|--window|--impact …]')
  return worst([])
}
