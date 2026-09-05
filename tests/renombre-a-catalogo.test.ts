import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createPiConfig, type PiConfigHandler } from '../server/pi-config'
import { createDiscovery, type Discovery } from '../server/discovery'
import { createProtoRegistry } from '../server/proto-registry'
import { miraProtoBotlet } from '@vergis/mira'
import { SqliteGovernanceStore, type PiRole } from '@vergis/capabilities'
import type { PolicyDecl } from '@vergis/policy'

/**
 * EL ESLABÓN COMPLETO DE #207: POST en la consola → `refreshDisplayNames()` → catálogo servido.
 *
 * Lo que ya estaba medido: que el override no se congela en el memo del escáner
 * (`pi-display-name.test.ts`) y que sobrevive al reinicio porque el store es SQLite en disco. Lo que
 * NO estaba medido era **la cadena**, y solo estaba cubierta por lectura del código.
 *
 * No es celo: es exactamente la clase de eslabón donde el frente vecino (#139) encontró un fallo
 * real —la observación del boot corría antes del registro de los watches—. Un eslabón entre dos
 * piezas correctas puede estar desconectado, y ningún test de las dos piezas lo nota.
 *
 * Este archivo compone las piezas REALES: el handler de `pi-config`, un `SqliteGovernanceStore` **en
 * disco** y el `createDiscovery` de verdad, atados por la MISMA clausura que `serve-rls.ts` publica
 * en `refreshDisplayNames` (`serve-rls.ts:1211`) y cablea en `onDisplayNameChange` (`:1943`).
 *
 * Lo que este archivo NO cubre, y va dicho para que nadie lea de más: la línea literal del cableado
 * dentro de `serve-rls.ts`. Ese monolito no se instancia sin su entorno; acá se reproduce su clausura
 * y se mide todo lo demás de la cadena. Si alguien desconecta esa línea, lo que se cae es el arnés de
 * `scripts/serve-rls-proof.ts`, no éste.
 */

const SECRET = 'renombre-secret'
const SPEC = [
  'identity: { code: PI-01, display_name: "Cartera" }',
  'data:',
  '  d1: { capability: execute-sql-ch, params: { sql: "SELECT 1 FROM qw04.areas" } }',
  'piece: { layout: rows, elements: [] }',
  'delivery: { render: [{ format: html, target: web }] }',
].join('\n')

function mockReq(method: string, url: string, user: string, body = ''): IncomingMessage {
  const r = Readable.from([body]) as unknown as IncomingMessage & { url: string; method: string; headers: Record<string, string> }
  r.url = url
  r.method = method
  r.headers = { 'x-test-user': user }
  return r
}
function mockRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, h?: Record<string, string>) {
      this.statusCode = code
      Object.assign(this.headers, h ?? {})
      return this
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk
    },
  }
}

describe('#207 · renombrar en la consola llega al catálogo servido', () => {
  let dir: string
  let file: string
  let gov: SqliteGovernanceStore
  let h: PiConfigHandler
  let discovery: Discovery
  /** El mapa vivo que `serve-rls.ts` consulta en cada `discover()`. */
  let overrides: Map<string, string>
  let refrescos: number

  /** La MISMA clausura de `serve-rls.ts:1211`, con su fail-safe. */
  const refreshDisplayNames = async (): Promise<void> => {
    refrescos += 1
    const rows = await gov.listDisplayNames()
    overrides.clear()
    for (const [code, name] of Object.entries(rows)) overrides.set(code, String(name))
  }

  /** Arma el catálogo tal como lo arma el server, apuntando al mapa vivo. */
  function armarDiscovery(cableado: boolean): void {
    discovery = createDiscovery({
      engine: 'clickhouse',
      store: new Map<string, PolicyDecl>([['qw04.areas', { public: true }]]),
      servingCaps: new Set(['execute-sql-ch']),
      protos: createProtoRegistry([miraProtoBotlet]),
      specPaths: () => ['/pi01.yaml'],
      readSpec: () => SPEC,
      displayNameOverride: cableado ? (code) => overrides.get(code) : undefined,
      log: () => {},
    })
  }

  async function abrirConsola(cableado = true): Promise<void> {
    gov = await SqliteGovernanceStore.open(file)
    await gov.bootstrapPi('PI-01', 'felipe@gh.cl', [])
    overrides = new Map()
    refrescos = 0
    // El server SIEMBRA el mapa al arrancar (`serve-rls.ts:1222`), para que el catálogo NAZCA con los
    // renombres aplicados sin esperar al primer POST. Si esa siembra faltara, un nodo recién
    // arrancado serviría el nombre del spec hasta que alguien renombrara algo.
    await refreshDisplayNames()
    armarDiscovery(cableado)
    h = createPiConfig({
      gov,
      resolve: (slug) => (slug === 'pi-01' ? { code: 'PI-01', name: 'Cartera' } : undefined),
      identityOf: (hd) => ({ user: (hd as Record<string, string>)['x-test-user'] }),
      roleOf: async (code: string, email: string | undefined): Promise<PiRole | null> =>
        (await gov.isAdmin(email)) ? 'owner' : gov.roleFor(code, email),
      audit: () => {},
      secret: SECRET,
      onDisplayNameChange: () => void refreshDisplayNames(),
    })
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'renombre-'))
    file = join(dir, 'governance.sqlite')
    await abrirConsola()
  })
  afterEach(async () => {
    await gov.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const go = async (req: IncomingMessage) => {
    const res = mockRes()
    const handled = await h.tryHandle(req, res as unknown as ServerResponse)
    return { handled, res }
  }
  const tok = async () => (await go(mockReq('GET', '/pi-01/config', 'felipe@gh.cl'))).res.body.match(/name="_csrf" value="([0-9a-f]+)"/)![1]
  const nombreServido = () => discovery.discover().find((r) => r.code === 'PI-01')?.name

  const renombrar = async (a: string) => {
    const t = await tok()
    const { res } = await go(mockReq('POST', '/pi-01/config/nombre', 'felipe@gh.cl', `_csrf=${t}&display_name=${encodeURIComponent(a)}`))
    return res.statusCode
  }

  it('el catálogo sirve el nombre del spec antes de tocar nada', () => {
    expect(nombreServido()).toBe('Cartera')
  })

  it('POST → el catálogo sirve el nombre nuevo, sin reiniciar ni invalidar el escáner', async () => {
    expect(await renombrar('Cartera Comercial')).toBe(303)
    expect(nombreServido()).toBe('Cartera Comercial')
    expect(refrescos).toBeGreaterThan(1) // el POST disparó el refresco, no solo la siembra del arranque
  })

  it('la RUTA no se mueve al renombrar — es identidad, no presentación', async () => {
    await renombrar('Cartera Comercial')
    expect(discovery.discover().find((r) => r.code === 'PI-01')?.slug).toBe('pi-01')
  })

  it('«restaurar» devuelve el catálogo al nombre del spec', async () => {
    await renombrar('Cartera Comercial')
    const t = await tok()
    await go(mockReq('POST', '/pi-01/config/nombre', 'felipe@gh.cl', `_csrf=${t}&restaurar=1`))
    expect(nombreServido()).toBe('Cartera')
  })

  it('el renombre sobrevive al reinicio del nodo, y el catálogo NACE con él', async () => {
    await renombrar('Cartera Comercial')
    await gov.close()
    // Reinicio real: store nuevo desde el MISMO archivo, mapa vacío, catálogo nuevo.
    await abrirConsola()
    expect(refrescos).toBe(1) // solo la siembra del arranque: nadie ha renombrado en esta vida
    expect(nombreServido()).toBe('Cartera Comercial')
  })

  it('CONTROL NEGATIVO · sin el override cableado, el catálogo sigue sirviendo el nombre viejo', async () => {
    armarDiscovery(false) // el eslabón desconectado: las dos piezas correctas, la cadena rota
    await renombrar('Cartera Comercial')
    expect(await gov.listDisplayNames()).toEqual({ 'PI-01': 'Cartera Comercial' }) // el store SÍ guardó
    expect(nombreServido()).toBe('Cartera') // y el catálogo no se enteró
  })
})
