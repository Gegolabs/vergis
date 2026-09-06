/**
 * El arnés de carga de H1, probado donde puede mentir: el cálculo de percentiles y el clasificador
 * `OK | MAL | SINMEDIR`.
 *
 * POR QUÉ ESTOS DOS Y NO OTROS. Un arnés de carga es un instrumento, y el corolario de la Norma 7
 * exige que un instrumento demuestre que **sabe reportar su propio fallo**. Los dos modos de mentira
 * de este instrumento son:
 *
 *   · el percentil que se calcula mal — un p95 optimista convierte un techo en un número inventado, y
 *     nadie lo nota porque el número «se ve razonable»;
 *   · el clasificador que confunde «no pude medir» con «medí y salió mal» — que es exactamente la
 *     familia de fallos que costó las cuatro mediciones ciegas de Cibeles.
 *
 * Hay UN CASO POR CLASE DE ERROR (gate del brief): 2xx que no cumple el cuerpo, 4xx, 5xx, el 409 de
 * standby contado aparte, el timeout y el rechazo de socket.
 */
import { describe, it, expect } from 'vitest'
import {
  juzgar,
  percentil,
  familiaDeMotivo,
  motivoDeFalloDeRed,
  resumir,
  violaUmbral,
  juzgarControlNegativo,
  compararProgreso,
  parsearCrudo,
} from '../deploy/carga/lib.mjs'

describe('percentil — por orden, sin interpolar', () => {
  it('devuelve un valor que EXISTE en la muestra (nearest-rank, no interpolación)', () => {
    const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    expect(percentil(v, 50)).toBe(50)
    expect(percentil(v, 95)).toBe(100)
    expect(percentil(v, 99)).toBe(100)
    expect(percentil(v, 100)).toBe(100)
    // La propiedad que importa: todo percentil es una latencia realmente medida.
    for (const p of [1, 25, 50, 75, 90, 95, 99, 100]) expect(v).toContain(percentil(v, p))
  })

  it('p95 de 100 muestras es la 95ª por orden — el caso donde la interpolación se desviaría', () => {
    const v = [...Array(100)].map((_, i) => i + 1) // 1..100
    expect(percentil(v, 50)).toBe(50)
    expect(percentil(v, 95)).toBe(95)
    expect(percentil(v, 99)).toBe(99)
    expect(percentil(v, 100)).toBe(100)
  })

  it('NO muta la muestra que recibe', () => {
    const v = [3, 1, 2]
    percentil(v, 50)
    expect(v).toEqual([3, 1, 2])
  })

  it('sin muestras devuelve null, JAMÁS 0 — cero mediciones no es latencia cero', () => {
    expect(percentil([], 95)).toBeNull()
  })

  it('un percentil fuera de rango es un error, no un silencio', () => {
    expect(() => percentil([1, 2], 0)).toThrow()
    expect(() => percentil([1, 2], 101)).toThrow()
  })
})

describe('juzgar — el predicado, completo y por clase', () => {
  it('healthz: 200 no basta; exige phase=serving y lets.serving==lets.total', () => {
    expect(juzgar('healthz', 200, JSON.stringify({ ok: true, phase: 'serving' })).ok).toBe(true)
    expect(juzgar('healthz', 200, JSON.stringify({ ok: true, phase: 'serving', lets: { total: 1, serving: 1 } })).ok).toBe(true)
    // Un standby responde 200 con ok:true POR DISEÑO: juzgar por código HTTP lo declararía sano.
    const standby = juzgar('healthz', 200, JSON.stringify({ ok: true, phase: 'standby' }))
    expect(standby.ok).toBe(false)
    expect(standby.motivo).toBe('phase-standby')
    const degradado = juzgar('healthz', 200, JSON.stringify({ ok: false, phase: 'serving', lets: { total: 9, serving: 8 } }))
    expect(degradado).toEqual({ ok: false, motivo: 'lets-8/9' })
  })

  it('healthz: SE PARSEA, NO SE GREPEA — un HTML con la cadena "phase":"serving" adentro es MAL', () => {
    const salaDeEspera = '<!doctype html><!-- el predicado del borde es "phase":"serving" --><p>volvemos en un momento</p>'
    expect(juzgar('healthz', 200, salaDeEspera)).toEqual({ ok: false, motivo: 'cuerpo-no-json' })
  })

  it('progress-post: un 200 sin ok:true es FALLO MEDIDO, no éxito', () => {
    expect(juzgar('progress-post', 200, '{"ok":true}').ok).toBe(true)
    expect(juzgar('progress-post', 200, '{"ok":false,"error":"locked"}')).toEqual({ ok: false, motivo: 'sin-ok-true' })
    expect(juzgar('progress-post', 200, 'no soy json')).toEqual({ ok: false, motivo: 'cuerpo-no-json' })
  })

  it('guides: un catálogo vacío es MAL — un 200 que no sirve para nada no es verde', () => {
    expect(juzgar('guides', 200, '[{"id":"carga-000"}]').ok).toBe(true)
    expect(juzgar('guides', 200, '[]')).toEqual({ ok: false, motivo: 'catalogo-vacio' })
    expect(juzgar('guides', 200, '{"id":"x"}')).toEqual({ ok: false, motivo: 'catalogo-no-es-lista' })
  })

  it('guia: exige el objeto con sections; un JSON cualquiera no pasa', () => {
    expect(juzgar('guia', 200, '{"sections":[{"exercises":[]}]}').ok).toBe(true)
    expect(juzgar('guia', 200, '{"title":"sin secciones"}')).toEqual({ ok: false, motivo: 'guia-sin-sections' })
  })

  it('report y pi: exigen HTML Y el invariante de contenido — un 200 vacío no pasa', () => {
    const html = '<!doctype html><title>PI 01 · Asistencia por Área</title><body>…</body>'
    expect(juzgar('pi', 200, html, 'PI 01 · Asistencia por Área').ok).toBe(true)
    expect(juzgar('pi', 200, html, 'PI 07 · otra cosa')).toEqual({ ok: false, motivo: 'falta-invariante' })
    expect(juzgar('report', 200, '', 'lo que sea')).toEqual({ ok: false, motivo: 'no-es-html' })
  })

  it('shell: 200 con algo que no es HTML es MAL', () => {
    expect(juzgar('shell', 200, '<!DOCTYPE html><html></html>').ok).toBe(true)
    expect(juzgar('shell', 200, '{"ok":true}')).toEqual({ ok: false, motivo: 'no-es-html' })
  })
})

describe('el clasificador, un caso por clase de error', () => {
  it('409 de standby: se reconoce ANTES que el status genérico y se cuenta APARTE', () => {
    const cuerpo = JSON.stringify({ ok: false, error: 'standby', message: 'Este nodo está en espera…' })
    const j = juzgar('progress-post', 409, cuerpo)
    expect(j).toEqual({ ok: false, motivo: '409-standby' })
    expect(familiaDeMotivo(j.motivo)).toBe('409-standby')
    // Un 409 que NO es de standby no se disfraza de standby.
    expect(juzgar('progress-post', 409, '{"ok":false,"error":"otro"}')).toEqual({ ok: false, motivo: 'status-409' })
  })

  it('4xx y 5xx: fallo MEDIDO, con el código en su propia familia', () => {
    expect(familiaDeMotivo(juzgar('guia', 404, '{"error":"not-found"}').motivo)).toBe('4xx:404')
    expect(familiaDeMotivo(juzgar('progress-post', 403, '{"error":"locked"}').motivo)).toBe('4xx:403')
    expect(familiaDeMotivo(juzgar('progress-post', 500, 'boom').motivo)).toBe('5xx:500')
    expect(familiaDeMotivo(juzgar('progress-get', 503, '{"error":"store-cerrado"}').motivo)).toBe('5xx:503')
  })

  it('timeout y rechazo: NO PUDE MEDIR ≠ MEDÍ Y SALIÓ MAL', () => {
    expect(motivoDeFalloDeRed({ name: 'TimeoutError' })).toBe('timeout')
    expect(motivoDeFalloDeRed({ name: 'AbortError' })).toBe('timeout')
    expect(motivoDeFalloDeRed({ name: 'TypeError', cause: { code: 'ECONNREFUSED' } })).toBe('rechazo')
    expect(motivoDeFalloDeRed({ name: 'TypeError', cause: { code: 'ECONNRESET' } })).toBe('socket-cortado')
    expect(motivoDeFalloDeRed({ name: 'TypeError', cause: { code: 'ENOTFOUND' } })).toBe('dns')
    // El nombre y el `code` mandan, NUNCA el texto del mensaje (que cambia entre versiones de Node).
    expect(motivoDeFalloDeRed({ name: 'TypeError', message: 'fetch failed' })).toBe('red:TypeError')
    for (const m of ['timeout', 'rechazo', 'tope-en-vuelo']) expect(familiaDeMotivo(m)).toBe(m)
  })
})

describe('resumir y la regla de parada', () => {
  const req = (o: Record<string, unknown>) => ({ tipo: 'req', escalon: 1, clase: 'progress-post', ms: 10, veredicto: 'OK', motivo: null, t0: 0, t1: 10, ...o })

  it('descarta el calentamiento de las latencias pero lo CUENTA', () => {
    const res = resumir([req({ warmup: true, ms: 9999 }), req({ warmup: false, ms: 10 }), req({ warmup: false, ms: 20 })])
    expect(res.warmupDescartado).toBe(1)
    expect(res.escalones[0]!.total.n).toBe(2)
    expect(res.escalones[0]!.total.p100).toBe(20)
  })

  it('la tasa de MAL se calcula sobre TODAS las muestras, SINMEDIR incluido — no sobre las que sí se midieron', () => {
    const regs = [
      ...[...Array(60)].map(() => req({ warmup: false })),
      ...[...Array(40)].map(() => req({ warmup: false, veredicto: 'SINMEDIR', motivo: 'timeout' })),
      req({ warmup: false, veredicto: 'MAL', motivo: 'status-500' }),
    ]
    const res = resumir(regs)
    // 1 MAL de 101 muestras = 0,99 %. Sobre las 61 «medidas» daría 1,6 %; sobre las 60 OK, 1,7 %.
    // El denominador correcto es el total: decir «0,1 %» sobre el subconjunto que se midió es maquillaje.
    expect(res.escalones[0]!.total.tasaMal).toBeCloseTo(1 / 101, 6)
  })

  it('viola por p95 de la PEOR clase, no por el p95 del total', () => {
    const res = resumir([
      ...[...Array(100)].map(() => req({ warmup: false, clase: 'shell', ms: 5 })),
      ...[...Array(100)].map(() => req({ warmup: false, clase: 'progress-post', ms: 500 })),
    ])
    const esc = res.escalones[0]!
    // El total promediaría a ~500 en p95 igual, pero con 1 POST lento entre 100 GET rápidos el total
    // lo escondería. Lo que se comprueba acá es que la causa NOMBRA la clase.
    const v = violaUmbral(esc, 200)
    expect(v.viola).toBe(true)
    expect(v.causas.join(' ')).toContain('progress-post')
    // Y que acotar las clases que paran no cambia el juicio de las demás, solo la parada.
    expect(violaUmbral(esc, 200, new Set(['shell'])).viola).toBe(false)
  })

  it('UN SOLO SINMEDIR viola: ausencia de evidencia no es evidencia de aguante', () => {
    const res = resumir([req({ warmup: false }), req({ warmup: false, veredicto: 'SINMEDIR', motivo: 'timeout' })])
    expect(violaUmbral(res.escalones[0]!, 100000).causas.join(' ')).toContain('SINMEDIR')
  })
})

describe('los brazos de control negativo — un verde inesperado NO pasa en silencio', () => {
  it('CN-A (standby): pide 100 % 409, cero OK y phase=standby en el preámbulo', () => {
    const preambulo = { tipo: 'preambulo', healthz: { phase: 'standby' } }
    const post = (o: Record<string, unknown>) => ({ tipo: 'req', clase: 'progress-post', warmup: false, ...o })
    expect(
      juzgarControlNegativo('standby', [preambulo, post({ veredicto: 'MAL', motivo: '409-standby' }), post({ veredicto: 'MAL', motivo: '409-standby' })]).ok,
    ).toBe(true)
    // Una sola escritura que pasa invalida el brazo: el nodo no estaba en espera, o el arnés no lo ve.
    expect(juzgarControlNegativo('standby', [preambulo, post({ veredicto: 'MAL', motivo: '409-standby' }), post({ veredicto: 'OK', motivo: null })]).ok).toBe(false)
    // Sin preámbulo que confirme la fase tampoco vale: el 409 podría venir de otra causa.
    expect(juzgarControlNegativo('standby', [post({ veredicto: 'MAL', motivo: '409-standby' })]).ok).toBe(false)
  })

  it('CN-B (rechazo): pide 100 % SINMEDIR:rechazo, cero MAL y cero OK', () => {
    const r = (o: Record<string, unknown>) => ({ tipo: 'req', clase: 'shell', warmup: false, ...o })
    expect(juzgarControlNegativo('rechazo', [r({ veredicto: 'SINMEDIR', motivo: 'rechazo' }), r({ veredicto: 'SINMEDIR', motivo: 'rechazo' })]).ok).toBe(true)
    // Un solo OK significa que HAY alguien en ese puerto: se midió otra cosa.
    expect(juzgarControlNegativo('rechazo', [r({ veredicto: 'SINMEDIR', motivo: 'rechazo' }), r({ veredicto: 'OK', motivo: null })]).ok).toBe(false)
    // Un timeout NO es un rechazo: hay algo que acepta la conexión y no contesta.
    expect(juzgarControlNegativo('rechazo', [r({ veredicto: 'SINMEDIR', motivo: 'timeout' })]).ok).toBe(false)
  })

  it('una corrida sin un solo request no es un control negativo verde: es no haber medido', () => {
    expect(juzgarControlNegativo('rechazo', []).ok).toBe(false)
    expect(juzgarControlNegativo('standby', [{ tipo: 'preambulo', healthz: { phase: 'standby' } }]).ok).toBe(false)
  })
})

describe('cero pérdidas', () => {
  const enviado = { guideId: 'carga-000', currentSection: 1, sections: { 0: { answers: [{ choice: 1, conf: 'S' }] } }, totalSections: 3 }

  it('el `last_updated` que agrega el servidor NO cuenta como pérdida', () => {
    const c = compararProgreso(enviado, { ...enviado, last_updated: '2026-09-05T00:00:00.000Z' })
    expect(c.igual).toBe(true)
    expect(c.agregadas).toEqual(['last_updated'])
  })

  it('una respuesta perdida SÍ cuenta', () => {
    const c = compararProgreso(enviado, { ...enviado, sections: { 0: { answers: [] } } })
    expect(c.igual).toBe(false)
    expect(c.diferencias[0]).toContain('sections')
  })

  it('sin progreso releído es pérdida, no «igual por vacío»', () => {
    expect(compararProgreso(enviado, null).igual).toBe(false)
  })
})

describe('el crudo', () => {
  it('una línea ilegible se REPORTA, no se descarta en silencio', () => {
    const { registros, rotas } = parsearCrudo('{"tipo":"req"}\n{roto\n\n{"tipo":"fin"}\n')
    expect(registros).toHaveLength(2)
    expect(rotas).toEqual([2])
  })
})
