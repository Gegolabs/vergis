import { describe, it, expect } from 'vitest'
import { classifyProcess, alertReason, reconcilePlan, type RunRecord } from '@vergis/capabilities'

const NOW = Date.parse('2026-06-23T12:00:00Z')
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString()

describe('observabilidad · classifyProcess', () => {
  it('última fallida → failed', () => {
    const runs: RunRecord[] = [
      { startedAt: ago(3600), endedAt: ago(3500), status: 'Completed' },
      { startedAt: ago(60), endedAt: ago(30), status: 'Failed', error: 'boom' },
    ]
    const h = classifyProcess(runs, 86400, NOW)
    expect(h.lastStatus).toBe('Failed')
    expect(h.failed).toBe(true)
    expect(alertReason(h)).toBe('failed')
  })

  it('última exitosa pero vieja vs cadencia → missed', () => {
    const runs: RunRecord[] = [{ startedAt: ago(2 * 86400), endedAt: ago(2 * 86400 - 60), status: 'Completed' }]
    const h = classifyProcess(runs, 86400, NOW) // cadencia diaria, última hace 2 días
    expect(h.failed).toBe(false)
    expect(h.missed).toBe(true)
    expect(alertReason(h)).toBe('missed')
  })

  it('exitosa y dentro de la cadencia → sana', () => {
    const runs: RunRecord[] = [{ startedAt: ago(3600), endedAt: ago(3540), status: 'Completed' }]
    const h = classifyProcess(runs, 86400, NOW)
    expect(h.failed).toBe(false)
    expect(h.missed).toBe(false)
    expect(alertReason(h)).toBeNull()
    expect(h.ageSeconds).toBeGreaterThan(3500)
  })

  it('sin corridas → missed (nunca corrió)', () => {
    const h = classifyProcess([], 86400, NOW)
    expect(h.lastStatus).toBe('NoRuns')
    expect(h.missed).toBe(true)
    expect(h.lastSuccessAt).toBeNull()
  })
})

describe('reconciliador · reconcilePlan', () => {
  it('set cuando difiere, noop cuando coincide', () => {
    expect(reconcilePlan(3600, null)).toEqual({ action: 'set', desiredSeconds: 3600 })
    expect(reconcilePlan(3600, 86400)).toEqual({ action: 'set', desiredSeconds: 3600 })
    expect(reconcilePlan(3600, 3600)).toEqual({ action: 'noop', desiredSeconds: 3600 })
  })
})
