/**
 * LA PUERTA DE SALIDA GENÉRICA (H3 · #295 · D-72): `ProtoBotlet.invoke` y el despacho por familia.
 *
 * Lo que estos tests miden es que MIRA NO CAMBIÓ: su `invoke` devuelve exactamente lo que el render
 * inyectado devuelve, para exactamente la ruta que el router ya atendía, y `null` para todo lo demás
 * —que es lo que deja intactas sus rutas propias (`/pdf`, `/config`, notas), servidas antes de llegar
 * acá—. La prueba fuerte de esto no vive en la suite sino en el banco v8 (§5.3 del brief); esto es su
 * control barato y determinista.
 */
import { describe, it, expect } from 'vitest'
import { createMiraProto } from '@vergis/mira'
import { catalogoSinDatosGobernados, createProtoRegistry } from '../server/proto-registry'
import type { LetInvocation } from '@vergis/botler'

const inv = (over: Partial<LetInvocation> = {}): LetInvocation => ({
  method: 'GET',
  path: '',
  query: {},
  rawUrl: '/qw-04',
  headers: {},
  identity: { agent: 'test', user: 'ana@x.com' },
  hasControl: true,
  activeHolder: 'nodo-1',
  base: '/qw-04',
  ...over,
})

describe('proto-invoke · Mira por la puerta genérica', () => {
  it('GET de la raíz del Let → 200 con EXACTAMENTE lo que devuelve el render inyectado', async () => {
    const proto = createMiraProto({ render: async (specPath) => `<html>${specPath}</html>` })
    const out = await proto.invoke({}, '/specs/qw-04.yaml', inv())
    expect(out).toEqual({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      body: '<html>/specs/qw-04.yaml</html>',
    })
  })

  it('el render recibe la invocación entera: la URL CRUDA viaja (el multi-select de `?ctx.x=` depende de los repetidos)', async () => {
    let visto = ''
    const proto = createMiraProto({
      render: async (_p, i) => {
        visto = i.rawUrl
        return ''
      },
    })
    await proto.invoke({}, '/s.yaml', inv({ rawUrl: '/qw-04?ctx.area=a&ctx.area=b', query: { 'ctx.area': 'b' } }))
    expect(visto).toBe('/qw-04?ctx.area=a&ctx.area=b')
  })

  it('cualquier otra ruta → null (el nodo 404ea; las rutas Mira-específicas las sirve el router antes)', async () => {
    const proto = createMiraProto({ render: async () => 'X' })
    expect(await proto.invoke({}, '/s.yaml', inv({ path: 'pdf' }))).toBeNull()
    expect(await proto.invoke({}, '/s.yaml', inv({ path: 'api/guides' }))).toBeNull()
  })

  it('un método que no es GET sobre la raíz → null (Mira no escribe por esta puerta)', async () => {
    const proto = createMiraProto({ render: async () => 'X' })
    expect(await proto.invoke({}, '/s.yaml', inv({ method: 'POST' }))).toBeNull()
  })

  it('Mira declara que SÍ consume datos gobernados', () => {
    expect(createMiraProto({ render: async () => '' }).consumesData).toBe(true)
  })
})

describe('proto-registry · byType (el despacho)', () => {
  it('resuelve la familia por su `type` y devuelve undefined para una desconocida', () => {
    const mira = createMiraProto({ render: async () => '' })
    const reg = createProtoRegistry([mira])
    expect(reg.byType('mira')).toBe(mira)
    expect(reg.byType('daftar')).toBeUndefined()
  })
})

// --- H3 (#295 · §3.2) · un nodo sin motor de datos ---------------------------------------------
describe('proto-registry · catalogoSinDatosGobernados (el arranque sin DWH)', () => {
  const mira = createMiraProto({ render: async () => '' })
  const daftar = {
    type: 'daftar',
    discriminator: 'daftar_version',
    consumesData: false,
    parse: () => ({}),
    capabilitiesOf: () => [],
    dataOf: () => [],
    identityOf: () => ({ code: 'estudios' }),
    invoke: async () => null,
  }
  const reg = createProtoRegistry([mira, daftar])

  it('solo Lets sin datos → true: el nodo arranca sin datasets, sin conexiones y sin bootstrap', () => {
    expect(catalogoSinDatosGobernados([{ proto: 'daftar' }], reg)).toBe(true)
  })

  it('un PI de Mira en la mezcla → false: ese sí necesita motor', () => {
    expect(catalogoSinDatosGobernados([{ proto: 'daftar' }, { proto: 'mira' }], reg)).toBe(false)
  })

  it('CATÁLOGO VACÍO → false: un directorio de specs vacío por accidente debe fallar como siempre, no arrancar mudo', () => {
    expect(catalogoSinDatosGobernados([], reg)).toBe(false)
  })

  it('una familia no registrada → false (fail-closed: no se asume nada de lo que no se conoce)', () => {
    expect(catalogoSinDatosGobernados([{ proto: 'desconocida' }], reg)).toBe(false)
  })
})
