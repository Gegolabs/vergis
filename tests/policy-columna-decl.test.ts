// La DECLARACIÓN del plano de columna — issue #163 H4 (diseño §4.2, §4.6).
//
// El hito 1 dejó el IR capaz de expresar `ColumnRule`, pero solo construyéndolo A MANO: una regla
// escrita en un YAML —spec o policy store— se ignoraba en silencio. Eso es **fail-OPEN a nivel de
// spec**: el autor escribe la regla, el sistema no la lee, la columna se sirve en claro y nadie se
// entera. Estas pruebas fijan las tres cosas que cierran ese hueco:
//   · la declaración se LEE y produce el `ColumnRule` esperado (spec y store, incluido `grant: all`);
//   · lo malformado ROMPE AL PARSEAR —arranque o recarga, §4.2— y NUNCA degrada a «policy sin reglas»;
//   · un spec SIN declaración produce EXACTAMENTE la misma policy que antes (control negativo).
//
// Lo que NO se prueba acá: la semántica de la máscara (eso es `policy-columna.test.ts`, el oráculo).

import { describe, expect, it } from 'vitest'
import { VergisError } from '@vergis/botler'
import { applyPolicy, MASK_VALUE, maskedColumns, parseAudience, parsePolicyStore, type Policy, type PolicyDecl } from '@vergis/policy'

const RLS = [{ column: 'area', claim: 'groups', op: 'in' }]
/** La policy que el spec de RLS produce HOY, sin plano de columna. Ancla del control negativo. */
const POLICY_HOY: Policy = { predicates: [{ kind: 'membership', column: 'area', claim: 'groups', op: 'in' }], combine: 'and', default: 'deny' }

/** El error estructurado de un parseo que debe romper. Falla la prueba si NO rompe. */
function estructuradoDe(fn: () => unknown): Record<string, unknown> {
  try {
    const r = fn()
    throw new Error(`se esperaba un VergisError y devolvió: ${JSON.stringify(r)}`)
  } catch (e) {
    if (!(e instanceof VergisError)) throw e
    return e.structured as unknown as Record<string, unknown>
  }
}

describe('#163 H4 · declaración de columna en el spec (`audience.columns`)', () => {
  it('una declaración válida junto a `rls` produce el ColumnRule esperado en el IR', () => {
    const p = parseAudience({ rls: RLS, columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }) as Policy
    expect(p.predicates).toEqual(POLICY_HOY.predicates) // el plano de fila no se movió
    expect(p.default).toBe('deny')
    expect(p.columnRules).toEqual([{ column: 'rut', claim: 've_pii', action: 'mask' }])
  })

  it('los planos son ortogonales: un PI público también puede declarar columnas sensibles', () => {
    for (const audience of [{ rls: 'public', columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }, { columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }]) {
      const p = parseAudience(audience)
      expect(p).toEqual({ public: true, columnRules: [{ column: 'rut', claim: 've_pii', action: 'mask' }] })
    }
  })

  it('varias reglas y varias sobre la MISMA columna: se conservan todas, en orden', () => {
    // Dos reglas sobre `rut` con claims distintos NO es un error: la celda va en claro solo para quien
    // trae AMBOS claims (la ausencia de cualquiera enmascara). Es el default-deny de la celda, y por
    // eso no se deduplica ni se «resuelve» acá — el oráculo ya lo compone.
    const p = parseAudience({
      rls: RLS,
      columns: [
        { column: 'rut', claim: 've_pii', action: 'mask' },
        { column: 'sueldo', claim: 've_remuneracion', action: 'mask' },
        { column: 'rut', claim: 've_rrhh', action: 'mask' },
      ],
    }) as Policy
    expect(p.columnRules).toHaveLength(3)
    expect(p.columnRules!.map((r) => r.column)).toEqual(['rut', 'sueldo', 'rut'])
    expect([...maskedColumns(p, { ve_pii: ['si'] })].sort()).toEqual(['rut', 'sueldo']) // falta `ve_rrhh` → sigue enmascarada
    expect([...maskedColumns(p, { ve_pii: ['si'], ve_rrhh: ['si'], ve_remuneracion: ['si'] })]).toEqual([])
  })

  it('el claim multi-valor no cambia nada: la regla mira PRESENCIA, no valor', () => {
    const p = parseAudience({ rls: RLS, columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }) as Policy
    const fila = { area: 'Producción', rut: '11.111.111-1' }
    expect(applyPolicy(p, { groups: ['Producción'], ve_pii: ['a', 'b'] }, [fila])[0].rut).toBe('11.111.111-1')
    expect(applyPolicy(p, { groups: ['Producción'], ve_pii: [] }, [fila])[0].rut).toBe(MASK_VALUE)
  })

  it('la declaración llega ENTERA hasta el oráculo: parsear y enmascarar son la misma cadena', () => {
    const p = parseAudience({ rls: RLS, columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] })
    const store = [{ area: 'Producción', rut: '11.111.111-1' }, { area: 'Finanzas', rut: '22.222.222-2' }]
    const r = applyPolicy(p, { groups: ['Producción'] }, store)
    expect(r).toEqual([{ area: 'Producción', rut: MASK_VALUE }]) // filtró filas Y enmascaró la celda
  })
})

describe('#163 H4 · fail-closed AL PARSEAR: lo malformado rompe, no produce una policy sin reglas', () => {
  const casos: Array<[string, unknown, string]> = [
    ['acción desconocida', [{ column: 'rut', claim: 've_pii', action: 'hide' }], 'column-rule-action'],
    ['acción con otra caja', [{ column: 'rut', claim: 've_pii', action: 'MASK' }], 'column-rule-action'],
    ['sin `action`', [{ column: 'rut', claim: 've_pii' }], 'column-rule-action'],
    ['sin `column`', [{ claim: 've_pii', action: 'mask' }], 'column-rule-column'],
    ['`column` vacía', [{ column: '', claim: 've_pii', action: 'mask' }], 'column-rule-column'],
    ['sin `claim`', [{ column: 'rut', action: 'mask' }], 'column-rule-claim'],
    ['`claim` vacío', [{ column: 'rut', claim: '', action: 'mask' }], 'column-rule-claim'],
    ['tipo equivocado en `column`', [{ column: 42, claim: 've_pii', action: 'mask' }], 'column-rule-column'],
    ['la regla no es un objeto', ['rut'], 'column-rule-shape'],
    ['la regla es null', [null], 'column-rule-shape'],
    ['`columns` no es lista', { column: 'rut' }, 'columns-malformed'],
    ['`columns` es un string', 'rut', 'columns-malformed'],
  ]

  it.each(casos)('%s → rompe con VergisError y código exacto', (_titulo, columns, code) => {
    const s = estructuradoDe(() => parseAudience({ rls: RLS, columns }))
    expect(s.code).toBe(code)
    expect(s.error).toBe('policy/spec-invalid')
    expect(s.path).toMatch(/^quality\.audience\.columns/)
    expect(s.remediation).toBeTruthy() // el error es accionable, no un "invalid input"
  })

  it('LA falla silenciosa que esto mata: jamás devuelve una policy sin reglas', () => {
    for (const [, columns] of casos) {
      let devuelto: PolicyDecl | undefined
      try {
        devuelto = parseAudience({ rls: RLS, columns })
      } catch {
        /* lo esperado */
      }
      expect(devuelto).toBeUndefined() // si esto falla, la columna se está sirviendo en claro
    }
  })

  it('una clave de más rompe: `{column, claim, action, if}` NO es una regla condicional', () => {
    // El vocabulario es cerrado (guardrail del IR: "flexibilidad = motor de authz disfrazado"). Si se
    // ignorara la clave sobrante, el autor creería haber condicionado la máscara y no lo habría hecho:
    // el mismo fail-open con otra cara.
    const s = estructuradoDe(() => parseAudience({ rls: RLS, columns: [{ column: 'rut', claim: 've_pii', action: 'mask', if: 'region = Norte' }] }))
    expect(s.code).toBe('column-rule-unknown-key')
    expect(s.path).toBe('quality.audience.columns[0]')
  })

  it('el `path` señala la regla exacta que hay que corregir (no la lista entera)', () => {
    const s = estructuradoDe(() =>
      parseAudience({ rls: RLS, columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }, { column: 'sueldo', claim: 've_rem', action: 'ocultar' }] }),
    )
    expect(s.path).toBe('quality.audience.columns[1]')
    expect(s.value).toBe('ocultar')
  })
})

describe('#163 H4 · control negativo: sin declaración de columnas, la policy es la de hoy', () => {
  it('un spec sin `columns` produce EXACTAMENTE la policy de antes (ni la clave aparece)', () => {
    const p = parseAudience({ rls: RLS, default: 'deny' })
    expect(p).toEqual(POLICY_HOY) // igualdad estructural, no «parecido»
    expect('columnRules' in p).toBe(false) // la clave ni siquiera existe: undefined ≠ presente
    expect(maskedColumns(p, {}).size).toBe(0)
  })

  it('un `audience` ausente o público sin `columns` sigue siendo el `{public: true}` pelado', () => {
    expect(parseAudience(undefined)).toEqual({ public: true })
    expect(parseAudience({})).toEqual({ public: true })
    expect(parseAudience({ rls: 'public' })).toEqual({ public: true })
    expect('columnRules' in parseAudience({ rls: 'public' })).toBe(false)
  })

  it('`columns: []` es «declara cero», explícito y legítimo — y se comporta igual', () => {
    const p = parseAudience({ rls: RLS, columns: [] }) as Policy
    expect(p.columnRules).toEqual([])
    expect(maskedColumns(p, {}).size).toBe(0)
    const store = [{ area: 'Producción', rut: '11.111.111-1' }]
    expect(applyPolicy(p, { groups: ['Producción'] }, store)[0]).toBe(store[0]) // ni copia la fila
  })
})

describe('#163 H4 · declaración de columna en el policy store (`policies[].columns`)', () => {
  it('entrada con `rls` + `columns`: la regla llega al mapa por dataset', () => {
    const m = parsePolicyStore({ policies: [{ dataset: 'qw04.empleados', rls: RLS, columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }] })
    const p = m.get('qw04.empleados') as Policy
    expect(p.predicates).toEqual(POLICY_HOY.predicates)
    expect(p.columnRules).toEqual([{ column: 'rut', claim: 've_pii', action: 'mask' }])
  })

  it('`grant: all` + `columns`: el dataset abierto conserva su columna sensible (diseño §6)', () => {
    // Es el driver que el diseño nombra: un dominio público con una columna que no es de todos. Si la
    // rama `grant` ignorara `columns`, ESA sería la instancia que se sirve en claro.
    const m = parsePolicyStore({ policies: [{ dataset: 'ref.personas', grant: 'all', columns: [{ column: 'rut', claim: 've_pii', action: 'mask' }] }] })
    expect(m.get('ref.personas')).toEqual({ public: true, columnRules: [{ column: 'rut', claim: 've_pii', action: 'mask' }] })
  })

  it('una regla malformada rompe AL CARGAR EL STORE (arranque/recarga), con el path de la entrada', () => {
    const s = estructuradoDe(() => parsePolicyStore({ policies: [{ dataset: 'ref.personas', grant: 'all', columns: [{ column: 'rut', claim: 've_pii', action: 'ocultar' }] }] }))
    expect(s.code).toBe('column-rule-action')
    expect(s.path).toBe('policies[0].columns[0]')
  })

  it('y rompe TODO el store, no solo esa entrada: no queda un mapa a medias', () => {
    expect(() =>
      parsePolicyStore({
        policies: [
          { dataset: 'a', grant: 'all' },
          { dataset: 'b', rls: RLS, columns: [{ column: 'rut', claim: '', action: 'mask' }] },
        ],
      }),
    ).toThrow(VergisError)
  })

  it('control negativo del store: sin `columns`, el mapa es idéntico al de hoy', () => {
    const m = parsePolicyStore({ policies: [{ dataset: 'qw04.empleados', rls: RLS }, { dataset: 'ref.areas', grant: 'all' }] })
    expect(m.get('qw04.empleados')).toEqual(POLICY_HOY)
    expect(m.get('ref.areas')).toEqual({ public: true })
    expect('columnRules' in (m.get('ref.areas') as object)).toBe(false)
  })
})
