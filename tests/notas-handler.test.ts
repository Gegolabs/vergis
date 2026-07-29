// La CAPA DE NOTAS end-to-end por su handler (vergis#84) — con foco ADVERSARIAL: lo que importa no
// es que el camino feliz funcione, sino que el camino torcido no pase.
//
// Las invariantes bajo prueba:
//  · comentar un registro que la RLS del autor NO devuelve → 403 (la llave forjada no sirve);
//  · un dataset sin `anchor` no ofrece el gesto → 404;
//  · el receptor revocado pierde el acceso hacia adelante, pero sus notas persisten;
//  · un autor no puede editar ni borrar la nota de otro;
//  · la voz se rechaza con 501 (la estructura existe, la función no);
//  · la impresión se materializa perezosamente y se reutiliza dentro de la sesión;
//  · lo no compartido no aparece en la lista de nadie más.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { createNotas, sinDrills, type NotasHandler } from '../server/notas'
import { csrfFactory } from '../server/ui'
import { SqliteNotasStore, type ResolvedNode } from '@vergis/capabilities'
import type { MiraSpec } from '@vergis/mira'
import type { LogEventInput } from '@vergis/botler'

const SECRET = 'notas-secret'
const csrf = csrfFactory(SECRET)

function mockReq(method: string, url: string, user: string, body: unknown = ''): IncomingMessage {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const r = Readable.from([text]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url
  r.method = method
  r.headers = { 'x-test-user': user, accept: 'application/json' }
  return r
}
interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  writeHead(code: number, h?: Record<string, string>): MockRes
  end(chunk?: string): void
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, h) {
      this.statusCode = code
      Object.assign(this.headers, h ?? {})
      return this
    },
    end(chunk) {
      if (chunk) this.body += chunk
    },
  }
}

/** El dato «gobernado» del PI de prueba: ana ve la fila 1; beto ve la 2. La RLS vive acá. */
const FILAS: Record<string, Record<string, unknown>[]> = {
  'ana@x.com': [{ rut: '4021', nombre: 'Ana', sueldo: 100 }],
  'beto@x.com': [{ rut: '9999', nombre: 'Beto', sueldo: 200 }],
}

const SPEC = {
  mira_version: '1.0',
  identity: { id: 'pi-16', display_name: 'Folios', classification: 'internal', version: '2.1' },
  data: {
    empleados: {
      capability: 'mock',
      anchor: { entity: 'dbo.dim_empleado', key: ['rut'], display: 'nombre' },
    },
    // Un dataset SIN anchor: sobre él el gesto de comentar no existe.
    totales: { capability: 'mock' },
  },
  quality: {},
  delivery: {},
} as unknown as MiraSpec

const ARBOL: ResolvedNode = {
  type: 'table',
  dataset: 'empleados',
  rows: [{ rut: '4021', nombre: 'Ana' }],
  columnsSpec: [{ field: 'rut', label: 'RUT' }],
  drills: [{ to: 'detalle', by: ['rut'] }],
  ancla: { dataset: 'empleados', entity: 'dbo.dim_empleado', key: ['rut'], comentarios: {} },
}

describe('capa de notas · handler', () => {
  let store: SqliteNotasStore
  let h: NotasHandler
  let audit: LogEventInput[]
  let congelados: number

  beforeEach(async () => {
    store = await SqliteNotasStore.open(null)
    audit = []
    congelados = 0
    h = createNotas({
      store,
      resolve: (slug) => (slug === 'pi-16' ? { code: 'PI-16', name: 'Folios', slug, spec: SPEC } : undefined),
      identityOf: (hd) => ({ user: (hd as Record<string, string>)['x-test-user'] }),
      canOpenPi: async (_slug, hd) => !!(hd as Record<string, string>)['x-test-user'],
      // La «RLS»: cada identidad recibe solo sus filas.
      retrieve: async (_slug, dataset, _ctx, hd) => {
        if (dataset !== 'empleados') return []
        return FILAS[(hd as Record<string, string>)['x-test-user']] ?? []
      },
      congelar: async (slug, page, ctx, hd) => {
        congelados += 1
        return {
          piSlug: slug,
          piName: 'Folios',
          title: 'Folios',
          page,
          ctx,
          watermark: '2026-07-01T00:00:00.000Z',
          specVersion: '2.1·abc12345',
          autor: (hd as Record<string, string>)['x-test-user'],
          resolved: ARBOL,
        }
      },
      renderCongelado: async (f) => `<div id="congelado">${f.resolved.rows?.length ?? 0} fila(s)</div>`,
      avatarFor: async () => '<div class="avm"></div>',
      audit: (e) => audit.push(e),
      secret: SECRET,
      brandTitle: 'Vergis',
    })
  })

  const post = async (url: string, user: string, body: Record<string, unknown>) => {
    const res = mockRes()
    await h.tryHandle(mockReq('POST', url, user, { _csrf: csrf(user), ...body }), res as never)
    return res
  }
  const get = async (url: string, user: string) => {
    const res = mockRes()
    await h.tryHandle(mockReq('GET', url, user, ''), res as never)
    return res
  }

  // ── Comentarios: el gate al escribir ──
  it('comentar un registro VISIBLE bajo la RLS → 200 y la nota queda anclada a la entidad', async () => {
    const res = await post('/pi-16/comentarios', 'ana@x.com', { dataset: 'empleados', key: { rut: '4021' }, contenido: 'Contabilidad: OK' })
    expect(res.statusCode).toBe(200)
    const notas = await store.comentariosDeLlave('dbo.dim_empleado', { rut: '4021' })
    expect(notas).toHaveLength(1)
    expect(notas[0].contenido).toBe('Contabilidad: OK')
    expect(notas[0].entityRef).toBe('dbo.dim_empleado')
  })

  it('ADVERSARIAL · comentar una llave que la RLS del autor NO devuelve → 403', async () => {
    // beto ve la 9999; forjar la 4021 no le sirve: el gate consulta el DATO, no un token.
    const res = await post('/pi-16/comentarios', 'beto@x.com', { dataset: 'empleados', key: { rut: '4021' }, contenido: 'no debería' })
    expect(res.statusCode).toBe(403)
    expect(res.body).toMatch(/no visible/i)
    expect(await store.comentariosDeLlave('dbo.dim_empleado', { rut: '4021' })).toHaveLength(0)
  })

  it('ADVERSARIAL · leer el hilo de una llave no visible también es 403 (la lectura es fail-closed)', async () => {
    await post('/pi-16/comentarios', 'ana@x.com', { dataset: 'empleados', key: { rut: '4021' }, contenido: 'privado' })
    const res = await get(`/pi-16/comentarios?dataset=empleados&key=${encodeURIComponent(JSON.stringify({ rut: '4021' }))}`, 'beto@x.com')
    expect(res.statusCode).toBe(403)
    expect(res.body).not.toContain('privado')
  })

  it('el autor sí lee su hilo', async () => {
    await post('/pi-16/comentarios', 'ana@x.com', { dataset: 'empleados', key: { rut: '4021' }, contenido: 'visible' })
    const res = await get(`/pi-16/comentarios?dataset=empleados&key=${encodeURIComponent(JSON.stringify({ rut: '4021' }))}`, 'ana@x.com')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).notas[0].contenido).toBe('visible')
  })

  it('dataset SIN anchor → 404: la capacidad no existe ahí (fail-closed, D16)', async () => {
    const res = await post('/pi-16/comentarios', 'ana@x.com', { dataset: 'totales', key: { rut: '4021' }, contenido: 'x' })
    expect(res.statusCode).toBe(404)
    expect(res.body).toMatch(/anchor|llave de negocio/i)
  })

  it('la llave debe traer TODAS las columnas declaradas', async () => {
    const res = await post('/pi-16/comentarios', 'ana@x.com', { dataset: 'empleados', key: { otra: '1' }, contenido: 'x' })
    expect(res.statusCode).toBe(400)
  })

  it('CSRF inválido → 403', async () => {
    const res = mockRes()
    await h.tryHandle(
      mockReq('POST', '/pi-16/comentarios', 'ana@x.com', { _csrf: 'forjado', dataset: 'empleados', key: { rut: '4021' }, contenido: 'x' }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
  })

  // ── Impresiones y anotaciones ──
  it('«Imprimir» congela una impresión explícita, aún sin notas', async () => {
    const res = await post('/pi-16/imprimir', 'ana@x.com', {})
    expect(res.statusCode).toBe(200)
    const id = JSON.parse(res.body).id
    const imp = await store.getImpresion(id)
    expect(imp?.explicita).toBe(true)
    expect(imp?.watermark).toBe('2026-07-01T00:00:00.000Z')
    expect(imp?.specVersion).toBe('2.1·abc12345')
    expect(await store.notasDe(id)).toHaveLength(0)
  })

  it('anotar MATERIALIZA la impresión perezosamente y la reutiliza en la misma sesión', async () => {
    const a = await post('/pi-16/notas', 'ana@x.com', { contenido: 'primera', objetivo: { tipo: 'fila', llave: { rut: '4021' } } })
    const b = await post('/pi-16/notas', 'ana@x.com', { contenido: 'segunda', objetivo: { tipo: 'impresion' } })
    const idA = JSON.parse(a.body).impresionId
    const idB = JSON.parse(b.body).impresionId
    expect(idB).toBe(idA) // anotar dos filas de la misma vista no produce dos impresiones
    const imp = await store.getImpresion(idA)
    expect(imp?.explicita).toBe(false)
    expect(await store.notasDe(idA)).toHaveLength(2)
    expect(congelados).toBe(2) // se renderiza para congelar, pero la impresión es una sola
  })

  it('una nota vacía se rechaza', async () => {
    expect((await post('/pi-16/notas', 'ana@x.com', { contenido: '   ' })).statusCode).toBe(400)
  })

  it('ADVERSARIAL · contenidoTipo=voz → 501 (el modelo la conoce; la función es de otra versión)', async () => {
    const res = await post('/pi-16/notas', 'ana@x.com', { contenido: 'hablado', contenidoTipo: 'voz' })
    expect(res.statusCode).toBe(501)
    expect(res.body).toMatch(/voz/i)
  })

  it('sin identidad no se escribe nada (jamás se infiere)', async () => {
    expect((await post('/pi-16/notas', '', { contenido: 'x' })).statusCode).toBe(403)
  })

  it('PI inexistente → 404', async () => {
    expect((await post('/pi-99/imprimir', 'ana@x.com', {})).statusCode).toBe(404)
  })

  // ── Compartición ──
  it('compartir da acceso; revocar lo quita HACIA ADELANTE y las notas del receptor persisten', async () => {
    const id = JSON.parse((await post('/pi-16/imprimir', 'ana@x.com', {})).body).id
    // Antes de compartir, beto no la ve.
    expect((await get(`/impresiones/${id}`, 'beto@x.com')).statusCode).toBe(403)

    const res = mockRes()
    await h.tryHandle(mockReq('POST', `/impresiones/${id}/compartir`, 'ana@x.com', `_csrf=${csrf('ana@x.com')}&receptor=Beto%40x.com`), res as never)
    expect(res.statusCode).toBe(303)
    expect((await get(`/impresiones/${id}`, 'beto@x.com')).statusCode).toBe(200)

    // El receptor anota mientras tiene acceso.
    const nota = await post(`/impresiones/${id}/notas`, 'beto@x.com', { contenido: 'del receptor' })
    expect(nota.statusCode).toBe(200)

    const rev = mockRes()
    await h.tryHandle(mockReq('POST', `/impresiones/${id}/revocar`, 'ana@x.com', `_csrf=${csrf('ana@x.com')}&receptor=beto%40x.com`), rev as never)
    expect((await get(`/impresiones/${id}`, 'beto@x.com')).statusCode).toBe(403)
    expect((await post(`/impresiones/${id}/notas`, 'beto@x.com', { contenido: 'ya no' })).statusCode).toBe(403)
    // El trabajo humano no se borra por un cambio de permiso.
    const notas = await store.notasDe(id)
    expect(notas.map((n) => n.contenido)).toContain('del receptor')
  })

  it('ADVERSARIAL · un no-dueño no comparte, no revoca y no borra', async () => {
    const id = JSON.parse((await post('/pi-16/imprimir', 'ana@x.com', {})).body).id
    await h.tryHandle(mockReq('POST', `/impresiones/${id}/compartir`, 'ana@x.com', `_csrf=${csrf('ana@x.com')}&receptor=beto%40x.com`), mockRes() as never)
    for (const op of ['compartir', 'revocar', 'borrar']) {
      const res = mockRes()
      await h.tryHandle(mockReq('POST', `/impresiones/${id}/${op}`, 'beto@x.com', `_csrf=${csrf('beto@x.com')}&receptor=caro%40x.com`), res as never)
      expect(res.statusCode).toBe(403)
    }
    expect(await store.getImpresion(id)).not.toBeNull()
  })

  // ── «Mis impresiones» ──
  it('«Mis impresiones» separa las mías de las compartidas conmigo; lo no compartido no aparece', async () => {
    const mia = JSON.parse((await post('/pi-16/imprimir', 'ana@x.com', {})).body).id
    const secreta = JSON.parse((await post('/pi-16/imprimir', 'ana@x.com', { page: 'otra' })).body).id
    await h.tryHandle(mockReq('POST', `/impresiones/${mia}/compartir`, 'ana@x.com', `_csrf=${csrf('ana@x.com')}&receptor=beto%40x.com`), mockRes() as never)

    const deBeto = await get('/impresiones', 'beto@x.com')
    expect(deBeto.statusCode).toBe(200)
    expect(deBeto.body).toContain(mia)
    expect(deBeto.body).not.toContain(secreta)
    expect(deBeto.body).toContain('Compartidas conmigo')

    const deAna = await get('/impresiones', 'ana@x.com')
    expect(deAna.body).toContain(mia)
    expect(deAna.body).toContain(secreta)
  })

  it('borrar la impresión la saca de la lista', async () => {
    const id = JSON.parse((await post('/pi-16/imprimir', 'ana@x.com', {})).body).id
    await h.tryHandle(mockReq('POST', `/impresiones/${id}/borrar`, 'ana@x.com', `_csrf=${csrf('ana@x.com')}`), mockRes() as never)
    expect(await store.getImpresion(id)).toBeNull()
    expect((await get('/impresiones', 'ana@x.com')).body).not.toContain(id)
  })

  it('la vista de una impresión trae su procedencia y el congelado, no la vista viva', async () => {
    const id = JSON.parse((await post('/pi-16/imprimir', 'ana@x.com', {})).body).id
    const res = await get(`/impresiones/${id}`, 'ana@x.com')
    expect(res.body).toContain('Impresión de')
    expect(res.body).toContain('ana@x.com')
    expect(res.body).toContain('id="congelado"')
    expect(res.body).toContain('Anotaciones')
  })

  it('el handler ignora las rutas que no son suyas', async () => {
    expect(await h.tryHandle(mockReq('GET', '/pi-16', 'ana@x.com'), mockRes() as never)).toBe(false)
    expect(await h.tryHandle(mockReq('GET', '/admin', 'ana@x.com'), mockRes() as never)).toBe(false)
  })
})

describe('capa de notas · el congelado es un documento, no una vista', () => {
  it('sinDrills quita las acciones de navegación en todo el árbol', () => {
    const arbol: ResolvedNode = {
      layout: 'rows',
      elements: [
        { type: 'table', rows: [], drills: [{ to: 'x', by: ['a'] }] },
        { layout: 'cols', elements: [{ type: 'table', rows: [], drills: [{ to: 'y', by: ['b'] }] }] },
      ],
    }
    const limpio = sinDrills(arbol)
    expect(limpio.elements![0].drills).toBeUndefined()
    expect(limpio.elements![1].elements![0].drills).toBeUndefined()
    // No muta el original (el congelado guardado conserva lo que se guardó).
    expect(arbol.elements![0].drills).toHaveLength(1)
  })
})
