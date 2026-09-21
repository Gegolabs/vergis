// LAS SECCIONES DE MENÚ DE LA INSTANCIA SE RECARGAN EN CALIENTE (`VERGIS_MENU`, CAP-194).
//
// El defecto que cierra, medido el 2026-09-21 contra `0.29.0` en producción: se escribió el
// `menu.yaml` nuevo del portal de ayuda y el catálogo vivo siguió sirviendo los seis enlaces viejos
// —el watch de instancia no cubría el menú—, así que el cambio quedó atrapado hasta la promoción
// siguiente. El menú se cargaba con `loadOne` en vez de pasar por `RELOADABLE_SLICES`.
//
// Qué prueban estos tests y qué NO: `server/serve-rls.ts` no es importable (módulo de arranque con
// top-level await), así que —igual que `tests/instance-reload.test.ts`— el orquestador se reduce acá
// a su esqueleto verificable, con las MISMAS piezas reales (`loadSlice`, `RELOADABLE_SLICES`,
// `loadInstanceConfig`, `avatarMenu`, `createContractRegistry`). El CABLEADO concreto de serve-rls
// —que `MENU_PATH` entre en `instanceTargets` y en los `envs` del watch— queda fuera del alcance de
// un import, y por eso se ancla al TEXTO del módulo (último bloque), como ya hace
// `tests/imagen-anillo-labels.test.ts` con `embeddedStores()`.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { loadInstanceConfig, loadSlice, RELOADABLE_SLICES, type EnvLike } from '../server/instance-config'
import { countMenuLinks, type MenuSection } from '../server/menu-config'
import { avatarMenu } from '../server/ui'
import { createContractRegistry } from '../server/contract'

const RAIZ = resolve(__dirname, '..')
const SERVE = readFileSync(join(RAIZ, 'server/serve-rls.ts'), 'utf8')

const DOS_ENLACES = `menu:
  - title: Ayuda
    links:
      - label: Catálogo del esquema
        href: /datadoc/
      - label: Manual viejo
        href: /guias/manual-viejo.html
`
const UN_ENLACE = `menu:
  - title: Ayuda
    links:
      - label: Portal de ayuda
        href: /ayuda/
`

/** Escribe `contenido` en un yaml temporal; devuelve su ruta y cómo reescribirlo en caliente. */
function yamlTmp(nombre: string, contenido: string): { path: string; escribir: (c: string) => void } {
  const path = join(mkdtempSync(join(tmpdir(), 'vergis-menu-')), nombre)
  writeFileSync(path, contenido, 'utf8')
  return { path, escribir: (c: string) => writeFileSync(path, c, 'utf8') }
}

/** El estado vivo que el arranque deja y la recarga repuebla: los DOS arreglos de `INSTANCE_CFG`. */
interface MenuVivo {
  menuSections: MenuSection[]
  menuWarnings: string[]
}

/**
 * El orquestador de `reloadInstanceSlices` para el slice `menu`, reducido a su esqueleto: los mismos
 * pasos, en el mismo orden, sobre las mismas piezas. NUNCA lanza — una recarga jamás tumba el nodo.
 * El swap es un SPLICE sobre los arreglos vivos, no una reasignación (ver el test 3).
 */
function recargarMenu(
  env: EnvLike,
  vivo: MenuVivo,
  contract: ReturnType<typeof createContractRegistry>,
  path: string,
  log: (m: string) => void = () => {},
  err: (m: string) => void = () => {},
): boolean {
  try {
    const next = loadSlice(env, RELOADABLE_SLICES.menu) ?? { sections: [], warnings: [] }
    vivo.menuSections.splice(0, vivo.menuSections.length, ...next.sections)
    vivo.menuWarnings.splice(0, vivo.menuWarnings.length, ...next.warnings)
    log(`[hot-reload] menú de instancia (watch:instancia): ${vivo.menuSections.length} sección(es) · ${countMenuLinks(vivo.menuSections)} enlace(s)`)
    for (const w of vivo.menuWarnings) log(`[hot-reload] VERGIS_MENU (watch:instancia): ${w}`)
    contract.record({ reason: 'watch:instancia', ok: true }, [{ source: 'menu', path }])
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(`[hot-reload] VERGIS_MENU: recarga rechazada, se conserva lo vigente (watch:instancia): VERGIS_MENU (${path}): ${msg}`)
    contract.record({ reason: 'watch:instancia', ok: false, error: `menu: ${msg}` })
    return false
  }
}

const registro = (): ReturnType<typeof createContractRegistry> => createContractRegistry({ engine: 'fabric', hotReload: true })

/** El «arranque»: `loadInstanceConfig` real, del que salen los arreglos vivos que todo lo demás usa. */
function boot(env: EnvLike): MenuVivo {
  const cfg = loadInstanceConfig(env)
  return cfg
}

// ── (1) El menú entra por la MISMA puerta que los otros slices ───────────────────────────────────

describe('menú en caliente · el slice está en la tabla que comparten boot y watch (CAP-194)', () => {
  it('(1) `RELOADABLE_SLICES.menu` existe, declara `VERGIS_MENU`, y `loadSlice` parsea IGUAL que el boot', () => {
    // REFUTARÍA el mecanismo: `RELOADABLE_SLICES.menu` ausente — el menú seguiría cargándose por un
    // `loadOne` propio, que es exactamente la divergencia que la tabla existe para hacer imposible.
    expect(RELOADABLE_SLICES.menu).toBeDefined()
    expect(RELOADABLE_SLICES.menu.env).toBe('VERGIS_MENU')

    const y = yamlTmp('menu.yaml', DOS_ENLACES)
    const env: EnvLike = { VERGIS_MENU: y.path }
    const porElSlice = loadSlice(env, RELOADABLE_SLICES.menu)
    const porElBoot = loadInstanceConfig(env)
    expect(porElSlice?.sections).toEqual(porElBoot.menuSections)
    expect(porElSlice?.warnings).toEqual(porElBoot.menuWarnings)
  })
})

// ── (2)(3) La recarga feliz, y que los consumidores la vean ──────────────────────────────────────

describe('menú en caliente · el archivo cambia y el menú servido cambia (caso medido del 2026-09-21)', () => {
  it('(2) reescribir el yaml y recargar deja las secciones NUEVAS en el estado vivo', () => {
    const y = yamlTmp('menu.yaml', DOS_ENLACES)
    const env: EnvLike = { VERGIS_MENU: y.path }
    const vivo = boot(env)
    expect(vivo.menuSections).toHaveLength(1)
    expect(countMenuLinks(vivo.menuSections)).toBe(2)

    y.escribir(UN_ENLACE)
    expect(recargarMenu(env, vivo, registro(), y.path)).toBe(true)

    // REFUTARÍA: seguirían los dos enlaces viejos — el fenómeno medido en producción, donde el
    // catálogo vivo servía el menú anterior tras reescribir el archivo.
    expect(countMenuLinks(vivo.menuSections)).toBe(1)
    expect(vivo.menuSections[0]!.links.map((l) => l.label)).toEqual(['Portal de ayuda'])
  })

  it('(3) el consumidor que CAPTURÓ el arreglo al arranque sirve el menú nuevo (el swap es un splice)', () => {
    const y = yamlTmp('menu.yaml', DOS_ENLACES)
    const env: EnvLike = { VERGIS_MENU: y.path }
    const vivo = boot(env)

    // `createAdmin({ menuSections: INSTANCE_CFG.menuSections })` de `serve-rls.ts` captura ESTA
    // referencia al arranque y la lee a render-time (`admin.ts`): es el consumidor que una
    // reasignación de la propiedad dejaría con el menú viejo. Se reproduce su captura literal.
    const depsAdmin = { menuSections: vivo.menuSections }
    const base = { email: 'ana.perez@gh.cl', isAdmin: true, hasDomains: true, signoutRd: '/' }

    y.escribir(UN_ENLACE)
    recargarMenu(env, vivo, registro(), y.path)

    // La identidad de la referencia se conserva: si alguien reasigna en vez de splicear, esto cae.
    expect(depsAdmin.menuSections).toBe(vivo.menuSections)
    const htmlAdmin = avatarMenu({ ...base, sections: depsAdmin.menuSections })
    // REFUTARÍA: el HTML de `/admin` con el enlace viejo — un menú que cambia según la pantalla.
    expect(htmlAdmin).toContain('href="/ayuda/"')
    expect(htmlAdmin).not.toContain('/guias/manual-viejo.html')
    // Y el consumidor que lee la propiedad por request (el catálogo, `avatarFor`) coincide con él.
    expect(avatarMenu({ ...base, sections: vivo.menuSections })).toBe(htmlAdmin)
  })
})

// ── (4) La recarga rota conserva lo vigente, y el nodo sigue de pie ──────────────────────────────

describe('menú en caliente · una recarga inválida NUNCA tumba el nodo (regla de los hermanos)', () => {
  const casos: { nombre: string; contenido: string; motivo: RegExp }[] = [
    // El motivo se exige LITERAL (el texto del parser de `yaml`), no un genérico: un `/VERGIS_MENU/`
    // lo satisface también el mensaje de una recarga que ni siquiera llegó al parser, y entonces el
    // caso aprobaría sin haber medido nada.
    { nombre: 'YAML que no parsea', contenido: 'menu: [\n  - title: Ayuda\n', motivo: /Block collections are not allowed within flow collections/ },
    { nombre: 'archivo DECAPITADO (perdió la clave raíz)', contenido: 'otra_clave: 1\n', motivo: /clave raíz 'menu'/ },
    { nombre: '`menu` que no es una lista', contenido: 'menu: {}\n', motivo: /debe ser una lista/ },
  ]
  for (const caso of casos) {
    it(`(4) ${caso.nombre}: no lanza, las secciones vigentes sobreviven y queda el motivo`, () => {
      const y = yamlTmp('menu.yaml', DOS_ENLACES)
      const env: EnvLike = { VERGIS_MENU: y.path }
      const vivo = boot(env)
      const c = registro()
      const errores: string[] = []

      y.escribir(caso.contenido)
      // REFUTARÍA el «una recarga jamás tumba el nodo»: un throw que salga de acá.
      const ok = recargarMenu(env, vivo, c, y.path, () => {}, (m) => void errores.push(m))

      expect(ok).toBe(false)
      // REFUTARÍA el validate-before-swap: cero secciones, o el menú a medio escribir servido.
      expect(countMenuLinks(vivo.menuSections)).toBe(2)
      expect(vivo.menuSections[0]!.links.map((l) => l.label)).toEqual(['Catálogo del esquema', 'Manual viejo'])
      expect(errores.join('\n')).toMatch(/se conserva lo vigente/)
      expect(errores.join('\n')).toMatch(caso.motivo)
      const last = c.snapshot().reloads.last
      expect(last?.ok).toBe(false)
      expect(last?.error).toMatch(/^menu: /)
    })
  }
})

// ── (5) Las entradas inválidas se siguen omitiendo una por una, con su aviso ─────────────────────

describe('menú en caliente · la omisión por entrada es la MISMA del arranque', () => {
  it('(5) sección sin `title` y `href: javascript:` se omiten con aviso; el resto entra', () => {
    const y = yamlTmp('menu.yaml', DOS_ENLACES)
    const env: EnvLike = { VERGIS_MENU: y.path }
    const vivo = boot(env)
    const avisos: string[] = []

    y.escribir(
      'menu:\n' +
        '  - links:\n' +
        '      - label: Huérfana\n' +
        '        href: /x\n' +
        '  - title: Ayuda\n' +
        '    links:\n' +
        '      - label: Portal de ayuda\n' +
        '        href: /ayuda/\n' +
        '      - label: Trampa\n' +
        '        href: javascript:alert(1)\n',
    )
    expect(recargarMenu(env, vivo, registro(), y.path, (m) => void avisos.push(m))).toBe(true)

    // El resto entra: la omisión es por entrada, no por archivo.
    expect(vivo.menuSections.map((s) => s.title)).toEqual(['Ayuda'])
    expect(vivo.menuSections[0]!.links.map((l) => l.label)).toEqual(['Portal de ayuda'])
    // …y no en silencio: los avisos quedan en el estado vivo y se RE-EMITEN nombrando la recarga.
    expect(vivo.menuWarnings).toHaveLength(2)
    expect(vivo.menuWarnings.join('\n')).toMatch(/'title' debe ser un string no vacío/)
    expect(vivo.menuWarnings.join('\n')).toMatch(/href inválido 'javascript:alert\(1\)'/)
    expect(avisos.filter((m) => m.includes('[hot-reload] VERGIS_MENU (watch:instancia):'))).toHaveLength(2)
    // Mismo veredicto que el arranque sobre el MISMO archivo: la recarga no es un parser distinto.
    expect(loadInstanceConfig(env).menuWarnings).toEqual(vivo.menuWarnings)
  })

  it('(5-bis) los avisos de la recarga anterior no se acumulan: el arreglo vivo se repuebla entero', () => {
    const y = yamlTmp('menu.yaml', 'menu:\n  - title: Ayuda\n    links:\n      - label: Malo\n        href: javascript:x\n      - label: Bueno\n        href: /b\n')
    const env: EnvLike = { VERGIS_MENU: y.path }
    const vivo = boot(env)
    expect(vivo.menuWarnings).toHaveLength(1)
    y.escribir(UN_ENLACE)
    recargarMenu(env, vivo, registro(), y.path)
    expect(vivo.menuWarnings).toEqual([])
  })
})

// ── (6) CONTROL: sin `VERGIS_MENU` nada cambia ───────────────────────────────────────────────────

describe('menú en caliente · control: una instancia SIN `VERGIS_MENU` se comporta idéntico', () => {
  it('(6) cero secciones, cero avisos, y ningún target de watch derivado del menú', () => {
    const cfg = loadInstanceConfig({})
    expect(cfg.menuSections).toEqual([])
    expect(cfg.menuWarnings).toEqual([])
    expect(cfg.summary).not.toMatch(/menu/)

    // La derivación del cableado es «env declarado ⇒ ruta vigilada»; sin env, no hay ruta.
    const MENU_PATH = null as string | null
    const targets = [...(MENU_PATH ? [MENU_PATH] : [])]
    expect(targets).toEqual([])
  })
})

// ── (7) El contrato lo declara recargable, y el cableado de serve-rls lo instala ─────────────────

describe('menú en caliente · el contrato del nodo deja de mentir sobre `VERGIS_MENU`', () => {
  it('(7) registrado el watch, `VERGIS_MENU` es `reloadableContent` y ya no `bootOnly`', () => {
    const y = yamlTmp('menu.yaml', UN_ENLACE)
    const c = registro()
    c.env('VERGIS_MENU') // la config de instancia consume la clave al arrancar
    expect(c.snapshot().env.bootOnly).toContain('VERGIS_MENU')

    const unwatch = c.watch({ envs: ['VERGIS_MENU'], reloads: 'config de instancia, por archivo' }, [y.path], () => {})
    const snap = c.snapshot()
    expect(snap.env.reloadableContent).toContain('VERGIS_MENU')
    expect(snap.env.bootOnly).not.toContain('VERGIS_MENU')
    unwatch()
  })

  it('(7-bis) el CABLEADO real: `serve-rls.ts` deriva `MENU_PATH`, lo vigila y lo declara en el watch', () => {
    // Anclado al texto porque el módulo de arranque no es importable. Si el ancla no se encuentra,
    // el test falla nombrándola en vez de aprobar por omisión (el instrumento sabe reprobar).
    expect(SERVE, 'no se encontró la derivación de MENU_PATH en serve-rls.ts').toMatch(
      /const MENU_PATH = contract\.env\('VERGIS_MENU'\)[^\n]*resolve\(/,
    )
    const i = SERVE.indexOf('const instanceTargets =')
    expect(i, 'no se encontró `instanceTargets` en serve-rls.ts').toBeGreaterThan(-1)
    const bloque = SERVE.slice(i, SERVE.indexOf('reloadInstanceSlices(\'watch:instancia\')', i))
    // REFUTARÍA: el menú fuera del arreglo vigilado o fuera de los `envs` declarados — el watch
    // existiría pero no cubriría el archivo, que es el estado de 0.29.0.
    expect(bloque).toMatch(/MENU_PATH \? \[MENU_PATH\] : \[\]/)
    expect(bloque).toMatch(/MENU_PATH \? \['VERGIS_MENU'\] : \[\]/)
    // …y la recarga del slice existe y hace SPLICE, no reasignación (punto 4 del diseño).
    const j = SERVE.indexOf('function reloadInstanceSlices(')
    const cuerpo = SERVE.slice(j, SERVE.indexOf('\nfunction reloadGovernance(', j))
    expect(cuerpo).toMatch(/INSTANCE_CFG\.menuSections\.splice\(/)
    expect(cuerpo).toMatch(/INSTANCE_CFG\.menuWarnings\.splice\(/)
    expect(cuerpo, 'reasignar la propiedad dejaría al avatar de /admin con el menú viejo').not.toMatch(/INSTANCE_CFG\.menuSections\s*=/)
  })
})
