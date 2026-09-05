import { describe, it, expect } from 'vitest'
import { createDiscovery, slugify, type DiscoveryDeps } from '../server/discovery'
import { createProtoRegistry } from '../server/proto-registry'
import { miraProtoBotlet } from '@vergis/mira'
import type { ProtoBotlet } from '@vergis/botler'
import type { ClaimSet, PolicyDecl } from '@vergis/policy'

function specYaml(code: string, sql: string, cap = 'execute-sql-ch'): string {
  return [
    `identity: { code: ${code}, display_name: "${code}" }`,
    `data:`,
    `  d1: { capability: ${cap}, params: { sql: "${sql}" } }`,
    `piece: { layout: rows, elements: [] }`,
    `delivery: { render: [{ format: html, target: web }] }`,
  ].join('\n')
}

const PUBLIC: PolicyDecl = { public: true }
const GOVERNED: PolicyDecl = {
  predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }],
  combine: 'and',
  default: 'deny',
}

function mk(over: Partial<DiscoveryDeps> & { specs: Record<string, string>; engine: 'clickhouse' | 'fabric' }) {
  const { specs, ...rest } = over
  return createDiscovery({
    store: new Map<string, PolicyDecl>([['qw04.areas', PUBLIC], ['dbo.saldos', GOVERNED]]),
    servingCaps: new Set(['execute-sql-ch']),
    protos: createProtoRegistry([miraProtoBotlet]),
    specPaths: () => Object.keys(specs),
    readSpec: (p) => specs[p],
    log: () => {},
    ...rest,
  })
}

describe('discovery · slugify', () => {
  it('minúscula, sin acentos, no-alfanum → guiones', () => {
    expect(slugify('QW-04 Producción')).toBe('qw-04-produccion')
  })
})

describe('discovery · descubrimiento y catálogo de serving', () => {
  it('lista los PIs servibles con su slug', () => {
    const d = mk({ engine: 'clickhouse', specs: { '/a.yaml': specYaml('QW-04', 'SELECT * FROM qw04.areas') } })
    const rep = d.discover()
    expect(rep).toHaveLength(1)
    expect(rep[0].slug).toBe('qw-04')
    expect(rep[0].tables).toEqual(['qw04.areas'])
  })

  it('omite un PI con capability fuera del catálogo de serving', () => {
    const d = mk({ engine: 'clickhouse', specs: { '/a.yaml': specYaml('X', 'SELECT 1 FROM qw04.areas', 'mock-sql') } })
    expect(d.discover()).toHaveLength(0)
  })

  it('avisa por log si dos specs colisionan en slug (la 2ª queda inalcanzable)', () => {
    const logs: string[] = []
    const d = mk({
      engine: 'clickhouse',
      specs: {
        '/a.yaml': specYaml('QW-04', 'SELECT * FROM qw04.areas'),
        '/b.yaml': specYaml('QW-04', 'SELECT * FROM qw04.areas'),
      },
      log: (m) => logs.push(m),
    })
    expect(d.discover()).toHaveLength(2)
    expect(logs.some((l) => l.includes('colisiona en slug'))).toBe(true)
  })
})

describe('discovery · gate de gobernanza fail-closed (fabric)', () => {
  it('fabric: un PI con tabla SIN política SÍ se descubre — el veredicto lo da la verificación por-PI (issues #52/#54)', () => {
    // Antes se omitía acá (404 silencioso). Ahora el PI existe y queda BLOQUEADO por piState hasta que
    // la verificación del bootstrap decida: sin política ni herencia de vista → 503 con motivo.
    const d = mk({ engine: 'fabric', specs: { '/a.yaml': specYaml('X', 'SELECT * FROM dbo.secreta', 'execute-sql-dwh') }, servingCaps: new Set(['execute-sql-dwh']) })
    expect(d.discover()).toHaveLength(1)
  })

  it('fabric: omite un PI con tabla de UNA sola parte (no verificable contra el store)', () => {
    const d = mk({ engine: 'fabric', specs: { '/a.yaml': specYaml('X', 'SELECT * FROM dim_area', 'execute-sql-dwh') }, servingCaps: new Set(['execute-sql-dwh']) })
    expect(d.discover()).toHaveLength(0)
  })

  it('fabric: SÍ sirve un PI cuyas tablas están todas gobernadas', () => {
    const d = mk({ engine: 'fabric', specs: { '/a.yaml': specYaml('OK', 'SELECT * FROM dbo.saldos', 'execute-sql-dwh') }, servingCaps: new Set(['execute-sql-dwh']) })
    expect(d.discover()).toHaveLength(1)
  })

  it('clickhouse: NO aplica el gate de tabla-sin-política (la seguridad la da el bootstrap)', () => {
    const d = mk({ engine: 'clickhouse', specs: { '/a.yaml': specYaml('X', 'SELECT * FROM dbo.secreta') } })
    expect(d.discover()).toHaveLength(1)
  })
})

describe('discovery · canAccess / visibleFor', () => {
  const d = mk({ engine: 'clickhouse', specs: {} })

  it('canAccess: pública → true; sin política → false (deny)', () => {
    expect(d.canAccess('qw04.areas', {})).toBe(true)
    expect(d.canAccess('inexistente', {})).toBe(false)
  })

  it('canAccess gobernada: true solo si la identidad trae el claim del predicado', () => {
    const conClaim: ClaimSet = { groups: ['ventas'] }
    expect(d.canAccess('dbo.saldos', conClaim)).toBe(true)
    expect(d.canAccess('dbo.saldos', {})).toBe(false)
  })

  it('visibleFor: PI sin datos gobernados es visible; con datos, filtra por acceso', () => {
    const reports = [
      { code: 'A', slug: 'a', name: 'A', specName: 'A', specPath: '/a', proto: 'mira', tables: [], databaseRefs: [] },
      { code: 'B', slug: 'b', name: 'B', specName: 'B', specPath: '/b', proto: 'mira', tables: ['dbo.saldos'], databaseRefs: [] },
    ]
    expect(d.visibleFor(reports, {}).map((r) => r.code)).toEqual(['A'])
    expect(d.visibleFor(reports, { groups: ['ventas'] }).map((r) => r.code)).toEqual(['A', 'B'])
  })

  // Issue #54: una vista-contrato sin entrada propia hereda la política de sus bases para la
  // visibilidad del índice, vía el linaje VIVO que puebla la verificación del bootstrap.
  it('canAccess hereda por linaje: la vista es accesible ssi TODAS sus bases lo son', () => {
    const lineage = new Map<string, string[]>([
      ['dbo.v_saldos', ['dbo.saldos']],
      ['dbo.v_mix', ['dbo.saldos', 'qw04.areas']], // gobernada + pública
      ['dbo.v_huerfana', ['staging.raw']], // base sin política ni linaje
      ['dbo.v2', ['dbo.v_saldos']], // transitiva (vista sobre vista)
      ['dbo.va', ['dbo.vb']], // ciclo defensivo
      ['dbo.vb', ['dbo.va']],
    ])
    const dv = mk({ engine: 'fabric', specs: {}, servingCaps: new Set(['execute-sql-dwh']), resolveBases: (t) => lineage.get(t) })
    const conClaim: ClaimSet = { groups: ['ventas'] }
    expect(dv.canAccess('dbo.v_saldos', conClaim)).toBe(true)
    expect(dv.canAccess('dbo.v_saldos', {})).toBe(false) // hereda también el deny
    expect(dv.canAccess('dbo.v_mix', conClaim)).toBe(true)
    expect(dv.canAccess('dbo.v_mix', {})).toBe(false) // una base gobernada sin claim niega el conjunto
    expect(dv.canAccess('dbo.v_huerfana', conClaim)).toBe(false) // sin certeza no hay herencia
    expect(dv.canAccess('dbo.v2', conClaim)).toBe(true) // transitiva
    expect(dv.canAccess('dbo.va', conClaim)).toBe(false) // ciclo → deny, sin colgarse
  })
})

describe('discovery · diagnóstico de la negación (#165 §3)', () => {
  const EQ: PolicyDecl = {
    predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'eq' }],
    combine: 'and',
    default: 'deny',
  }
  function mkEq() {
    return createDiscovery({
      store: new Map<string, PolicyDecl>([['qw04.areas', PUBLIC], ['dbo.saldos', EQ]]),
      engine: 'clickhouse',
      servingCaps: new Set(['execute-sql-ch']),
      protos: createProtoRegistry([miraProtoBotlet]),
      specPaths: () => ['/a.yaml', '/b.yaml'],
      readSpec: (p: string) =>
        p === '/a.yaml' ? specYaml('QW-04', 'SELECT * FROM qw04.areas') : specYaml('QW-09', 'SELECT * FROM dbo.saldos'),
      log: () => {},
    })
  }

  it('el gerente con DOS áreas legítimas: el PI se ve, y ahora hay línea que dice por qué está vacío', () => {
    const d = mkEq()
    const claims: ClaimSet = { groups: ['Gerencia General', 'Proyecto'] }
    const reports = d.discover()
    // La visibilidad NO cambia — es lo que el issue pide que no se toque.
    expect(d.visibleFor(reports, claims).map((r) => r.code).sort()).toEqual(['QW-04', 'QW-09'])
    const diag = d.diagnoseFor(reports, claims)
    expect(diag).toHaveLength(1)
    expect(diag[0].table).toBe('dbo.saldos')
    expect(diag[0].denials[0].kind).toBe('cardinalidad-eq')
  })

  it('el mismo sujeto con UN área: nada que diagnosticar', () => {
    const d = mkEq()
    expect(d.diagnoseFor(d.discover(), { groups: ['Gerencia General'] })).toEqual([])
  })

  it('sin claim: se diagnostica como `sin-claim`, distinto de la cardinalidad', () => {
    const d = mkEq()
    const diag = d.diagnoseFor(d.discover(), {})
    expect(diag.map((x) => x.denials[0].kind)).toEqual(['sin-claim'])
  })

  it('la tabla `grant: all` nunca aparece en el diagnóstico', () => {
    const d = mkEq()
    expect(d.diagnoseFor(d.discover(), {}).map((x) => x.table)).not.toContain('qw04.areas')
  })

  it('una tabla sin política propia no se inventa un hallazgo (la herencia de vista se resuelve aparte)', () => {
    const d = createDiscovery({
      store: new Map<string, PolicyDecl>(),
      engine: 'clickhouse',
      servingCaps: new Set(['execute-sql-ch']),
      protos: createProtoRegistry([miraProtoBotlet]),
      specPaths: () => ['/a.yaml'],
      readSpec: () => specYaml('QW-04', 'SELECT * FROM qw04.areas'),
      log: () => {},
    })
    expect(d.diagnoseFor(d.discover(), {})).toEqual([])
  })
})

// --- H0 (#289) · el descubrimiento pasa por el registro de proto-Botlets ---------------------
//
// Lo que estos tests miden NO es el registro (eso es proto-registry.test.ts): es la REGLA DE
// COMPATIBILIDAD de §3.3 del brief, la que garantiza que H0 no cambie la conducta de ninguna
// instancia viva. Antes de H0 el nodo servía cualquier YAML de Mira aunque no trajera
// `mira_version`, y una instancia real puede tener specs así en `/opt/mira/specs`.

/** Proto FICTICIO de test (H0 no crea `packages/daftar`): con él se mide el brazo de DOS familias. */
const fakeDaftar: ProtoBotlet<Record<string, unknown>> = {
  type: 'daftar',
  discriminator: 'daftar_version',
  parse: (t) => ({ t }),
  capabilitiesOf: () => [],
  dataOf: () => [],
  identityOf: () => ({ code: 'x' }),
}

describe('discovery · registro de proto-Botlets (H0 · #289)', () => {
  const SPEC_SIN = specYaml('QW-04', 'SELECT * FROM qw04.areas') // el `specYaml` de arriba NO trae `mira_version`
  const SPEC_CON = `mira_version: "1.0"\n${SPEC_SIN}`

  it('`Report.proto` dice qué familia reconoció la spec', () => {
    const logs: string[] = []
    const d = mk({ engine: 'clickhouse', specs: { '/a.yaml': SPEC_CON }, log: (m) => logs.push(m) })
    expect(d.discover().map((r) => r.proto)).toEqual(['mira'])
    expect(logs.filter((l) => l.includes('se asume Mira'))).toHaveLength(0) // con la clave, no hay aviso
  })

  it('con UN proto, una spec sin `mira_version` se descubre igual y se avisa UNA vez por ruta', () => {
    const logs: string[] = []
    const d = mk({ engine: 'clickhouse', specs: { '/a.yaml': SPEC_SIN }, log: (m) => logs.push(m) })
    expect(d.discover().map((r) => r.slug)).toEqual(['qw-04'])
    d.discover() // memoizado: no re-escanea
    // ... y tampoco tras un rebuild(), que SÍ re-escanea: el aviso es una vez por ruta y por proceso,
    // no una por escaneo (si no, un hot-reload periódico lo volvería ruido de log).
    d.rebuild()
    d.discover()
    expect(logs.filter((l) => l.includes('se asume Mira'))).toHaveLength(1)
    expect(logs[0]).toContain('/a.yaml')
    expect(logs[0]).toContain('mira_version')
  })

  it('con DOS protos registrados, la MISMA spec sin discriminador se OMITE y el log lo dice', () => {
    const logs: string[] = []
    const d = mk({
      engine: 'clickhouse',
      specs: { '/a.yaml': SPEC_SIN },
      protos: createProtoRegistry([miraProtoBotlet, fakeDaftar]),
      log: (m) => logs.push(m),
    })
    expect(d.discover()).toHaveLength(0)
    expect(logs.some((l) => l.includes('no declara la clave de ninguna familia registrada'))).toBe(true)
    expect(logs.some((l) => l.includes('se asume'))).toBe(false)
  })

  it('una spec AMBIGUA (dos discriminadores) se omite con log y no se lista', () => {
    const logs: string[] = []
    const d = mk({
      engine: 'clickhouse',
      specs: { '/a.yaml': `daftar_version: "1.0"\n${SPEC_CON}` },
      protos: createProtoRegistry([miraProtoBotlet, fakeDaftar]),
      log: (m) => logs.push(m),
    })
    expect(d.discover()).toHaveLength(0)
    expect(logs.some((l) => l.includes('más de un discriminador'))).toBe(true)
  })

  it('un texto que no es YAML se omite EN SILENCIO, como siempre', () => {
    const logs: string[] = []
    const d = mk({ engine: 'clickhouse', specs: { '/a.yaml': '{ no cierra\n  ni: yaml' }, log: (m) => logs.push(m) })
    expect(d.discover()).toHaveLength(0)
    expect(logs).toEqual([])
  })
})
