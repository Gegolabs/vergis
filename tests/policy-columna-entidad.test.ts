// El plano de columna en la forma ENTIDAD-CANÓNICA — issue #163 H5 (diseño §4.1–§4.3, charter §2c).
//
// El hito 4 cerró el fail-open en el spec (`quality.audience.columns`) y en el store legacy
// (`policies[].columns`). Quedaba abierto en la forma que el charter PREFIERE: `entities[].columns`
// se ignoraba en silencio, así que alguien podía escribir la protección en la entidad, el resolver
// no la leía, y la columna se servía en claro con el autor creyendo que la había protegido.
//
// La gramática que se fija acá es la que el archivo ya usa para el plano de fila: la regla se declara
// en la ENTIDAD sobre un ATRIBUTO canónico (`columns: [{column, claim, action}]`) y cada dataset dice
// qué COLUMNA FÍSICA lo realiza (`columns: {atributo: columna}`) — exactamente `governed_by` ↔
// `dimensions`. Y el binder liga esas columnas contra el schema, porque una regla que apunta a una
// columna inexistente no enmascara nada y tampoco avisa.
//
// Lo que NO se prueba acá: la semántica de la máscara (`policy-columna.test.ts`, el oráculo) ni la
// declaración en spec/store legacy (`policy-columna-decl.test.ts`).

import { describe, expect, it } from 'vitest'
import { VergisError } from '@vergis/botler'
import { applyPolicy, bindPolicy, MASK_VALUE, maskedColumns, resolveEntityStore, type Policy, type PolicyDecl } from '@vergis/policy'

const GOV = [{ dimension: 'area', claim: 'groups', op: 'in' }]
/** Los predicados que la entidad produce HOY, sin plano de columna. Ancla del control negativo. */
const PREDICADOS_HOY = [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }]

/** Store canónico con una entidad protegida y dos datasets que la realizan con nombres distintos. */
const STORE = {
  entities: [
    {
      entity: 'empleado',
      governed_by: GOV,
      columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }],
    },
  ],
  datasets: [
    { dataset: 'pi04.empleado', realizes: 'empleado', dimensions: { area: 'area' }, columns: { rut: 'rut' } },
    // El mismo atributo canónico realizado por OTRA columna física: el punto entero del mapeo.
    { dataset: 'dbo.dim_empleado', realizes: 'empleado', dimensions: { area: 'area_name' }, columns: { rut: 'rut_empleado' } },
  ],
}

/** El error estructurado de una resolución que debe romper. Falla la prueba si NO rompe. */
function estructuradoDe(fn: () => unknown): Record<string, unknown> {
  try {
    const r = fn()
    throw new Error(`se esperaba un VergisError y devolvió: ${JSON.stringify([...(r as Map<string, unknown>)])}`)
  } catch (e) {
    if (!(e instanceof VergisError)) throw e
    return e.structured as unknown as Record<string, unknown>
  }
}

describe('#163 H5 · declaración de columna en la entidad canónica', () => {
  it('la regla de la entidad llega al IR con la columna FÍSICA de cada dataset ya resuelta', () => {
    const m = resolveEntityStore(STORE)
    const a = m.get('pi04.empleado') as Policy
    const b = m.get('dbo.dim_empleado') as Policy
    expect(a.predicates).toEqual(PREDICADOS_HOY) // el plano de fila no se movió
    expect(a.columnRules).toEqual([{ column: 'rut', claim: 've_pii', action: 'mask' }])
    // La entidad declaró `rut` (atributo); el dataset lo realiza en `rut_empleado` (columna física).
    expect(b.columnRules).toEqual([{ column: 'rut_empleado', claim: 've_pii', action: 'mask' }])
  })

  it('la declaración llega ENTERA hasta el oráculo, con la columna de CADA dataset', () => {
    const m = resolveEntityStore(STORE)
    const filaA = { area: 'Producción', rut: '11.111.111-1' }
    const filaB = { area_name: 'Producción', rut_empleado: '11.111.111-1' }
    const claims = { groups: ['Producción'] }
    expect(applyPolicy(m.get('pi04.empleado')!, claims, [filaA])).toEqual([{ area: 'Producción', rut: MASK_VALUE }])
    expect(applyPolicy(m.get('dbo.dim_empleado')!, claims, [filaB])).toEqual([{ area_name: 'Producción', rut_empleado: MASK_VALUE }])
    // Con el claim, la celda va en claro — la regla mira PRESENCIA del claim, no su valor.
    expect(applyPolicy(m.get('pi04.empleado')!, { ...claims, ve_pii: ['si'] }, [filaA])).toEqual([filaA])
  })

  it('varias reglas sobre varios atributos: se conservan todas, en orden, ya mapeadas', () => {
    const m = resolveEntityStore({
      entities: [
        {
          entity: 'empleado',
          governed_by: GOV,
          columns: [
            { column: 'rut', claim: 've_pii', action: 'mask' },
            { column: 'sueldo', claim: 've_remuneracion', action: 'mask' },
            { column: 'rut', claim: 've_rrhh', action: 'mask' }, // dos claims sobre el MISMO atributo
          ],
        },
      ],
      datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado', dimensions: { area: 'area' }, columns: { rut: 'rut_emp', sueldo: 'renta_liquida' } }],
    })
    const p = m.get('pi04.empleado') as Policy
    expect(p.columnRules).toEqual([
      { column: 'rut_emp', claim: 've_pii', action: 'mask' },
      { column: 'renta_liquida', claim: 've_remuneracion', action: 'mask' },
      { column: 'rut_emp', claim: 've_rrhh', action: 'mask' },
    ])
    // La ausencia de CUALQUIERA de los dos claims deja `rut_emp` enmascarada: default-deny de la celda.
    expect([...maskedColumns(p, { ve_pii: ['si'] })].sort()).toEqual(['renta_liquida', 'rut_emp'])
    expect([...maskedColumns(p, { ve_pii: ['si'], ve_rrhh: ['si'], ve_remuneracion: ['si'] })]).toEqual([])
  })

  it('una entidad se declara UNA vez y protege a todos sus datasets (el punto de la forma canónica)', () => {
    const m = resolveEntityStore(STORE)
    for (const ds of ['pi04.empleado', 'dbo.dim_empleado']) {
      expect((m.get(ds) as Policy).columnRules).toHaveLength(1)
    }
  })

  it('`columns: []` en la entidad es «declara cero», explícito y legítimo', () => {
    const m = resolveEntityStore({
      entities: [{ entity: 'empleado', governed_by: GOV, columns: [] }],
      datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado', dimensions: { area: 'area' } }],
    })
    const p = m.get('pi04.empleado') as Policy
    expect(p.columnRules).toEqual([])
    expect(maskedColumns(p, {}).size).toBe(0)
  })
})

describe('#163 H5 · fail-closed AL RESOLVER: lo malformado rompe, no produce una policy sin reglas', () => {
  /** Cada caso: [título, `columns` de la entidad, `columns` del dataset, código exacto]. */
  const casos: Array<[string, unknown, Record<string, unknown> | undefined, string]> = [
    ['acción desconocida', [{ column: 'rut', claim: 've_pii', action: 'hide' }], { rut: 'rut' }, 'column-rule-action'],
    ['acción con otra caja', [{ column: 'rut', claim: 've_pii', action: 'MASK' }], { rut: 'rut' }, 'column-rule-action'],
    ['sin `action`', [{ column: 'rut', claim: 've_pii' }], { rut: 'rut' }, 'column-rule-action'],
    ['sin `column`', [{ claim: 've_pii', action: 'mask' }], { rut: 'rut' }, 'column-rule-column'],
    ['sin `claim`', [{ column: 'rut', action: 'mask' }], { rut: 'rut' }, 'column-rule-claim'],
    ['`claim` vacío', [{ column: 'rut', claim: '', action: 'mask' }], { rut: 'rut' }, 'column-rule-claim'],
    ['la regla no es un objeto', ['rut'], { rut: 'rut' }, 'column-rule-shape'],
    ['`columns` de la entidad no es lista', { column: 'rut' }, { rut: 'rut' }, 'columns-malformed'],
    ['clave de más: no hay reglas condicionales', [{ column: 'rut', claim: 've_pii', action: 'mask', if: 'region = Norte' }], { rut: 'rut' }, 'column-rule-unknown-key'],
    ['atributo protegido SIN mapear en el dataset', [{ column: 'rut', claim: 've_pii', action: 'mask' }], undefined, 'column-unmapped'],
    ['mapeo a algo que no es un nombre de columna', [{ column: 'rut', claim: 've_pii', action: 'mask' }], { rut: 42 }, 'column-unmapped'],
    ['mapeo a nombre vacío', [{ column: 'rut', claim: 've_pii', action: 'mask' }], { rut: '' }, 'column-unmapped'],
    ['typo en la clave del mapeo (el atributo real queda sin mapear)', [{ column: 'rut', claim: 've_pii', action: 'mask' }], { ruut: 'rut' }, 'column-mapping-unknown'],
    ['el dataset mapea columnas y la entidad no protege ninguna', undefined, { rut: 'rut' }, 'column-mapping-unknown'],
  ]

  const resolver = (columns: unknown, mapeo: Record<string, unknown> | undefined) =>
    resolveEntityStore({
      entities: [{ entity: 'empleado', governed_by: GOV, ...(columns === undefined ? {} : { columns }) }],
      datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado', dimensions: { area: 'area' }, ...(mapeo === undefined ? {} : { columns: mapeo }) }],
    })

  it.each(casos)('%s → rompe con VergisError y código exacto', (_titulo, columns, mapeo, code) => {
    const s = estructuradoDe(() => resolver(columns, mapeo))
    expect(s.code).toBe(code)
    expect(String(s.path)).toMatch(/columns/) // el path señala dónde está la falta
    expect(s.remediation).toBeTruthy() // el error es accionable, no un "invalid input"
  })

  it('LA falla silenciosa que esto mata: jamás devuelve un mapa con la policy sin reglas', () => {
    for (const [, columns, mapeo] of casos) {
      let devuelto: Map<string, PolicyDecl> | undefined
      try {
        devuelto = resolver(columns, mapeo)
      } catch {
        /* lo esperado */
      }
      // Si esto falla, el resolver degradó a «policy sin reglas de columna» y el PI sirve el dato en
      // claro con el autor creyendo que lo protegió — el fail-open que el hito viene a matar.
      expect(devuelto).toBeUndefined()
    }
  })

  it('rompe TODO el store, no solo esa entidad: no queda un mapa a medias', () => {
    expect(() =>
      resolveEntityStore({
        entities: [
          { entity: 'area', governed_by: GOV },
          { entity: 'empleado', governed_by: GOV, columns: [{ column: 'rut', claim: 've_pii', action: 'ocultar' }] },
        ],
        datasets: [{ dataset: 'pi04.area', realizes: 'area', dimensions: { area: 'area' } }],
      }),
    ).toThrow(VergisError)
  })

  it('una regla malformada rompe aunque NINGÚN dataset realice esa entidad todavía', () => {
    // Se parsea al registrar la entidad, no al realizarla: si no, el typo vive latente y el error
    // aparece el día que alguien mapea el dataset — lejos de su causa.
    const s = estructuradoDe(() =>
      resolveEntityStore({ entities: [{ entity: 'empleado', governed_by: GOV, columns: [{ column: 'rut', claim: 've_pii', action: 'ocultar' }] }], datasets: [] }),
    )
    expect(s.code).toBe('column-rule-action')
    expect(s.path).toBe('entities[empleado].columns[0]')
  })

  it('el `path` señala la regla exacta que hay que corregir (no la lista entera)', () => {
    const s = estructuradoDe(() =>
      resolveEntityStore({
        entities: [{ entity: 'empleado', governed_by: GOV, columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }, { column: 'sueldo', claim: 've_rem', action: 'ocultar' }] }],
        datasets: [],
      }),
    )
    expect(s.path).toBe('entities[empleado].columns[1]')
    expect(s.value).toBe('ocultar')
  })

  it('el mapeo del dataset es un MAPA, no una lista de reglas: confundir las dos formas rompe', () => {
    const s = estructuradoDe(() =>
      resolveEntityStore({
        entities: [{ entity: 'empleado', governed_by: GOV, columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }],
        datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado', dimensions: { area: 'area' }, columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] as unknown as Record<string, unknown> }],
      }),
    )
    expect(s.code).toBe('column-map-malformed')
  })

  it('`grant: all` con mapeo de columnas rompe: no hay entidad de la cual mapear', () => {
    const s = estructuradoDe(() => resolveEntityStore({ entities: [], datasets: [{ dataset: 'ref.personas', grant: 'all', columns: { rut: 'rut' } }] }))
    expect(s.code).toBe('grant-columns-unsupported')
    expect(s.remediation).toMatch(/legacy|entidad/i) // dice dónde SÍ se declara
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// #163 H7 · EL CASO QUE ORIGINA EL ISSUE: fila abierta + columna protegida, en la forma canónica.
//
// El hito 5 dejó la capacidad disponible solo en la forma legacy, porque la única manera de abrir la
// fila era `datasets[].grant: all` — y un dataset abierto no realiza entidad, así que no había
// atributo canónico que mapear. La apertura sube a la ENTIDAD: `grant: all` ahí abre la fila y
// convive con `columns`, sin abrir un segundo sitio de autoría.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** La instancia de referencia: `empleado` abierta por decisión del cliente, con PII adentro. */
const ABIERTA = {
  entities: [
    {
      entity: 'empleado',
      grant: 'all', // apertura explícita y gobernada de FILA — no un bypass
      columns: [
        { column: 'rut', claim: 've_pii', action: 'mask' },
        { column: 'sueldo', claim: 've_remuneracion', action: 'mask' },
      ],
    },
  ],
  datasets: [
    { dataset: 'pi04.empleado', realizes: 'empleado', columns: { rut: 'rut', sueldo: 'renta_liquida' } },
    // La misma entidad realizada por otro dataset con nombres físicos distintos.
    { dataset: 'dbo.dim_empleado', realizes: 'empleado', columns: { rut: 'rut_empleado', sueldo: 'sueldo_bruto' } },
  ],
}

describe('#163 H7 · la entidad abierta en filas protege columnas (el caso del issue)', () => {
  it('la policy sale PÚBLICA en filas y CON la regla de columna ya mapeada a la columna física', () => {
    const m = resolveEntityStore(ABIERTA)
    expect(m.get('pi04.empleado')).toEqual({
      public: true, // la semántica de fila de `grant: all` queda intacta
      columnRules: [
        { column: 'rut', claim: 've_pii', action: 'mask' },
        { column: 'renta_liquida', claim: 've_remuneracion', action: 'mask' },
      ],
    })
  })

  it('dos datasets, el MISMO atributo con nombres físicos distintos: una sola declaración los cubre', () => {
    const m = resolveEntityStore(ABIERTA)
    expect((m.get('dbo.dim_empleado') as PolicyDecl & { columnRules: unknown }).columnRules).toEqual([
      { column: 'rut_empleado', claim: 've_pii', action: 'mask' },
      { column: 'sueldo_bruto', claim: 've_remuneracion', action: 'mask' },
    ])
    // Y sigue siendo pública: la apertura es de la entidad, no de cada dataset.
    expect(m.get('dbo.dim_empleado')).toMatchObject({ public: true })
  })

  it('contra el oráculo: sin el claim la celda va enmascarada; con el claim, en claro — y TODAS las filas pasan', () => {
    const p = resolveEntityStore(ABIERTA).get('pi04.empleado')!
    const filas = [
      { area: 'Producción', nombre: 'Ana', rut: '11.111.111-1', renta_liquida: 1_200_000 },
      { area: 'Finanzas', nombre: 'Beto', rut: '22.222.222-2', renta_liquida: 2_400_000 },
    ]
    // Sujeto SIN ningún claim: ve las dos filas (público) y ninguna celda sensible.
    expect(applyPolicy(p, {}, filas)).toEqual([
      { area: 'Producción', nombre: 'Ana', rut: MASK_VALUE, renta_liquida: MASK_VALUE },
      { area: 'Finanzas', nombre: 'Beto', rut: MASK_VALUE, renta_liquida: MASK_VALUE },
    ])
    // Un claim habilita SU columna y solo esa: el default-deny es por celda.
    expect(applyPolicy(p, { ve_pii: ['si'] }, [filas[0]])).toEqual([{ ...filas[0], renta_liquida: MASK_VALUE }])
    // Con los dos claims, la fila sale intacta y SIN copiar (la extensión es conservadora).
    expect(applyPolicy(p, { ve_pii: ['si'], ve_remuneracion: ['si'] }, filas)[0]).toBe(filas[0])
  })

  it('el binder liga las columnas enmascaradas también en la policy pública (el caso más expuesto)', () => {
    const CTX_ABIERTA = { columns: ['area', 'nombre', 'rut', 'renta_liquida'], claims: ['ve_pii', 've_remuneracion'] }
    const p = resolveEntityStore(ABIERTA).get('pi04.empleado')!
    expect(() => bindPolicy(p, CTX_ABIERTA)).not.toThrow()
    // Un typo en la columna física de una entidad ABIERTA no lo caza el plano de fila (no hay
    // predicados que ligar): si el binder volviera temprano por `public`, nadie lo vería.
    const conTypo = resolveEntityStore({
      entities: [{ entity: 'empleado', grant: 'all', columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }],
      datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado', columns: { rut: 'ruut' } }],
    }).get('pi04.empleado')!
    const s = estructuradoDe(() => bindPolicy(conTypo, CTX_ABIERTA))
    expect(s.code).toBe('unknown-column')
    expect(s.value).toBe('ruut')
  })

  it('control negativo de la apertura: entidad abierta SIN `columns` = la policy pública de siempre', () => {
    const m = resolveEntityStore({
      entities: [{ entity: 'area', grant: 'all' }],
      datasets: [{ dataset: 'dim_area', realizes: 'area' }],
    })
    expect(m.get('dim_area')).toEqual({ public: true }) // igualdad estructural con el `grant: all` del dataset
    expect('columnRules' in (m.get('dim_area') as object)).toBe(false)
  })

  it('`columns: []` en una entidad abierta es «declara cero», y viaja explícito', () => {
    const m = resolveEntityStore({ entities: [{ entity: 'area', grant: 'all', columns: [] }], datasets: [{ dataset: 'dim_area', realizes: 'area' }] })
    expect(m.get('dim_area')).toEqual({ public: true, columnRules: [] })
  })
})

describe('#163 H7 · fail-closed de la entidad abierta', () => {
  /** Cada caso: [título, store, código exacto]. */
  const casos: Array<[string, unknown, string]> = [
    [
      'valor de `grant` fuera del vocabulario',
      { entities: [{ entity: 'empleado', grant: 'publico' }], datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado' }] },
      'grant-unsupported',
    ],
    [
      '`grant: true` (el booleano no es el literal)',
      { entities: [{ entity: 'empleado', grant: true }], datasets: [] },
      'grant-unsupported',
    ],
    [
      'gobierno Y apertura a la vez: no hay lectura única',
      { entities: [{ entity: 'empleado', grant: 'all', governed_by: GOV, columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }], datasets: [] },
      'entity-grant-and-governed',
    ],
    [
      'el dataset mapea dimensiones a una entidad abierta (cree que filtra y no filtra)',
      {
        entities: [{ entity: 'empleado', grant: 'all', columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }],
        datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado', dimensions: { area: 'area' }, columns: { rut: 'rut' } }],
      },
      'entity-open-dimensions',
    ],
    [
      'atributo protegido SIN mapear (mismo código que en la entidad gobernada)',
      {
        entities: [{ entity: 'empleado', grant: 'all', columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }],
        datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado' }],
      },
      'column-unmapped',
    ],
    [
      'mapeo a un atributo que la entidad abierta no protege (typo)',
      {
        entities: [{ entity: 'empleado', grant: 'all', columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }],
        datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado', columns: { ruut: 'rut' } }],
      },
      'column-mapping-unknown',
    ],
    [
      'regla malformada en una entidad abierta: mismo vocabulario, mismo código',
      { entities: [{ entity: 'empleado', grant: 'all', columns: [{ column: 'rut', claim: 've_pii', action: 'hide' }] }], datasets: [] },
      'column-rule-action',
    ],
    [
      'clave de más en una entidad abierta: no hay reglas condicionales',
      { entities: [{ entity: 'empleado', grant: 'all', columns: [{ column: 'rut', claim: 've_pii', action: 'mask', if: 'x' }] }], datasets: [] },
      'column-rule-unknown-key',
    ],
    [
      'el mapeo del dataset sigue siendo un MAPA, no una lista de reglas',
      {
        entities: [{ entity: 'empleado', grant: 'all', columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }],
        datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado', columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }],
      },
      'column-map-malformed',
    ],
  ]

  it.each(casos)('%s → rompe con VergisError y código exacto', (_titulo, store, code) => {
    const s = estructuradoDe(() => resolveEntityStore(store as never))
    expect(s.code).toBe(code)
    expect(s.remediation).toBeTruthy() // accionable, no un "invalid input"
  })

  it('jamás devuelve un mapa con la policy abierta y SIN sus reglas de columna', () => {
    for (const [, store] of casos) {
      let devuelto: Map<string, PolicyDecl> | undefined
      try {
        devuelto = resolveEntityStore(store as never)
      } catch {
        /* lo esperado */
      }
      // El fail-open de esta familia con su peor cara: fila abierta a todos y la PII en claro.
      expect(devuelto).toBeUndefined()
    }
  })

  it('el `grant: all` del DATASET sigue sin admitir `columns`, y su remediación apunta a la entidad abierta', () => {
    const s = estructuradoDe(() => resolveEntityStore({ entities: [], datasets: [{ dataset: 'ref.personas', grant: 'all', columns: { rut: 'rut' } }] }))
    expect(s.code).toBe('grant-columns-unsupported')
    expect(String(s.remediation)).toMatch(/grant: all/) // dice cómo expresarlo en la forma canónica
  })

  it('una entidad sin gobierno y sin apertura sigue rompiendo: la ambigüedad no se abre sola', () => {
    const s = estructuradoDe(() => resolveEntityStore({ entities: [{ entity: 'empleado' }], datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado' }] }))
    expect(s.code).toBe('entity-ungoverned')
  })
})

describe('#163 H7 · binder: el claim de una regla de columna también se liga', () => {
  const CTX = { columns: ['area', 'rut'], claims: ['groups', 've_pii'] }

  it('un claim que el gate no entrega rompe con `unknown-claim` (antes enmascaraba todo, para todos, en silencio)', () => {
    const p = resolveEntityStore({
      entities: [{ entity: 'empleado', governed_by: GOV, columns: [{ column: 'rut', claim: 've_pi', action: 'mask' }] }],
      datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado', dimensions: { area: 'area' }, columns: { rut: 'rut' } }],
    }).get('pi04.empleado')!
    const s = estructuradoDe(() => bindPolicy(p, CTX))
    expect(s.code).toBe('unknown-claim')
    expect(s.value).toBe('ve_pi')
    expect(s.path).toBe('quality.audience.columns[0].claim')
  })

  it('sin lista de claims en el contexto no se valida (puede no conocerse al compilar)', () => {
    const p: PolicyDecl = { public: true, columnRules: [{ column: 'rut', claim: 'inventado', action: 'mask' }] }
    expect(() => bindPolicy(p, { columns: ['rut'] })).not.toThrow()
  })
})

describe('#163 H5 · control negativo: sin `columns`, la entidad produce la policy de hoy', () => {
  const SIN_COLUMNAS = {
    entities: [{ entity: 'empleado', governed_by: GOV }],
    datasets: [
      { dataset: 'pi04.empleado', realizes: 'empleado', dimensions: { area: 'area' } },
      { dataset: 'dim_area', grant: 'all' },
    ],
  }

  it('produce EXACTAMENTE el mismo mapa que antes (igualdad estructural, sin la clave de reglas)', () => {
    const m = resolveEntityStore(SIN_COLUMNAS)
    expect(m.get('pi04.empleado')).toEqual({ predicates: PREDICADOS_HOY, combine: 'and', default: 'deny' })
    expect(m.get('dim_area')).toEqual({ public: true })
    // `undefined` ≠ presente: la clave ni siquiera existe, así que nada aguas abajo puede ramificar
    // por «tiene reglas» donde antes no había nada.
    expect('columnRules' in (m.get('pi04.empleado') as object)).toBe(false)
    expect('columnRules' in (m.get('dim_area') as object)).toBe(false)
    expect(maskedColumns(m.get('pi04.empleado')!, {}).size).toBe(0)
  })

  it('y las filas salen SIN copiar: la extensión es conservadora por construcción', () => {
    const m = resolveEntityStore(SIN_COLUMNAS)
    const fila = { area: 'Producción', rut: '11.111.111-1' }
    expect(applyPolicy(m.get('pi04.empleado')!, { groups: ['Producción'] }, [fila])[0]).toBe(fila)
  })
})

describe('#163 H5 · binder: una columna enmascarada también se liga contra el schema', () => {
  const CTX = { columns: ['area', 'rut'], claims: ['groups', 've_pii'] }

  it('una regla sobre una columna que existe pasa', () => {
    const p = resolveEntityStore(STORE).get('pi04.empleado')!
    expect(() => bindPolicy(p, CTX)).not.toThrow()
  })

  it('un typo en la columna enmascarada rompe con `unknown-column` (antes no enmascaraba y callaba)', () => {
    const p = resolveEntityStore({
      entities: [{ entity: 'empleado', governed_by: GOV, columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }],
      datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado', dimensions: { area: 'area' }, columns: { rut: 'ruut' } }],
    }).get('pi04.empleado')!
    const s = estructuradoDe(() => bindPolicy(p, CTX))
    expect(s.code).toBe('unknown-column') // el mismo error que un predicado mal ligado: es la misma falta
    expect(s.error).toBe('policy/bind-failed')
    expect(s.value).toBe('ruut')
    expect(s.path).toBe('quality.audience.columns[0].column')
  })

  it('también sobre una policy PÚBLICA: los dos planos son ortogonales', () => {
    // Un `grant: all` con columna sensible es el driver que el diseño nombra (§6). Si el binder
    // volviera temprano por ser pública, ese caso —el más expuesto— quedaría sin ligar.
    const publica: PolicyDecl = { public: true, columnRules: [{ column: 'ruut', claim: 've_pii', action: 'mask' }] }
    expect(() => bindPolicy(publica, CTX)).toThrow(VergisError)
    expect(() => bindPolicy({ public: true, columnRules: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }, CTX)).not.toThrow()
  })

  it('control negativo del binder: una policy sin reglas de columna se liga igual que hoy', () => {
    const p = resolveEntityStore({ entities: [{ entity: 'empleado', governed_by: GOV }], datasets: [{ dataset: 'pi04.empleado', realizes: 'empleado', dimensions: { area: 'area' } }] }).get('pi04.empleado')!
    expect(bindPolicy(p, CTX)).toBe(p) // misma referencia: el binder no transforma
  })
})
