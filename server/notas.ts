/**
 * La CAPA DE NOTAS (vergis#84) — un solo handler cohesivo para toda la familia: impresiones,
 * anotaciones, comentarios, compartición y la superficie «Mis impresiones».
 *
 * Rutas:
 *   POST `/<slug>/imprimir`          congela la vista actual — «Imprimir» deliberado
 *   POST `/<slug>/notas`             anota; materializa la impresión perezosamente si hace falta
 *   POST `/<slug>/comentarios`       comenta un REGISTRO (gate al escribir, contra el dato)
 *   GET  `/<slug>/comentarios`       el hilo de comentarios de una llave
 *   GET  `/impresiones`              mías + compartidas conmigo
 *   GET  `/impresiones/<id>`         la impresión congelada, read-only, con su panel de anotaciones
 *   POST `/impresiones/<id>/notas`   anota (o responde) sobre una impresión
 *   POST `/impresiones/<id>/compartir` · `/revocar` · `/borrar`
 *
 * Las tres reglas que gobiernan este archivo:
 *
 *  1. **La impresión congela dato YA filtrado por la RLS del emisor.** No hay token por fila ni
 *     autorización diferida: el congelado nació de un render bajo la identidad de su dueño, así que
 *     anotarlo no vuelve a preguntar nada. Quien lo recibe compartido ve lo que el emisor vio (D8).
 *  2. **El comentario se verifica AL ESCRIBIR, contra el DATO.** El server re-ejecuta la recuperación
 *     del dataset bajo la identidad del autor y exige que la fila con esa llave esté en el resultado.
 *     Una llave forjada que la RLS del autor no devuelve no se comenta: 403. Verificar contra un
 *     token firmado sería verificar contra lo que el server dijo antes, no contra lo que el dato dice
 *     ahora — y una autorización revocada seguiría escribiendo.
 *  3. **Sin `anchor` no hay gesto.** Un dataset que no declaró llave de negocio no ofrece comentar, y
 *     el endpoint responde 404: la capacidad no existe ahí (fail-closed, D16).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  escapeHtml,
  canonicalKey,
  llaveDeFila,
  normalizeEntityRef,
  NotasConflict,
  type NotasStore,
  type Impresion,
  type Nota,
  type NotaObjetivoTipo,
} from '@vergis/capabilities'
import type { MiraAnchor, MiraSpec, ResolvedNode } from '@vergis/mira'
import type { LogEventInput } from '@vergis/botler'
import { page, shellNav, send, redirect, readForm, requireCsrf, csrfFactory, CsrfError } from './ui'
import { readJsonBody, fail } from './http-util'

/** Lo que un render produce y una impresión congela. */
export interface CongeladoPi {
  piSlug: string
  piName: string
  title: string
  page?: string
  ctx?: Record<string, string | string[]>
  theme?: string
  palette?: string
  watermark?: string
  specVersion?: string
  autor: string
  /** El árbol resuelto tal como se sirvió (con los comentarios visibles ya fusionados). */
  resolved: ResolvedNode
}

export interface NotasDeps {
  store: NotasStore
  /** slug → PI servible + su spec parseada, o undefined si no existe / no es servible. */
  resolve: (slug: string) => { code: string; name: string; slug: string; spec: MiraSpec } | undefined
  identityOf: (headers: IncomingMessage['headers']) => { user?: string }
  /** Gate de ARTEFACTO: ¿esta identidad puede abrir el PI? (la RLS de datos aplica igual). */
  canOpenPi: (slug: string, headers: IncomingMessage['headers']) => Promise<boolean>
  /**
   * Re-ejecuta la recuperación de un dataset del PI bajo la identidad del request, con el `ctx`
   * aplicado. ES la fuente del gate al escribir un comentario: lo que devuelve es exactamente lo que
   * esa identidad puede ver.
   */
  retrieve: (
    slug: string,
    dataset: string,
    ctx: Record<string, string | string[]> | undefined,
    headers: IncomingMessage['headers'],
  ) => Promise<Record<string, unknown>[]>
  /** Renderiza el PI bajo la identidad del request y devuelve lo congelable. */
  congelar: (
    slug: string,
    page: string | undefined,
    ctx: Record<string, string | string[]> | undefined,
    headers: IncomingMessage['headers'],
  ) => Promise<CongeladoPi>
  /** Render del árbol congelado a HTML (read-only, sin controles de datos). */
  renderCongelado: (frozen: CongeladoPi) => Promise<string>
  /** Menú de avatar de la identidad (para el shell de «Mis impresiones»). */
  avatarFor: (email: string) => Promise<string>
  audit: (event: LogEventInput) => void
  secret: string
  brandTitle?: string
}

export interface NotasHandler {
  tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
}

class Forbidden extends Error {}
class NotFound extends Error {}
class NotImplementedYet extends Error {}
class BadRequest extends Error {}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Código HTTP de cada modo de falla. `NotImplementedYet` = la estructura existe, la función no. */
function statusOf(e: unknown): number {
  if (e instanceof CsrfError || e instanceof Forbidden) return 403
  if (e instanceof NotFound) return 404
  if (e instanceof NotImplementedYet) return 501
  if (e instanceof BadRequest) return 400
  if (e instanceof NotasConflict) return 409
  return 500
}

const OBJETIVOS: NotaObjetivoTipo[] = ['celda', 'fila', 'agregado', 'elemento', 'impresion']

export function createNotas(deps: NotasDeps): NotasHandler {
  const csrf = csrfFactory(deps.secret)
  const pg = (title: string, body: string): string => page(`${deps.brandTitle ?? 'Vergis'} · Notas`, title, body)

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  /** Identidad del request, normalizada. Vacía ⇒ no se escribe nada (jamás se infiere). */
  const emailOf = (req: IncomingMessage): string => (deps.identityOf(req.headers).user ?? '').trim().toLowerCase()

  /** El `anchor` declarado por un dataset del PI, o NotFound: sin declaración el gesto no existe. */
  function anchorDe(spec: MiraSpec, dataset: string): MiraAnchor {
    const anchor = spec.data?.[dataset]?.anchor
    if (!anchor) {
      throw new NotFound(
        `El dataset '${dataset}' no declara llave de negocio (\`anchor\`): sobre él no se puede comentar un registro.`,
      )
    }
    return anchor
  }

  /**
   * Gate del comentario (regla 2): re-ejecuta la recuperación del dataset bajo la identidad del
   * autor y exige que la llave esté entre las filas devueltas. Devuelve la fila visible.
   */
  async function exigirFilaVisible(
    slug: string,
    dataset: string,
    anchor: MiraAnchor,
    llave: Record<string, string>,
    ctx: Record<string, string | string[]> | undefined,
    req: IncomingMessage,
  ): Promise<Record<string, unknown>> {
    const filas = await deps.retrieve(slug, dataset, ctx, req.headers)
    const buscada = canonicalKey(llave)
    const hit = filas.find((f) => canonicalKey(llaveDeFila(f, anchor.key)) === buscada)
    if (!hit) {
      throw new Forbidden('Registro no visible para esta identidad: no se puede comentar lo que no se ve.')
    }
    return hit
  }

  /** Normaliza la llave recibida del cliente contra las columnas DECLARADAS (nada más viaja). */
  function llaveDelCuerpo(anchor: MiraAnchor, raw: unknown): Record<string, string> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequest('Falta la llave del registro (key).')
    const src = raw as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const col of [...anchor.key].sort()) {
      if (!(col in src)) throw new BadRequest(`La llave no trae la columna declarada '${col}'.`)
      out[col] = src[col] == null ? '' : String(src[col])
    }
    return out
  }

  /** La voz nace en el modelo, no en la función: cualquier intento de escribirla se rechaza claro. */
  function rechazarVoz(body: { contenidoTipo?: unknown; contenido_tipo?: unknown }): void {
    const tipo = String(body.contenidoTipo ?? body.contenido_tipo ?? 'texto')
    if (tipo !== 'texto') {
      throw new NotImplementedYet(
        'Las notas de voz llegan en una versión próxima: el modelo ya las conoce, la captura y la transcripción todavía no existen.',
      )
    }
  }

  function contenidoDe(body: { contenido?: unknown }): string {
    const texto = String(body.contenido ?? '').trim()
    if (!texto) throw new BadRequest('La nota no puede ir vacía.')
    return texto
  }

  // ── Impresiones: acceso ────────────────────────────────────────────────────────────────────
  /** Una impresión se abre si eres su dueño o tienes compartición VIGENTE (revocada ⇒ 403). */
  async function exigirAcceso(id: string, email: string): Promise<Impresion> {
    const imp = await deps.store.getImpresion(id)
    if (!imp) throw new NotFound('La impresión no existe (o fue purgada por retención).')
    if (imp.owner === email) return imp
    if (await deps.store.tieneComparticionVigente(id, email)) return imp
    throw new Forbidden('No tienes acceso a esta impresión.')
  }

  async function tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/'
    const esImpresiones = path === '/impresiones' || path.startsWith('/impresiones/')
    const mPi = path.match(/^\/([^/]+)\/(imprimir|notas|comentarios)$/)
    if (!esImpresiones && !mPi) return false

    const email = emailOf(req)
    const token = csrf(email)

    try {
      if (mPi) {
        await handlePi(req, res, mPi[1].toLowerCase(), mPi[2], email, token)
        return true
      }
      await handleImpresiones(req, res, path, email, token)
      return true
    } catch (e) {
      const code = statusOf(e)
      const quiereJson = (req.headers['accept'] ?? '').includes('application/json') || req.method === 'POST'
      if (quiereJson) json(res, code, { ok: false, error: errMsg(e) })
      else send(res, code, pg('No disponible', `<p class="msg err">${escapeHtml(errMsg(e))}</p><p><a href="/impresiones">← Mis impresiones</a></p>`))
      return true
    }
  }

  // ── Rutas del PI ───────────────────────────────────────────────────────────────────────────
  async function handlePi(
    req: IncomingMessage,
    res: ServerResponse,
    slug: string,
    op: string,
    email: string,
    token: string,
  ): Promise<void> {
    const target = deps.resolve(slug)
    if (!target) throw new NotFound('Producto de Información no encontrado.')
    if (!(await deps.canOpenPi(slug, req.headers))) throw new Forbidden('No tienes acceso a este Producto de Información.')
    if (!email) throw new Forbidden('Sin identidad no se escriben notas.')

    // GET del hilo de comentarios de una llave (lo consume el popover del marcador).
    if (op === 'comentarios' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const dataset = url.searchParams.get('dataset') ?? ''
      const anchor = anchorDe(target.spec, dataset)
      let llaveRaw: unknown
      try {
        llaveRaw = JSON.parse(url.searchParams.get('key') ?? 'null')
      } catch {
        throw new BadRequest('La llave del registro no es un JSON válido.')
      }
      const llave = llaveDelCuerpo(anchor, llaveRaw)
      // Lectura fail-closed: solo se devuelve el hilo de una llave que ESTA identidad puede ver.
      await exigirFilaVisible(slug, dataset, anchor, llave, navCtxDe(url), req)
      const notas = await deps.store.comentariosDeLlave(anchor.entity, llave)
      json(res, 200, { ok: true, entity: normalizeEntityRef(anchor.entity), llave, notas: notas.map(notaJson) })
      return
    }

    if (req.method !== 'POST') throw new NotFound('Ruta no encontrada.')
    const body = (await readJsonBody(req)) as Record<string, unknown>
    requireCsrf({ _csrf: String(body['_csrf'] ?? '') }, token)
    const pageParam = body['page'] == null ? undefined : String(body['page'])
    const ctx = ctxDelCuerpo(body['ctx'])

    if (op === 'imprimir') {
      const frozen = await deps.congelar(slug, pageParam, ctx, req.headers)
      const imp = await deps.store.abrirImpresion({
        piSlug: slug,
        owner: email,
        page: pageParam,
        ctx,
        specVersion: frozen.specVersion,
        watermark: frozen.watermark,
        frozen,
        explicita: true,
      })
      deps.audit({ type: 'notas-imprimir', pi: slug, impresion: imp.id, by: email })
      json(res, 200, { ok: true, id: imp.id, url: `/impresiones/${imp.id}` })
      return
    }

    if (op === 'notas') {
      rechazarVoz(body)
      const contenido = contenidoDe(body)
      const objetivo = (body['objetivo'] ?? {}) as Record<string, unknown>
      const tipoRaw = String(objetivo['tipo'] ?? 'impresion')
      const objetivoTipo = (OBJETIVOS as string[]).includes(tipoRaw) ? (tipoRaw as NotaObjetivoTipo) : 'impresion'
      // MATERIALIZACIÓN PEREZOSA (D3/D4): la primera nota sobre una vista es la que hace nacer su
      // impresión. Si el autor ya tiene una del MISMO sustrato dentro de su sesión de trabajo, la
      // nota cuelga de esa — anotar tres filas de la misma vista no produce tres impresiones.
      const frozen = await deps.congelar(slug, pageParam, ctx, req.headers)
      const imp = await deps.store.abrirImpresion({
        piSlug: slug,
        owner: email,
        page: pageParam,
        ctx,
        specVersion: frozen.specVersion,
        watermark: frozen.watermark,
        frozen,
      })
      const llave = objetivo['llave'] && typeof objetivo['llave'] === 'object' ? (objetivo['llave'] as Record<string, unknown>) : undefined
      const nota = await deps.store.crearNota({
        especie: 'anotacion',
        autor: email,
        contenido,
        impresionId: imp.id,
        objetivoTipo,
        objetivo,
        llave,
      })
      deps.audit({ type: 'notas-anotar', pi: slug, impresion: imp.id, nota: nota.id, objetivo: objetivoTipo, by: email })
      json(res, 200, { ok: true, id: nota.id, impresionId: imp.id, url: `/impresiones/${imp.id}` })
      return
    }

    // op === 'comentarios' (POST) — la especie anclada al REGISTRO.
    rechazarVoz(body)
    const contenido = contenidoDe(body)
    const dataset = String(body['dataset'] ?? '')
    const anchor = anchorDe(target.spec, dataset)
    const llave = llaveDelCuerpo(anchor, body['key'])
    await exigirFilaVisible(slug, dataset, anchor, llave, ctx, req)
    const campoRaw = body['campo'] == null ? '' : String(body['campo'])
    // Un comentario de CELDA solo puede apuntar a un campo que el PI declara: un campo forjado
    // dejaría el comentario colgando de una columna que nadie ve.
    const campo = campoRaw || undefined
    const parentId = body['parentId'] == null ? undefined : String(body['parentId'])
    const nota = await deps.store.crearNota({
      especie: 'comentario',
      autor: email,
      contenido,
      entityRef: anchor.entity,
      llave,
      campo,
      parentId,
    })
    deps.audit({ type: 'notas-comentar', pi: slug, entity: normalizeEntityRef(anchor.entity), nota: nota.id, campo: campo ?? '', by: email })
    json(res, 200, { ok: true, id: nota.id })
  }

  // ── Rutas de impresiones ───────────────────────────────────────────────────────────────────
  async function handleImpresiones(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    email: string,
    token: string,
  ): Promise<void> {
    if (path === '/impresiones') {
      if (req.method !== 'GET') throw new NotFound('Ruta no encontrada.')
      send(res, 200, await misImpresionesPage(email, token, new URL(req.url ?? '/', 'http://localhost')))
      return
    }
    const m = path.match(/^\/impresiones\/([^/]+)(?:\/(notas|compartir|revocar|borrar))?$/)
    if (!m) throw new NotFound('Ruta no encontrada.')
    const id = m[1]
    const op = m[2]
    if (!email) throw new Forbidden('Sin identidad no se accede a una impresión.')

    if (!op) {
      if (req.method !== 'GET') throw new NotFound('Ruta no encontrada.')
      const imp = await exigirAcceso(id, email)
      send(res, 200, await vistaImpresion(imp, email, token))
      return
    }

    if (req.method !== 'POST') throw new NotFound('Ruta no encontrada.')

    if (op === 'notas') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      requireCsrf({ _csrf: String(body['_csrf'] ?? '') }, token)
      rechazarVoz(body)
      const contenido = contenidoDe(body)
      const imp = await exigirAcceso(id, email)
      const objetivo = (body['objetivo'] ?? {}) as Record<string, unknown>
      const tipoRaw = String(objetivo['tipo'] ?? 'impresion')
      const parentId = body['parentId'] == null ? undefined : String(body['parentId'])
      const nota = await deps.store.crearNota({
        especie: 'anotacion',
        autor: email,
        contenido,
        impresionId: imp.id,
        objetivoTipo: (OBJETIVOS as string[]).includes(tipoRaw) ? (tipoRaw as NotaObjetivoTipo) : 'impresion',
        objetivo,
        parentId,
      })
      deps.audit({ type: 'notas-anotar', impresion: imp.id, nota: nota.id, by: email })
      json(res, 200, { ok: true, id: nota.id })
      return
    }

    // compartir · revocar · borrar — formularios del DUEÑO.
    const f = await readForm(req)
    requireCsrf(f, token)
    const imp = await deps.store.getImpresion(id)
    if (!imp) throw new NotFound('La impresión no existe.')
    if (imp.owner !== email) throw new Forbidden('Solo el dueño de la impresión puede compartirla, revocarla o borrarla.')

    if (op === 'borrar') {
      await deps.store.borrarImpresion(id)
      deps.audit({ type: 'notas-borrar-impresion', impresion: id, by: email })
      redirect(res, '/impresiones')
      return
    }
    const receptor = (f['receptor'] ?? '').trim().toLowerCase()
    if (!receptor) throw new BadRequest('Indica el correo del receptor.')
    if (op === 'compartir') {
      // Sin validación de buzón ni envío de correo: la notificación llega en una versión próxima; el
      // receptor la descubre en «Compartidas conmigo». El registro ES la auditoría (D8/D9).
      await deps.store.compartir(id, email, receptor)
      deps.audit({ type: 'notas-compartir', impresion: id, receptor, by: email })
    } else {
      // Revocación HACIA ADELANTE: el receptor pierde acceso; sus notas ya escritas persisten —
      // el trabajo humano no se borra por un cambio de permiso.
      await deps.store.revocar(id, email, receptor)
      deps.audit({ type: 'notas-revocar', impresion: id, receptor, by: email })
    }
    redirect(res, `/impresiones/${id}`)
  }

  // ── Superficie «Mis impresiones» (T8) ──────────────────────────────────────────────────────
  async function misImpresionesPage(email: string, token: string, url: URL): Promise<string> {
    const fPi = (url.searchParams.get('pi') ?? '').toLowerCase()
    const fDesde = url.searchParams.get('desde') ?? ''
    const fConNotas = url.searchParams.get('notas') === '1'
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()

    const mias = await deps.store.listImpresiones(email)
    const compartidas = await deps.store.listCompartidasCon(email)

    const notasDe = new Map<string, number>()
    for (const imp of [...mias, ...compartidas.map((c) => c.impresion)]) {
      if (!notasDe.has(imp.id)) notasDe.set(imp.id, (await deps.store.notasDe(imp.id)).length)
    }

    const pasa = (imp: Impresion): boolean => {
      if (fPi && imp.piSlug !== fPi) return false
      if (fDesde && imp.lastActivity < fDesde) return false
      if (fConNotas && !(notasDe.get(imp.id) ?? 0)) return false
      if (q && !tituloDe(imp).toLowerCase().includes(q)) return false
      return true
    }

    const filaMia = (imp: Impresion): string =>
      `<tr><td><a href="/impresiones/${escapeHtml(imp.id)}">${escapeHtml(tituloDe(imp))}</a>` +
      `<div class="sub">${escapeHtml(imp.piSlug)}${imp.page ? ' · ' + escapeHtml(imp.page) : ''}${imp.explicita ? '' : ' · materializada al anotar'}</div></td>` +
      `<td>${escapeHtml(fechaCorta(imp.createdAt))}</td>` +
      `<td>${notasDe.get(imp.id) ?? 0}</td>` +
      `<td class="r">` +
      `<form method="post" action="/impresiones/${escapeHtml(imp.id)}/borrar" onsubmit="return confirm('¿Borrar esta impresión y sus notas?')">` +
      `<input type="hidden" name="_csrf" value="${token}"><button class="del">Borrar</button></form></td></tr>`

    const filaCompartida = (c: { impresion: Impresion; comparticion: { emisor: string; createdAt: string } }): string =>
      `<tr><td><a href="/impresiones/${escapeHtml(c.impresion.id)}">${escapeHtml(tituloDe(c.impresion))}</a>` +
      `<div class="sub">${escapeHtml(c.impresion.piSlug)}</div></td>` +
      `<td>${escapeHtml(c.comparticion.emisor)}</td>` +
      `<td>${escapeHtml(fechaCorta(c.comparticion.createdAt))}</td>` +
      `<td>${notasDe.get(c.impresion.id) ?? 0}</td></tr>`

    const misFilas = mias.filter(pasa).map(filaMia).join('')
    const compFilas = compartidas.filter((c) => pasa(c.impresion)).map(filaCompartida).join('')
    const pis = [...new Set([...mias, ...compartidas.map((c) => c.impresion)].map((i) => i.piSlug))].sort()

    const filtros =
      `<form method="get" action="/impresiones" class="row">` +
      `<select name="pi"><option value="">Todos los PI</option>${pis
        .map((p) => `<option value="${escapeHtml(p)}"${p === fPi ? ' selected' : ''}>${escapeHtml(p)}</option>`)
        .join('')}</select>` +
      `<input type="date" name="desde" value="${escapeHtml(fDesde.slice(0, 10))}" aria-label="Desde">` +
      `<input name="q" value="${escapeHtml(q)}" placeholder="Buscar…" aria-label="Buscar">` +
      `<label class="fld"><input type="checkbox" name="notas" value="1"${fConNotas ? ' checked' : ''}> Solo con notas</label>` +
      `<button class="add">Filtrar</button></form>`

    const body =
      `<p class="sub">Una impresión es lo que viste, congelado tal como lo viste: filas, forma, recorte y fecha del dato. Lo que no compartes no aparece en la lista de nadie más.</p>` +
      filtros +
      `<h2>Mías</h2>` +
      `<table><thead><tr><th>Impresión</th><th>Creada</th><th>Notas</th><th></th></tr></thead><tbody>${
        misFilas || `<tr><td colspan="4" class="sub">Todavía no has impreso nada. En cualquier PI, la bandeja trae «Imprimir».</td></tr>`
      }</tbody></table>` +
      `<h2>Compartidas conmigo</h2>` +
      `<table><thead><tr><th>Impresión</th><th>De</th><th>Compartida</th><th>Notas</th></tr></thead><tbody>${
        compFilas || `<tr><td colspan="4" class="sub">Nadie ha compartido una impresión contigo.</td></tr>`
      }</tbody></table>`

    return shellNav(
      `${deps.brandTitle ?? 'Vergis'}`,
      'Mis impresiones',
      `<a class="catlink" href="/">← Catálogo de PIs</a><a href="/impresiones" class="on">Mis impresiones</a>`,
      await deps.avatarFor(email),
      body,
    )
  }

  // ── Vista de una impresión (T6) ────────────────────────────────────────────────────────────
  async function vistaImpresion(imp: Impresion, email: string, token: string): Promise<string> {
    const frozen = JSON.parse(imp.frozenJson) as CongeladoPi
    const cuerpo = await deps.renderCongelado({ ...frozen, resolved: sinDrills(frozen.resolved) })
    const notas = await deps.store.notasDe(imp.id)
    const comparticiones = await deps.store.comparticionesDe(imp.id)
    const esDueno = imp.owner === email

    const hilo = notas
      .map((n) => {
        const responder =
          `<form class="notas-responder" data-parent="${escapeHtml(n.id)}">` +
          `<textarea placeholder="Responder…" aria-label="Responder"></textarea><button type="button" class="add">Responder</button></form>`
        return (
          `<li class="nota" data-id="${escapeHtml(n.id)}"${n.parentId ? ` data-parent="${escapeHtml(n.parentId)}"` : ''}>` +
          `<div class="sub">${escapeHtml(n.autor)} · ${escapeHtml(fechaCorta(n.createdAt))}${n.editedAt ? ' · editada' : ''}` +
          `${n.objetivoTipo && n.objetivoTipo !== 'impresion' ? ' · sobre ' + escapeHtml(n.objetivoTipo) : ''}` +
          `${n.refRota ? ' · referencia no resuelta' : ''}</div>` +
          `<div>${escapeHtml(n.contenido || '(nota retirada)')}</div>` +
          responder +
          `</li>`
        )
      })
      .join('')

    const compartirForm = esDueno
      ? `<h2>Compartir</h2>` +
        `<form method="post" action="/impresiones/${escapeHtml(imp.id)}/compartir" class="row">` +
        `<input type="hidden" name="_csrf" value="${token}">` +
        `<input name="receptor" placeholder="correo@dominio" aria-label="Receptor"><button class="add">Compartir</button></form>` +
        `<p class="sub">Quien la reciba verá exactamente lo que tú viste. La encontrará en «Compartidas conmigo»; la notificación por correo llega en una versión próxima.</p>` +
        `<table><thead><tr><th>Receptor</th><th>Desde</th><th>Estado</th><th></th></tr></thead><tbody>${
          comparticiones
            .map(
              (c) =>
                `<tr><td>${escapeHtml(c.receptor)}</td><td>${escapeHtml(fechaCorta(c.createdAt))}</td>` +
                `<td>${c.revocadaAt ? 'revocada ' + escapeHtml(fechaCorta(c.revocadaAt)) : 'vigente'}</td>` +
                `<td class="r">${
                  c.revocadaAt
                    ? '<span class="sub">—</span>'
                    : `<form method="post" action="/impresiones/${escapeHtml(imp.id)}/revocar"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="receptor" value="${escapeHtml(c.receptor)}"><button class="del">Revocar</button></form>`
                }</td></tr>`,
            )
            .join('') || `<tr><td colspan="4" class="sub">Sin compartir.</td></tr>`
        }</tbody></table>`
      : ''

    const banner =
      `<div class="imp-banner">Impresión de <b>${escapeHtml(frozen.piName || frozen.piSlug)}</b> · ` +
      `${escapeHtml(fechaCorta(imp.createdAt))} · dato al ${escapeHtml(imp.watermark ? fechaCorta(imp.watermark) : 'sin marca de frescura')} · ` +
      `por ${escapeHtml(imp.owner)}${imp.explicita ? '' : ' (materializada al anotar)'}</div>`

    const script = `<script>(function(){
var CSRF=${JSON.stringify(token)}, URLN=${JSON.stringify(`/impresiones/${imp.id}/notas`)};
function enviar(contenido, parentId, btn){
  btn.disabled=true;
  fetch(URLN,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({_csrf:CSRF,contenido:contenido,parentId:parentId,objetivo:{tipo:'impresion'}})})
    .then(function(r){ if(!r.ok) throw new Error('no se pudo guardar'); location.reload(); })
    .catch(function(e){ btn.disabled=false; alert(e.message); });
}
var nueva=document.getElementById('nota-nueva');
if(nueva) nueva.querySelector('button').addEventListener('click', function(){
  var t=nueva.querySelector('textarea').value.trim(); if(t) enviar(t, null, this);
});
Array.prototype.forEach.call(document.querySelectorAll('.notas-responder'), function(f){
  f.querySelector('button').addEventListener('click', function(){
    var t=f.querySelector('textarea').value.trim(); if(t) enviar(t, f.getAttribute('data-parent'), this);
  });
});
})();</script>`

    const css = `<style>
.imp-banner{padding:10px 14px;margin:0 0 18px;border-radius:9px;background:var(--card);border:1px solid var(--border);font-size:12.5px;color:var(--muted)}
.imp-cuerpo{border:1px solid var(--border);border-radius:10px;padding:6px 14px;margin-bottom:22px;overflow-x:auto}
ul.notas{list-style:none;padding:0}
ul.notas li.nota{padding:11px 14px;margin:8px 0;background:var(--card);border:1px solid var(--border);border-radius:9px}
ul.notas li.nota[data-parent]{margin-left:26px}
.notas-responder{display:flex;gap:8px;margin-top:8px}
.notas-responder textarea{flex:1;min-height:38px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:7px;padding:7px 9px;font:inherit;font-size:13px}
#nota-nueva{display:flex;gap:8px;max-width:640px}
#nota-nueva textarea{flex:1;min-height:64px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:7px;padding:8px 10px;font:inherit;font-size:13px}
</style>`

    return page(
      `${deps.brandTitle ?? 'Vergis'} · Impresión`,
      tituloDe(imp),
      css +
        `<p><a href="/impresiones">← Mis impresiones</a></p>` +
        banner +
        `<div class="imp-cuerpo">${cuerpo}</div>` +
        `<h2>Anotaciones</h2>` +
        `<div id="nota-nueva"><textarea placeholder="Anota esta impresión…" aria-label="Nueva anotación"></textarea><button class="add">Anotar</button></div>` +
        `<ul class="notas">${hilo || '<li class="sub">Sin anotaciones todavía.</li>'}</ul>` +
        compartirForm +
        script,
    )
  }

  return { tryHandle }
}

// ── Helpers puros ─────────────────────────────────────────────────────────────────────────────

/** Título legible de una impresión: el del congelado, con el PI y la fecha como respaldo. */
export function tituloDe(imp: Impresion): string {
  try {
    const f = JSON.parse(imp.frozenJson) as CongeladoPi
    const base = f.title || f.piName || imp.piSlug
    return f.page ? `${base} · ${f.page}` : base
  } catch {
    return `${imp.piSlug} · ${fechaCorta(imp.createdAt)}`
  }
}

function fechaCorta(iso: string): string {
  return (iso ?? '').slice(0, 16).replace('T', ' ')
}

/**
 * Quita las acciones de drill del árbol congelado. Una impresión es un DOCUMENTO: navegar desde ella
 * a una vista viva rompería la promesa de que lo que se ve es lo que se vio — el drill llevaría a
 * dato de hoy dentro del marco de un dato de ayer.
 */
export function sinDrills(node: ResolvedNode): ResolvedNode {
  const { drills: _drills, ...resto } = node
  return {
    ...resto,
    ...(node.elements ? { elements: node.elements.map(sinDrills) } : {}),
  }
}

function notaJson(n: Nota): Record<string, unknown> {
  return {
    id: n.id,
    autor: n.autor,
    createdAt: n.createdAt,
    editedAt: n.editedAt,
    contenido: n.contenido,
    campo: n.campo,
    parentId: n.parentId,
    refRota: n.refRota,
  }
}

/** `ctx` del cuerpo de un POST → el mapa que la navegación usa (solo string o string[]). */
function ctxDelCuerpo(raw: unknown): Record<string, string | string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v.map((x) => String(x))
    else if (v != null) out[k] = String(v)
  }
  return Object.keys(out).length ? out : undefined
}

/** `?ctx.<k>=` de una URL → el mapa de navegación (espejo de `navFromUrl`, sin importarlo). */
function navCtxDe(url: URL): Record<string, string | string[]> | undefined {
  const ctx: Record<string, string | string[]> = {}
  for (const k of new Set(url.searchParams.keys())) {
    const m = k.match(/^ctx\.(.+)$/)
    if (!m) continue
    const all = url.searchParams.getAll(k)
    ctx[m[1]] = all.length === 1 ? all[0] : all
  }
  return Object.keys(ctx).length ? ctx : undefined
}

export { fail }
