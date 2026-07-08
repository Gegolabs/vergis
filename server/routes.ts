/**
 * Router del servidor RLS — módulo del refactor createApp() (A14). `createRequestHandler(deps)` es el
 * RequestListener PURO: hace el dispatch (healthz · gate opt-in · admin · config-por-PI · gate ready ·
 * POST anotaciones · índice per-consumidor · PI) con todas sus dependencias INYECTADAS. Los getters
 * (`isReady`/`getAdmin`/`getPiConfig`) se leen en call-time → reflejan el estado mutable del server
 * (admin/piConfig se asignan durante el bootstrap async). Testeable con req/res fakes.
 */
import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http'
import type { GateHeaders, IdentityContext } from '@vergis/botler'
import { navFromUrl } from './nav'
import { fail } from './http-util'
import type { Report } from './discovery'
import type { AdminHandler } from './admin'
import type { PiConfigHandler } from './pi-config'

export interface RouteDeps {
  engine: string
  /** Secreto de gate opt-in (A10); vacío = sin chequeo. */
  gateSecret: string
  isReady: () => boolean
  getAdmin: () => AdminHandler | null
  getPiConfig: () => PiConfigHandler | null
  discover: () => Report[]
  identityFor: (headers: GateHeaders) => IdentityContext
  /** Render por-consumidor de un PI (con RLS). */
  renderReport: (report: Report, headers: GateHeaders, nav: ReturnType<typeof navFromUrl>) => Promise<string>
  /** Escritura de anotación (gateada por HMAC). Ya responde por `res`. */
  handleAnnotationWrite: (report: Report, req: IncomingMessage, res: ServerResponse) => Promise<void>
  /** PIs visibles para la identidad (ACL de artefacto si está encendida; si no, acceso a dato). */
  indexReports: (all: Report[], identity: IdentityContext) => Promise<Report[]>
  /** HTML de la página índice (título + avatar + gobierno por PI). */
  renderIndexPage: (visible: Report[], identity: IdentityContext) => Promise<string>
  /** Gate de ARTEFACTO por-PI: ¿la identidad puede abrir este PI? (la RLS de datos aplica igual). */
  canOpenPi: (report: Report, identity: IdentityContext) => Promise<boolean>
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createRequestHandler(deps: RouteDeps): RequestListener {
  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    if (url === '/healthz') {
      const ok = deps.isReady()
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok, engine: deps.engine }))
      return
    }
    // A10 · gate opt-in: sin el token del proxy no se sirve nada (salvo el healthz de arriba).
    if (deps.gateSecret && req.headers['x-gate-token'] !== deps.gateSecret) {
      return fail(res, 403, 'Acceso denegado: falta el token del gate (el request no pasó por el proxy).')
    }
    // ADMINISTRACIÓN — gateada por rol DENTRO del handler. Va antes del gate `ready` (no sirve dato gobernado).
    const admin = deps.getAdmin()
    if (admin && (url === '/admin' || url.startsWith('/admin/'))) {
      admin.tryHandle(req, res).catch((e) => fail(res, 500, `Error en Administración: ${errMsg(e)}`))
      return
    }
    // Configuración por-PI — gateada por rol de PI dentro del handler.
    const piConfig = deps.getPiConfig()
    if (piConfig && /^\/[^/]+\/config(?:\/|$)/.test(url)) {
      piConfig
        .tryHandle(req, res)
        .then((handled) => {
          if (!handled) fail(res, 404, 'Ruta no encontrada')
        })
        .catch((e) => fail(res, 500, `Error en configuración del PI: ${errMsg(e)}`))
      return
    }
    if (!deps.isReady()) return fail(res, 503, 'Inicializando…')
    const all = deps.discover()
    // POST /<slug>/annotations — escritura de anotación (único surface mutable; gateado por HMAC).
    if (req.method === 'POST') {
      const m = url.match(/^\/([^/]+)\/annotations\/?$/)
      const report = m && all.find((r) => r.slug === m[1].toLowerCase())
      if (!report) return fail(res, 404, 'Ruta no encontrada')
      deps.handleAnnotationWrite(report, req, res).catch((e) => fail(res, 500, `Error al guardar anotación: ${errMsg(e)}`))
      return
    }
    const identity = deps.identityFor(req.headers as GateHeaders)
    const sendHtml = (html: string): void => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    }
    // Índice PER-CONSUMIDOR.
    if (url === '/' || url === '') {
      deps
        .indexReports(all, identity)
        .then(async (visible) => {
          if (visible.length === 1) {
            return deps.renderReport(visible[0], req.headers as GateHeaders, navFromUrl(req.url ?? '/')).then(sendHtml)
          }
          sendHtml(await deps.renderIndexPage(visible, identity))
        })
        .catch((e) => fail(res, 500, errMsg(e)))
      return
    }
    const slug = url.replace(/^\//, '').replace(/\/$/, '').toLowerCase()
    const report = all.find((r) => r.slug === slug)
    if (!report) return fail(res, 404, `Producto de Información no encontrado. <a href="/">Ver disponibles</a>`)
    // Gate de ARTEFACTO (si ACL encendida). La RLS de datos aplica igual al render.
    deps
      .canOpenPi(report, identity)
      .then((allowed) => {
        if (!allowed) return fail(res, 403, `No tienes acceso a este Producto de Información. <a href="/">Ver disponibles</a>`)
        return deps.renderReport(report, req.headers as GateHeaders, navFromUrl(req.url ?? '/')).then(sendHtml)
      })
      .catch((e) => fail(res, 500, `Error al render por-consumidor: ${errMsg(e)}`))
  }
}
