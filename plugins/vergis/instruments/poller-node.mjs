// poller-node.mjs — el poller de corte para el contenedor que trae `node` y no `wget`/`sed` (#376).
//
// Hermano de `poller.sh`: MISMA línea por muestra, mismo vocabulario, y el predicado es EL del plugin
// (`lib/predicate.mjs`): el CLI antepone su texto (`PREDICATE_JS`) al copiar este archivo al contenedor,
// así que acá `juzgar` existe sin importarse — una sola implementación del predicado, también adentro.
// Solo, sin ese prefijo, no corre.
//
// Existe para que el instrumento pueda vivir donde el acto no lo toca: un relay de vida larga basado en
// Node es justo el contenedor que un recreate del borde no recrea, y `poller.sh` no corría ahí.
// No usa `sh` del contenedor: escribe su propio log y su pid (un contenedor solo-node puede no traer shell).
//
//   node poller-node.mjs <url-de-healthz> [intervalo-s] [timeout-s] [--log f] [--pid f] [--for s]
//
// Una línea por muestra:   <uptime-s> <HH:MM:SS> OK|MAL|SINMEDIR <detalle> ms=<latencia>
//
//   · 2xx se juzga con el predicado como si fuera 200 — `poller.sh` no distingue 2xx (BusyBox wget no
//     lo hace) y los dos tienen que dar el mismo veredicto. Otro status es `MAL status=<n>`, sin cuerpo.
//   · Sin respuesta HTTP en `timeout` (10 s por omisión: la sala de espera RETIENE, #367) ⇒ SINMEDIR,
//     «no pude medir», que la cuenta lleva aparte y nunca como verde.
//   · `--for s` termina sola a los s segundos (el control negativo); sin él corre hasta SIGTERM.

import { closeSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { uptime } from 'node:os'

const argv = process.argv.slice(2)
const pos = []
const opt = {}
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i]
  else pos.push(argv[i])
}
const [url, ivArg = '0.25', toArg = '10'] = pos
if (!url) {
  process.stderr.write('uso: node poller-node.mjs <url-de-healthz> [intervalo] [timeout] [--log f] [--pid f] [--for s]\n')
  process.exit(2)
}
const iv = Number(ivArg) * 1000
const to = Number(toArg) * 1000

const fd = opt.log ? openSync(opt.log, 'w') : 1
if (opt.pid) writeFileSync(opt.pid, `${process.pid}\n`)
const fin = () => {
  if (opt.pid) try { rmSync(opt.pid, { force: true }) } catch {}
  if (fd !== 1) try { closeSync(fd) } catch {}
  process.exit(0)
}
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, fin)
const hasta = opt.for ? Date.now() + Number(opt.for) * 1000 : Infinity

// El reloj de las muestras es /proc/uptime, el mismo de `poller.sh` y del «ahora» de la cuenta.
function up() {
  try { return readFileSync('/proc/uptime', 'utf8').split(' ')[0] } catch { return uptime().toFixed(2) }
}
const token = (s, n) => String(s).replace(/[\r\n]/g, '').slice(0, n).replace(/\s/g, '_')

async function muestra() {
  const t = up()
  const hh = new Date().toISOString().slice(11, 19)
  const t0 = performance.now()
  let linea
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(to), redirect: 'follow' })
    const body = await r.text()
    const ms = Math.round(performance.now() - t0)
    if (r.status >= 200 && r.status < 300) {
      const j = juzgar(200, body) // eslint-disable-line no-undef -- lo antepone el CLI (PREDICATE_JS)
      const cnt = j.block ? `${j.block}=${j.serving ?? '?'}/${j.total ?? '?'}` : 'lets=-'
      if (j.ok) linea = `OK status=2xx phase=${j.phase} ${cnt} ms=${ms}`
      else {
        let why = ''
        if (!j.json) why += ` cuerpo-no-json=${token(body.trim(), 60)}`
        if (j.sueltos) why += ' conteos-fuera-de-bloque'
        linea = `MAL status=2xx phase=${j.phase ?? '-'} ${cnt}${why} ms=${ms}`
      }
    } else linea = `MAL status=${r.status} phase=- lets=- ms=${ms}`
  } catch (e) {
    const ms = Math.round(performance.now() - t0)
    const why = e?.name === 'TimeoutError' ? `node:_sin_respuesta_en_${to / 1000}_s` : `node:_${e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e}`
    linea = `SINMEDIR ${token(why, 80)} ms=${ms}`
  }
  writeSync(fd, `${t} ${hh} ${linea}\n`)
}

while (Date.now() < hasta) {
  await muestra()
  if (Date.now() >= hasta) break
  await new Promise((r) => setTimeout(r, iv))
}
fin()
