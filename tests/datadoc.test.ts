// EL ORQUESTADOR del Datadoc (CAP-197), con reloj falso y un `execute` que registra.
//
// Cuatro propiedades que no se ven por inspección y que cuestan caro si fallan:
//
//  · **Standby no genera.** `VERGIS_OUT` es sustrato compartido; dos nodos escribiendo `current` a la
//    vez producen builds cruzados. El router ya rechaza el POST, pero el LAZO no pasa por el router.
//  · **Una sola en vuelo.** Un segundo clic no arranca otra vuelta contra los mismos almacenes.
//  · **El schedule dispara una vez por período.** Ni dos veces el mismo día ni ninguna al siguiente.
//  · **Marcar rancio retira los conteos del sitio ya publicado**, sin volver a medir — el eslabón que
//    cierra la regla del §D6, porque el Producto no se entera cuando la instancia aplica una policy.

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatadoc, formatSchedule, parseSchedule, type Datadoc, type DatadocDeps } from '../server/datadoc'
import { leerSello, rutaCurrent } from '../server/datadoc-store'
import type { EjecutarSql } from '../server/datadoc-introspect'
import type { PlatformSettingStore } from '@vergis/capabilities'

const OBJETOS = [{ TABLE_SCHEMA: 'dbo', TABLE_NAME: 't', TABLE_TYPE: 'BASE TABLE' }]

function ejecutorFalso(): { execute: EjecutarSql; sqls: string[]; falla: { valor: boolean } } {
  const sqls: string[] = []
  const falla = { valor: false }
  const execute: EjecutarSql = async ({ sql }) => {
    sqls.push(sql)
    if (falla.valor) throw new Error('la conexión no responde')
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) return { rows: OBJETOS }
    if (sql.includes('COUNT_BIG')) return { rows: [{ n: 7 }] }
    return { rows: [] }
  }
  return { execute, sqls, falla }
}

function settingsFalsos(inicial: Record<string, string> = {}): PlatformSettingStore & { valores: Record<string, string> } {
  const valores = { ...inicial }
  return {
    valores,
    async getSetting(k) {
      return valores[k] ?? null
    },
    async setSetting(k, v) {
      valores[k] = v
    },
  }
}

interface Arnes {
  dd: Datadoc
  out: string
  dir: string
  sqls: string[]
  falla: { valor: boolean }
  audit: Record<string, unknown>[]
  control: { valor: boolean }
  ahora: { valor: number }
  settings: ReturnType<typeof settingsFalsos>
}

function arnes(over: Partial<DatadocDeps> = {}, settingsIniciales: Record<string, string> = {}): Arnes {
  const out = mkdtempSync(join(tmpdir(), 'vergis-dd-orq-'))
  const { execute, sqls, falla } = ejecutorFalso()
  const audit: Record<string, unknown>[] = []
  const control = { valor: true }
  const ahora = { valor: Date.parse('2026-09-21T12:00:00.000Z') }
  const settings = settingsFalsos(settingsIniciales)
  const dd = createDatadoc({
    out,
    execute,
    connections: { finanzas: { server: 'endpoint', database: 'wh_finanzas' } },
    discover: () => [],
    writers: () => ({ writers: [], warnings: [] }),
    semantica: () => ({ conexiones: [], warnings: [] }),
    domains: () => [],
    sources: () => ({}),
    settings,
    audit: (e) => audit.push(e),
    hasControl: () => control.valor,
    log: () => {},
    now: () => new Date(ahora.valor),
    ...over,
  })
  return { dd, out, dir: join(out, 'datadoc'), sqls, falla, audit, control, ahora, settings }
}

describe('parseSchedule / formatSchedule', () => {
  it.each([
    ['off', { every: 'off' }],
    ['', { every: 'off' }],
    ['daily@06:00', { every: 'daily', at: '06:00' }],
    ['weekly:monday@06:30', { every: 'weekly', at: '06:30', weekday: 'monday' }],
  ])('«%s»', (raw, esperado) => expect(parseSchedule(raw)).toEqual(esperado))

  it('lo que no se entiende queda en `off`: NO se adivina una cadencia', () => {
    for (const raro of ['cada rato', 'daily@25:00', 'weekly:lunes@06:00', 'daily'])
      expect(parseSchedule(raro)).toEqual({ every: 'off' })
  })

  it('formatSchedule es la inversa', () => {
    for (const s of ['off', 'daily@06:00', 'weekly:friday@23:15']) expect(formatSchedule(parseSchedule(s))).toBe(s)
  })
})

describe('generar', () => {
  let a: Arnes
  beforeEach(() => {
    a = arnes()
  })

  it('mide, escribe el modelo, publica el build y deja el sello', async () => {
    const r = await a.dd.generar('all')
    expect(r.ok).toBe(true)
    expect(a.dd.hayBuild()).toBe(true)
    expect(readFileSync(join(rutaCurrent(a.dir), 'index.html'), 'utf8')).toContain('Datadoc')
    const sello = leerSello(a.dir)
    expect(sello.build?.dir).toMatch(/^build-/)
    expect(sello.conexiones).toEqual([expect.objectContaining({ ref: 'finanzas', ok: true, objetos: 1 })])
    expect(a.audit.some((e) => e['type'] === 'datadoc-done' && e['ok'] === true)).toBe(true)
  })

  it('⚠ un nodo SIN control no genera, y lo dice', async () => {
    a.control.valor = false
    const r = await a.dd.generar('all')
    // REFUTARÍA: dos nodos escribiendo el mismo `current` producen builds cruzados. El router para el
    // POST, pero el lazo no pasa por el router — por eso la verificación se repite acá.
    expect(r.ok).toBe(false)
    expect(r.motivo).toMatch(/no tiene el plano de control/)
    expect(a.sqls).toHaveLength(0)
    expect(a.dd.hayBuild()).toBe(false)
  })

  it('una conexión que no está declarada no se mide y se dice con su nombre', async () => {
    const r = await a.dd.generar('fantasma')
    expect(r.ok).toBe(false)
    expect(r.motivo).toMatch(/'fantasma' no está declarada/)
    expect(a.sqls).toHaveLength(0)
  })

  it('una conexión caída NO tumba la generación: el build sale con la marca y el motivo', async () => {
    a.falla.valor = true
    const r = await a.dd.generar('all')
    expect(r.ok).toBe(false)
    expect(r.fallidas).toEqual(['finanzas'])
    // El sitio se publica igual: un catálogo parcial y honesto vale más que ninguno.
    expect(a.dd.hayBuild()).toBe(true)
    expect(readFileSync(join(rutaCurrent(a.dir), 'index.html'), 'utf8')).toContain('NO medida')
    expect(leerSello(a.dir).conexiones[0]).toMatchObject({ ok: false, error: expect.stringContaining('no responde') })
  })

  it('⚠ una sola en vuelo: el segundo disparo recibe la promesa del primero', async () => {
    const p1 = a.dd.generar('all')
    expect(a.dd.enCurso()).toBe(true)
    const p2 = a.dd.generar('all')
    await Promise.all([p1, p2])
    // REFUTARÍA: dos tandas de consultas contra los mismos almacenes por un doble clic.
    expect(a.sqls.filter((s) => s.includes('INFORMATION_SCHEMA.TABLES'))).toHaveLength(1)
    expect(a.dd.enCurso()).toBe(false)
  })

  it('con `datadoc_conteos = off` no se emite un solo COUNT', async () => {
    const b = arnes({}, { datadoc_conteos: 'off' })
    await b.dd.generar('all')
    expect(b.sqls.filter((s) => s.includes('COUNT_BIG'))).toHaveLength(0)
  })
})

describe('⚠ marcarRancio: el eslabón que retira los conteos sin volver a medir', () => {
  it('re-dibuja el sitio publicado sin conteos, deja la marca y NO toca la red', async () => {
    const a = arnes()
    await a.dd.generar('all')
    expect(readFileSync(join(rutaCurrent(a.dir), 'index.html'), 'utf8')).toBeTruthy()
    const consultasAntes = a.sqls.length
    await a.dd.marcarRancio('watch:policies')
    // REFUTARÍA una medición: marcar rancio es CPU puro sobre los modelos ya en disco.
    expect(a.sqls).toHaveLength(consultasAntes)
    const sello = leerSello(a.dir)
    expect(sello.rancio).toMatchObject({ razon: 'watch:policies' })
    const idx = readFileSync(join(rutaCurrent(a.dir), 'index.html'), 'utf8')
    expect(idx).toContain('Catálogo marcado rancio')
  })

  it('sin build todavía, no hace nada (no hay conteos publicados que retirar)', async () => {
    const a = arnes()
    await a.dd.marcarRancio('watch:policies')
    expect(leerSello(a.dir).rancio).toBeNull()
  })

  it('en standby no escribe: el sustrato es del activo', async () => {
    const a = arnes()
    await a.dd.generar('all')
    a.control.valor = false
    await a.dd.marcarRancio('watch:policies')
    expect(leerSello(a.dir).rancio).toBeNull()
  })

  it('una generación exitosa RETIRA la marca: lo que se acaba de medir es lo vigente', async () => {
    const a = arnes()
    await a.dd.generar('all')
    await a.dd.marcarRancio('watch:policies')
    expect(leerSello(a.dir).rancio).not.toBeNull()
    await a.dd.generar('all')
    expect(leerSello(a.dir).rancio).toBeNull()
  })
})

describe('⚠ el schedule dispara UNA vez por período', () => {
  const T = (iso: string): number => Date.parse(iso)

  it('a las 08:59 no dispara; a las 09:01 sí; a las 09:30 del mismo día NO otra vez; al día siguiente sí', async () => {
    const a = arnes({}, { datadoc_schedule: 'daily@09:00', datadoc_timezone: 'UTC' })
    const corridas = (): number => a.sqls.filter((s) => s.includes('INFORMATION_SCHEMA.TABLES')).length

    // La primera vuelta toma posición sin generar (ver el test de abajo).
    a.ahora.valor = T('2026-09-21T08:59:00Z')
    await a.dd.tickSchedule()
    expect(corridas()).toBe(0)

    a.ahora.valor = T('2026-09-21T09:01:00Z')
    await a.dd.tickSchedule()
    expect(corridas()).toBe(1)
    expect(leerSello(a.dir).periodKey).toBe('2026-09-21')

    a.ahora.valor = T('2026-09-21T09:30:00Z')
    await a.dd.tickSchedule()
    // REFUTARÍA: un segundo disparo el mismo día es una tanda de consultas que nadie pidió.
    expect(corridas()).toBe(1)

    a.ahora.valor = T('2026-09-22T09:01:00Z')
    await a.dd.tickSchedule()
    expect(corridas()).toBe(2)
    expect(leerSello(a.dir).periodKey).toBe('2026-09-22')
  })

  it('con el schedule en `off` no dispara nunca', async () => {
    const a = arnes({}, { datadoc_schedule: 'off' })
    a.ahora.valor = T('2026-09-21T09:01:00Z')
    await a.dd.tickSchedule()
    expect(a.sqls).toHaveLength(0)
  })

  it('en standby el lazo no dispara', async () => {
    const a = arnes({}, { datadoc_schedule: 'daily@09:00', datadoc_timezone: 'UTC' })
    a.control.valor = false
    a.ahora.valor = T('2026-09-21T09:01:00Z')
    await a.dd.tickSchedule()
    expect(a.sqls).toHaveLength(0)
  })

  it('la PRIMERA vuelta solo toma posición: un período que transcurrió antes de que nadie mirara no se genera', async () => {
    const a = arnes({}, { datadoc_schedule: 'daily@09:00', datadoc_timezone: 'UTC' })
    a.ahora.valor = T('2026-09-21T08:59:00Z')
    await a.dd.tickSchedule()
    expect(a.sqls).toHaveLength(0)
    // …pero la posición queda registrada, que es lo que permite disparar el período SIGUIENTE.
    expect(leerSello(a.dir).periodKey).toBe('2026-09-20')
  })

  it('un nodo que se cayó a la hora del disparo y vuelve más tarde SÍ recupera el período', async () => {
    const a = arnes({}, { datadoc_schedule: 'daily@09:00', datadoc_timezone: 'UTC' })
    a.ahora.valor = T('2026-09-20T09:01:00Z')
    await a.dd.tickSchedule() // toma posición: 2026-09-20
    a.ahora.valor = T('2026-09-21T14:00:00Z') // volvió cinco horas tarde
    await a.dd.tickSchedule()
    // REFUTARÍA: saltarse el período por llegar tarde dejaría el catálogo sin generar un día entero.
    expect(a.sqls.filter((s) => s.includes('INFORMATION_SCHEMA.TABLES'))).toHaveLength(1)
    expect(leerSello(a.dir).periodKey).toBe('2026-09-21')
  })

  it('un período que falló NO se reintenta cada cinco minutos: el periodKey queda marcado igual', async () => {
    const a = arnes({}, { datadoc_schedule: 'daily@09:00', datadoc_timezone: 'UTC' })
    a.ahora.valor = T('2026-09-21T08:59:00Z')
    await a.dd.tickSchedule() // toma posición
    a.falla.valor = true
    a.ahora.valor = T('2026-09-21T09:01:00Z')
    await a.dd.tickSchedule()
    const tras = a.sqls.length
    expect(tras).toBeGreaterThan(0)
    a.ahora.valor = T('2026-09-21T09:06:00Z')
    await a.dd.tickSchedule()
    // REFUTARÍA: martillar cada cinco minutos almacenes que no responden.
    expect(a.sqls).toHaveLength(tras)
  })
})

describe('ajustes y estado', () => {
  it('guarda schedule y conteos, los audita y los devuelve normalizados', async () => {
    const a = arnes()
    const r = await a.dd.ajustes({ schedule: 'daily@06:00', conteos: 'off', timezone: 'America/Santiago' }, 'admin@x.cl')
    expect(r).toEqual({ schedule: 'daily@06:00', timezone: 'America/Santiago', conteos: 'off' })
    expect(a.settings.valores['datadoc_schedule']).toBe('daily@06:00')
    expect(a.settings.valores['datadoc_conteos']).toBe('off')
    expect(a.audit.some((e) => e['type'] === 'platform-setting' && e['key'] === 'datadoc')).toBe(true)
  })

  it('un schedule basura se guarda como `off`, no como basura', async () => {
    const a = arnes()
    expect((await a.dd.ajustes({ schedule: 'cuando pueda' }, 'x')).schedule).toBe('off')
  })

  it('sin haber generado nunca, el estado nombra las conexiones declaradas como no medidas', async () => {
    const a = arnes()
    const e = await a.dd.estado()
    expect(e.build).toBeNull()
    expect(e.conexiones).toEqual([expect.objectContaining({ ref: 'finanzas', ok: false, error: 'nunca medida' })])
  })

  it('`contrato()` es SÍNCRONO y refleja el build servido', async () => {
    const a = arnes()
    expect(a.dd.contrato().current).toBeNull()
    await a.dd.generar('all')
    const c = a.dd.contrato()
    expect(c.enabled).toBe(true)
    expect(c.current?.build).toMatch(/^build-/)
    expect(c.conexiones).toEqual([{ ref: 'finanzas', ok: true, medidoEn: expect.any(String) }])
  })
})
