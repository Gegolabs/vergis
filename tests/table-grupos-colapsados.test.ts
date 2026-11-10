// #451 · Una tabla puede declarar que, al agrupar desde la bandeja, sus grupos nacen COLAPSADOS: solo la
// cabecera de cada grupo con su conteo y sus subtotales (#316); el detalle se abre con un clic.
//
// Lo pidió un usuario de PI-15 (GH) como un drill-down: «al agrupar, ver el total de las agrupaciones y
// no el detalle; al hacer clic sobre una, que muestre su detalle». Se eligió la opción B del issue —
// declarable por tabla (`group: { start: collapsed }`), con `expanded` por defecto— para no mover
// ninguna tabla existente.
//
// El modelo: el estado de los grupos es un DEFECTO más las rutas que el lector invirtió
// (`vtGroupCollapsed`). Con el conjunto de rutas cerradas de siempre, un grupo que aparece después (al
// quitar un filtro) nacería abierto en una tabla que parte colapsada.
//
// La conducta del navegador (clic, segundo nivel, Expandir/Colapsar todo, filtros, ida y vuelta) la mide
// el arnés `scripts/arnes-451-grupos-colapsados.ts` en un DOM real; acá se mide lo que no necesita DOM.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  renderHtmlPiece,
  tableRuntimeSource,
  vtGroupCollapsed,
  vtGroupTree,
  TABLE_RUNTIME_SOURCE,
  TABLE_RUNTIME_SOURCE_TONES,
  TABLE_RUNTIME_SOURCE_GROUPS_COLLAPSED,
  type ResolvedNode,
} from '@vergis/capabilities'
import { VERGIS_VERSION_LABEL } from '../packages/capabilities/src/version'
import { TABLE_GROUP_STARTS } from '../packages/mira/src/dsl/validate'
import { composePiece, parseSpec, validateSpec, type MiraSpec } from '@vergis/mira'

const FILAS = [
  { area: 'Norte', empresa: 'A', status: 'Entregado', monto: 10 },
  { area: 'Norte', empresa: 'B', status: 'Atrasado', monto: -5 },
  { area: 'Sur', empresa: 'C', status: 'En Proceso', monto: 3 },
]
const cols = (tones: boolean) => [
  { field: 'area', label: 'Área' },
  { field: 'empresa', label: 'Empresa' },
  { field: 'status', label: 'Status', ...(tones ? { tones: { Entregado: 'green', Atrasado: 'red' } } : {}) },
  { field: 'monto', label: 'Monto', format: 'int_0', align: 'right' as const, total: 'sum' as const },
]
function tabla(over: Partial<ResolvedNode> = {}): ResolvedNode {
  return { type: 'table', title: 'T', rows: FILAS, interactive: true, columnsSpec: cols(false), ...over }
}
async function html(piece: ResolvedNode, opts: { print?: boolean } = {}): Promise<string> {
  const out = (await renderHtmlPiece.execute(
    { piece, title: 'X', theme: 'roble', stateKey: 'k', ...opts },
    { agent: 'test' },
  )) as { html: string }
  return out.html
}
// La etiqueta de versión de la bandeja cambia en cada corte: se normaliza para que el golden mida la tabla.
const sha = (h: string) => createHash('sha256').update(h.split(VERGIS_VERSION_LABEL).join('Vergis vX')).digest('hex')
const payload = (h: string): Record<string, unknown> => {
  const m = /<script type="application\/json" class="vtable-data">([\s\S]*?)<\/script>/.exec(h)
  if (!m) throw new Error('la tabla no emitió su payload')
  return JSON.parse(m[1]) as Record<string, unknown>
}

describe('vtGroupCollapsed · defecto + rutas invertidas', () => {
  it('sin defecto colapsado es la regla de siempre: colapsado solo lo marcado', () => {
    expect(vtGroupCollapsed(false, {}, 'a')).toBe(false)
    expect(vtGroupCollapsed(false, { a: 1 }, 'a')).toBe(true)
  })
  it('con defecto colapsado: todo nace cerrado y lo marcado es lo que el lector abrió', () => {
    expect(vtGroupCollapsed(true, {}, 'a')).toBe(true)
    expect(vtGroupCollapsed(true, { a: 1 }, 'a')).toBe(false)
  })

  // Las rutas de un grupo que aparece DESPUÉS (al quitar un filtro) no están en ningún conjunto.
  const rutas = (rows: Record<string, unknown>[]) => vtGroupTree(rows, ['area']).groups!.map((g) => 'area~|~' + g.key)
  it('un grupo que aparece después nace como dice el defecto', () => {
    const flips: Record<string, number> = { [rutas(FILAS.filter((r) => r.area === 'Sur'))[0]]: 1 } // abrió Sur con el filtro puesto
    const estado = rutas(FILAS).map((p) => vtGroupCollapsed(true, flips, p))
    expect(estado).toEqual([true, false]) // Norte (aparece al quitar el filtro) cerrado; Sur abierto
  })
  it('CONTROL NEGATIVO: con el conjunto de rutas cerradas de siempre, ese grupo nacería abierto', () => {
    // «Colapsado por omisión» a la manera vieja: al agrupar se cierran las rutas PRESENTES (con el
    // filtro puesto, solo Sur) y el clic del lector borra la de Sur. Norte no está en el conjunto.
    const cerradas: Record<string, number> = {}
    for (const p of rutas(FILAS.filter((r) => r.area === 'Sur'))) cerradas[p] = 1
    delete cerradas['area~|~Sur']
    const vieja = (p: string) => !!cerradas[p]
    expect(rutas(FILAS).map(vieja)).toEqual([false, false]) // Norte nace ABIERTO: lo que el modelo nuevo evita
    expect(rutas(FILAS).map(vieja)).not.toEqual(rutas(FILAS).map((p) => vtGroupCollapsed(true, { 'area~|~Sur': 1 }, p)))
  })
})

describe('runtime · una variante, y sin la opción los bytes de siempre', () => {
  it('sin capacidades, el runtime armado es TABLE_RUNTIME_SOURCE; con tonos, TABLE_RUNTIME_SOURCE_TONES', () => {
    expect(tableRuntimeSource()).toBe(TABLE_RUNTIME_SOURCE)
    expect(tableRuntimeSource({ tones: true })).toBe(TABLE_RUNTIME_SOURCE_TONES)
  })
  it('el runtime de siempre no conoce la capacidad', () => {
    expect(TABLE_RUNTIME_SOURCE).not.toContain('vtGroupCollapsed')
    expect(TABLE_RUNTIME_SOURCE).not.toContain('groupStart')
  })
  it('la variante trae la función de decisión, lee groupStart del payload y es JS válido', () => {
    const v = TABLE_RUNTIME_SOURCE_GROUPS_COLLAPSED
    expect(v).toContain('function vtGroupCollapsed(')
    expect(v).toContain(`var gStart = payload.groupStart==='collapsed'`)
    expect(v).toContain('var collapsed=vtGroupCollapsed(state.gDefault, state.collapsed, path);')
    expect(v).not.toContain('var collapsed=!!state.collapsed[path];')
    // Ningún reinicio de grupos queda con la regla vieja (todos pasan por resetGroups).
    expect(v.match(/state\.collapsed ?= ?\{\};/g)).toEqual(['state.collapsed = {};', 'state.collapsed={};', 'state.collapsed={};'])
    expect(() => new Function(v)).not.toThrow()
    expect(() => new Function(tableRuntimeSource({ tones: true, groupsCollapsed: true }))).not.toThrow()
  })
  it('las dos capacidades componen: tonos + colapsados trae las funciones de ambas', () => {
    const v = tableRuntimeSource({ tones: true, groupsCollapsed: true })
    expect(v).toContain('function vtToneCls(')
    expect(v).toContain('function vtGroupCollapsed(')
    expect(v).toContain('var tone=col.tones ? vtToneCls(col.tones, raw)')
  })
})

describe('render · la opción viaja solo cuando se declara', () => {
  it('con group.start collapsed, el payload la lleva y el documento trae la variante', async () => {
    const h = await html(tabla({ groupStart: 'collapsed' }))
    expect(payload(h)['groupStart']).toBe('collapsed')
    expect(h).toContain(`<script>${TABLE_RUNTIME_SOURCE_GROUPS_COLLAPSED}</script>`)
  })
  it('con tonos y colapsados en el mismo documento, va el runtime que conoce las dos', async () => {
    const h = await html(tabla({ groupStart: 'collapsed', columnsSpec: cols(true) }))
    expect(h).toContain(`<script>${tableRuntimeSource({ tones: true, groupsCollapsed: true })}</script>`)
  })
  it('sin la opción, el payload no tiene la llave y el runtime es el de siempre', async () => {
    const h = await html(tabla())
    expect(payload(h)).not.toHaveProperty('groupStart')
    expect(h).toContain(`<script>${TABLE_RUNTIME_SOURCE}</script>`)
  })
  it('el SSR no cambia: la tabla se sirve plana igual (agrupar es un acto del lector)', async () => {
    const tb = (h: string) => /<tbody>([\s\S]*?)<\/tbody>/.exec(h)![1]
    expect(tb(await html(tabla({ groupStart: 'collapsed' })))).toBe(tb(await html(tabla())))
  })
})

/**
 * GOLDEN de retrocompatibilidad: el HTML COMPLETO de una tabla sin la opción, con la etiqueta de versión
 * normalizada, calculado con `main` (df56e39, v0.48.0) ANTES del cambio, bajo vitest (el `.toString()` del runtime
 * depende del transformador: el mismo caso bajo tsx da otro hash). Si esto se rompe por otro
 * cambio legítimo de la tabla, se recalcula con el `main` de ese momento — nunca con la rama.
 *
 * Recalculado por #459 · #460 (cabecera de navegación, catálogo fuera de la bandeja): el golden hashea
 * el documento entero, así que el cromo nuevo cambia los hashes sin tocar la tabla. Antes de aceptar los
 * hashes nuevos se diferenció el HTML de `main` (0bd9738) contra la rama: las únicas líneas distintas son
 * el CSS y el `<nav class="vnav">` de la cabecera y la entrada `.tray-catalog` retirada. Papel, sin cromo,
 * conserva su hash. Y otra vez por #461: el diff contra el paso anterior es solo el rótulo, el aria
 * de la bandeja y un comentario del runtime de tabla que viaja en el documento («Inspector» → «Bandeja»).
 */
describe('golden · un spec sin la opción se ve igual que en main, byte a byte', () => {
  const GOLDEN: [string, Partial<ResolvedNode>, { print?: boolean }, string][] = [
    ['interactiva', {}, {}, '72b20ee2698437c4143519780e02d2aff3006bf659056c39fb237174925122dc'],
    ['interactiva · tones', { columnsSpec: cols(true) }, {}, 'a8cabc7d0ce1ba9b750222d8ee14c9f26ff9eeff2e8a602a975131c7ad4484c9'],
    ['estática', { interactive: false }, {}, 'c4b7a4a4684d75c39f83c07407b6ccedf7aa853c059d2e7b9f4ad99832aba25b'],
    ['papel', {}, { print: true }, 'ce5992eae9ae066350571f7c80e3aacc50d3afa17c349172037d76fbf0595e35'],
    ['interactiva · drill', { drills: [{ to: 'det', by: ['empresa'] }] }, {}, 'e26afbce088cd5f31c893e09dc6ca399f30919b7c9adab7eed31c59eaa071485'],
  ]
  it.each(GOLDEN)('%s', async (_n, over, opts, esperado) => {
    expect(sha(await html(tabla(over), opts))).toBe(esperado)
  })
  it('control negativo: con la opción, la tabla interactiva SÍ cambia (el golden discrimina)', async () => {
    expect(sha(await html(tabla({ groupStart: 'collapsed' })))).not.toBe(GOLDEN[0][3])
  })
  it('en la tabla estática y en papel la opción no tiene efecto (no agrupan): mismos bytes', async () => {
    expect(sha(await html(tabla({ groupStart: 'collapsed' }), { print: true }))).toBe(GOLDEN[3][3])
  })
})

describe('compose · group.start viaja del spec al nodo', () => {
  const spec = { data: { v: {} } } as unknown as MiraSpec
  const nodo = (group?: unknown) =>
    composePiece({ table: { data: 'data.v', columns: [{ field: 'area' }], ...(group ? { group } : {}) } }, { v: { rows: FILAS } } as never, spec)
  it('collapsed → groupStart', () => {
    expect(nodo({ start: 'collapsed' }).groupStart).toBe('collapsed')
  })
  it('expanded o ausente → el nodo no lleva la llave (la tabla de siempre)', () => {
    expect(nodo({ start: 'expanded' })).not.toHaveProperty('groupStart')
    expect(nodo()).not.toHaveProperty('groupStart')
  })
})

describe('validador · table.group', () => {
  const spec = (extra: string) => `
mira_version: "1.0"
identity: { id: pi-grupos, display_name: "Grupos", classification: internal }
piece:
  layout: rows
  elements:
    - table: { data: data.v, columns: [{ field: area }]${extra} }
data:
  v: { capability: mock-sql, params: { sql: "select 'Norte' as area" } }
quality: {}
delivery: { render: [{ format: html, target: web }] }
`
  const SCHEMA = JSON.parse(readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8')) as object
  const validar = (s: string) => validateSpec(parseSpec(s), { capabilities: ['mock-sql', 'render-html-piece'], schema: SCHEMA })
  const codigo = (s: string): string => {
    try {
      validar(s)
    } catch (e) {
      return String((e as { structured?: { code?: string } }).structured?.code ?? (e as Error).message)
    }
    return 'ok'
  }
  it('el vocabulario es collapsed · expanded', () => {
    expect([...TABLE_GROUP_STARTS]).toEqual(['collapsed', 'expanded'])
  })
  it('sin group, o con un start del vocabulario, pasa', () => {
    expect(codigo(spec(''))).toBe('ok')
    expect(codigo(spec(', group: { start: collapsed }'))).toBe('ok')
    expect(codigo(spec(', group: { start: expanded }'))).toBe('ok')
  })
  it('un start desconocido se rechaza nombrando el valor', () => {
    expect(codigo(spec(', group: { start: colapsado }'))).toBe('table-group-start-unknown')
    expect(() => validar(spec(', group: { start: colapsado }'))).toThrow(/colapsado/)
    expect(codigo(spec(', group: { start: true }'))).toBe('table-group-start-unknown')
  })
  it('group que no es un mapa, o con otra llave, se rechaza', () => {
    expect(codigo(spec(', group: collapsed'))).toBe('table-group-invalid')
    expect(codigo(spec(', group: [collapsed]'))).toBe('table-group-invalid')
    expect(codigo(spec(', group: { start: collapsed, by: area }'))).toBe('table-group-invalid')
  })
  it('collapsed en una tabla con interactive: false no tendría efecto: se rechaza', () => {
    expect(codigo(spec(', interactive: false, group: { start: collapsed }'))).toBe('table-group-static')
    expect(codigo(spec(', interactive: false, group: { start: expanded }'))).toBe('ok')
  })
})
