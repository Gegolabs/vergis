import { describe, it, expect } from 'vitest'
import { parseIntakeConfig, matchSlot, validateUpload, validateMeta, validateRut, buildSidecar, sidecarName, isSidecarName, globToRegExp, slotMaxBytes, slotLogPath, DEFAULT_INGEST_LOG } from '@vergis/capabilities'

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

// Issue #76: metadata requerida por slot (schema + validación + sidecar).
const META_SLOT = {
  slots: [{
    id: 'facturas', label: 'Facturas', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/f' },
    meta: [
      { id: 'empresa_rut', label: 'Empresa (receptor)', type: 'rut', required: true },
      { id: 'version', label: 'Versión', type: 'enum', options: ['V0', 'V1', 'V2'], required: true },
      { id: 'folios', label: 'Folios', type: 'number' },
      { id: 'nota', label: 'Nota', type: 'string' },
    ],
  }],
}

describe('intake · metadata requerida (issue #76)', () => {
  it('parsea el bloque meta completo (tipos, required, options)', () => {
    const slot = parseIntakeConfig(META_SLOT)[0]
    expect(slot.meta).toHaveLength(4)
    expect(slot.meta![0]).toEqual({ id: 'empresa_rut', label: 'Empresa (receptor)', type: 'rut', required: true })
    expect(slot.meta![1].options).toEqual(['V0', 'V1', 'V2'])
    expect(slot.meta![2]).toEqual({ id: 'folios', label: 'Folios', type: 'number' })
  })

  it('slot sin meta: meta queda undefined (regresión cero)', () => {
    const slot = parseIntakeConfig({ slots: [{ id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' } }] })[0]
    expect(slot.meta).toBeUndefined()
  })

  it('schema mal formado = fallo ruidoso: type inválido · enum sin options · options_ref no soportado · id dup · required no-bool', () => {
    const base = { id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' } }
    expect(() => parseIntakeConfig({ slots: [{ ...base, meta: [{ id: 'x', label: 'X', type: 'fecha' }] }] })).toThrow(/type inválido/)
    expect(() => parseIntakeConfig({ slots: [{ ...base, meta: [{ id: 'x', label: 'X', type: 'enum' }] }] })).toThrow(/requiere 'options'/)
    expect(() => parseIntakeConfig({ slots: [{ ...base, meta: [{ id: 'x', label: 'X', type: 'enum', options_ref: 'cat' }] }] })).toThrow(/options_ref no soportado/)
    expect(() => parseIntakeConfig({ slots: [{ ...base, meta: [{ id: 'x', label: 'X', type: 'string' }, { id: 'x', label: 'Y', type: 'string' }] }] })).toThrow(/duplicado/)
    expect(() => parseIntakeConfig({ slots: [{ ...base, meta: [{ id: 'x', label: 'X', type: 'string', required: 'si' }] }] })).toThrow(/booleano/)
    expect(() => parseIntakeConfig({ slots: [{ ...base, meta: [{ id: 'BAD-ID', label: 'X', type: 'string' }] }] })).toThrow(/id inválido/)
    expect(() => parseIntakeConfig({ slots: [{ ...base, meta: [{ id: 'x', label: 'X', type: 'string', options: ['a'] }] }] })).toThrow(/solo aplica a type enum/)
    expect(() => parseIntakeConfig({ slots: [{ ...base, meta: 'no-lista' }] })).toThrow(/debe ser una lista/)
  })

  it('validateRut: DV módulo 11 (acepta puntos, guion y K)', () => {
    expect(validateRut('96835510-4')).toBe(true)
    expect(validateRut('12.345.678-5')).toBe(true)
    expect(validateRut('11111111-1')).toBe(true)
    expect(validateRut('60803000-K')).toBe(true) // Tesorería (DV = K)
    expect(validateRut('96835510-3')).toBe(false) // DV incorrecto
    expect(validateRut('sin-guion')).toBe(false)
    expect(validateRut('123456789-1')).toBe(false) // cuerpo > 8 dígitos
    expect(validateRut('')).toBe(false)
  })

  it('validateMeta: requerido faltante rechaza; devuelve solo los campos declarados (trim)', () => {
    const slot = parseIntakeConfig(META_SLOT)[0]
    const ok = validateMeta(slot, { empresa_rut: ' 96835510-4 ', version: 'V1', extra: 'ignorado' })
    expect(ok.ok).toBe(true)
    expect((ok as { values: Record<string, string> }).values).toEqual({ empresa_rut: '96835510-4', version: 'V1' })
    expect((validateMeta(slot, { version: 'V1' }) as { error: string }).error).toMatch(/Empresa/)
  })

  it('validateMeta: rechaza rut inválido, enum fuera de opciones, number no-numérico', () => {
    const slot = parseIntakeConfig(META_SLOT)[0]
    expect((validateMeta(slot, { empresa_rut: '96835510-3', version: 'V1' }) as { error: string }).error).toMatch(/RUT inválido/)
    expect((validateMeta(slot, { empresa_rut: '96835510-4', version: 'V9' }) as { error: string }).error).toMatch(/opción válida/)
    expect((validateMeta(slot, { empresa_rut: '96835510-4', version: 'V1', folios: 'abc' }) as { error: string }).error).toMatch(/número/)
  })

  it('buildSidecar/sidecarName/isSidecarName: orden slot → campos → auditoría', () => {
    const json = buildSidecar('facturas', { empresa_rut: '96835510-4' }, 'user@tenant', '2026-07-22T00:41:00Z')
    expect(JSON.parse(json)).toEqual({ slot: 'facturas', empresa_rut: '96835510-4', uploadedBy: 'user@tenant', uploadedAt: '2026-07-22T00:41:00Z' })
    expect(Object.keys(JSON.parse(json))).toEqual(['slot', 'empresa_rut', 'uploadedBy', 'uploadedAt'])
    expect(sidecarName('extracto w24.xlsx')).toBe('extracto w24.xlsx.meta.json')
    expect(isSidecarName('extracto w24.xlsx.meta.json')).toBe(true)
    expect(isSidecarName('extracto w24.xlsx')).toBe(false)
  })
})
