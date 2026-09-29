// transport.mjs — el adaptador de transporte, con contrato cerrado (D7).
//
// Tres tipos: `local` (docker en esta máquina), `ssh` y `az-run-command`. Un tipo nuevo es un PR al
// Producto: ninguna declaración puede traer una plantilla de comando, porque ejecutar la declaración
// sería ejecutar código que viene de un archivo de datos.
//
// EL CENTINELA. Todo script remoto termina imprimiendo `VERGIS-OPS <nonce> rc=<n> lines=<m>`, y empieza
// imprimiendo `VERGIS-OPS-BEGIN <nonce>`. Sin el centinela de ESTA corrida no hay medición —ni éxito ni
// negativo—: `az` sale 0 aunque el remoto haya muerto (medido en el lab, P-144/P-147), y a veces le
// entrega a una invocación la salida de OTRA. El par inicio/fin con el conteo de líneas detecta además
// el corte del transporte por cualquiera de los dos extremos: `az` recorta la salida larga (~4 KB), y
// no es seguro de qué lado.
//
// NUNCA se interpolan secretos en un script: el agente de Azure guarda cada script en disco del host y
// no lo borra. El remoto lee sus secretos de archivos del host.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { EXIT, OpsExit, fail, nonce as mkNonce, shq, sleep, err } from './util.mjs'
import { withLock } from './lock.mjs'

const AZ_BUDGET = 100_000 // `az vm run-command` DESCARTA EN SILENCIO scripts grandes (medido: 180 KB corre, 200 KB no)

function run(cmd, args, { input, env, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let done = false
    let child
    try {
      child = spawn(cmd, args, { env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: null, stdout, stderr, error: e })
      return
    }
    const timer = timeoutMs ? setTimeout(() => { if (!done) child.kill('SIGTERM') }, timeoutMs) : null
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => { done = true; if (timer) clearTimeout(timer); resolve({ code: null, stdout, stderr, error: e }) })
    child.on('close', (code, signal) => { done = true; if (timer) clearTimeout(timer); resolve({ code, signal, stdout, stderr }) })
    child.stdin.on('error', () => {})
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** Lo que TODO script remoto lleva delante: raíz, `RINGS_*` y helpers POSIX. */
export function preamble(ins) {
  const L = ['set -u']
  L.push(`cd ${shq(ins.host.root)} 2>/dev/null || { echo "vergis-ops: la raíz de la instalación ${ins.host.root} no existe en el host"; exit 90; }`)
  if (ins.rings.env_file) {
    const f = shq(ins.rings.env_file)
    L.push(`if [ -f ${f} ]; then set -a; . ${f}; set +a; else echo "vergis-ops: rings.env_file ${ins.rings.env_file} no existe en el host"; exit 91; fi`)
  }
  for (const [k, v] of Object.entries(ins.rings.env ?? {})) L.push(`${k}=${shq(v)}; export ${k}`)
  L.push(`VO_TOOL=${shq(ins.rings.tool ?? '/usr/local/bin/botler-rollout')}`)
  L.push(HELPERS)
  return L.join('\n')
}

// Los helpers POSIX que todo script remoto tiene a mano. `String.raw`: lo que se lee acá es lo que
// corre allá, sin una capa de escapes de JS en medio.
const HELPERS = String.raw`: "${'$'}{RINGS_DIR:=./rings}" "${'$'}{RINGS_EDGE:=caddy}" "${'$'}{RINGS_EDGE_URL:=http://caddy:8079}" "${'$'}{RINGS_IMAGE:=ghcr.io/gegolabs/vergis}"
export RINGS_DIR RINGS_EDGE RINGS_EDGE_URL RINGS_IMAGE
DOCKER="${'$'}{VERGIS_OPS_DOCKER:-docker}"
# sha256 del host: GNU trae sha256sum; macOS, shasum.
vo_sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" 2>/dev/null | cut -d" " -f1; else shasum -a 256 "$1" 2>/dev/null | cut -d" " -f1; fi; }
vo_b64() { base64 | tr -d '\n'; }
# El anillo ACTIVO es el que el borde rutea: active.caddy (lo reescribe la herramienta en cada flip).
# Antes de la primera promoción apunta a un servicio del compose: se resuelve por label.
vo_active_upstream() { sed -n 's/^[[:space:]]*reverse_proxy[[:space:]]\{1,\}\([^: ]*\):8080.*/\1/p' "$RINGS_DIR/active.caddy" 2>/dev/null | head -1; }
vo_active_ring() {
  _u=$(vo_active_upstream); [ -n "$_u" ] || return 1
  if $DOCKER inspect "$_u" >/dev/null 2>&1; then printf '%s\n' "$_u"; return 0; fi
  $DOCKER ps --filter "label=com.docker.compose.service=$_u" --format '{{.Names}}' | head -1
}
vo_ring_name() { printf 'vergis-%s\n' "$(printf '%s' "$1" | tr '.' '-')"; }
# Sonda HTTP con el node de un anillo: status en la 1ª línea, cuerpo después; rc≠0 SOLO si no hubo respuesta.
VO_FETCH_JS='const [u,h]=process.argv.slice(1);const H=JSON.parse(h||"{}");if(process.env.VERGIS_OPS_GATE_TOKEN)H["x-gate-token"]=process.env.VERGIS_OPS_GATE_TOKEN;fetch(u,{headers:H,signal:AbortSignal.timeout(15000)}).then(async r=>{process.stdout.write(r.status+"\n");process.stdout.write(await r.text())}).catch(e=>{process.stderr.write("sonda: "+(e&&e.message||e)+"\n");process.exit(1)})'
vo_fetch() {
  _c=$1; _u=$2
  _h=${'$'}{VO_HDR:-}; [ -n "$_h" ] || _h='{}'
  $DOCKER exec -e VERGIS_OPS_GATE_TOKEN "$_c" node -e "$VO_FETCH_JS" "$_u" "$_h"
}
# El token del gate se lee DEL HOST y viaja por env heredado (docker exec -e NOMBRE), jamás en el texto del script.
VERGIS_OPS_GATE_TOKEN=""
if [ -n "${'$'}{RINGS_GATE_TOKEN_FILE:-}" ] && [ -f "$RINGS_GATE_TOKEN_FILE" ]; then VERGIS_OPS_GATE_TOKEN=$(sed -n 1p "$RINGS_GATE_TOKEN_FILE" | tr -d '\r\n'); fi
export VERGIS_OPS_GATE_TOKEN
# Correr un programa node (base64 por stdin) dentro de un contenedor. -e para el token; nada más viaja por env.
vo_node() { _c=$1; _p=$2; printf '%s' "$_p" | base64 -d 2>/dev/null | $DOCKER exec -i -e VERGIS_OPS_GATE_TOKEN "$_c" node --input-type=module - ; }`

/** El script completo: el cuerpo en un archivo, su salida enmarcada entre BEGIN y el centinela. */
export function wrap(ins, body, n, { mute = false } = {}) {
  const delim = `VO_BODY_${n}`
  return [
    mute ? 'exit 0   # fault=mute — simula el descarte silencioso del canal' : '',
    'VO_T=$(mktemp -d "${TMPDIR:-/tmp}/vergis-ops.XXXXXX") || exit 1',
    'export VO_T',
    `cat > "$VO_T/body.sh" <<'${delim}'`,
    preamble(ins),
    body,
    delim,
    `printf 'VERGIS-OPS-BEGIN %s\\n' '${n}'`,
    'sh "$VO_T/body.sh" > "$VO_T/out" 2>&1',
    'VO_RC=$?',
    "awk '1' \"$VO_T/out\"",
    `VO_N=$(awk 'END{print NR}' "$VO_T/out")`,
    'rm -rf "$VO_T"',
    `printf 'VERGIS-OPS %s rc=%s lines=%s\\n' '${n}' "$VO_RC" "$VO_N"`,
    '',
  ].join('\n')
}

/**
 * Aparea la salida con SU centinela. Devuelve `{ rc, lines, complete }` o lanza 3/5.
 * `complete` = llegó el BEGIN propio y exactamente las líneas que el remoto contó.
 */
export function parse(raw, n) {
  const lines = raw.split(/\r?\n/)
  const endIdx = lines.findIndex((l) => l.startsWith(`VERGIS-OPS ${n} `))
  if (endIdx < 0) {
    const other = lines.find((l) => /^VERGIS-OPS [0-9a-f]{20} rc=/.test(l))
    if (other) throw new OpsExit(EXIT.CROSSED, `respuesta cruzada: se pidió el centinela ${n} y llegó «${other}». El resultado de OTRA corrida no se entrega.`)
    const tail = raw.trim().split(/\r?\n/).slice(-6).map((l) => `   | ${l}`).join('\n')
    throw new OpsExit(EXIT.MUTE, `remoto mudo: el transporte respondió sin el centinela de esta corrida (${n}). NO hubo medición: nada de esto es un veredicto.${tail ? `\n${tail}` : ''}`)
  }
  const m = /rc=(\d+) lines=(\d+)/.exec(lines[endIdx])
  const rc = m ? Number(m[1]) : NaN
  const expected = m ? Number(m[2]) : NaN
  const beginIdx = lines.findIndex((l) => l === `VERGIS-OPS-BEGIN ${n}`)
  const body = lines.slice(beginIdx >= 0 ? beginIdx + 1 : 0, endIdx)
  const complete = beginIdx >= 0 && body.length === expected
  return { rc, lines: body, complete, expected }
}

async function azAccount(azBin) {
  const r = await run(azBin, ['account', 'show', '--query', 'user.name', '-o', 'tsv'], { timeoutMs: 60_000 })
  if (r.error) fail(EXIT.TRANSPORT, `falta el CLI \`az\` (${r.error.message})`)
  if (r.code !== 0) fail(EXIT.TRANSPORT, `\`az account show\` falló (rc=${r.code}): ${r.stderr.trim().split('\n').slice(-2).join(' ')}`)
  return r.stdout.trim()
}

function retryWaits() {
  return (process.env.VERGIS_OPS_RETRY_WAITS ?? '10,20,30,45').split(',').map((s) => Number(s) * 1000)
}

/** Un intento por el transporte. Devuelve la salida cruda o lanza con el código que corresponde. */
async function attempt(ins, script) {
  const t = ins.transport
  if (t.kind === 'local') {
    const r = await run('sh', ['-s'], { input: script })
    if (r.error) fail(EXIT.TRANSPORT, `no pude lanzar sh local: ${r.error.message}`)
    return { raw: r.stdout + (r.stderr ? `\n${r.stderr}` : ''), retry: null }
  }
  if (t.kind === 'ssh') {
    const bin = process.env.VERGIS_OPS_SSH || 'ssh'
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']
    if (t.port) args.push('-p', String(t.port))
    if (t.identity_file) args.push('-i', t.identity_file.startsWith('~/') ? join(homedir(), t.identity_file.slice(2)) : t.identity_file)
    args.push(`${t.user}@${t.host}`, t.sudo ? 'sudo sh -s' : 'sh -s')
    const r = await run(bin, args, { input: script, timeoutMs: 15 * 60_000 })
    if (r.error) fail(EXIT.TRANSPORT, `no pude lanzar ssh (${r.error.message})`)
    if (r.code === 255) fail(EXIT.TRANSPORT, `ssh falló (rc=255): ${r.stderr.trim().split('\n').slice(-2).join(' ')}`)
    return { raw: r.stdout + (r.stderr ? `\n${r.stderr}` : ''), retry: null }
  }
  // az-run-command
  if (Buffer.byteLength(script) > AZ_BUDGET) {
    fail(EXIT.NOT_RUN, `el script remoto pesa ${Buffer.byteLength(script)} B (> ${AZ_BUDGET} B): az vm run-command descarta en silencio los scripts grandes. No se invoca.`)
  }
  const bin = process.env.VERGIS_OPS_AZ || 'az'
  const dir = mkdtempSync(join(tmpdir(), 'vergis-ops-az-'))
  try {
    const f = join(dir, 'script.sh')
    writeFileSync(f, script, { mode: 0o600 })
    const r = await run(bin, ['vm', 'run-command', 'invoke', '-g', t.resource_group, '-n', t.vm, '--command-id', 'RunShellScript', '--scripts', `@${f}`, '--query', 'value[0].message', '-o', 'tsv'], { timeoutMs: 15 * 60_000 })
    if (r.error) fail(EXIT.TRANSPORT, `falta el CLI \`az\` (${r.error.message})`)
    if (r.code !== 0) {
      if (/Conflict/i.test(r.stderr)) return { raw: null, retry: 'conflict' }
      fail(EXIT.TRANSPORT, `az vm run-command falló (rc=${r.code}): ${r.stderr.trim().split('\n').slice(-3).join(' ')}`)
    }
    return { raw: r.stdout, retry: null }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Corre `body` en el host de la instalación, bajo su candado, y devuelve `{ rc, lines }`.
 * Una salida incompleta sale con 7 salvo `allowPartial` (y entonces `complete:false` viaja).
 */
export async function runRemote(decl, ins, body, { mute = false, allowPartial = false, lock = true } = {}) {
  const go = async () => {
    const t = ins.transport
    // La identidad del transporte, ANTES de cualquier acto: una cuenta distinta sale con 2 sin tocar nada.
    if (t.kind === 'az-run-command') {
      const acct = await azAccount(process.env.VERGIS_OPS_AZ || 'az')
      if (acct.toLowerCase() !== t.expected_account.toLowerCase()) {
        fail(EXIT.NOT_RUN, `az está con la cuenta «${acct}» y la instalación «${ins.id}» exige «${t.expected_account}». No se ejecutó nada: cambia de cuenta (az login / az account set) y reintenta.`)
      }
    }
    const waits = retryWaits()
    let last = null
    for (let i = 0; i <= waits.length; i++) {
      const n = mkNonce()
      const script = wrap(ins, body, n, { mute })
      const a = await attempt(ins, script)
      if (a.retry === 'conflict') {
        last = new OpsExit(EXIT.BUSY, `transporte ocupado: «Conflict» persistente tras ${waits.length + 1} intento(s) — el canal de run-command se serializa en el host y otro actor lo tiene tomado.`)
      } else {
        try {
          const p = parse(a.raw, n)
          if (!p.complete && !allowPartial) {
            const how = a.raw.includes(`VERGIS-OPS-BEGIN ${n}`) ? `llegaron ${p.lines.length} de las ${p.expected} línea(s) que el remoto emitió` : `no llegó el inicio de la salida (el remoto emitió ${p.expected} línea(s))`
            fail(EXIT.PARTIAL, `salida cortada por el transporte: llegó el centinela (rc=${p.rc}) pero ${how}. Lo que falta no se da por visto.`)
          }
          return p
        } catch (e) {
          if (!(e instanceof OpsExit) || e.code !== EXIT.CROSSED) throw e
          last = e
        }
      }
      if (i < waits.length) {
        err(`⏳ ${last.message.split(':')[0]} — intento ${i + 1}/${waits.length + 1}, reintento en ${waits[i] / 1000} s…`)
        await sleep(waits[i])
      }
    }
    throw last
  }
  return lock ? withLock(decl.path, ins.id, go) : go()
}
