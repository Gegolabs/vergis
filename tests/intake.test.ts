import { describe, it, expect } from 'vitest'
import { parseIntakeConfig, matchSlot, validateUpload, globToRegExp, slotMaxBytes, slotLogPath, DEFAULT_INGEST_LOG } from '@vergis/capabilities'

const SLOT = {
  slots: [
    {
      id: 'saldos_cartera',
      label: 'Antigüedad de saldos (Cartera)',
      domain: 'cartera',
      accept: 'Antigüedad de saldos *.xlsx',
      maxBytes: 1024,
      target: { workspaceId: 'ws1', lakehouseId: 'lh1', path: 'Files/intake/saldos' },
      trigger: { processRef: 'pipe1' },
    },
  ],
}

describe('intake · contrato declarativo', () => {
  it('parsea un slot completo y normaliza el path', () => {
    const slots = parseIntakeConfig(SLOT)
    expect(slots).toHaveLength(1)
    expect(slots[0].target).toEqual({ workspaceId: 'ws1', lakehouseId: 'lh1', path: 'Files/intake/saldos' })
    expect(slots[0].trigger?.processRef).toBe('pipe1')
    expect(slotMaxBytes(slots[0])).toBe(1024)
  })

  it('default de maxBytes = 25 MB cuando se omite', () => {
    const slots = parseIntakeConfig({ slots: [{ id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' } }] })
    expect(slotMaxBytes(slots[0])).toBe(25 * 1024 * 1024)
  })

  // Issue #55: la ruta del log de conversión es declarable, con default por convención.
  it('slotLogPath: default Files/code/_ingest_log.txt · declarable · log:false lo apaga · fuera de Files/ rechaza', () => {
    const base = { id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' } }
    expect(slotLogPath(parseIntakeConfig({ slots: [base] })[0])).toBe(DEFAULT_INGEST_LOG)
    expect(slotLogPath(parseIntakeConfig({ slots: [{ ...base, log: 'Files/logs/conv.txt' }] })[0])).toBe('Files/logs/conv.txt')
    expect(slotLogPath(parseIntakeConfig({ slots: [{ ...base, log: false }] })[0])).toBeNull()
    expect(() => parseIntakeConfig({ slots: [{ ...base, log: '/etc/passwd' }] })).toThrow(/Files\//)
  })

  it('rechaza target incompleto, path fuera de Files/, id dup, trigger sin processRef', () => {
    expect(() => parseIntakeConfig({ slots: [{ id: 's', label: 'S', target: { workspaceId: 'w' } }] })).toThrow(/target requiere/)
    expect(() => parseIntakeConfig({ slots: [{ id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Tables/x' } }] })).toThrow(/Files\//)
    expect(() => parseIntakeConfig({ slots: [{ id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' } }, { id: 's', label: 'S2', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/y' } }] })).toThrow(/duplicado/)
    expect(() => parseIntakeConfig({ slots: [{ id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' }, trigger: {} }] })).toThrow(/processRef/)
  })

  it('globToRegExp: comodines * y ? case-insensitive; el resto se escapa', () => {
    expect(globToRegExp('saldos *.xlsx').test('SALDOS w24.xlsx')).toBe(true)
    expect(globToRegExp('a?c.csv').test('abc.csv')).toBe(true)
    expect(globToRegExp('a?c.csv').test('ac.csv')).toBe(false)
    expect(globToRegExp('lit.eral').test('litXeral')).toBe(false) // el punto NO es comodín
  })

  it('matchSlot: por patrón; slot sin accept acepta cualquiera', () => {
    const slots = parseIntakeConfig(SLOT)
    expect(matchSlot(slots, 'Antigüedad de saldos W24.xlsx')?.id).toBe('saldos_cartera')
    expect(matchSlot(slots, 'otro.csv')).toBeUndefined()
    const libre = parseIntakeConfig({ slots: [{ id: 'libre', label: 'L', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' } }] })
    expect(matchSlot(libre, 'cualquier-cosa.bin')?.id).toBe('libre')
  })

  it('validateUpload: ok · patrón · tamaño · vacío · ruta en el nombre', () => {
    const slot = parseIntakeConfig(SLOT)[0]
    expect(validateUpload(slot, 'Antigüedad de saldos W24.xlsx', 500)).toEqual({ ok: true })
    expect(validateUpload(slot, 'malo.csv', 500).ok).toBe(false)
    expect((validateUpload(slot, 'Antigüedad de saldos W24.xlsx', 99999) as { error: string }).error).toMatch(/excede/)
    expect(validateUpload(slot, 'Antigüedad de saldos W24.xlsx', 0).ok).toBe(false)
    expect(validateUpload(slot, '../etc/passwd', 10).ok).toBe(false)
  })
})
