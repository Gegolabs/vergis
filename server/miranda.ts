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
import {
  runAgentTurn,
  runSelfCheck,
  publishSpec,
  PublishBlocked,
  TokenBudgetExceeded,
  buildToolRegistry,
  guardProbeSql,
  probeableNames,
  hasBlockingGaps,
  type AnthropicTransport,
  type AnthropicMessage,
  type MirandaToolContext,
  type CatalogEntry,
  type SpecRef,
  type IntentSummary,
} from '@vergis/miranda'
import { page, readForm, redirect, send, csrfFactory, requireCsrf, CsrfError } from './ui'

export interface MirandaHandler {
  tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
  /** Espera a que terminen los turnos en background en curso (seam de tests + apagado ordenado). */
  whenIdle(): Promise<void>
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
  /** `max_tokens` por llamada al modelo (tope de emisión). undefined ⇒ default del paquete (16384).
   *  Un tope corto trunca la emisión (thinking + draft en una llamada) → el loop lo trata como
   *  incidente visible, jamás como fin silencioso. */
  maxTokensPerCall?: number
  catalog: CatalogEntry[]
  /** Conexiones (`database_ref`) configuradas en este despliegue — el conjunto contra el que se decide
   *  si una fuente servible es sondeable AQUÍ (una cuyo ref no esté acá cae en el camino educativo). */
  configuredRefs: string[]
  /** Identidad del request (email del gate). */
  identityOf(headers: IncomingMessage['headers']): { user?: string }
  /** ¿La identidad tiene el scope `miranda`? (admin o miembro del grupo de scope). */
  hasScope(email: string | undefined): Promise<boolean>
  /** Ejecuta una probe (SQL ya guardado) con la identidad del autor, ruteada a `databaseRef`
   *  (undefined ⇒ el default global del despliegue). */
  probe(sql: string, email: string | undefined, databaseRef?: string): Promise<{ rows: Record<string, unknown>[] }>
  /** Columnas+tipos de un objeto del catálogo, ruteado a `databaseRef` (undefined ⇒ default global). */
  columnsOf(table: string, databaseRef?: string): Promise<{ name: string; type: string }[]>
  /** Valida un draft contra el DSL (schema + capabilities de instancia). */
  validateDraft(yaml: string): { ok: true } | { ok: false; error: string }
  listSpecs(): SpecRef[]
  readSpec(code: string): string | null
  /** Escribe la spec publicada al SPECS_DIR (hot-reload la levanta). */
  writeSpec(filename: string, content: string): Promise<void>
  /** Renderiza un draft efímero por el riel serve-rls con la identidad del request (RLS real). */
  renderPreviewHtml(draftYaml: string, headers: IncomingMessage['headers']): Promise<string>
  secret: string
  brandTitle?: string
  announce?: (message: string) => Promise<void>
  /** Umbral (ms) tras el cual un marcador de turno se considera huérfano (proceso reiniciado a mitad
   *  de turno). Default 10 min: mayor que un turno legítimo (que puede tardar varios minutos). */
  orphanTurnMs?: number
}

/** Marcador viejo que ningún proceso vivo sostiene ⇒ huérfano. Default 10 min. */
const DEFAULT_ORPHAN_TURN_MS = 10 * 60_000

const STATE_LABEL: Record<string, string> = {
  explorando: 'Explorando',
  borrador: 'Borrador',
  validado: 'Validado',
  autochequeado: 'Auto-chequeado',
  publicado: 'Publicado',
  descartado: 'Descartado',
}

/** Solo identificador simple (anti-inyección en profile_column). */
const IDENT_RE = /^[A-Za-z0-9_]+$/

export function createMiranda(deps: MirandaServerDeps): MirandaHandler {
  const csrf = csrfFactory(deps.secret)
  const pg = (title: string, body: string, bodyClass = '', headExtra = '') =>
    page(`${deps.brandTitle ?? 'Vergis'} · Miranda`, title, body, bodyClass, headExtra)
  const orphanTurnMs = deps.orphanTurnMs ?? DEFAULT_ORPHAN_TURN_MS
  // Turnos in-process en vuelo por sesión (fire-and-forget). Seam de `whenIdle` para tests + apagado.
  const inflight = new Map<string, Promise<void>>()
  /** Texto del error de sistema estándar (mismo prefijo ⚠️ que el resto). */
  const systemError = (note: string): string => JSON.stringify([{ type: 'text', text: `⚠️ ${note}` }])

  /** Contexto de tools para una sesión + identidad. */
  function toolContext(sessionId: string, email: string | undefined): MirandaToolContext {
    // Allowlist de la guardia = SOLO las fuentes gestionadas (probeables). Las tools ya rechazan por
    // nivel antes de llegar acá (defensa en profundidad); la guardia lo re-afirma sobre el SQL.
    const probeable = probeableNames(deps.catalog)
    return {
      catalog: deps.catalog,
      configuredRefs: deps.configuredRefs,
      runProbe: async (sql, _why, databaseRef) => {
        try {
          return await deps.probe(sql, email, databaseRef)
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      },
      columnsOf: (table, databaseRef) => deps.columnsOf(table, databaseRef),
      sampleRows: async (table, n, databaseRef) => {
        const g = guardProbeSql(`SELECT * FROM ${table}`, { allowlist: probeable, topLimit: n })
        return (await deps.probe(g.sql, email, databaseRef)).rows
      },
      profileColumn: async (table, column, top, databaseRef) => {
        if (!IDENT_RE.test(column)) throw new Error(`Columna inválida: '${column}'.`)
        const g = guardProbeSql(`SELECT ${column} AS value, COUNT(*) AS count FROM ${table} GROUP BY ${column} ORDER BY COUNT(*) DESC`, {
          allowlist: probeable,
          topLimit: top,
        })
        const rows = (await deps.probe(g.sql, email, databaseRef)).rows
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
      createDataRequest: async (descripcion, tablasFaltantes, opts) => {
        await deps.gov.appendMirandaArtifact(
          sessionId,
          'data_request',
          JSON.stringify({ descripcion, tablasFaltantes, nivel: opts?.nivel, accionDeCierre: opts?.accionDeCierre }),
        )
        return { ok: true }
      },
      renderPreview: async () => {
        const draft = await deps.gov.latestMirandaArtifact(sessionId, 'spec_draft')
        if (!draft) throw new Error('No hay draft para previsualizar.')
        return { url: `/miranda/preview/${sessionId}` }
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
          configuredRefs: deps.configuredRefs, // cruce en código: database_ref inexistente → brecha B
          catalog: deps.catalog, // cruce en código: pertenencia objeto↔ref según catálogo (addendum 3) → brecha B
        })
        await deps.gov.appendMirandaArtifact(sessionId, 'qc_report', JSON.stringify(report))
        // Gate en código: validado + sin B/M → autochequeado.
        const s = await deps.gov.getMirandaSession(sessionId)
        if (s?.state === 'validado' && !hasBlockingGaps(report.brechas)) await deps.gov.setMirandaState(sessionId, 'autochequeado')
        return report
      },
    }
  }

  async function tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/miranda'
    if (path !== '/miranda' && !path.startsWith('/miranda/')) return false
    const email = (deps.identityOf(req.headers).user ?? '').toLowerCase()
    if (!(await deps.hasScope(email))) {
      send(res, 403, pg('Sin acceso', `<p class="msg err">No tienes el scope <code>miranda</code>. Pídeselo a un administrador.</p><p><a href="/">← Catálogo</a></p>`))
      return true
    }
    const token = csrf(email)
    try {
      // Preview (GET) — sirve el draft efímero por serve-rls con la identidad del request.
      const mPrev = path.match(/^\/miranda\/preview\/([^/]+)$/)
      if (mPrev && req.method === 'GET') return await handlePreview(mPrev[1], req, res)

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
        send(res, 200, await sessionPage(mSess[1], email, token))
        return true
      }
      // Turno del chat.
      const mMsg = path.match(/^\/miranda\/api\/s\/([^/]+)\/message$/)
      if (mMsg && req.method === 'POST') {
        const f = await readForm(req)
        requireCsrf(f, token)
        await handleMessage(mMsg[1], email, (f['text'] ?? '').trim())
        redirect(res, `/miranda/s/${mMsg[1]}`)
        return true
      }
      // Validar el resumen de intención (el usuario aprueba).
      const mVal = path.match(/^\/miranda\/api\/s\/([^/]+)\/validate-intent$/)
      if (mVal && req.method === 'POST') {
        const f = await readForm(req)
        requireCsrf(f, token)
        const s = await deps.gov.getMirandaSession(mVal[1])
        if (s && !(await deps.gov.latestMirandaArtifact(mVal[1], 'intent_summary'))) {
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
  /**
   * Turno ASÍNCRONO: persiste el mensaje del usuario + marca «turno en proceso» y dispara el
   * procesamiento en background (promise in-process, NO bloqueante) — el POST puede redirigir de
   * inmediato. Guardas: un solo turno por sesión (si ya hay uno en curso, no-op → el POST solo
   * redirige a la página que muestra «pensando»); watchdog de huérfanos antes de decidir.
   */
  async function handleMessage(sessionId: string, email: string, text: string): Promise<void> {
    const session = await deps.gov.getMirandaSession(sessionId)
    if (!session || !text) return
    if (session.state === 'publicado') return
    const fresh = await reapOrphan(session)
    // Un-turno-por-sesión: si ya hay un turno vivo, este POST no arranca otro (el composer ya sale
    // deshabilitado; esto cubre el caso de una recarga o un doble-submit).
    if (fresh.turnState === 'procesando') return
    await startTurn(sessionId, email, text)
  }

  /** Arranca el turno: captura el historial (ANTES de persistir el mensaje nuevo, para no duplicarlo
   *  en el contexto del modelo), persiste el mensaje del usuario, marca el turno y despacha el fondo. */
  async function startTurn(sessionId: string, email: string, text: string): Promise<void> {
    const history = reconstructHistory(await deps.gov.listMirandaMessages(sessionId))
    const tokensUsedBefore = await deps.gov.mirandaSessionTokens(sessionId)
    await deps.gov.appendMirandaMessage(sessionId, 'user', JSON.stringify(text), 0)
    await deps.gov.beginMirandaTurn(sessionId)
    const p = runTurnBackground(sessionId, email, text, history, tokensUsedBefore)
    inflight.set(sessionId, p)
    p.finally(() => {
      if (inflight.get(sessionId) === p) inflight.delete(sessionId)
    }).catch(() => {})
  }

  /** Procesamiento del turno en background: exactamente lo que antes corría inline (`runAgentTurn` +
   *  persistencia). El mensaje del usuario YA está persistido, así que se omite el 1er `newMessage`.
   *  El error (incluido presupuesto agotado) se persiste como error de sistema — nunca se pierde. Al
   *  terminar (éxito o error) limpia el marcador de turno (jamás un «pensando» eterno). */
  async function runTurnBackground(
    sessionId: string,
    email: string,
    text: string,
    history: AnthropicMessage[],
    tokensUsedBefore: number,
  ): Promise<void> {
    const t0 = Date.now() // cronómetro del turno (plan 100 addendum 5): mide cuánto tarda este mensaje
    try {
      const tools = buildToolRegistry(toolContext(sessionId, email))
      const result = await runAgentTurn({
        transport: deps.transport,
        model: deps.model,
        system: deps.systemPrompt,
        tools,
        history,
        userMessage: text,
        maxTurns: deps.maxTurns,
        tokenBudget: deps.tokenBudget,
        maxTokensPerCall: deps.maxTokensPerCall, // tope de emisión (plan 100 addendum 2)
        tokensUsedBefore,
        onEvent: (e) => {
          // Fase visible del turno (addendum 4): cada tool_use proyecta a una frase de negocio que el
          // meta-refresh pinta en la burbuja «pensando». Fire-and-forget: la fase jamás bloquea ni
          // rompe el turno (un fallo del marcador se ignora; la burbuja cae al default).
          if (e.type !== 'tool_use') return
          const name = String((e.detail as { name?: unknown } | undefined)?.name ?? '')
          const phase = turnPhaseOf(name)
          // El índice canónico hace que el marcador avance en ALTO-AGUA (el store gatea monotónico):
          // un rebote del pipeline a una fase anterior no retrocede el stepper (plan 101 etapa A).
          if (phase) void deps.gov.setMirandaTurnPhase(sessionId, phase, phaseIndex(phase)).catch(() => {})
        },
      })
      // El mensaje del usuario (newMessages[0]) ya está persistido; se anotan los del asistente/tool.
      // Los tokens del turno se anclan en el 1er mensaje persistido (el usuario quedó en 0); la
      // DURACIÓN se ancla en el ÚLTIMO (la burbuja visible del assistant), para que la medición viva
      // CON el mensaje que midió. Cubre éxito y disculpa por max_tokens (esta vuelve dentro de `result`).
      const rest = result.newMessages.slice(1)
      for (let i = 0; i < rest.length; i += 1) {
        const m = rest[i]
        const isLast = i === rest.length - 1
        await deps.gov.appendMirandaMessage(sessionId, roleOf(m), JSON.stringify(m.content), i === 0 ? result.tokensUsed : 0, isLast ? Date.now() - t0 : undefined)
      }
    } catch (e) {
      const note = e instanceof TokenBudgetExceeded ? e.message : `Error del sistema al conversar con Miranda: ${e instanceof Error ? e.message : String(e)}`
      await deps.gov.appendMirandaMessage(sessionId, 'assistant', systemError(note), 0, Date.now() - t0)
    } finally {
      try {
        await deps.gov.endMirandaTurn(sessionId)
      } catch {
        /* el marcador se reapará por watchdog si el store falló acá */
      }
    }
  }

  /** Watchdog de huérfanos: un marcador «procesando» más viejo que `orphanTurnMs` sin un turno vivo
   *  en `inflight` (proceso reiniciado a mitad de turno) se considera muerto → limpia el marcador y
   *  persiste el error de sistema estándar. Devuelve la sesión fresca (con el marcador ya limpio). */
  async function reapOrphan(session: MirandaSession): Promise<MirandaSession> {
    if (session.turnState !== 'procesando') return session
    if (inflight.has(session.id)) return session // turno vivo en este proceso: no es huérfano
    const startedAt = session.turnStartedAt ? Date.parse(session.turnStartedAt) : NaN
    const age = Number.isNaN(startedAt) ? Infinity : Date.now() - startedAt
    if (age < orphanTurnMs) return session // aún dentro de la ventana: se deja pensar
    await deps.gov.endMirandaTurn(session.id)
    await deps.gov.appendMirandaMessage(
      session.id,
      'assistant',
      systemError('Error del sistema: el turno se interrumpió (posible reinicio del servidor). Vuelve a enviar tu mensaje.'),
      0,
    )
    return (await deps.gov.getMirandaSession(session.id)) ?? session
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

  async function handlePreview(sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const draft = await deps.gov.latestMirandaArtifact(sessionId, 'spec_draft')
    if (!draft) {
      send(res, 404, pg('Sin draft', `<p class="msg err">No hay draft que previsualizar en esta sesión.</p>`))
      return true
    }
    const html = await deps.renderPreviewHtml(draft.content, req.headers)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
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

  async function sessionPage(sessionId: string, email: string, token: string): Promise<string> {
    const s0 = await deps.gov.getMirandaSession(sessionId)
    if (!s0) return pg('No encontrada', `<p class="msg err">Sesión no encontrada.</p>`)
    // Watchdog: si el marcador quedó huérfano (reinicio a mitad de turno), se reapa acá antes de pintar.
    const s = await reapOrphan(s0)
    const pending = s.turnState === 'procesando'
    const messages = await deps.gov.listMirandaMessages(sessionId)
    let chat = renderChat(messages, { youInitials: youInitialsOf(email) })
    // Mientras piensa: el mensaje del usuario ya está en el hilo; se añade la burbuja «pensando» con
    // la fase actual del turno y el reloj corriendo (cada meta-refresh los re-lee — feedback ocasional,
    // no solo «…»). El transcurrido se calcula desde turn_started_at (NaN/ausente → sin reloj).
    if (pending) {
      const startedMs = s.turnStartedAt ? Date.parse(s.turnStartedAt) : NaN
      const elapsedMs = Number.isNaN(startedMs) ? undefined : Date.now() - startedMs
      chat += thinkingBubble(s.turnPhase, elapsedMs)
    }
    const intentArt = await deps.gov.latestMirandaArtifact(sessionId, 'intent_summary')
    const qc = await deps.gov.latestMirandaArtifact(sessionId, 'qc_report')
    const draft = await deps.gov.latestMirandaArtifact(sessionId, 'spec_draft')
    // Aside = LIENZO (el reporte embebido, protagonista) + ficha técnica (sustento, secundaria) +
    // presupuesto (maquinaria). El «Publicar» y el link «desprendido» viven junto al lienzo.
    const canvas = renderCanvas(sessionId, s, token, draft?.content)
    const fichaPanel = renderIntentPanel(intentArt?.content, s, token, sessionId, qc?.content, draft?.content)
    const tokensUsed = await deps.gov.mirandaSessionTokens(sessionId)
    const aside = `${canvas}${fichaPanel}${renderBudgetLine(tokensUsed, deps.tokenBudget)}`
    let composer: string
    if (s.state === 'publicado') {
      composer = `<div class="mir-composer"><p class="sub">Sesión publicada como <code>${escapeHtml(s.piCode ?? '')}</code>.</p></div>`
    } else if (pending) {
      // Composer DESHABILITADO mientras hay turno en proceso (un-turno-por-sesión).
      composer = `<div class="mir-composer mir-composer--busy">
           <p class="mir-busy-note">Miranda está respondiendo… la página se actualiza sola.</p>
           <div class="mir-send" aria-disabled="true">
             <textarea rows="2" placeholder="Miranda está respondiendo…" disabled></textarea>
             <button class="add" disabled>Enviar</button>
           </div>
         </div>`
    } else {
      composer = `<div class="mir-composer">
           <form method="post" action="/miranda/api/s/${escapeHtml(sessionId)}/message" class="mir-send">
             <input type="hidden" name="_csrf" value="${token}">
             <textarea name="text" rows="2" placeholder="Escríbele a Miranda…" required></textarea>
             <button class="add">Enviar</button>
           </form>
         </div>`
    }
    // El aside se lee «vacío» (borde punteado) mientras no haya reporte que mostrar como lienzo.
    const intentEmpty = !draft
    const convInner = `<h2>Conversación</h2>
           <div class="mir-thread">${chat}</div>
           ${composer}`
    // Meta-refresh SOLO en estado pendiente (cuando no hay turno, cero refresh — no molestar).
    const headExtra = pending ? `<meta http-equiv="refresh" content="4">` : ''
    return pg(
      s.title,
      `<p><a href="/miranda">← Sesiones</a> · <span class="tag">${escapeHtml(STATE_LABEL[s.state] ?? s.state)}</span></p>
       ${renderMirCols(convInner, aside, intentEmpty)}`,
      'chat',
      headExtra,
    )
  }

  return {
    tryHandle,
    whenIdle: async () => {
      await Promise.allSettled([...inflight.values()])
    },
  }
}

/**
 * Proyección tool → fase visible del turno, en VOZ DE NEGOCIO (plan 100 addendum 4). Coarse a
 * propósito: el usuario oye QUÉ está pasando en sus términos, jamás el nombre de la maquinaria.
 * Un tool fuera del mapa NO cambia la fase (se conserva la previa; no inventar).
 */
const TOOL_PHASE: Record<string, string> = {
  catalog_tables: 'Revisando la información disponible…',
  describe_table: 'Revisando la información disponible…',
  profile_column: 'Revisando la información disponible…',
  run_probe: 'Revisando la información disponible…',
  update_intent_summary: 'Armando el reporte…',
  save_draft: 'Armando el reporte…',
  run_self_check: 'Cuadrando las cifras…',
  render_preview: 'Preparando la vista previa…',
}

/** La fase de negocio de un tool del loop, o undefined si el tool no proyecta fase (no se cambia). */
export function turnPhaseOf(toolName: string): string | undefined {
  return TOOL_PHASE[toolName]
}

/**
 * ORDEN CANÓNICO de las fases del pipeline (plan 101 etapa A) — FUENTE ÚNICA para el stepper. `phrase`
 * es exactamente el valor que proyecta `TOOL_PHASE` (así el mapeo fase→índice es directo); `label` es
 * la etiqueta corta del stepper (voz de negocio, sin jerga). El pipeline NO es estrictamente monotónico
 * (el modelo rebota entre fases), por eso el marcador de fase avanza en alto-agua y el stepper nunca
 * retrocede visualmente.
 */
export const PHASE_STEPS: readonly { phrase: string; label: string }[] = [
  { phrase: 'Revisando la información disponible…', label: 'Explorando' },
  { phrase: 'Armando el reporte…', label: 'Armando' },
  { phrase: 'Cuadrando las cifras…', label: 'Cuadrando' },
  { phrase: 'Preparando la vista previa…', label: 'Vista previa' },
]

/** Índice canónico de una fase (por su frase), o -1 si no hay fase aún / no reconocida («Pensando…»). */
export function phaseIndex(phase?: string): number {
  if (!phase) return -1
  return PHASE_STEPS.findIndex((s) => s.phrase === phase)
}

/**
 * Stepper de progreso (plan 101 etapa A), CSS-only. `activeIdx` = índice de ALTO-AGUA alcanzado (no la
 * fase instantánea): pasos previos = cumplidos, actual = activo, siguientes = pendientes. `activeIdx=-1`
 * (aún sin fase) → todos pendientes. Decorativo (`aria-hidden`): la semántica la lleva el `aria-label`
 * de la burbuja (frase + reloj). Sin JS.
 */
export function renderStepper(activeIdx: number): string {
  const chips: string[] = []
  PHASE_STEPS.forEach((s, i) => {
    if (i > 0) chips.push('<span class="mir-sep" aria-hidden="true">→</span>')
    const state = i < activeIdx ? 'is-done' : i === activeIdx ? 'is-active' : 'is-pending'
    chips.push(`<span class="mir-step ${state}">${escapeHtml(s.label)}</span>`)
  })
  return `<div class="mir-stepper" aria-hidden="true">${chips.join('')}</div>`
}

/**
 * Formato compacto de una duración: <60s → «47s»; ≥60s → «1m 05s» (segundos con cero a la izquierda).
 * Un cronómetro es lenguaje universal, no jerga: no viola VOZ. Entrada inválida (NaN/negativa) → «0s».
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}m ${String(sec).padStart(2, '0')}s`
}

/** Burbuja «pensando» de Miranda: indicador sobrio con puntos animados (CSS-only, cero JS). La FRASE
 *  de fase (voz de negocio) acompaña a los puntos; con `elapsedMs`, un reloj corriendo junto a la fase
 *  («Cuadrando las cifras… · 1m 12s»), que el meta-refresh de 4 s avanza en saltos. Sin fase → «Pensando…»;
 *  sin `elapsedMs` (o NaN) → solo la fase, nunca «NaN». */
export function thinkingBubble(phase?: string, elapsedMs?: number): string {
  const label = phase && phase.trim() ? phase.trim() : 'Pensando…'
  const clock = elapsedMs != null && Number.isFinite(elapsedMs) && elapsedMs >= 0 ? fmtDuration(elapsedMs) : ''
  const shown = clock ? `${label} · ${clock}` : label
  const clockHtml = clock ? ` <span class="mir-clock sub">· ${escapeHtml(clock)}</span>` : ''
  // Stepper de progreso (plan 101 etapa A) sobre la frase; el marcador de fase ya viene en alto-agua
  // (monotónico en el store), así que su índice canónico ilumina «el más avanzado alcanzado».
  const stepper = renderStepper(phaseIndex(phase))
  return `<div class="turn turn--miranda mir-thinking"><div class="av2" aria-hidden="true">M</div><div class="turn-b"><div class="cap">Miranda</div>${stepper}<div class="bubble" role="status" aria-label="Miranda: ${escapeHtml(shown)}"><span class="mir-phase">${escapeHtml(label)}</span>${clockHtml} <span class="mir-dots" aria-hidden="true"><i></i><i></i><i></i></span></div></div></div>`
}

/** Compacta un conteo de tokens a una etiqueta corta: 407000 → «407k», 4000000 → «4M». */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(Math.max(0, Math.trunc(n)))
}

/** Línea de presupuesto de la sesión (maquinaria — vive en la gaveta). Acento de advertencia sobre 80%. */
export function renderBudgetLine(used: number, budget: number): string {
  if (!budget || budget <= 0) return ''
  const warn = used / budget >= 0.8
  return `<div class="mir-budget${warn ? ' mir-budget--warn' : ''}"><span>Uso de la sesión</span><span><b>${fmtTokens(used)}</b> / ${fmtTokens(budget)}</span></div>`
}

/** Nombre canónico del panel de sustento a demanda (plan 101 etapa B). En UN solo lugar por si se
 *  renombra (César lo confirmó, pero puede cambiar tras verlo vivo). */
export const FICHA_TECNICA = 'Ficha técnica'

/**
 * «Ficha técnica» (plan 101 etapa B): el sustento a demanda de la sesión. Un disclosure CERRADO por
 * defecto (CSS-only, cero JS) con tres secciones legibles — **Intención** (resumen + «Esto es lo que
 * quiero», mudado adentro por decisión de César), **Verificación** (self-check) y **Definición técnica**
 * (el DSL). Guarda la JUSTIFICACIÓN, no las ACCIONES: «Publicar» y el link al reporte quedan FUERA de la
 * ficha, en la superficie principal. Función pura (server-rendered). */
export function renderIntentPanel(
  intentJson: string | undefined,
  s: MirandaSession,
  token: string,
  sessionId: string,
  qcJson?: string,
  draftYaml?: string,
): string {
  // Sección INTENCIÓN (+ el botón «Esto es lo que quiero» — mudado adentro, decisión de César).
  let intencion = '<p class="sub">Aún no hay un resumen de intención. Sigue conversando con Miranda.</p>'
  if (intentJson) {
    try {
      const it = JSON.parse(intentJson) as IntentSummary
      intencion = `<div class="tile" style="min-width:auto">
        <div class="l">Título</div><div>${escapeHtml(it.titulo)}</div>
        <div class="l" style="margin-top:8px">Pregunta de negocio</div><div>${escapeHtml(it.pregunta_de_negocio)}</div>
        <div class="l" style="margin-top:8px">Audiencia</div><div>${escapeHtml(it.audiencia)}</div>
        <div class="l" style="margin-top:8px">Grano</div><div>${escapeHtml(it.grano)}</div>
        ${it.medidas.length ? `<div class="l" style="margin-top:8px">Medidas</div><ul>${it.medidas.map((m) => `<li>${escapeHtml(m.nombre)}: ${escapeHtml(m.definicion)}</li>`).join('')}</ul>` : ''}
        ${it.vistas?.length ? `<div class="l" style="margin-top:8px">Forma por vista</div><ul>${it.vistas.map((v) => `<li>${escapeHtml(v.nombre || 'Vista')}: <b>${escapeHtml(v.forma)}</b>${v.piezas?.length ? ` (${escapeHtml(v.piezas.join(', '))})` : ''}</li>`).join('')}</ul>` : ''}
        ${it.pendientes_de_datos.length ? `<div class="l" style="margin-top:8px">Pendientes de datos</div><ul>${it.pendientes_de_datos.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : ''}
      </div>`
    } catch {
      intencion = '<p class="msg err">Resumen de intención ilegible.</p>'
    }
  }
  const validateBtn =
    s.state === 'borrador' && intentJson
      ? `<form method="post" action="/miranda/api/s/${escapeHtml(sessionId)}/validate-intent"><input type="hidden" name="_csrf" value="${token}"><button class="add">Esto es lo que quiero</button></form>`
      : ''
  const seccionIntencion = `<section class="mir-ficha-sec"><h3>Intención</h3>${intencion}${validateBtn}</section>`

  // Sección VERIFICACIÓN (self-check): solo si ya corrió.
  let seccionVerificacion = ''
  if (qcJson) {
    try {
      const r = JSON.parse(qcJson) as { veredicto: string; brechas: { id: string; sev: string; brecha: string; recomendacion: string }[] }
      seccionVerificacion = `<section class="mir-ficha-sec"><h3>Verificación</h3><p>Veredicto: <span class="tag">${escapeHtml(r.veredicto)}</span></p>${r.brechas.length ? `<ul>${r.brechas.map((b) => `<li><b>${escapeHtml(b.sev)}</b> ${escapeHtml(b.brecha)} — ${escapeHtml(b.recomendacion)}</li>`).join('')}</ul>` : '<p class="sub">Sin brechas.</p>'}</section>`
    } catch {
      /* ignore */
    }
  }

  // Sección DEFINICIÓN TÉCNICA (el DSL): el detalle técnico vive AQUÍ, a demanda (escotilla técnica).
  const seccionDefinicion = draftYaml
    ? `<section class="mir-ficha-sec"><h3>Definición técnica</h3><pre class="mir-ficha-dsl">${escapeHtml(draftYaml)}</pre></section>`
    : ''

  // La ficha técnica: disclosure CERRADO por defecto (CSS-only). Guarda la JUSTIFICACIÓN, no las
  // acciones — «Publicar» y el link al reporte viven junto al LIENZO (`renderCanvas`, plan 101 etapa C).
  return `<details class="mir-ficha"><summary class="mir-ficha-sum">${escapeHtml(FICHA_TECNICA)}</summary><div class="mir-ficha-body">${seccionIntencion}${seccionVerificacion}${seccionDefinicion}</div></details>`
}

/**
 * LIENZO (plan 101 etapa C): el reporte generado es el protagonista de la 2ª columna. Se embebe por el
 * MISMO riel RLS (`/miranda/preview/<sid>`, mismo-origen) en un `<iframe>` — la request del iframe lleva
 * las cookies del proxy y su identidad se deriva de sus propios headers (`identityFor(req.headers)` en
 * `handlePreview`/`renderPreviewHtml`), IDÉNTICA a la del standalone: cero canal lateral, misma RLS.
 * Un link «desprendido» (`target="_blank"`) abre el reporte standalone. «Publicar» se reubica aquí, en la
 * superficie principal. Sin draft aún → placeholder sobrio (NO la ficha). Server-render, cero JS.
 */
export function renderCanvas(sessionId: string, s: MirandaSession, token: string, draftYaml?: string): string {
  const sid = escapeHtml(sessionId)
  if (!draftYaml) {
    return `<div class="mir-canvas-empty"><p class="sub">El reporte aparecerá aquí cuando esté listo.</p></div>`
  }
  const iframe = `<iframe class="mir-canvas" src="/miranda/preview/${sid}" title="Reporte" loading="lazy"></iframe>`
  const detach = `<a class="mir-canvas-detach" href="/miranda/preview/${sid}" target="_blank" rel="noopener noreferrer">Abrir desprendido ↗</a>`
  const publishBtn =
    s.state === 'autochequeado'
      ? `<form method="post" action="/miranda/api/s/${sid}/publish"><input type="hidden" name="_csrf" value="${token}"><button class="add">Publicar</button></form>`
      : ''
  return `${iframe}<div class="mir-canvas-actions">${detach}${publishBtn}</div>`
}

/**
 * Ensambla la grilla (conversación + **gaveta** de intención) con el mecanismo de **plegado de la
 * columna derecha**, CSS-only: un `<input type="checkbox">` oculto (accesible por teclado) más
 * `<label>` como controles; `:has(> .col-toggle:checked)` en `PAGE_CSS` dirige el grid a una sola
 * columna y oculta la gaveta, de modo que la conversación se expande a ancho completo.
 * La columna derecha se **lee como una gaveta** (convención de plataforma «cara = estado · gaveta =
 * maquinaria», work/093): un **divisor vertical punteado** (`.mir-divider`) la separa de la
 * conversación, y el control de plegado vive como **tirador sobre ese divisor** (`.mir-drawer-pull`,
 * chevron `›` = cerrar la gaveta) — no dentro de la tarjeta de intención, que queda limpia. Colapsada,
 * queda el **divisor punteado fijo al borde derecho con su tirador** (`.mir-reopen`, chevron `‹` =
 * abrir), leyéndose como una gaveta cerrada. Cero JS.
 * El estado NO persiste entre turnos (cada envío recarga la página → default expandido). */
export function renderMirCols(convInner: string, asideInner: string, intentEmpty: boolean): string {
  const id = 'mir-col-toggle'
  const emptyCls = intentEmpty ? ' mir-intent--empty' : ''
  return `<div class="mir-cols">
         <input type="checkbox" class="col-toggle" id="${id}" aria-label="Abrir o cerrar la gaveta de intención">
         <section class="mir-conv">${convInner}</section>
         <div class="mir-divider"><label for="${id}" class="mir-drawer-pull" title="Cerrar la gaveta de intención"><span aria-hidden="true">›</span></label></div>
         <aside class="mir-intent${emptyCls}">${asideInner}</aside>
         <label for="${id}" class="mir-reopen" title="Abrir la gaveta de intención"><span class="mir-reopen-tab" aria-hidden="true">‹</span></label>
       </div>`
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

/** Extrae el texto de usuario/asistente de un contenido de mensaje ya parseado. */
function extractText(c: string | AnthropicMessage['content']): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .filter((b) => (b as { type: string }).type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
  }
  return ''
}

/** ¿Es esta fila una señal de traza de herramienta (a colapsar)? Un `tool_result` (role `tool`),
 *  o un turno del asistente que SOLO usó herramientas (tool_use sin texto para el usuario). */
function isToolSignal(role: string, c: string | AnthropicMessage['content']): boolean {
  if (role === 'tool') return true
  if (role === 'assistant' && Array.isArray(c)) {
    const hasToolUse = c.some((b) => (b as { type: string }).type === 'tool_use')
    return hasToolUse && !extractText(c).trim()
  }
  return false
}

/** Cuenta los `tool_use` (pasos reales de herramienta) en un contenido de mensaje. */
function countToolUse(c: string | AnthropicMessage['content']): number {
  if (!Array.isArray(c)) return 0
  return c.filter((b) => (b as { type: string }).type === 'tool_use').length
}

/**
 * Renderiza un subconjunto SEGURO de Markdown inline. Regla de oro: **escapar HTML primero,
 * formatear después** — el texto del modelo jamás puede inyectar HTML/JS. Soporta negrita `**x**`,
 * código `` `x` ``, párrafos (doble salto → `<p>`), saltos simples (`<br>`) y listas (`- `/`N. `).
 * Soporta links `[texto](url)` con un ALLOWLIST DE ESQUEMAS duro (solo relativa mismo-origen `/…` o
 * `http(s):`; el resto degrada a texto plano — ver `isSafeLinkUrl`). NO soporta imágenes ni HTML
 * embebido (esa superficie de ataque sigue cerrada).
 */
export function mdInline(raw: string): string {
  const escaped = escapeHtml(raw) // 1) escapar SIEMPRE primero
  const paragraphs = escaped.split(/\n{2,}/)
  return paragraphs
    .map((para) => {
      const lines = para.split('\n')
      const isUl = lines.length > 0 && lines.every((l) => /^\s*-\s+/.test(l))
      const isOl = lines.length > 0 && lines.every((l) => /^\s*\d+\.\s+/.test(l))
      if (isUl) {
        return `<ul>${lines.map((l) => `<li>${formatSpans(l.replace(/^\s*-\s+/, ''))}</li>`).join('')}</ul>`
      }
      if (isOl) {
        return `<ol>${lines.map((l) => `<li>${formatSpans(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`
      }
      return `<p>${formatSpans(para).replace(/\n/g, '<br>')}</p>`
    })
    .join('')
}

/**
 * ¿La URL de un link markdown es SEGURA de renderizar? Allowlist DURA (default-deny): SOLO
 *  - relativa mismo-origen que empiece con una sola `/` (p. ej. `/miranda/preview/…`; NO `//host`
 *    protocol-relative, que escaparía del origen), o
 *  - `http:` / `https:` absoluta.
 * Todo lo demás (`javascript:`, `data:`, `vbscript:`, `file:`, `mailto:`, esquemas raros) → false, y el
 *  link se degrada a texto plano (jamás se emite `<a>` ni se expone la URL cruda). La URL llega YA
 *  escapada por HTML; acá se decide sobre su forma, no se re-escapa. */
function isSafeLinkUrl(escapedUrl: string): boolean {
  const u = escapedUrl.trim()
  if (u.startsWith('/') && !u.startsWith('//')) return true // relativa mismo-origen
  return /^https?:\/\//i.test(u)
}

/** Formateo inline (negrita, código, links con allowlist) sobre texto YA escapado. El código y los
 *  links se protegen con centinela ANTES de la negrita, para que un `**` o un `](url)` dentro de un
 *  backtick no se reinterprete y para no romper el escapado. */
function formatSpans(escaped: string): string {
  const codes: string[] = []
  // 2a) proteger spans de codigo con un centinela del area de uso privado Unicode (U+E000/U+E001):
  //     no colisiona con digitos del texto y no sobrevive como HTML. El contenido va verbatim en <code>.
  let s = escaped.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code)
    return `\uE000${codes.length - 1}\uE001`
  })
  // 2b) links markdown `[texto](url)` con ALLOWLIST de esquemas. Se resuelven ANTES de la negrita y se
  //     protegen con su propio centinela (U+E002/U+E003) para que un `**` en el texto del link siga
  //     funcionando y para no re-tocar el `href`. URL fuera del allowlist → texto plano (sin `<a>`).
  const links: string[] = []
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    const label = String(text)
    if (!isSafeLinkUrl(url)) return label // degradar a texto plano; NO exponer la url cruda como link
    const external = /^https?:\/\//i.test(url.trim())
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : ''
    links.push(`<a href="${url}"${attrs}>${label}</a>`)
    return `\uE002${links.length - 1}\uE003`
  })
  // 2c) negrita (opera sobre el label del link ya protegido — un **[x](/r)** funciona).
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // 2d) restaurar los links (su label pudo ganar <strong>; se restaura tras la negrita).
  s = s.replace(/\uE002(\d+)\uE003/g, (_m, i) => links[Number(i)])
  // 2c) restaurar los spans de codigo.
  s = s.replace(/\uE000(\d+)\uE001/g, (_m, i) => `<code>${codes[Number(i)]}</code>`)
  return s
}

/** Iniciales (≤2 chars) para el avatar de «Tú», derivadas del email como el menú de identidad.
 *  Sin email → 'Tú'. */
export function youInitialsOf(email: string | undefined): string {
  const local = (email ?? '').split('@')[0]
  if (!local) return 'Tú'
  const parts = local.split(/[._-]/).filter(Boolean)
  const ini = (parts.slice(0, 2).map((p) => p[0]).join('') || local[0] || '').toUpperCase()
  return ini || 'Tú'
}

/** Renderiza la conversación como un chat: burbujas con lado (Tú a la derecha con tinte accent,
 *  Miranda a la izquierda sobre `--card`), nombre como caption chico y avatar. Texto con Markdown
 *  seguro (`mdInline`); las trazas de herramientas consecutivas se colapsan en UNA señal discreta. */
export function renderChat(rows: { role: string; content: string; durationMs?: number }[], opts: { youInitials?: string } = {}): string {
  const youIni = opts.youInitials ?? 'Tú'
  const parts: string[] = []
  let i = 0
  while (i < rows.length) {
    const r = rows[i]
    const c = safeParse(r.content)
    // Colapsar una racha de señales de herramienta en UN disclosure `<details>`: el `<summary>` es la
    // señal discreta (separador con el conteo); el cuerpo, abierto a demanda, muestra el detalle por paso.
    if (isToolSignal(r.role, c)) {
      let steps = 0
      const runContents: (string | AnthropicMessage['content'])[] = []
      while (i < rows.length) {
        const cc = safeParse(rows[i].content)
        if (!isToolSignal(rows[i].role, cc)) break
        steps += countToolUse(cc)
        runContents.push(cc)
        i += 1
      }
      if (steps === 0) steps = runContents.length
      const label = `🔧 Miranda exploró los datos (${steps} ${steps === 1 ? 'paso' : 'pasos'})`
      parts.push(
        `<details class="trace-d"><summary class="trace"><span class="chev" aria-hidden="true">▸</span><span>${label}</span></summary><div class="trace-body">${renderTraceDetail(runContents)}</div></details>`,
      )
      continue
    }
    const text = extractText(c)
    const isMiranda = r.role === 'assistant'
    const side = isMiranda ? 'miranda' : 'you'
    const who = isMiranda ? 'Miranda' : 'Tú'
    const ini = isMiranda ? 'M' : youIni
    // Meta discreto bajo la burbuja del assistant: cuánto tardó ese mensaje (plan 100 addendum 5).
    const meta = isMiranda && r.durationMs != null && Number.isFinite(r.durationMs) ? `<div class="mir-took sub">Respondido en ${escapeHtml(fmtDuration(r.durationMs))}</div>` : ''
    parts.push(
      `<div class="turn turn--${side}"><div class="av2" aria-hidden="true">${escapeHtml(ini)}</div><div class="turn-b"><div class="cap">${who}</div><div class="bubble">${mdInline(text)}</div>${meta}</div></div>`,
    )
    i += 1
  }
  return parts.join('') || '<p class="mir-empty">Sin mensajes aún. Dile a Miranda qué PI quieres crear.</p>'
}

// Topes de truncado del detalle de traza: los resultados de un probe pueden traer cientos de filas y
// un SQL puede ser largo; se muestra lo suficiente para entender el paso, no el volcado completo.
const TRACE_RESULT_MAX = 800
const TRACE_INPUT_MAX = 600

/** Trunca un string a `max` caracteres, con marca explícita de corte. */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… (truncado)` : s
}

/**
 * Detalle expandible de una racha de herramientas: un bloque por paso con el `name` de la tool, sus
 * argumentos clave (p. ej. `sql`/`why` de run_probe, `name` de describe_table) y el resultado truncado.
 * REGLA DE SEGURIDAD (igual que `mdInline`): TODO (nombres, inputs, results) se **escapa con `escapeHtml`**
 * — es dato del QA, no markup; un `<script>` en un tool_result queda neutralizado, jamás como etiqueta real.
 */
export function renderTraceDetail(contents: (string | AnthropicMessage['content'])[]): string {
  const uses: { id: string; name: string; input: unknown }[] = []
  const results = new Map<string, string>()
  for (const c of contents) {
    if (!Array.isArray(c)) continue
    for (const b of c) {
      const blk = b as { type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }
      if (blk.type === 'tool_use') {
        uses.push({ id: blk.id ?? '', name: blk.name ?? '(herramienta)', input: blk.input })
      } else if (blk.type === 'tool_result') {
        results.set(blk.tool_use_id ?? '', typeof blk.content === 'string' ? blk.content : JSON.stringify(blk.content))
      }
    }
  }
  if (uses.length === 0) return '<p class="sub" style="margin:0">Sin detalle de pasos.</p>'
  return uses
    .map((u) => {
      const res = results.get(u.id)
      const resHtml =
        res !== undefined ? `<span class="trace-k">resultado</span><pre>${escapeHtml(truncate(res, TRACE_RESULT_MAX))}</pre>` : ''
      return `<div class="trace-step"><div class="trace-tool"><code>${escapeHtml(u.name)}</code></div>${renderTraceInput(u.input)}${resHtml}</div>`
    })
    .join('')
}

/** Argumentos de un tool_use como pares clave→valor escapados (string verbatim; el resto, JSON). */
function renderTraceInput(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input !== 'object') {
    return `<pre>${escapeHtml(truncate(String(input), TRACE_INPUT_MAX))}</pre>`
  }
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) return ''
  return entries
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
      return `<span class="trace-k">${escapeHtml(k)}</span><pre>${escapeHtml(truncate(val, TRACE_INPUT_MAX))}</pre>`
    })
    .join('')
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
