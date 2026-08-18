/**
 * Router del servidor RLS — módulo del refactor createApp() (A14). `createRequestHandler(deps)` es el
 * RequestListener PURO: hace el dispatch (healthz · gate opt-in · admin · config-por-PI · gate ready ·
 * capa de notas · índice per-consumidor · PI) con todas sus dependencias INYECTADAS. Los getters
 * (`isReady`/`getAdmin`/`getPiConfig`) se leen en call-time → reflejan el estado mutable del server
 * (admin/piConfig se asignan durante el bootstrap async). Testeable con req/res fakes.
 */
import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http'
import type { GateHeaders, IdentityContext } from '@vergis/botler'
import { navFromUrl } from './nav'
import { fail, constantTimeEqual, headerValue } from './http-util'
import { contentDisposition, PdfUnavailableError } from './pdf'
import type { Report } from './discovery'
import type { AdminHandler } from './admin'
import type { PiConfigHandler } from './pi-config'
import type { MirandaHandler } from './miranda'
import type { NotasHandler } from './notas'

export interface RouteDeps {
  engine: string
  /** Secreto de gate opt-in (A10); vacío = sin chequeo. */
  gateSecret: string
  isReady: () => boolean
  getAdmin: () => AdminHandler | null
  /** CONTRATO OPERATIVO (`/contrato`, issue #139) — handler o null. Ausente ⇒ la ruta ni se intercepta
   *  (cae al slug-lookup → 404 de siempre): la superficie sin la dep es idéntica a la de antes. */
  getContract?: () => ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) | null
  getPiConfig: () => PiConfigHandler | null
  /** Handler de Miranda (cluster 077) o null si el flag `MIRANDA_ENABLED` está apagado (default).
   * null ⇒ `/miranda*` cae al 404 normal: con el flag apagado la superficie es idéntica a hoy. */
  getMiranda?: () => MirandaHandler | null
  /** Handler de la CAPA DE NOTAS (impresiones, anotaciones, comentarios, compartición) o null si el
   *  store no abrió: sin él, sus rutas caen al 404 normal y el resto del serving sigue intacto. */
  getNotas?: () => NotasHandler | null
  discover: () => Report[]
  identityFor: (headers: GateHeaders) => IdentityContext
  /** Render por-consumidor de un PI (con RLS). */
  renderReport: (report: Report, headers: GateHeaders, nav: ReturnType<typeof navFromUrl>) => Promise<string>
  /**
   * «Descargar PDF» server-side (issue #65): el MISMO render por-consumidor, en modo print, pasado al
   * sidecar de conversión. AUSENTE = la feature está apagada (sin `VERGIS_PDF_SERVICE_URL`) y la ruta
   * `/<slug>/pdf` NI SIQUIERA se intercepta: cae al slug-lookup y responde el 404 de siempre. La
   * superficie sin la env es idéntica a la de antes del issue.
   */
  renderPdf?: (report: Report, headers: GateHeaders, nav: ReturnType<typeof navFromUrl>) => Promise<{ pdf: Uint8Array; filename: string }>
  /** PIs visibles para la identidad (ACL de artefacto si está encendida; si no, acceso a dato). */
  indexReports: (all: Report[], identity: IdentityContext) => Promise<Report[]>
  /** HTML de la página índice (título + avatar + gobierno por PI). */
  renderIndexPage: (visible: Report[], identity: IdentityContext) => Promise<string>
  /** Gate de ARTEFACTO por-PI: ¿la identidad puede abrir este PI? (la RLS de datos aplica igual). */
  canOpenPi: (report: Report, identity: IdentityContext) => Promise<boolean>
  /** Servibilidad POR PI (issue #52): motivo por el que este PI NO se sirve, o null si sirve. Un PI
   * bloqueado responde 503 con su motivo; los demás siguen sirviendo. Ausente = solo el gate global. */
  piBlocked?: (report: Report) => string | null
  /** Conteo para /healthz (sin slugs ni mensajes — healthz corre sin gate y se mantiene reducido).
   * null = el motor no distingue servibilidad por PI (clickhouse). */
  healthSummary?: () => { total: number; serving: number } | null
  /**
   * PLANO DE CONTROL del nodo. Un nodo sin control **sirve lecturas** y no escribe nada: sus lazos de
   * fondo están desarmados y sus mutaciones se rechazan con 409 nombrando al activo.
   *
   * AUSENTE ⇒ el nodo siempre controla, que es la superficie de antes de que el plano existiera: fase
   * `serving` y mutaciones aceptadas. Así un despliegue de un solo nodo y todo test previo se comportan
   * exactamente igual.
   */
  control?: {
    hasControl: () => boolean
    /** Quién es el activo, para el mensaje del 409 (titular observado + época). */
    activeHolder: () => string
  }
}

/** Métodos que no mutan: los únicos que un nodo sin control puede atender en superficie de gestión. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createRequestHandler(deps: RouteDeps): RequestListener {
  /** ¿Este nodo tiene el plano de control? Sin la dep, sí — la superficie de un nodo suelto no cambia. */
  const hasControl = (): boolean => deps.control?.hasControl() ?? true
  /**
   * Gate de MUTACIÓN de las superficies de gestión (administración, config por-PI, notas, Miranda,
   * intake). Un nodo en standby no escribe: aceptar la mutación sería volcar su snapshot rancio encima
   * de lo que el activo lleva escrito. El 409 **nombra al activo** para que quien lo recibe sepa dónde
   * sí se puede escribir, en vez de leer «conflicto» y no saber con qué.
   */
  const mutacionSinControl = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (SAFE_METHODS.has((req.method ?? 'GET').toUpperCase()) || hasControl()) return false
    fail(
      res,
      409,
      `Este nodo está en espera (standby): no tiene el plano de control y por eso no escribe. ` +
        `El nodo activo es ${deps.control?.activeHolder() ?? 'otro nodo'}. Reintenta contra el activo.`,
    )
    return true
  }
  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    if (url === '/healthz') {
      // Distingue ARRANCANDO (nada evaluado aún → 503) de N-de-M DEGRADADOS (el proceso está sano y
      // sirve el resto → 200, ok:false) de EN ESPERA (standby: sano, sirve lecturas, no controla).
      // Solo CONTEOS: healthz corre sin gate y se mantiene reducido (sin slugs ni mensajes de error).
      //
      // `standby` es HTTP 200 y NO relaja `serving`: el predicado del conmutador y del poller de cortes
      // es `HTTP 200 ∧ phase=serving ∧ pis.serving=N`, y un standby **no debe** satisfacerlo — rutear
      // tráfico de escritura a un nodo que responde 409 sería peor que no rutear nada. Precedencia:
      // `starting` (nada evaluado) → `standby` (no controla) → `degraded` → `serving`. Un standby con
      // PIs degradados sigue delatando su degradación en `ok:false` y en los conteos de `pis`.
      const ready = deps.isReady()
      const pis = deps.healthSummary?.() ?? null
      const degraded = pis ? pis.total - pis.serving : 0
      const phase = !ready ? 'starting' : !hasControl() ? 'standby' : degraded ? 'degraded' : 'serving'
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: ready && degraded === 0, engine: deps.engine, phase, ...(pis ? { pis } : {}) }))
      return
    }
    // A10 · gate opt-in: sin el token del proxy no se sirve nada (salvo el healthz de arriba).
    // Comparación en tiempo constante (D6 del diseño 004/10): `!==` corta en el primer byte
    // distinto y filtra por temporización cuántos caracteres del token acertó quien prueba.
    // El CSRF de `ui.ts` ya usaba `constantTimeEqual`; este gate era la asimetría que quedaba.
    // `?? ''` porque el header puede venir ausente o repetido (array): ambos casos son «no acertó».
    if (deps.gateSecret && !constantTimeEqual(headerValue(req.headers['x-gate-token']), deps.gateSecret)) {
      return fail(res, 403, 'Acceso denegado: falta el token del gate (el request no pasó por el proxy).')
    }
    // CONTRATO OPERATIVO (`/contrato`, issue #139) — gateado por rol DENTRO del handler. Va DESPUÉS
    // del token del gate y ANTES del gate `ready`: el contrato debe poder responder aunque el motor no
    // haya verificado — «¿por qué no arranca?» es justo la pregunta que se le hace a un nodo no-listo.
    const contract = deps.getContract?.() ?? null
    if (contract && url === '/contrato') {
      contract(req, res).catch((e) => fail(res, 500, `Error en el contrato operativo: ${errMsg(e)}`))
      return
    }
    // ADMINISTRACIÓN — gateada por rol DENTRO del handler. Va antes del gate `ready` (no sirve dato gobernado).
    const admin = deps.getAdmin()
    if (admin && (url === '/admin' || url.startsWith('/admin/'))) {
      // La administración es la superficie de escritura gobernada (incluida la ingesta de archivos):
      // sin control, su mutación se rechaza ANTES de que el handler toque el store.
      if (mutacionSinControl(req, res)) return
      admin.tryHandle(req, res).catch((e) => fail(res, 500, `Error en Administración: ${errMsg(e)}`))
      return
    }
    // Configuración por-PI — gateada por rol de PI dentro del handler.
    const piConfig = deps.getPiConfig()
    if (piConfig && /^\/[^/]+\/config(?:\/|$)/.test(url)) {
      if (mutacionSinControl(req, res)) return
      piConfig
        .tryHandle(req, res)
        .then((handled) => {
          if (!handled) fail(res, 404, 'Ruta no encontrada')
        })
        .catch((e) => fail(res, 500, `Error en configuración del PI: ${errMsg(e)}`))
      return
    }
    // MIRANDA (cluster 077) — gateada por scope DENTRO del handler. Va antes del gate `ready` (es una
    // superficie de gestión; la preview de un draft sí sirve dato gobernado, pero por serve-rls). Con el
    // flag apagado `getMiranda` es undefined/null → `/miranda*` cae al slug-lookup normal → 404 de hoy.
    const miranda = deps.getMiranda?.() ?? null
    if (miranda && (url === '/miranda' || url.startsWith('/miranda/'))) {
      if (mutacionSinControl(req, res)) return
      miranda
        .tryHandle(req, res)
        .then((handled) => {
          if (!handled) fail(res, 404, 'Ruta no encontrada')
        })
        .catch((e) => fail(res, 500, `Error en Miranda: ${errMsg(e)}`))
      return
    }
    // CAPA DE NOTAS — `/impresiones*` y `/<slug>/{imprimir,notas,comentarios}`. Va DESPUÉS del gate
    // `ready` (abajo) no: va acá arriba porque `/impresiones` no sirve dato gobernado — lo que sirve
    // es dato YA congelado bajo la RLS de quien imprimió. Las rutas por-PI sí resuelven el PI dentro
    // del handler (que aplica su propio gate de artefacto).
    const notas = deps.getNotas?.() ?? null
    if (notas && (url === '/impresiones' || url.startsWith('/impresiones/'))) {
      if (mutacionSinControl(req, res)) return
      notas
        .tryHandle(req, res)
        .then((handled) => {
          if (!handled) fail(res, 404, 'Ruta no encontrada')
        })
        .catch((e) => fail(res, 500, `Error en la capa de notas: ${errMsg(e)}`))
      return
    }
    // Gate GLOBAL solo para el ARRANQUE EN FRÍO (nada evaluado aún). Después, la servibilidad es
    // por-PI (`piBlocked`): un PI degradado responde 503 con motivo y los demás siguen (issue #52).
    if (!deps.isReady()) return fail(res, 503, 'Inicializando…')
    const all = deps.discover()
    const blockedReason = (report: Report): string | null => deps.piBlocked?.(report) ?? null
    // Rutas de notas ATADAS A UN PI: necesitan el PI descubierto (por eso van tras el gate `ready`).
    if (notas && /^\/[^/]+\/(imprimir|notas|comentarios)$/.test(url)) {
      if (mutacionSinControl(req, res)) return
      notas
        .tryHandle(req, res)
        .then((handled) => {
          if (!handled) fail(res, 404, 'Ruta no encontrada')
        })
        .catch((e) => fail(res, 500, `Error en la capa de notas: ${errMsg(e)}`))
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
    // DESCARGA PDF (#65 · D7) — `/<slug>/pdf` con EXACTAMENTE los gates de la página del PI: mismo
    // token de gate (arriba), mismo `ready`, mismo `piBlocked`, mismo `canOpenPi`, misma identidad al
    // render. Sin `renderPdf` inyectado el match NO intercepta (la URL sigue al slug-lookup → 404).
    // Sin CSRF: es un GET de descarga, no muta estado.
    const pdfMatch = url.match(/^\/([^/]+)\/pdf$/)
    if (pdfMatch && deps.renderPdf) {
      const renderPdf = deps.renderPdf
      const pdfReport = all.find((r) => r.slug === pdfMatch[1].toLowerCase())
      if (!pdfReport) return fail(res, 404, `Producto de Información no encontrado. <a href="/">Ver disponibles</a>`)
      const pdfBlocked = blockedReason(pdfReport)
      if (pdfBlocked) return fail(res, 503, `Producto de Información no disponible: ${pdfBlocked}`)
      deps
        .canOpenPi(pdfReport, identity)
        .then(async (allowed) => {
          if (!allowed) return fail(res, 403, `No tienes acceso a este Producto de Información. <a href="/">Ver disponibles</a>`)
          const { pdf, filename } = await renderPdf(pdfReport, req.headers as GateHeaders, navFromUrl(req.url ?? '/'))
          res.writeHead(200, {
            'content-type': 'application/pdf',
            'content-disposition': contentDisposition(filename),
            'cache-control': 'no-store',
          })
          res.end(Buffer.from(pdf))
        })
        .catch((e) => {
          // El detalle técnico (URL interna del sidecar, status, causa) va al LOG, nunca al cuerpo.
          if (e instanceof PdfUnavailableError) {
            console.error(`[vergis-rls] PDF no disponible (${pdfReport.slug}): ${e.detail}`)
            return fail(
              res,
              503,
              'La generación de PDF no está disponible en este momento (el servicio de conversión no respondió). Intenta de nuevo o usa Imprimir.',
            )
          }
          fail(res, 500, `Error al generar el PDF: ${errMsg(e)}`)
        })
      return
    }
    const slug = url.replace(/^\//, '').replace(/\/$/, '').toLowerCase()
    const report = all.find((r) => r.slug === slug)
    if (!report) return fail(res, 404, `Producto de Información no encontrado. <a href="/">Ver disponibles</a>`)
    const blocked = blockedReason(report)
    if (blocked) return fail(res, 503, `Producto de Información no disponible: ${blocked}`)
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
