/**
 * EL INTENT DE HANDOVER — el relevo DIRIGIDO (#232, cierre parcial · diseño «flip-first»).
 *
 * Qué está en juego. El release ordenado deja una marca (`holder:''`) que cualquier anillo caliente
 * puede tomar: quien suelta no nombra sucesor, así que el relevo es una CARRERA y el ganador no es
 * necesariamente el que se quiso promover. El intent —`control.handover.json`, hermano del lease en
 * el mismo volumen— nombra al sucesor **antes** de que el activo suelte.
 *
 * Lo que el intent hace, y lo que NO:
 *
 *  · **Ordena la fila**: el no-nombrado se abstiene de aspirar; el nombrado aspira YA, saltándose la
 *    ventana de gracia que se impone a sí mismo el nodo que acaba de soltar.
 *  · **Jamás otorga el control**: adquirir sigue siendo `acquire()` con sus reglas enteras. Por eso
 *    el cierre de #232 es **PARCIAL por diseño**: `releaseSync()` deja `{holder:'', epoch}` y
 *    `#attempt()` concede ese archivo al PRIMERO que llegue sin mirar quién, así que el intent ordena
 *    la fila SOLO entre quienes pasan por `intentarRelevo`; la marca de release sigue siendo subasta
 *    abierta para cualquier camino que no pase por ahí.
 *
 * Los cuatro casos que este archivo mide son los cuatro que, de fallar, habrían salido distinto:
 * el nombrado adquiere ya · el no-nombrado se abstiene · un intent vencido no manda · el crash del
 * sucesor no congela el relevo. Más el quinto que protege el camino degradado: sin watch, el poll de
 * respaldo alcanza — porque la decisión RE-LEE el archivo en cada llamada, no en un evento.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlLease, controlHandoverFile, controlLeaseFile, evaluarRelevo, readHandoverIntent } from '@vergis/capabilities'

const CANDIDATO = 'vergis-0-19-0'
const PREVIO = 'vergis-0-18-0'

describe('intent de handover · el relevo dirigido', () => {
  let dir: string
  let intent: string
  let lease: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vergis-intent-'))
    intent = controlHandoverFile(dir)
    lease = controlLeaseFile(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Escribe el intent tal como lo hace la herramienta de anillos. */
  function escribirIntent(successor: string, vigenciaMs: number, ahora = Date.now()): void {
    writeFileSync(intent, `${JSON.stringify({ successor, expiresAt: new Date(ahora + vigenciaMs).toISOString() }, null, 2)}\n`)
  }

  it('el SUCESOR NOMBRADO aspira ya, aunque su ventana de gracia siga abierta', () => {
    const ahora = Date.now()
    escribirIntent(CANDIDATO, 10_000, ahora)
    // La gracia vence dentro de 8 s: sin el intent, este nodo NO aspiraría.
    const sinIntent = evaluarRelevo({ file: join(dir, 'no-existe.json'), self: CANDIDATO, noAspirarHasta: ahora + 8_000, now: ahora })
    expect(sinIntent.aspirar).toBe(false)
    // Con el intent que lo nombra, sí — y lo dice: la gracia se salta a propósito, no por olvido.
    const d = evaluarRelevo({ file: intent, self: CANDIDATO, noAspirarHasta: ahora + 8_000, now: ahora })
    expect(d).toMatchObject({ aspirar: true, verdict: 'nombrado', saltaGracia: true })
  })

  it('el NO NOMBRADO se abstiene mientras el intent esté vigente (y sin intent sí aspiraría)', () => {
    const ahora = Date.now()
    escribirIntent(CANDIDATO, 10_000, ahora)
    // Control negativo del propio test: sin intent, el previo aspira (es la carrera de hoy).
    expect(evaluarRelevo({ file: join(dir, 'no-existe.json'), self: PREVIO, noAspirarHasta: 0, now: ahora }).aspirar).toBe(true)
    const d = evaluarRelevo({ file: intent, self: PREVIO, noAspirarHasta: 0, now: ahora })
    expect(d).toMatchObject({ aspirar: false, verdict: 'ajeno' })
    expect(d.detail).toContain(CANDIDATO)
    // Un nodo SIN identidad de anillo tampoco es el sucesor: se abstiene igual, sin caso especial.
    expect(evaluarRelevo({ file: intent, self: null, noAspirarHasta: 0, now: ahora }).aspirar).toBe(false)
  })

  it('un intent VENCIDO no manda: rige el protocolo de siempre', () => {
    const ahora = Date.now()
    escribirIntent(CANDIDATO, 5_000, ahora)
    // Vigente: el previo se abstiene.
    expect(evaluarRelevo({ file: intent, self: PREVIO, noAspirarHasta: 0, now: ahora + 4_000 }).aspirar).toBe(false)
    // Vencido: ni ordena la fila ni exime de la gracia.
    const vencido = evaluarRelevo({ file: intent, self: PREVIO, noAspirarHasta: 0, now: ahora + 6_000 })
    expect(vencido).toMatchObject({ aspirar: true, verdict: 'vencido', saltaGracia: false })
    // Y al nombrado tampoco lo exime: pasado el plazo vuelve a pagar su propia ventana de gracia.
    const nombrado = evaluarRelevo({ file: intent, self: CANDIDATO, noAspirarHasta: ahora + 60_000, now: ahora + 6_000 })
    expect(nombrado).toMatchObject({ aspirar: false, verdict: 'vencido', saltaGracia: false })
  })

  it('el CRASH DEL SUCESOR no congela el relevo: pasado el plazo, otro toma el control', async () => {
    const ahora = Date.now()
    // La herramienta nombró al candidato… y el candidato murió antes de aspirar. Nadie controla.
    escribirIntent(CANDIDATO, 5_000, ahora)
    const previo = new ControlLease({ file: lease, holder: PREVIO, renewMs: 50, staleMs: 200, maxAttempts: 1, autoRenew: false })

    // Durante la vigencia, el previo se abstiene: no aspira aunque el control esté libre.
    expect(evaluarRelevo({ file: intent, self: PREVIO, noAspirarHasta: 0, now: ahora + 1_000 }).aspirar).toBe(false)
    expect(previo.hasControl()).toBe(false)

    // Vencido el intent, el protocolo de siempre vuelve a regir y el previo SÍ toma el control.
    const d = evaluarRelevo({ file: intent, self: PREVIO, noAspirarHasta: 0, now: ahora + 6_000 })
    expect(d.aspirar).toBe(true)
    expect(await previo.acquire()).toBe(true)
    expect(previo.hasControl()).toBe(true)
    previo.stopRenewals()
  })

  it('SIN WATCH, el poll de respaldo alcanza: la decisión re-lee el archivo en cada llamada', async () => {
    // Ni un watcher instalado. El intent aparece DESPUÉS de la primera consulta —el caso del evento
    // perdido (inotify no propagado por un bind-mount)— y la siguiente vuelta del poll lo ve.
    const ahora = Date.now()
    expect(evaluarRelevo({ file: intent, self: CANDIDATO, noAspirarHasta: ahora + 8_000, now: ahora }))
      .toMatchObject({ aspirar: false, verdict: 'sin-intent' })
    escribirIntent(CANDIDATO, 10_000, ahora)
    expect(evaluarRelevo({ file: intent, self: CANDIDATO, noAspirarHasta: ahora + 8_000, now: ahora + 2_000 }))
      .toMatchObject({ aspirar: true, verdict: 'nombrado' })

    // Y el relevo dirigido termina en un `acquire()` de verdad, con la marca de release del activo.
    const activo = new ControlLease({ file: lease, holder: PREVIO, renewMs: 50, staleMs: 10_000, maxAttempts: 1, autoRenew: false })
    expect(await activo.acquire()).toBe(true)
    activo.releaseSync()
    const candidato = new ControlLease({ file: lease, holder: CANDIDATO, renewMs: 50, staleMs: 10_000, maxAttempts: 1, autoRenew: false })
    expect(await candidato.acquire()).toBe(true)
    // La época es monótona: el intent no la alteró — ordenó la fila, no otorgó nada.
    expect(candidato.status().epoch).toBe(2)
    candidato.stopRenewals()
  })

  it('un intent ILEGIBLE no manda ni congela: se degrada al protocolo de siempre, ruidosamente', () => {
    writeFileSync(intent, '{"successor": ')
    const d = evaluarRelevo({ file: intent, self: PREVIO, noAspirarHasta: 0 })
    expect(d).toMatchObject({ aspirar: true, verdict: 'ilegible' })
    expect(d.detail).toBeTruthy()
    // Y un intent sin sucesor tampoco se interpreta con buena voluntad.
    writeFileSync(intent, JSON.stringify({ successor: '', expiresAt: new Date(Date.now() + 9_000).toISOString() }))
    expect(readHandoverIntent(intent, PREVIO).verdict).toBe('ilegible')
  })

  it('el intent NO toca el lease: quien no pasa por la decisión sigue ganando la subasta (#232 parcial)', async () => {
    // La afirmación honesta del alcance, medida: con un intent vigente que nombra al candidato, un
    // aspirante que llama `acquire()` DIRECTO —sin consultar el intent— se lleva la marca de release.
    // Es la mitad de #232 que este frente NO cierra, y así queda dicho.
    escribirIntent(CANDIDATO, 30_000)
    const activo = new ControlLease({ file: lease, holder: PREVIO, renewMs: 50, staleMs: 10_000, maxAttempts: 1, autoRenew: false })
    expect(await activo.acquire()).toBe(true)
    activo.releaseSync()
    const colado = new ControlLease({ file: lease, holder: 'vergis-colado', renewMs: 50, staleMs: 10_000, maxAttempts: 1, autoRenew: false })
    expect(await colado.acquire()).toBe(true)
    expect(JSON.parse(readFileSync(lease, 'utf8')).holder).toBe('vergis-colado')
    colado.stopRenewals()
  })
})
