import { describe, it, expect } from 'vitest'
import { indexHtml } from '../server/catalog'
import { avatarMenu } from '../server/ui'

describe('catálogo · marco de identidad (avatar)', () => {
  it('renderiza los PIs y va enmarcado con el avatar', () => {
    const avatar = avatarMenu({ email: 'cesar.obach@gh.cl', isAdmin: true, hasDomains: true, signoutRd: '/' })
    const html = indexHtml(
      [{ code: 'PI-01', slug: 'pi-01', name: 'Cartera' }, { code: 'PI-04', slug: 'pi-04', name: 'Asistencia' }],
      'Productos de Información',
      { avatar },
    )
    expect(html).toContain('PI-01')
    expect(html).toContain('Cartera')
    expect(html).toContain('class="avm"') // el avatar está presente
    expect(html).toContain('.avm{position:fixed') // y su CSS
    expect(html).toContain('cesar.obach@gh.cl') // identidad visible
    expect(html).toContain('CO') // iniciales
    expect(html).toContain('href="/oauth2/sign_out?rd=%2F"') // salir vuelve al catálogo
  })

  it('el avatar gradúa el menú por rol', () => {
    const consumer = avatarMenu({ email: 'consumidor@gh.cl', isAdmin: false, hasDomains: false, signoutRd: '/' })
    expect(consumer).toContain('Perfil')
    expect(consumer).not.toContain('Configuración') // no admin
    expect(consumer).not.toContain('>Gestión</a>') // no gestiona dominios
    const power = avatarMenu({ email: 'admin@gh.cl', isAdmin: true, hasDomains: true, signoutRd: '/' })
    expect(power).toContain('>Gestión</a>')
    expect(power).toContain('>Configuración</a>')
  })
})
