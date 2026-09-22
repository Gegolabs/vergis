/**
 * I3 · el gate de ofrecibilidad por Conector — PURO, con ejecutor falso.
 *
 * Lo que estos casos protegen es una sola frase: **ningún camino deja ofrecible lo que no se midió**.
 * Por eso hay un caso por condición, uno por cada forma de NO poder medir, y el positivo al final:
 * sin el positivo, N negativos podrían significar «esta función nunca ofrece nada».
 */
import { describe, it, expect } from 'vitest'
import {
  verificarConectorConsola,
  FN_MY_PERMISSIONS_SQL,
  SYS_TABLES_SQL,
  SYS_SECURITY_POLICIES_SQL,
  UNMASK_PROBE_SCHEMAS_SQL,
  UNMASK_PROBE_EXPECTED,
} from '../server/engines/fabric'
import type { PolicyDecl } from '@vergis/policy'

const POL_FILA: PolicyDecl = { predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }], combine: 'and', default: 'deny' }
const POL_COL: PolicyDecl = { ...POL_FILA, columnRules: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }

interface Terreno {
  permisos?: string[]
  tablas?: string[]
  protegidas?: string[]
  centinelaEn?: string[]
  centinelaValor?: string
  fallaEn?: RegExp
}
const ejecutorDe = (t: Terreno) => async (q: string): Promise<Record<string, unknown>[]> => {
  if (t.fallaEn?.test(q)) throw new Error('credencial vencida')
  if (q === FN_MY_PERMISSIONS_SQL) return (t.permisos ?? ['CONNECT', 'SELECT']).map((p) => ({ permission_name: p }))
  if (q === SYS_TABLES_SQL) return (t.tablas ?? ['dbo.areas']).map((x) => ({ sch: x.split('.')[0], tbl: x.split('.')[1] }))
  if (q === SYS_SECURITY_POLICIES_SQL) return (t.protegidas ?? ['dbo.areas']).map((x) => ({ sch: x.split('.')[0], tbl: x.split('.')[1] }))
  if (q === UNMASK_PROBE_SCHEMAS_SQL) return (t.centinelaEn ?? []).map((s) => ({ sch: s }))
  if (q.includes('vergis_unmask_probe')) return [{ probe: t.centinelaValor ?? 'xxxx' }]
  throw new Error(`consulta inesperada: ${q}`)
}
const correr = (t: Terreno, store: Map<string, PolicyDecl>, tablasDelRef: string[] = ['dbo.areas'], readOnly: 'honra' | 'no-honra' | 'indeterminado' = 'honra') =>
  verificarConectorConsola({
    ejecutar: ejecutorDe(t),
    sondaReadOnly: async () => readOnly,
    store,
    tablasDelRef,
    ref: 'fin',
    ahora: () => '2026-09-21T00:00:00.000Z',
  })

const SOLO_FILA = new Map([['dbo.areas', POL_FILA]])
const CON_COLUMNA = new Map([['dbo.areas', POL_COL]])

describe('gate de la Consola · (a) el principal no puede escribir', () => {
  it('un permiso de escritura NO se ofrece, y el motivo lo NOMBRA', async () => {
    const r = await correr({ permisos: ['CONNECT', 'SELECT', 'INSERT'] }, SOLO_FILA)
    expect(r.ofrecible).toBe(false)
    expect(r.motivo).toContain('INSERT')
  })
  it('`fn_my_permissions` que lanza ⇒ no ofrecible (no se pudo medir ≠ midió bien)', async () => {
    const r = await correr({ fallaEn: /fn_my_permissions/ }, SOLO_FILA)
    expect(r.ofrecible).toBe(false)
    expect(r.motivo).toContain('sin medición')
  })
  it('los `VIEW …` implícitos que el motor concede solo NO apagan el Conector (medido en lab:proof)', async () => {
    // Un `GRANT SELECT` a secas trae de arrastre `VIEW ANY COLUMN ENCRYPTION KEY DEFINITION` y
    // compañía. Con la lista literal del diseño ningún principal del mundo habría pasado (a).
    const r = await correr(
      { permisos: ['CONNECT', 'SELECT', 'VIEW DEFINITION', 'VIEW ANY COLUMN ENCRYPTION KEY DEFINITION', 'VIEW SECURITY DEFINITION', 'VIEW PERFORMANCE DEFINITION'] },
      SOLO_FILA,
    )
    expect(r.ofrecible).toBe(true)
  })
  it('`UNMASK` es permiso de BASE: (a) lo caza antes de que (c) llegue a medirse', async () => {
    // Defensa en profundidad que el diseño no previó y el arnés devolvió: `fn_my_permissions` lo
    // lista, así que un principal con UNMASK apaga el Conector por (a) — tenga o no reglas de columna.
    const r = await correr({ permisos: ['CONNECT', 'SELECT', 'UNMASK'] }, SOLO_FILA)
    expect(r.ofrecible).toBe(false)
    expect(r.motivo).toContain('UNMASK')
  })
  it('cero permisos devueltos ⇒ no ofrecible (el instrumento no midió)', async () => {
    const r = await correr({ permisos: [] }, SOLO_FILA)
    expect(r.ofrecible).toBe(false)
  })
})

describe('gate de la Consola · (b) toda tabla base gobernada', () => {
  it('una tabla sin política NO se ofrece y el motivo la nombra', async () => {
    const r = await correr({ tablas: ['dbo.areas', 'dbo.stg_oc'], protegidas: ['dbo.areas'] }, SOLO_FILA)
    expect(r.ofrecible).toBe(false)
    expect(r.motivo).toContain('dbo.stg_oc')
    expect(r.medido.tablasSinPolitica).toEqual(['dbo.stg_oc'])
  })
  it('el centinela de #238 se EXCLUYE de (b): es instrumento, no dato', async () => {
    const r = await correr({ tablas: ['dbo.areas', 'dbo.vergis_unmask_probe'], protegidas: ['dbo.areas'] }, SOLO_FILA)
    expect(r.ofrecible).toBe(true)
  })
  it('listar el gobierno que lanza ⇒ no ofrecible', async () => {
    const r = await correr({ fallaEn: /sys\.tables/ }, SOLO_FILA)
    expect(r.ofrecible).toBe(false)
    expect(r.motivo).toContain('sin medición')
  })
})

describe('gate de la Consola · P-7 y (c) son problemas DISTINTOS', () => {
  it('con reglas de columna NO se ofrece aunque el principal sea `incapable` de desenmascarar (P-7)', async () => {
    const r = await correr({ centinelaEn: ['dbo'], centinelaValor: 'xxxx' }, CON_COLUMNA)
    expect(r.ofrecible).toBe(false)
    expect(r.medido.unmask).toBe('incapable') // (c) PASA…
    expect(r.motivo).toContain('P-7') // …y aun así no se ofrece: el motivo es la inferencia por predicado
    expect(r.motivo).toContain('valor REAL')
  })
  it('con reglas de columna y principal `capable`, tampoco (y (c) queda medido)', async () => {
    const r = await correr({ centinelaEn: ['dbo'], centinelaValor: UNMASK_PROBE_EXPECTED }, CON_COLUMNA)
    expect(r.ofrecible).toBe(false)
    expect(r.medido.unmask).toBe('capable')
  })
  it('con reglas de columna y centinela AUSENTE ⇒ `uninstrumented`, y no se ofrece', async () => {
    const r = await correr({ centinelaEn: [] }, CON_COLUMNA)
    expect(r.ofrecible).toBe(false)
    expect(r.medido.unmask).toBe('uninstrumented')
  })
  it('SIN reglas de columna, el plano de columna no decide nada: se ofrece', async () => {
    const r = await correr({ centinelaEn: ['dbo'], centinelaValor: UNMASK_PROBE_EXPECTED }, SOLO_FILA)
    expect(r.ofrecible).toBe(true)
    expect(r.medido.columnRules).toBe(false)
  })
})

describe('gate de la Consola · (d) el motor honra @read_only', () => {
  it('si el re-set NO falla, el plano de fila no está garantizado ⇒ no se ofrece', async () => {
    const r = await correr({}, SOLO_FILA, ['dbo.areas'], 'no-honra')
    expect(r.ofrecible).toBe(false)
    expect(r.motivo).toContain('read_only')
  })
  it('indeterminado ⇒ no se ofrece (un instrumento que no midió no absuelve a nadie)', async () => {
    const r = await correr({}, SOLO_FILA, ['dbo.areas'], 'indeterminado')
    expect(r.ofrecible).toBe(false)
    expect(r.medido.readOnly).toBe('indeterminado')
  })
})

describe('gate de la Consola · el positivo', () => {
  it('todo medido y bien ⇒ ofrecible, con la marca de cuándo se verificó', async () => {
    const r = await correr({}, SOLO_FILA)
    expect(r.ofrecible).toBe(true)
    expect(r.motivo).toBeUndefined()
    expect(r.verificadoEn).toBe('2026-09-21T00:00:00.000Z')
    expect(r.medido.readOnly).toBe('honra')
  })
})
