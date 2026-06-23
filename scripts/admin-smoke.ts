/**
 * Arnés de humo LOCAL del área de gestión (no es producción ni CI). Levanta el surface REAL —
 * Administración (data maestra + roles + grupos + mapa de fuentes) y configuración por-PI — con stores
 * SQLite embebidos sobre http, para ejercitar A+B end-to-end por sockets (curl). El store Fabric, el
 * gate de ACL del server y la observabilidad/reconciliador (Fabric) se validan aparte (gated).
 *
 * Uso:  VERGIS_MASTER_DATA=<entidades.yaml> VERGIS_ADMIN_SEED=cesar@x.com npx tsx scripts/admin-smoke.ts
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { AppendOnlyLog, identityFromHeaders } from '@vergis/botler'
import {
  parseMasterDataConfig,
  SqliteMasterDataStore,
  SqliteGovernanceStore,
  deriveIngestionMap,
  type PiRole,
} from '@vergis/capabilities'
import { createAdmin } from '../server/admin'
import { createPiConfig } from '../server/pi-config'

const PORT = Number(process.env['PORT'] ?? 7799)
const OUT = mkdtempSync(join(tmpdir(), 'admin-smoke-'))
const entities = parseMasterDataConfig(parseYaml(readFileSync(process.env['VERGIS_MASTER_DATA']!, 'utf8')))
const adminSeed = (process.env['VERGIS_ADMIN_SEED'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)

// Registro de PIs simulado (sin specs reales): PI-01 lee fact_saldos (fuente SAP, oferta horaria).
const PIS = [{ code: 'PI-01', name: 'Cartera', slug: 'pi-01', tables: ['dbo.fact_saldos'] }]

const gov = await SqliteGovernanceStore.open(join(OUT, 'governance.sqlite'), {
  admins: adminSeed,
  groups: [{ id: 'analistas_arbol', label: 'Analistas ARBOL', members: ['ana@ratio.cl'] }],
  sources: [
    { id: 'buk', label: 'Buk RRHH', oferta: 'P1D' },
    { id: 'sap', label: 'SAP B1', oferta: 'PT1H' },
  ],
  tableSources: [{ tableRef: 'dbo.fact_saldos', sourceId: 'sap' }],
  processes: [{ id: 'pipe_saldos', label: 'Pipeline saldos', sourceId: 'sap' }],
  processOutputs: [{ processId: 'pipe_saldos', tableRef: 'dbo.fact_saldos' }],
})
await gov.bootstrapPi('PI-01', 'felipe@gh.cl', ['analistas_arbol'])
await gov.setDemanda('PI-01', 'PT6H', 'felipe@gh.cl')

const mdStore = await SqliteMasterDataStore.open(join(OUT, 'master-data.sqlite'), entities)
const auditLog = new AppendOnlyLog(join(OUT, 'admin-audit.log'))
const roleOf = async (code: string, email: string | undefined): Promise<PiRole | null> =>
  (await gov.isAdmin(email)) ? 'owner' : gov.roleFor(code, email)

const admin = createAdmin({
  entities,
  mdStore,
  adminStore: gov,
  groupStore: gov,
  ingestionMap: async () =>
    deriveIngestionMap({
      sources: (await gov.listSources()).map((s) => ({ id: s.id, oferta: s.oferta })),
      processes: await gov.listProcesses(),
      processOutputs: await gov.listProcessOutputs(),
      piTables: PIS.map((p) => ({ piCode: p.code, tables: p.tables })),
      piDemandas: (await Promise.all(PIS.map(async (p) => ({ piCode: p.code, d: await gov.getDemanda(p.code) })))).flatMap((x) => (x.d ? [{ piCode: x.piCode, maxAge: x.d.maxAge }] : [])),
    }),
  identityOf: (h) => identityFromHeaders(h),
  audit: (e) => auditLog.append(e),
  secret: 'smoke-secret',
  brandTitle: 'Vergis @ Grupo Hijuelas',
})

const piConfig = createPiConfig({
  gov,
  resolve: (slug) => PIS.find((p) => p.slug === slug),
  identityOf: (h) => identityFromHeaders(h),
  roleOf,
  ceilingFor: async (code) => {
    const pi = PIS.find((p) => p.code === code)
    return pi ? gov.ofertasForTables(pi.tables) : []
  },
  audit: (e) => auditLog.append(e),
  secret: 'smoke-secret',
  brandTitle: 'Vergis @ Grupo Hijuelas',
})

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  const route = url === '/admin' || url.startsWith('/admin/') ? admin : /^\/[^/]+\/config(?:\/|$)/.test(url) ? piConfig : null
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('fuera de gestión')
    return
  }
  route
    .tryHandle(req, res)
    .then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end('no')
      }
    })
    .catch((e) => {
      res.writeHead(500)
      res.end(String(e))
    })
})
server.listen(PORT, () => console.log(`[admin-smoke] :${PORT} · OUT=${OUT} · A+B`))
