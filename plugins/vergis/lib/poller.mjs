// poller.mjs — `vergis-ops poller start|stop|count|cn1`: el instrumento con que se mide un corte.
//
// Un solo poller para todo el plugin: `instruments/poller.sh`, el del RUNBOOK §0.3. Vive en el borde
// (`RINGS_EDGE`) o en `instrument.container` si la instalación declara otro de vida larga. Lo que el
// CLI agrega es lo que la memoria de un operador no garantiza:
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
import { readRecord, writeRecord } from './state.mjs'

const POLLER = () => readFileSync(join(PLUGIN_ROOT, 'instruments', 'poller.sh'), 'utf8')
export const POLLER_VERSION = 'poller.sh (RUNBOOK §0.3, plugin vergis)'

/** El contenedor del instrumento y su destino por omisión, resueltos EN EL HOST. */
function whereSh(ins, target) {
  const ct = ins.instrument?.container ? shq(ins.instrument.container) : '"$RINGS_EDGE"'
  const tgt = target ? shq(target) : `"$VO_DEFAULT_TARGET"`
  return String.raw`VO_CT=${ct}
if [ "$VO_CT" = "$RINGS_EDGE" ]; then VO_DEFAULT_TARGET=http://127.0.0.1:8079/healthz; else VO_DEFAULT_TARGET="$RINGS_EDGE_URL/healthz"; fi
VO_TARGET=${tgt}
if ! $DOCKER exec "$VO_CT" sh -c 'command -v wget >/dev/null && command -v sed >/dev/null' >/dev/null 2>&1; then
  echo "NOTOOLS $VO_CT"; exit 0
fi`
}

// El «ahora» se lee del reloj del CONTENEDOR (el mismo /proc/uptime con que el poller estampa cada
// muestra): el host puede no tener /proc (un Docker Desktop corre en su propia VM).
const COUNT_AWK = String.raw`awk -v now="$($DOCKER exec "$VO_CT" cut -d' ' -f1 /proc/uptime 2>/dev/null)" '
  { t=$1+0; c=$3; n++; if (n==1) first=t; last=t
    if (c=="OK") ok++; else if (c=="MAL") { mal++; if ($5=="phase=standby") stb++ } else if (c=="SINMEDIR") sm++
    if (c!="OK") { bad++; if (!fbs) { fb=t; fbs=1 } lb=t; if (nex<3) { ex[nex++]=substr($0,1,160) }
                   if (!inrun) { rs=t; inrun=1 } re=t }
    else if (inrun) { d=re-rs; if (d>maxd) maxd=d; inrun=0 }
  }
  END { if (inrun) { d=re-rs; if (d>maxd) maxd=d }
        printf "COUNT n=%d ok=%d mal=%d standby=%d sinmedir=%d first=%.2f last=%.2f now=%.2f firstbad=%s lastbad=%s maxrun=%.2f\n", n, ok, mal, stb, sm, first, last, now, (fbs?sprintf("%.2f",fb):"-"), (fbs?sprintf("%.2f",lb):"-"), maxd
        for (i=0;i<nex;i++) print "EX " ex[i] }'`

function parseCount(lines) {
  const c = lines.find((l) => l.startsWith('COUNT '))
  if (!c) return null
  const kv = Object.fromEntries(c.slice(6).split(' ').map((p) => p.split('=')))
  const num = (k) => (kv[k] === '-' || kv[k] === undefined ? null : Number(kv[k]))
  return {
    n: num('n'), ok: num('ok'), mal: num('mal'), standby: num('standby'), sinmedir: num('sinmedir'),
    first: num('first'), last: num('last'), now: num('now'), firstbad: num('firstbad'), lastbad: num('lastbad'), maxrun: num('maxrun'),
    examples: lines.filter((l) => l.startsWith('EX ')).map((l) => l.slice(3)),
  }
}

/** ¿Hay un poller corriendo para esta instalación? Se pregunta al HOST, no al registro local. */
export async function pollerStatus(decl, ins) {
  const rec = readRecord(decl.path, ins.id, 'poller')
  if (!rec || rec.state !== 'running') return { running: false, rec }
  const body = String.raw`VO_CT=${shq(rec.container)}
if $DOCKER exec "$VO_CT" sh -c 'kill -0 "$(cat ${rec.pidFile})" 2>/dev/null'; then echo ALIVE; else echo DEAD; fi
$DOCKER exec "$VO_CT" cat ${rec.logFile} 2>/dev/null | ${COUNT_AWK}`
  const r = await runRemote(decl, ins, body)
  return { running: r.lines.includes('ALIVE'), rec, count: parseCount(r.lines) }
}

export async function pollerRunning(decl, ins) {
  return (await pollerStatus(decl, ins)).running
}

function report(label, c, extra = '') {
  if (!c || !c.n) return `${label}: sin muestras${extra}`
  const corte = c.firstbad === null ? '0 muestras fuera de predicado' : `fuera de predicado desde +${(c.firstbad - c.first).toFixed(2)} s hasta +${(c.lastbad - c.first).toFixed(2)} s (tramo continuo máximo ${c.maxrun.toFixed(2)} s)`
  return `${label}: ${c.n} muestras en ${(c.last - c.first).toFixed(1)} s · OK ${c.ok} · MAL ${c.mal} (standby ${c.standby}) · SINMEDIR ${c.sinmedir} · ${corte}${extra}`
}

async function start(decl, ins, o) {
  const cur = await pollerStatus(decl, ins)
  if (cur.running) fail(EXIT.NOT_RUN, `ya hay un poller corriendo en «${cur.rec.container}» desde ${cur.rec.startedAt} (id ${cur.rec.id}). Uno por instalación: detenlo con \`poller stop\` antes de arrancar otro.`)
  const id = `p${Date.now()}`
  const iv = o.interval ?? '0.25'
  assertToken(iv, '--interval', /^[0-9]+(\.[0-9]+)?$/)
  if (o.target) assertToken(o.target, '--target', /^https?:\/\/[A-Za-z0-9._:/-]+$/)
  const pidFile = `/tmp/vergis-ops-poller-${id}.pid`
  const logFile = `/tmp/vergis-ops-poller-${id}.log`
  const body = String.raw`${whereSh(ins, o.target)}
$DOCKER exec -i "$VO_CT" sh -c 'cat > /tmp/vergis-ops-poller.sh' <<'VO_POLLER_EOF'
${POLLER()}
VO_POLLER_EOF
$DOCKER exec -d "$VO_CT" sh -c "echo \$\$ > ${pidFile}; exec sh /tmp/vergis-ops-poller.sh $VO_TARGET ${iv} > ${logFile} 2>&1"
i=0; while [ $i -lt 20 ]; do
  if [ -n "$($DOCKER exec "$VO_CT" sh -c 'head -1 ${logFile} 2>/dev/null')" ]; then break; fi
  sleep 0.25; i=$((i+1))
done
printf 'WHERE %s %s\n' "$VO_CT" "$VO_TARGET"
$DOCKER exec "$VO_CT" sh -c 'head -1 ${logFile} 2>/dev/null' | sed 's/^/FIRST /'`
  const r = await runRemote(decl, ins, body)
  const nt = r.lines.find((l) => l.startsWith('NOTOOLS '))
  if (nt) fail(EXIT.NOT_RUN, `el contenedor del instrumento «${nt.slice(8)}» no trae wget y sed: el poller del RUNBOOK no puede vivir ahí. Declara otro de vida larga en instrument.container.`)
  const where = r.lines.find((l) => l.startsWith('WHERE '))?.split(' ') ?? []
  const first = r.lines.find((l) => l.startsWith('FIRST '))
  if (!first) fail(EXIT.MUTE, `el poller no escribió su primera muestra en 5 s en «${where[1]}»: no hay instrumento corriendo. Nada que venga después se puede medir con él.`)
  const rec = { id, state: 'running', container: where[1], target: where[2], pidFile, logFile, interval: iv, startedAt: new Date().toISOString(), instrument: POLLER_VERSION }
  writeRecord(decl.path, ins.id, 'poller', rec)
  out(`== vergis-ops poller start · ${ins.id} ==`)
  out(`   poller ${id} en «${rec.container}» → ${rec.target} cada ${iv} s`)
  out(`   primera muestra: ${first.slice(6)}`)
  out(`✓ CORRIENDO (exit 0). Línea base mínima antes de promover: ${ins.instrument?.baseline_seconds ?? 60} s. Y antes del acto, su control negativo: \`vergis-ops poller cn1 --ring <versión del anillo en espera>\`.`)
  return EXIT.OK
}

async function count(decl, ins, { stop = false } = {}) {
  const rec = readRecord(decl.path, ins.id, 'poller')
  if (!rec) fail(EXIT.NOT_RUN, 'no hay registro de un poller de esta instalación en esta máquina: arráncalo con `vergis-ops poller start`.')
  const body = String.raw`VO_CT=${shq(rec.container)}
${stop ? `$DOCKER exec "$VO_CT" sh -c 'kill "$(cat ${rec.pidFile})" 2>/dev/null; rm -f ${rec.pidFile}' && echo STOPPED` : ''}
if ! $DOCKER exec "$VO_CT" test -f ${rec.logFile}; then echo NOLOG; exit 0; fi
$DOCKER exec "$VO_CT" cat ${rec.logFile} | ${COUNT_AWK}`
  const r = await runRemote(decl, ins, body)
  if (r.lines.includes('NOLOG')) fail(EXIT.MUTE, `el log del poller (${rec.logFile}) no está en «${rec.container}»: ¿se recreó el contenedor del instrumento? La medición no existe.`)
  const c = parseCount(r.lines)
  if (!c) fail(EXIT.MUTE, 'el host no devolvió la cuenta del poller.')
  if (stop) writeRecord(decl.path, ins.id, 'poller', { ...rec, state: 'stopped', stoppedAt: new Date().toISOString(), final: c })
  out(`== vergis-ops poller ${stop ? 'stop' : 'count'} · ${ins.id} · ${rec.id} en «${rec.container}» → ${rec.target} ==`)
  out(`   ${report('medición', c)}`)
  for (const e of c.examples) out(`   | ${e}`)
  out(`   instrumento: ${rec.instrument} · intervalo ${rec.interval} s`)
  const bad = (c.mal ?? 0) + (c.sinmedir ?? 0)
  if (!c.n) { out('✗ NO PUDE MEDIR (exit 5): el log está vacío.'); return EXIT.MUTE }
  if (c.sinmedir) out(`⚠ ${c.sinmedir} muestra(s) SINMEDIR: en ese tramo el instrumento no obtuvo respuesta — se cuentan aparte, no como verde.`)
  const cuts = ins.governance?.cuts_log
  out(`   fila para ${cuts ?? 'el registro de cortes (la instalación no declara governance.cuts_log: no hay dónde registrarla — la fila queda en esta salida)'}: ` +
    `${new Date().toISOString().slice(0, 10)} · ${c.n} muestras · ${bad} fuera de predicado · tramo máximo ${c.maxrun.toFixed(2)} s · instrumento ${rec.instrument} en ${rec.container} · CN-1 ${cn1Line(decl, ins)}`)
  if (bad === 0) { out(`✓ MEDÍ (exit 0): 0 muestras fuera de predicado en ${c.n}.`); return EXIT.OK }
  out(`⚠ MEDÍ (exit 1): ${bad} muestra(s) fuera de predicado — ESE es el corte, no la duración del comando.`)
  return c.sinmedir ? EXIT.PARTIAL : EXIT.FINDING
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
  VO_PH=$($DOCKER exec "$VO_CT" wget -q -T 2 -O- "http://$VO_RING:8080/healthz" 2>/dev/null | tr -d '\r\n' | sed -n 's/.*"phase"[[:space:]]*:[[:space:]]*"\([a-z-]*\)".*/\1/p')
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
$DOCKER exec -i "$VO_CT" sh -c 'cat > /tmp/vergis-ops-poller.sh' <<'VO_POLLER_EOF'
${POLLER()}
VO_POLLER_EOF
L=/tmp/vergis-ops-cn1-$$.log
$DOCKER exec "$VO_CT" sh -c "sh /tmp/vergis-ops-poller.sh http://$VO_RING:8080/healthz 0.25 > $L 2>&1 & p=\$!; sleep ${secs}; kill \$p 2>/dev/null; wait \$p 2>/dev/null; true"
printf 'WHERE %s %s\n' "$VO_CT" "$VO_RING"
$DOCKER exec "$VO_CT" cat "$L" | ${COUNT_AWK}
$DOCKER exec "$VO_CT" rm -f "$L"`
  const r = await runRemote(decl, ins, body)
  const nr = r.lines.find((l) => l.startsWith('NORING '))
  if (nr) fail(EXIT.NOT_RUN, `cn1: no existe el anillo «${nr.slice(7)}» en el host.`)
  const ia = r.lines.find((l) => l.startsWith('ISACTIVE '))
  if (ia) fail(EXIT.NOT_RUN, `cn1: «${ia.slice(9)}» es el anillo ACTIVO. El control negativo se corre contra uno EN ESPERA: contra el activo daría verde y no probaría nada.`)
  const nt = r.lines.find((l) => l.startsWith('NOTOOLS '))
  if (nt) fail(EXIT.NOT_RUN, `el contenedor del instrumento «${nt.slice(8)}» no trae wget y sed.`)
  const stopped = r.lines.find((l) => l.startsWith('STOPPED '))
  if (stopped) fail(EXIT.NOT_RUN, `cn1: «${stopped.slice(8)}» está RETENIDO (detenido), y contra un contenedor detenido no hay control negativo. Arrancarlo es un acto de clase «version» y su gate no se cumplió: ${startRefusal?.message ?? 'sin evidencia'}. Nada se arrancó.`)
  const sf = r.lines.find((l) => l.startsWith('STARTFAIL '))
  if (sf) fail(EXIT.FINDING, `cn1: \`docker start ${sf.slice(10)}\` falló: el anillo retenido no arranca. Tampoco se podría promover; el previo caliente sigue siendo la red.`)
  const started = r.lines.find((l) => l.startsWith('STARTED '))
  const ns = r.lines.find((l) => l.startsWith('NOTSTANDBY '))
  if (ns) {
    const [, ring, ph, waited] = ns.split(' ')
    writeRecord(decl.path, ins.id, 'cn1', { ring, passed: false, at: new Date().toISOString(), notStandby: ph, instrument: POLLER_VERSION })
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
  writeRecord(decl.path, ins.id, 'cn1', { ring: where[2], container: where[1], passed: code === EXIT.OK, at: new Date().toISOString(), count: c, instrument: POLLER_VERSION })
  out(`== vergis-ops poller cn1 · ${ins.id} · ${where[1]} → ${where[2]} (${secs} s) ==`)
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
  fail(EXIT.NOT_RUN, 'uso: vergis-ops poller start [--target <url>] [--interval s] · count · stop · status · cn1 --ring <versión> [--seconds n] [--standby-timeout s] [--approval|--window|--impact …]')
  return worst([])
}
