// Settings de plataforma de la capa de notas (A7) y la purga por retención.
// La decisión de fondo: retención y límites son CONFIGURABLES, no constantes horneadas — y la
// retención se valida con el MISMO parser que la consume, no con un regex propio.
import { describe, it, expect } from 'vitest'
import {
  NOTAS_SETTINGS,
  SettingInvalido,
  corteDeRetencion,
  leerNotasSettings,
  purgarRetencion,
  validarAntiCementerio,
  validarMaxSchedules,
  validarRetencion,
} from '../server/notas-settings'
import { SqliteGovernanceStore, SqliteNotasStore } from '@vergis/capabilities'

describe('notas · settings A7', () => {
  it('los defaults son P12M · 10 · on, y viven en código (la instancia solo guarda lo que cambia)', async () => {
    const gov = await SqliteGovernanceStore.open(null)
    expect(await leerNotasSettings(gov)).toEqual({ retencion: 'P12M', maxSchedules: '10', antiCementerio: 'on' })
    expect(NOTAS_SETTINGS.retencionImpresiones.def).toBe('P12M')
    expect(NOTAS_SETTINGS.maxSchedulesUsuario.def).toBe('10')
    expect(NOTAS_SETTINGS.antiCementerio.def).toBe('on')
  })

  it('un valor guardado gana sobre el default', async () => {
    const gov = await SqliteGovernanceStore.open(null)
    await gov.setSetting(NOTAS_SETTINGS.retencionImpresiones.key, 'P6M', 'admin@x.com')
    await gov.setSetting(NOTAS_SETTINGS.maxSchedulesUsuario.key, '3', 'admin@x.com')
    await gov.setSetting(NOTAS_SETTINGS.antiCementerio.key, 'off', 'admin@x.com')
    expect(await leerNotasSettings(gov)).toEqual({ retencion: 'P6M', maxSchedules: '3', antiCementerio: 'off' })
  })

  it('la retención se valida con el parser que la consume (no un regex propio)', () => {
    expect(validarRetencion('P12M')).toBeGreaterThan(0)
    expect(validarRetencion('P1W1D')).toBeGreaterThan(0) // un regex ingenuo lo rechazaba
    expect(() => validarRetencion('PT')).toThrow(SettingInvalido) // un regex ingenuo lo aceptaba
    expect(() => validarRetencion('P0D')).toThrow(SettingInvalido)
    expect(() => validarRetencion('doce meses')).toThrow(SettingInvalido)
  })

  it('el límite de envíos programados es un entero positivo; el anti-cementerio es on|off', () => {
    expect(validarMaxSchedules('10')).toBe(10)
    expect(() => validarMaxSchedules('0')).toThrow(SettingInvalido)
    expect(() => validarMaxSchedules('-1')).toThrow(SettingInvalido)
    expect(() => validarMaxSchedules('diez')).toThrow(SettingInvalido)
    expect(validarAntiCementerio('ON')).toBe('on')
    expect(validarAntiCementerio('off')).toBe('off')
    expect(() => validarAntiCementerio('quizás')).toThrow(SettingInvalido)
  })

  it('el corte se calcula desde ahora hacia atrás', () => {
    const ahora = Date.parse('2026-07-01T00:00:00.000Z')
    const corte = corteDeRetencion('P12M', ahora)
    expect(new Date(corte).getTime()).toBeLessThan(ahora)
    // 12 meses ≈ un año antes (el parser usa meses de 30 días; basta que caiga en 2025).
    expect(corte.startsWith('2025')).toBe(true)
  })
})

describe('notas · purga por retención', () => {
  it('purga lo vencido —con sus notas— y respeta la actividad reciente', async () => {
    const gov = await SqliteGovernanceStore.open(null)
    const notas = await SqliteNotasStore.open(null)
    const ahora = Date.parse('2026-07-01T00:00:00.000Z')

    const vieja = await notas.abrirImpresion(
      { piSlug: 'pi-16', owner: 'ana@x.com', page: 'vieja', frozen: {} },
      { now: Date.parse('2024-01-01T00:00:00.000Z') },
    )
    const reciente = await notas.abrirImpresion({ piSlug: 'pi-16', owner: 'ana@x.com', page: 'reciente', frozen: {} }, { now: ahora })

    // Sin retención vencida no se purga nada.
    expect((await purgarRetencion(notas, gov, Date.parse('2024-02-01T00:00:00.000Z'))).purgados).toEqual([])

    const out = await purgarRetencion(notas, gov, ahora)
    expect(out.purgados).toEqual([vieja.id])
    expect(await notas.getImpresion(vieja.id)).toBeNull()
    expect(await notas.getImpresion(reciente.id)).not.toBeNull()
  })

  it('la retención se mide desde la ÚLTIMA ACTIVIDAD: anotar una impresión vieja la mantiene viva', async () => {
    const gov = await SqliteGovernanceStore.open(null)
    const notas = await SqliteNotasStore.open(null)
    const imp = await notas.abrirImpresion(
      { piSlug: 'pi-16', owner: 'ana@x.com', frozen: {} },
      { now: Date.parse('2024-01-01T00:00:00.000Z') },
    )
    // Alguien la retoma hoy: la impresión vuelve a estar viva y ya no se purga.
    await notas.crearNota({ especie: 'anotacion', autor: 'ana@x.com', contenido: 'sigue sirviendo', impresionId: imp.id })
    expect((await purgarRetencion(notas, gov, Date.now())).purgados).toEqual([])
    expect(await notas.getImpresion(imp.id)).not.toBeNull()
  })

  it('al purgar, las notas de la impresión se van con ella', async () => {
    const gov = await SqliteGovernanceStore.open(null)
    const notas = await SqliteNotasStore.open(null)
    const imp = await notas.abrirImpresion({ piSlug: 'pi-16', owner: 'ana@x.com', frozen: {} }, { now: Date.now() })
    const n = await notas.crearNota({ especie: 'anotacion', autor: 'ana@x.com', contenido: 'x', impresionId: imp.id })
    // Corte en el futuro: todo está vencido.
    const out = await purgarRetencion(notas, gov, Date.now() + 400 * 24 * 3600_000)
    expect(out.purgados).toEqual([imp.id])
    expect(await notas.getNota(n.id)).toBeNull()
  })

  it('una retención más corta purga más (el setting manda, no una constante)', async () => {
    const gov = await SqliteGovernanceStore.open(null)
    const notas = await SqliteNotasStore.open(null)
    const ahora = Date.parse('2026-07-01T00:00:00.000Z')
    const hace3meses = ahora - 90 * 24 * 3600_000
    const imp = await notas.abrirImpresion({ piSlug: 'pi-16', owner: 'ana@x.com', frozen: {} }, { now: hace3meses })

    // Con el default (12 meses) sigue viva…
    expect((await purgarRetencion(notas, gov, ahora)).purgados).toEqual([])
    // …con 1 mes, se va.
    await gov.setSetting(NOTAS_SETTINGS.retencionImpresiones.key, 'P1M', 'admin@x.com')
    expect((await purgarRetencion(notas, gov, ahora)).purgados).toEqual([imp.id])
  })
})
