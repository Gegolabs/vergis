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
  SYS_POLICY_VISIBILITY_SQL,
  consolaSelectPermisoSQL,
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
  /**
   * ¿Qué ve el principal que sondea el TERRENO? (#340) Por defecto, uno que puede leer
   * `sys.security_policies` — el caso sano. `'ciega'` es el principal permission-blind: enumera
   * `sys.tables` con normalidad y lee CERO filas de la vista de políticas aunque existan.
   */
  sonda?: 'vidente' | 'ciega' | 'muda' | 'falla'
  /**
   * Tablas sobre las que el principal de CONSOLA no tiene `SELECT` — la firma de un
   * `DENY SELECT ON <tabla> TO [<principal de consola>]` (#342). Se modela donde de verdad vive: en
   * lo que `HAS_PERMS_BY_NAME` contesta BAJO ESE PRINCIPAL, no en el gate.
   */
  sinSelect?: string[]
  /** Qué hace la sonda de permiso: por defecto contesta; `'muda'` devuelve `NULL`; `'falla'` lanza. */
  sondaPermiso?: 'contesta' | 'muda' | 'falla'
}
const ejecutorDe = (t: Terreno) => async (q: string): Promise<Record<string, unknown>[]> => {
  if (t.fallaEn?.test(q)) throw new Error('credencial vencida')
  // La ceguera es del PRINCIPAL, así que la trae puesta cualquiera que ejecute con ella: es la firma
  // medida —cero filas en la vista de políticas, `sys.tables` normal— y NO una peculiaridad del seam.
  if (t.sonda && t.sonda !== 'vidente') {
    if (q === SYS_POLICY_VISIBILITY_SQL) {
      if (t.sonda === 'falla') throw new Error('credencial vencida')
      return t.sonda === 'muda' ? [{ viewdef: null, viewany: null }] : [{ viewdef: 0, viewany: 0 }]
    }
    if (q === SYS_SECURITY_POLICIES_SQL) return []
  }
  if (q.includes('HAS_PERMS_BY_NAME') && q.includes('OBJECT')) {
    if ((t.sondaPermiso ?? 'contesta') === 'falla') throw new Error('credencial vencida')
    // Las tablas sondeadas se recuperan del propio SQL: así el fake no puede contestar por tablas
    // que el gate no preguntó, que es justo el modo de falla que haría verde un instrumento ciego.
    const pares = [...q.matchAll(/\(N'([^']*)', N'([^']*)'\)/g)].map((m) => `${m[1]}.${m[2]}`)
    const mudo = (t.sondaPermiso ?? 'contesta') === 'muda'
    return pares.map((x) => ({
      sch: x.split('.')[0],
      tbl: x.slice(x.indexOf('.') + 1),
      sel: mudo ? null : (t.sinSelect ?? []).includes(x) ? 0 : 1,
    }))
  }
  if (q === FN_MY_PERMISSIONS_SQL) return (t.permisos ?? ['CONNECT', 'SELECT']).map((p) => ({ permission_name: p }))
  if (q === SYS_TABLES_SQL) return (t.tablas ?? ['dbo.areas']).map((x) => ({ sch: x.split('.')[0], tbl: x.split('.')[1] }))
  if (q === SYS_SECURITY_POLICIES_SQL) return (t.protegidas ?? ['dbo.areas']).map((x) => ({ sch: x.split('.')[0], tbl: x.split('.')[1] }))
  if (q === UNMASK_PROBE_SCHEMAS_SQL) return (t.centinelaEn ?? []).map((s) => ({ sch: s }))
  if (q.includes('vergis_unmask_probe')) return [{ probe: t.centinelaValor ?? 'xxxx' }]
  throw new Error(`consulta inesperada: ${q}`)
}
/**
 * El ejecutor del TERRENO. La ceguera se modela donde de verdad vive —en la VISTA, no en el gate—:
 * el principal ciego responde `sys.tables` igual que el vidente y devuelve cero filas de
 * `sys.security_policies` **aunque el terreno esté gobernado**. Es la firma medida en producción
 * (#340) y reproducida en el arnés T-SQL local (SA ve 1 política, un principal con solo `SELECT` ve 0
 * sobre el MISMO terreno).
 */
const ejecutorTerrenoDe = (t: Terreno) => async (q: string): Promise<Record<string, unknown>[]> => {
  if (q === SYS_POLICY_VISIBILITY_SQL && (t.sonda ?? 'vidente') === 'vidente') return [{ viewdef: 1, viewany: 0 }]
  return ejecutorDe(t)(q)
}
const correr = (t: Terreno, store: Map<string, PolicyDecl>, tablasDelRef: string[] = ['dbo.areas'], readOnly: 'honra' | 'no-honra' | 'indeterminado' = 'honra') =>
  verificarConectorConsola({
    ejecutar: ejecutorDe(t),
    ejecutarTerreno: ejecutorTerrenoDe(t),
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

/**
 * #340 · **la corrida discriminante**: el terreno está gobernado y el principal que sondea NO ve las
 * políticas. «Medí y salió negativo» y «no pude medir» son hechos distintos con remediaciones
 * OPUESTAS —declarar 37 políticas vs conceder un permiso—, y el gate los colapsaba en el primero.
 * Estos casos fallan si el colapso vuelve: sin la guarda, el motivo dice «sin SECURITY POLICY».
 */
describe('gate de la Consola · (b·guarda) la ceguera NO es ausencia de gobierno (#340)', () => {
  it('principal ciego sobre terreno gobernado ⇒ «no se pudo medir», NUNCA «sin SECURITY POLICY»', async () => {
    const r = await correr({ tablas: ['dbo.areas', 'dbo.saldos'], protegidas: ['dbo.areas', 'dbo.saldos'], sonda: 'ciega' }, SOLO_FILA)
    expect(r.ofrecible).toBe(false) // fail-closed: lo que cambia es el motivo, no el veredicto
    expect(r.motivo).toContain('no se pudo medir el gobierno')
    expect(r.motivo).not.toContain('sin SECURITY POLICY')
    expect(r.motivo).toContain('NO declarar políticas nuevas') // la remediación apunta al permiso
    expect(r.medido.gobiernoVisible).toBe('blind')
    // Y NO se publica una lista de «tablas sin política» que sería falsa.
    expect(r.medido.tablasSinPolitica).toBeUndefined()
  })
  it('la sonda que contesta algo irreconocible (`NULL`) tampoco absuelve: `unknown`, y se dice', async () => {
    const r = await correr({ tablas: ['dbo.areas'], protegidas: ['dbo.areas'], sonda: 'muda' }, SOLO_FILA)
    expect(r.ofrecible).toBe(false)
    expect(r.medido.gobiernoVisible).toBe('unknown')
    expect(r.motivo).toContain('sin respuesta reconocible')
  })
  it('la sonda que LANZA es confesión de no-medición, no veredicto sobre el terreno', async () => {
    const r = await correr({ tablas: ['dbo.areas'], protegidas: ['dbo.areas'], sonda: 'falla' }, SOLO_FILA)
    expect(r.ofrecible).toBe(false)
    expect(r.medido.gobiernoVisible).toBe('unknown')
    expect(r.motivo).toContain('no se pudo medir el gobierno')
  })
  it('EL CONTRASTE · desgobierno REAL medido por un principal vidente ⇒ su propio motivo, con la tabla nombrada', async () => {
    const r = await correr({ tablas: ['dbo.areas'], protegidas: [], sonda: 'vidente' }, SOLO_FILA)
    expect(r.ofrecible).toBe(false)
    expect(r.motivo).toContain('sin SECURITY POLICY')
    expect(r.motivo).toContain('dbo.areas')
    expect(r.medido.gobiernoVisible).toBe('visible')
    expect(r.medido.tablasSinPolitica).toEqual(['dbo.areas'])
  })
  it('ver AL MENOS una política es prueba positiva: la guarda no se paga y no decide nada', async () => {
    const llamadas: string[] = []
    const r = await verificarConectorConsola({
      ejecutar: ejecutorDe({}),
      ejecutarTerreno: async (q) => {
        llamadas.push(q)
        return ejecutorTerrenoDe({})(q)
      },
      sondaReadOnly: async () => 'honra',
      store: SOLO_FILA,
      tablasDelRef: ['dbo.areas'],
      ref: 'fin',
    })
    expect(r.ofrecible).toBe(true)
    expect(llamadas).not.toContain(SYS_POLICY_VISIBILITY_SQL)
    expect(r.medido.gobiernoVisible).toBe('visible')
  })
  it('el terreno se sondea BAJO SERVING y lo del principal de consola se queda con él (las dos poblaciones)', async () => {
    const consola: string[] = []
    const terreno: string[] = []
    const r = await verificarConectorConsola({
      ejecutar: async (q) => {
        consola.push(q)
        return ejecutorDe({})(q)
      },
      ejecutarTerreno: async (q) => {
        terreno.push(q)
        return ejecutorTerrenoDe({})(q)
      },
      sondaReadOnly: async () => 'honra',
      store: SOLO_FILA,
      tablasDelRef: ['dbo.areas'],
      ref: 'fin',
    })
    expect(r.ofrecible).toBe(true)
    expect(terreno).toEqual([SYS_TABLES_SQL, SYS_SECURITY_POLICIES_SQL]) // la propiedad del TERRENO
    expect(consola).toEqual([FN_MY_PERMISSIONS_SQL]) // lo que sí es del principal de consola
  })
})

/**
 * #342 · **la segunda forma de cobertura de (b)**: una tabla base está cubierta si tiene
 * `SECURITY POLICY` **o** si el principal de consola no puede leerla. Lo que no se puede leer no
 * puede filtrar, y para las tablas que el PIPELINE lee y la Consola no debe ver (`_migrations`,
 * `_bak_*`, `raw_*`) es la única vía sana: una política de fila `deny` aplicaría a TODOS los
 * principales y dejaría al runner de migraciones viendo cero filas.
 *
 * **La corrida discriminante es la primera**, y sin el cambio falla: el Conector se rechazaba.
 */
describe('gate de la Consola · (b·permiso) lo que no se puede leer no puede filtrar (#342)', () => {
  it('LA DISCRIMINANTE · tabla sin política y SIN `SELECT` para la consola ⇒ ofrecible, y el motivo lo dice', async () => {
    const r = await correr(
      { tablas: ['dbo.areas', 'dbo._migrations'], protegidas: ['dbo.areas'], sinSelect: ['dbo._migrations'] },
      SOLO_FILA,
    )
    expect(r.ofrecible).toBe(true)
    expect(r.motivo).toContain('1 excluida(s) por permiso')
    expect(r.motivo).toContain('dbo._migrations')
    expect(r.medido.tablasConPolitica).toBe(1)
    expect(r.medido.tablasExcluidasPorPermiso).toEqual(['dbo._migrations'])
    expect(r.medido.tablasSinCobertura).toEqual([])
  })
  it('EL CONTRASTE · la misma tabla sin política pero CON `SELECT` ⇒ sigue bloqueando, con su motivo', async () => {
    const r = await correr({ tablas: ['dbo.areas', 'dbo._migrations'], protegidas: ['dbo.areas'] }, SOLO_FILA)
    expect(r.ofrecible).toBe(false)
    expect(r.motivo).toContain('sin SECURITY POLICY')
    expect(r.motivo).toContain('dbo._migrations')
    expect(r.medido.tablasSinCobertura).toEqual(['dbo._migrations'])
    expect(r.medido.tablasExcluidasPorPermiso).toEqual([])
  })
  it('las tres poblaciones se distinguen en el motivo, y solo K bloquea', async () => {
    const r = await correr(
      { tablas: ['dbo.areas', 'dbo._migrations', 'dbo.stg_oc'], protegidas: ['dbo.areas'], sinSelect: ['dbo._migrations'] },
      SOLO_FILA,
    )
    expect(r.ofrecible).toBe(false)
    expect(r.motivo).toContain('1 con política')
    expect(r.motivo).toContain('1 excluida(s) por permiso')
    expect(r.motivo).toContain('1 sin cobertura')
    expect(r.medido.tablasSinCobertura).toEqual(['dbo.stg_oc'])
  })
  it('la sonda que devuelve `NULL` NO cubre: cuenta en K y el motivo confiesa que no se midió', async () => {
    const r = await correr(
      { tablas: ['dbo.areas', 'dbo._migrations'], protegidas: ['dbo.areas'], sondaPermiso: 'muda' },
      SOLO_FILA,
    )
    expect(r.ofrecible).toBe(false)
    expect(r.motivo).toContain('No se pudo medir el permiso')
    expect(r.medido.tablasPermisoNoMedido).toEqual(['dbo._migrations'])
    expect(r.medido.tablasExcluidasPorPermiso).toEqual([])
  })
  it('la sonda que LANZA tampoco absuelve a nadie: todas quedan sin medir, y ninguna cubierta', async () => {
    const r = await correr(
      { tablas: ['dbo.areas', 'dbo._migrations'], protegidas: ['dbo.areas'], sondaPermiso: 'falla' },
      SOLO_FILA,
    )
    expect(r.ofrecible).toBe(false)
    expect(r.motivo).toContain('No se pudo medir el permiso')
    expect(r.motivo).toContain('credencial vencida')
    expect(r.medido.tablasSinCobertura).toEqual(['dbo._migrations'])
  })
  it('terreno completo por política ⇒ ofrecible SIN motivo y SIN pagar el RTT de la sonda', async () => {
    const consulta: string[] = []
    const r = await verificarConectorConsola({
      ejecutar: async (q) => {
        consulta.push(q)
        return ejecutorDe({})(q)
      },
      ejecutarTerreno: ejecutorTerrenoDe({}),
      sondaReadOnly: async () => 'honra',
      store: SOLO_FILA,
      tablasDelRef: ['dbo.areas'],
      ref: 'fin',
    })
    expect(r.ofrecible).toBe(true)
    expect(r.motivo).toBeUndefined()
    expect(consulta.some((q) => q.includes('HAS_PERMS_BY_NAME'))).toBe(false)
    expect(r.medido.tablasExcluidasPorPermiso).toEqual([])
  })
  it('la sonda cuesta UN RTT por Conector, no uno por tabla', async () => {
    const consulta: string[] = []
    const r = await verificarConectorConsola({
      ejecutar: async (q) => {
        consulta.push(q)
        return ejecutorDe({ tablas: ['a.t1', 'a.t2', 'a.t3'], protegidas: [], sinSelect: ['a.t1', 'a.t2', 'a.t3'] })(q)
      },
      ejecutarTerreno: ejecutorTerrenoDe({ tablas: ['a.t1', 'a.t2', 'a.t3'], protegidas: [], sonda: 'vidente' }),
      sondaReadOnly: async () => 'honra',
      store: SOLO_FILA,
      tablasDelRef: ['dbo.areas'],
      ref: 'fin',
    })
    expect(r.ofrecible).toBe(true)
    expect(consulta.filter((q) => q.includes('HAS_PERMS_BY_NAME')).length).toBe(1)
  })
  it('el SQL de la sonda escapa la comilla del nombre (una tabla no reescribe la consulta)', () => {
    const sqlText = consolaSelectPermisoSQL([`dbo.o'hara`])
    expect(sqlText).toContain(`N'o''hara'`)
    expect(sqlText.match(/\(N'/g)?.length).toBe(1)
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
