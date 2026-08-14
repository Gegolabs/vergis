/**
 * Superficie HTTP de Miranda — el agente conversacional que autora specs (cluster 077). Server-rendered
 * (patrón de `server/pi-config.ts`) + endpoints form-encoded con CSRF (no requiere JS). Se monta desde
 * `server/routes.ts` SOLO con el flag `MIRANDA_ENABLED` encendido: apagado ⇒ `getMiranda()` null ⇒
 * `/miranda*` cae al 404 normal (superficie cero).
 *
 * AuthZ de la capacidad: scope `miranda` (admin o miembro del grupo de scope). Sin scope ⇒ 403 en todas
 * las rutas y sin entrada en nav. La RLS del DATO (preview y serving) es INDEPENDIENTE y siempre aplica:
 * la preview pasa por el mismo `serve-rls` que un PI real.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { escapeHtml, type MirandaStore, type MirandaSession } from '@vergis/capabilities'
import type { IdentityContext } from '@vergis/botler'
import {
  runAgentTurn,
  runSelfCheck,
  publishSpec,
  PublishBlocked,
  TokenBudgetExceeded,
  buildToolRegistry,
  guardProbeSql,
  hasBlockingGaps,
  type AnthropicTransport,
  type AnthropicMessage,
  type MirandaToolContext,
  type CatalogEntry,
  type SpecRef,
  type IntentSummary,
  type ColumnShield,
  UNKNOWN_SHIELD,
} from '@vergis/miranda'
import { columnRules, type PolicyDecl } from '@vergis/policy'
import { page, readForm, redirect, send, csrfFactory, requireCsrf, CsrfError } from './ui'

export interface MirandaHandler {
  tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
}

/** Dependencias que el server cablea (todas seams testeables). */
export interface MirandaServerDeps {
  gov: MirandaStore
  transport: AnthropicTransport
  model: string
  systemPrompt: string
  rubric?: string
  maxTurns: number
  tokenBudget: number
  catalog: CatalogEntry[]
  /** Identidad del request (email del gate). */
  identityOf(headers: IncomingMessage['headers']): { user?: string }
  /** ¿La identidad tiene el scope `miranda`? (admin o miembro del grupo de scope). */
  hasScope(email: string | undefined): Promise<boolean>
  /** ¿La identidad es admin de la plataforma? (para el guard de pertenencia — el admin ve/opera toda
   *  sesión). Obligatorio: el compilador garantiza que ningún cableado lo olvide. */
  isAdmin(email: string | undefined): Promise<boolean>
  /** Ejecuta una probe (SQL ya guardado) con la identidad del autor. */
  probe(sql: string, email: string | undefined): Promise<{ rows: Record<string, unknown>[] }>
  /** Columnas+tipos de un objeto del catálogo. */
  columnsOf(table: string): Promise<{ name: string; type: string }[]>
  /**
   * La política data-anchored del policy store para un objeto del catálogo (#163 · H9). De ella sale
   * el plano de columna: `columnRules(policy)` — la lectura canónica de `@vergis/policy`, que no se
   * reimplementa acá.
   *
   * **Devolver `undefined` NO abre nada**: el nodo es default-deny sobre el dato sin política («dato
   * sin política no se sirve», serve-rls §cabecera), y lo mismo rige para el sondeo. Un objeto sin
   * política determinable se describe entero —su esquema se nombra— y no se muestrea.
   *
   * Opcional SOLO por compatibilidad de cableado: si esta dep no se cablea, Miranda no sondea NADA.
   * Es el lado correcto del error, pero es una degradación visible — cablearla es parte del hito.
   */
  policyFor?(table: string): PolicyDecl | undefined
  /** Valida un draft contra el DSL (schema + capabilities de instancia). */
  validateDraft(yaml: string): { ok: true } | { ok: false; error: string }
  listSpecs(): SpecRef[]
  readSpec(code: string): string | null
  /** Escribe la spec publicada al SPECS_DIR (hot-reload la levanta). */
  writeSpec(filename: string, content: string): Promise<void>
  /** Renderiza un draft efímero por el riel serve-rls con la identidad del request (RLS real). */
  renderPreviewHtml(draftYaml: string, headers: IncomingMessage['headers']): Promise<string>
  /**
   * ROSTER de identidades inspeccionables en preview (#110·1, D1) — lo declara la instancia
   * (`MIRANDA_PREVIEW_IDENTITIES`), jamás el actor. Ausente o vacío ⇒ la feature NO existe: ni
   * `?as=`, ni links en el panel, ni campos nuevos en la tool (superficie cero).
   * Los `claims` viajan solo a la banda de la página `/compare`, que los NOMBRA: sin ellos la
   * verificación es una ficción no auditable (riesgo P1 del diseño). No van a la salida de la tool.
   */
  previewIdentities?: { label: string; user: string; claims?: Record<string, string[]> }[]
  /**
   * Renderiza el draft «como lo vería» la identidad del roster con esa etiqueta — mismo riel que
   * `renderPreviewHtml`, cambiando SOLO la identidad. Lanza si el label no está en el roster.
   * Cableado solo cuando hay roster: su ausencia ES la superficie cero de la feature.
   */
  renderPreviewHtmlAs?(draftYaml: string, label: string): Promise<string>
  /** Auditoría (log administrativo del server). Cada render impersonado emite un evento (D4). */
  audit?: (event: Record<string, unknown>) => void
  secret: string
  brandTitle?: string
  announce?: (message: string) => Promise<void>
}

/**
 * Capacidades válidas de un draft de Miranda: las del serving (el conector enforcing de la
 * instancia) más los canales de render/publicación que el catálogo de serving registra de verdad.
 *
 * Vive acá y no como literal en `serve-rls.ts` por dos razones. Primera, testeabilidad:
 * `serve-rls.ts` es un módulo con top-level `await` que no se puede importar desde un test, así que
 * la lista escrita ahí era inobservable. Segunda, y es la que importa: mientras fue inobservable
 * prometió dos capabilities de entrega por correo y por Slack que no existen en ninguna parte del
 * repo — Miranda validaba OK drafts que `Botler.register` rechazaba después con
 * `channel-capability-not-catalogued`. La lista no promete lo que el catálogo no registra, y hay un
 * test que lo mide (`tests/miranda-validate-caps.test.ts`).
 */
export const mirandaValidateCaps = (servingCaps: Iterable<string>): string[] => [
  ...servingCaps,
  'publicar-artefacto',
  'render-html-piece',
  'render-csv-piece',
]

/**
 * Identidad con la que se rinde una preview impersonada: los campos del roster TAL CUAL. NO se
 * enriquece desde `VERGIS_IDENTITY_MAP` — el roster es la única fuente de verdad de lo suplantado
 * (una impersonación a medias que se ve «verificada» es peor que ninguna). `agent` se pasa desde el
 * server para que sea el MISMO que produce el gate en un request real: así el render impersonado es
 * idéntico a lo que esa identidad vería de verdad.
 *
 * Vive acá (y no como literal en `serve-rls.ts`) por la razón de `mirandaValidateCaps`: `serve-rls.ts`
 * tiene top-level `await` y no se puede importar desde un test — escrito ahí, esto sería inobservable.
 */
export const previewIdentityFor = (entry: { user: string; claims?: Record<string, string[]> }, agent: string): IdentityContext => ({
  agent,
  user: entry.user,
  claims: { ...(entry.claims ?? {}) },
})

const STATE_LABEL: Record<string, string> = {
  explorando: 'Explorando',
  borrador: 'Borrador',
  validado: 'Validado',
  autochequeado: 'Auto-chequeado',
  publicado: 'Publicado',
  descartado: 'Descartado',
}

/** Solo identificador simple (anti-inyección en profile_column y en la proyección de sampleRows). */
const IDENT_RE = /^[A-Za-z0-9_]+$/

/** Normalización de email para comparar dueño vs requester (misma semántica que `normEmail` del
 *  store de gobierno: trim + lowercase). Local para no ampliar la superficie exportada del paquete. */
const normEmail = (e: string | undefined): string => (e ?? '').trim().toLowerCase()

export function createMiranda(deps: MirandaServerDeps): MirandaHandler {
  const csrf = csrfFactory(deps.secret)
  const pg = (title: string, body: string) => page(`${deps.brandTitle ?? 'Vergis'} · Miranda`, title, body)

  /** El roster EFECTIVO: la feature existe solo si la instancia declaró identidades Y el server
   *  cableó el render impersonado. Sin las dos cosas, `?as=`, `/compare`, los links del panel y los
   *  campos de la tool no existen (D1: superficie cero). */
  const roster = (): { label: string; user: string; claims?: Record<string, string[]> }[] =>
    deps.renderPreviewHtmlAs ? (deps.previewIdentities ?? []) : []
  const rosterHas = (label: string): boolean => roster().some((i) => i.label === label)

  /** Contexto de tools para una sesión + identidad. */
  function toolContext(sessionId: string, email: string | undefined): MirandaToolContext {
    const allowLeaf = new Set(deps.catalog.map((c) => c.name.split('.').pop()!.toLowerCase()))
    const isAllowed = (t: string): boolean => allowLeaf.has(t.split('.').pop()!.toLowerCase())
    return {
      catalog: deps.catalog,
      isAllowed,
      runProbe: async (sql, _why) => {
        try {
          return await deps.probe(sql, email)
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      },
      columnsOf: (table) => deps.columnsOf(table),
      /**
       * El plano de columna del objeto (#163 · H9). Tres estados y ninguno es «quizás»: sin dep
       * cableada, sin política para el objeto, o lectura que lanza ⇒ escudo DESCONOCIDO (el objeto no
       * se sondea). Con política ⇒ las columnas de sus `columnRules`.
       *
       * Las reglas se toman TODAS, sin mirar los claims de quien pregunta: la superficie de Miranda
       * no conoce claims (el gate le entrega un email, no un `ClaimSet`), así que usar
       * `maskedColumns(policy, claims)` acá exigiría inventar los claims — y un claim inventado es
       * exactamente el «inferir identidad» que el charter prohíbe. El superconjunto protege de más:
       * quien especifica un PI no necesita ver el valor de una columna sensible para especificarlo.
       */
      columnShield: async (table): Promise<ColumnShield> => {
        if (!deps.policyFor) return UNKNOWN_SHIELD
        try {
          const policy = deps.policyFor(table)
          if (!policy) return UNKNOWN_SHIELD
          return { known: true, columns: columnRules(policy).map((r) => r.column) }
        } catch {
          return UNKNOWN_SHIELD
        }
      },
      sampleRows: async (table, n, columns) => {
        // Proyección explícita: solo identificadores simples, y jamás vacía. El tool ya filtró por el
        // escudo; acá no se confía en él — lo que se interpola en SQL se valida donde se interpola.
        if (!columns.length) throw new Error('sampleRows exige al menos una columna sondeable.')
        const bad = columns.filter((c) => !IDENT_RE.test(c))
        if (bad.length) throw new Error(`Columna inválida en la proyección: ${bad.join(', ')}.`)
        const g = guardProbeSql(`SELECT ${columns.join(', ')} FROM ${table}`, { allowlist: deps.catalog.map((c) => c.name), topLimit: n })
        return (await deps.probe(g.sql, email)).rows
      },
      profileColumn: async (table, column, top) => {
        if (!IDENT_RE.test(column)) throw new Error(`Columna inválida: '${column}'.`)
        const g = guardProbeSql(`SELECT ${column} AS value, COUNT(*) AS count FROM ${table} GROUP BY ${column} ORDER BY COUNT(*) DESC`, {
          allowlist: deps.catalog.map((c) => c.name),
          topLimit: top,
        })
        const rows = (await deps.probe(g.sql, email)).rows
        return rows.map((r) => ({ value: r['value'], count: Number(r['count'] ?? 0) }))
      },
      listSpecs: () => deps.listSpecs(),
      readSpec: (code) => deps.readSpec(code),
      validateDraft: (yaml) => deps.validateDraft(yaml),
      saveDraft: async (yaml) => {
        const version = await deps.gov.appendMirandaArtifact(sessionId, 'spec_draft', yaml)
        const s = await deps.gov.getMirandaSession(sessionId)
        if (s?.state === 'explorando') await deps.gov.setMirandaState(sessionId, 'borrador')
        return { version }
      },
      updateIntent: async (summary: IntentSummary) => {
        const version = await deps.gov.appendMirandaArtifact(sessionId, 'intent_summary', JSON.stringify(summary))
        const s = await deps.gov.getMirandaSession(sessionId)
        if (s?.state === 'explorando') await deps.gov.setMirandaState(sessionId, 'borrador')
        // Cambiar el resumen invalida la validación (autochequeado/validado → borrador).
        if (s && (s.state === 'validado' || s.state === 'autochequeado')) await deps.gov.setMirandaState(sessionId, 'borrador')
        return { version }
      },
      createDataRequest: async (descripcion, tablasFaltantes) => {
        await deps.gov.appendMirandaArtifact(sessionId, 'data_request', JSON.stringify({ descripcion, tablasFaltantes }))
        return { ok: true }
      },
      renderPreview: async () => {
        const draft = await deps.gov.latestMirandaArtifact(sessionId, 'spec_draft')
        if (!draft) throw new Error('No hay draft para previsualizar.')
        const url = `/miranda/preview/${sessionId}`
        const list = roster()
        // Sin roster la salida es EXACTAMENTE la de siempre: el modelo no ve campos que no existen.
        if (!list.length) return { url }
        return {
          url,
          identities: list.map((i) => ({ label: i.label, url: `${url}?as=${encodeURIComponent(i.label)}` })),
          compare_url: `${url}/compare?a=me&b=${encodeURIComponent(list[0].label)}`,
        }
      },
      runSelfCheck: async () => {
        const draft = await deps.gov.latestMirandaArtifact(sessionId, 'spec_draft')
        if (!draft) throw new Error('No hay draft: compón uno con save_draft antes del self-check.')
        const intent = await deps.gov.latestMirandaArtifact(sessionId, 'intent_summary')
        const probeContext = await assembleProbeContext(deps.gov, sessionId)
        const report = await runSelfCheck({
          transport: deps.transport,
          model: deps.model,
          rubric: deps.rubric,
          draftYaml: draft.content,
          intentSummary: intent?.content ?? '(sin resumen de intención)',
          probeContext,
        })
        await deps.gov.appendMirandaArtifact(sessionId, 'qc_report', JSON.stringify(report))
        // Gate en código: validado + sin B/M → autochequeado.
        const s = await deps.gov.getMirandaSession(sessionId)
        if (s?.state === 'validado' && !hasBlockingGaps(report.brechas)) await deps.gov.setMirandaState(sessionId, 'autochequeado')
        return report
      },
    }
  }

  /** Resuelve la sesión y exige pertenencia (dueño o admin). Responde 404/403 él mismo y devuelve
   *  null si cortó; la ruta solo continúa con una sesión autorizada en la mano.
   *  Sesión sin `createdBy` (filas legadas) = solo-admin (fail-closed). */
  async function requireSession(sessionId: string, email: string, res: ServerResponse): Promise<MirandaSession | null> {
    const s = await deps.gov.getMirandaSession(sessionId)
    if (!s) {
      send(res, 404, pg('No encontrada', `<p class="msg err">Sesión no encontrada.</p><p><a href="/miranda">← Sesiones</a></p>`))
      return null
    }
    const owner = normEmail(s.createdBy)
    if (owner && owner === normEmail(email)) return s
    if (await deps.isAdmin(email)) return s
    send(res, 403, pg('Sin acceso', `<p class="msg err">Esta sesión pertenece a otra persona.</p><p><a href="/miranda">← Sesiones</a></p>`))
    return null
  }

  async function tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const rawUrl = req.url ?? '/'
    const path = rawUrl.split('?')[0].replace(/\/+$/, '') || '/miranda'
    if (path !== '/miranda' && !path.startsWith('/miranda/')) return false
    const query = new URLSearchParams(rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '')
    const email = (deps.identityOf(req.headers).user ?? '').toLowerCase()
    if (!(await deps.hasScope(email))) {
      send(res, 403, pg('Sin acceso', `<p class="msg err">No tienes el scope <code>miranda</code>. Pídeselo a un administrador.</p><p><a href="/">← Catálogo</a></p>`))
      return true
    }
    const token = csrf(email)
    try {
      // Preview (GET) — sirve el draft efímero por serve-rls con la identidad del request, o con la
      // de una etiqueta del roster (`?as=`) cuando la instancia lo declaró.
      const mPrev = path.match(/^\/miranda\/preview\/([^/]+)$/)
      if (mPrev && req.method === 'GET') {
        if (!(await requireSession(mPrev[1], email, res))) return true
        return await handlePreview(mPrev[1], req, res, query.get('as'), email)
      }
      // Comparador de dos identidades lado a lado — azúcar sobre `?as=`, sin lógica de datos propia.
      const mCmp = path.match(/^\/miranda\/preview\/([^/]+)\/compare$/)
      if (mCmp && req.method === 'GET' && roster().length) {
        if (!(await requireSession(mCmp[1], email, res))) return true
        return handleCompare(mCmp[1], res, query.get('a'), query.get('b'))
      }

      // Lista de sesiones.
      if (path === '/miranda' && req.method === 'GET') {
        send(res, 200, await listPage(email, token))
        return true
      }
      // Nueva sesión.
      if (path === '/miranda/api/new' && req.method === 'POST') {
        const f = await readForm(req)
        requireCsrf(f, token)
        const id = randomUUID()
        await deps.gov.createSession(id, (f['title'] ?? '').trim() || 'Sesión sin título', email)
        redirect(res, `/miranda/s/${id}`)
        return true
      }
      // Conversación.
      const mSess = path.match(/^\/miranda\/s\/([^/]+)$/)
      if (mSess && req.method === 'GET') {
        const s = await requireSession(mSess[1], email, res)
        if (!s) return true
        send(res, 200, await sessionPageOf(s, token))
        return true
      }
      // Turno del chat.
      const mMsg = path.match(/^\/miranda\/api\/s\/([^/]+)\/message$/)
      if (mMsg && req.method === 'POST') {
        const f = await readForm(req)
        requireCsrf(f, token)
        if (!(await requireSession(mMsg[1], email, res))) return true
        await handleMessage(mMsg[1], email, (f['text'] ?? '').trim())
        redirect(res, `/miranda/s/${mMsg[1]}`)
        return true
      }
      // Validar el resumen de intención (el usuario aprueba).
      const mVal = path.match(/^\/miranda\/api\/s\/([^/]+)\/validate-intent$/)
      if (mVal && req.method === 'POST') {
        const f = await readForm(req)
        requireCsrf(f, token)
        const s = await requireSession(mVal[1], email, res)
        if (!s) return true
        if (!(await deps.gov.latestMirandaArtifact(mVal[1], 'intent_summary'))) {
          send(res, 400, pg('Sin resumen', `<p class="msg err">Aún no hay un resumen de intención que validar.</p><p><a href="/miranda/s/${escapeHtml(mVal[1])}">← Volver</a></p>`))
          return true
        }
        if (s?.state === 'borrador') await deps.gov.setMirandaState(mVal[1], 'validado')
        redirect(res, `/miranda/s/${mVal[1]}`)
        return true
      }
      // Publicar.
      const mPub = path.match(/^\/miranda\/api\/s\/([^/]+)\/publish$/)
      if (mPub && req.method === 'POST') {
        const f = await readForm(req)
        requireCsrf(f, token)
        if (!(await requireSession(mPub[1], email, res))) return true
        return await handlePublish(mPub[1], res)
      }
      send(res, 404, pg('No encontrado', `<p class="msg err">Ruta no encontrada.</p>`))
      return true
    } catch (e) {
      if (e instanceof CsrfError) {
        send(res, 403, pg('Sesión expirada', `<p class="msg err">${escapeHtml(e.message)}</p>`))
        return true
      }
      send(res, 500, pg('Error', `<p class="msg err">${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`))
      return true
    }
  }

  // ── Acciones ──
  async function handleMessage(sessionId: string, email: string, text: string): Promise<void> {
    const session = await deps.gov.getMirandaSession(sessionId)
    if (!session || !text) return
    const history = reconstructHistory(await deps.gov.listMirandaMessages(sessionId))
    const tools = buildToolRegistry(toolContext(sessionId, email))
    const tokensUsedBefore = await deps.gov.mirandaSessionTokens(sessionId)
    try {
      const result = await runAgentTurn({
        transport: deps.transport,
        model: deps.model,
        system: deps.systemPrompt,
        tools,
        history,
        userMessage: text,
        maxTurns: deps.maxTurns,
        tokenBudget: deps.tokenBudget,
        tokensUsedBefore,
      })
      // Persistir los mensajes nuevos; los tokens del turno se anotan en el 1er mensaje (user).
      for (let i = 0; i < result.newMessages.length; i += 1) {
        const m = result.newMessages[i]
        const role = roleOf(m)
        await deps.gov.appendMirandaMessage(sessionId, role, JSON.stringify(m.content), i === 0 ? result.tokensUsed : 0)
      }
    } catch (e) {
      const note = e instanceof TokenBudgetExceeded ? e.message : `Error del sistema al conversar con Miranda: ${e instanceof Error ? e.message : String(e)}`
      await deps.gov.appendMirandaMessage(sessionId, 'user', JSON.stringify(text), 0)
      await deps.gov.appendMirandaMessage(sessionId, 'assistant', JSON.stringify([{ type: 'text', text: `⚠️ ${note}` }]), 0)
    }
  }

  async function handlePublish(sessionId: string, res: ServerResponse): Promise<boolean> {
    try {
      const result = await publishSpec(sessionId, {
        store: deps.gov,
        validateDraft: deps.validateDraft,
        writeSpec: deps.writeSpec,
        announce: deps.announce,
      })
      send(res, 200, pg('Publicado', `<p class="msg ok">Publicado como <code>${escapeHtml(result.code)}</code> (archivo <code>${escapeHtml(result.filename)}</code>). Ya lo sirve la plataforma.</p><p><a href="/${escapeHtml(result.slug)}">Ver el PI</a> · <a href="/miranda/s/${escapeHtml(sessionId)}">← Sesión</a></p>`))
      return true
    } catch (e) {
      if (e instanceof PublishBlocked) {
        send(res, 409, pg('No se puede publicar', `<p class="msg err">${escapeHtml(e.message)}</p><p><a href="/miranda/s/${escapeHtml(sessionId)}">← Volver</a></p>`))
        return true
      }
      throw e
    }
  }

  async function handlePreview(sessionId: string, req: IncomingMessage, res: ServerResponse, as: string | null, actor: string): Promise<boolean> {
    const draft = await deps.gov.latestMirandaArtifact(sessionId, 'spec_draft')
    if (!draft) {
      send(res, 404, pg('Sin draft', `<p class="msg err">No hay draft que previsualizar en esta sesión.</p>`))
      return true
    }
    // Sin roster, `?as=` se comporta como si el parámetro no existiera (superficie cero, D1).
    const impersonate = as && roster().length ? as : null
    let html: string
    if (impersonate) {
      if (!rosterHas(impersonate)) {
        send(res, 404, pg('Identidad no declarada', `<p class="msg err">La identidad de preview <code>${escapeHtml(impersonate)}</code> no está declarada en el roster de esta instancia.</p><p><a href="/miranda/s/${escapeHtml(sessionId)}">← Sesión</a></p>`))
        return true
      }
      // D4 — el actor REAL queda siempre en el registro: la impersonación es trazable por construcción.
      deps.audit?.({ type: 'miranda-preview-as', session: sessionId, actor, as: impersonate })
      html = await deps.renderPreviewHtmlAs!(draft.content, impersonate)
    } else {
      html = await deps.renderPreviewHtml(draft.content, req.headers)
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return true
  }

  /** Dos previews lado a lado. `me` = tu propia RLS; cualquier otro valor debe ser una etiqueta del
   *  roster. Cero lógica de datos: cada panel es un iframe a `/miranda/preview/:id[?as=…]`. */
  function handleCompare(sessionId: string, res: ServerResponse, a: string | null, b: string | null): boolean {
    const list = roster()
    const pick = (v: string | null, fallback: string): string => (v ?? fallback)
    const one = pick(a, 'me')
    const two = pick(b, list[0]?.label ?? 'me')
    for (const label of [one, two]) {
      if (label !== 'me' && !rosterHas(label)) {
        send(res, 404, pg('Identidad no declarada', `<p class="msg err">La identidad de preview <code>${escapeHtml(label)}</code> no está declarada en el roster de esta instancia.</p><p><a href="/miranda/s/${escapeHtml(sessionId)}">← Sesión</a></p>`))
        return true
      }
    }
    const panel = (label: string): string => {
      const it = list.find((i) => i.label === label)
      const who = label === 'me' ? 'Tu identidad (tu RLS)' : `${escapeHtml(label)} · ${escapeHtml(it?.user ?? '')}`
      const claims = label === 'me' || !it?.claims ? '' : `<div class="sub">${escapeHtml(Object.entries(it.claims).map(([c, v]) => `${c}=${v.join('|')}`).join(' · ')) || 'sin claims'}</div>`
      const src = label === 'me' ? `/miranda/preview/${encodeURIComponent(sessionId)}` : `/miranda/preview/${encodeURIComponent(sessionId)}?as=${encodeURIComponent(label)}`
      return `<div style="flex:1;min-width:320px;display:flex;flex-direction:column">
        <div style="padding:8px 12px;border:1px solid var(--border);border-radius:8px 8px 0 0;background:var(--card)"><b>${who}</b>${claims}</div>
        <iframe src="${src}" title="${escapeHtml(label)}" style="width:100%;height:70vh;border:1px solid var(--border);border-top:0;border-radius:0 0 8px 8px;background:#fff"></iframe>
      </div>`
    }
    send(
      res,
      200,
      pg(
        'Comparar identidades',
        `<p><a href="/miranda/s/${escapeHtml(sessionId)}">← Sesión</a></p>
         <p class="sub">El mismo draft por el riel RLS real, rendido con dos identidades. Los claims de cada etiqueta son los que declaró la instancia.</p>
         <div style="display:flex;gap:16px;flex-wrap:wrap">${panel(one)}${panel(two)}</div>`,
      ),
    )
    return true
  }

  // ── Páginas ──
  async function listPage(email: string, token: string): Promise<string> {
    const sessions = await deps.gov.listMirandaSessions(email)
    const rows = sessions
      .map(
        (s) =>
          `<tr><td><a href="/miranda/s/${escapeHtml(s.id)}">${escapeHtml(s.title)}</a></td><td><span class="tag">${escapeHtml(STATE_LABEL[s.state] ?? s.state)}</span></td><td>${escapeHtml(s.piCode ?? '—')}</td></tr>`,
      )
      .join('')
    return pg(
      'Miranda',
      `<p class="sub">Conversa y Miranda escribe la especificación. Tú validas el resumen de intención, nunca el YAML.</p>
       <form method="post" action="/miranda/api/new" class="row">
         <input type="hidden" name="_csrf" value="${token}">
         <input name="title" placeholder="Título del PI nuevo" style="min-width:260px">
         <button class="add">Nueva sesión</button>
       </form>
       <h2>Tus sesiones</h2>
       <table><thead><tr><th>Sesión</th><th>Estado</th><th>PI</th></tr></thead><tbody>${rows || `<tr><td colspan="3" class="sub">Aún no tienes sesiones.</td></tr>`}</tbody></table>`,
    )
  }

  /** Página de la sesión — recibe la sesión YA resuelta y autorizada por `requireSession`. */
  async function sessionPageOf(s: MirandaSession, token: string): Promise<string> {
    const sessionId = s.id
    const messages = await deps.gov.listMirandaMessages(sessionId)
    const chat = renderChat(messages)
    const intentArt = await deps.gov.latestMirandaArtifact(sessionId, 'intent_summary')
    const qc = await deps.gov.latestMirandaArtifact(sessionId, 'qc_report')
    const draft = await deps.gov.latestMirandaArtifact(sessionId, 'spec_draft')
    const intentPanel = renderIntentPanel(intentArt?.content, s, token, sessionId, qc?.content, draft?.content)
    const composer = s.state === 'publicado'
      ? `<p class="sub">Sesión publicada como <code>${escapeHtml(s.piCode ?? '')}</code>.</p>`
      : `<form method="post" action="/miranda/api/s/${escapeHtml(sessionId)}/message" class="grid">
           <input type="hidden" name="_csrf" value="${token}">
           <textarea name="text" rows="3" placeholder="Escríbele a Miranda…" style="width:100%;resize:vertical" required></textarea>
           <button class="add">Enviar</button>
         </form>`
    return pg(
      escapeHtml(s.title),
      `<p><a href="/miranda">← Sesiones</a> · <span class="tag">${escapeHtml(STATE_LABEL[s.state] ?? s.state)}</span></p>
       <div style="display:flex;gap:24px;flex-wrap:wrap">
         <div style="flex:1;min-width:320px">
           <h2>Conversación</h2>
           ${chat}
           ${composer}
         </div>
         <div style="flex:1;min-width:320px">${intentPanel}</div>
       </div>`,
    )
  }

  /** Links de preview del panel. Sin roster: exactamente el link de siempre (superficie cero). Con
   *  roster: «Ver con tu RLS» + un link por etiqueta + el comparador de dos identidades. */
  function renderPreviewLinks(sessionId: string): string {
    const base = `/miranda/preview/${encodeURIComponent(sessionId)}`
    const mine = `<a href="${base}" target="_blank">Ver preview (con tu RLS) ↗</a>`
    const list = roster()
    if (!list.length) return `<p>${mine}</p>`
    const opts = (sel: string): string =>
      [`<option value="me">tu identidad</option>`, ...list.map((i) => `<option value="${escapeHtml(i.label)}"${i.label === sel ? ' selected' : ''}>${escapeHtml(i.label)}</option>`)].join('')
    const links = list
      .map((i) => `<li><a href="${base}?as=${encodeURIComponent(i.label)}" target="_blank">Ver como <b>${escapeHtml(i.label)}</b> (${escapeHtml(i.user)}) ↗</a></li>`)
      .join('')
    return `<p>${mine}</p>
      <div class="l">Ver como otra identidad (roster de la instancia)</div>
      <ul>${links}</ul>
      <form method="get" action="${base}/compare" target="_blank" class="row">
        <select name="a">${opts('')}</select>
        <select name="b">${opts(list[0].label)}</select>
        <button class="add">Comparar…</button>
      </form>`
  }

  function renderIntentPanel(intentJson: string | undefined, s: MirandaSession, token: string, sessionId: string, qcJson?: string, draftYaml?: string): string {
    let summary = '<p class="sub">Aún no hay un resumen de intención. Sigue conversando con Miranda.</p>'
    if (intentJson) {
      try {
        const it = JSON.parse(intentJson) as IntentSummary
        summary = `<div class="tile" style="min-width:auto">
          <div class="l">Título</div><div>${escapeHtml(it.titulo)}</div>
          <div class="l" style="margin-top:8px">Pregunta de negocio</div><div>${escapeHtml(it.pregunta_de_negocio)}</div>
          <div class="l" style="margin-top:8px">Audiencia</div><div>${escapeHtml(it.audiencia)}</div>
          <div class="l" style="margin-top:8px">Grano</div><div>${escapeHtml(it.grano)}</div>
          ${it.medidas.length ? `<div class="l" style="margin-top:8px">Medidas</div><ul>${it.medidas.map((m) => `<li>${escapeHtml(m.nombre)}: ${escapeHtml(m.definicion)}</li>`).join('')}</ul>` : ''}
          ${it.vistas?.length ? `<div class="l" style="margin-top:8px">Forma por vista</div><ul>${it.vistas.map((v) => `<li>${escapeHtml(v.nombre || 'Vista')}: <b>${escapeHtml(v.forma)}</b>${v.piezas?.length ? ` (${escapeHtml(v.piezas.join(', '))})` : ''}</li>`).join('')}</ul>` : ''}
          ${it.pendientes_de_datos.length ? `<div class="l" style="margin-top:8px">Pendientes de datos</div><ul>${it.pendientes_de_datos.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : ''}
        </div>`
      } catch {
        summary = '<p class="msg err">Resumen de intención ilegible.</p>'
      }
    }
    const validateBtn =
      s.state === 'borrador' && intentJson
        ? `<form method="post" action="/miranda/api/s/${escapeHtml(sessionId)}/validate-intent"><input type="hidden" name="_csrf" value="${token}"><button class="add">Esto es lo que quiero</button></form>`
        : ''
    let qcPanel = ''
    if (qcJson) {
      try {
        const r = JSON.parse(qcJson) as { veredicto: string; brechas: { id: string; sev: string; brecha: string; recomendacion: string }[] }
        qcPanel = `<h2>Self-check</h2><p>Veredicto: <span class="tag">${escapeHtml(r.veredicto)}</span></p>${r.brechas.length ? `<ul>${r.brechas.map((b) => `<li><b>${escapeHtml(b.sev)}</b> ${escapeHtml(b.brecha)} — ${escapeHtml(b.recomendacion)}</li>`).join('')}</ul>` : '<p class="sub">Sin brechas.</p>'}`
      } catch {
        /* ignore */
      }
    }
    const publishBtn =
      s.state === 'autochequeado'
        ? `<form method="post" action="/miranda/api/s/${escapeHtml(sessionId)}/publish"><input type="hidden" name="_csrf" value="${token}"><button class="add">Publicar</button></form>`
        : ''
    const preview = draftYaml ? renderPreviewLinks(sessionId) : ''
    const dslToggle = draftYaml
      ? `<details style="margin-top:12px"><summary class="sub">ver DSL (read-only)</summary><pre style="overflow:auto;background:var(--card);padding:12px;border-radius:8px;font-size:12px">${escapeHtml(draftYaml)}</pre></details>`
      : ''
    return `<h2>Resumen de intención</h2>${summary}${validateBtn}${preview}${qcPanel}${publishBtn}${dslToggle}`
  }

  return { tryHandle }
}

// ── Helpers puros ──

/** Rol de almacenamiento de un mensaje Anthropic: los tool_result (role user + bloques tool_result)
 *  se guardan como `tool` para reconstruirlos bien; texto de usuario como `user`. */
function roleOf(m: AnthropicMessage): 'user' | 'assistant' | 'tool' {
  if (m.role === 'assistant') return 'assistant'
  if (Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')) return 'tool'
  return 'user'
}

/** Reconstruye el historial Anthropic desde las filas del store. */
export function reconstructHistory(rows: { role: string; content: string }[]): AnthropicMessage[] {
  return rows.map((r) => {
    const content = safeParse(r.content)
    const role: 'user' | 'assistant' = r.role === 'assistant' ? 'assistant' : 'user'
    return { role, content } as AnthropicMessage
  })
}

function safeParse(s: string): string | AnthropicMessage['content'] {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

/** Renderiza la conversación (muestra texto de user/assistant; las tools van compactas). */
function renderChat(rows: { role: string; content: string }[]): string {
  const bubbles = rows
    .map((r) => {
      const c = safeParse(r.content)
      if (r.role === 'tool') {
        return `<div class="sub" style="margin:6px 0">⚙️ (resultado de herramienta)</div>`
      }
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => (b as { type: string }).type === 'text').map((b) => (b as { text: string }).text).join('\n') : ''
      const who = r.role === 'assistant' ? 'Miranda' : 'Tú'
      const bg = r.role === 'assistant' ? 'var(--card)' : 'transparent'
      if (!text.trim() && Array.isArray(c) && c.some((b) => (b as { type: string }).type === 'tool_use')) {
        return `<div class="sub" style="margin:6px 0">🔧 Miranda usó una herramienta…</div>`
      }
      return `<div style="margin:8px 0;padding:10px 12px;border-radius:10px;background:${bg};border:1px solid var(--border)"><b>${who}:</b> ${escapeHtml(text)}</div>`
    })
    .join('')
  return bubbles || '<p class="sub">Sin mensajes aún. Dile a Miranda qué PI quieres crear.</p>'
}

/** Ensambla el contexto de realizabilidad para el self-check desde los tool_result de la sesión
 *  (probes/perfiles): el guard anti-`'TC '`. Toma los resultados de run_probe/profile_column/describe_table. */
async function assembleProbeContext(gov: MirandaStore, sessionId: string): Promise<string> {
  const rows = await gov.listMirandaMessages(sessionId)
  const chunks: string[] = []
  for (const r of rows) {
    if (r.role !== 'tool') continue
    try {
      const blocks = JSON.parse(r.content) as { type: string; content?: string }[]
      for (const b of blocks) {
        if (b.type === 'tool_result' && typeof b.content === 'string') {
          const parsed = JSON.parse(b.content) as Record<string, unknown>
          if ('rows' in parsed || 'values' in parsed || 'sample' in parsed || 'columns' in parsed) {
            chunks.push(b.content)
          }
        }
      }
    } catch {
      /* fila no estructurada: se ignora */
    }
  }
  return chunks.slice(-12).join('\n')
}


/**
 * Resuelve la política de una tabla del catálogo de Miranda contra el policy store del nodo.
 *
 * El problema es que las dos superficies no nombran igual: el store se llama por referencia
 * calificada (`schema.tabla`), y el catálogo de Miranda puede traer la tabla pelada. Resolver mal
 * acá no produce un error: produce un **escudo vacío**, o sea sondeo en claro de una columna
 * protegida. Por eso las tres ramas son explícitas y la del medio es la única que adivina:
 *
 *   · Coincidencia EXACTA → esa.
 *   · Sufijo `.<tabla>` con UN solo candidato → ése. Es la única inferencia, y es segura porque no
 *     hay a quién confundir.
 *   · Cero candidatos, o VARIOS → `undefined`, que aguas arriba significa **escudo desconocido y
 *     nada se sondea**. La ambigüedad NO se desempata: dos schemas con la misma tabla y distinta
 *     política es exactamente el caso donde elegir mal sirve el dato equivocado.
 */
export function resolvePolicyFor(store: Map<string, PolicyDecl>, table: string): PolicyDecl | undefined {
  const exacta = store.get(table)
  if (exacta) return exacta
  if (table.includes('.')) return undefined // ya venía calificada: si no está, no está
  const sufijo = `.${table.toLowerCase()}`
  const candidatos = [...store.keys()].filter((k) => k.toLowerCase().endsWith(sufijo))
  return candidatos.length === 1 ? store.get(candidatos[0]) : undefined
}
