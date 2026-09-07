// Secciones de menú declaradas por la instancia (`VERGIS_MENU`): el parser y su carga por
// `loadInstanceConfig`. Lo que se prueba es la semántica de dos niveles — clave raíz ausente FATAL,
// sección/enlace inválidos OMITIDOS con aviso — y que el env ausente no produce ni sección ni ruido.

import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { parseMenuConfig, countMenuLinks } from '../server/menu-config'
import { loadInstanceConfig, type ReadFile } from '../server/instance-config'

const fs = (files: Record<string, string>): ReadFile => {
  return (path: string) => {
    const hit = Object.entries(files).find(([name]) => path.endsWith(name))
    if (!hit) throw new Error(`ENOENT: ${path}`)
    return hit[1]
  }
}

const VALIDO = `menu:
  - title: Ayuda
    links:
      - label: Catálogo del esquema (datadoc)
        href: /datadoc/
        description: Las entidades y columnas que sirven los PIs.
        newTab: true
      - label: Manual
        href: https://ejemplo.cl/manual
`

describe('menu-config · archivo válido', () => {
  it('carga secciones y enlaces con sus campos opcionales', () => {
    const { sections, warnings } = parseMenuConfig(parseYaml(VALIDO))
    expect(warnings).toEqual([])
    expect(sections).toHaveLength(1)
    expect(sections[0]!.title).toBe('Ayuda')
    expect(sections[0]!.links).toEqual([
      {
        label: 'Catálogo del esquema (datadoc)',
        href: '/datadoc/',
        description: 'Las entidades y columnas que sirven los PIs.',
        newTab: true,
      },
      { label: 'Manual', href: 'https://ejemplo.cl/manual' },
    ])
    expect(countMenuLinks(sections)).toBe(2)
  })

  it('`menu: []` es un cero legítimo y silencioso', () => {
    expect(parseMenuConfig({ menu: [] })).toEqual({ sections: [], warnings: [] })
  })
})

describe('menu-config · lo inválido se omite con aviso, no tumba el nodo', () => {
  it('un enlace sin href se omite nombrando sección, entrada y razón', () => {
    const r = parseMenuConfig({ menu: [{ title: 'Ayuda', links: [{ label: 'Sin destino' }, { label: 'OK', href: '/x' }] }] })
    expect(r.sections[0]!.links.map((l) => l.label)).toEqual(['OK'])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain("sección 'Ayuda'")
    expect(r.warnings[0]).toContain("entrada 'Sin destino'")
    expect(r.warnings[0]).toContain("'href'")
  })

  it('rechaza un href `javascript:` — un <a> del marco de identidad no ejecuta script por config', () => {
    const r = parseMenuConfig({ menu: [{ title: 'A', links: [{ label: 'X', href: 'javascript:alert(1)' }] }] })
    expect(r.sections).toEqual([])
    expect(r.warnings.join(' ')).toContain('href inválido')
  })

  it('rechaza esquemas y formas que no son ruta relativa ni https://', () => {
    for (const href of ['data:text/html,x', 'http://ejemplo.cl', '//ejemplo.cl/x', 'ejemplo.cl/x', 'https://']) {
      const r = parseMenuConfig({ menu: [{ title: 'A', links: [{ label: 'X', href }] }] })
      expect(r.sections, href).toEqual([])
    }
  })

  it('una sección sin title, o con links que no es lista, se omite entera', () => {
    const r = parseMenuConfig({ menu: [{ links: [{ label: 'X', href: '/x' }] }, { title: 'B', links: 'no-lista' }] })
    expect(r.sections).toEqual([])
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings[0]).toContain("sección #0 omitida: 'title'")
    expect(r.warnings[1]).toContain("sección 'B' omitida: 'links'")
  })

  it('una sección que se queda sin enlaces válidos NO se renderiza (rótulo suelto sería peor)', () => {
    const r = parseMenuConfig({ menu: [{ title: 'Vacía', links: [] }, { title: 'Rota', links: [{ label: 'X' }] }] })
    expect(r.sections).toEqual([])
    expect(r.warnings.filter((w) => w.includes('sin enlaces válidos'))).toHaveLength(2)
  })

  it('`description` y `newTab` con tipo equivocado omiten la entrada', () => {
    const r = parseMenuConfig({
      menu: [{ title: 'A', links: [{ label: 'X', href: '/x', description: 3 }, { label: 'Y', href: '/y', newTab: 'sí' }] }],
    })
    expect(r.sections).toEqual([])
    expect(r.warnings).toHaveLength(3) // dos entradas + la sección que quedó vacía
  })
})

describe('menu-config · clave raíz y carga por instance-config', () => {
  it('la clave raíz ausente sí es fatal, como en toda la config de instancia', () => {
    expect(() => parseMenuConfig({ otra: 1 })).toThrow(/falta la clave raíz 'menu'/)
    expect(() => loadInstanceConfig({ VERGIS_MENU: 'menu.yaml' }, fs({ 'menu.yaml': 'otra: 1\n' }))).toThrow(
      /VERGIS_MENU .*falta la clave raíz 'menu'/s,
    )
  })

  it('`menu` que no es lista es fatal, con la remediación en el mensaje', () => {
    expect(() => parseMenuConfig({ menu: { title: 'A' } })).toThrow(/`menu` debe ser una lista/)
  })

  it('env definido → secciones, avisos y la línea de conteos del arranque', () => {
    const cfg = loadInstanceConfig({ VERGIS_MENU: 'menu.yaml' }, fs({ 'menu.yaml': VALIDO }))
    expect(cfg.menuSections).toHaveLength(1)
    expect(cfg.menuWarnings).toEqual([])
    expect(cfg.summary).toBe('menu 1 sección(es) · 2 enlace(s)')
  })

  it('env ausente → cero secciones, cero avisos y ni mención en el summary', () => {
    const cfg = loadInstanceConfig({}, fs({}))
    expect(cfg.menuSections).toEqual([])
    expect(cfg.menuWarnings).toEqual([])
    expect(cfg.summary).toBe('')
  })

  it('los avisos viajan hasta el arranque para poder imprimirse', () => {
    const cfg = loadInstanceConfig(
      { VERGIS_MENU: 'm.yaml' },
      fs({ 'm.yaml': 'menu:\n  - title: Ayuda\n    links:\n      - label: Malo\n        href: javascript:x\n      - label: Bueno\n        href: /ok\n' }),
    )
    expect(cfg.menuSections[0]!.links.map((l) => l.label)).toEqual(['Bueno'])
    expect(cfg.menuWarnings).toHaveLength(1)
  })
})
