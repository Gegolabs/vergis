// publish.mjs — `vergis-ops publish <archivo del espejo>`: publicar un archivo en el host de la
// instalación, con la red puesta por el ejecutor.
//
//   1. clasifica el acto contra el contrato VIVO (content · boot · service · service-interrupting)
//   2. aplica el gate de esa clase (y exige la evidencia del pre-test si la instalación lo declara)
//   3. respalda el archivo remoto (`<ruta>.bak-<ts>`)
//   4. escribe EN SITIO: conserva inodo, dueño y modo del archivo reemplazado — un montaje de ARCHIVO
//      en Docker sigue el inodo, y reemplazarlo deja al contenedor viendo lo viejo (RUNBOOK §0.5)
//   5. verifica que el sha remoto sea el local
//   6. si es contenido: espera a que el NODO lo tome (sha cargado == local, pending=false). Es la
//      medición de que el despliegue quedó desplegado — no «el archivo está ahí», sino «el nodo lo cargó»
//   7. deja escrito el rollback exacto
//
// Lo que no publica: estado del rollout (`active.caddy`, `ring.args`, `rings.json`, el lease), ni
// AppleDouble `._*`, ni nada que no esté declarado en el espejo (espejo primero).

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { EXIT, fail, out, sha256File, shq } from './util.mjs'
import { resolveInstallation, localPath } from './declaration.mjs'
import { runRemote } from './transport.mjs'
import { classifyFile, waitTaken } from './contract.mjs'
import { RINGS_STATE } from './classify.mjs'
import { gate, evidenceLine } from './exec.mjs'

const MAX_BYTES = 70_000 // en base64 cabe en el presupuesto de run-command (100 KB) con su marco

export async function runPublish(common, o) {
  const { decl, ins } = resolveInstallation(common)
  const arg = o._[0]
  if (!arg) fail(EXIT.NOT_RUN, 'publish <archivo del espejo> [--pretest "<evidencia>"] [--window …] [--impact …] [--approval …]')
  const file = localPath({ dir: common.cwd }, arg)
  if (!existsSync(file) || !statSync(file).isFile()) fail(EXIT.NOT_RUN, `no existe el archivo «${file}»`)
  const name = basename(file)
  if (name.startsWith('._')) fail(EXIT.NOT_RUN, `«${name}» es metadata de macOS (AppleDouble): no se publica`)
  if (RINGS_STATE.has(name)) fail(EXIT.NOT_RUN, `«${name}» es estado del rollout, no un artefacto: lo escribe la herramienta de anillos, jamás un publish`)
  const size = statSync(file).size
  if (ins.transport.kind === 'az-run-command' && size > MAX_BYTES) fail(EXIT.NOT_RUN, `«${name}» pesa ${size} B: por run-command no caben más de ${MAX_BYTES} B sin que el canal lo descarte en silencio`)

  const c = await classifyFile(decl, ins, file)
  const g = await gate(decl, ins, c.cls, o)
  if (c.cls === 'content' && ins.governance?.pretest && !o.pretest) {
    fail(EXIT.NOT_RUN, `la instalación exige un pre-test antes de publicar contenido: «${ins.governance.pretest}». Pasa su evidencia con --pretest "<qué corriste y qué dio>".`)
  }
  const local = sha256File(file)
  const ts = Math.floor(Date.now() / 1000)
  const target = c.hostPath
  const body = String.raw`T=${shq(target)}
D=$(dirname "$T")
[ -d "$D" ] || { echo "NODIR $D"; exit 0; }
printf '%s' ${shq(readFileSync(file).toString('base64'))} | base64 -d > "$VO_T/nuevo" 2>/dev/null || { echo "DECODEFAIL"; exit 0; }
if [ -f "$T" ]; then
  cp -p "$T" "$T.bak-${ts}" || { echo "BACKUPFAIL"; exit 0; }
  echo "BACKUP $T.bak-${ts}"
  cat "$VO_T/nuevo" > "$T" || { echo "WRITEFAIL"; exit 0; }
else
  cp "$VO_T/nuevo" "$T" || { echo "WRITEFAIL"; exit 0; }
  OWN=$(stat -c %u:%g "$D" 2>/dev/null || stat -f %u:%g "$D" 2>/dev/null)
  [ -n "$OWN" ] && chown "$OWN" "$T" 2>/dev/null
  echo "NEW"
fi
printf 'SHA %s\n' "$(vo_sha "$T")"`
  out(`== vergis-ops publish · ${ins.id} ==`)
  out(`   ${c.local} → ${target}${c.containerPath ? ` (en el nodo: ${c.containerPath})` : ''}`)
  out(`   clase: ${c.cls} — ${c.why}`)
  if (c.contractError) out(`   ⚠ ${c.contractError}`)
  out(`   ${evidenceLine(g)}`)
  if (o.pretest) out(`   pre-test declarado: ${o.pretest}`)
  const r = await runRemote(decl, ins, body)
  const bad = r.lines.find((l) => /^(NODIR|DECODEFAIL|BACKUPFAIL|WRITEFAIL)/.test(l))
  if (bad) { out(`✗ no se publicó (${bad}). El host no cambió${bad === 'WRITEFAIL' ? ' — salvo que la escritura haya quedado a medias: verifícalo con `parity`' : ''}.`); return EXIT.FINDING }
  const isNew = r.lines.includes('NEW')
  const remote = r.lines.find((l) => l.startsWith('SHA '))?.slice(4)
  const rollback = isNew
    ? `vergis-ops exec run --class ${c.cls} -- 'rm -f ${target}'`
    : `vergis-ops exec run --class ${c.cls} -- 'cat ${target}.bak-${ts} > ${target}'`
  out(`   rollback: ${rollback}`)
  if (remote !== local) {
    out(`✗ HALLAZGO (exit 1): el sha en el host (${remote?.slice(0, 16)}…) no es el local (${local.slice(0, 16)}…). Aplica el rollback de arriba y revisa el transporte.`)
    return EXIT.FINDING
  }
  out(`   sha en el host == sha local (${local.slice(0, 16)}…)`)
  if (c.cls !== 'content') {
    out(`✓ PUBLICADO (exit 0). No es contenido que el nodo recargue: su efecto llega con el acto de su clase (${c.cls}).`)
    return EXIT.OK
  }
  const w = await waitTaken(decl, ins, file, c.containerPath, Number(o.timeout ?? 30))
  out(`   ${w.msg}`)
  if (w.code !== EXIT.OK) {
    out(`⚠ (exit ${w.code}) el archivo está en el host pero el nodo no lo tomó: el despliegue NO quedó desplegado. Mira /contrato (reloads.last) antes de reintentar; el rollback está arriba.`)
    return w.code
  }
  out('✓ PUBLICADO Y TOMADO (exit 0). Sigue: `vergis-ops smoke` (todos los Lets) y `vergis-ops parity --family ' + c.family.id + '` hasta 0.')
  return EXIT.OK
}
