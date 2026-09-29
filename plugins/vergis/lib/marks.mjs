// marks.mjs — `vergis-ops marks`: ¿el gráfico dibuja lo que la consulta devuelve, y puedo demostrarlo?
//
//   marks calibrar --html-a <f> --n-a <n₁> --html-b <f> --n-b <n₂> --forma <F> [--motor v] [--calibracion ruta]
//   marks contar   --html <f|-> [--forma <F>] [--esperado <n|n1,n2,…>] [--motor v] [--calibracion ruta]
//   marks vigencia [--calibracion ruta]
//   marks ruta <slug>[?page=<id>] [--identity id]      (en el anillo activo: REPORTA, no juzga)
//
// El punto de este instrumento no es el selector: es que SEPA FALLAR. Ningún conteo se juzga sin una
// CORRIDA DISCRIMINANTE vigente —dos documentos de la misma forma con cardinalidades conocidas y
// distintas; el contador vive si y solo si devuelve exactamente esos dos números— guardada por
// (versión del motor × forma), que caduca sola al cambiar el motor.
//
// Códigos propios, dentro del vocabulario del plugin: 0 medí y cuadra · 1 hallazgo (incluye el 0 con
// el selector VIVO: gráfico vacío) · 2 no corrí · 3 selector muerto · 4 sin calibración vigente (aquí
// el 4 no es «transporte ocupado»: es «no pude medir» por falta de discriminante) · 5 sin asidero.
// Inyector `MARCAS_FAULT` (solo puede dañar): mismo → 3 · sin-aria → 5 · motor → 4.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { EXIT, fail, out, err } from './util.mjs'
import { FORMAS, medir, tieneAsidero, motorDeHtml, nucleoTexto } from './marks-core.mjs'
import { stateDir } from './state.mjs'

const X = { OK: 0, HALLAZGO: 1, NO_CORRI: 2, MUERTO: 3, SIN_CAL: 4, SIN_ASIDERO: 5 }
const FAULT = () => process.env.MARCAS_FAULT || ''
const muere = (code, msg) => { throw Object.assign(new Error(msg), { opsCode: code }) }

function calPath(o) {
  return typeof o.calibracion === 'string' ? resolve(o.calibracion) : join(stateDir(), 'marcas-calibracion.json')
}
function cargaCal(p) {
  if (!existsSync(p)) return { version: 1, calibraciones: {} }
  try { const j = JSON.parse(readFileSync(p, 'utf8')); return j?.calibraciones ? j : { version: 1, calibraciones: {} } } catch { return { version: 1, calibraciones: {} } }
}
function guardaCal(p, obj) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}
const clave = (motor, forma) => `${motor}|${forma}`
function leerHtml(ruta) {
  if (ruta === '-') return readFileSync(0, 'utf8')
  if (!existsSync(ruta)) muere(X.NO_CORRI, `✗ NO CORRÍ: no existe el HTML «${ruta}».`)
  return readFileSync(ruta, 'utf8')
}
function aplicaFault(html) {
  return FAULT() === 'sin-aria' ? html.split('aria-roledescription=').join('aria-XXX=').split('role-mark').join('role-XXXX') : html
}
function motorDe(html, cli) {
  let m = motorDeHtml(html)
  if (FAULT() === 'motor') m = 'FAULT-' + (m || 'sin-pie')
  if (!m && typeof cli === 'string') m = cli
  return m
}
function exigeForma(f) {
  if (!f || typeof f !== 'string' || !FORMAS[f]) muere(X.NO_CORRI, `✗ NO CORRÍ: --forma debe ser una de ${Object.keys(FORMAS).join(' · ')} (llegó «${f}»).`)
  return f
}
const total = (filas) => filas.reduce((a, f) => a + (f.marcas || 0), 0)

function calibrar(o) {
  const forma = exigeForma(o.forma)
  if (!o['html-a'] || !o['html-b']) muere(X.NO_CORRI, '✗ NO CORRÍ: faltan --html-a / --html-b.')
  const nA = Number(o['n-a'])
  const nB = Number(o['n-b'])
  if (!Number.isInteger(nA) || !Number.isInteger(nB)) muere(X.NO_CORRI, '✗ NO CORRÍ: --n-a y --n-b deben ser enteros.')
  if (nA === nB) muere(X.NO_CORRI, `✗ NO CORRÍ: --n-a y --n-b son iguales (${nA}). Sin dos cardinalidades DISTINTAS no hay discriminante: un selector muerto pasaría verde.`)
  const htmlA = aplicaFault(leerHtml(o['html-a']))
  const htmlB = aplicaFault(leerHtml(FAULT() === 'mismo' ? o['html-a'] : o['html-b']))
  for (const [rot, h] of [['A', htmlA], ['B', htmlB]]) {
    if (!tieneAsidero(h)) muere(X.SIN_ASIDERO, `✗ NO PUDE MEDIR (asidero ausente): el HTML ${rot} no trae ni «aria-roledescription=» ni «role-mark».`)
  }
  const fA = medir(htmlA, forma)
  const fB = medir(htmlB, forma)
  if (!fA.length || !fB.length) muere(X.NO_CORRI, '✗ NO CORRÍ: alguno de los HTML no trae ninguna <section class="chart">.')
  const mA = total(fA)
  const mB = total(fB)
  const motorA = motorDe(htmlA, o.motor)
  const motorB = motorDe(htmlB, o.motor)
  if (motorA !== motorB) muere(X.MUERTO, `✗ NO PUDE MEDIR: los dos HTML son de motores distintos (A=${motorA} · B=${motorB}).`)
  if (!motorA) muere(X.NO_CORRI, '✗ NO CORRÍ: no pude leer la versión del motor del pie del render («Vergis v…») y no se pasó --motor. Una calibración sin motor no caduca nunca.')
  const selector = `aria-roledescription="${FORMAS[forma]}"`
  err(`discriminante · forma=${forma} · selector=${selector} · motor=${motorA}`)
  err(`  A: esperado ${nA} · medido ${mA}`)
  err(`  B: esperado ${nB} · medido ${mB}${FAULT() === 'mismo' ? '   ← MARCAS_FAULT=mismo' : ''}`)
  err(`  (contenedores «mark-rect role-mark», el contador MUERTO: ${fA.reduce((a, f) => a + f.contenedores_rect, 0)} y ${fB.reduce((a, f) => a + f.contenedores_rect, 0)})`)
  if (mA === mB) muere(X.MUERTO, `✗ NO PUDE MEDIR (selector muerto): el contador devolvió el MISMO número (${mA}) para dos cardinalidades distintas (${nA} y ${nB}). NO se escribió calibración.`)
  if (mA !== nA || mB !== nB) muere(X.MUERTO, `✗ NO PUDE MEDIR (selector muerto): números distintos pero no los correctos (esperaba ${nA} y ${nB}; midió ${mA} y ${mB}). NO se escribió calibración.`)
  const ruta = calPath(o)
  const cal = cargaCal(ruta)
  cal.calibraciones[clave(motorA, forma)] = { motor: motorA, forma, selector, pares: [[nA, mA], [nB, mB]], origen: typeof o.origen === 'string' ? o.origen : 'local', fecha: new Date().toISOString() }
  guardaCal(ruta, cal)
  out(JSON.stringify(cal.calibraciones[clave(motorA, forma)]))
  err(`✓ CALIBRACIÓN VIGENTE (exit 0): ${forma} · motor ${motorA} · ${nA}→${mA} y ${nB}→${mB}. Escrita en ${ruta}.`)
  return X.OK
}

function contar(o) {
  if (!o.html) muere(X.NO_CORRI, '✗ NO CORRÍ: falta --html (un archivo, o «-» para stdin).')
  const juzga = o.esperado !== undefined
  if (juzga && !o.forma) muere(X.NO_CORRI, '✗ NO CORRÍ: --esperado exige --forma. Sin la forma no se sabe qué contador es «el» contador.')
  const forma = o.forma ? exigeForma(o.forma) : null
  const html = aplicaFault(leerHtml(o.html))
  if (!tieneAsidero(html)) muere(X.SIN_ASIDERO, '✗ NO PUDE MEDIR (asidero ausente): el HTML no trae ni «aria-roledescription=» ni «role-mark». Esto NO es «cero marcas».')
  const filas = medir(html, forma)
  if (!filas.length) muere(X.NO_CORRI, '✗ NO CORRÍ: el HTML no trae ninguna <section class="chart">.')
  const motor = motorDe(html, o.motor)
  const ruta = calPath(o)
  const vig = forma && motor ? cargaCal(ruta).calibraciones[clave(motor, forma)] : undefined
  const esperados = juzga ? String(o.esperado).split(',').map((s) => Number(s.trim())) : []
  if (juzga && esperados.some((n) => !Number.isInteger(n))) muere(X.NO_CORRI, '✗ NO CORRÍ: --esperado debe ser un entero, o una lista de enteros separados por coma.')
  if (juzga && esperados.length !== 1 && esperados.length !== filas.length) muere(X.NO_CORRI, `✗ NO CORRÍ: --esperado trae ${esperados.length} valores y el documento tiene ${filas.length} sección(es).`)
  const salida = filas.map((f, i) => ({ ...f, esperado: juzga ? (esperados.length === 1 ? esperados[0] : esperados[i]) : null, motor, calibracion: { vigente: !!vig }, veredicto: null }))
  if (juzga && !vig) {
    for (const s of salida) { s.veredicto = 'NO-PUDE-MEDIR'; out(JSON.stringify(s)) }
    muere(X.SIN_CAL, `✗ NO PUDE MEDIR (sin calibración): no hay discriminante vigente para (motor=${motor} · forma=${forma}) en ${ruta}. Los números NO son un veredicto: un selector muerto y un gráfico vacío se ven igual.`)
  }
  let hallazgo = false
  for (const s of salida) {
    if (!juzga) s.veredicto = 'SIN-JUICIO'
    else if (s.marcas === s.esperado) s.veredicto = 'CUADRA'
    else { s.veredicto = 'HALLAZGO'; hallazgo = true }
    out(JSON.stringify(s))
  }
  if (!juzga) { err(`ℹ REPORTE, NO VEREDICTO: ${filas.length} sección(es), motor=${motor || '?'}. Para un gate, pasa --forma y --esperado.`); return X.OK }
  const resumen = salida.map((s) => `§${s.seccion} ${s.marcas}/${s.esperado}`).join(' · ')
  if (hallazgo) { err(`⚠ HALLAZGO (exit 1): ${resumen} · forma=${forma} · motor=${motor}. El instrumento midió bien; el render está mal.`); return X.HALLAZGO }
  err(`✓ MEDÍ Y CUADRA (exit 0): ${resumen} · legitimado por la discriminante ${vig.pares[0][0]}→${vig.pares[0][1]} y ${vig.pares[1][0]}→${vig.pares[1][1]} (${vig.fecha}).`)
  return X.OK
}

function vigencia(o) {
  const ruta = calPath(o)
  const ks = Object.keys(cargaCal(ruta).calibraciones)
  if (!ks.length) { err(`(sin calibraciones en ${ruta}) — ningún conteo es juzgable todavía.`); return X.SIN_CAL }
  for (const k of ks.sort()) out(JSON.stringify(cargaCal(ruta).calibraciones[k]))
  return X.OK
}

async function ruta(common, o) {
  const { resolveInstallation, requireKey } = await import('./declaration.mjs')
  const { runRemote } = await import('./transport.mjs')
  const { nodeInActive } = await import('./smoke.mjs')
  const { decl, ins } = resolveInstallation(common)
  const raw = o._[1]
  if (!raw) fail(EXIT.NOT_RUN, 'marks ruta <slug>[?page=<id>]')
  const [path, q] = raw.split('?')
  const route = path.replace(/^\/+|\/+$/g, '').toLowerCase()
  if (!/^[a-z0-9][a-z0-9/_-]*$/.test(route) || (q !== undefined && !/^page=[A-Za-z0-9_-]+$/.test(q))) fail(EXIT.NOT_RUN, `ruta inválida «${raw}»`)
  const ids = requireKey(ins, 'probe_identities', 'marks ruta')
  const id = o.identity ? ids.find((i) => i.id === o.identity) : ids[0]
  if (!id) fail(EXIT.NOT_RUN, `--identity «${o.identity}» no está en probe_identities`)
  const js = `${await nucleoTexto()}
const cfg = JSON.parse(Buffer.from(process.env.VO_CFG || '', 'base64').toString('utf8'))
const H = { 'x-forwarded-email': cfg.email, 'x-forwarded-groups': cfg.groups.join(',') }
if (process.env.VERGIS_OPS_GATE_TOKEN) H['x-gate-token'] = process.env.VERGIS_OPS_GATE_TOKEN
try {
  const r = await fetch((process.env.VO_NODE_BASE || 'http://127.0.0.1:8080') + '/' + cfg.route, { headers: H, signal: AbortSignal.timeout(120000) })
  const t = await r.text()
  const am = t.match(/<a href="\\?page=([^"&]*)[^"]*" class="active"/)
  const filas = medir(t, null)
  for (const f of filas) console.log('FILA ' + JSON.stringify(f))
  console.log('MARKS status=' + r.status + ' secciones=' + filas.length + ' asidero=' + (tieneAsidero(t) ? 1 : 0) + ' motor=' + (motorDeHtml(t) || '-') + ' served=' + (am ? decodeURIComponent(am[1]) : '-') + ' vacias=' + filas.filter((f) => f.bar === 0 && f.point === 0).length)
} catch (e) { console.log('MARKS-ERR ' + String(e && e.message).slice(0, 100)) }
`
  const r = await runRemote(decl, ins, nodeInActive({ route: route + (q ? `?${q}` : ''), email: id.email, groups: id.groups }, js))
  const m = r.lines.find((l) => l.startsWith('MARKS '))
  if (!m) { out(`✗ NO PUDE MEDIR (exit 5): ${r.lines.find((l) => l.startsWith('MARKS-ERR')) ?? 'sin resumen del anillo'}`); return EXIT.MUTE }
  const kv = Object.fromEntries(m.slice(6).split(' ').map((p) => p.split('=')))
  for (const l of r.lines.filter((x) => x.startsWith('FILA '))) out(l.slice(5))
  if (kv.status !== '200') { out(`⚠ HALLAZGO (exit 1): la ruta respondió ${kv.status}.`); return EXIT.FINDING }
  if (q && kv.served !== '-' && `page=${kv.served}` !== q) { out(`⚠ HALLAZGO (exit 1): pedí ?${q} y sirvieron ?page=${kv.served}: se contarían las marcas de OTRA vista.`); return EXIT.FINDING }
  if (kv.asidero !== '1') { out('✗ NO PUDE MEDIR (exit 5): el documento no trae asidero («aria-roledescription=» ni «role-mark»). No es «cero marcas».'); return EXIT.MUTE }
  if (kv.secciones === '0') { out('✗ NO PUDE MEDIR (exit 5): la vista no trae ninguna <section class="chart">.'); return EXIT.MUTE }
  out(`ℹ MEDÍ (exit 0) — NO JUZGUÉ: ${kv.secciones} sección(es), motor ${kv.motor}. Para un veredicto hace falta la discriminante (\`marks calibrar\`) y \`marks contar --esperado\`.`)
  if (kv.vacias !== '0') out(`   ⚠ ${kv.vacias} sección(es) con CERO marcas de dato: sin discriminante vigente, ese cero es AMBIGUO (gráfico vacío y selector muerto se ven igual).`)
  return EXIT.OK
}

export async function runMarks(common, o) {
  const verbo = o._[0]
  if (FAULT()) {
    err(`!! MARCAS_FAULT=${FAULT()} — INYECTOR DE FALLAS ACTIVO (solo controles negativos) !!`)
    if (!['mismo', 'sin-aria', 'motor'].includes(FAULT())) fail(EXIT.NOT_RUN, `MARCAS_FAULT=«${FAULT()}» no existe (mismo · sin-aria · motor)`)
  }
  try {
    if (verbo === 'calibrar') return calibrar(o)
    if (verbo === 'contar') return contar(o)
    if (verbo === 'vigencia') return vigencia(o)
    if (verbo === 'ruta') return await ruta(common, o)
  } catch (e) {
    if (e && e.opsCode !== undefined) { err(e.message); return e.opsCode }
    throw e
  }
  fail(EXIT.NOT_RUN, 'uso: marks calibrar|contar|vigencia|ruta …')
  return EXIT.NOT_RUN
}
