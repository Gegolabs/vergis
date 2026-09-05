// #207 · El nombre visible de un PI se edita sin desplegar.
//
// Hoy `identity.display_name` vive en el YAML del spec: cambiarlo exige editar el archivo y
// desplegarlo a /opt/mira, o sea que renombrar un reporte es una operación de ingeniería. En una
// fase donde los PIs se están presentando y renombrando seguido, el roce es constante.
//
// Las dos preguntas de diseño que el issue pidió resolver antes de construir, y que este archivo
// mide: (1) dónde queda la verdad cuando hay dos fuentes, y (2) que la RUTA no se mueva.
import { describe, it, expect } from 'vitest'
import { createDiscovery, slugify, type DiscoveryDeps } from '../server/discovery'
import { createProtoRegistry } from '../server/proto-registry'
import { createMiraProto } from '@vergis/mira'

/** Mira, construida con un render inerte: estos tests miden DESCUBRIMIENTO, no invocación. */
const miraProtoBotlet = createMiraProto({ render: async () => '<html>PI</html>' })
import type { PolicyDecl } from '@vergis/policy'

function specYaml(code: string, nombre: string): string {
  return [
    `identity: { code: ${code}, display_name: "${nombre}" }`,
    `data:`,
    `  d1: { capability: execute-sql-ch, params: { sql: "SELECT 1 FROM qw04.areas" } }`,
    `piece: { layout: rows, elements: [] }`,
    `delivery: { render: [{ format: html, target: web }] }`,
  ].join('\n')
}

const SPECS = { '/pi07.yaml': specYaml('PI-07', 'Entregas por Local') }

function mk(over: Partial<DiscoveryDeps> = {}) {
  return createDiscovery({
    engine: 'clickhouse',
    store: new Map<string, PolicyDecl>([['qw04.areas', { public: true }]]),
    servingCaps: new Set(['execute-sql-ch']),
    protos: createProtoRegistry([miraProtoBotlet]),
    specPaths: () => Object.keys(SPECS),
    readSpec: (p) => SPECS[p as keyof typeof SPECS],
    log: () => {},
    ...over,
  })
}

describe('#207 · dónde queda la verdad', () => {
  it('sin override, el nombre sale del spec', () => {
    const r = mk().discover()[0]!
    expect(r.name).toBe('Entregas por Local')
    expect(r.specName).toBe('Entregas por Local')
  })

  it('con override, el del gobierno GANA — y el del spec sigue disponible', () => {
    const r = mk({ displayNameOverride: (c) => (c === 'PI-07' ? 'Entregas Sodimac' : undefined) }).discover()[0]!
    expect(r.name).toBe('Entregas Sodimac')
    // El criterio del issue: el override tiene que ser visible como override, no un misterio para el
    // que lea el spec. Sin conservar el nombre del YAML, la consola no podría decir contra qué.
    expect(r.specName).toBe('Entregas por Local')
  })

  it('un override vacío no pisa el nombre del spec', () => {
    const r = mk({ displayNameOverride: () => '' }).discover()[0]!
    expect(r.name).toBe('Entregas por Local')
  })

  it('el override de OTRO PI no toca a éste', () => {
    const r = mk({ displayNameOverride: (c) => (c === 'PI-99' ? 'Otro' : undefined) }).discover()[0]!
    expect(r.name).toBe('Entregas por Local')
  })
})

describe('#207 · la ruta NO se mueve', () => {
  it('renombrar no cambia el slug: el enlace sale de identity.code, no del nombre', () => {
    const sin = mk().discover()[0]!
    const con = mk({ displayNameOverride: () => 'Un Nombre Completamente Distinto' }).discover()[0]!
    expect(con.slug).toBe(sin.slug)
    expect(con.slug).toBe(slugify('PI-07'))
    // El criterio duro del issue: `/pi-07` está en enlaces de Jira, correos y comentarios ya
    // repartidos. Un renombre que los rompiera sería peor que el roce que viene a quitar.
    expect(con.slug).toBe('pi-07')
  })

  it('el override tampoco toca el código ni la ruta del spec en disco', () => {
    const r = mk({ displayNameOverride: () => 'Otro nombre' }).discover()[0]!
    expect(r.code).toBe('PI-07')
    expect(r.specPath).toBe('/pi07.yaml')
  })
})

describe('#207 · el override se lee en cada discover, no se congela', () => {
  it('cambiar el override se refleja SIN reconstruir el descubrimiento', () => {
    // Éste es el mecanismo que hace que renombrar no exija desplegar ni reiniciar: el override se
    // aplica AL SALIR del escáner memoizado. Si se aplicara adentro, el primer `discover()` lo
    // congelaría en el memo y el nombre nuevo no aparecería hasta un rebuild.
    let actual: string | undefined
    const d = mk({ displayNameOverride: () => actual })
    expect(d.discover()[0]!.name).toBe('Entregas por Local')
    actual = 'Renombrado en caliente'
    expect(d.discover()[0]!.name).toBe('Renombrado en caliente')
    actual = undefined
    expect(d.discover()[0]!.name).toBe('Entregas por Local')
  })
})

// ── El store: persistencia, restauración y sus bordes ────────────────────────────────────────────
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteGovernanceStore, PI_DISPLAY_NAME_MAX } from '@vergis/capabilities'

const abrir = async (file: string | null = null) => SqliteGovernanceStore.open(file, { admins: ['cesar@ultrabase.com'] })

describe('#207 · el override en el gobierno', () => {
  it('sin override, no hay fila — «nunca se renombró» se distingue de «se renombró»', async () => {
    const g = await abrir()
    expect(await g.getDisplayName('PI-07')).toBeNull()
    await g.close()
  })

  it('guarda el nombre con su rastro de quién y cuándo', async () => {
    const g = await abrir()
    await g.setDisplayName('PI-07', 'Entregas Sodimac', 'Cesar@ultrabase.com')
    const n = await g.getDisplayName('PI-07')
    expect(n?.displayName).toBe('Entregas Sodimac')
    expect(n?.updatedBy).toBe('cesar@ultrabase.com')
    expect(n?.updatedAt).toBeTruthy()
    await g.close()
  })

  it('restaurar BORRA la fila, no guarda el nombre del spec', async () => {
    // La distinción importa: guardar el nombre del YAML congelaría el de hoy, y una edición
    // posterior del spec no se vería nunca más — el override sobreviviría disfrazado de «sin override».
    const g = await abrir()
    await g.setDisplayName('PI-07', 'Entregas Sodimac', 'cesar@ultrabase.com')
    await g.setDisplayName('PI-07', null, 'cesar@ultrabase.com')
    expect(await g.getDisplayName('PI-07')).toBeNull()
    await g.close()
  })

  it('un nombre en blanco se RECHAZA: para volver al del spec está restaurar', async () => {
    const g = await abrir()
    await expect(g.setDisplayName('PI-07', '   ', 'cesar@ultrabase.com')).rejects.toThrow(/no puede quedar vac/i)
    await g.close()
  })

  it('el nombre tiene tope y el error lo dice con su número', async () => {
    const g = await abrir()
    await expect(g.setDisplayName('PI-07', 'x'.repeat(PI_DISPLAY_NAME_MAX + 1), 'c@u.com')).rejects.toThrow(
      new RegExp(String(PI_DISPLAY_NAME_MAX)),
    )
    await g.setDisplayName('PI-07', 'x'.repeat(PI_DISPLAY_NAME_MAX), 'c@u.com') // el tope exacto pasa
    await g.close()
  })

  it('el override SOBREVIVE al reinicio del nodo — si no, seguiría dependiendo del despliegue', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vergis-gov-')), 'gov.sqlite')
    const seed = { admins: ['cesar@ultrabase.com'] }
    const g1 = await SqliteGovernanceStore.open(file, seed)
    await g1.setDisplayName('PI-07', 'Entregas Sodimac', 'cesar@ultrabase.com')
    await g1.close()
    const g2 = await SqliteGovernanceStore.open(file, seed)
    expect((await g2.getDisplayName('PI-07'))?.displayName).toBe('Entregas Sodimac')
    expect(await g2.listDisplayNames()).toEqual({ 'PI-07': 'Entregas Sodimac' })
    await g2.close()
  })

  it('listDisplayNames trae todos los overrides y solo ésos', async () => {
    const g = await abrir()
    await g.setDisplayName('PI-07', 'Uno', 'c@u.com')
    await g.setDisplayName('PI-25', 'Dos', 'c@u.com')
    await g.setDisplayName('PI-25', null, 'c@u.com')
    expect(await g.listDisplayNames()).toEqual({ 'PI-07': 'Uno' })
    await g.close()
  })
})
