import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  SqliteGovernanceStore,
  SqliteMasterDataStore,
  SqliteAdminStore,
  parseMasterDataConfig,
  parseDomainsConfig,
  parseIntakeConfig,
  parseRunFileOutcomes,
  runLogFileName,
  expectedInLanding,
  type IntakeSlot,
  type OneLakeEntry,
  type OneLakeListing,
  type RunRecord,
} from '@vergis/capabilities'
import { declaracionDeArchivo } from '../packages/capabilities/src/run-logs'
import { nombreCanonico, slotProcessedDir, slotsQueCalzan, nombresAmbiguos } from '../packages/capabilities/src/intake'
import { leerRetiro } from '../packages/capabilities/src/intake-observability'
import { createIntakeLoop, resolverEstadoDeCarga, type CorridaConLog, type IntakeLoopDeps, type RetiroDeCarga } from '../server/intake-loop'
import { createAdmin, validarEnLaPuerta, avisoDeDuplicado, type AdminHandler } from '../server/admin'
import { chipDeCarga, motivoDeRechazo, señalDeContrato, type CargasOps, type IntakeUploadEvent } from '../server/admin-cargas'
import type { Notification } from '../server/notify'
import { parseNotifyConfig } from '../server/notify'

/**
 * Los tests sintéticos de work/269 §6.1 (P1 · «Verdad»): cada mecanismo del diseño con la corrida que lo
 * habría refutado. Datos SINTÉTICOS: ningún nombre, correo ni número de la instancia real — los casos
 * reales viven en el oráculo del lab (`lab/local/269-oraculo/`), fuera de este repo por diseño.
 */
const T0 = Date.parse('2026-09-01T12:00:00.000Z')
const iso = (minDesdeT0: number): string => new Date(T0 + minDesdeT0 * 60_000).toISOString()

const archivoEn = (dir: string, name: string, mtime = iso(0)): OneLakeEntry => ({ path: `${dir}/${name}`, isDirectory: false, size: 10, lastModified: mtime })
const corrida = (inicioMin: number, finMin: number | null, status: RunRecord['status'], texto: string | null, log: CorridaConLog['log'] = texto == null ? 'sin-log' : 'match'): CorridaConLog => {
  const run: RunRecord = { startedAt: iso(inicioMin), status }
  if (finMin != null) run.endedAt = iso(finMin)
  return { run, log, texto }
}
const carga = (name: string, subidaMin = 0, id = 1) => ({ id, filename: name, uploadedAt: iso(subidaMin) })
const LANDING = 'Files/intake/ventas'
const resolver = (
  c: { id: number; filename: string; uploadedAt: string },
  cs: CorridaConLog[],
  over: { landing?: OneLakeEntry[]; archivados?: OneLakeEntry[]; retiros?: RetiroDeCarga[]; reemplazos?: { uploadedAt: string }[]; contratoDesde?: string; nowMs?: number } = {},
) =>
  resolverEstadoDeCarga(c, cs, over.landing ?? [], over.archivados ?? [], over.retiros ?? [], over.reemplazos ?? [], {
    nowMs: over.nowMs ?? T0 + 24 * 3_600_000,
    ...(over.contratoDesde ? { contratoDesde: over.contratoDesde } : {}),
  })

describe('#269·A · una corrida que no nombra el archivo no dice nada de él', () => {
  it('✔ x en la corrida A y una corrida B Failed que declara ✖ y: x queda procesada', () => {
    const r = resolver(carga('x.xlsx'), [
      corrida(1, 3, 'Completed', '[intake] ✔ procesado: x.xlsx\n'),
      corrida(10, 12, 'Failed', '[intake] ✖ fallido: y.xlsx — faltan columnas\n[job] ✖ ABORTADO: 1 archivo con error\n'),
    ])
    expect(r).toMatchObject({ estado: 'procesada', final: true, via: 'declaracion', runStartedAt: iso(1) })
  })

  it('control: la MISMA corrida B, si nombrara x, sí la declararía fallida (el test distingue)', () => {
    const r = resolver(carga('x.xlsx'), [corrida(10, 12, 'Failed', '[intake] ✖ fallido: x.xlsx — faltan columnas\n')])
    expect(r).toMatchObject({ estado: 'fallida', motivo: 'faltan columnas' })
  })

  it('un log con gramática que no nombra el archivo, en una corrida Failed, NO lo vuelve fallida', () => {
    const r = resolver(carga('x.xlsx'), [corrida(10, 12, 'Failed', '[intake] ✖ fallido: y.xlsx — otra cosa\n')], { landing: [archivoEn(LANDING, 'x.xlsx')] })
    expect(r.estado).toBeNull() // sigue en el landing, sin declaración: «Recibido»
  })
})

describe('#269·B · D1 · el estado avanza: falló, siguió en espera, y se cargó', () => {
  it('✖ en la corrida 1, nada en la 2, ✔ en la 3 ⇒ procesada, con los dos intentos observados', () => {
    const r = resolver(carga('x.xlsx'), [
      corrida(1, 2, 'Failed', '[intake] ✖ fallido: x.xlsx — falta el maestro ⟦referencia-ausente/tienda-sin-zona faltan=58⟧\n'),
      corrida(5, 6, 'Completed', '[intake] ✔ procesado: otro.xlsx\n'),
      corrida(9, 10, 'Completed', '[intake] ✔ procesado: x.xlsx\n'),
    ])
    expect(r).toMatchObject({ estado: 'procesada', final: true, runStartedAt: iso(9) })
    expect(r.intentos.map((i) => i.resultado)).toEqual(['fallida', 'procesada'])
    expect(r.intentos[0]).toMatchObject({ codigo: 'referencia-ausente/tienda-sin-zona', params: { faltan: '58' } })
  })

  it('en el lazo, con el store real: la carga pasa por fallida y termina procesada, con su historia', async () => {
    const a = await arnes()
    const id = await a.subir('x.xlsx', -10)
    a.runs.push({ startedAt: iso(-5), endedAt: iso(-4), status: 'Failed' })
    a.logs[iso(-5)] = '[intake] ✖ fallido: x.xlsx — falta el maestro\n'
    a.landing.push(archivoEn(LANDING, 'x.xlsx', iso(-10)))
    await a.loop.tick()
    expect((await a.fila(id))?.desenlace).toBe('fallida')
    expect(a.avisosUsuario).toHaveLength(1)

    a.runs.push({ startedAt: iso(20), endedAt: iso(21), status: 'Completed' })
    a.logs[iso(20)] = '[intake] ✔ procesado: x.xlsx\n'
    a.landing.splice(0)
    a.clock.ms = T0 + 30 * 60_000
    await a.loop.tick()
    const fila = await a.fila(id)
    expect(fila).toMatchObject({ desenlace: 'procesada', desenlaceFinal: true, desenlaceRunStartedAt: iso(20) })
    expect((await a.store.listIntentos(id)).map((i) => i.resultado)).toEqual(['fallida', 'procesada'])
    expect(a.avisosUsuario).toHaveLength(1) // procesada no manda correo
  })
})

describe('#269·C · retiros en sus TRES formas de nombre (§3.4)', () => {
  const sello = Date.parse(iso(30))
  const otroSello = Date.parse(iso(90))
  const formas: [string, string, RetiroDeCarga['via']][] = [
    ['Retirar', `${sello}-x.xlsx`, 'retirar'],
    ['Revertir', `${sello}-revertido-x.xlsx`, 'revertir'],
    ['rename a mano', `${sello}-retirado-${otroSello}-x.xlsx`, 'rename'],
  ]
  for (const [nombre, base, via] of formas) {
    it(`${nombre}: «${base.replace(/\d{13}/g, '<ts>')}» cierra la carga como retirada, al instante del PRIMER sello`, () => {
      // El mtime del rename es el del ORIGINAL (anterior a la subida): creerle al mtime lo descartaría.
      const r0 = leerRetiro({ path: `Files/intake/_retirado/${base}`, isDirectory: false, lastModified: iso(-600) })!
      expect(r0).toEqual({ filename: 'x.xlsx', at: iso(30), via })
      const r = resolver(carga('x.xlsx'), [corrida(1, 2, 'Completed', '[intake] ⚠ saltado: x.xlsx — el lote vino encogido\n')], {
        retiros: [{ filename: r0.filename, at: r0.at, via: r0.via! }],
      })
      expect(r).toMatchObject({ estado: 'retirada', final: true, via: 'retiro', actoAt: iso(30) })
      expect(r.ultimoIntento?.resultado).toBe('saltada')
    })
  }

  it('un retiro ANTERIOR a la subida no la cierra (retiró otra carga del mismo nombre)', () => {
    const r = resolver(carga('x.xlsx', 60), [], { retiros: [{ filename: 'x.xlsx', at: iso(30), via: 'retirar' }], landing: [archivoEn(LANDING, 'x.xlsx', iso(60))] })
    expect(r.estado).toBeNull()
  })

  it('una reversión (con id) cierra SOLO su carga', () => {
    const rev: RetiroDeCarga = { filename: 'x.xlsx', at: iso(30), via: 'revertir', uploadId: 7 }
    expect(resolver(carga('x.xlsx', 0, 7), [], { retiros: [rev] }).estado).toBe('retirada')
    expect(resolver(carga('x.xlsx', 0, 8), [], { retiros: [rev], landing: [archivoEn(LANDING, 'x.xlsx')] }).estado).toBeNull()
  })

  it('otros caminos (`_cargado-manual-*`, `_sin-metadata/`) NO son retiro: la carga queda sin informe', () => {
    const r = resolver(carga('x.xlsx'), [corrida(1, 2, 'Completed', '[intake] ✔ procesado: otro.xlsx\n')])
    expect(r).toMatchObject({ estado: 'sin-informe', via: 'fuera-sin-declaracion', final: false })
  })
})

describe('#269·D · la re-subida con el mismo nombre cierra la anterior', () => {
  it('fallida y después re-subida ⇒ reemplazada, con el último intento', () => {
    const r = resolver(carga('m.xlsx'), [corrida(1, 2, 'Failed', '[intake] ✖ fallido: m.xlsx — faltan 3 tiendas\n')], { reemplazos: [{ uploadedAt: iso(20) }] })
    expect(r).toMatchObject({ estado: 'reemplazada', final: true, actoAt: iso(20) })
    expect(r.ultimoIntento).toMatchObject({ resultado: 'fallida', motivo: 'faltan 3 tiendas' })
  })

  it('la corrida posterior a la re-subida NO se le atribuye a la carga reemplazada', () => {
    const r = resolver(carga('m.xlsx'), [corrida(30, 31, 'Completed', '[intake] ✔ procesado: m.xlsx\n')], { reemplazos: [{ uploadedAt: iso(20) }] })
    expect(r.estado).toBe('reemplazada') // el ✔ es de la versión nueva
  })
})

describe('#269·F/G · la ausencia no se vuelve resultado', () => {
  it('F · salió del landing tras una Completed, sin declaración ⇒ sin-informe (nunca «procesada»)', () => {
    expect(resolver(carga('x.xlsx'), [corrida(1, 2, 'Completed', null, 'sin-log')]).estado).toBe('sin-informe')
  })

  it('G · la edad no es estado: días en el landing sin corrida ⇒ sin estado', () => {
    expect(resolver(carga('x.xlsx'), [], { landing: [archivoEn(LANDING, 'x.xlsx', iso(-5000))] }).estado).toBeNull()
  })

  it('P30 · declarado «saltado» y archivado igual: gana la declaración y se marca la contradicción', () => {
    const r = resolver(carga('x.xlsx'), [corrida(1, 2, 'Completed', '[intake] ⚠ saltado: x.xlsx — sin motivo claro\n')], {
      archivados: [archivoEn('Files/intake/_processed/inv', `${Date.parse(iso(3))}-x.xlsx`, iso(3))],
    })
    expect(r).toMatchObject({ estado: 'saltada', contradiccion: true })
  })
})

describe('#269·P26 · el nombre con « - » (el lector no adivina dónde termina)', () => {
  const NOMBRE = '20260101 - Recepción y Facturación Vivero.xlsx'
  it('`✔ procesado: <fecha> - <resto>.xlsx` se lee con el archivo COMPLETO', () => {
    expect(parseRunFileOutcomes(`[intake] ✔ procesado: ${NOMBRE}\n`)).toEqual([{ file: NOMBRE, outcome: 'procesado' }])
  })

  it('`✖ fallido` sin raya: el corte vale solo en el « - » cuya izquierda termina en extensión', () => {
    expect(parseRunFileOutcomes(`[intake] ✖ fallido: ${NOMBRE} - faltan columnas\n`)).toEqual([{ file: NOMBRE, outcome: 'fallido', motivo: 'faltan columnas' }])
  })

  it('el resolvedor compara contra el NOMBRE CONOCIDO: la carga se declara aunque el nombre traiga « - »', () => {
    expect(declaracionDeArchivo(`[intake] ✔ procesado: ${NOMBRE}\n`, NOMBRE)).toEqual({ outcome: 'procesado' })
    expect(resolver(carga(NOMBRE), [corrida(1, 2, 'Completed', `[intake] ✔ procesado: ${NOMBRE}\n`)]).estado).toBe('procesada')
  })

  it('un nombre que es prefijo de otro no se confunde con él', () => {
    expect(declaracionDeArchivo('[intake] ✔ procesado: ventas.xlsx.bak\n', 'ventas.xlsx')).toBeUndefined()
    expect(declaracionDeArchivo('[intake] ✖ fallido: Files/intake/ventas/ventas.xlsx — x\n', 'ventas.xlsx')).toEqual({ outcome: 'fallido', motivo: 'x' })
  })
})

describe('#269·P27 · la corrida que YA estaba en curso cuando se subió el archivo', () => {
  it('arrancó 15 s antes de la subida, terminó después y declaró ✔ ⇒ procesada', () => {
    const r = resolverEstadoDeCarga(
      { id: 1, filename: 'x.xlsx', uploadedAt: new Date(T0 + 15_000).toISOString() },
      [corrida(0, 2, 'Completed', '[intake] ✔ procesado: x.xlsx\n')],
      [], [], [], [], { nowMs: T0 + 3_600_000 },
    )
    expect(r.estado).toBe('procesada')
  })

  it('control: una corrida que TERMINÓ antes de la subida no pudo tomarlo', () => {
    const r = resolverEstadoDeCarga(
      { id: 1, filename: 'x.xlsx', uploadedAt: iso(5) },
      [corrida(0, 2, 'Completed', '[intake] ✔ procesado: x.xlsx\n')],
      [archivoEn(LANDING, 'x.xlsx', iso(5))], [], [], [], { nowMs: T0 + 3_600_000 },
    )
    expect(r.estado).toBeNull()
  })

  it('una corrida en curso reciente detiene la conclusión («Cargando»); una NotStarted de hace días, no', () => {
    const enCurso = resolver(carga('x.xlsx'), [corrida(1, null, 'InProgress', null, 'en-curso')], { nowMs: T0 + 10 * 60_000 })
    expect(enCurso).toMatchObject({ estado: null, enCurso: true })
    const muerta = resolver(carga('x.xlsx'), [corrida(1, null, 'NotStarted', null, 'en-curso'), corrida(30, 31, 'Completed', '[intake] ✔ procesado: x.xlsx\n')], { nowMs: T0 + 5 * 86_400_000 })
    expect(muerta).toMatchObject({ estado: 'procesada', enCurso: false })
  })
})

describe('#269·§3.1 · el puente histórico, anclado a `contrato_desde`', () => {
  const CONTRATO = iso(24 * 60) // el proceso declara por archivo desde el día siguiente
  const PROC = 'Files/intake/_processed/k'

  it('carga ANTERIOR al contrato, sin declaración, con su copia archivada antes del ancla ⇒ procesada (puente)', () => {
    const r = resolver(carga('x.xlsx'), [corrida(1, 2, 'Completed', null, 'sin-log')], { archivados: [archivoEn(PROC, 'x.xlsx', iso(2))], contratoDesde: CONTRATO })
    expect(r).toMatchObject({ estado: 'procesada', final: true, via: 'puente', copia: `${PROC}/x.xlsx` })
  })

  it('M5 · carga BAJO contrato con todos sus logs purgados y copia archivada ⇒ sin-informe', () => {
    const c = carga('x.xlsx', 48 * 60)
    const r = resolver(c, [corrida(48 * 60 + 1, 48 * 60 + 2, 'Failed', null, 'purgado')], { archivados: [archivoEn(PROC, 'x.xlsx', iso(48 * 60 + 2))], contratoDesde: CONTRATO })
    expect(r.estado).toBe('sin-informe')
  })

  it('control de M5: el MISMO caso con un ancla que no ancla nada (2099) cruza el puente — el test distingue', () => {
    const c = carga('x.xlsx', 48 * 60)
    const r = resolver(c, [corrida(48 * 60 + 1, 48 * 60 + 2, 'Failed', null, 'purgado')], { archivados: [archivoEn(PROC, 'x.xlsx', iso(48 * 60 + 2))], contratoDesde: '2099-01-01T00:00:00.000Z' })
    expect(r.estado).toBe('procesada')
  })

  it('copia archivada DESPUÉS del ancla no cuenta, aunque la carga sea anterior', () => {
    const r = resolver(carga('x.xlsx'), [], { archivados: [archivoEn(PROC, `${Date.parse(iso(30 * 60))}-x.xlsx`, iso(30 * 60))], contratoDesde: CONTRATO })
    expect(r.estado).toBe('sin-informe')
  })

  it('slot SIN `contrato_desde`: no hay puente (fail-closed)', () => {
    const r = resolver(carga('x.xlsx'), [], { archivados: [archivoEn(PROC, 'x.xlsx', iso(2))] })
    expect(r.estado).toBe('sin-informe')
  })

  it('`contrato_desde` se parsea del slot; una fecha ilegible rompe el parse (no apaga el puente en silencio)', () => {
    const base = { id: 's', label: 'S', target: { workspaceId: 'W', lakehouseId: 'L', path: 'Files/intake/s' } }
    expect(parseIntakeConfig({ slots: [{ ...base, contrato_desde: '2026-08-16T19:17:36Z' }] })[0]!.contratoDesde).toBe('2026-08-16T19:17:36.000Z')
    expect(() => parseIntakeConfig({ slots: [{ ...base, contrato_desde: 'ayer' }] })).toThrow(/contrato_desde/)
  })
})

describe('#269·V11/V12 · lo que declara la instancia: `target.processed` y `contacto`', () => {
  const base = { id: 's', label: 'S', target: { workspaceId: 'W', lakehouseId: 'L', path: 'Files/intake/fact' } }
  it('processed: ruta declarada, `false` o la convención de siempre', () => {
    const [conRuta, sinArchivo, porDefecto] = parseIntakeConfig({
      slots: [
        { ...base, id: 'a', target: { ...base.target, processed: 'Files/intake/fact/_processed' } },
        { ...base, id: 'b', target: { ...base.target, processed: false } },
        { ...base, id: 'c' },
      ],
    })
    expect(slotProcessedDir(conRuta!)).toBe('Files/intake/fact/_processed')
    expect(slotProcessedDir(sinArchivo!)).toBeNull()
    expect(slotProcessedDir(porDefecto!)).toBe('Files/intake/_processed')
    expect(() => parseIntakeConfig({ slots: [{ ...base, target: { ...base.target, processed: 'Tables/x' } }] })).toThrow(/processed/)
  })

  it('contacto de la raíz lo hereda cada slot; uno propio manda; no-correo se acusa', () => {
    const [a, b] = parseIntakeConfig({ contacto: 'mesa@ejemplo.cl', slots: [{ ...base, id: 'a' }, { ...base, id: 'b', contacto: 'otra@ejemplo.cl' }] })
    expect([a!.contacto, b!.contacto]).toEqual(['mesa@ejemplo.cl', 'otra@ejemplo.cl'])
    expect(() => parseIntakeConfig({ contacto: 'nadie', slots: [base] })).toThrow(/contacto/)
  })

  it('el flujo `cargas-operador` se puede declarar en notify', () => {
    const cfg = parseNotifyConfig({ destinations: [{ id: 'op', type: 'webhook', url: 'https://hook.ejemplo.cl/x', events: ['cargas-operador'] }] })
    expect(cfg.destinations[0]!.events).toEqual(['cargas-operador'])
  })
})

describe('#269·V5 · expectedInLanding no espera lo que ya está en un estado final', () => {
  it('7 cargas procesadas y el motor sin corridas ⇒ no se espera ninguna (antes: las 7, y CONTRADICE)', () => {
    const cargas = Array.from({ length: 7 }, (_, i) => ({ filename: `f${i}.xlsx`, uploadedAt: iso(i), ok: true, final: true }))
    expect(expectedInLanding(cargas, [], [])).toEqual([])
    // Control: las mismas sin la marca de final se siguen esperando (el test distingue).
    expect(expectedInLanding(cargas.map(({ final: _f, ...c }) => c), [], [])).toHaveLength(7)
  })
})

describe('#269·§4.1 · la puerta: NFC, disjunción y el nombre que ya se recibió', () => {
  const slot = (id: string, accept: string): IntakeSlot => ({ id, label: id.toUpperCase(), domain: 'd', accept, target: { workspaceId: 'W', lakehouseId: 'L', path: `Files/intake/${id}` } })
  const SALDOS = slot('saldos', 'Antig?edad de saldos *.xlsx')
  const PROD = slot('prod', '*products-details*.xlsx')
  const DIST = slot('dist', '*details*.xlsx')

  it('NFD («u» + diéresis combinante) no calza con `?`; en su forma canónica (NFC), sí', () => {
    const nfd = 'Antigüedad de saldos clientes W1.xlsx'
    expect(nfd).not.toBe(nfd.normalize('NFC'))
    expect(validarEnLaPuerta([SALDOS], SALDOS, nfd, 10).ok).toBe(false) // control: sin normalizar, rechaza
    expect(validarEnLaPuerta([SALDOS], SALDOS, nombreCanonico(nfd), 10)).toEqual({ ok: true })
  })

  it('un nombre que calza con DOS tipos no aterriza, aunque calce con el de la tarjeta', () => {
    const v = validarEnLaPuerta([PROD, DIST], PROD, 'oc-1-products-details-01-01-2026.xlsx', 10)
    expect(v).toMatchObject({ ok: false, reason: 'ambiguo' })
    expect(slotsQueCalzan([PROD, DIST], 'oc-1-distributions-details.xlsx').map((s) => s.id)).toEqual(['dist'])
    expect(nombresAmbiguos([PROD, DIST], ['oc-1-products-details.xlsx', 'oc-1-distributions-details.xlsx'])).toEqual([{ nombre: 'oc-1-products-details.xlsx', slots: ['prod', 'dist'] }])
  })

  it('el nombre que ya se RECIBIÓ en un tipo y hoy no calza con ninguno: el mensaje dice que ese archivo cambió de nombre', async () => {
    const h = await adminArnes([slot('inv', '*Vivero*.xlsx')])
    await h.store.recordUpload({ slotId: 'inv', filename: '20260101 - Inventario Vivero 2026.xlsx', sha256: 'a'.repeat(64), bytes: 10, uploadedBy: 'x@ejemplo.cl', uploadedAt: iso(-100), ok: true, triggered: false, origen: 'upload' })
    // La instancia cambió el patrón: el nombre viejo ya no calza con ningún tipo.
    h.slots.splice(0, 1, slot('inv', '*Recepcion Vivero*.xlsx'))
    const res = await h.subir('inv', '20260101 - Inventario Vivero 2026.xlsx')
    const msg = decodeURIComponent(res.headers['location'] ?? '')
    expect(msg).toContain('Este archivo se recibió antes como «INV», pero ese archivo ahora tiene que llamarse así: «*Recepcion Vivero*.xlsx».')
    // Control: un nombre que NUNCA se recibió se rechaza con el mensaje de siempre.
    const otro = decodeURIComponent((await h.subir('inv', 'Libro1.xlsx')).headers['location'] ?? '')
    expect(otro).toContain('no coincide con el patrón esperado')
    expect(otro).not.toContain('se recibió antes')
  })

  it('en la subida real el nombre se registra en NFC', async () => {
    const h = await adminArnes([SALDOS])
    const nfd = 'Antigüedad de saldos clientes W1.xlsx'
    const res = await h.subir('saldos', nfd)
    expect(decodeURIComponent(res.headers['location'] ?? '')).toContain('Recibimos 1 archivo(s).')
    expect((await h.store.listUploads('saldos', 5))[0]!.filename).toBe(nfd.normalize('NFC'))
  })
})

describe('#269·V4 · el aviso de duplicado dice solo lo que es cierto', () => {
  const fila = (over: Partial<Parameters<typeof avisoDeDuplicado>[0]> = {}) => ({
    id: 5, slotId: 's', filename: 'x.xlsx', sha256: 'a'.repeat(64), bytes: 1, uploadedBy: 'ana@ejemplo.cl', uploadedAt: '2026-09-01T10:00:00Z', ok: true, triggered: true, origen: 'upload' as const, ...over,
  })
  const ins = (over: Partial<Parameters<typeof avisoDeDuplicado>[1]> = {}) => ({ cargas: [], landing: new Set<string>(), ...over })
  it('cargada y vigente ⇒ «no cambia nada»', () => {
    expect(avisoDeDuplicado(fila({ desenlace: 'procesada' }), ins(), T0).texto).toBe('Ya se cargó este mismo archivo el 2026-09-01 10:00 UTC (ana@ejemplo.cl). Subirlo de nuevo no cambia nada.')
  })
  it('cargada pero PISADA por una carga posterior del mismo nombre ⇒ sin la promesa', () => {
    const pisada = fila({ id: 9, desenlace: 'procesada', uploadedAt: '2026-09-02T10:00:00Z', sha256: 'b'.repeat(64) })
    expect(avisoDeDuplicado(fila({ desenlace: 'procesada' }), ins({ cargas: [pisada] }), T0).texto).not.toContain('no cambia nada')
  })
  it('en espera (sigue en el landing) ⇒ se vuelve a intentar solo', () => {
    expect(avisoDeDuplicado(fila({ desenlace: 'fallida' }), ins({ landing: new Set(['x.xlsx']) }), T0).texto).toContain('todavía está en espera: se vuelve a intentar solo')
  })
  it('no cargada y fuera del landing (la 223) ⇒ «esa vez no se cargó», nunca «no cambia nada»', () => {
    const t = avisoDeDuplicado(fila({ desenlace: 'retirada' }), ins(), T0).texto
    expect(t).toContain('esa vez no se cargó: se retiró antes de cargarse')
    expect(t).not.toContain('no cambia nada')
  })
  it('todavía cargándose', () => {
    expect(avisoDeDuplicado(fila({ uploadedAt: new Date(T0 - 4 * 60_000).toISOString() }), ins(), T0).texto).toBe('Subiste este mismo archivo hace 4 minutos y todavía se está cargando.')
  })
})

describe('#269·V7/V10 · lo que ve la consola: chip y frase de cada estado', () => {
  const h = (over: Partial<IntakeUploadEvent> = {}): IntakeUploadEvent => ({ ts: iso(0), filename: 'x.xlsx', bytes: 10, by: 'a@ejemplo.cl', ok: true, triggered: true, ...over })
  it('sin estado ⇒ «Recibido»; con una corrida en curso ⇒ «Cargando»', () => {
    expect(chipDeCarga(h()).chip).toContain('Recibido')
    expect(chipDeCarga(h(), { enCurso: true }).chip).toContain('⏳ Cargando')
    expect(chipDeCarga(h({ desenlace: 'fallida', desenlaceFinal: false }), { enCurso: true }).chip).toContain('⏳ Cargando')
  })
  it('retirada / reemplazada / deshecha dicen qué pasó y cuándo', () => {
    expect(chipDeCarga(h({ desenlace: 'retirada', desenlaceFinal: true, actoAt: iso(30) })).frase).toBe(`Se retiró el ${iso(30).slice(0, 10)} ${iso(30).slice(11, 16)} UTC; no se cargó.`)
    expect(chipDeCarga(h({ desenlace: 'reemplazada', desenlaceFinal: true, actoAt: iso(30) })).frase).toContain('esta versión no se cargó')
    expect(chipDeCarga(h({ desenlace: 'deshecha', desenlaceFinal: true })).chip).toContain('Deshecho')
  })
  it('rechazo en la puerta: «No se recibió» con el motivo humanizado (no calza)', () => {
    const c = chipDeCarga(h({ ok: false, error: "El nombre 'x.xlsx' no coincide con el patrón esperado «*Tiendas*.xlsx»." }))
    expect(c.chip).toContain('No se recibió')
    expect(c.frase).toContain('no calza')
    expect(motivoDeRechazo('El archivo (2000000 bytes) excede el máximo del slot (1048576 bytes).')).toBe('Pesa 1.9 MB y el máximo es 1 MB.')
  })
  it('procesada después de un intento fallido: «En el primer intento: …»', () => {
    const c = chipDeCarga(
      h({ desenlace: 'procesada', desenlaceFinal: true, desenlaceRunStartedAt: iso(9), intentos: [{ id: 1, uploadId: 1, runStartedAt: iso(1), resultado: 'fallida', motivo: 'falta el maestro', observadoAt: iso(2), origen: 'declaracion' }] }),
      { tituloDeIntento: (i) => i.motivo ?? '' },
    )
    expect(c.frase).toContain('En el primer intento: falta el maestro.')
  })
  it('sin-informe: la línea de aviso sale solo si es cierta', () => {
    expect(chipDeCarga(h({ desenlace: 'sin-informe', desenlaceFinal: false })).frase).not.toMatch(/avis/i)
    expect(chipDeCarga(h({ desenlace: 'sin-informe', desenlaceFinal: false }), { aviso: 'Avísale a mesa@ejemplo.cl.' }).frase).toContain('Avísale a mesa@ejemplo.cl.')
  })
})

describe('#269·§3.1 · la señal de contrato de la vista técnica', () => {
  const slot: IntakeSlot = { id: 's', label: 'S', target: { workspaceId: 'W', lakehouseId: 'L', path: 'Files/intake/s' } }
  it('nombra lo que salió fuera de contrato, la contradicción declaración/archivo y la falta de contacto', () => {
    const history: IntakeUploadEvent[] = [
      { ts: iso(0), filename: 'fuera.xlsx', bytes: 1, by: 'a', ok: true, triggered: true, desenlace: 'sin-informe', desenlaceFinal: false },
      { ts: iso(0), filename: 'contra.xlsx', bytes: 1, by: 'a', ok: true, triggered: true, desenlace: 'saltada', desenlaceFinal: false, desenlaceRunStartedAt: iso(1) },
      { ts: iso(0), filename: 'sin-log.xlsx', bytes: 1, by: 'a', ok: true, triggered: true, desenlace: 'sin-informe', desenlaceFinal: false, desenlaceRunStartedAt: iso(1) },
    ]
    const html = señalDeContrato(slot, { history, archived: [archivoEn('Files/intake/_processed/k', `${Date.parse(iso(2))}-contra.xlsx`, iso(2))] }, new Set(), false)
    expect(html).toContain('salió fuera de contrato')
    expect(html).toContain('<b>fuera.xlsx</b>')
    expect(html).not.toContain('sin-log.xlsx') // esa sí tuvo corrida: su falta de informe es del proceso, no de un camino
    expect(html).toContain('archivó un archivo que declaró no cargado: <b>contra.xlsx</b>')
    expect(html).toContain('Falta declarar <code>contacto</code>')
    expect(señalDeContrato({ ...slot, contacto: 'mesa@ejemplo.cl' }, { history: [], archived: [] }, new Set(), false)).toBe('')
  })
})

describe('#269·V12 · aviso al operador y al usuario, en el lazo', () => {
  it('sin-informe ⇒ UN aviso al operador (dedup por carga) y el usuario lee «Le avisamos…» solo con destino', async () => {
    const a = await arnes({ operador: true })
    const id = await a.subir('x.xlsx', -10)
    a.runs.push({ startedAt: iso(-5), endedAt: iso(-4), status: 'Failed' }) // sin log: sin-informe
    await a.loop.tick()
    expect((await a.fila(id))?.desenlace).toBe('sin-informe')
    expect(a.avisosOperador).toHaveLength(1)
    expect(a.avisosOperador[0]!.data).toMatchObject({ event: 'carga-operador', uploadId: id, via: 'sin-log' })
    expect(a.avisosUsuario[0]!.lines).toContain('Le avisamos al equipo de la plataforma.')
    a.clock.ms = T0 + 60 * 60_000
    await a.loop.tick()
    expect(a.avisosOperador).toHaveLength(1)
  })

  it('sin destino del operador y con contacto ⇒ el usuario lee «Avísale a …»; sin ninguno, ninguna línea', async () => {
    const conContacto = await arnes({ contacto: 'mesa@ejemplo.cl' })
    await conContacto.subir('x.xlsx', -10)
    conContacto.runs.push({ startedAt: iso(-5), endedAt: iso(-4), status: 'Failed' })
    await conContacto.loop.tick()
    expect(conContacto.avisosUsuario[0]!.lines).toContain('Avísale a mesa@ejemplo.cl.')
    const nada = await arnes()
    await nada.subir('x.xlsx', -10)
    nada.runs.push({ startedAt: iso(-5), endedAt: iso(-4), status: 'Failed' })
    await nada.loop.tick()
    expect(nada.avisosUsuario[0]!.lines.join('\n')).not.toMatch(/avis/i)
  })

  it('un valor LEGADO (0.34.0) se reevalúa en silencio: cambia con su registro-v1 y no manda correos', async () => {
    const a = await arnes({ operador: true })
    const id = await a.subir('x.xlsx', -10)
    const db = (a.store as unknown as { db: { run(sql: string, p?: unknown[]): void } }).db
    db.run(`UPDATE intake_upload SET desenlace = 'fallida', desenlace_at = ? WHERE id = ?`, [iso(-3), id])
    a.runs.push({ startedAt: iso(-5), endedAt: iso(-4), status: 'Completed' })
    a.logs[iso(-5)] = '[intake] ✔ procesado: x.xlsx\n'
    await a.loop.tick()
    expect((await a.fila(id))).toMatchObject({ desenlace: 'procesada', desenlaceFinal: true })
    expect((await a.store.listIntentos(id)).map((i) => [i.origen, i.resultado])).toEqual([['registro-v1', 'fallida'], ['declaracion', 'procesada']])
    expect(a.avisosUsuario).toHaveLength(0)
    expect(a.avisosOperador).toHaveLength(0)
  })

  it('la disjunción se mide tras la recarga y queda como señal (nombres del registro con 2+ tipos)', async () => {
    const a = await arnes({ slots: [
      { id: 'ventas', label: 'V', domain: 'd', accept: '*ventas*.xlsx', target: { workspaceId: 'W', lakehouseId: 'L', path: LANDING }, trigger: { processRef: 'P' } },
      { id: 'otro', label: 'O', domain: 'd', accept: '*mensual*.xlsx', target: { workspaceId: 'W', lakehouseId: 'L', path: 'Files/intake/otro' } },
    ] })
    await a.subir('ventas mensual.xlsx', -10)
    await a.loop.tick()
    const raw = await a.store.getSetting('intake.disjuncion')
    expect(JSON.parse(raw!).ambiguos).toEqual([{ nombre: 'ventas mensual.xlsx', slots: ['ventas', 'otro'] }])
    expect(a.logLines.some((l) => l.includes('calzan con 2+ tipos'))).toBe(true)
  })
})

// ─── Arneses ─────────────────────────────────────────────────────────────────────────────────────

async function arnes(opts: { operador?: boolean; contacto?: string; slots?: IntakeSlot[] } = {}) {
  const store = await SqliteGovernanceStore.open(null, {})
  const slotVentas: IntakeSlot = { id: 'ventas', label: 'Ventas', domain: 'd', target: { workspaceId: 'W', lakehouseId: 'L', path: LANDING }, trigger: { processRef: 'P' }, ...(opts.contacto ? { contacto: opts.contacto } : {}) }
  const slots = opts.slots ?? [slotVentas]
  const runs: RunRecord[] = []
  const logs: Record<string, string> = {}
  const landing: OneLakeEntry[] = []
  const avisosUsuario: Notification[] = []
  const avisosOperador: Notification[] = []
  const logLines: string[] = []
  const clock = { ms: T0 }
  const deps: IntakeLoopDeps = {
    slots: () => slots,
    landing: async (): Promise<OneLakeListing> => ({ kind: 'ok', entries: [...landing] }),
    runs: async () => [...runs],
    retiros: async () => [],
    store,
    runLogs: {
      list: async () => Object.keys(logs).map((s) => ({ path: `Files/code/_logs/${runLogFileName(s)}`, isDirectory: false, size: 1, lastModified: s })),
      read: async (_s, path) => Object.entries(logs).find(([s]) => path.endsWith(runLogFileName(s)))?.[1] ?? null,
    },
    notifyUploader: async (n) => void avisosUsuario.push(n),
    domains: [{ id: 'd', label: 'Dominio' }],
    log: (l) => void logLines.push(l),
    now: () => clock.ms,
  }
  if (opts.operador) {
    deps.notifyOperador = async (n) => void avisosOperador.push(n)
    deps.hayDestinoOperador = () => true
  }
  const loop = createIntakeLoop(deps, { publicUrl: 'https://mira.ejemplo.cl', pollMs: 600_000 })
  return {
    store, runs, logs, landing, avisosUsuario, avisosOperador, logLines, clock, loop,
    subir: (filename: string, min: number) =>
      store.recordUpload({ slotId: slots[0]!.id, filename, sha256: filename.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '0'), bytes: 10, uploadedBy: 'ana@ejemplo.cl', uploadedAt: iso(min), ok: true, triggered: true, origen: 'upload' }),
    fila: async (id: number) => (await store.listUploads(slots[0]!.id, 50)).find((r) => r.id === id),
  }
}

const STEWARD = 'steward@ejemplo.cl'
async function adminArnes(slots: IntakeSlot[]) {
  const ENT = parseMasterDataConfig({ entities: [{ id: 'e', label: 'E', domain: 'd', columns: [{ name: 'k', label: 'K', type: 'string', pk: true }] }] })
  const store = await SqliteGovernanceStore.open(null, {})
  const vivos = [...slots]
  const cargas: CargasOps = {
    history: async () => [], runs: async () => [], log: async () => null, landing: async () => [], archived: async () => [],
    rerun: async () => {}, retire: async () => {}, restore: async () => {},
  }
  const admin: AdminHandler = createAdmin({
    cargas,
    entities: ENT,
    mdStore: await SqliteMasterDataStore.open(null, ENT),
    adminStore: await SqliteAdminStore.open(null, ['admin@ejemplo.cl']),
    domains: parseDomainsConfig({ domains: [{ id: 'd', label: 'D', stewards: [STEWARD] }] }),
    intakeSlots: vivos,
    intake: { put: async () => {} },
    intakeUploads: store,
    identityOf: (h) => ({ user: (h as Record<string, string>)['x-test-user'] }),
    audit: () => {},
    secret: 'test-secret',
  })
  const res = () => ({ statusCode: 0, headers: {} as Record<string, string>, body: '', writeHead(c: number, h?: Record<string, string>) { this.statusCode = c; Object.assign(this.headers, h ?? {}); return this }, end(c?: string) { if (c) this.body += c } })
  const go = async (req: IncomingMessage) => {
    const r = res()
    await admin.tryHandle(req, r as unknown as ServerResponse)
    return r
  }
  const req = (method: string, url: string, body: Buffer | string = '', ct?: string): IncomingMessage => {
    const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
    r.url = url; r.method = method; r.headers = { 'x-test-user': STEWARD }
    if (ct) r.headers['content-type'] = ct
    return r
  }
  const token = async (): Promise<string> => {
    const page = await go(req('GET', `/admin/dominio/d/cargas`))
    return page.body.match(/name="_csrf" value="([0-9a-f]+)"/)![1]!
  }
  return {
    store,
    slots: vivos,
    subir: async (slotId: string, filename: string) => {
      const B = 'b269'
      const body = Buffer.concat([
        Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${await token()}\r\n`),
        Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        Buffer.from('contenido'),
        Buffer.from(`\r\n--${B}--\r\n`),
      ])
      return go(req('POST', `/admin/dominio/d/intake/${slotId}`, body, `multipart/form-data; boundary=${B}`))
    },
  }
}

describe('#269 · juez P1 · M1: el cursor nunca pasa por encima de una corrida no terminada', () => {
  it('una NotStarted vieja que después arranca y declara ✔ se sigue viendo: la carga termina procesada, no sin-informe', () => {
    const c = carga('x.xlsx')
    const otro = corrida(5, 6, 'Completed', '[intake] ✔ procesado: otro.xlsx\n')
    // Vuelta 1 (t0+90 min): R1 `NotStarted` desde t0+1 (vieja: se ignora para el veredicto) y R2 que no nombra x.
    const v1 = resolverEstadoDeCarga(c, [corrida(1, null, 'NotStarted', null, 'en-curso'), otro], [archivoEn(LANDING, 'x.xlsx')], [], [], [], { nowMs: T0 + 90 * 60_000 })
    expect(v1.estado).toBeNull()
    // El cursor queda ANTES de R1: su desenlace tardío no puede quedar fuera de la ventana.
    expect(v1.evaluadoHasta == null || Date.parse(v1.evaluadoHasta) < Date.parse(iso(1))).toBe(true)
    // Vuelta 2 (t0+160 min): R1 arrancó al fin con el MISMO startedAt, terminó y declaró ✔ x; x salió del landing.
    const opts = { nowMs: T0 + 160 * 60_000, ...(v1.evaluadoHasta ? { evaluadoHasta: v1.evaluadoHasta } : {}) }
    const v2 = resolverEstadoDeCarga(c, [corrida(1, 152, 'Completed', '[intake] ✔ procesado: x.xlsx\n'), otro], [], [], [], [], opts)
    expect(v2).toMatchObject({ estado: 'procesada', final: true, runStartedAt: iso(1) })
  })
})

describe('#269 · juez P1 · M2: la corrida que ya corría al subir y sigue en curso cuenta como en curso', () => {
  it('arrancó antes de la subida, sigue InProgress y ya archivó el archivo ⇒ sin estado («Cargando»), nunca sin-informe', () => {
    const r = resolverEstadoDeCarga(
      { id: 1, filename: 'x.xlsx', uploadedAt: new Date(T0 + 15_000).toISOString() },
      [corrida(0, null, 'InProgress', null, 'en-curso')],
      [], [], [], [], { nowMs: T0 + 5 * 60_000 },
    )
    expect(r).toMatchObject({ estado: null, enCurso: true })
  })

  it('en el lazo: mientras esa corrida no termine, ni estado falso ni correo', async () => {
    const a = await arnes({ operador: true })
    const id = await a.subir('x.xlsx', 0.25)
    a.runs.push({ startedAt: iso(0), status: 'InProgress' })
    a.clock.ms = T0 + 5 * 60_000
    await a.loop.tick()
    expect((await a.fila(id))?.desenlace).toBeUndefined()
    expect(a.avisosUsuario).toHaveLength(0)
    expect(a.avisosOperador).toHaveLength(0)
  })
})
