// Secciones declaradas por la instancia en el menú del avatar (`VERGIS_MENU`). Lo que se prueba es
// que la instancia AGREGA sin mover nada — el test de regresión es HTML idéntico sin `sections` — y
// que lo que se renderiza escapa el label y el href, respeta el orden y marca `newTab`.

import { describe, it, expect } from 'vitest'
import { avatarMenu } from '../server/ui'
import type { MenuSection } from '../server/menu-config'

const base = { email: 'ana.perez@gh.cl', isAdmin: true, hasDomains: true, signoutRd: '/' }

const AYUDA: MenuSection[] = [
  {
    title: 'Ayuda',
    links: [{ label: 'Catálogo del esquema (datadoc)', href: '/datadoc/', description: 'Entidades y columnas', newTab: true }],
  },
]

describe('avatarMenu · sin secciones el menú es el de siempre', () => {
  it('HTML idéntico con `sections` ausente, vacío, o con una sección sin enlaces', () => {
    const hoy = avatarMenu(base)
    expect(avatarMenu({ ...base, sections: [] })).toBe(hoy)
    expect(avatarMenu({ ...base, sections: [{ title: 'Ayuda', links: [] }] })).toBe(hoy)
    expect(hoy).not.toContain('avlbl')
  })
})

describe('avatarMenu · secciones declaradas por la instancia', () => {
  it('renderiza rótulo y enlace, con description como title y newTab seguro', () => {
    const html = avatarMenu({ ...base, sections: AYUDA })
    expect(html).toContain('<div class="avlbl">Ayuda</div>')
    expect(html).toContain('href="/datadoc/"')
    expect(html).toContain('title="Entidades y columnas"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
    expect(html).toContain('Catálogo del esquema (datadoc)')
  })

  it('sin newTab no se abre en pestaña nueva, y sin description no se inventa un title', () => {
    const html = avatarMenu({ ...base, sections: [{ title: 'Ayuda', links: [{ label: 'Manual', href: '/m' }] }] })
    expect(html).toContain('<a href="/m">Manual</a>')
    expect(html).not.toContain('target="_blank"')
  })

  it('la sección va DESPUÉS de los ítems del Producto y ANTES de tema y salir', () => {
    const html = avatarMenu({ ...base, sections: AYUDA })
    const cfg = html.indexOf('Configuración')
    const ayuda = html.indexOf('avlbl')
    const tema = html.indexOf('Cambiar tema')
    expect(cfg).toBeGreaterThan(-1)
    expect(ayuda).toBeGreaterThan(cfg)
    expect(tema).toBeGreaterThan(ayuda)
    // La instancia agrega: los ítems del Producto siguen todos ahí.
    for (const item of ['Catálogo de PIs', 'Perfil', 'Mis impresiones', '>Gestión</a>', '>Configuración</a>', 'Cerrar sesión'])
      expect(html).toContain(item)
  })

  it('dos secciones se renderizan en el orden declarado', () => {
    const html = avatarMenu({
      ...base,
      sections: [
        { title: 'Ayuda', links: [{ label: 'A', href: '/a' }] },
        { title: 'Referencia', links: [{ label: 'B', href: '/b' }] },
      ],
    })
    expect(html.indexOf('>Ayuda<')).toBeLessThan(html.indexOf('>Referencia<'))
    expect(html.indexOf('>A</a>')).toBeLessThan(html.indexOf('>B</a>'))
  })

  it('escapa label, href y title — el YAML de la instancia no inyecta HTML en el marco', () => {
    const html = avatarMenu({
      ...base,
      sections: [
        {
          title: '<b>T</b>',
          links: [{ label: '<img src=x onerror=alert(1)>', href: '/x?a=1&b="2"', description: '<i>d</i>' }],
        },
      ],
    })
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<b>T</b>')
    expect(html).not.toContain('<i>d</i>')
    expect(html).toContain('&lt;img src=x')
    expect(html).toContain('href="/x?a=1&amp;b=&quot;2&quot;"')
  })
})

describe('avatarMenu · entrada de la Consola SQL (#306)', () => {
  it('sin `hasConsola` no aparece: una superficie no se anuncia a quien no puede abrirla', () => {
    expect(avatarMenu(base)).not.toContain('/consola')
    expect(avatarMenu({ ...base, hasConsola: false })).not.toContain('/consola')
  })
  it('con `hasConsola` aparece, y DESPUÉS de Miranda', () => {
    const m = avatarMenu({ ...base, hasMiranda: true, hasConsola: true })
    expect(m).toContain('>Consola SQL<')
    expect(m.indexOf('/miranda')).toBeLessThan(m.indexOf('/consola'))
  })
})
