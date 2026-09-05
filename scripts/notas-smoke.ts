/**
 * Smoke e2e LOCAL de la capa de notas (vergis#84) — servidor HTTP real, router real, handler real,
 * store SQLite real en disco. Recorre los 9 puntos del protocolo de validación del plan work/118.
 *
 * Lo que NO usa: ClickHouse. El protocolo original levanta el motor B para tener dato gobernado; acá
 * la RLS se representa con un retrieve que devuelve filas distintas por identidad, que es exactamente
 * lo que el gate del comentario consume. Lo que se ejercita de verdad es el camino HTTP completo:
 * rutas, CSRF, JSON, códigos de error, redirects y persistencia a disco.
 */
import { createServer } from 'node:http'
import { rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequestHandler } from '../server/routes'
import { createNotas } from '../server/notas'
import { csrfFactory } from '../server/ui'
import { SqliteNotasStore, renderHtmlPiece, type ResolvedNode } from '@vergis/capabilities'
import type { MiraSpec } from '@vergis/mira'

const DB = join(tmpdir(), `vergis-smoke-notas-${Date.now()}.sqlite`)
const SECRET = 'smoke-secret'
const csrf = csrfFactory(SECRET)

let fallos = 0
let pasos = 0
const ok = (cond: boolean, msg: string): void => {
  pasos += 1
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    fallos += 1
    console.log(`  ✗ ${msg}`)
  }
}

// ── El «dato gobernado»: ana ve la 4021; beto ve la 9999. ────────────────────────────────────────
const FILAS: Record<string, Record<string, unknown>[]> = {
  'ana@x.com': [{ rut: '4021', nombre: 'Ana', sueldo: 100 }],
  'beto@x.com': [{ rut: '9999', nombre: 'Beto', sueldo: 200 }],
}

const SPEC = {
  mira_version: '1.0',
  identity: { id: 'pi-16', display_name: 'Folios', classification: 'internal', version: '2.1' },
  data: {
    empleados: { capability: 'mock', anchor: { entity: 'dbo.dim_empleado', key: ['rut'], display: 'nombre' } },
    totales: { capability: 'mock' }, // sin anchor: el gesto no se ofrece
  },
  quality: {},
  delivery: {},
} as unknown as MiraSpec

const arbolDe = (user: string): ResolvedNode => ({
  type: 'table',
  dataset: 'empleados',
  interactive: true,
  columnsSpec: [
    { field: 'rut', label: 'RUT' },
    { field: 'nombre', label: 'Nombre' },
  ],
  rows: FILAS[user] ?? [],
  drills: [{ to: 'detalle', by: ['rut'] }],
  ancla: { dataset: 'empleados', entity: 'dbo.dim_empleado', key: ['rut'], comentarios: {} },
})

const REPORT = { code: 'PI-16', slug: 'pi-16', name: 'Folios', specName: 'Folios', specPath: '/dev/null', proto: 'mira', tables: [], databaseRefs: [] }
const userDe = (h: Record<string, unknown>): string => String(h['x-test-user'] ?? '')

const store = await SqliteNotasStore.open(DB)
const notas = createNotas({
  store,
  resolve: (slug) => (slug === 'pi-16' ? { code: 'PI-16', name: 'Folios', slug, spec: SPEC } : undefined),
  identityOf: (h) => ({ user: userDe(h as Record<string, unknown>) }),
  canOpenPi: async (_s, h) => !!userDe(h as Record<string, unknown>),
  retrieve: async (_s, dataset, _ctx, h) => (dataset === 'empleados' ? (FILAS[userDe(h as Record<string, unknown>)] ?? []) : []),
  congelar: async (slug, page, ctx, h) => ({
    piSlug: slug,
    piName: 'Folios',
    title: 'Folios',
    page,
    ctx,
    watermark: '2026-07-01T00:00:00.000Z',
    specVersion: '2.1·abc12345',
    autor: userDe(h as Record<string, unknown>),
    resolved: arbolDe(userDe(h as Record<string, unknown>)),
  }),
  renderCongelado: async (f) =>
    ((await renderHtmlPiece.execute({ piece: f.resolved, title: f.title }, { agent: 'smoke' })) as { html: string }).html,
  avatarFor: async () => '<div class="avm"></div>',
  audit: () => {},
  secret: SECRET,
  brandTitle: 'Vergis',
})

const handler = createRequestHandler({
  engine: 'clickhouse',
  gateSecret: '',
  isReady: () => true,
  getAdmin: () => null,
  getPiConfig: () => null,
  getNotas: () => notas,
  discover: () => [REPORT],
  identityFor: (h) => ({ agent: 'smoke', user: userDe(h as unknown as Record<string, unknown>) }),
  // El render del PI vivo: con la superficie de notas cableada (bandeja + marcadores).
  renderReport: async (_r, h) =>
    (
      (await renderHtmlPiece.execute(
        {
          piece: arbolDe(userDe(h as unknown as Record<string, unknown>)),
          title: 'Folios',
          notas: {
            imprimirUrl: '/pi-16/imprimir',
            notasUrl: '/pi-16/notas',
            comentariosUrl: '/pi-16/comentarios',
            impresionesUrl: '/impresiones',
            csrf: csrf(userDe(h as unknown as Record<string, unknown>)),
          },
        },
        { agent: 'smoke' },
      )) as { html: string }
    ).html,
  indexReports: async (all) => all,
  renderIndexPage: async () => '<html>índice</html>',
  canOpenPi: async () => true,
})

const server = createServer(handler)
await new Promise<void>((r) => server.listen(0, r))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

const call = async (
  method: string,
  path: string,
  user: string,
  body?: unknown,
  form?: string,
): Promise<{ status: number; text: string; json: Record<string, unknown> }> => {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      'x-test-user': user,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? JSON.stringify({ _csrf: csrf(user), ...(body as object) }) : form,
  })
  const text = await res.text()
  let j: Record<string, unknown> = {}
  try {
    j = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* HTML */
  }
  return { status: res.status, text, json: j }
}

console.log(`\n── Smoke e2e · capa de notas ──  (store: ${DB})\n`)

// 1 · GET /<slug> → la bandeja ofrece Anotar e Imprimir; no existe columna de anotaciones
{
  const r = await fetch(base + '/pi-16', { headers: { 'x-test-user': 'ana@x.com' } })
  const html = await r.text()
  console.log('1 · GET /pi-16 — la bandeja del PI')
  ok(r.status === 200, 'sirve 200')
  ok(html.includes('notas-imprimir') && html.includes('notas-anotar'), '«Imprimir» y «Anotar» viven en la bandeja')
  ok(html.indexOf('tray-panel-controles') < html.indexOf('vt-notas-kit'), 'están DENTRO del panel, no sueltos en el cuerpo')
  ok(!html.includes('vt-ann-cell') && !html.includes('__anntok'), 'no existe la columna editable ni el token por fila')
  ok(html.includes('data-nkey='), 'las filas llevan su llave de negocio')
}

// 2 · POST /<slug>/notas → impresión perezosa; repetir en <12h con la misma vista → MISMA impresión
console.log('\n2 · POST /pi-16/notas — materialización perezosa')
const n1 = await call('POST', '/pi-16/notas', 'ana@x.com', { contenido: 'no cuadra', objetivo: { tipo: 'fila', llave: { rut: '4021' } } })
const n2 = await call('POST', '/pi-16/notas', 'ana@x.com', { contenido: 'segunda', objetivo: { tipo: 'impresion' } })
ok(n1.status === 200 && n2.status === 200, 'ambas anotaciones se guardan')
ok(n1.json['impresionId'] === n2.json['impresionId'], 'la misma vista en la misma sesión ⇒ MISMA impresión')
const impLazy = String(n1.json['impresionId'])
ok((await store.getImpresion(impLazy))?.explicita === false, 'nació perezosa (explicita=0)')
ok((await store.notasDe(impLazy)).length === 2, 'cuelgan las dos notas')

// 3 · POST /<slug>/imprimir → impresión explícita aún sin notas
console.log('\n3 · POST /pi-16/imprimir — impresión explícita')
const imp = await call('POST', '/pi-16/imprimir', 'ana@x.com', {})
ok(imp.status === 200, 'responde 200')
const impId = String(imp.json['id'])
const impRow = await store.getImpresion(impId)
ok(impRow?.explicita === true, 'nació explícita')
ok((await store.notasDe(impId)).length === 0, 'existe sin notas')
ok(impRow?.watermark === '2026-07-01T00:00:00.000Z' && impRow?.specVersion === '2.1·abc12345', 'congela su procedencia')

// 4 · GET /impresiones → ambas aparecen en «mías»
console.log('\n4 · GET /impresiones — Mis impresiones')
{
  const r = await fetch(base + '/impresiones', { headers: { 'x-test-user': 'ana@x.com' } })
  const html = await r.text()
  ok(r.status === 200, 'sirve 200')
  ok(html.includes(impId) && html.includes(impLazy), 'las dos aparecen en «mías»')
  ok(html.includes('Compartidas conmigo'), 'la zona «compartidas conmigo» existe')
}

// 5 · compartir → el receptor la ve; revocar → 403
console.log('\n5 · Compartición gobernada')
{
  const sh = await call('POST', `/impresiones/${impId}/compartir`, 'ana@x.com', undefined, `_csrf=${csrf('ana@x.com')}&receptor=beto%40x.com`)
  ok(sh.status === 303, 'compartir redirige (303)')
  const vista = await fetch(base + `/impresiones/${impId}`, { headers: { 'x-test-user': 'beto@x.com' } })
  ok(vista.status === 200, 'el receptor abre la impresión')
  const lista = await (await fetch(base + '/impresiones', { headers: { 'x-test-user': 'beto@x.com' } })).text()
  ok(lista.includes(impId), 'aparece en «compartidas conmigo» del receptor')
  ok(!lista.includes(impLazy), 'lo NO compartido no aparece en la lista de nadie más')
  const nota = await call('POST', `/impresiones/${impId}/notas`, 'beto@x.com', { contenido: 'del receptor' })
  ok(nota.status === 200, 'el receptor puede anotar mientras tiene acceso')
  await call('POST', `/impresiones/${impId}/revocar`, 'ana@x.com', undefined, `_csrf=${csrf('ana@x.com')}&receptor=beto%40x.com`)
  const post = await fetch(base + `/impresiones/${impId}`, { headers: { 'x-test-user': 'beto@x.com' } })
  ok(post.status === 403, 'revocado ⇒ 403')
  ok((await store.notasDe(impId)).some((n) => n.contenido === 'del receptor'), 'sus notas ya escritas PERSISTEN')
}

// 6 · dataset con anchor: comentar visible → 200 + marcador; llave forjada → 403
console.log('\n6 · Comentario — el gate se verifica contra el dato')
{
  const okC = await call('POST', '/pi-16/comentarios', 'ana@x.com', { dataset: 'empleados', key: { rut: '4021' }, contenido: 'Contabilidad: OK' })
  ok(okC.status === 200, 'comentar un registro VISIBLE → 200')
  const forjada = await call('POST', '/pi-16/comentarios', 'beto@x.com', { dataset: 'empleados', key: { rut: '4021' }, contenido: 'no debería' })
  ok(forjada.status === 403, 'llave que la RLS del autor NO devuelve → 403')
  const leer = await call('GET', `/pi-16/comentarios?dataset=empleados&key=${encodeURIComponent(JSON.stringify({ rut: '4021' }))}`, 'beto@x.com')
  ok(leer.status === 403, 'leer el hilo de una llave no visible también es 403')
  const mio = await call('GET', `/pi-16/comentarios?dataset=empleados&key=${encodeURIComponent(JSON.stringify({ rut: '4021' }))}`, 'ana@x.com')
  ok(mio.status === 200 && JSON.stringify(mio.json).includes('Contabilidad: OK'), 'el autor sí lee su hilo')
  const csrfMalo = await fetch(base + '/pi-16/comentarios', {
    method: 'POST',
    headers: { 'x-test-user': 'ana@x.com', 'content-type': 'application/json' },
    body: JSON.stringify({ _csrf: 'forjado', dataset: 'empleados', key: { rut: '4021' }, contenido: 'x' }),
  })
  ok(csrfMalo.status === 403, 'CSRF forjado → 403')
}

// 7 · dataset sin anchor → el gesto no se ofrece (404)
console.log('\n7 · Fail-closed sin anchor')
{
  const r = await call('POST', '/pi-16/comentarios', 'ana@x.com', { dataset: 'totales', key: { rut: '4021' }, contenido: 'x' })
  ok(r.status === 404, 'dataset SIN anchor → 404 (la capacidad no existe ahí)')
}

// 8 · contenido_tipo=voz → 501
console.log('\n8 · La voz existe en el modelo, no en la función')
{
  const r = await call('POST', '/pi-16/notas', 'ana@x.com', { contenido: 'hablado', contenidoTipo: 'voz' })
  ok(r.status === 501, 'contenidoTipo=voz → 501')
}

// 9 · el esquema viejo ya no existe · el congelado es read-only · persistencia real
console.log('\n9 · Retiro del esquema viejo y forma del congelado')
{
  const viejo = await fetch(base + '/pi-16/annotations', { method: 'POST', headers: { 'x-test-user': 'ana@x.com' } })
  ok(viejo.status === 404, 'POST /pi-16/annotations → 404 (la ruta ya no existe)')
  const vista = await (await fetch(base + `/impresiones/${impId}`, { headers: { 'x-test-user': 'ana@x.com' } })).text()
  ok(vista.includes('Impresión de'), 'la vista trae el banner de procedencia')
  // Se mira el DATO servido, no el documento: el runtime de tabla menciona las clases de drill en
  // sus selectores (eso es código). Lo que importa es que ninguna fila lleve destino de navegación.
  const tbodyCong = /<tbody>([\s\S]*?)<\/tbody>/.exec(vista)?.[1] ?? ''
  const payloadCong = JSON.parse(
    (/<script type="application\/json" class="vtable-data">([\s\S]*?)<\/script>/.exec(vista)?.[1] ?? '{}').replace(/\\u003c/g, '<'),
  ) as { drills?: unknown[] }
  ok(!tbodyCong.includes('data-href'), 'ninguna fila del congelado lleva destino de drill')
  ok(!payloadCong.drills || payloadCong.drills.length === 0, 'el payload del congelado va sin drills (es documento, no vista)')
  ok(!vista.includes('notas-imprimir'), 'y sin la bandeja de notas viva')
  ok(existsSync(DB), 'el store persistió a disco')
  // Handle de INSPECCIÓN (`mode: 'read'`), no un segundo escritor: el store de arriba sigue vivo y
  // abierto. Con el default (`write`) este `open` arma su propio fencing y su `close` vuelca el
  // archivo, con lo que el handle original encuentra un inodo que no es el que dejó y aborta su
  // volcado — que es el fencing HACIENDO SU TRABAJO, no un defecto del store.
  const store2 = await SqliteNotasStore.open(DB, { mode: 'read' })
  ok((await store2.getImpresion(impId)) !== null, 'y se re-abre desde el archivo con sus datos')
  await store2.close()
}

server.close()
await store.close()
rmSync(DB, { force: true })
rmSync(`${DB}.tmp`, { force: true })

console.log(`\n── Resultado: ${pasos - fallos}/${pasos} verificaciones OK ──\n`)
process.exit(fallos ? 1 : 0)
