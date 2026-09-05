// veredicto.mjs — computa el resultado del banco V-14 DESDE LOS DATOS CRUDOS, nunca desde la consola.
//
// Por qué existe como paso aparte: «el comando miente». La duración de `botler-rollout promote` no
// mide nada (precedentes del proyecto: `docker restart` devuelve rc=0 en 375 ms con cortes de
// segundos), y los logs de la herramienta cuentan lo que ella cree, no lo que un cliente recibió.
// Lo único que cuenta son las respuestas del poller, y la ventana del acto se marca con dos sellos
// de tiempo tomados fuera de él.
//
// Uso: node veredicto.mjs <poller.jsonl> <ventana.json> [mutaciones.jsonl]
//   ventana.json = { "inicio": <ms>, "fin": <ms>, "etiqueta": "CN-2 promoción orden vigente" }

import { readFileSync } from 'node:fs'

const [fPoller, fVentana, fMut] = process.argv.slice(2)
const leerJsonl = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

const muestras = leerJsonl(fPoller)
const ventana = JSON.parse(readFileSync(fVentana, 'utf8'))

// Un request PERTENECE al acto si se SOLAPA con la ventana: el que salió antes y volvió después es
// justamente el retenido, y descartarlo sería descartar la observación que más importa.
const enVentana = muestras.filter((m) => m.t1 >= ventana.inicio && m.t0 <= ventana.fin)

const ok = enVentana.filter((m) => m.veredicto === 'OK')
const mal = enVentana.filter((m) => m.veredicto === 'MAL')
const sinmedir = enVentana.filter((m) => m.veredicto === 'SINMEDIR')

// FAMILIAS DE LO FUERA-DE-PREDICADO. Se separan porque son fenómenos distintos con causas distintas,
// y fundirlos en un solo número es perder justo la observación que el banco existe para producir:
//
//   tramo (a)  — `200 ∧ phase=standby`: el borde entregó la respuesta de un nodo que responde y NO
//                sirve. Es lo que CN-2 tiene que reproducir bajo el orden vigente.
//   503 espera — el borde soltó al request con la sala de espera. Candidato al tramo (b); su CAUSA
//                NO se declara acá — la discrimina V-15 (`work/225` §6), y afirmarla sin ese
//                experimento es exactamente lo que la Norma 7 prohíbe.
//   otros      — cualquier otra cosa medida. Se listan enteras: no hay familia residual muda.
const tramoA = mal.filter((m) => m.status === 200 && m.phase === 'standby')
const espera503 = mal.filter((m) => m.status === 503)
const otrosMal = mal.filter((m) => !tramoA.includes(m) && !espera503.includes(m))

const pct = (xs, p) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const lat = ok.map((m) => m.ms)

const relativo = (xs, t0) => (xs.length ? { desde: Math.min(...xs.map((m) => m.t0)) - t0, hasta: Math.max(...xs.map((m) => m.t1)) - t0 } : null)
const ventanaDe = (xs) => (xs.length ? { desde: Math.min(...xs.map((m) => m.t0)), hasta: Math.max(...xs.map((m) => m.t1)), duracionMs: Math.max(...xs.map((m) => m.t1)) - Math.min(...xs.map((m) => m.t0)) } : null)

const res = {
  etiqueta: ventana.etiqueta ?? '(sin etiqueta)',
  ventanaDelActo: { inicio: ventana.inicio, fin: ventana.fin, duracionMs: ventana.fin - ventana.inicio },
  muestras: { total: muestras.length, enVentana: enVentana.length, OK: ok.length, MAL: mal.length, SINMEDIR: sinmedir.length },
  // La métrica primaria del contrato (§7): fuera-de-predicado durante el acto.
  fueraDePredicado: mal.length,
  tramoA: { respuestas200Standby: tramoA.length, ventana: ventanaDe(tramoA), relativoAlActoMs: relativo(tramoA, ventana.inicio) },
  espera503: { respuestas: espera503.length, ventana: ventanaDe(espera503), relativoAlActoMs: relativo(espera503, ventana.inicio), latenciaMaxMs: espera503.length ? Math.max(...espera503.map((m) => m.ms)) : null },
  otrasRespuestasFueraDePredicado: otrosMal.map((m) => ({ t0: m.t0, status: m.status, phase: m.phase, ms: m.ms, noJson: m.noJson ?? false })),
  // Secundaria: se registra, no gatea.
  latenciaDeLasOK: { p50: pct(lat, 50), p95: pct(lat, 95), p100: pct(lat, 100) },
  sinmedirDetalle: sinmedir.slice(0, 20).map((m) => ({ t0: m.t0, ms: m.ms, motivo: m.motivo })),
}

if (fMut) {
  const mut = leerJsonl(fMut).filter((m) => m.t1 >= ventana.inicio && m.t0 <= ventana.fin)
  const por = (c) => mut.filter((m) => m.clase === c)
  res.mutaciones = {
    enVentana: mut.length,
    ejecutadas: por('ejecutada').length,
    rechazos409: por('409').length,
    fallos: por('fallo').map((m) => ({ t0: m.t0, status: m.status, cuerpo: m.cuerpo })),
    sinmedir: por('sinmedir').length,
    latenciaMaxMs: mut.length ? Math.max(...mut.map((m) => m.ms)) : null,
  }
}

console.log(JSON.stringify(res, null, 2))
