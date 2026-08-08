// Fase de carga de la config declarativa de instancia (issue #117): env + readFile inyectados, sin
// disco. Lo que se prueba es el contrato de tres estados — env ausente, clave raíz ausente (fatal),
// clave presente y vacía (legítima) — y la línea de conteos del arranque.

import { describe, it, expect } from 'vitest'
import { loadInstanceConfig, loadSlice, RELOADABLE_SLICES, type EnvLike, type InstanceSlice, type ReadFile } from '../server/instance-config'

/** `readFile` de mentira: mapa ruta-sufijo → contenido YAML. */
const fs = (files: Record<string, string>): ReadFile => {
  return (path: string) => {
    const hit = Object.entries(files).find(([name]) => path.endsWith(name))
    if (!hit) throw new Error(`ENOENT: ${path}`)
    return hit[1]
  }
}

describe('instance-config · clave raíz ausente es fatal (#117)', () => {
  it('env definido + archivo sin la clave → lanza con ENV, ruta y clave', () => {
    const env: EnvLike = { VERGIS_DOMAINS: 'cfg/domains.yaml' }
    const read = fs({ 'domains.yaml': 'otra: 1\n' })
    expect(() => loadInstanceConfig(env, read)).toThrow(/VERGIS_DOMAINS/)
    expect(() => loadInstanceConfig(env, read)).toThrow(/domains\.yaml/)
    expect(() => loadInstanceConfig(env, read)).toThrow(/falta la clave raíz 'domains'/)
    // la ruta va absoluta
    try {
      loadInstanceConfig(env, read)
    } catch (e) {
      expect((e as Error).message).toMatch(/\(\/.*domains\.yaml\)/)
    }
  })

  it('archivo vacío o solo-comentarios también es «ausente»', () => {
    for (const contenido of ['', '# nada\n']) {
      expect(() => loadInstanceConfig({ VERGIS_INTAKE: 'slots.yaml' }, fs({ 'slots.yaml': contenido }))).toThrow(
        /VERGIS_INTAKE .*falta la clave raíz 'slots'/s,
      )
    }
  })

  it('cada env declarado se valida, aunque no haya data maestra ni admins', () => {
    const casos: [string, string, string][] = [
      ['VERGIS_GROUPS', 'groups.yaml', 'groups'],
      ['VERGIS_PI_OWNERS', 'owners.yaml', 'owners'],
      ['VERGIS_SOURCES', 'sources.yaml', 'sources'],
      ['VERGIS_MASTER_DATA', 'md.yaml', 'entities'],
    ]
    for (const [env, file, key] of casos) {
      expect(() => loadInstanceConfig({ [env]: file }, fs({ [file]: 'roto: 1\n' }))).toThrow(
        new RegExp(`${env} .*falta la clave raíz '${key}'`, 's'),
      )
    }
  })

  it('un YAML que ni parsea también sale envuelto con ENV y ruta', () => {
    expect(() => loadInstanceConfig({ VERGIS_DOMAINS: 'd.yaml' }, fs({ 'd.yaml': 'a: [1,\n' }))).toThrow(/VERGIS_DOMAINS \(\/.*d\.yaml\):/)
  })
})

describe('instance-config · «declara cero» y el resumen de conteos', () => {
  it('clave presente y vacía → carga 0, sin error, reportado en el summary', () => {
    const cfg = loadInstanceConfig(
      { VERGIS_DOMAINS: 'd.yaml', VERGIS_GROUPS: 'g.yaml', VERGIS_PI_OWNERS: 'o.yaml' },
      fs({ 'd.yaml': 'domains: []\n', 'g.yaml': 'groups: []\n', 'o.yaml': 'owners: {}\n' }),
    )
    expect(cfg.domains).toEqual([])
    expect(cfg.groupSeeds).toEqual([])
    expect(cfg.piOwners).toEqual({})
    expect(cfg.summary).toBe('groups 0 · domains 0 · pi-owners 0')
  })

  it('env no definido → ni error ni mención en el summary', () => {
    const cfg = loadInstanceConfig({}, fs({}))
    expect(cfg.summary).toBe('')
    expect(cfg).toMatchObject({ entities: [], groupSeeds: [], domains: [], intakeSlots: [], piOwners: {}, sourceReg: {} })
  })

  it('el summary compone los conteos de las seis configs, con los cuatro de sources', () => {
    const cfg = loadInstanceConfig(
      {
        VERGIS_GROUPS: 'g.yaml',
        VERGIS_DOMAINS: 'd.yaml',
        VERGIS_PI_OWNERS: 'o.yaml',
        VERGIS_SOURCES: 's.yaml',
        VERGIS_INTAKE: 'i.yaml',
        VERGIS_MASTER_DATA: 'm.yaml',
      },
      fs({
        'g.yaml': 'groups:\n  - id: analistas\n',
        'd.yaml': 'domains:\n  - id: cartera\n    label: Cartera\n  - id: personas\n    label: Personas\n',
        'o.yaml': 'owners:\n  pi-1: ana@gh.cl\n',
        's.yaml':
          'sources:\n  - id: sap\n    label: SAP\n    oferta: P1D\n' +
          'tableSources:\n  - tableRef: qw04.areas\n    sourceId: sap\n  - tableRef: qw04.otra\n    sourceId: sap\n' +
          'processes:\n  - id: p1\n    label: P1\n    sourceId: sap\n' +
          'processOutputs: []\n',
        'i.yaml': 'slots:\n  - id: saldos\n    label: Saldos\n    target: { workspaceId: w, lakehouseId: l, path: Files/x }\n',
        'm.yaml': 'entities:\n  - id: rel\n    label: Rel\n    columns:\n      - name: rut\n        pk: true\n',
      }),
    )
    expect(cfg.summary).toBe(
      'groups 1 · domains 2 · pi-owners 1 · sources 1 (tablas 2 · procesos 1 · salidas 0) · intake-slots 1 · master-data 1',
    )
    expect(cfg.sourceReg).toMatchObject({ sources: [{ id: 'sap', label: 'SAP', oferta: 'P1D' }] })
    expect(cfg.intakeSlots[0].id).toBe('saldos')
    expect(cfg.entities[0].id).toBe('rel')
  })

  it('claves secundarias de sources ausentes no aparecen como error y cuentan 0', () => {
    const cfg = loadInstanceConfig({ VERGIS_SOURCES: 's.yaml' }, fs({ 's.yaml': 'sources: []\n' }))
    expect(cfg.summary).toBe('sources 0 (tablas 0 · procesos 0 · salidas 0)')
  })
})

describe('instance-config · destinos de aviso y URL pública (#100)', () => {
  const notifyYaml = 'destinations:\n  - id: ops-slack\n    type: slack-webhook\n    url: https://hooks.slack.com/x\n'

  it('sin VERGIS_NOTIFY: cero destinos, URL pública opcional y ninguna mención en el summary', () => {
    const cfg = loadInstanceConfig({}, fs({}))
    expect(cfg.notify).toEqual({ destinations: [] })
    expect(cfg.publicUrl).toBe('')
    expect(cfg.summary).toBe('')
  })

  it('con destinos declarados y SIN VERGIS_PUBLIC_URL el arranque LANZA (el aviso quedaría sin dónde mirar)', () => {
    expect(() => loadInstanceConfig({ VERGIS_NOTIFY: 'n.yaml' }, fs({ 'n.yaml': notifyYaml }))).toThrow(
      /VERGIS_NOTIFY declara destinos pero falta VERGIS_PUBLIC_URL/,
    )
    // Cero destinos declarados no exige la URL: no hay enlace que emitir.
    expect(loadInstanceConfig({ VERGIS_NOTIFY: 'n.yaml' }, fs({ 'n.yaml': 'destinations: []\n' })).summary).toBe('notify 0')
  })

  it('con URL pública: se normaliza sin slash final y los destinos cuentan en el summary', () => {
    const cfg = loadInstanceConfig({ VERGIS_NOTIFY: 'n.yaml', VERGIS_PUBLIC_URL: ' https://mira.gh.example.com// ' }, fs({ 'n.yaml': notifyYaml }))
    expect(cfg.publicUrl).toBe('https://mira.gh.example.com')
    // `events` ausente ⇒ ['alerts'] (issue #102): la suscripción por defecto no cambia a quién le llega qué.
    expect(cfg.notify.destinations).toEqual([{ id: 'ops-slack', type: 'slack-webhook', url: 'https://hooks.slack.com/x', events: ['alerts'] }])
    expect(cfg.summary).toBe('notify 1')
  })

  it('un destino mal declarado sale envuelto con ENV y ruta, como cualquier otra config', () => {
    expect(() => loadInstanceConfig({ VERGIS_NOTIFY: 'n.yaml' }, fs({ 'n.yaml': 'destinations:\n  - type: teams\n    url: https://x\n' }))).toThrow(
      /VERGIS_NOTIFY \(\/.*n\.yaml\): notify: destino #0 con type inválido 'teams'/,
    )
  })
})

describe('instance-config · slices recargables (#138·2)', () => {
  it('env no declarado → undefined (la config no se usa; no es un error)', () => {
    for (const slice of Object.values(RELOADABLE_SLICES) as InstanceSlice<unknown>[]) {
      expect(loadSlice({}, slice, fs({}))).toBeUndefined()
    }
  })

  it('cada slice re-parsea desde disco con SU parser, sin tocar nada más', () => {
    const env: EnvLike = { VERGIS_NOTIFY: 'n.yaml', VERGIS_PI_OWNERS: 'o.yaml', VERGIS_SOURCES: 's.yaml' }
    const read = fs({
      'n.yaml': 'destinations:\n  - id: ops\n    type: slack-webhook\n    url: https://hooks.slack.com/x\n',
      'o.yaml': 'owners:\n  PI-1: ana@gh.cl\n',
      's.yaml': 'sources:\n  - id: sap\n    label: SAP\n    oferta: PT1H\n',
    })
    expect(loadSlice(env, RELOADABLE_SLICES.notify, read)?.destinations.map((d) => d.id)).toEqual(['ops'])
    expect(loadSlice(env, RELOADABLE_SLICES.piOwners, read)).toEqual({ 'PI-1': 'ana@gh.cl' })
    expect(loadSlice(env, RELOADABLE_SLICES.sources, read)?.sources?.map((s) => s.id)).toEqual(['sap'])
  })

  it('archivo roto (YAML inválido) → lanza nombrando el ENV y la ruta absoluta', () => {
    const env: EnvLike = { VERGIS_NOTIFY: 'cfg/n.yaml' }
    expect(() => loadSlice(env, RELOADABLE_SLICES.notify, fs({ 'n.yaml': 'destinations: [\n' }))).toThrow(/VERGIS_NOTIFY \(\/.*n\.yaml\)/)
  })

  it('archivo DECAPITADO (perdió la clave raíz) → lanza igual que en el boot (4.8)', () => {
    const casos: [InstanceSlice<unknown>, string, RegExp][] = [
      [RELOADABLE_SLICES.notify, 'n.yaml', /falta la clave raíz 'destinations'/],
      [RELOADABLE_SLICES.piOwners, 'o.yaml', /falta la clave raíz 'owners'/],
      [RELOADABLE_SLICES.sources, 's.yaml', /falta la clave raíz 'sources'/],
    ]
    for (const [slice, file, patron] of casos) {
      const llamar = (): unknown => loadSlice({ [slice.env]: file }, slice, fs({ [file]: 'otra_cosa: 1\n' }))
      expect(llamar).toThrow(patron)
      expect(llamar).toThrow(new RegExp(slice.env))
    }
  })

  it('el boot y la recarga usan LA MISMA entrada: el slice produce lo que `loadInstanceConfig` dejó', () => {
    const env: EnvLike = { VERGIS_PI_OWNERS: 'o.yaml' }
    const read = fs({ 'o.yaml': 'owners:\n  PI-7: Beto@gh.cl\n' })
    expect(loadSlice(env, RELOADABLE_SLICES.piOwners, read)).toEqual(loadInstanceConfig(env, read).piOwners)
  })
})
