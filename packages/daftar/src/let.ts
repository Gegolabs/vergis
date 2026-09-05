/**
 * EL LET: el evaluador. Una instancia hospeda uno, y `atenderDaftar` es todo lo que hace — la
 * superficie de §3.5 del brief H3, relativa a `/<slug>`.
 *
 * Tres reglas que no se negocian, y que el nodo NO puede hacer por él:
 *
 *  1. **El estudiante es el login.** Sale del claim `student` de la identidad que el nodo resolvió.
 *     Sin claim no hay estudiante por defecto: es 403. `?s=` sobrevive SOLO para el admin de Daftar
 *     (`student: ["*"]`), que es el único con derecho a mirar el catálogo de otro.
 *  2. **Sin control no se escribe.** El 409 lo emite el Let, no el router, porque solo el Let sabe
 *     cuáles de sus rutas escriben (`POST` de progreso, revisión y reset).
 *  3. **Los instrumentos son archivos; los intentos, store.** Lo primero se relee en caliente; lo
 *     segundo vive en `evaluaciones` (D-75). Sin store abierto el catálogo sigue sirviendo y solo las
 *     rutas de progreso responden 503 con motivo — una guía se puede leer sin poder guardarla.
 */
import type { LetInvocation, LetResponse } from '@vergis/botler'
import type { SqliteEvaluacionesStore } from '@vergis/capabilities'
import { exportarProgreso, progresoAIntento, sha256De, totalItemsDe, totalSeccionesDe } from '@vergis/capabilities'
import type { DaftarSpec } from './spec'
import type { Instrumentos, GuiaMeta } from './instrumentos'
import { idSeguro } from './instrumentos'
import { renderShell } from './assets'
import { renderReport } from './report'
import { renderPrint } from './print'
import type { Progreso } from './tipos'

export type DaftarStore = SqliteEvaluacionesStore

export interface DaftarDeps {
  instrumentos: Instrumentos
  /** El store `evaluaciones`, o `null` si el nodo no lo abrió. Getter: el relevo lo puede reabrir. */
  store: () => DaftarStore | null
  /** Reloj inyectable (los tests fijan el instante). */
  ahora?: () => string
  log?: (msg: string) => void
}

const JSON_H = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const HTML_H = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }

const json = (status: number, body: unknown): LetResponse => ({ status, headers: JSON_H, body: JSON.stringify(body) })
const html = (status: number, body: string): LetResponse => ({ status, headers: HTML_H, body })

/** El MISMO texto que el router emite para las superficies de gestión: un 409 es un 409. */
const textoStandby = (activeHolder: string): string =>
  `Este nodo está en espera (standby): no tiene el plano de control y por eso no escribe. ` +
  `El nodo activo es ${activeHolder}. Reintenta contra el activo.`

/** Página de 403 que dice A QUIÉN pedirle acceso, nombrando el email que entró. Sin ella, un
 *  estudiante sin claim ve un 403 mudo y no tiene forma de saber qué le falta. */
function paginaSinAcceso(email: string | undefined, motivo: string): LetResponse {
  const quien = email ? `<code>${escapeMin(email)}</code>` : 'tu sesión (el gate no entregó un email)'
  return html(
    403,
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Daftar — sin acceso</title>` +
      `<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5;color:#333}` +
      `.card{background:#fff;padding:2.5rem;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center;max-width:460px}` +
      `h1{margin:0 0 .5rem;font-size:1.8rem}p{color:#666;line-height:1.6}code{background:#f0f0f0;padding:.2rem .5rem;border-radius:4px;font-size:.9rem}</style>` +
      `</head><body><div class="card"><h1>Daftar</h1><p>${escapeMin(motivo)}</p>` +
      `<p>Entraste como ${quien}. Pídele a quien administra esta instancia que agregue tu correo al directorio de identidad con el claim <code>student</code>.</p>` +
      `</div></body></html>`,
  )
}

function escapeMin(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Quién entró, resuelto SOLO desde la identidad del nodo. */
interface Sesion {
  admin: boolean
  /** Estudiante en foco: el del claim, o el elegido con `?s=` si es admin. `null` = admin sin foco. */
  student: string | null
}

function resolverSesion(inv: LetInvocation): Sesion | LetResponse {
  const email = inv.identity.user?.trim()
  if (!email) return paginaSinAcceso(undefined, 'No hay sesión: este Let no se sirve sin identidad.')
  const valores = inv.identity.claims?.['student'] ?? []
  if (valores.length === 0) return paginaSinAcceso(email, 'Tu cuenta no tiene acceso a ningún catálogo de instrumentos.')
  if (valores.includes('*')) {
    const elegido = inv.query['s']
    return { admin: true, student: elegido ? elegido : null }
  }
  return { admin: false, student: valores[0]! }
}

/** ¿Esta guía es del estudiante en foco? El admin sin foco ve todo; con `?s=` ve el de ese. */
const visible = (meta: GuiaMeta, s: Sesion): boolean => (s.admin && s.student === null ? true : meta.student === s.student)

export async function atenderDaftar(spec: DaftarSpec, deps: DaftarDeps, inv: LetInvocation): Promise<LetResponse | null> {
  const ahora = deps.ahora ?? (() => new Date().toISOString())
  const log = deps.log ?? ((m: string) => console.warn(m))
  const { method, path, base } = inv
  const escribe = method === 'POST'

  // ¿La ruta es siquiera nuestra? Se decide ANTES que la identidad: un 404 no debe depender de quién
  // pregunta, y un 403 sobre una ruta inexistente delataría rutas que no existen.
  const conocida =
    (method === 'GET' &&
      (path === '' ||
        path === 'api/students' ||
        path === 'api/guides' ||
        path.startsWith('api/guides/') ||
        path.startsWith('recursos/') ||
        path === 'api/progress' ||
        path.startsWith('api/progress/') ||
        path === 'api/reports' ||
        path.startsWith('api/reports/') ||
        path.startsWith('report/') ||
        path.startsWith('print/'))) ||
    (escribe && (path.startsWith('api/progress/') || path.startsWith('api/review/') || path.startsWith('api/reset/')))
  if (!conocida) return null

  const sesion = resolverSesion(inv)
  if ('status' in sesion) return sesion
  const s = sesion

  // ESCRITURA SIN CONTROL: se corta acá, antes de tocar nada. El Let lo hace porque solo él sabe
  // cuáles de sus rutas escriben — para el router `POST /estudios/api/progress/x` es una ruta más.
  if (escribe && !inv.hasControl) return json(409, { ok: false, error: 'standby', message: textoStandby(inv.activeHolder) })

  // ── Shell ──
  if (path === '') {
    return html(200, renderShell({ base, student: s.student, admin: s.admin, students: spec.estudiantes }))
  }
  if (path === 'api/students') return json(200, spec.estudiantes)

  // ── Catálogo ──
  if (path === 'api/guides') {
    // Como `_list_guides`: se emite el metadato SIN la clave `student` (es de gobierno, no de UI).
    const filas = deps.instrumentos
      .listar()
      .filter((m) => visible(m, s))
      .map((m) => {
        const { student: _omitido, ...resto } = m
        return resto
      })
    return json(200, filas)
  }
  if (path.startsWith('api/guides/')) {
    const id = path.slice('api/guides/'.length)
    const c = idSeguro(id) ? deps.instrumentos.guia(id) : null
    if (!c) return json(404, { ok: false, error: 'not-found' })
    if (!visible(c.meta, s)) return json(403, { ok: false, error: 'ajena' })
    // Las imágenes del preu viven en el JSON como `/preu/…` absoluto. El nodo NO sirve estáticos en
    // la raíz, así que la ruta se reescribe AL SERVIR — el archivo del disco no se toca.
    const texto = JSON.stringify(c.guia).split('src=\\"/preu/').join(`src=\\"${base}/recursos/preu/`)
    return { status: 200, headers: JSON_H, body: texto }
  }
  if (path.startsWith('recursos/')) {
    const r = deps.instrumentos.recurso(path.slice('recursos/'.length))
    if (!r) return json(404, { ok: false, error: 'not-found' })
    return { status: 200, headers: { 'content-type': r.contentType, 'cache-control': 'no-store' }, body: r.bytes }
  }

  // ── Progreso (store) ──
  const store = deps.store()
  const sinStore = (): LetResponse =>
    json(503, { ok: false, error: 'store-cerrado', message: 'El store de evaluaciones no está disponible en este nodo: el catálogo se sirve, el progreso no.' })

  if (path === 'api/progress') {
    if (!store) return sinStore()
    const out: Record<string, unknown> = {}
    const claves = s.admin && s.student === null ? Object.keys(spec.estudiantes) : [s.student!]
    for (const est of claves) {
      for (const it of store.intentosDe(est)) {
        const p = exportarProgreso(store, it.instrumentoId, est)
        if (p !== null) out[it.instrumentoId] = p
      }
    }
    return json(200, out)
  }
  if (path.startsWith('api/progress/')) {
    const id = path.slice('api/progress/'.length)
    if (!idSeguro(id)) return json(404, { ok: false, error: 'not-found' })
    const c = deps.instrumentos.guia(id)
    if (!c) return json(404, { ok: false, error: 'not-found' })
    if (!visible(c.meta, s)) return json(403, { ok: false, error: 'ajena' })
    const dueño = c.meta.student || s.student || ''
    if (!store) return sinStore()
    if (method === 'GET') return json(200, exportarProgreso(store, id, dueño) ?? {})

    // POST — el guardado del intento.
    const previo = store.intento(id, dueño)
    if (previo?.bloqueado) return json(403, { ok: false, error: 'locked' })
    let data: Record<string, unknown>
    try {
      data = JSON.parse(inv.body ?? '{}') as Record<string, unknown>
      if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('el cuerpo no es un objeto')
    } catch (e) {
      return json(400, { ok: false, error: `cuerpo inválido: ${e instanceof Error ? e.message : String(e)}` })
    }
    const bodyGuideId = data['guideId']
    if (bodyGuideId && bodyGuideId !== id) {
      return json(400, { ok: false, error: `guideId mismatch: body=${String(bodyGuideId)}, url=${id}` })
    }
    data['last_updated'] = ahora()
    // ESPEJO IDEMPOTENTE del instrumento (D-75): el catálogo es el disco; el store solo lo registra
    // para que el intento tenga contra qué colgar. Un conflicto de sha se LOGUEA y no corta el
    // guardado — el estudiante no pierde su trabajo por un problema editorial.
    try {
      store.publicarInstrumento({
        id,
        titulo: c.meta.title,
        codigo: c.meta.code || undefined,
        subtitulo: c.meta.subtitle || undefined,
        materia: c.meta.subject || undefined,
        grupo: c.meta.group || undefined,
        variante: c.meta.variant || undefined,
        modo: c.meta.mode || undefined,
        institucion: c.meta.institution || undefined,
        estudiante: c.meta.student || undefined,
        departamento: typeof c.guia.department === 'string' ? c.guia.department : undefined,
        confianza: c.guia.confidence === true,
        totalSecciones: totalSeccionesDe(c.guia as Record<string, unknown>),
        totalItems: totalItemsDe(c.guia as Record<string, unknown>),
        sha256: c.sha256 || sha256De(JSON.stringify(c.guia)),
        publicadoAt: ahora(),
        invalidado: c.meta.invalidated,
      })
    } catch (e) {
      log(`[daftar] espejo del instrumento '${id}' no registrado: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      store.guardarIntento(progresoAIntento(data, id, dueño))
    } catch (e) {
      return json(500, { ok: false, error: `no se pudo guardar el intento: ${e instanceof Error ? e.message : String(e)}` })
    }
    return json(200, { ok: true })
  }

  // ── Revisión y reset: SOLO admin (en Daftar el reset era «solo QA») ──
  if (path.startsWith('api/review/') || path.startsWith('api/reset/')) {
    const revision = path.startsWith('api/review/')
    const id = path.slice((revision ? 'api/review/' : 'api/reset/').length)
    if (!s.admin) return json(403, { ok: false, error: 'solo-admin' })
    if (!idSeguro(id)) return json(404, { ok: false, error: 'not-found' })
    const c = deps.instrumentos.guia(id)
    if (!c) return json(404, { ok: false, error: 'not-found' })
    if (!store) return sinStore()
    const dueño = c.meta.student || s.student || ''
    if (!revision) {
      store.borrarIntento(id, dueño)
      return json(200, { ok: true })
    }
    const it = store.intento(id, dueño)
    if (!it) return json(404, { ok: false, error: 'not-found' })
    let cuerpo: Record<string, unknown>
    try {
      cuerpo = JSON.parse(inv.body ?? '{}') as Record<string, unknown>
    } catch {
      return json(400, { ok: false, error: 'JSON inválido' })
    }
    const secciones = (cuerpo['sections'] ?? {}) as Record<string, unknown>
    const at = ahora()
    for (const [si, rev] of Object.entries(secciones)) {
      const n = Number(si)
      if (!Number.isInteger(n)) continue
      store.guardarRevision(it.id, n, rev, at)
    }
    return json(200, { ok: true })
  }

  // ── Reportes de devolución (archivos) ──
  if (path === 'api/reports') {
    const filas = deps.instrumentos.reportes().filter((r) => (s.admin && s.student === null ? true : r['student'] === s.student))
    return json(200, filas)
  }
  if (path.startsWith('api/reports/')) {
    const id = path.slice('api/reports/'.length)
    const r = idSeguro(id) ? deps.instrumentos.reporte(id) : null
    if (!r) return json(404, { ok: false, error: 'not-found' })
    if (!(s.admin && s.student === null) && r['student'] !== s.student) return json(403, { ok: false, error: 'ajeno' })
    return json(200, r)
  }

  // ── Instrumento corregido / imprimible ──
  if (path.startsWith('report/') || path.startsWith('print/')) {
    const esReporte = path.startsWith('report/')
    const id = path.slice((esReporte ? 'report/' : 'print/').length)
    const c = idSeguro(id) ? deps.instrumentos.guia(id) : null
    if (!c) return html(404, '<!doctype html><meta charset="utf-8"><p>Instrumento no encontrado.</p>')
    if (!visible(c.meta, s)) return paginaSinAcceso(inv.identity.user, 'Este instrumento no es tuyo.')
    const blank = !esReporte && ['1', 'true', 'yes'].includes(inv.query['blank'] ?? '0')
    const dueño = c.meta.student || s.student || ''
    const progreso: Progreso = (!blank && store ? ((exportarProgreso(store, id, dueño) ?? {}) as Progreso) : {}) as Progreso
    const opts = { estudiantes: spec.estudiantes, base }
    return html(200, esReporte ? renderReport(c.guia, progreso, opts) : renderPrint(c.guia, progreso, { ...opts, blank }))
  }

  return null
}
