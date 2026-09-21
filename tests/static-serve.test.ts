// SERVIR EL CONTENIDO ESTÁTICO DE LA INSTANCIA (`VERGIS_STATIC`, CAP-195) — el handler puro y su
// despacho en el router.
//
// Tres ejes: que sirva lo que debe (índice de la raíz, archivo anidado, MIME por lista blanca), que
// NO sirva lo que no debe (traversal en sus dos escrituras y symlink que escapa ⇒ 403) y que el
// despacho no le quite superficie a nadie (ni `/healthz` ni `/admin`; un Let con el mismo slug gana).
//
// **El control positivo del eje de seguridad es obligatorio y está acá**: un symlink INTERNO sí se
// sirve. Sin él, los tres 403 no distinguen «mi defensa funcionó» de «el arnés no supo construir el
// ataque» — un instrumento que confunde «medí y salió negativo» con «no pude medir» produce datos con
// cara de verdad. Por eso, además, cada ataque comprueba que el archivo objetivo EXISTE y es legible
// por el proceso antes de exigir el 403: si el objetivo no estuviera, el 403 no probaría nada.

import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, accessSync, realpathSync, constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveStatic, tipoDe, TIPO_DESCONOCIDO, type StaticHit } from '../server/static-serve'
import type { StaticCollection } from '../server/static-config'
import { createRequestHandler, type RouteDeps } from '../server/routes'
import type { Report } from '../server/discovery'

/**
 * Una colección REAL en disco: `index.html`, un archivo anidado, uno de extensión desconocida, un
 * symlink interno (el control positivo) y uno que escapa a un archivo de afuera que sí existe.
 */
function coleccionReal(): { dir: string; afuera: string; col: StaticCollection[] } {
  // `realpathSync` sobre el tmp: en macOS `/var` es un symlink a `/private/var`, y el handler
  // devuelve el camino REAL (así es como ataja un symlink que escapa). Comparar contra el camino sin
  // resolver haría fallar al control positivo por una razón que no tiene nada que ver con la defensa.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'vergis-serve-')))
  const dir = join(base, 'ayuda')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<h1>Portal de ayuda</h1>')
  writeFileSync(join(dir, 'assets', 'app.css'), 'body{}')
  writeFileSync(join(dir, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(dir, 'datos.parquet'), 'binario')
  // El «afuera»: el objetivo del escape, HERMANO de la raíz y dentro del tmp (no se toca /etc).
  const afuera = join(base, 'secreto.txt')
  writeFileSync(afuera, 'root:x:0:0')
  symlinkSync(join(dir, 'assets', 'app.css'), join(dir, 'atajo.css')) // INTERNO — control positivo
  symlinkSync(afuera, join(dir, 'fuga.txt')) // ESCAPA
  return { dir, afuera, col: [{ path: 'ayuda', dir }] }
}

const ok = (r: ReturnType<typeof resolveStatic>): StaticHit => {
  expect(r, 'se esperaba un hit y llegó null o un fallo').toMatchObject({ status: 200 })
  return r as StaticHit
}

// ── (2) SERVIR ───────────────────────────────────────────────────────────────────────────────────

describe('static-serve · sirve lo declarado', () => {
  const { col, dir } = coleccionReal()

  it('la raíz de la colección se sirve con su `index.html`', () => {
    for (const url of ['/ayuda', '/ayuda/']) {
      const hit = ok(resolveStatic(col, url))
      expect(hit.file, url).toBe(resolve(dir, 'index.html'))
      expect(hit.headers['content-type'], url).toBe('text/html; charset=utf-8')
    }
  })

  it('un archivo anidado se sirve con el MIME de su extensión', () => {
    expect(ok(resolveStatic(col, '/ayuda/assets/app.css')).headers['content-type']).toBe('text/css; charset=utf-8')
    expect(ok(resolveStatic(col, '/ayuda/assets/logo.png')).headers['content-type']).toBe('image/png')
  })

  it('una extensión fuera de la lista blanca sale `octet-stream`: no se adivina', () => {
    // REFUTARÍA: un `content-type` inferido del contenido — el sniffing es exactamente lo que la
    // lista blanca existe para no delegar.
    expect(ok(resolveStatic(col, '/ayuda/datos.parquet')).headers['content-type']).toBe(TIPO_DESCONOCIDO)
    expect(tipoDe('x.EXE')).toBe(TIPO_DESCONOCIDO)
    expect(tipoDe('sin-extension')).toBe(TIPO_DESCONOCIDO)
  })

  it('`nosniff` va en TODA respuesta, y `no-cache` solo en el HTML (no hay fingerprinting)', () => {
    const html = ok(resolveStatic(col, '/ayuda/'))
    const css = ok(resolveStatic(col, '/ayuda/assets/app.css'))
    expect(html.headers['x-content-type-options']).toBe('nosniff')
    expect(css.headers['x-content-type-options']).toBe('nosniff')
    expect(html.headers['cache-control']).toBe('no-cache')
    expect(css.headers['cache-control']).toBeUndefined()
    // REFUTARÍA la promesa de «actualizar es copiar el archivo»: un `immutable` sin fingerprinting.
    expect(JSON.stringify(html.headers)).not.toContain('immutable')
  })

  it('el `content-length` es el tamaño real del archivo en disco', () => {
    expect(ok(resolveStatic(col, '/ayuda/')).headers['content-length']).toBe(String('<h1>Portal de ayuda</h1>'.length))
  })

  it('un prefijo que no es de ninguna colección devuelve `null` — «no es mío», no un 404', () => {
    // REFUTARÍA la propiedad que hace seguro el despliegue: un 404 acá se comería el catálogo entero.
    expect(resolveStatic(col, '/otra-cosa')).toBeNull()
    expect(resolveStatic(col, '/')).toBeNull()
    expect(resolveStatic([], '/ayuda/')).toBeNull()
  })

  it('un directorio SIN `index.html` es 404, nunca un listado del directorio', () => {
    expect(resolveStatic(col, '/ayuda/assets/')).toEqual({ status: 404, error: expect.any(String) })
  })

  it('un archivo inexistente es 404 y un método que muta es 405 (la ruta existe, el método no)', () => {
    expect(resolveStatic(col, '/ayuda/no-esta.html')?.status).toBe(404)
    for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS']) expect(resolveStatic(col, '/ayuda/', m)?.status, m).toBe(405)
    expect(resolveStatic(col, '/ayuda/', 'HEAD')?.status).toBe(200)
  })
})

// ── (3) SEGURIDAD — con su control positivo ──────────────────────────────────────────────────────

describe('static-serve · nada fuera de la raíz declarada, y el control que lo prueba', () => {
  const { col, dir, afuera } = coleccionReal()

  it('CONTROL POSITIVO: un symlink INTERNO sí se sirve (si esto cae, los 403 no prueban nada)', () => {
    const hit = ok(resolveStatic(col, '/ayuda/atajo.css'))
    expect(hit.file).toBe(resolve(dir, 'assets', 'app.css'))
    expect(hit.headers['content-type']).toBe('text/css; charset=utf-8')
  })

  it('CONTROL DEL ARNÉS: el objetivo del escape existe y el proceso puede leerlo', () => {
    // Sin esto, un 403 sería indistinguible de «el archivo objetivo no estaba»: el instrumento
    // tiene que saber reportar que NO pudo medir.
    expect(() => accessSync(afuera, constants.R_OK)).not.toThrow()
  })

  it('`../..` en claro ⇒ 403', () => {
    for (const url of ['/ayuda/../secreto.txt', '/ayuda/../../etc/passwd', '/ayuda/assets/../../secreto.txt']) {
      expect(resolveStatic(col, url), url).toMatchObject({ status: 403 })
    }
  })

  it('`%2e%2e%2f` (el mismo ataque percent-encoded) ⇒ 403', () => {
    // REFUTARÍA: verificar la contención SIN decodificar mediría un string que el sistema de
    // archivos nunca va a ver — el 403 saldría de casualidad o no saldría.
    for (const url of ['/ayuda/%2e%2e%2fsecreto.txt', '/ayuda/%2e%2e/%2e%2e/etc/passwd', '/ayuda/..%2fsecreto.txt']) {
      expect(resolveStatic(col, url), url).toMatchObject({ status: 403 })
    }
  })

  it('un symlink que ESCAPA ⇒ 403, aunque el archivo exista y sea legible', () => {
    // Éste es el que la verificación léxica NO ve: la ruta pedida está dentro de la raíz.
    expect(resolveStatic(col, '/ayuda/fuga.txt')).toMatchObject({ status: 403 })
  })

  it('un prefijo HERMANO no cuenta como dentro (la contención es por segmento, no por substring)', () => {
    const otra: StaticCollection[] = [{ path: 'ayuda', dir }]
    expect(resolveStatic(otra, '/ayuda/../ayuda-otro/x.html')).toMatchObject({ status: 403 })
  })

  it('un NUL en la ruta se rechaza antes de tocar disco', () => {
    expect(resolveStatic(col, '/ayuda/a%00.html')).toMatchObject({ status: 403 })
  })
})

// ── (4) EL ROUTER ────────────────────────────────────────────────────────────────────────────────

const REPORT: Report = {
  code: 'QW-04', slug: 'qw-04', name: 'Asistencia', specName: 'Asistencia',
  specPath: '/a.yaml', proto: 'mira', tables: ['t'], databaseRefs: [],
}

function mkReq(url: string, method = 'GET'): IncomingMessage {
  return { url, method, headers: {} } as unknown as IncomingMessage
}

function mkRes() {
  const calls: { status: number; body: string; headers: Record<string, string> } = { status: 0, body: '', headers: {} }
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))
  const res = {
    headersSent: false,
    writeHead: (code: number, h?: Record<string, string>) => {
      calls.status = code
      if (h) calls.headers = h
    },
    write: (c: unknown) => {
      calls.body += String(c)
      return true
    },
    end: (b?: string) => {
      if (b) calls.body += b
      resolveDone()
    },
    on: () => res,
    once: () => res,
    emit: () => false,
    destroy: () => resolveDone(),
  } as unknown as ServerResponse
  return { res, calls, done }
}

function deps(over: Partial<RouteDeps> = {}): RouteDeps {
  return {
    engine: 'clickhouse',
    gateSecret: '',
    isReady: () => true,
    getAdmin: () => null,
    getPiConfig: () => null,
    discover: () => [REPORT],
    identityFor: () => ({ agent: 'test', user: 'ana@x.com' }),
    renderReport: async () => '<html>PI</html>',
    indexReports: async (all) => all,
    renderIndexPage: async () => '<html>INDEX</html>',
    canOpenPi: async () => true,
    ...over,
  }
}

describe('routes · despacho del contenido estático (CAP-195)', () => {
  const { col } = coleccionReal()
  const conEstaticos = (over: Partial<RouteDeps> = {}): RouteDeps => deps({ getStaticCollections: () => col, ...over })

  it('sirve el `index.html` de la colección con sus cabeceras', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(conEstaticos())(mkReq('/ayuda/'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(calls.headers['x-content-type-options']).toBe('nosniff')
  })

  it('el query se pela antes de resolver (`/ayuda/?v=2` sirve el índice igual)', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(conEstaticos())(mkReq('/ayuda/?v=2'), res)
    await done
    expect(calls.status).toBe(200)
  })

  it('NO intercepta `/healthz` ni `/admin`: una colección no puede quitarle superficie al nodo', () => {
    // Aunque alguien declare a mano una colección con ese prefijo (saltándose el parser), el
    // despacho de esas rutas va ANTES. REFUTARÍA: un `/healthz` servido como archivo estático.
    const conflictiva: StaticCollection[] = [{ path: 'healthz', dir: col[0]!.dir }]
    const { res, calls } = mkRes()
    createRequestHandler(deps({ getStaticCollections: () => conflictiva }))(mkReq('/healthz'), res)
    expect(calls.status).toBe(200)
    expect(JSON.parse(calls.body).engine).toBe('clickhouse')
  })

  it('un Let con el mismo slug GANA: el estático no lo tapa', async () => {
    const tapando: StaticCollection[] = [...col, { path: 'qw-04', dir: col[0]!.dir }]
    const { res, calls, done } = mkRes()
    createRequestHandler(deps({ getStaticCollections: () => tapando }))(mkReq('/qw-04'), res)
    await done
    // REFUTARÍA: el `index.html` de la colección en vez del PI — el dato gobernado perdiendo su ruta
    // porque alguien declaró un prefijo con su nombre.
    expect(calls.status).toBe(200)
    expect(calls.body).toBe('<html>PI</html>')
  })

  it('`POST` a una colección ⇒ 405 (la ruta existe, el método no)', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(conEstaticos())(mkReq('/ayuda/', 'POST'), res)
    await done
    expect(calls.status).toBe(405)
  })

  it('traversal a través del router ⇒ 403', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(conEstaticos())(mkReq('/ayuda/%2e%2e%2fsecreto.txt'), res)
    await done
    expect(calls.status).toBe(403)
  })

  it('sin la dep, la superficie es EXACTAMENTE la de antes de la capacidad', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps())(mkReq('/ayuda/'), res)
    await done
    // REFUTARÍA: cualquier cosa distinta del 404 de siempre en una instancia que no declara estáticos.
    expect(calls.status).toBe(404)
  })

  it('durante el arranque en frío el estático NO se adelanta al catálogo: 503 `Inicializando…`', async () => {
    // El desempate con un Let se decide contra el catálogo VIVO; con el catálogo aún vacío, servir
    // el estático le daría la ruta a la colección justo en la ventana en que el Let no se descubrió.
    const { res, calls, done } = mkRes()
    createRequestHandler(conEstaticos({ isReady: () => false, discover: () => [] }))(mkReq('/ayuda/'), res)
    await done
    expect(calls.status).toBe(503)
  })
})
