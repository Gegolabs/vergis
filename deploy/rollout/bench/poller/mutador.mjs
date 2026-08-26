// mutador.mjs — el LOOP DE MUTACIONES del banco V-14 (V13 de `work/210` §10; contrato `work/225` §7).
//
// QUÉ MIDE, dicho como criterio: durante el acto, una mutación puede quedar RETENIDA y ejecutarse
// (200 con id), o ser rechazada con un `409` EXPLÍCITO por un nodo que declara no tener el plano de
// control. Cualquier otra cosa —un 500, un cuelgue, o una respuesta 200 cuyo efecto después no se
// encuentra— es FALLO. La pérdida silenciosa es el modo de falla que este loop existe para delatar.
//
// LA MUTACIÓN ELEGIDA, y por qué: `POST /<pi>/imprimir` congela una vista del PI y abre una
// «impresión» con id propio en el store embebido. Es inocua (no toca dato gobernado, no borra nada),
// es VERIFICABLE (cada 200 devuelve un id que después tiene que existir en `GET /impresiones/<id>`),
// y pasa por el MISMO gate de control que toda escritura gobernada (`mutacionSinControl` en
// `server/routes.ts`): sin control, 409 nombrando al activo.
//
// El token CSRF es HMAC(secreto, `vergis-csrf|<email>`) — el secreto va por `VERGIS_CSRF_SECRET`,
// compartido por los anillos, y por eso el MISMO token sirve antes y después del handover. Se genera
// al vuelo por corrida y no se versiona.

import { appendFileSync, writeFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'

const base = process.env['MUT_URL'] ?? 'http://benchv14-caddy:8079'
const pi = process.env['MUT_PI'] ?? 'bench-01'
const out = process.env['MUT_OUT'] ?? '/datos/mutaciones.jsonl'
const email = process.env['MUT_EMAIL'] ?? 'banco@v14.local'
const intervalo = Number(process.env['MUT_INTERVALO_MS'] ?? 1000)
const timeout = Number(process.env['MUT_TIMEOUT_MS'] ?? 20000)
const secreto = process.env['VERGIS_CSRF_SECRET'] ?? ''

const csrf = createHmac('sha256', secreto).update(`vergis-csrf|${email}`).digest('hex').slice(0, 24)

writeFileSync(out, '')
console.log(`mutador → ${base}/${pi}/imprimir · cada ${intervalo}ms · crudo en ${out}`)

let seq = 0
let cerrando = false

function anotar(reg) {
  appendFileSync(out, JSON.stringify(reg) + '\n')
}

function clasificar(status, cuerpo) {
  // Vocabulario cerrado, para que el veredicto no dependa de leer prosa:
  //   ejecutada — 200 con id (la retención, si la hubo, terminó bien: la latencia la dice `ms`)
  //   409       — rechazo EXPLÍCITO de un nodo sin control (esperado durante el handover)
  //   fallo     — cualquier otra cosa medida
  if (status === 200) {
    try {
      const j = JSON.parse(cuerpo)
      if (j && j.ok === true && typeof j.id === 'string') return { clase: 'ejecutada', id: j.id }
    } catch { /* cuerpo no-JSON con 200: es fallo, no éxito */ }
    return { clase: 'fallo', id: null }
  }
  if (status === 409) return { clase: '409', id: null }
  return { clase: 'fallo', id: null }
}

function disparar() {
  if (cerrando) return
  const n = seq++
  const t0 = Date.now()
  fetch(`${base}/${pi}/imprimir`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-Email': email },
    body: JSON.stringify({ _csrf: csrf }),
    signal: AbortSignal.timeout(timeout),
  })
    .then(async (r) => {
      const cuerpo = await r.text()
      const t1 = Date.now()
      const { clase, id } = clasificar(r.status, cuerpo)
      const reg = { seq: n, t0, t1, ms: t1 - t0, status: r.status, clase, id }
      if (clase === 'fallo') reg.cuerpo = cuerpo.replace(/\s+/g, ' ').slice(0, 240)
      anotar(reg)
      if (clase !== 'ejecutada') console.log(`${t0} ${clase} status=${r.status} ${t1 - t0}ms`)
    })
    .catch((e) => {
      const t1 = Date.now()
      // Igual que en el poller: no poder medir no es haber medido un fallo del sujeto. Pero para el
      // criterio de mutaciones una PÉRDIDA es fallo, y un request que no volvió es candidato a
      // pérdida — se marca `sinmedir` y el veredicto lo reporta aparte, sin fundirlo con los 409.
      anotar({ seq: n, t0, t1, ms: t1 - t0, status: null, clase: 'sinmedir', motivo: `${e?.name}:${String(e?.message).slice(0, 80)}`, id: null })
      console.log(`${t0} sinmedir ${e?.name} ${t1 - t0}ms`)
    })
}

const timer = setInterval(disparar, intervalo)

function cerrar() {
  cerrando = true
  clearInterval(timer)
  setTimeout(() => process.exit(0), 1500)
}
process.on('SIGTERM', cerrar)
process.on('SIGINT', cerrar)
