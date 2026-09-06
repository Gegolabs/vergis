#!/usr/bin/env node
// arnes.mjs — EL INSTRUMENTO de la prueba de carga a UN nodo (H1 · `work/013` doc 06).
//
// Node ≥ 22, **sin una sola dependencia**. Corre en el HOST o en un contenedor hermano; JAMÁS dentro
// del contenedor del sujeto (regla 7 de la ley del instrumento: el arnés vive fuera del sujeto).
//
// ── Las nueve reglas, y dónde las cumple este archivo ──────────────────────────────────────────
//
//  1. Cada request es un par (t-envío, t-respuesta) con veredicto, en un JSONL crudo → `anotar()`.
//     El veredicto se computa DEL ARCHIVO (`veredicto.mjs`), nunca de la consola.
//  2. `SINMEDIR ≠ MAL` → `motivoDeFalloDeRed()` en `lib.mjs`; el tope de en-vuelo se anota como
//     `SINMEDIR:tope-en-vuelo` y no como fallo del sujeto.
//  3. Predicado completo por clase → `juzgar()` en `lib.mjs`.
//  4. Errores por clase, con el 409 de standby APARTE → `familiaDeMotivo()`.
//  5. p50/p95/p99/p100 por clase y por escalón, del crudo, sin librerías → `percentil()`.
//  6. Control negativo obligatorio → `--esperar standby|rechazo`, que sale con rc≠0 si el resultado
//     NO es el esperado. Un control negativo verde no pasa en silencio.
//  7. Fuera del sujeto → este proceso corre en el host.
//  8. Escalera de carga, no un punto → `--vu 1,5,10,25,50,100,200`, `--dur`, `--warmup`, y parada en
//     el primer escalón que viola. El TECHO es el último escalón DENTRO de umbral.
//  9. La configuración se lee del SUJETO VIVO → `preambulo()` pide `/healthz` y `/contrato` y guarda
//     versión, `protos`, `control` y driver en el crudo. Sin preámbulo no hay corrida (salvo en el
//     brazo `rechazo`, donde que el preámbulo NO conteste es justamente lo que se espera).
//
// Uso (los ejemplos vivos están en README.md):
//   node deploy/carga/arnes.mjs --perfil daftar --url http://127.0.0.1:8080 --slug carga \
//        --vu 1,5,10,25,50 --dur 60 --warmup 10 --p95-max 200 --out .run/carga/daftar-S0.jsonl

import { appendFileSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawn } from 'node:child_process'
import {
  juzgar,
  motivoDeFalloDeRed,
  resumir,
  violaUmbral,
  juzgarControlNegativo,
  compararProgreso,
  parsearCrudo,
} from './lib.mjs'

// ── Argumentos ─────────────────────────────────────────────────────────────────────────────────

function parsearArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const clave = t.slice(2)
    const sig = argv[i + 1]
    if (sig === undefined || sig.startsWith('--')) {
      a[clave] = true
    } else {
      a[clave] = sig
      i++
    }
  }
  return a
}

const args = parsearArgs(process.argv.slice(2))
const morir = (m) => {
  console.error(`arnes: ${m}`)
  process.exit(2)
}

const PERFIL = args['perfil'] ?? morir('falta --perfil (daftar|mira)')
const URL_BASE = (args['url'] ?? morir('falta --url')).replace(/\/+$/, '')
const SLUG = args['slug'] ?? (PERFIL === 'daftar' ? 'carga' : null)
const VUS = String(args['vu'] ?? '1,5,10,25,50')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const DUR_MS = Number(args['dur'] ?? 60) * 1000
const WARMUP_MS = Number(args['warmup'] ?? 10) * 1000
const P95_MAX = args['p95-max'] === undefined ? null : Number(args['p95-max'])
const OUT = args['out'] ?? morir('falta --out')
const ESPERAR = args['esperar'] ?? null // 'standby' | 'rechazo'
const TIMEOUT_MS = Number(args['timeout'] ?? 20000)
const MAX_VUELO = Number(args['max-vuelo'] ?? 2000)
const ADMIN = args['admin-email'] ?? 'admin@carga.local'
const DOMINIO = args['dominio'] ?? 'carga.local'
const K_POST = Number(args['k'] ?? 3) // POSTs de progreso por vuelta de estudiante virtual
const CONTENEDOR = args['contenedor'] ?? null
const STATS_CADA_MS = Number(args['stats-cada'] ?? 5) * 1000
const PIS = String(args['pis'] ?? 'bench-01,bench-02,bench-03,bench-04,bench-05,bench-06,bench-07,bench-08,bench-09')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const MIRA_EMAIL = args['mira-email'] ?? 'banco@v14.local'
const SEMBRAR = args['sembrar'] === undefined ? 0 : Number(args['sembrar'])
const SEMBRAR_VU = Number(args['sembrar-vu'] ?? 20)
const SIN_REVERIFICAR = args['sin-reverificar'] === true
/** Clases que mandan la PARADA de la escalera. Por defecto, todas (el brief no exceptúa ninguna). */
const UMBRAL_CLASES = args['umbral-clases'] === undefined ? null : new Set(String(args['umbral-clases']).split(',').map((s) => s.trim()).filter(Boolean))

if (!['daftar', 'mira'].includes(PERFIL)) morir(`perfil desconocido: ${PERFIL}`)

// ── El crudo ───────────────────────────────────────────────────────────────────────────────────
// Se BUFFEREA y se vuelca cada 250 ms: a 200 VU un `appendFileSync` por request convierte al
// instrumento en el cuello de botella y lo que se mediría sería el disco del arnés, no el sujeto.

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, '')
let buffer = []
const anotar = (reg) => {
  buffer.push(JSON.stringify(reg))
  if (buffer.length >= 2000) volcar()
}
const volcar = () => {
  if (buffer.length === 0) return
  const t = buffer
  buffer = []
  appendFileSync(OUT, t.join('\n') + '\n')
}
const volcador = setInterval(volcar, 250)
volcador.unref()

// ── El pedido, con su par de tiempos y su veredicto ────────────────────────────────────────────

let vuelo = 0
let seq = 0

/**
 * Un request medido. Devuelve `{ ok, status, texto }` para que el perfil pueda encadenar (por
 * ejemplo, leer el id de la guía del catálogo) — pero el que decide OK/MAL/SINMEDIR es `juzgar()`,
 * y el registro va al crudo pase lo que pase.
 */
async function pedir({ clase, url, metodo = 'GET', email, cuerpo = null, invariante = null, escalon, warmup }) {
  const n = seq++
  if (vuelo >= MAX_VUELO) {
    const t = Date.now()
    anotar({ tipo: 'req', seq: n, escalon, vu: escalon, clase, t0: t, t1: t, ms: 0, veredicto: 'SINMEDIR', motivo: 'tope-en-vuelo', status: null, warmup })
    return { ok: false, status: null, texto: null }
  }
  const cabeceras = { 'X-Forwarded-Email': email }
  if (cuerpo !== null) cabeceras['Content-Type'] = 'application/json'
  const t0 = Date.now()
  const m0 = performance.now()
  vuelo += 1
  try {
    const r = await fetch(url, {
      method: metodo,
      headers: cabeceras,
      body: cuerpo === null ? undefined : cuerpo,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const texto = await r.text()
    const ms = Math.round((performance.now() - m0) * 100) / 100
    const { ok, motivo } = juzgar(clase, r.status, texto, invariante)
    const reg = {
      tipo: 'req',
      seq: n,
      escalon,
      clase,
      t0,
      t1: Date.now(),
      ms,
      veredicto: ok ? 'OK' : 'MAL',
      status: r.status,
      motivo,
      warmup,
    }
    // El cuerpo del fallo se guarda RECORTADO: sin él, un `MAL` es un número sin diagnóstico; entero,
    // un escalón de 200 VU llenaría el disco con el mismo HTML repetido.
    if (!ok) reg.cuerpo = texto.replace(/\s+/g, ' ').slice(0, 200)
    anotar(reg)
    return { ok, status: r.status, texto }
  } catch (e) {
    const ms = Math.round((performance.now() - m0) * 100) / 100
    anotar({ tipo: 'req', seq: n, escalon, clase, t0, t1: Date.now(), ms, veredicto: 'SINMEDIR', motivo: motivoDeFalloDeRed(e), status: null, warmup })
    return { ok: false, status: null, texto: null }
  } finally {
    vuelo -= 1
  }
}

// ── Preámbulo: la configuración se lee del SUJETO VIVO (regla 9) ───────────────────────────────

async function preambulo() {
  const reg = { tipo: 'preambulo', t: Date.now(), url: URL_BASE, perfil: PERFIL, slug: SLUG, admin: ADMIN }
  try {
    const r = await fetch(`${URL_BASE}/healthz`, { signal: AbortSignal.timeout(10000) })
    const texto = await r.text()
    reg.healthzStatus = r.status
    try {
      reg.healthz = JSON.parse(texto)
    } catch {
      reg.healthz = null
      reg.healthzCrudo = texto.slice(0, 200)
    }
  } catch (e) {
    reg.healthzError = motivoDeFalloDeRed(e)
  }
  try {
    const r = await fetch(`${URL_BASE}/contrato`, { headers: { 'X-Forwarded-Email': ADMIN }, signal: AbortSignal.timeout(15000) })
    const texto = await r.text()
    reg.contratoStatus = r.status
    let c = null
    try {
      c = JSON.parse(texto)
    } catch {
      reg.contratoCrudo = texto.slice(0, 300)
    }
    if (c) {
      // Solo lo que el brief exige guardar: versión, protos, plano de control y drivers de store.
      // El contrato entero pesa y su ruido tapa lo que se está registrando.
      reg.contrato = {
        version: c.version ?? null,
        ring: c.ring ?? null,
        protos: c.protos ?? null,
        control: c.control ?? null,
        stores: c.stores ?? null,
        engine: c.engine ?? null,
      }
    }
  } catch (e) {
    reg.contratoError = motivoDeFalloDeRed(e)
  }
  anotar(reg)
  volcar()
  const vivo = reg.healthzStatus !== undefined
  if (!vivo && ESPERAR !== 'rechazo') {
    console.error(`arnes: el sujeto no respondió el preámbulo (${reg.healthzError}). Una corrida sin preámbulo no es una corrida.`)
    process.exit(2)
  }
  if (vivo) {
    const v = reg.contrato?.version ?? '¿?'
    const p = (reg.contrato?.protos ?? []).join(',') || '¿?'
    console.log(`· preámbulo: healthz=${reg.healthzStatus} phase=${reg.healthz?.phase ?? '?'} · versión=${v} · protos=[${p}] · contrato=${reg.contratoStatus ?? reg.contratoError}`)
  } else {
    console.log(`· preámbulo: el sujeto NO respondió (${reg.healthzError}) — es lo esperado en el brazo --esperar rechazo`)
  }
  return reg
}

// ── `docker stats` al crudo (criterio 4: RSS y CPU del contenedor en el techo) ─────────────────

let statsTimer = null
function arrancarStats(escalonActual) {
  if (!CONTENEDOR) return
  const tomar = () => {
    const p = spawn('docker', ['stats', '--no-stream', '--format', '{{json .}}', CONTENEDOR])
    let salida = ''
    p.stdout.on('data', (d) => {
      salida += d
    })
    p.on('error', () => anotar({ tipo: 'stats', t: Date.now(), escalon: escalonActual(), error: 'docker-no-disponible' }))
    p.on('close', () => {
      const linea = salida.trim().split('\n')[0]
      if (!linea) return anotar({ tipo: 'stats', t: Date.now(), escalon: escalonActual(), error: 'sin-salida' })
      try {
        const j = JSON.parse(linea)
        anotar({ tipo: 'stats', t: Date.now(), escalon: escalonActual(), cpu: j.CPUPerc, mem: j.MemUsage, memPerc: j.MemPerc, pids: j.PIDs })
      } catch {
        anotar({ tipo: 'stats', t: Date.now(), escalon: escalonActual(), error: 'json-invalido', crudo: linea.slice(0, 200) })
      }
    })
  }
  tomar()
  statsTimer = setInterval(tomar, STATS_CADA_MS)
  statsTimer.unref()
}
const pararStats = () => {
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = null
}

// ── Perfil `daftar`, calcado del frontend (`packages/daftar/assets/app.js`) ────────────────────
//
// Un estudiante virtual = su propio email y su propio instrumento (un intento por
// (instrumento, estudiante)): así los POST no se pisan y se mide concurrencia real, no
// serialización sobre una fila.

const pad = (n) => String(n).padStart(3, '0')
const emailDe = (i) => `e${pad(i)}@${DOMINIO}`
const guiaDe = (i) => `carga-${pad(i)}`

/** Último cuerpo que el arnés dio por guardado (200) por estudiante — insumo del cero-pérdidas. */
const ultimoEnviado = new Map()

/** Estado de progreso por estudiante virtual: crece a lo largo de la corrida, como el real. */
const progresoDe = new Map()

function cuerpoDeProgreso(i, secciones, itemsPorSeccion) {
  let st = progresoDe.get(i)
  if (!st) {
    st = { currentSection: 0, sections: {}, respondidas: 0, iniciado: new Date().toISOString() }
    progresoDe.set(i, st)
  }
  const sec = st.currentSection
  const clave = String(sec)
  if (!st.sections[clave]) st.sections[clave] = { answers: [], checked: false }
  const s = st.sections[clave]
  s.answers.push({ choice: st.respondidas % 4, conf: ['S', 'C', 'A'][st.respondidas % 3] })
  st.respondidas += 1
  if (s.answers.length >= itemsPorSeccion) {
    s.checked = true
    s.score = { correct: Math.floor(s.answers.length / 2), total: s.answers.length }
    st.currentSection = sec + 1
    // TERMINÓ EL INSTRUMENTO ⇒ EMPIEZA UNO NUEVO, no un progreso infinito. Sin este corte el
    // `answers` de la sección crecía sin tope a lo largo de la corrida: el cuerpo del `POST` y la
    // fila del store engordaban con el tiempo, y la latencia derivaba por una causa del ARNÉS. Eso
    // habría metido el crecimiento de `S` dentro de la serie S₀, que es justo lo que S₀ mide
    // sin él. (Medido y corregido el 5-sep, primera corrida de S₀.)
    if (st.currentSection >= secciones) {
      st.currentSection = 0
      st.sections = {}
      st.respondidas = 0
      st.iniciado = new Date().toISOString()
    }
  }
  return {
    guideId: guiaDe(i),
    currentSection: st.currentSection,
    sections: JSON.parse(JSON.stringify(st.sections)),
    totalSections: secciones,
    _startedAt: st.iniciado,
    _finishedAt: null,
  }
}

/**
 * El invariante de contenido del `report` de UNA guía. Se calibra del sujeto vivo leyendo la guía 0
 * y, si su título contiene el id (que es lo que emite el generador), se vuelve PLANTILLA: cada
 * estudiante virtual exige el título de SU instrumento. Sin esto el invariante de la guía 0 se
 * aplicaba a las 200 y el arnés marcaba `falta-invariante` en 4 de cada 5 reports — un rojo del
 * instrumento, no del sujeto (medido en la primera corrida de CN-A, 5-sep).
 */
const invarianteDe = (forma, id) => (forma.invarianteTpl ? forma.invarianteTpl.replaceAll('{id}', id) : forma.invariante)

async function vueltaDaftar(i, escalon, warmup, forma) {
  const email = emailDe(i)
  const id = guiaDe(i)
  const b = `${URL_BASE}/${SLUG}`
  await pedir({ clase: 'shell', url: `${b}/`, email, escalon, warmup })
  await pedir({ clase: 'guides', url: `${b}/api/guides`, email, escalon, warmup })
  await pedir({ clase: 'guia', url: `${b}/api/guides/${id}`, email, escalon, warmup })
  await pedir({ clase: 'progress-get', url: `${b}/api/progress/${id}`, email, escalon, warmup })
  for (let k = 0; k < K_POST; k++) {
    const cuerpo = cuerpoDeProgreso(i, forma.secciones, forma.items)
    const r = await pedir({ clase: 'progress-post', url: `${b}/api/progress/${id}`, email, metodo: 'POST', cuerpo: JSON.stringify(cuerpo), escalon, warmup })
    if (r.ok) ultimoEnviado.set(i, cuerpo)
  }
  await pedir({ clase: 'report', url: `${b}/report/${id}`, email, invariante: invarianteDe(forma, id), escalon, warmup })
}

// ── Perfil `mira` ──────────────────────────────────────────────────────────────────────────────

async function vueltaMira(i, escalon, warmup, forma) {
  const pi = PIS[i % PIS.length]
  await pedir({ clase: 'pi', url: `${URL_BASE}/${pi}`, email: MIRA_EMAIL, invariante: forma.invariantes?.[pi] ?? null, escalon, warmup })
}

// ── Calibración del invariante de contenido, del sujeto vivo ───────────────────────────────────
//
// El plan dice que el invariante de Mira «se toma de `.run/datos/pis-servidos.json`». Ese archivo
// solo guarda CONTEOS (`{pisServidos, de, malos}`, `bench.sh` cmd_preparar), no contenido: no hay de
// dónde sacarlo ahí. Se calibra entonces del SUJETO VIVO —una lectura de cada PI en el preámbulo,
// de la que se extrae el `<title>`— y el invariante usado queda anotado en el crudo. Inventarlo
// habría producido un rojo que no es del sujeto.

async function calibrarInvariantes() {
  if (PERFIL === 'daftar') {
    const r = await fetch(`${URL_BASE}/${SLUG}/api/guides/${guiaDe(0)}`, { headers: { 'X-Forwarded-Email': emailDe(0) }, signal: AbortSignal.timeout(15000) }).catch(() => null)
    if (!r || r.status !== 200) {
      if (ESPERAR) return { secciones: 3, items: 8, invariante: null, invarianteTpl: null }
      morir(`no se pudo calibrar el perfil: GET /${SLUG}/api/guides/${guiaDe(0)} devolvió ${r ? r.status : 'nada'}`)
    }
    const g = JSON.parse(await r.text())
    const titulo = typeof g.title === 'string' ? g.title : null
    const id0 = guiaDe(0)
    const forma = {
      secciones: Array.isArray(g.sections) ? g.sections.length : 1,
      items: Array.isArray(g.sections?.[0]?.exercises) ? g.sections[0].exercises.length : 5,
      invariante: titulo,
      invarianteTpl: titulo && titulo.includes(id0) ? titulo.replaceAll(id0, '{id}') : null,
    }
    anotar({ tipo: 'calibracion', t: Date.now(), ...forma })
    console.log(`· calibración (del sujeto vivo): ${forma.secciones} secciones × ${forma.items} ítems · invariante del report: ${JSON.stringify(forma.invarianteTpl ?? forma.invariante)}${forma.invarianteTpl ? ' (plantilla por instrumento)' : ''}`)
    return forma
  }
  const invariantes = {}
  for (const pi of PIS) {
    const r = await fetch(`${URL_BASE}/${pi}`, { headers: { 'X-Forwarded-Email': MIRA_EMAIL }, signal: AbortSignal.timeout(20000) }).catch(() => null)
    if (!r || r.status !== 200) {
      if (ESPERAR) continue
      morir(`no se pudo calibrar el PI ${pi}: devolvió ${r ? r.status : 'nada'}`)
    }
    const html = await r.text()
    const m = /<title>([^<]{3,120})<\/title>/i.exec(html)
    if (!m) morir(`el PI ${pi} no trae <title>: sin invariante de contenido no se mide (un 200 vacío pasaría)`)
    invariantes[pi] = m[1].trim()
  }
  anotar({ tipo: 'calibracion', t: Date.now(), invariantes })
  console.log(`· calibración (del sujeto vivo): invariantes de ${Object.keys(invariantes).length} PIs · ej. ${JSON.stringify(Object.values(invariantes)[0] ?? null)}`)
  return { invariantes }
}

// ── La escalera ────────────────────────────────────────────────────────────────────────────────

async function correrEscalon(vu, forma) {
  const t0 = Date.now()
  const finWarmup = t0 + WARMUP_MS
  const fin = finWarmup + DUR_MS
  let vueltas = 0
  const uno = async (i) => {
    while (Date.now() < fin) {
      const warmup = Date.now() < finWarmup
      if (PERFIL === 'daftar') await vueltaDaftar(i, vu, warmup, forma)
      else await vueltaMira(i, vu, warmup, forma)
      vueltas += 1
    }
  }
  await Promise.all([...Array(vu)].map((_, i) => uno(i)))
  volcar()
  return { vueltas, segundos: (Date.now() - t0) / 1000 }
}

// ── Cero pérdidas: se relee cada intento escrito y se compara con lo enviado ────────────────────

async function reverificar() {
  if (PERFIL !== 'daftar' || SIN_REVERIFICAR || ultimoEnviado.size === 0) return null
  console.log(`· cero-pérdidas: releyendo ${ultimoEnviado.size} intentos escritos…`)
  const distintos = []
  let iguales = 0
  let sinRespuesta = 0
  for (const [i, enviado] of ultimoEnviado) {
    try {
      const r = await fetch(`${URL_BASE}/${SLUG}/api/progress/${guiaDe(i)}`, { headers: { 'X-Forwarded-Email': emailDe(i) }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (r.status !== 200) {
        sinRespuesta += 1
        distintos.push({ estudiante: emailDe(i), status: r.status })
        continue
      }
      const releido = JSON.parse(await r.text())
      const c = compararProgreso(enviado, releido)
      if (c.igual) iguales += 1
      else distintos.push({ estudiante: emailDe(i), diferencias: c.diferencias.slice(0, 5) })
    } catch (e) {
      sinRespuesta += 1
      distintos.push({ estudiante: emailDe(i), error: motivoDeFalloDeRed(e) })
    }
  }
  const reg = { tipo: 'reverificacion', t: Date.now(), total: ultimoEnviado.size, iguales, distintos: distintos.length, sinRespuesta, detalle: distintos.slice(0, 20) }
  anotar(reg)
  volcar()
  console.log(`· cero-pérdidas: ${iguales}/${ultimoEnviado.size} idénticos · ${distintos.length} distintos · ${sinRespuesta} sin respuesta`)
  return reg
}

// ── Siembra (para la serie S₁): N intentos por POST, jamás tocando el archivo ──────────────────

async function sembrar(n) {
  console.log(`· sembrando ${n} intentos por POST (nunca tocando el archivo del store)…`)
  let proximo = 0
  let hechos = 0
  let fallos = 0
  const pad4 = (x) => String(x).padStart(4, '0')
  const uno = async () => {
    for (;;) {
      const idx = proximo++
      if (idx >= n) return
      // Los ids de siembra son los que emite `gen-instrumentos.mjs --siembra`: `siembra-NNNN` con
      // estudiante `sNNNN`. Si no calzan, el nodo devuelve 404 y la siembra se reporta en rojo.
      const email = `s${pad4(idx)}@${DOMINIO}`
      const guia = `siembra-${pad4(idx)}`
      const cuerpo = {
        guideId: guia,
        currentSection: 0,
        sections: { 0: { answers: [{ choice: idx % 4, conf: 'S' }], checked: false } },
        totalSections: 1,
        _startedAt: new Date().toISOString(),
        _finishedAt: null,
      }
      try {
        const r = await fetch(`${URL_BASE}/${SLUG}/api/progress/${guia}`, {
          method: 'POST',
          headers: { 'X-Forwarded-Email': email, 'Content-Type': 'application/json' },
          body: JSON.stringify(cuerpo),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (r.status === 200) hechos += 1
        else {
          fallos += 1
          if (fallos <= 3) console.error(`  siembra: ${guia} → ${r.status} ${(await r.text()).slice(0, 160)}`)
        }
      } catch (e) {
        fallos += 1
        if (fallos <= 3) console.error(`  siembra: ${guia} → ${motivoDeFalloDeRed(e)}`)
      }
      if ((idx + 1) % 500 === 0) console.log(`  … ${idx + 1}/${n} (ok=${hechos} fallos=${fallos})`)
    }
  }
  await Promise.all([...Array(SEMBRAR_VU)].map(() => uno()))
  anotar({ tipo: 'siembra', t: Date.now(), pedidos: n, ok: hechos, fallos })
  volcar()
  console.log(`· siembra: ${hechos} ok · ${fallos} fallos`)
  if (fallos > 0) process.exitCode = 1
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`arnés de carga · perfil=${PERFIL} · sujeto=${URL_BASE} · escalera=[${VUS.join(',')}] · ${DUR_MS / 1000}s por escalón (+${WARMUP_MS / 1000}s de calentamiento) · crudo=${OUT}`)
  const pre = await preambulo()

  if (SEMBRAR > 0) {
    await sembrar(SEMBRAR)
    volcar()
    return
  }

  const forma = await calibrarInvariantes()
  let escalonActual = VUS[0]
  arrancarStats(() => escalonActual)

  const escalonesCorridos = []
  for (const vu of VUS) {
    escalonActual = vu
    process.stdout.write(`· escalón ${vu} VU… `)
    const { vueltas, segundos } = await correrEscalon(vu, forma)
    // El veredicto del escalón se computa DEL ARCHIVO, no de la memoria del proceso (regla 1).
    const { registros } = parsearCrudo(readFileSync(OUT, 'utf8'))
    const res = resumir(registros)
    const esc = res.escalones.find((e) => e.escalon === vu)
    escalonesCorridos.push(vu)
    if (!esc) {
      console.log('sin muestras (?)')
      continue
    }
    const { viola, causas } = violaUmbral(esc, P95_MAX, UMBRAL_CLASES)
    const p95s = esc.clases.map((c) => `${c.clase}:${c.p95 === null ? '—' : c.p95.toFixed(0)}`).join(' ')
    console.log(`${vueltas} vueltas en ${segundos.toFixed(0)}s · n=${esc.total.n} OK=${esc.total.ok} MAL=${esc.total.mal} SINMEDIR=${esc.total.sinmedir} · p95 [${p95s}]`)
    if (viola) {
      console.log(`  ✖ escalón ${vu} FUERA de umbral: ${causas.join(' · ')}`)
      anotar({ tipo: 'parada', t: Date.now(), escalon: vu, causas, techo: escalonesCorridos.length >= 2 ? escalonesCorridos[escalonesCorridos.length - 2] : null })
      break
    }
    anotar({ tipo: 'escalon-ok', t: Date.now(), escalon: vu, vueltas, segundos })
  }
  pararStats()
  await reverificar()
  anotar({ tipo: 'fin', t: Date.now() })
  volcar()

  // ── El brazo de control negativo: rc≠0 si el resultado NO es el esperado ──
  if (ESPERAR) {
    const { registros } = parsearCrudo(readFileSync(OUT, 'utf8'))
    const v = juzgarControlNegativo(ESPERAR, registros)
    console.log(`\n── CONTROL NEGATIVO «${ESPERAR}» ──\n${v.ok ? '✓ VE EL FALLO' : '✖ CIEGO'}: ${v.detalle}`)
    if (!v.ok) {
      console.error('\nUn control negativo que no sale como se espera INVALIDA la serie: sospechá del transporte antes que del mecanismo.')
      process.exit(1)
    }
    return
  }
  console.log(`\nCrudo en ${OUT}. El veredicto se computa del archivo:\n  node deploy/carga/veredicto.mjs ${OUT}`)
  if (pre.healthzStatus === undefined) process.exit(2)
}

main().catch((e) => {
  volcar()
  console.error(`arnes: fallo no capturado: ${e?.stack ?? e}`)
  process.exit(3)
})
