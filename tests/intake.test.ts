import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
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

  // Issue #63: la instancia DECLARA que su convertidor ejecuta el DELETE del manifiesto de reversión.
  it('revert_delete: true lo declara · ausente = sin declaración · no-booleano rechaza nombrando el slot', () => {
    const base = { id: 'saldos', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' } }
    expect(parseIntakeConfig({ slots: [{ ...base, revert_delete: true }] })[0].revertDelete).toBe(true)
    expect(parseIntakeConfig({ slots: [base] })[0].revertDelete).toBeUndefined()
    expect(parseIntakeConfig({ slots: [{ ...base, revert_delete: false }] })[0].revertDelete).toBeUndefined()
    expect(() => parseIntakeConfig({ slots: [{ ...base, revert_delete: 'si' }] })).toThrow(/'saldos'\.revert_delete debe ser booleano/)
    expect(() => parseIntakeConfig({ slots: [{ ...base, revert_delete: 1 }] })).toThrow(/revert_delete/)
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
    // #109 · las options se normalizan a { value, label }: sin etiqueta declarada, label = value.
    expect(slot.meta![1].options).toEqual([{ value: 'V0', label: 'V0' }, { value: 'V1', label: 'V1' }, { value: 'V2', label: 'V2' }])
    expect(slot.meta![2]).toEqual({ id: 'folios', label: 'Folios', type: 'number' })
  })

  it('slot sin meta: meta queda undefined (regresión cero)', () => {
    const slot = parseIntakeConfig({ slots: [{ id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' } }] })[0]
    expect(slot.meta).toBeUndefined()
  })

  it('schema mal formado = fallo ruidoso: type inválido · enum sin options · options_ref sin catálogo · id dup · required no-bool', () => {
    const base = { id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' } }
    expect(() => parseIntakeConfig({ slots: [{ ...base, meta: [{ id: 'x', label: 'X', type: 'fecha' }] }] })).toThrow(/type inválido/)
    expect(() => parseIntakeConfig({ slots: [{ ...base, meta: [{ id: 'x', label: 'X', type: 'enum' }] }] })).toThrow(/requiere 'options'/)
    expect(() => parseIntakeConfig({ slots: [{ ...base, meta: [{ id: 'x', label: 'X', type: 'enum', options_ref: 'cat' }] }] })).toThrow(/catálogo desconocido/)
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

// ─── #109 · catálogo de la instancia como fuente de opciones (`options_ref`) ──

/** El caso motivador: `empresa_rut` deja de ser texto libre validado y pasa a ser dropdown de catálogo. */
const CATALOGO = {
  catalogs: [
    {
      id: 'empresas_gh',
      label: 'Empresas del grupo',
      options: [
        { value: '96835510-4', label: 'Hijuelas S.A.' },
        { value: '77130310-2', label: 'Agrícola El Tranque' },
        'OTRO',
      ],
    },
  ],
  slots: [{
    id: 'facturas', label: 'Facturas', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/f' },
    meta: [{ id: 'empresa_rut', label: 'Empresa (receptor)', type: 'enum', required: true, options_ref: 'empresas_gh' }],
  }],
}

const conCatalogo = (meta: unknown[], catalogs: unknown[] = CATALOGO.catalogs) => ({
  catalogs,
  slots: [{ id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' }, meta }],
})

describe('intake · catálogo de opciones de la instancia (#109)', () => {
  it('resuelve la referencia en parse-time: options con labels + optionsRef; la entrada string ≡ value=label', () => {
    const f = parseIntakeConfig(CATALOGO)[0].meta![0]
    expect(f.optionsRef).toBe('empresas_gh')
    expect(f.options).toEqual([
      { value: '96835510-4', label: 'Hijuelas S.A.' },
      { value: '77130310-2', label: 'Agrícola El Tranque' },
      { value: 'OTRO', label: 'OTRO' },
    ])
  })

  it('el bloque `catalogs` es opcional: ausente = cero catálogos (no lanza)', () => {
    expect(parseIntakeConfig({ slots: [] })).toEqual([])
    expect(parseIntakeConfig({ catalogs: [], slots: [] })).toEqual([])
    expect(() => parseIntakeConfig({ catalogs: 'no-lista', slots: [] })).toThrow(/`catalogs` debe ser una lista/)
  })

  it('un catálogo declarado y no referenciado es válido (sin warning)', () => {
    expect(parseIntakeConfig({ catalogs: CATALOGO.catalogs, slots: [{ id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' } }] })).toHaveLength(1)
  })

  it('catálogo mal declarado = fallo ruidoso: sin options · value duplicado · value vacío · id dup · id inválido', () => {
    const slots = [{ id: 's', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' } }]
    expect(() => parseIntakeConfig({ catalogs: [{ id: 'c' }], slots })).toThrow(/catálogo 'c' requiere 'options'/)
    expect(() => parseIntakeConfig({ catalogs: [{ id: 'c', options: [] }], slots })).toThrow(/requiere 'options'/)
    expect(() => parseIntakeConfig({ catalogs: [{ id: 'c', options: ['A', 'A'] }], slots })).toThrow(/value duplicado 'A'/)
    expect(() => parseIntakeConfig({ catalogs: [{ id: 'c', options: ['A', { label: 'sin value' }] }], slots })).toThrow(/opción #1 sin 'value'/)
    expect(() => parseIntakeConfig({ catalogs: [{ id: 'c', options: ['A'] }, { id: 'c', options: ['B'] }], slots })).toThrow(/id de catálogo duplicado 'c'/)
    expect(() => parseIntakeConfig({ catalogs: [{ id: 'MALO', options: ['A'] }], slots })).toThrow(/catálogo #0 con id inválido/)
  })

  it('la referencia del campo es fail-closed: desconocida · junto a options · en type no-enum · enum sin ninguna', () => {
    expect(() => parseIntakeConfig(conCatalogo([{ id: 'x', label: 'X', type: 'enum', options_ref: 'noexiste' }])))
      .toThrow(/catálogo desconocido 'noexiste' \(declarados: empresas_gh\)/)
    expect(() => parseIntakeConfig(conCatalogo([{ id: 'x', label: 'X', type: 'enum', options_ref: 'noexiste' }], [])))
      .toThrow(/no hay catálogos declarados/)
    expect(() => parseIntakeConfig(conCatalogo([{ id: 'x', label: 'X', type: 'enum', options: ['A'], options_ref: 'empresas_gh' }])))
      .toThrow(/no ambos/)
    expect(() => parseIntakeConfig(conCatalogo([{ id: 'x', label: 'X', type: 'string', options_ref: 'empresas_gh' }])))
      .toThrow(/'options_ref' solo aplica a type enum/)
    expect(() => parseIntakeConfig(conCatalogo([{ id: 'x', label: 'X', type: 'enum' }])))
      .toThrow(/requiere 'options' \(lista no vacía\) u 'options_ref'/)
  })

  it('las options inline también admiten { value, label } (mismo parser que el catálogo)', () => {
    const f = parseIntakeConfig(conCatalogo([{ id: 'x', label: 'X', type: 'enum', options: [{ value: 'V0', label: 'Borrador' }, 'V1'] }]))[0].meta![0]
    expect(f.options).toEqual([{ value: 'V0', label: 'Borrador' }, { value: 'V1', label: 'V1' }])
    expect(f.optionsRef).toBeUndefined()
    expect(() => parseIntakeConfig(conCatalogo([{ id: 'x', label: 'X', type: 'enum', options: ['A', 'A'] }]))).toThrow(/value duplicado/)
  })

  it('validateMeta: la pertenencia se mide por `value` — esta es la compuerta del POST, no el <select>', () => {
    const slot = parseIntakeConfig(CATALOGO)[0]
    expect(validateMeta(slot, { empresa_rut: '96835510-4' })).toEqual({ ok: true, values: { empresa_rut: '96835510-4' } })
    // Un HTML manipulado con un RUT fuera del catálogo NO pasa (y el mensaje nombra el catálogo).
    expect((validateMeta(slot, { empresa_rut: '12345678-5' }) as { error: string }).error)
      .toBe('«Empresa (receptor)»: \'12345678-5\' no está en el catálogo «empresas_gh».')
    // El `label` jamás es un valor aceptable: lo que viaja es el value.
    expect(validateMeta(slot, { empresa_rut: 'Hijuelas S.A.' }).ok).toBe(false)
  })

  it('validateMeta: el enum inline conserva su mensaje actual (regresión cero)', () => {
    const slot = parseIntakeConfig(META_SLOT)[0]
    expect((validateMeta(slot, { empresa_rut: '96835510-4', version: 'V9' }) as { error: string }).error)
      .toBe('«Versión»: \'V9\' no es una opción válida.')
  })

  it('from_filename + options_ref: doble compuerta — el valor derivado también debe estar en el catálogo', () => {
    const doc = {
      catalogs: CATALOGO.catalogs,
      slots: [{
        id: 'documentos', label: 'D', accept: '*.xlsx', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' },
        meta: [{
          id: 'empresa_rut', label: 'Empresa (receptor)', type: 'enum', required: true, options_ref: 'empresas_gh',
          from_filename: { pattern: 'Listado EasyDoc {codigo}.xlsx', catalog: { VH: '96835510-4', IVL: '76526723-4' } },
        }],
      }],
    }
    const slot = parseIntakeConfig(doc)[0]
    // Derivado y dentro del catálogo de la instancia → pasa, y el value es lo que viaja al sidecar.
    expect(validateMeta(slot, {}, 'Listado EasyDoc VH.xlsx')).toEqual({ ok: true, values: { empresa_rut: '96835510-4' } })
    // Derivado pero FUERA del catálogo → falla nombrando archivo y catálogo.
    expect((validateMeta(slot, {}, 'Listado EasyDoc IVL.xlsx') as { error: string }).error)
      .toBe('El valor \'76526723-4\' derivado del nombre \'Listado EasyDoc IVL.xlsx\' no está en el catálogo «empresas_gh» de «Empresa (receptor)».')
    // Los errores de #95 (nombre fuera de convención / token fuera del catálogo de tokens) siguen intactos.
    expect((validateMeta(slot, {}, 'Factura VH.xlsx') as { error: string }).error).toMatch(/no declara «Empresa \(receptor\)»/)
    expect((validateMeta(slot, {}, 'Listado EasyDoc ZZZ.xlsx') as { error: string }).error).toMatch(/no está en el catálogo de «Empresa \(receptor\)»/)
  })
})

// ─── Vigilancia declarada por slot: el bloque `watch:` (issue #161) ──────────────────────────────

const CON_WATCH = (watch: unknown, extra: Record<string, unknown> = {}) => ({
  slots: [{ id: 'saldos', label: 'S', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/x' }, watch, ...extra }],
})
const CON_TRIGGER = { trigger: { processRef: 'pipe1' } }

/**
 * El YAML de compatibilidad: representativo del contrato completo —catálogo, slot con trigger + meta
 * derivada + log + revert_delete, y slot land-only con `log: false`— y SIN una sola clave `watch:`.
 * Su parse esperado se capturó ejecutando el código PREVIO a este frente (commit `8592bba`) y se
 * congela acá: el test compara la ESTRUCTURA entera, no campo por campo, de modo que cualquier clave
 * que el parse nuevo agregara a un YAML viejo lo pone rojo.
 */
const YAML_SIN_WATCH = `
catalogs:
  - id: empresas_gh
    label: Empresas del grupo
    options:
      - value: '96835510-4'
        label: Hijuelas S.A.
      - OTRO
slots:
  - id: saldos_cartera
    label: Antigüedad de saldos (Cartera)
    description: Extracto semanal de cartera
    domain: cartera
    accept: 'Antigüedad de saldos *.xlsx'
    maxBytes: 1048576
    target:
      workspaceId: ws1
      lakehouseId: lh1
      path: Files/intake/saldos/
    trigger:
      processRef: pipe1
      workspaceId: ws2
      jobType: Notebook
    log: Files/code/conv.txt
    revert_delete: true
    meta:
      - id: empresa_rut
        label: Empresa (receptor)
        type: enum
        required: true
        options_ref: empresas_gh
        from_filename:
          patterns:
            - 'Listado EasyDoc {codigo}.xlsx'
          catalog:
            VH: '96835510-4'
          verify_against: rut_receptor
      - id: version
        label: Versión
        type: string
  - id: consumo_externo
    label: Consumo externo (land-only)
    target:
      workspaceId: ws1
      lakehouseId: lh1
      path: Files/intake/consumo
    log: false
`

const PARSE_CONGELADO = [
  {
    id: 'saldos_cartera',
    label: 'Antigüedad de saldos (Cartera)',
    target: { workspaceId: 'ws1', lakehouseId: 'lh1', path: 'Files/intake/saldos' },
    description: 'Extracto semanal de cartera',
    domain: 'cartera',
    accept: 'Antigüedad de saldos *.xlsx',
    maxBytes: 1048576,
    trigger: { processRef: 'pipe1', workspaceId: 'ws2', jobType: 'Notebook' },
    log: 'Files/code/conv.txt',
    revertDelete: true,
    meta: [
      {
        id: 'empresa_rut',
        label: 'Empresa (receptor)',
        type: 'enum',
        required: true,
        options: [{ value: '96835510-4', label: 'Hijuelas S.A.' }, { value: 'OTRO', label: 'OTRO' }],
        optionsRef: 'empresas_gh',
        fromFilename: { patterns: ['Listado EasyDoc {codigo}.xlsx'], catalog: { VH: '96835510-4' }, verifyAgainst: 'rut_receptor' },
      },
      { id: 'version', label: 'Versión', type: 'string' },
    ],
  },
  {
    id: 'consumo_externo',
    label: 'Consumo externo (land-only)',
    target: { workspaceId: 'ws1', lakehouseId: 'lh1', path: 'Files/intake/consumo' },
    log: false,
  },
]

const CLAVES_CONGELADAS = [
  ['id', 'label', 'target', 'description', 'domain', 'accept', 'maxBytes', 'trigger', 'log', 'revertDelete', 'meta'],
  ['id', 'label', 'target', 'log'],
]

describe('intake · vigilancia declarada por slot (`watch:`, #161)', () => {
  it('compatibilidad hacia atrás: un YAML sin `watch:` parsea ESTRUCTURALMENTE idéntico al contrato previo', () => {
    const slots = parseIntakeConfig(parseYaml(YAML_SIN_WATCH))
    // Igualdad estructural de TODO el resultado contra el parse congelado del código previo.
    expect(slots).toEqual(PARSE_CONGELADO)
    // `toEqual` ignora las claves cuyo valor es `undefined`: el juego de claves se compara aparte, para
    // que un `watch: undefined` colado en el objeto tampoco pase inadvertido.
    expect(slots.map((s) => Object.keys(s))).toEqual(CLAVES_CONGELADAS)
    expect(slots.every((s) => !('watch' in s))).toBe(true)
  })

  it('`watch: false` es el opt-out declarado; el mapa admite una clave, la otra, o ambas', () => {
    expect(parseIntakeConfig(CON_WATCH(false))[0].watch).toBe(false)
    expect(parseIntakeConfig(CON_WATCH({ max_age_minutes: 1440 }))[0].watch).toEqual({ maxAgeMinutes: 1440 })
    expect(parseIntakeConfig(CON_WATCH({ max_run_minutes: 90 }, CON_TRIGGER))[0].watch).toEqual({ maxRunMinutes: 90 })
    expect(parseIntakeConfig(CON_WATCH({ max_age_minutes: 30, max_run_minutes: 90 }, CON_TRIGGER))[0].watch)
      .toEqual({ maxAgeMinutes: 30, maxRunMinutes: 90 })
  })

  it('`watch: true` es error: no declara nada que el default no diga ya', () => {
    expect(() => parseIntakeConfig(CON_WATCH(true)))
      .toThrow(/intake: 'saldos'\.watch: 'true' no declara nada/)
  })

  it('fail-closed: bloque vacío · `watch:` sin valor · clave desconocida · forma que no es mapa ni booleano', () => {
    expect(() => parseIntakeConfig(CON_WATCH({}))).toThrow(/intake: 'saldos'\.watch está vacío/)
    expect(() => parseIntakeConfig(CON_WATCH(null))).toThrow(/intake: 'saldos'\.watch está vacío/)
    expect(() => parseIntakeConfig(CON_WATCH({ max_age_minutes: null }))).toThrow(/intake: 'saldos'\.watch está vacío/)
    expect(() => parseIntakeConfig(CON_WATCH({ maxAgeMinutes: 30 })))
      .toThrow(/intake: 'saldos'\.watch: clave desconocida 'maxAgeMinutes' \(esperadas: max_age_minutes, max_run_minutes\)/)
    expect(() => parseIntakeConfig(CON_WATCH({ max_age_minutes: 30, otra: 1 }))).toThrow(/clave desconocida 'otra'/)
    for (const forma of ['false', 120, [30]]) {
      expect(() => parseIntakeConfig(CON_WATCH(forma))).toThrow(/intake: 'saldos'\.watch debe ser 'false' o un mapa/)
    }
  })

  it('los umbrales son enteros positivos: 0, negativo, decimal, texto y booleano se acusan nombrando la clave', () => {
    for (const malo of [0, -5, 12.5, '30', true]) {
      expect(() => parseIntakeConfig(CON_WATCH({ max_age_minutes: malo })))
        .toThrow(/intake: 'saldos'\.watch\.max_age_minutes debe ser un entero positivo/)
    }
    expect(() => parseIntakeConfig(CON_WATCH({ max_run_minutes: 0 }, CON_TRIGGER)))
      .toThrow(/intake: 'saldos'\.watch\.max_run_minutes debe ser un entero positivo/)
  })

  it('`max_run_minutes` en un slot sin `trigger` es error: no hay corridas que medir', () => {
    expect(() => parseIntakeConfig(CON_WATCH({ max_run_minutes: 90 })))
      .toThrow(/intake: 'saldos'\.watch\.max_run_minutes requiere 'trigger'/)
    // Con trigger, la misma declaración es legítima: el control positivo del mismo mensaje.
    expect(parseIntakeConfig(CON_WATCH({ max_run_minutes: 90 }, CON_TRIGGER))[0].watch).toEqual({ maxRunMinutes: 90 })
  })

  it('el error nombra siempre al slot que lo trae (mensaje accionable en un YAML de muchos slots)', () => {
    const doc = {
      slots: [
        { id: 'bueno', label: 'B', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/a' }, watch: false },
        { id: 'malo', label: 'M', target: { workspaceId: 'w', lakehouseId: 'l', path: 'Files/b' }, watch: { max_age_minutes: -1 } },
      ],
    }
    expect(() => parseIntakeConfig(doc)).toThrow("intake: 'malo'.watch.max_age_minutes debe ser un entero positivo.")
  })
})
