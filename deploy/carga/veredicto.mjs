#!/usr/bin/env node
// veredicto.mjs — EL JUEZ. Computa el veredicto de una corrida **del archivo crudo**, jamás de la
// consola ni de la memoria del proceso que midió (regla 1 de la ley del instrumento).
//
// Que sea un proceso aparte no es prolijidad: es lo que permite volver a juzgar una corrida vieja,
// juzgarla con otro umbral, y —sobre todo— que el que mide no pueda «redondear» lo que reporta.
//
// Uso:
//   node deploy/carga/veredicto.mjs .run/carga/daftar-S0.jsonl [--p95-max 200] [--json]
//
// Imprime: el preámbulo (versión, protos, plano de control, driver leídos del SUJETO VIVO), la tabla
// p50/p95/p99/p100 por clase y escalón, los errores por clase con el 409 de standby APARTE, el
// techo, el uso de CPU/RSS del contenedor, y el resultado del cero-pérdidas.

import { readFileSync } from 'node:fs'
import { parsearCrudo, resumir, violaUmbral } from './lib.mjs'

const argv = process.argv.slice(2)
const archivo = argv.find((a) => !a.startsWith('--'))
if (!archivo) {
  console.error('veredicto: falta el archivo crudo (.jsonl)')
  process.exit(2)
}
const flag = (n, def = null) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? def : argv[i + 1]
}
const P95_MAX = flag('p95-max') === null ? null : Number(flag('p95-max'))
const JSON_OUT = argv.includes('--json')
const UMBRAL_CLASES = flag('umbral-clases') === null ? null : new Set(String(flag('umbral-clases')).split(',').map((s) => s.trim()))

const texto = readFileSync(archivo, 'utf8')
const { registros, rotas } = parsearCrudo(texto)
const res = resumir(registros)

// ── El techo ───────────────────────────────────────────────────────────────────────────────────
// TECHO = el ÚLTIMO escalón DENTRO de umbral (criterio 4 del brief). El primero que viola se reporta
// como `escalonFallido`, con sus causas OBSERVADAS. Si ninguno viola, el techo es el último corrido
// y se dice que la escalera NO encontró el techo — que es distinto de haberlo encontrado arriba.
let techo = null
let escalonFallido = null
let causas = []
for (const esc of res.escalones) {
  const v = violaUmbral(esc, P95_MAX, UMBRAL_CLASES)
  if (v.viola) {
    escalonFallido = esc.escalon
    causas = v.causas
    break
  }
  techo = esc.escalon
}
const parada = registros.find((r) => r.tipo === 'parada') ?? null
const siembra = registros.find((r) => r.tipo === 'siembra') ?? null
const calibracion = registros.find((r) => r.tipo === 'calibracion') ?? null

// ── Stats del contenedor ───────────────────────────────────────────────────────────────────────
// La muestra puede venir SIN escalón: cuando el arnés corre dentro de un contenedor hermano (el caso
// de Mira, que vive en la red del banco) no tiene el CLI de docker a mano, y el muestreo lo hace un
// lazo en el host que después se concatena al crudo. En ese caso el escalón se INFIERE de la ventana
// temporal de los requests — no se inventa: una muestra fuera de toda ventana queda sin atribuir.
const ventanas = new Map()
for (const x of registros) {
  if (x.tipo !== 'req' || x.warmup) continue
  const v = ventanas.get(x.escalon) ?? { min: Infinity, max: -Infinity }
  if (x.t0 < v.min) v.min = x.t0
  if (x.t1 > v.max) v.max = x.t1
  ventanas.set(x.escalon, v)
}
const escalonDe = (t) => {
  for (const [esc, v] of ventanas) if (t >= v.min && t <= v.max) return esc
  return null
}
const statsPorEscalon = new Map()
let statsSinAtribuir = 0
for (const s of res.stats) {
  if (s.error) continue
  const esc = s.escalon ?? escalonDe(s.t)
  if (esc === null || esc === undefined) {
    statsSinAtribuir += 1
    continue
  }
  const k = String(esc)
  if (!statsPorEscalon.has(k)) statsPorEscalon.set(k, [])
  statsPorEscalon.get(k).push(s)
}
const cpuNum = (s) => Number(String(s.cpu ?? '0').replace('%', '')) || 0
const memNum = (s) => {
  const m = /([\d.]+)\s*([KMG]i?B)/i.exec(String(s.mem ?? ''))
  if (!m) return 0
  const v = Number(m[1])
  const u = m[2].toUpperCase()
  return u.startsWith('G') ? v * 1024 : u.startsWith('M') ? v : v / 1024
}

if (JSON_OUT) {
  console.log(JSON.stringify({ archivo, techo, escalonFallido, causas, resumen: res, rotas }, null, 2))
  process.exit(0)
}

// ── Impresión ──────────────────────────────────────────────────────────────────────────────────
const num = (v, d = 1) => (v === null || v === undefined ? '—' : v.toFixed(d))
const l = (s, n) => String(s).padEnd(n)
const r = (s, n) => String(s).padStart(n)

console.log(`\n══ VEREDICTO · ${archivo} ══`)
if (rotas.length) console.log(`⚠ ${rotas.length} líneas ilegibles en el crudo (${rotas.slice(0, 5).join(', ')}…) — NO se descartan en silencio`)

const p = res.preambulo
if (!p) {
  console.log('⚠ SIN PREÁMBULO: una corrida sin preámbulo no es una corrida (regla 9).')
} else {
  console.log(`\n── Preámbulo (leído del SUJETO VIVO) ──`)
  console.log(`  sujeto      ${p.url} · perfil ${p.perfil}${p.slug ? ` · slug ${p.slug}` : ''}`)
  console.log(`  healthz     ${p.healthzStatus ?? `SIN RESPUESTA (${p.healthzError})`}${p.healthz ? ` · phase=${p.healthz.phase} · ok=${p.healthz.ok}${p.healthz.lets ? ` · lets=${p.healthz.lets.serving}/${p.healthz.lets.total}` : ' · sin bloque lets'}` : ''}`)
  console.log(`  /contrato   ${p.contratoStatus ?? `SIN RESPUESTA (${p.contratoError})`}`)
  if (p.contrato) {
    console.log(`  versión     ${p.contrato.version ?? '—'}${p.contrato.ring?.version ? ` · anillo ${p.contrato.ring.version}` : ''}`)
    console.log(`  protos      ${(p.contrato.protos ?? []).join(', ') || '—'}`)
    console.log(`  engine      ${p.contrato.engine ?? '—'}`)
    console.log(`  control     ${p.contrato.control ? JSON.stringify(p.contrato.control) : '—'}`)
    console.log(`  stores      ${p.contrato.stores ? JSON.stringify(p.contrato.stores) : '—'}`)
  }
}
if (calibracion) console.log(`  calibración ${JSON.stringify({ ...calibracion, tipo: undefined, t: undefined })}`)
if (siembra) console.log(`\n── Siembra ──\n  ${siembra.ok} intentos escritos · ${siembra.fallos} fallos (de ${siembra.pedidos} pedidos)`)

console.log(`\n── Latencias por escalón y clase (ms; percentil por orden, solo OK; calentamiento descartado: ${res.warmupDescartado} muestras) ──`)
console.log(`  ${l('VU', 5)}${l('clase', 15)}${r('n', 8)}${r('OK', 8)}${r('MAL', 6)}${r('SINMED', 8)}${r('p50', 9)}${r('p95', 9)}${r('p99', 9)}${r('p100', 9)}${r('rps', 9)}`)
for (const esc of res.escalones) {
  const segs = duracionEscalon(registros, esc.escalon)
  for (const c of esc.clases) {
    const rps = segs > 0 ? c.n / segs : null
    console.log(`  ${l(esc.escalon, 5)}${l(c.clase, 15)}${r(c.n, 8)}${r(c.ok, 8)}${r(c.mal, 6)}${r(c.sinmedir, 8)}${r(num(c.p50), 9)}${r(num(c.p95), 9)}${r(num(c.p99), 9)}${r(num(c.p100), 9)}${r(num(rps, 2), 9)}`)
  }
  const rpsT = segs > 0 ? esc.total.n / segs : null
  console.log(`  ${l(esc.escalon, 5)}${l('· TOTAL', 15)}${r(esc.total.n, 8)}${r(esc.total.ok, 8)}${r(esc.total.mal, 6)}${r(esc.total.sinmedir, 8)}${r(num(esc.total.p50), 9)}${r(num(esc.total.p95), 9)}${r(num(esc.total.p99), 9)}${r(num(esc.total.p100), 9)}${r(num(rpsT, 2), 9)}`)
}

console.log(`\n── Errores por clase (el 409 de standby va APARTE; SINMEDIR ≠ MAL) ──`)
for (const esc of res.escalones) {
  for (const c of esc.clases) {
    const fams = Object.entries(c.errores).filter(([f]) => f !== 'ok')
    if (fams.length === 0) continue
    console.log(`  VU ${l(esc.escalon, 5)} ${l(c.clase, 15)} ${fams.map(([f, n]) => `${f}=${n}`).join(' · ')}`)
  }
}
if (res.escalones.every((e) => e.clases.every((c) => Object.keys(c.errores).every((f) => f === 'ok')))) console.log('  (ninguno)')

if (statsPorEscalon.size) {
  console.log(`\n── Contenedor (docker stats, cada muestra al crudo) ──`)
  console.log(`  ${l('VU', 6)}${r('muestras', 10)}${r('CPU máx', 10)}${r('CPU med', 10)}${r('RSS máx MB', 12)}`)
  for (const [k, ss] of [...statsPorEscalon.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const cpus = ss.map(cpuNum)
    const mems = ss.map(memNum)
    const med = cpus.reduce((a, b) => a + b, 0) / cpus.length
    console.log(`  ${l(k, 6)}${r(ss.length, 10)}${r(`${Math.max(...cpus).toFixed(1)}%`, 10)}${r(`${med.toFixed(1)}%`, 10)}${r(Math.max(...mems).toFixed(1), 12)}`)
  }
  if (statsSinAtribuir) console.log(`  (${statsSinAtribuir} muestras fuera de toda ventana de escalón: NO se atribuyen)`)
}

if (res.reverificacion) {
  const v = res.reverificacion
  console.log(`\n── Cero pérdidas (cada POST con 200, releído y comparado con lo enviado) ──`)
  console.log(`  ${v.iguales}/${v.total} idénticos · ${v.distintos} distintos · ${v.sinRespuesta} sin respuesta`)
  if (v.distintos > 0) console.log(`  detalle: ${JSON.stringify(v.detalle).slice(0, 600)}`)
} else {
  console.log(`\n── Cero pérdidas ── SIN MEDIR (la corrida no reverificó: perfil sin escrituras o --sin-reverificar).`)
}

console.log(`\n── TECHO ──`)
if (escalonFallido !== null) {
  console.log(`  techo = ${techo ?? 'ninguno'} VU (último escalón dentro de umbral)`)
  console.log(`  se rompió en ${escalonFallido} VU: ${causas.join(' · ')}`)
} else if (techo !== null) {
  console.log(`  techo ≥ ${techo} VU — la escalera terminó SIN encontrar el techo (ningún escalón violó el umbral).`)
  console.log(`  «≥» y no «=»: no se midió más arriba, así que el número acota por abajo y no dice dónde se rompe.`)
} else {
  console.log('  sin escalones medidos.')
}
if (parada) console.log(`  (parada anotada por el arnés en el escalón ${parada.escalon}: ${(parada.causas ?? []).join(' · ')})`)
console.log(`  umbral aplicado: p95 ≤ ${P95_MAX === null ? '(no declarado)' : `${P95_MAX} ms`} · MAL ≤ 0,1 % · SINMEDIR = 0${UMBRAL_CLASES ? ` · clases que paran: ${[...UMBRAL_CLASES].join(',')}` : ''}`)
console.log('')

function duracionEscalon(regs, escalon) {
  let min = Infinity
  let max = -Infinity
  for (const x of regs) {
    if (x.tipo !== 'req' || x.escalon !== escalon || x.warmup) continue
    if (x.t0 < min) min = x.t0
    if (x.t1 > max) max = x.t1
  }
  return max > min ? (max - min) / 1000 : 0
}
