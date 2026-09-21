// COLECCIONES ESTÁTICAS DECLARADAS POR LA INSTANCIA (`VERGIS_STATIC`, CAP-195) — el parser, su carga
// por `loadInstanceConfig`, la recarga en caliente y lo que el contrato del nodo publica.
//
// El caso que funda la capacidad, MEDIDO el 2026-09-21: el portal de ayuda de la instancia GH se
// publicó como sitio estático servido por un contenedor aparte, con un bloque nuevo en el Caddyfile
// del borde, y dio 404 al usuario. La lección no es «montar por directorio» sino que publicar una
// página no debería tocar el borde. De ahí los dos ejes que se prueban acá: que declarar una
// colección sea config de instancia como cualquier otra (misma tabla, mismo watch, misma semántica de
// fallas), y que lo mal declarado se omita con aviso en vez de tumbar el nodo.
//
// Qué NO se prueba acá: `server/serve-rls.ts` no es importable (módulo de arranque con top-level
// await), así que —igual que `tests/menu-hot-reload.test.ts`— el orquestador de la recarga se reduce
// a su esqueleto verificable sobre las MISMAS piezas reales, y el CABLEADO concreto se ancla al TEXTO
// del módulo (último bloque). Si un ancla no se encuentra, el test falla nombrándola en vez de
// aprobar por omisión: el instrumento sabe reprobar.

import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseStaticConfig,
  omitirPorLets,
  estadoDeColecciones,
  avisosDeDirectorio,
  RUTAS_DEL_NODO,
  type StaticCollection,
} from '../server/static-config'
import { loadInstanceConfig, loadSlice, RELOADABLE_SLICES, type EnvLike, type ReadFile } from '../server/instance-config'
import { createContractRegistry } from '../server/contract'

const RAIZ = resolve(__dirname, '..')
const SERVE = readFileSync(join(RAIZ, 'server/serve-rls.ts'), 'utf8')

const fs = (files: Record<string, string>): ReadFile => {
  return (path: string) => {
    const hit = Object.entries(files).find(([name]) => path.endsWith(name))
    if (!hit) throw new Error(`ENOENT: ${path}`)
    return hit[1]
  }
}

/** Un directorio temporal real (los veredictos de disco no se simulan: se miden). */
function dirTmp(): string {
  return mkdtempSync(join(tmpdir(), 'vergis-static-'))
}

/** Escribe `contenido` en un yaml temporal; devuelve su ruta y cómo reescribirlo en caliente. */
function yamlTmp(nombre: string, contenido: string): { path: string; escribir: (c: string) => void } {
  const path = join(dirTmp(), nombre)
  writeFileSync(path, contenido, 'utf8')
  return { path, escribir: (c: string) => writeFileSync(path, c, 'utf8') }
}

// ── (1) EL PARSER ────────────────────────────────────────────────────────────────────────────────

describe('static-config · archivo válido', () => {
  it('carga las colecciones con su prefijo, su directorio absoluto y su rótulo opcional', () => {
    const { collections, warnings } = parseStaticConfig(
      parseYaml('static:\n  - path: ayuda\n    dir: /static/ayuda\n    label: Portal de ayuda\n  - path: datadoc\n    dir: /static/datadoc\n'),
    )
    expect(warnings).toEqual([])
    expect(collections).toEqual([
      { path: 'ayuda', dir: resolve('/static/ayuda'), label: 'Portal de ayuda' },
      { path: 'datadoc', dir: resolve('/static/datadoc') },
    ])
  })

  it('`static: []` es un cero legítimo y silencioso', () => {
    expect(parseStaticConfig({ static: [] })).toEqual({ collections: [], warnings: [] })
  })
})

describe('static-config · lo inválido se omite con aviso, no tumba el nodo', () => {
  it('un `path` vacío, con mayúsculas, con barras o con puntos se omite nombrando la entrada', () => {
    for (const path of ['', 'Ayuda', 'ayuda/sub', 'a/b', '.ayuda', '-ayuda', 'ay uda', 'ayuda.html', '..']) {
      const r = parseStaticConfig({ static: [{ path, dir: '/x' }] })
      // REFUTARÍA: un prefijo con barras o mayúsculas admitido — el despacho por primer segmento
      // dejaría de ser decidible y la colisión con un Let pasaría a depender del case de la URL.
      expect(r.collections, `path=${JSON.stringify(path)}`).toEqual([])
      expect(r.warnings, `path=${JSON.stringify(path)}`).toHaveLength(1)
      expect(r.warnings[0]).toMatch(/omitida:/)
    }
  })

  it('una entrada sin `dir` se omite: una colección sin raíz no es una colección', () => {
    const r = parseStaticConfig({ static: [{ path: 'ayuda' }, { path: 'ok', dir: '/x' }] })
    expect(r.collections.map((c) => c.path)).toEqual(['ok'])
    expect(r.warnings[0]).toContain("colección 'ayuda' omitida")
    expect(r.warnings[0]).toContain("'dir'")
  })

  it('un `path` que choca con una ruta propia del nodo se omite nombrándola', () => {
    for (const reservada of RUTAS_DEL_NODO) {
      const r = parseStaticConfig({ static: [{ path: reservada, dir: '/x' }] })
      // REFUTARÍA: `/admin` o `/healthz` tapados por una colección — pérdida de superficie que nadie
      // declaró, y de las que solo se descubren cuando ya no se puede administrar el nodo.
      expect(r.collections, reservada).toEqual([])
      expect(r.warnings.join(' '), reservada).toContain('ruta propia del nodo')
    }
  })

  it('un prefijo declarado dos veces omite el segundo: el despacho no puede ser ambiguo', () => {
    const r = parseStaticConfig({ static: [{ path: 'ayuda', dir: '/a' }, { path: 'ayuda', dir: '/b' }] })
    expect(r.collections.map((c) => c.dir)).toEqual([resolve('/a')])
    expect(r.warnings.join(' ')).toContain('ya fue declarado')
  })

  it('un `label` que no es string omite la entrada; una entrada que no es mapa también', () => {
    const r = parseStaticConfig({ static: [{ path: 'a', dir: '/a', label: 3 }, 'no-soy-un-mapa'] })
    expect(r.collections).toEqual([])
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings[0]).toContain("'label'")
    expect(r.warnings[1]).toContain('no es un mapa')
  })
})

describe('static-config · el desempate con un Let: gana el Let', () => {
  const cols: StaticCollection[] = [
    { path: 'ayuda', dir: '/s/ayuda' },
    { path: 'qw-04', dir: '/s/qw-04' },
  ]

  it('una colección cuyo prefijo es el slug de un Let servido se omite NOMBRANDO el Let', () => {
    const r = omitirPorLets(cols, new Set(['qw-04', 'pi-15']))
    // REFUTARÍA: `qw-04` servido como estático — el PI dejaría de responder y nadie lo declaró.
    expect(r.collections.map((c) => c.path)).toEqual(['ayuda'])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain("Let 'qw-04'")
    expect(r.warnings[0]).toContain('gana')
  })

  it('sin Lets que choquen, no omite nada ni inventa avisos', () => {
    expect(omitirPorLets(cols, new Set(['pi-15']))).toEqual({ collections: cols, warnings: [] })
  })
})

describe('static-config · clave raíz y carga por instance-config', () => {
  it('la clave raíz ausente sí es fatal, como en toda la config de instancia', () => {
    expect(() => parseStaticConfig({ otra: 1 })).toThrow(/falta la clave raíz 'static'/)
    expect(() => loadInstanceConfig({ VERGIS_STATIC: 'static.yaml' }, fs({ 'static.yaml': 'otra: 1\n' }))).toThrow(
      /VERGIS_STATIC .*falta la clave raíz 'static'/s,
    )
  })

  it('`static` que no es lista es fatal, con la remediación en el mensaje', () => {
    expect(() => parseStaticConfig({ static: {} })).toThrow(/`static` debe ser una lista/)
  })

  it('env definido → colecciones, avisos y la línea de conteos del arranque', () => {
    const cfg = loadInstanceConfig({ VERGIS_STATIC: 'static.yaml' }, fs({ 'static.yaml': 'static:\n  - path: ayuda\n    dir: /static/ayuda\n' }))
    expect(cfg.staticCollections).toHaveLength(1)
    expect(cfg.staticWarnings).toEqual([])
    expect(cfg.summary).toBe('static 1 colección(es)')
  })

  it('env ausente → cero colecciones, cero avisos y ni mención en el summary', () => {
    const cfg = loadInstanceConfig({}, fs({}))
    expect(cfg.staticCollections).toEqual([])
    expect(cfg.staticWarnings).toEqual([])
    expect(cfg.summary).toBe('')
  })
})

// ── (5) LA RECARGA EN CALIENTE ───────────────────────────────────────────────────────────────────

/** El estado vivo que el arranque deja y la recarga repuebla: los DOS arreglos de `INSTANCE_CFG`. */
interface StaticVivo {
  staticCollections: StaticCollection[]
  staticWarnings: string[]
}

/**
 * El orquestador de `reloadInstanceSlices` para el slice `static`, reducido a su esqueleto: los
 * mismos pasos, en el mismo orden, sobre las mismas piezas. NUNCA lanza — una recarga jamás tumba el
 * nodo. El swap es un SPLICE sobre los arreglos vivos, no una reasignación.
 */
function recargarStatic(
  env: EnvLike,
  vivo: StaticVivo,
  contract: ReturnType<typeof createContractRegistry>,
  path: string,
  log: (m: string) => void = () => {},
  err: (m: string) => void = () => {},
): boolean {
  try {
    const next = loadSlice(env, RELOADABLE_SLICES.static) ?? { collections: [], warnings: [] }
    vivo.staticCollections.splice(0, vivo.staticCollections.length, ...next.collections)
    vivo.staticWarnings.splice(0, vivo.staticWarnings.length, ...next.warnings)
    log(`[hot-reload] estáticos de instancia (watch:instancia): ${vivo.staticCollections.length} colección(es)`)
    for (const w of vivo.staticWarnings) log(`[hot-reload] VERGIS_STATIC (watch:instancia): ${w}`)
    contract.record({ reason: 'watch:instancia', ok: true }, [{ source: 'static', path }])
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(`[hot-reload] VERGIS_STATIC: recarga rechazada, se conserva lo vigente (watch:instancia): VERGIS_STATIC (${path}): ${msg}`)
    contract.record({ reason: 'watch:instancia', ok: false, error: `static: ${msg}` })
    return false
  }
}

const registro = (): ReturnType<typeof createContractRegistry> => createContractRegistry({ engine: 'fabric', hotReload: true })

const UNA = 'static:\n  - path: ayuda\n    dir: /static/ayuda\n'
const DOS = 'static:\n  - path: ayuda\n    dir: /static/ayuda\n  - path: datadoc\n    dir: /static/datadoc\n'

describe('estáticos en caliente · el slice está en la tabla que comparten boot y watch', () => {
  it('`RELOADABLE_SLICES.static` existe, declara `VERGIS_STATIC`, y parsea IGUAL que el boot', () => {
    // REFUTARÍA el mecanismo: `RELOADABLE_SLICES.static` ausente — los estáticos se cargarían por un
    // `loadOne` propio, que es exactamente la divergencia que la tabla existe para hacer imposible.
    expect(RELOADABLE_SLICES.static).toBeDefined()
    expect(RELOADABLE_SLICES.static.env).toBe('VERGIS_STATIC')

    const y = yamlTmp('static.yaml', DOS)
    const env: EnvLike = { VERGIS_STATIC: y.path }
    expect(loadSlice(env, RELOADABLE_SLICES.static)?.collections).toEqual(loadInstanceConfig(env).staticCollections)
  })

  it('agregar y quitar una colección en caliente se refleja en el estado vivo', () => {
    const y = yamlTmp('static.yaml', UNA)
    const env: EnvLike = { VERGIS_STATIC: y.path }
    const vivo = loadInstanceConfig(env)
    expect(vivo.staticCollections.map((c) => c.path)).toEqual(['ayuda'])

    y.escribir(DOS)
    expect(recargarStatic(env, vivo, registro(), y.path)).toBe(true)
    // REFUTARÍA: seguiría una sola colección — publicar una página exigiría recrear el proceso, que
    // es justo el costo que la capacidad retira.
    expect(vivo.staticCollections.map((c) => c.path)).toEqual(['ayuda', 'datadoc'])

    y.escribir(UNA)
    recargarStatic(env, vivo, registro(), y.path)
    expect(vivo.staticCollections.map((c) => c.path)).toEqual(['ayuda'])
  })

  it('el consumidor que CAPTURÓ el arreglo al arranque ve las colecciones nuevas (el swap es un splice)', () => {
    const y = yamlTmp('static.yaml', UNA)
    const env: EnvLike = { VERGIS_STATIC: y.path }
    const vivo = loadInstanceConfig(env)
    const capturado = vivo.staticCollections // como `createAdmin` capturó `menuSections` en CAP-194

    y.escribir(DOS)
    recargarStatic(env, vivo, registro(), y.path)
    // La identidad de la referencia se conserva: si alguien reasigna en vez de splicear, esto cae.
    expect(capturado).toBe(vivo.staticCollections)
    expect(capturado.map((c) => c.path)).toEqual(['ayuda', 'datadoc'])
  })
})

describe('estáticos en caliente · una recarga inválida NUNCA tumba el nodo', () => {
  const casos: { nombre: string; contenido: string; motivo: RegExp }[] = [
    // El motivo se exige LITERAL (el texto del parser de `yaml`), no un genérico: un /VERGIS_STATIC/
    // lo satisface también el mensaje de una recarga que ni llegó al parser, y el caso aprobaría sin
    // haber medido nada.
    { nombre: 'YAML que no parsea', contenido: 'static: [\n  - path: ayuda\n', motivo: /Block collections are not allowed within flow collections/ },
    { nombre: 'archivo DECAPITADO (perdió la clave raíz)', contenido: 'otra_clave: 1\n', motivo: /clave raíz 'static'/ },
    { nombre: '`static` que no es una lista', contenido: 'static: {}\n', motivo: /debe ser una lista/ },
  ]
  for (const caso of casos) {
    it(`${caso.nombre}: no lanza, lo vigente sobrevive y queda el motivo`, () => {
      const y = yamlTmp('static.yaml', DOS)
      const env: EnvLike = { VERGIS_STATIC: y.path }
      const vivo = loadInstanceConfig(env)
      const c = registro()
      const errores: string[] = []

      y.escribir(caso.contenido)
      // REFUTARÍA el «una recarga jamás tumba el nodo»: un throw que salga de acá.
      const ok = recargarStatic(env, vivo, c, y.path, () => {}, (m) => void errores.push(m))

      expect(ok).toBe(false)
      // REFUTARÍA el validate-before-swap: cero colecciones, o las de un archivo a medio escribir.
      expect(vivo.staticCollections.map((x) => x.path)).toEqual(['ayuda', 'datadoc'])
      expect(errores.join('\n')).toMatch(/se conserva lo vigente/)
      expect(errores.join('\n')).toMatch(caso.motivo)
      const last = c.snapshot().reloads.last
      expect(last?.ok).toBe(false)
      expect(last?.error).toMatch(/^static: /)
    })
  }

  it('los avisos de la recarga anterior no se acumulan: el arreglo vivo se repuebla entero', () => {
    const y = yamlTmp('static.yaml', 'static:\n  - path: MALO\n    dir: /x\n  - path: ayuda\n    dir: /static/ayuda\n')
    const env: EnvLike = { VERGIS_STATIC: y.path }
    const vivo = loadInstanceConfig(env)
    expect(vivo.staticWarnings).toHaveLength(1)
    y.escribir(UNA)
    recargarStatic(env, vivo, registro(), y.path)
    expect(vivo.staticWarnings).toEqual([])
  })
})

// ── (6) EL CONTRATO DEL NODO ─────────────────────────────────────────────────────────────────────

describe('estáticos · el contrato del nodo los declara y marca el directorio que no está', () => {
  it('`estadoDeColecciones` mide el DISCO: existe y es legible vs. no está', () => {
    const base = dirTmp()
    const vivo = join(base, 'ayuda')
    mkdirSync(vivo)
    const estado = estadoDeColecciones([
      { path: 'ayuda', dir: vivo },
      { path: 'fantasma', dir: join(base, 'no-existe') },
    ])
    // REFUTARÍA: un `exists:true` sobre un directorio ausente — el contrato mintiendo con la
    // autoridad del nodo, que es la única cosa peor que no tener contrato.
    expect(estado.map((c) => [c.path, c.exists, c.readable])).toEqual([
      ['ayuda', true, true],
      ['fantasma', false, false],
    ])
    expect(avisosDeDirectorio(estado)).toHaveLength(1)
    expect(avisosDeDirectorio(estado)[0]).toContain("colección 'fantasma'")
    expect(avisosDeDirectorio(estado)[0]).toContain('no existe')
  })

  it('un archivo (no directorio) declarado como `dir` NO cuenta como existente', () => {
    const base = dirTmp()
    const f = join(base, 'no-soy-dir')
    writeFileSync(f, 'x')
    expect(estadoDeColecciones([{ path: 'x', dir: f }])[0]!.exists).toBe(false)
  })

  it('`GET /contrato` lista las colecciones, marca la inexistente y la tapada por un Let', () => {
    const base = dirTmp()
    const vivo = join(base, 'ayuda')
    mkdirSync(vivo)
    const declaradas: StaticCollection[] = [
      { path: 'ayuda', dir: vivo },
      { path: 'fantasma', dir: join(base, 'no-existe') },
      { path: 'qw-04', dir: vivo },
    ]
    const slugs = new Set(['qw-04'])
    // El proveedor es el MISMO closure que cablea `serve-rls.ts`: estado de disco + desempate vivo.
    const c = createContractRegistry({
      engine: 'fabric',
      hotReload: true,
      staticCollections: () => estadoDeColecciones(declaradas).map((x) => ({ ...x, shadowedByLet: slugs.has(x.path) })),
    })
    const snap = c.snapshot()
    expect(snap.static?.map((x) => [x.path, x.exists, x.shadowedByLet])).toEqual([
      ['ayuda', true, false],
      ['fantasma', false, false],
      ['qw-04', true, true],
    ])
  })

  it('sin proveedor cableado el contrato dice `[]`, no finge; y un proveedor que lanza no es un 500', () => {
    expect(createContractRegistry({ engine: 'fabric', hotReload: true }).snapshot().static).toEqual([])
    const roto = createContractRegistry({
      engine: 'fabric',
      hotReload: true,
      staticCollections: () => {
        throw new Error('disco ilegible')
      },
    })
    // REFUTARÍA el fail-safe del contrato: un throw que salga de `snapshot()`. El contrato es
    // observabilidad — quedarse sin la sección es infinitamente mejor que un 500 en `/contrato`.
    expect(() => roto.snapshot()).not.toThrow()
    expect(roto.snapshot().static).toEqual([])
  })

  it('registrado el watch, `VERGIS_STATIC` es `reloadableContent` y ya no `bootOnly`', () => {
    const y = yamlTmp('static.yaml', UNA)
    const c = registro()
    c.env('VERGIS_STATIC')
    expect(c.snapshot().env.bootOnly).toContain('VERGIS_STATIC')
    const unwatch = c.watch({ envs: ['VERGIS_STATIC'], reloads: 'config de instancia, por archivo' }, [y.path], () => {})
    const snap = c.snapshot()
    expect(snap.env.reloadableContent).toContain('VERGIS_STATIC')
    expect(snap.env.bootOnly).not.toContain('VERGIS_STATIC')
    unwatch()
    rmSync(y.path, { force: true })
  })
})

// ── EL CABLEADO REAL de serve-rls.ts (anclado al texto: el módulo no es importable) ──────────────

describe('estáticos · el cableado de `serve-rls.ts` instala lo que el contrato promete', () => {
  it('deriva `STATIC_PATH`, lo vigila, lo declara en los `envs` del watch y lo registra como artefacto', () => {
    expect(SERVE, 'no se encontró la derivación de STATIC_PATH en serve-rls.ts').toMatch(
      /const STATIC_PATH = contract\.env\('VERGIS_STATIC'\)[^\n]*resolve\(/,
    )
    const i = SERVE.indexOf('const instanceTargets =')
    expect(i, 'no se encontró `instanceTargets` en serve-rls.ts').toBeGreaterThan(-1)
    const bloque = SERVE.slice(i, SERVE.indexOf("reloadInstanceSlices('watch:instancia')", i))
    // REFUTARÍA: el archivo fuera del arreglo vigilado o fuera de los `envs` declarados — el watch
    // existiría pero no cubriría el archivo, que es el estado que CAP-194 midió con el menú.
    expect(bloque).toMatch(/STATIC_PATH \? \[STATIC_PATH\] : \[\]/)
    expect(bloque).toMatch(/STATIC_PATH \? \['VERGIS_STATIC'\] : \[\]/)
    expect(SERVE, 'el artefacto `static` no se registra en el contrato').toMatch(/source: 'static', path: STATIC_PATH/)
  })

  it('la recarga del slice hace SPLICE sobre los arreglos vivos, no reasignación', () => {
    const j = SERVE.indexOf('function reloadInstanceSlices(')
    expect(j, 'no se encontró `reloadInstanceSlices` en serve-rls.ts').toBeGreaterThan(-1)
    const cuerpo = SERVE.slice(j, SERVE.indexOf('\nfunction reloadGovernance(', j))
    expect(cuerpo).toMatch(/INSTANCE_CFG\.staticCollections\.splice\(/)
    expect(cuerpo).toMatch(/INSTANCE_CFG\.staticWarnings\.splice\(/)
    expect(cuerpo, 'reasignar la propiedad rompería a cualquier consumidor que capture la referencia').not.toMatch(
      /INSTANCE_CFG\.staticCollections\s*=/,
    )
  })

  it('el router recibe el arreglo VIVO por getter, y el contrato su proveedor', () => {
    expect(SERVE, 'el router no recibe las colecciones estáticas').toMatch(
      /getStaticCollections: \(\) => INSTANCE_CFG\.staticCollections/,
    )
    expect(SERVE, 'el contrato no recibe el proveedor de estáticos').toMatch(/staticCollections: \(\) => \{/)
  })
})
