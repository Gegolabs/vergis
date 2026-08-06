import { describe, it, expect } from 'vitest'
import { parseIntakeConfig, matchSlot, validateUpload, validateMeta, validateRut, buildSidecar, sidecarName, isSidecarName, globToRegExp, slotMaxBytes, slotLogPath, DEFAULT_INGEST_LOG, deriveMetaFromFilename, tokenFromFilename, filenamePatternToRegExp, metaEsDerivada, slotRunLogsDir } from '@vergis/capabilities'

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
  it('clave raíz ausente → lanza; slots: [] es «declara cero» legítimo (#117)', () => {
    for (const doc of [{}, null, undefined, { otra: 1 }]) {
      expect(() => parseIntakeConfig(doc)).toThrow(/falta la clave raíz 'slots'/)
    }
    expect(() => parseIntakeConfig({})).toThrow(/usa 'slots: \[\]'/)
    expect(parseIntakeConfig({ slots: [] })).toEqual([])
    expect(() => parseIntakeConfig({ slots: null })).toThrow(/debe ser una lista/)
  })

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

  // Issue #99: el directorio de logs POR CORRIDA se deriva del log ya declarado.
  it('slotRunLogsDir: hermano `_logs/` del log declarado · log:false → null', () => {
    const base = { id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' } }
    expect(slotRunLogsDir(parseIntakeConfig({ slots: [base] })[0])).toBe('Files/code/_logs')
    expect(slotRunLogsDir(parseIntakeConfig({ slots: [{ ...base, log: 'Files/x/mi.log' }] })[0])).toBe('Files/x/_logs')
    expect(slotRunLogsDir(parseIntakeConfig({ slots: [{ ...base, log: false }] })[0])).toBeNull()
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

// ─── #95 · metadata derivada del nombre del archivo ──────────────────────────

/** El caso real que motiva la capacidad: PI-16 · Facturas (EasyDoc y SAP en archivos separados). */
const FACTURAS = {
  slots: [
    {
      id: 'facturas_documentos',
      label: 'Documentos de factura (EasyDoc / SAP)',
      domain: 'facturas',
      accept: '*.xlsx',
      target: { workspaceId: 'ws', lakehouseId: 'lh', path: 'Files/intake/facturas' },
      meta: [
        {
          id: 'empresa_rut',
          label: 'Empresa receptora (RUT)',
          type: 'rut',
          required: true,
          from_filename: {
            patterns: ['Listado EasyDoc {codigo}.xlsx', 'Listado SAP {codigo}.xlsx'],
            catalog: { VH: '96835510-4', COVH: '99524070-K', IVL: '76526723-4', SAC: '78241100-4', TSV: '77130310-2' },
            verify_against: 'RUTRECEPTOR',
          },
        },
      ],
    },
  ],
}

describe('intake · metadata derivada del nombre (#95)', () => {
  it('parsea from_filename: patterns, catálogo y verify_against; `pattern` singular es azúcar', () => {
    const slot = parseIntakeConfig(FACTURAS)[0]
    const f = slot.meta![0]
    expect(f.fromFilename?.patterns).toEqual(['Listado EasyDoc {codigo}.xlsx', 'Listado SAP {codigo}.xlsx'])
    expect(f.fromFilename?.catalog?.['COVH']).toBe('99524070-K')
    expect(f.fromFilename?.verifyAgainst).toBe('RUTRECEPTOR')
    expect(metaEsDerivada(slot)).toBe(true)

    const uno = parseIntakeConfig({
      slots: [{ id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' }, meta: [{ id: 'v', label: 'V', type: 'string', from_filename: { pattern: 'Presupuesto {version}.xlsx' } }] }],
    })[0]
    expect(uno.meta![0].fromFilename?.patterns).toEqual(['Presupuesto {version}.xlsx'])
  })

  it('config mal formada = fallo ruidoso al arrancar (nunca al subir)', () => {
    const slot = (meta: unknown) => ({ slots: [{ id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' }, meta }] })
    const campo = (ff: unknown) => [{ id: 'x', label: 'X', type: 'string', from_filename: ff }]
    expect(() => parseIntakeConfig(slot(campo({})))).toThrow(/requiere 'pattern'/)
    expect(() => parseIntakeConfig(slot(campo({ pattern: 'a{x}b', patterns: ['a{x}b'] })))).toThrow(/no ambos/)
    expect(() => parseIntakeConfig(slot(campo({ pattern: 'sin marcador.xlsx' })))).toThrow(/exactamente un marcador/)
    expect(() => parseIntakeConfig(slot(campo({ pattern: '{a} y {b}.xlsx' })))).toThrow(/exactamente un marcador/)
    expect(() => parseIntakeConfig(slot(campo({ pattern: 'x {c}', catalog: [] })))).toThrow(/mapa token → valor/)
    expect(() => parseIntakeConfig(slot(campo({ pattern: 'x {c}', catalog: { VH: '1', vh: '2' } })))).toThrow(/colisiona/)
    expect(() => parseIntakeConfig(slot(campo({ pattern: 'x {c}', catalog: { VH: '' } })))).toThrow(/token o valor vacío/)
    expect(() => parseIntakeConfig(slot(campo({ pattern: 'x {c}', verify_against: '  ' })))).toThrow(/verify_against vacío/)
    // El sidecar se reserva sus llaves: un campo llamado `verify` pisaría el manifiesto del convertidor.
    expect(() => parseIntakeConfig(slot([{ id: 'verify', label: 'V', type: 'string' }]))).toThrow(/id reservado/)
  })

  it('camino 1 — el nombre calza y el código está en el catálogo: resuelve sin preguntar', () => {
    const slot = parseIntakeConfig(FACTURAS)[0]
    const f = slot.meta![0]
    expect(deriveMetaFromFilename(f, 'Listado EasyDoc VH.xlsx')).toEqual({ ok: true, value: '96835510-4' })
    expect(deriveMetaFromFilename(f, 'Listado SAP COVH.xlsx')).toEqual({ ok: true, value: '99524070-K' })
    // Case-insensitive en el patrón y en el token (el catálogo no tiene claves que colisionen).
    expect(deriveMetaFromFilename(f, 'listado easydoc vh.xlsx')).toEqual({ ok: true, value: '96835510-4' })
    // El formulario ya no manda: lo enviado se ignora frente a lo que declara el nombre.
    const r = validateMeta(slot, { empresa_rut: '77130310-2' }, 'Listado EasyDoc VH.xlsx')
    expect(r).toEqual({ ok: true, values: { empresa_rut: '96835510-4' }, verify: { empresa_rut: 'RUTRECEPTOR' } })
  })

  it('camino 2 — nombre fuera de convención o código fuera de catálogo: falla explícita, nombrando lo esperado', () => {
    const slot = parseIntakeConfig(FACTURAS)[0]
    const f = slot.meta![0]
    const fuera = deriveMetaFromFilename(f, 'Factura_VH.xlsx') as { ok: false; error: string }
    expect(fuera.ok).toBe(false)
    expect(fuera.error).toMatch(/no declara «Empresa receptora \(RUT\)»/)
    expect(fuera.error).toMatch(/Listado EasyDoc \{codigo\}\.xlsx/)
    expect(fuera.error).toMatch(/Listado SAP \{codigo\}\.xlsx/)

    const desconocido = deriveMetaFromFilename(f, 'Listado EasyDoc ZZZ.xlsx') as { ok: false; error: string }
    expect(desconocido.ok).toBe(false)
    expect(desconocido.error).toMatch(/'ZZZ'.*no está en el catálogo/)
    expect(desconocido.error).toMatch(/VH, COVH, IVL, SAC, TSV/)

    // La falla llega hasta validateMeta: el lote no entra a medias ni se imputa un default.
    expect(validateMeta(slot, {}, 'Factura_VH.xlsx').ok).toBe(false)
    expect(validateMeta(slot, {}, 'Listado EasyDoc ZZZ.xlsx').ok).toBe(false)
    // Sin nombre no hay derivación posible: fail-closed, no «se pide por formulario».
    expect((validateMeta(slot, { empresa_rut: '96835510-4' }) as { error: string }).error).toMatch(/no se recibió un nombre/)
  })

  it('camino 3 — la directiva de contraste contra el contenido viaja en el sidecar', () => {
    const slot = parseIntakeConfig(FACTURAS)[0]
    const r = validateMeta(slot, {}, 'Listado SAP TSV.xlsx') as { ok: true; values: Record<string, string>; verify: Record<string, string> }
    const json = JSON.parse(buildSidecar(slot.id, r.values, 'user@tenant', '2026-08-06T12:00:00Z', r.verify))
    expect(json).toEqual({
      slot: 'facturas_documentos',
      empresa_rut: '77130310-2',
      verify: { empresa_rut: 'RUTRECEPTOR' },
      uploadedBy: 'user@tenant',
      uploadedAt: '2026-08-06T12:00:00Z',
    })
    expect(Object.keys(json)).toEqual(['slot', 'empresa_rut', 'verify', 'uploadedBy', 'uploadedAt'])
    // Sin verify_against el sidecar queda idéntico al de #76 (regresión cero).
    expect(JSON.parse(buildSidecar('s', { a: '1' }, 'u', 't'))).toEqual({ slot: 's', a: '1', uploadedBy: 'u', uploadedAt: 't' })
  })

  it('sin catálogo el token capturado ES el valor, y el `type` del campo lo sigue validando', () => {
    const slot = parseIntakeConfig({
      slots: [{
        id: 'presupuesto', label: 'P', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' },
        meta: [{ id: 'version', label: 'Versión', type: 'number', required: true, from_filename: { pattern: 'Presupuesto V{version}*.xlsx' } }],
      }],
    })[0]
    expect(validateMeta(slot, {}, 'Presupuesto V3 - julio.xlsx')).toEqual({ ok: true, values: { version: '3' } })
    expect((validateMeta(slot, {}, 'Presupuesto Vbis.xlsx') as { error: string }).error).toMatch(/debe ser un número/)
  })

  it('el patrón es injection-safe: los metacaracteres del literal se escapan; `*`/`?` son comodines', () => {
    expect(filenamePatternToRegExp('a.b{x}.xlsx').test('aXbVH.xlsx')).toBe(false)
    expect(filenamePatternToRegExp('a.b{x}.xlsx').test('a.bVH.xlsx')).toBe(true)
    expect(tokenFromFilename({ patterns: ['Listado * {c}.xlsx'] }, 'Listado EasyDoc VH.xlsx')).toBe('VH')
    // El token no cruza puntos ni espacios: `Listado EasyDoc VH extra.xlsx` no calza el patrón cerrado.
    expect(tokenFromFilename({ patterns: ['Listado EasyDoc {c}.xlsx'] }, 'Listado EasyDoc VH extra.xlsx')).toBe(null)
  })
})
