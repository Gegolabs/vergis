// verificar-impresiones.mjs — el CERO-PÉRDIDAS del loop de mutaciones.
//
// Cada mutación `ejecutada` devolvió un id. Que el servidor haya contestado 200 no prueba que el
// efecto sobreviviera al handover: el store lo reabre otro proceso, y el modo de falla que interesa
// —last-writer-wins entre dos escritores— es SILENCIOSO por construcción. Así que se re-pregunta por
// cada id, ya cerrado el acto, contra el nodo que hoy tiene el control.
//
// Uso: MUT_OUT=<mutaciones.jsonl> MUT_URL=<base> MUT_EMAIL=<email> node verificar-impresiones.mjs

import { readFileSync } from 'node:fs'

const base = process.env['MUT_URL'] ?? 'http://benchv14-caddy:8079'
const archivo = process.env['MUT_OUT'] ?? '/datos/mutaciones.jsonl'
const email = process.env['MUT_EMAIL'] ?? 'banco@v14.local'

const ids = readFileSync(archivo, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => r.clase === 'ejecutada' && r.id)
  .map((r) => r.id)

let vivas = 0
const perdidas = []
for (const id of ids) {
  try {
    const r = await fetch(`${base}/impresiones/${id}`, { headers: { 'X-Forwarded-Email': email }, signal: AbortSignal.timeout(20000) })
    if (r.status === 200) vivas += 1
    else perdidas.push({ id, status: r.status })
  } catch (e) {
    perdidas.push({ id, status: null, motivo: `${e?.name}` })
  }
}
console.log(JSON.stringify({ ejecutadas: ids.length, vivas, perdidas }, null, 2))
process.exit(perdidas.length === 0 ? 0 : 1)
