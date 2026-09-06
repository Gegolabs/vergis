// lib.mjs — EL NÚCLEO PURO del arnés de carga (H1 del plan `work/013` doc 06).
//
// Acá vive todo lo que se puede juzgar sin red: el predicado por clase de request, la clasificación
// `OK | MAL | SINMEDIR`, la familia del error y el cálculo de percentiles. Está separado de
// `arnes.mjs` por una razón que no es estética: **el veredicto se computa del archivo crudo, nunca
// de la consola** (regla 1 de la ley del instrumento), y para que eso sea cierto el que mide y el
// que juzga tienen que poder correr por separado — y el que juzga tiene que ser testeable sin
// levantar un nodo (`tests/carga-arnes.test.ts`).
//
// LA LEY QUE ESTE ARCHIVO HACE CUMPLIR, heredada de `poller-v14.mjs` sin relajar una regla:
//
//   1. Cada request es un par (t-envío, t-respuesta) con su veredicto en un JSONL.
//   2. `SINMEDIR ≠ MAL`. Timeout, socket rechazado y tope de en-vuelo NO son fallo del sujeto: son
//      ausencia de evidencia. Un 5xx o un cuerpo que no cumple el predicado SÍ es fallo medido.
//   3. El predicado es COMPLETO y POR CLASE. Juzgar por código HTTP declara sano a un nodo que no
//      sirve: un `standby` responde 200 con `ok:true` por diseño.
//   4. El 409 de standby se cuenta APARTE. Contra el nodo activo es un hallazgo, no ruido.
//
// Sin dependencias: Node ≥ 22, nada más.

/** Clases de request del perfil `daftar`, en el orden en que las emite un estudiante virtual. */
export const CLASES_DAFTAR = ['shell', 'guides', 'guia', 'progress-get', 'progress-post', 'report']
/** Clases de request del perfil `mira`. */
export const CLASES_MIRA = ['pi']

/** Clases que ESCRIBEN. Son las que un nodo en standby tiene que rechazar con 409. */
export const CLASES_ESCRITURA = new Set(['progress-post'])

// ── El predicado, por clase ────────────────────────────────────────────────────────────────────

/**
 * ¿Esta respuesta cumple el contrato de su clase?
 *
 * Devuelve `{ ok, motivo }`. `motivo` es `null` cuando `ok`; si no, dice EN QUÉ falló — y ese texto
 * es el que después agrupa la tabla de errores. Un cuerpo que no parsea es **fallo medido**
 * (`MAL`), no `SINMEDIR`: hubo respuesta y no satisface el predicado.
 *
 * `invariante` es el texto que el HTML debe contener (clases `report` y `pi`). Se pasa desde afuera
 * porque se calibra del SUJETO VIVO en el preámbulo, no se hardcodea: un invariante inventado que
 * el render nunca emite produce un rojo que no es del sujeto.
 */
export function juzgar(clase, status, texto, invariante = null) {
  const malo = (motivo) => ({ ok: false, motivo })
  // El 409 de standby se reconoce ANTES que nada: es la firma que el control negativo A persigue, y
  // fundirlo con «status-409» le quitaría al veredicto la columna que el brief exige aparte.
  if (status === 409 && /"error"\s*:\s*"standby"/.test(texto ?? '')) return malo('409-standby')
  if (status !== 200) return malo(`status-${status}`)
  const t = texto ?? ''

  switch (clase) {
    case 'healthz': {
      // El predicado canónico del proyecto: `200 ∧ phase=serving ∧ (¬lets ∨ lets.serving==lets.total)`.
      // SE PARSEA, NO SE GREPEA (hallazgo del banco V-14: la sala de espera trae `"phase":"serving"`
      // en un comentario del HTML y un extractor por regexp le cree).
      let j
      try {
        j = JSON.parse(t)
      } catch {
        return malo('cuerpo-no-json')
      }
      const phase = typeof j?.phase === 'string' ? j.phase : null
      const lets = j && typeof j.lets === 'object' && j.lets ? j.lets : null
      if (phase !== 'serving') return malo(`phase-${phase ?? 'ausente'}`)
      if (lets) {
        const total = typeof lets.total === 'number' ? lets.total : null
        const serving = typeof lets.serving === 'number' ? lets.serving : null
        if (total === null || serving === null) return malo('lets-sin-conteos')
        if (total !== serving) return malo(`lets-${serving}/${total}`)
      }
      return { ok: true, motivo: null }
    }
    case 'shell':
      return /<!doctype html/i.test(t) ? { ok: true, motivo: null } : malo('no-es-html')
    case 'guides': {
      let j
      try {
        j = JSON.parse(t)
      } catch {
        return malo('cuerpo-no-json')
      }
      if (!Array.isArray(j)) return malo('catalogo-no-es-lista')
      // Catálogo vacío = el estudiante virtual no tiene su instrumento: el generador falló o el
      // volumen no se montó. Verde ahí sería medir un 200 que no sirve para nada.
      return j.length > 0 ? { ok: true, motivo: null } : malo('catalogo-vacio')
    }
    case 'guia': {
      let j
      try {
        j = JSON.parse(t)
      } catch {
        return malo('cuerpo-no-json')
      }
      if (!j || typeof j !== 'object' || Array.isArray(j)) return malo('guia-no-es-objeto')
      return Array.isArray(j.sections) ? { ok: true, motivo: null } : malo('guia-sin-sections')
    }
    case 'progress-get': {
      let j
      try {
        j = JSON.parse(t)
      } catch {
        return malo('cuerpo-no-json')
      }
      if (!j || typeof j !== 'object' || Array.isArray(j)) return malo('progreso-no-es-objeto')
      return { ok: true, motivo: null }
    }
    case 'progress-post': {
      let j
      try {
        j = JSON.parse(t)
      } catch {
        return malo('cuerpo-no-json')
      }
      return j?.ok === true ? { ok: true, motivo: null } : malo('sin-ok-true')
    }
    case 'report':
    case 'pi': {
      if (!/<(!doctype|html)/i.test(t)) return malo('no-es-html')
      if (invariante && !t.includes(invariante)) return malo('falta-invariante')
      return { ok: true, motivo: null }
    }
    default:
      return malo(`clase-desconocida-${clase}`)
  }
}

/**
 * `SINMEDIR ≠ MAL`, del lado del transporte. Traduce el error de `fetch` al motivo que va al crudo.
 *
 * NO se decide por el texto del mensaje sino por el nombre del error y el `code` del sistema, porque
 * el texto cambia entre versiones de Node y un instrumento que dependa de eso miente en silencio.
 */
export function motivoDeFalloDeRed(err) {
  const nombre = err?.name ?? 'Error'
  const causa = err?.cause ?? {}
  const code = causa?.code ?? err?.code ?? null
  if (nombre === 'TimeoutError' || nombre === 'AbortError') return 'timeout'
  if (code === 'ECONNREFUSED') return 'rechazo'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') return 'socket-cortado'
  return `red:${code ?? nombre}`
}

/** Familias del motivo, para la tabla de errores: el 409 va aparte y «no pude medir» también. */
export function familiaDeMotivo(motivo) {
  if (motivo === null || motivo === undefined) return 'ok'
  if (motivo === '409-standby') return '409-standby'
  if (motivo === 'timeout') return 'timeout'
  if (motivo === 'rechazo') return 'rechazo'
  if (motivo === 'tope-en-vuelo') return 'tope-en-vuelo'
  const m = /^status-(\d{3})$/.exec(motivo)
  if (m) {
    const n = Number(m[1])
    if (n >= 500) return `5xx:${n}`
    if (n >= 400) return `4xx:${n}`
    return `${Math.floor(n / 100)}xx:${n}`
  }
  if (motivo.startsWith('red:') || motivo === 'dns' || motivo === 'socket-cortado') return motivo
  return `cuerpo:${motivo}`
}

// ── Percentiles ────────────────────────────────────────────────────────────────────────────────

/**
 * Percentil POR ORDEN (nearest-rank), sin librerías y sin interpolar.
 *
 * Se elige nearest-rank y no interpolación lineal porque el número tiene que ser **una latencia que
 * de verdad ocurrió**: interpolar inventa un valor intermedio que ningún request midió, y en una
 * distribución con cola (que es justo la que interesa) el promedio entre dos vecinos es el valor
 * menos representativo de los dos. `p100` es el máximo por construcción.
 *
 * Contrato: `valores` NO se muta (se ordena una copia). Lista vacía ⇒ `null`, que el reporte
 * imprime como «—» y jamás como 0: cero mediciones no es latencia cero.
 */
export function percentil(valores, p) {
  if (!Array.isArray(valores) || valores.length === 0) return null
  if (!(p > 0 && p <= 100)) throw new Error(`percentil fuera de rango: ${p}`)
  const orden = [...valores].sort((a, b) => a - b)
  const rango = Math.ceil((p / 100) * orden.length)
  return orden[Math.min(orden.length - 1, Math.max(0, rango - 1))]
}

// ── Agregación del crudo ───────────────────────────────────────────────────────────────────────

const vacio = () => ({ n: 0, ok: 0, mal: 0, sinmedir: 0, ms: [], errores: {} })

/**
 * Resume un crudo (array de registros ya parseados) en la estructura que el reporte imprime.
 *
 * DESCARTA el calentamiento (`warmup:true`) para las latencias y para el veredicto — pero lo CUENTA
 * aparte, porque «cuántas muestras se tiraron» es parte de saber si la corrida midió algo.
 */
export function resumir(registros) {
  const escalones = new Map()
  let preambulo = null
  let reverificacion = null
  const stats = []
  let warmupDescartado = 0

  for (const r of registros) {
    if (r.tipo === 'preambulo') {
      preambulo = r
      continue
    }
    if (r.tipo === 'reverificacion') {
      reverificacion = r
      continue
    }
    if (r.tipo === 'stats') {
      stats.push(r)
      continue
    }
    if (r.tipo !== 'req') continue
    if (r.warmup) {
      warmupDescartado += 1
      continue
    }
    const clave = String(r.escalon)
    if (!escalones.has(clave)) escalones.set(clave, { escalon: r.escalon, vu: r.vu ?? null, clases: new Map(), total: vacio() })
    const esc = escalones.get(clave)
    if (!esc.clases.has(r.clase)) esc.clases.set(r.clase, vacio())
    for (const acc of [esc.clases.get(r.clase), esc.total]) {
      acc.n += 1
      if (r.veredicto === 'OK') {
        acc.ok += 1
        acc.ms.push(r.ms)
      } else if (r.veredicto === 'SINMEDIR') {
        acc.sinmedir += 1
      } else {
        acc.mal += 1
        // La latencia de un MAL SÍ se guarda: un 500 en 3 s dice algo distinto que un 500 en 4 ms.
        // Pero no entra a los percentiles de OK — se reporta en su propia fila si hace falta.
      }
      const fam = familiaDeMotivo(r.veredicto === 'OK' ? null : r.motivo)
      acc.errores[fam] = (acc.errores[fam] ?? 0) + 1
    }
  }

  const salida = [...escalones.values()]
    .sort((a, b) => a.escalon - b.escalon)
    .map((esc) => ({
      escalon: esc.escalon,
      vu: esc.vu,
      clases: [...esc.clases.entries()].map(([clase, acc]) => ({ clase, ...perc(acc) })),
      total: perc(esc.total),
    }))

  return { preambulo, escalones: salida, reverificacion, stats, warmupDescartado }
}

function perc(acc) {
  return {
    n: acc.n,
    ok: acc.ok,
    mal: acc.mal,
    sinmedir: acc.sinmedir,
    p50: percentil(acc.ms, 50),
    p95: percentil(acc.ms, 95),
    p99: percentil(acc.ms, 99),
    p100: percentil(acc.ms, 100),
    errores: acc.errores,
    rps: null,
    // La tasa de fallo medido: `mal / n`. El denominador incluye SINMEDIR a propósito — si el 40 %
    // de la corrida no se pudo medir, decir «0,1 % de MAL» sobre el 60 % restante es maquillaje.
    tasaMal: acc.n === 0 ? null : acc.mal / acc.n,
  }
}

/**
 * La regla de parada de la escalera (regla 8 de la ley): un escalón **viola** si su p95 pasa el
 * umbral, si su tasa de `MAL` pasa 0,1 %, o si hubo **un solo** `SINMEDIR`.
 *
 * Devuelve `{ viola, causas }`. El p95 que se mira es el **peor entre las clases**, no el del total:
 * el total promedia un `POST` lento con cinco `GET` rápidos y esconde justo lo que se busca.
 */
export function violaUmbral(resumenEscalon, p95Max, clasesUmbral = null) {
  const causas = []
  for (const c of resumenEscalon.clases) {
    // `clasesUmbral` acota QUÉ clases mandan la parada. Existe por un confundido declarado de la
    // serie S₁: sembrar 5.000 intentos obliga a 5.000 guías más, y la clase `guides` (que enumera el
    // directorio) deja de ser comparable con S₀. Acotar la parada NO relaja el predicado —cada
    // request se sigue juzgando igual y la tabla reporta todas las clases—, solo evita que un
    // confundido conocido corte la escalera antes de medir lo que la serie vino a medir.
    if (clasesUmbral && !clasesUmbral.has(c.clase)) continue
    if (c.p95 !== null && p95Max !== null && c.p95 > p95Max) causas.push(`p95(${c.clase})=${c.p95.toFixed(1)}ms > ${p95Max}ms`)
  }
  if (resumenEscalon.total.tasaMal !== null && resumenEscalon.total.tasaMal > 0.001) {
    causas.push(`MAL=${(resumenEscalon.total.tasaMal * 100).toFixed(3)}% > 0,1%`)
  }
  if (resumenEscalon.total.sinmedir > 0) causas.push(`SINMEDIR=${resumenEscalon.total.sinmedir} > 0`)
  return { viola: causas.length > 0, causas }
}

/**
 * El veredicto del brazo de control negativo, computado DEL CRUDO.
 *
 * `standby` (CN-A): **todas** las escrituras contestaron 409 de standby, **ninguna** 200, y el
 * preámbulo vio `phase=standby`. Si alguna escritura pasó, el nodo no estaba en espera o el
 * instrumento no lo distingue: en cualquiera de los dos casos el número que siga no vale.
 *
 * `rechazo` (CN-B): 100 % `SINMEDIR` con motivo de transporte, **cero MAL y cero OK**. Un solo OK
 * significa que se midió otra cosa (otro proceso en ese puerto).
 */
export function juzgarControlNegativo(esperado, registros) {
  const reqs = registros.filter((r) => r.tipo === 'req' && !r.warmup)
  const preambulo = registros.find((r) => r.tipo === 'preambulo') ?? null
  if (reqs.length === 0) return { ok: false, detalle: 'el control negativo no emitió un solo request: no se midió nada' }

  if (esperado === 'rechazo') {
    const ok = reqs.filter((r) => r.veredicto === 'OK').length
    const mal = reqs.filter((r) => r.veredicto === 'MAL').length
    const rechazos = reqs.filter((r) => r.veredicto === 'SINMEDIR' && (r.motivo === 'rechazo' || r.motivo === 'socket-cortado')).length
    const bien = ok === 0 && mal === 0 && rechazos === reqs.length
    return {
      ok: bien,
      detalle: `${reqs.length} requests · OK=${ok} · MAL=${mal} · SINMEDIR:rechazo=${rechazos}` + (bien ? '' : ' — se esperaba 100 % SINMEDIR:rechazo, cero MAL y cero OK'),
    }
  }

  if (esperado === 'standby') {
    const escrituras = reqs.filter((r) => CLASES_ESCRITURA.has(r.clase))
    const con409 = escrituras.filter((r) => r.motivo === '409-standby').length
    const con200 = escrituras.filter((r) => r.veredicto === 'OK').length
    const fase = preambulo?.healthz?.phase ?? null
    const bien = escrituras.length > 0 && con409 === escrituras.length && con200 === 0 && fase === 'standby'
    return {
      ok: bien,
      detalle:
        `${escrituras.length} escrituras · 409-standby=${con409} · OK=${con200} · phase(preámbulo)=${fase ?? 'sin-preámbulo'}` +
        (bien ? '' : ' — se esperaba 100 % 409-standby, cero OK y phase=standby'),
    }
  }

  return { ok: false, detalle: `expectativa desconocida: ${esperado}` }
}

// ── Cero pérdidas ──────────────────────────────────────────────────────────────────────────────

/**
 * ¿El progreso releído del sujeto contiene, clave por clave, lo que el arnés envió?
 *
 * NO es igualdad de objetos: el servidor AGREGA `last_updated` (`let.ts`, antes de guardar), así que
 * exigir deep-equal total daría rojo por una diferencia que es del contrato. Se compara el
 * SUBCONJUNTO enviado — todo lo que se mandó tiene que volver idéntico —, que es la propiedad que
 * «cero pérdidas» nombra. Lo que el servidor agregue de más se reporta como `agregadas`.
 */
export function compararProgreso(enviado, releido) {
  if (releido === null || releido === undefined) return { igual: false, diferencias: ['el sujeto no devolvió progreso'], agregadas: [] }
  const diferencias = []
  for (const k of Object.keys(enviado)) {
    const a = JSON.stringify(enviado[k])
    const b = JSON.stringify(releido[k])
    if (a !== b) diferencias.push(`${k}: enviado=${recortar(a)} · releído=${recortar(b)}`)
  }
  const agregadas = Object.keys(releido ?? {}).filter((k) => !Object.prototype.hasOwnProperty.call(enviado, k))
  return { igual: diferencias.length === 0, diferencias, agregadas }
}

const recortar = (s) => (s === undefined ? 'ausente' : s.length > 120 ? `${s.slice(0, 120)}…` : s)

// ── Lectura del crudo ──────────────────────────────────────────────────────────────────────────

/** Parsea un JSONL. Una línea ilegible NO se descarta en silencio: se devuelve en `rotas`. */
export function parsearCrudo(texto) {
  const registros = []
  const rotas = []
  for (const [i, linea] of texto.split('\n').entries()) {
    if (!linea.trim()) continue
    try {
      registros.push(JSON.parse(linea))
    } catch {
      rotas.push(i + 1)
    }
  }
  return { registros, rotas }
}
