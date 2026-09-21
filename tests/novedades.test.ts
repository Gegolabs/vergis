// NOVEDADES (`GET /novedades`, issue #308) — el CHANGELOG embarcado en la imagen, publicado por HTTP.
//
// Cada bloque de abajo dice qué corrida lo REFUTARÍA, porque un test que pasa igual sin el cambio no
// prueba nada. Los cinco ejes del encargo: la versión que corre sale PRIMERO · el ancla por versión
// resuelve · «Sin publicar» AUSENTE · una versión inexistente no rompe la página · el enlace del pie
// apunta a la ruta.
//
// **El control positivo del eje «Sin publicar» es obligatorio y está acá**: la fixture contiene la
// sección, y un test comprueba que el PARSEO la ve antes de que otro exija que la PÁGINA no la tenga.
// Sin ese control, «no aparece» no distingue «el filtro funcionó» de «la fixture nunca la trajo» —
// un instrumento que confunde las dos produce datos con cara de verdad.

import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseChangelog,
  seccionesPublicables,
  ordenarPorVersionQueCorre,
  novedadesHtml,
  mdToHtml,
  inlineHtml,
  createNovedadesHandler,
} from '../server/novedades'
import { createRequestHandler, type RouteDeps } from '../server/routes'
import type { Report } from '../server/discovery'
import { indexHtml } from '../server/catalog'
import { VERGIS_VERSION } from '../packages/capabilities/src/version'

/** Fixture: la forma REAL del documento — prosa de proceso, «Sin publicar» y tres versiones. */
const CHANGELOG_FIXTURE = `# Changelog — Vergis

Texto de encabezado que no es una sección.

## Qué significa cada tag de la imagen

| Tag | Qué es |
|--|--|
| \`0.31.0\` | Una versión publicada |

## Sin publicar

### El nodo aprende a volar

**Qué trae:** una capacidad que NADIE tiene todavía porque no se cortó ninguna versión con ella.
Palabra canaria: PLUMAS-SECRETAS.

## 0.31.0 — 2026-09-21

### El nodo sirve el contenido estático de la instancia

**Qué trae:** colecciones de archivos con [la misma autorización](docs/capacidades.md) del catálogo.

- Un ítem con \`código\` inline.
- Otro ítem.

## 0.30.0 — 2026-09-20

**Qué trae:** el menú se recarga en caliente.

## 0.29.0 — 2026-09-19

**Qué trae:** subtotal por grupo.
`

const VERSIONES = ['0.31.0', '0.30.0', '0.29.0']

// ── (1) EL PARSEO, Y SU CONTROL POSITIVO ─────────────────────────────────────────────────────────

describe('novedades · el CHANGELOG partido en secciones', () => {
  it('CONTROL POSITIVO: la fixture SÍ trae «Sin publicar» y el parseo la ve (si esto cae, el filtro no prueba nada)', () => {
    const todas = parseChangelog(CHANGELOG_FIXTURE)
    const sp = todas.filter((s) => s.sinPublicar)
    expect(sp).toHaveLength(1)
    expect(sp[0].cuerpo).toContain('PLUMAS-SECRETAS')
  })

  it('las secciones de versión salen con su número, en el orden del documento', () => {
    expect(seccionesPublicables(CHANGELOG_FIXTURE).map((s) => s.version)).toEqual(VERSIONES)
  })

  it('la prosa de proceso NO es una novedad: la tabla de tags queda fuera', () => {
    // REFUTARÍA: «Qué significa cada tag» entre las secciones publicables — el manual de quien corta
    // versiones sepultando lo que el lector vino a buscar.
    expect(seccionesPublicables(CHANGELOG_FIXTURE).map((s) => s.titulo)).not.toContain('Qué significa cada tag de la imagen')
  })

  it('un `##` dentro de una cerca de código NO abre sección', () => {
    const md = '## 1.0.0 — hoy\n\n```\n## no soy un encabezado\n```\n\n## 0.9.0 — ayer\n'
    expect(parseChangelog(md).map((s) => s.titulo)).toEqual(['1.0.0 — hoy', '0.9.0 — ayer'])
  })
})

// ── (2) «SIN PUBLICAR» NO SE SIRVE ───────────────────────────────────────────────────────────────

describe('novedades · «Sin publicar» jamás llega a la página', () => {
  it('no está entre las secciones publicables', () => {
    expect(seccionesPublicables(CHANGELOG_FIXTURE).some((s) => s.sinPublicar)).toBe(false)
  })

  it('el HTML no contiene ni el título ni una sola palabra de su cuerpo', () => {
    // REFUTARÍA: publicar el documento entero. Lo que corre es una versión CORTADA; mostrar lo no
    // publicado le promete al lector capacidades que su nodo no tiene.
    const html = novedadesHtml({ md: CHANGELOG_FIXTURE, version: '0.31.0' })
    expect(html).not.toContain('PLUMAS-SECRETAS')
    expect(html).not.toContain('El nodo aprende a volar')
    expect(html.toLowerCase()).not.toContain('sin publicar')
  })

  it('tampoco cuando la versión que corre es justamente la que no existe', () => {
    const html = novedadesHtml({ md: CHANGELOG_FIXTURE, version: '9.9.9' })
    expect(html).not.toContain('PLUMAS-SECRETAS')
  })

  it('y tampoco a través del handler HTTP, que es el único camino real', async () => {
    const { res, calls, done } = mkRes()
    await createNovedadesHandler({ leerChangelog: () => CHANGELOG_FIXTURE, version: '0.31.0' })(mkReq('/novedades'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.body).not.toContain('PLUMAS-SECRETAS')
  })

  it('el CHANGELOG REAL del repo pasa por el mismo filtro (no es solo la fixture)', () => {
    const real = readFileSync(resolve(__dirname, '..', 'CHANGELOG.md'), 'utf8')
    const html = novedadesHtml({ md: real, version: VERGIS_VERSION })
    for (const s of parseChangelog(real).filter((x) => x.sinPublicar)) {
      // Una frase larga y textual del cuerpo: si la sección existe hoy, esto la caza en la página.
      const frase = (s.cuerpo.split('\n').find((l) => l.trim().length > 40) ?? '').trim().slice(0, 40)
      if (frase) expect(html, 'una entrada de «Sin publicar» se filtró a la página').not.toContain(frase)
    }
    expect(html).not.toMatch(/>Sin publicar</)
  })
})

// ── (3) LA VERSIÓN QUE CORRE VA PRIMERO, Y SU ANCLA RESUELVE ─────────────────────────────────────

describe('novedades · la versión que corre encabeza la página', () => {
  it('el orden pone la que corre primero y deja el resto en orden de documento', () => {
    const { actual, historial } = ordenarPorVersionQueCorre(seccionesPublicables(CHANGELOG_FIXTURE), '0.30.0')
    expect(actual?.version).toBe('0.30.0')
    expect(historial.map((s) => s.version)).toEqual(['0.31.0', '0.29.0'])
  })

  it('en el HTML, la que corre aparece ANTES que las demás aunque no sea la más nueva', () => {
    // REFUTARÍA: renderizar el documento en su orden natural — 0.31.0 saldría primero y el nodo que
    // corre 0.29.0 abriría la página en las novedades de otra versión.
    const html = novedadesHtml({ md: CHANGELOG_FIXTURE, version: '0.29.0' })
    const pos = (v: string): number => html.indexOf(`id="${v}"`)
    expect(pos('0.29.0')).toBeGreaterThan(-1)
    expect(pos('0.29.0')).toBeLessThan(pos('0.31.0'))
    expect(pos('0.29.0')).toBeLessThan(pos('0.30.0'))
  })

  it('la sección que corre va marcada, y una sola vez', () => {
    const html = novedadesHtml({ md: CHANGELOG_FIXTURE, version: '0.30.0' })
    expect(html.match(/class="nv-tag"/g)).toHaveLength(1)
    expect(html.match(/id="0\.30\.0"/g)).toHaveLength(1)
  })

  it('cada versión tiene su ancla estable y el índice enlaza a todas', () => {
    const html = novedadesHtml({ md: CHANGELOG_FIXTURE, version: '0.31.0' })
    for (const v of VERSIONES) {
      expect(html, v).toContain(`id="${v}"`)
      expect(html, v).toContain(`href="#${v}"`)
    }
  })
})

// ── (4) UNA VERSIÓN INEXISTENTE NO ROMPE LA PÁGINA ───────────────────────────────────────────────

describe('novedades · la versión que el changelog no tiene se dice, no se inventa', () => {
  it('con una versión ausente la página se sirve igual, con el historial completo', () => {
    // REFUTARÍA: una página en blanco, un throw o —peor— destacar cualquier sección como si fuera
    // la que corre. `package.json` puede ir adelante del CHANGELOG en cualquier momento.
    const html = novedadesHtml({ md: CHANGELOG_FIXTURE, version: '9.9.9' })
    for (const v of VERSIONES) expect(html, v).toContain(`id="${v}"`)
    expect(html).toContain('v9.9.9')
    expect(html).not.toContain('class="nv-tag"')
  })

  it('sin versión declarada tampoco rompe', () => {
    const html = novedadesHtml({ md: CHANGELOG_FIXTURE, version: null })
    expect(html).toContain('id="0.31.0"')
    expect(html).not.toContain('class="nv-tag"')
  })

  it('un changelog sin ninguna versión se sirve diciendo que no hay ninguna', () => {
    const html = novedadesHtml({ md: '# Changelog\n\n## Sin publicar\n\ntodavía nada\n', version: '1.0.0' })
    expect(html).toContain('no declara ninguna versión publicada')
    expect(html).not.toContain('todavía nada')
  })
})

// ── (5) EL MARCO Y EL MARKDOWN ───────────────────────────────────────────────────────────────────

describe('novedades · marco de la plataforma y render del markdown', () => {
  it('la página respeta el tema persistido y trae el avatar que se le pasa', () => {
    const html = novedadesHtml({ md: CHANGELOG_FIXTURE, version: '0.31.0', avatar: '<details class="avm">YO</details>' })
    expect(html).toContain("localStorage.getItem('vergis:index-theme')")
    expect(html).toContain("document.documentElement.setAttribute('data-theme'")
    expect(html).toContain('<details class="avm">YO</details>')
  })

  it('no carga nada de una CDN', () => {
    const html = novedadesHtml({ md: CHANGELOG_FIXTURE, version: '0.31.0' })
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/)
  })

  it('los encabezados de la sección bajan un nivel (el `###` del documento es `<h3>` de la página)', () => {
    const html = novedadesHtml({ md: CHANGELOG_FIXTURE, version: '0.31.0' })
    expect(html).toContain('<h3>El nodo sirve el contenido estático de la instancia</h3>')
  })

  it('tablas, listas, negrita, código y enlaces se rinden sin dependencias', () => {
    expect(mdToHtml('| a | b |\n|--|--|\n| 1 | 2 |')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    )
    expect(mdToHtml('- uno\n- dos')).toBe('<ul><li>uno</li><li>dos</li></ul>')
    expect(mdToHtml('1. uno\n2. dos')).toBe('<ol><li>uno</li><li>dos</li></ol>')
    expect(inlineHtml('**fuerte** y `código`')).toBe('<strong>fuerte</strong> y <code>código</code>')
    expect(inlineHtml('[ver](docs/x.md)')).toBe('<a href="docs/x.md">ver</a>')
  })

  it('el markdown del changelog no puede inyectar HTML ni un esquema `javascript:`', () => {
    // REFUTARÍA: escapar DESPUÉS del marcado, o confiar en el destino de un enlace.
    expect(inlineHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;')
    const peligroso = inlineHtml('[clic](javascript:alert(1))')
    expect(peligroso).not.toContain('<a')
    expect(peligroso).not.toContain('javascript')
    expect(inlineHtml('`<b>x</b>`')).toBe('<code>&lt;b&gt;x&lt;/b&gt;</code>')
  })
})

// ── (6) EL ENLACE DESDE EL PIE ───────────────────────────────────────────────────────────────────

describe('novedades · el número de versión deja de ser un callejón sin salida', () => {
  it('el pie del catálogo enlaza la versión a `/novedades`', () => {
    // REFUTARÍA: un pie que solo dice «Powered by Vergis», que es lo que había.
    const html = indexHtml([{ code: 'QW-04', slug: 'qw-04', name: 'Asistencia' }], 'PIs')
    expect(VERGIS_VERSION, 'el repo tiene que declarar versión para que este test mida algo').toBeTruthy()
    expect(html).toContain(`<a href="/novedades">v${VERGIS_VERSION}</a>`)
  })
})

// ── (7) EL ROUTER ────────────────────────────────────────────────────────────────────────────────

const REPORT: Report = {
  code: 'QW-04', slug: 'qw-04', name: 'Asistencia', specName: 'Asistencia',
  specPath: '/a.yaml', proto: 'mira', tables: ['t'], databaseRefs: [],
}

function mkReq(url: string, method = 'GET', headers: Record<string, string> = {}): IncomingMessage {
  return { url, method, headers } as unknown as IncomingMessage
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

const conNovedades = (over: Partial<RouteDeps> = {}, md = CHANGELOG_FIXTURE): RouteDeps =>
  deps({ getNovedades: () => createNovedadesHandler({ leerChangelog: () => md, version: '0.30.0' }), ...over })

describe('routes · despacho de `/novedades` (#308)', () => {
  it('sirve la página con la versión que corre destacada', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(conNovedades())(mkReq('/novedades'), res)
    await done
    expect(calls.status).toBe(200)
    expect(calls.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(calls.body).toContain('id="0.30.0"')
    expect(calls.body).not.toContain('PLUMAS-SECRETAS')
  })

  it('el query se pela antes del match (`/novedades?x=1` sirve igual)', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(conNovedades())(mkReq('/novedades?x=1'), res)
    await done
    expect(calls.status).toBe(200)
  })

  it('responde ANTES del gate `ready`: «¿qué versión es ésta?» se pregunta justo cuando no arranca', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(conNovedades({ isReady: () => false, discover: () => [] }))(mkReq('/novedades'), res)
    await done
    expect(calls.status).toBe(200)
  })

  it('sin el token del gate NO se sirve: la autorización es la del resto del nodo, sin puerta nueva', async () => {
    // REFUTARÍA: interceptar `/novedades` antes del gate opt-in — una ruta que se salta el proxy.
    const { res, calls, done } = mkRes()
    createRequestHandler(conNovedades({ gateSecret: 's3cr3t' }))(mkReq('/novedades'), res)
    await done
    expect(calls.status).toBe(403)
  })

  it('con el token del gate sí', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(conNovedades({ gateSecret: 's3cr3t' }))(mkReq('/novedades', 'GET', { 'x-gate-token': 's3cr3t' }), res)
    await done
    expect(calls.status).toBe(200)
  })

  it('un método que muta es 405', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(conNovedades())(mkReq('/novedades', 'POST'), res)
    await done
    expect(calls.status).toBe(405)
  })

  it('sin el changelog embarcado responde 503 diciendo por qué, sin tumbar el resto', async () => {
    const { res, calls, done } = mkRes()
    const h = createNovedadesHandler({ leerChangelog: () => null, version: '0.30.0' })
    createRequestHandler(deps({ getNovedades: () => h }))(mkReq('/novedades'), res)
    await done
    expect(calls.status).toBe(503)
    expect(calls.body).toContain('no viajó en esta imagen')
  })

  it('sin la dep, la superficie es EXACTAMENTE la de antes: el 404 de siempre', async () => {
    const { res, calls, done } = mkRes()
    createRequestHandler(deps())(mkReq('/novedades'), res)
    await done
    expect(calls.status).toBe(404)
  })

  it('no le quita superficie a nadie: `/healthz` y un PI siguen respondiendo lo suyo', async () => {
    const h = mkRes()
    createRequestHandler(conNovedades())(mkReq('/healthz'), h.res)
    expect(JSON.parse(h.calls.body).engine).toBe('clickhouse')
    const pi = mkRes()
    createRequestHandler(conNovedades())(mkReq('/qw-04'), pi.res)
    await pi.done
    expect(pi.calls.body).toBe('<html>PI</html>')
  })
})
