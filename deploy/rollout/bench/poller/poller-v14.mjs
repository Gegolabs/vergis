// poller-v14.mjs — EL INSTRUMENTO del banco V-14. Extiende `poller-corte.mjs` (el canónico del
// proyecto A.R.B.O.L., `lab/scripts/poller-corte.mjs`) sin relajar una sola de sus reglas.
//
// LA LEY DEL INSTRUMENTO, heredada ENTERA y no opcional:
//
//   1. El poller vive en un contenedor que el acto NO recrea (acá: `benchv14-poller`, hermano del
//      borde). Uno efímero muere durante el acto y solo acota el corte POR ABAJO, sin decirlo.
//   2. El predicado es `200 ∧ phase=serving ∧ pis.serving == pis.total`, JAMÁS «responde» ni `r.ok`:
//      un nodo en `standby` responde 200 con `ok:true` POR DISEÑO, y un instrumento que juzgue por
//      código HTTP declara sano a un nodo que no sirve.
//   3. `SINMEDIR` se distingue de `MAL`. Confundir «medí y salió negativo» con «no pude medir»
//      produce datos con cara de verdad.
//   4. El CONTROL NEGATIVO es obligatorio: hay que comprobar que este instrumento VE el fallo.
//   5. Si el control negativo sale VERDE, sospechá del TRANSPORTE antes que del mecanismo.
//
// QUÉ AGREGA ESTA VERSIÓN, y por qué cada cosa (contrato: `lab/work/225` §7):
//
//   a) MUESTREO POR DESPACHO, no por vuelta de lazo. El canónico espera la respuesta y recién ahí
//      duerme 25 ms: con la sala de espera reteniendo un request 1,7 s, ese lazo produce UNA muestra
//      en 1,7 s y la ventana queda sin observar justo donde importa. Acá se DESPACHA cada ~28 ms
//      pase lo que pase, los requests se apilan, y la métrica se computa POR REQUEST.
//   b) CADA REQUEST ES UN PAR (t-envío, t-respuesta) con su veredicto, en un archivo JSONL crudo.
//      El veredicto del banco se computa de ese archivo, nunca de la consola ni de la memoria.
//   c) TIMEOUT 20 s por request — mayor que cualquier retención esperada y menor que
//      `lb_try_duration` (90 s), para que un cuelgue se vea como cuelgue y el banco termine.
//
// Uso: POLLER_URL=<healthz> POLLER_OUT=<archivo.jsonl> node poller-v14.mjs
//      Termina con SIGTERM/SIGINT cerrando el archivo (los in-flight se anotan como SINMEDIR).

import { appendFileSync, writeFileSync } from 'node:fs'

const url = process.env['POLLER_URL'] ?? process.argv[2]
const out = process.env['POLLER_OUT'] ?? process.argv[3] ?? '/datos/poller.jsonl'
const intervalo = Number(process.env['POLLER_INTERVALO_MS'] ?? 28)
const timeout = Number(process.env['POLLER_TIMEOUT_MS'] ?? 20000)
// Tope de requests en vuelo: con retención larga la pila crece sin límite y el que se queda sin
// sockets es el instrumento. Al tocar el tope se anota una muestra `SINMEDIR` con motivo — que es
// exactamente la distinción de la regla 3: el banco sabe que ahí NO se midió, y por qué.
const maxVuelo = Number(process.env['POLLER_MAX_VUELO'] ?? 600)

if (!url) {
  console.error('poller-v14: falta POLLER_URL (o argv[2])')
  process.exit(2)
}

writeFileSync(out, '')
console.log(`poller-v14 → ${url} · cada ${intervalo}ms · timeout ${timeout}ms · crudo en ${out}`)

let seq = 0
let vuelo = 0
let cerrando = false

/**
 * El predicado canónico. No se relaja: es el contrato de la medición y del conmutador a la vez.
 *
 * SE PARSEA, NO SE GREPEA — y esto no es prolijidad, es un hallazgo del banco. La página de la SALA
 * DE ESPERA que el borde sirve con 503 (`deploy/edge/espera.html`) contiene, en un comentario, la
 * cadena literal `"phase":"serving"`. Un extractor por regexp le lee `phase=serving` a un 503 del
 * borde y lo anota como si el nodo hubiera hablado. El predicado no se rompe (exige 200), así que no
 * produce un falso verde — produce algo peor de diagnosticar: un dato con cara de verdad en la
 * columna `phase` justo en el tramo que se está estudiando. Se descubrió en la corrida CN-2 del
 * 2026-08-26 y se corrige acá.
 *
 * Un cuerpo que no parsea a JSON es FALLO MEDIDO (`MAL`), no `SINMEDIR`: hubo respuesta y no
 * satisface el predicado. Es la misma regla que declara el healthcheck de `compose.reference.yml`.
 */
function juzgar(status, body) {
  let j = null
  try {
    j = JSON.parse(body)
  } catch {
    return { ok: false, phase: null, total: null, serving: null, noJson: true }
  }
  const phase = typeof j?.phase === 'string' ? j.phase : null
  const pis = j && typeof j.pis === 'object' && j.pis ? j.pis : null
  const total = pis && typeof pis.total === 'number' ? pis.total : null
  const serving = pis && typeof pis.serving === 'number' ? pis.serving : null
  // `pis` se exige SOLO SI VIENE — igual que el canónico, que el healthcheck del compose de
  // referencia y que `serving_ok` de `vergis-rollout`. `/healthz` omite el bloque cuando el motor no
  // tiene servibilidad por PI. Ausencia NO es permiso: es que ese conjunto está vacío.
  const ok = status === 200 && phase === 'serving' && (pis === null || (total !== null && total === serving))
  return { ok, phase, total, serving, noJson: false }
}

function anotar(reg) {
  appendFileSync(out, JSON.stringify(reg) + '\n')
}

function despachar() {
  if (cerrando) return
  if (vuelo >= maxVuelo) {
    const t = Date.now()
    anotar({ seq: seq++, t0: t, t1: t, ms: 0, veredicto: 'SINMEDIR', motivo: 'tope-en-vuelo', status: null, phase: null })
    return
  }
  const n = seq++
  const t0 = Date.now()
  vuelo += 1
  fetch(url, { signal: AbortSignal.timeout(timeout) })
    .then(async (r) => {
      const body = await r.text()
      const t1 = Date.now()
      const { ok, phase, total, serving, noJson } = juzgar(r.status, body)
      const reg = { seq: n, t0, t1, ms: t1 - t0, veredicto: ok ? 'OK' : 'MAL', status: r.status, phase, pisTotal: total, pisServing: serving }
      if (noJson) reg.noJson = true
      if (!ok) reg.cuerpo = body.replace(/\s+/g, ' ').slice(0, 200)
      anotar(reg)
      if (!ok) console.log(`${t0} MAL ${t1 - t0}ms status=${r.status} phase=${phase ?? '?'}`)
    })
    .catch((e) => {
      const t1 = Date.now()
      // NO PUDE MEDIR ≠ MEDÍ Y SALIÓ MAL. Un timeout, un ECONNREFUSED o un socket cortado no son
      // evidencia de que el servicio estuviera caído: son ausencia de evidencia, y se anotan como tal.
      anotar({ seq: n, t0, t1, ms: t1 - t0, veredicto: 'SINMEDIR', motivo: `${e?.name}:${String(e?.message).slice(0, 80)}`, status: null, phase: null })
      console.log(`${t0} SINMEDIR ${t1 - t0}ms ${e?.name}`)
    })
    .finally(() => {
      vuelo -= 1
    })
}

const timer = setInterval(despachar, intervalo)

function cerrar() {
  cerrando = true
  clearInterval(timer)
  // Se le da un respiro a los in-flight para que anoten su propia línea; los que no alcancen quedan
  // fuera del archivo y por eso el veredicto cuenta REGISTROS, no despachos.
  setTimeout(() => {
    console.log(`poller-v14: cerrado · ${seq} despachos`)
    process.exit(0)
  }, 1500)
}
process.on('SIGTERM', cerrar)
process.on('SIGINT', cerrar)
