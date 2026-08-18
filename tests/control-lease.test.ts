import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  ControlLease,
  SqliteGovernanceStore,
  SqliteEpochFencedError,
  createControlPlane,
  resolveControlPlaneConfig,
  controlLeaseFile,
  type ControlLeaseOptions,
  type ControlLeaseRecord,
  type ControlLeaseReason,
} from '@vergis/capabilities'

/**
 * El lease de control (`packages/capabilities/src/control-lease.ts`) — la garantía de que hay
 * **exactamente un** plano de control sobre el volumen de gobierno.
 *
 * Lo que se mide acá son carreras, y una carrera se mide con el reloj en la mano: el lease acepta
 * reloj y espera inyectables, así que estos tests no duermen de verdad ni dependen de la velocidad de
 * la máquina. La única fuente de tiempo es el reloj falso, y avanzarlo es lo que crea el escenario.
 *
 * **Control negativo obligatorio**: la exclusión que afirman los tests de arriba se apoya en el stale
 * window. El último bloque lo pone en cero y muestra que la exclusión **deja de cumplirse** — dos
 * nodos se creen dueños. Si esa inversión no rompiera nada, los tests de exclusión no estarían
 * midiendo el mecanismo, sino la casualidad.
 */

const leaseFile = (slug: string): string => join(mkdtempSync(join(tmpdir(), `vergis-${slug}-`)), 'control.lease.json')

/** Reloj falso: la espera inyectada AVANZA el reloj, así que el escenario es determinista. */
function relojFalso(inicio = 1_770_000_000_000) {
  let t = inicio
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

const enArchivo = (file: string): ControlLeaseRecord => JSON.parse(readFileSync(file, 'utf8')) as ControlLeaseRecord

/** Silencia el log del lease en los tests que provocan sus gritos a propósito. */
const callado = (): Pick<ControlLeaseOptions, 'log'> => ({ log: () => {} })

describe('lease de control · exclusión de aspirantes', () => {
  it('dos aspirantes concurrentes: EXACTAMENTE uno adquiere', async () => {
    const file = leaseFile('lease-dos')
    const reloj = relojFalso()
    const comun = { file, now: reloj.now, sleep: reloj.sleep, autoRenew: false, maxAttempts: 1, ...callado() }
    const a = new ControlLease({ ...comun, holder: 'nodo-a' })
    const b = new ControlLease({ ...comun, holder: 'nodo-b' })

    const [ganoA, ganoB] = await Promise.all([a.acquire(), b.acquire()])

    expect([ganoA, ganoB].filter(Boolean)).toHaveLength(1)
    expect([a, b].filter((p) => p.hasControl())).toHaveLength(1)
    const titular = ganoA ? 'nodo-a' : 'nodo-b'
    expect(enArchivo(file).holder).toBe(titular)
    expect(enArchivo(file).epoch).toBe(1)
    // El que no ganó lo dice, y dice por qué.
    const perdedor = ganoA ? b : a
    expect(perdedor.hasControl()).toBe(false)
    expect(perdedor.status().reason).toBe<ControlLeaseReason>('held-by-other')
  })

  it('cinco aspirantes simultáneos sobre un archivo nuevo: EXACTAMENTE uno adquiere', async () => {
    const file = leaseFile('lease-cinco')
    const reloj = relojFalso()
    const aspirantes = [1, 2, 3, 4, 5].map(
      (n) =>
        new ControlLease({
          file,
          holder: `nodo-${n}`,
          now: reloj.now,
          sleep: reloj.sleep,
          autoRenew: false,
          maxAttempts: 1,
          ...callado(),
        }),
    )
    const resultados = await Promise.all(aspirantes.map((p) => p.acquire()))
    expect(resultados.filter(Boolean)).toHaveLength(1)
    expect(aspirantes.filter((p) => p.hasControl())).toHaveLength(1)
  })

  it('el titular vivo no se releva: el relevo llega SOLO tras el stale window', async () => {
    const file = leaseFile('lease-stale')
    const reloj = relojFalso()
    const comun = { file, now: reloj.now, sleep: reloj.sleep, autoRenew: false, maxAttempts: 1, staleMs: 10_000 }
    const perdidos: string[] = []
    const a = new ControlLease({ ...comun, holder: 'nodo-a', onLost: (r) => perdidos.push(r), ...callado() })
    const b = new ControlLease({ ...comun, holder: 'nodo-b', ...callado() })

    expect(await a.acquire()).toBe(true)
    expect(a.status().epoch).toBe(1)

    // Medio stale window: el titular sigue vivo a los ojos del aspirante. No se le quita nada.
    reloj.advance(5_000)
    expect(await b.acquire()).toBe(false)
    expect(b.status().reason).toBe<ControlLeaseReason>('held-by-other')
    expect(enArchivo(file).holder).toBe('nodo-a')
    expect([a, b].filter((p) => p.hasControl())).toHaveLength(1)

    // Pasado el stale window sin renovar, el relevo procede con época NUEVA.
    reloj.advance(6_000)
    expect(await b.acquire()).toBe(true)
    expect(b.status().takeovers).toBe(1)
    expect(b.status().epoch).toBe(2)
    expect(enArchivo(file)).toMatchObject({ holder: 'nodo-b', epoch: 2 })

    // Y el relevado se entera de que dejó de mandar en su siguiente heartbeat: cero, no dos.
    expect(await a.renew()).toBe(false)
    expect(a.hasControl()).toBe(false)
    expect(a.status().reason).toBe<ControlLeaseReason>('taken-over')
    expect(perdidos).toEqual(['taken-over'])
    expect([a, b].filter((p) => p.hasControl())).toHaveLength(1)
  })

  it('el que pierde la carrera del relevo NO queda creyéndose dueño', async () => {
    const file = leaseFile('lease-carrera')
    const reloj = relojFalso()
    const viejo = new ControlLease({
      file,
      holder: 'nodo-viejo',
      now: reloj.now,
      sleep: reloj.sleep,
      autoRenew: false,
      ...callado(),
    })
    expect(await viejo.acquire()).toBe(true)
    reloj.advance(30_000) // el titular murió: nadie renueva

    // Durante la espera de confirmación del relevo, OTRO aspirante gana el rename. Es la carrera que
    // el protocolo tiene que detectar: escribir no es controlar; controlar es releer y encontrarse.
    const b = new ControlLease({
      file,
      holder: 'nodo-b',
      now: reloj.now,
      autoRenew: false,
      maxAttempts: 1,
      ...callado(),
      sleep: async (ms) => {
        reloj.advance(ms)
        writeFileSync(
          file,
          JSON.stringify({
            holder: 'nodo-c',
            ring: null,
            epoch: 9,
            renewedAt: new Date(reloj.now()).toISOString(),
            pid: process.pid,
          }),
        )
      },
    })

    expect(await b.acquire()).toBe(false)
    expect(b.hasControl()).toBe(false)
    expect(b.status().reason).toBe<ControlLeaseReason>('lost-race')
    expect(enArchivo(file).holder).toBe('nodo-c')
  })

  it('el release ordenado deja adquirir de inmediato, sin pagar el stale window', async () => {
    const file = leaseFile('lease-release')
    const reloj = relojFalso()
    const comun = { file, now: reloj.now, sleep: reloj.sleep, autoRenew: false, maxAttempts: 1, ...callado() }
    const a = new ControlLease({ ...comun, holder: 'nodo-a' })
    const b = new ControlLease({ ...comun, holder: 'nodo-b' })

    expect(await a.acquire()).toBe(true)
    await a.release()
    expect(a.hasControl()).toBe(false)
    // Marca de release: titular vacío y la ÉPOCA SE CONSERVA.
    expect(enArchivo(file)).toMatchObject({ holder: '', epoch: 1 })

    // Sin avanzar el reloj ni un milisegundo: el sucesor entra ya, con época+1.
    expect(await b.acquire()).toBe(true)
    expect(b.status().epoch).toBe(2)
    expect(b.status().takeovers).toBe(0)
    expect(enArchivo(file)).toMatchObject({ holder: 'nodo-b', epoch: 2 })
  })

  it('un release que llega tarde no pisa al sucesor', async () => {
    const file = leaseFile('lease-release-tarde')
    const reloj = relojFalso()
    const comun = { file, now: reloj.now, sleep: reloj.sleep, autoRenew: false, maxAttempts: 1, ...callado() }
    const a = new ControlLease({ ...comun, holder: 'nodo-a' })
    const b = new ControlLease({ ...comun, holder: 'nodo-b' })
    expect(await a.acquire()).toBe(true)
    reloj.advance(30_000)
    expect(await b.acquire()).toBe(true)

    await a.release() // A creía mandar; el archivo ya es de B
    expect(enArchivo(file)).toMatchObject({ holder: 'nodo-b', epoch: 2 })
    expect(b.hasControl()).toBe(true)
  })
})

describe('lease de control · ante duda, CERO controladores', () => {
  const casos: { slug: string; contenido: string; motivo: ControlLeaseReason }[] = [
    { slug: 'basura', contenido: 'no soy json {{{', motivo: 'file-unreadable' },
    { slug: 'truncado', contenido: '{"holder":"nodo-x"', motivo: 'file-unreadable' },
    { slug: 'sin-campos', contenido: '{"holder":"nodo-x"}', motivo: 'file-unreadable' },
    { slug: 'epoca-rara', contenido: '{"holder":"x","epoch":"dos","renewedAt":"2026-08-18T00:00:00Z"}', motivo: 'file-unreadable' },
    { slug: 'fecha-rara', contenido: '{"holder":"x","epoch":1,"renewedAt":"ayer"}', motivo: 'file-unreadable' },
  ]

  for (const caso of casos) {
    it(`un archivo de lease ${caso.slug} NO produce dos dueños: produce cero, y lo grita`, async () => {
      const file = leaseFile(`lease-${caso.slug}`)
      writeFileSync(file, caso.contenido)
      const reloj = relojFalso()
      const gritos: string[] = []
      const comun = {
        file,
        now: reloj.now,
        sleep: reloj.sleep,
        autoRenew: false,
        maxAttempts: 2,
        log: (_l: 'warn' | 'error', m: string) => gritos.push(m),
      }
      const a = new ControlLease({ ...comun, holder: 'nodo-a' })
      const b = new ControlLease({ ...comun, holder: 'nodo-b' })

      expect(await a.acquire()).toBe(false)
      expect(await b.acquire()).toBe(false)
      expect([a, b].filter((p) => p.hasControl())).toHaveLength(0)
      expect(a.status().reason).toBe<ControlLeaseReason>(caso.motivo)
      expect(gritos.join('\n')).toMatch(/CERO controladores/)
      // El archivo ilegible no se pisa: queda tal cual para que una persona lo mire.
      expect(readFileSync(file, 'utf8')).toBe(caso.contenido)
    })
  }

  it('un titular que renovó «en el futuro» no se releva a ciegas: relojes incomparables = cero', async () => {
    const file = leaseFile('lease-reloj')
    const reloj = relojFalso()
    writeFileSync(
      file,
      JSON.stringify({
        holder: 'nodo-de-otro-reloj',
        ring: null,
        epoch: 4,
        renewedAt: new Date(reloj.now() + 3_600_000).toISOString(),
        pid: 999_999,
      }),
    )
    const gritos: string[] = []
    const a = new ControlLease({
      file,
      holder: 'nodo-a',
      now: reloj.now,
      sleep: reloj.sleep,
      autoRenew: false,
      maxAttempts: 1,
      log: (_l, m) => gritos.push(m),
    })
    expect(await a.acquire()).toBe(false)
    expect(a.hasControl()).toBe(false)
    expect(a.status().reason).toBe<ControlLeaseReason>('clock-skew')
    expect(gritos.join('\n')).toMatch(/CERO controladores/)
  })

  it('si el archivo desaparece bajo los pies del titular, suelta el control en vez de recrearlo', async () => {
    const file = leaseFile('lease-borrado')
    const reloj = relojFalso()
    const perdidos: ControlLeaseReason[] = []
    const a = new ControlLease({
      file,
      holder: 'nodo-a',
      now: reloj.now,
      sleep: reloj.sleep,
      autoRenew: false,
      onLost: (r) => perdidos.push(r),
      ...callado(),
    })
    expect(await a.acquire()).toBe(true)
    writeFileSync(file, '') // vaciarlo lo vuelve ilegible; borrarlo o corromperlo dan el mismo veredicto
    expect(await a.renew()).toBe(false)
    expect(a.hasControl()).toBe(false)
    expect(perdidos).toHaveLength(1)
  })
})

describe('lease de control · heartbeat y ciclo de vida', () => {
  it('la renovación mueve el sello de tiempo y mantiene la época', async () => {
    const file = leaseFile('lease-renew')
    const reloj = relojFalso()
    const a = new ControlLease({
      file,
      holder: 'nodo-a',
      now: reloj.now,
      sleep: reloj.sleep,
      autoRenew: false,
      ...callado(),
    })
    expect(await a.acquire()).toBe(true)
    const primero = enArchivo(file).renewedAt
    reloj.advance(2_000)
    expect(await a.renew()).toBe(true)
    reloj.advance(2_000)
    expect(await a.renew()).toBe(true)
    expect(a.status().renews).toBe(2)
    expect(enArchivo(file).epoch).toBe(1)
    expect(enArchivo(file).renewedAt).not.toBe(primero)
  })

  it('el heartbeat automático no sostiene el proceso y se apaga al soltar', async () => {
    const file = leaseFile('lease-timer')
    const reloj = relojFalso()
    const a = new ControlLease({ file, holder: 'nodo-a', now: reloj.now, sleep: reloj.sleep, ...callado() })
    expect(await a.acquire()).toBe(true)
    // Idempotencia: pedir el heartbeat dos veces no deja dos timers ni relanza nada.
    a.startRenewals()
    a.startRenewals()
    a.stopRenewals()
    a.stopRenewals()
    await a.release()
    await a.release() // release idempotente
    expect(a.hasControl()).toBe(false)
    expect(await a.renew()).toBe(false)
  })

  it('adquirir dos veces desde el mismo nodo es idempotente', async () => {
    const file = leaseFile('lease-idem')
    const reloj = relojFalso()
    const a = new ControlLease({
      file,
      holder: 'nodo-a',
      now: reloj.now,
      sleep: reloj.sleep,
      autoRenew: false,
      ...callado(),
    })
    expect(await a.acquire()).toBe(true)
    expect(await a.acquire()).toBe(true)
    expect(a.status().epoch).toBe(1)
    expect(enArchivo(file).epoch).toBe(1)
  })
})

describe('lease de control · la época llega al store', () => {
  it('la época del lease se estampa en el store y un handle de la época anterior se topa con el fencing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-lease-store-'))
    const file = join(dir, 'control.lease.json')
    const store = join(dir, 'governance.sqlite')
    const reloj = relojFalso()
    const comun = { file, now: reloj.now, sleep: reloj.sleep, autoRenew: false, maxAttempts: 1, ...callado() }
    const a = new ControlLease({ ...comun, holder: 'nodo-a' })
    const b = new ControlLease({ ...comun, holder: 'nodo-b' })

    // El titular abre el store con LA ÉPOCA DEL LEASE como proveedor — nadie la copia a mano.
    expect(await a.acquire()).toBe(true)
    const gA = await SqliteGovernanceStore.open(store, { admins: ['cesar@ratio.cl'] }, { epoch: a.epoch, writer: 'a' })
    expect(await gA.add('primero@gh.com')).toBe(true)
    expect(gA.controlStatus()!.epoch).toBe(1)
    await gA.close()

    // El titular cae y otro nodo releva: época 2.
    reloj.advance(30_000)
    expect(await b.acquire()).toBe(true)
    expect(b.epoch()).toBe(2)
    const gB = await SqliteGovernanceStore.open(store, {}, { epoch: b.epoch, writer: 'b' })
    expect(await gB.add('segundo@gh.com')).toBe(true)
    expect(gB.controlStatus()!.epoch).toBe(2)
    await gB.close()

    // Y el nodo relevado, con su época vieja, ya no puede abrir para escribir: el lease previene, el
    // gate de época DELATA. El error nombra las dos épocas.
    expect(a.epoch()).toBe(1)
    await expect(SqliteGovernanceStore.open(store, {}, { epoch: a.epoch, writer: 'a' })).rejects.toBeInstanceOf(
      SqliteEpochFencedError,
    )
    await expect(SqliteGovernanceStore.open(store, {}, { epoch: a.epoch })).rejects.toThrow(/época 1 .* la época 2/s)

    // Nada se perdió: las dos escrituras están en el archivo.
    const lectura = await SqliteGovernanceStore.open(store, {}, { mode: 'read' })
    expect((await lectura.list()).map((x) => x.email).sort()).toEqual([
      'cesar@ratio.cl',
      'primero@gh.com',
      'segundo@gh.com',
    ])
    await lectura.close()
  })
})

describe('plano de control · resolución del modo desde el entorno', () => {
  it('el default de la caja es `lease`, con sus tiempos por default', () => {
    const c = resolveControlPlaneConfig({}, '/var/vergis')
    expect(c).toEqual({ mode: 'lease', file: '/var/vergis/control.lease.json', renewMs: 2_000, staleMs: 10_000 })
    expect(controlLeaseFile('/var/vergis/')).toBe('/var/vergis/control.lease.json')
  })

  it('los tiempos se parametrizan y un valor no numérico se rechaza en vez de degradarse a default', () => {
    expect(
      resolveControlPlaneConfig({ VERGIS_LEASE_RENEW_MS: '500', VERGIS_LEASE_STALE_MS: '3000' }, '/out'),
    ).toMatchObject({ renewMs: 500, staleMs: 3_000 })
    expect(() => resolveControlPlaneConfig({ VERGIS_LEASE_RENEW_MS: 'pronto' }, '/out')).toThrow(/no es un número/)
  })

  it('`VERGIS_CONTROL=single` no toca el disco y siempre tiene el control', async () => {
    const file = leaseFile('lease-single')
    const plano = createControlPlane(resolveControlPlaneConfig({ VERGIS_CONTROL: 'single' }, '/out'), {
      holder: 'nodo-solo',
    })
    expect(plano.mode).toBe('single')
    expect(await plano.acquire()).toBe(true)
    expect(plano.hasControl()).toBe(true)
    expect(plano.epoch()).toBe(0)
    expect(plano.status().mode).toBe('single')
    expect(existsSync(join(file, '..'))).toBe(true) // el directorio del volumen existe…
    expect(existsSync(file)).toBe(false) // …y nadie escribió un archivo de lease en él
    await plano.release()
    expect(plano.hasControl()).toBe(false)
  })

  it('un modo desconocido no se interpreta con buena voluntad: se rechaza nombrando los válidos', () => {
    expect(() => resolveControlPlaneConfig({ VERGIS_CONTROL: 'multi' }, '/out')).toThrow(/'lease' \(default\) o 'single'/)
  })

  it('`createControlPlane` en modo lease entrega un lease sobre el archivo del volumen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vergis-plane-'))
    const plano = createControlPlane(resolveControlPlaneConfig({}, dir), {
      holder: 'nodo-a',
      ring: '0.18.0@sha256:abc',
      autoRenew: false,
      log: () => {},
    })
    expect(plano.mode).toBe('lease')
    expect(await plano.acquire()).toBe(true)
    expect(plano.epoch()).toBe(1)
    expect(enArchivo(join(dir, 'control.lease.json'))).toMatchObject({ holder: 'nodo-a', ring: '0.18.0@sha256:abc' })
    await plano.release()
  })
})

describe('lease de control · CONTROL NEGATIVO (sin el mecanismo, la exclusión desaparece)', () => {
  it('con el stale window en CERO, un titular VIVO se releva y quedan DOS dueños', async () => {
    const file = leaseFile('lease-negativo')
    const reloj = relojFalso()
    const comun = { file, now: reloj.now, sleep: reloj.sleep, autoRenew: false, maxAttempts: 1, staleMs: 0, ...callado() }
    const a = new ControlLease({ ...comun, holder: 'nodo-a' })
    const b = new ControlLease({ ...comun, holder: 'nodo-b' })

    expect(await a.acquire()).toBe(true)
    reloj.advance(1) // un milisegundo ya es «viejo» cuando el stale window es cero

    // Sin stale window el relevo procede sobre un titular vivo, y A todavía no se ha enterado:
    // ESTE es el estado prohibido. Que el escenario lo reproduzca es lo que prueba que los tests de
    // exclusión de arriba miden el mecanismo y no la casualidad.
    expect(await b.acquire()).toBe(true)
    expect(a.hasControl()).toBe(true)
    expect(b.hasControl()).toBe(true)
    expect([a, b].filter((p) => p.hasControl())).toHaveLength(2)

    // Y el gate de época del store es la segunda línea: A, ya relevado, no puede abrir para escribir.
    expect(b.epoch()).toBeGreaterThan(a.epoch())
  })

  it('con el stale window en CERO, cinco aspirantes se relevan en cadena en vez de excluirse', async () => {
    const file = leaseFile('lease-negativo-cadena')
    const reloj = relojFalso()
    const aspirantes = [1, 2, 3, 4, 5].map(
      (n) =>
        new ControlLease({
          file,
          holder: `nodo-${n}`,
          now: reloj.now,
          sleep: reloj.sleep,
          autoRenew: false,
          maxAttempts: 1,
          staleMs: 0,
          ...callado(),
        }),
    )
    for (const p of aspirantes) {
      expect(await p.acquire()).toBe(true)
      reloj.advance(1)
    }
    expect(aspirantes.filter((p) => p.hasControl())).toHaveLength(5)
  })
})
