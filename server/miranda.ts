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
  /** Ejecuta una probe (SQL ya guardado) con la identidad del autor. */
  probe(sql: string, email: string | undefined): Promise<{ rows: Record<string, unknown>[] }>
  /** Columnas+tipos de un objeto del catálogo. */
  columnsOf(table: string): Promise<{ name: string; type: string }[]>
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
}

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
  const pg = (title: string, body: string, bodyClass = '') => page(`${deps.brandTitle ?? 'Vergis'} · Miranda`, title, body, bodyClass)

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
      sampleRows: async (table, n) => {
        const g = guardProbeSql(`SELECT * FROM ${table}`, { allowlist: deps.catalog.map((c) => c.name), topLimit: n })
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
    const s = await deps.gov.getMirandaSession(sessionId)
    if (!s) return pg('No encontrada', `<p class="msg err">Sesión no encontrada.</p>`)
    const messages = await deps.gov.listMirandaMessages(sessionId)
    const chat = renderChat(messages, { youInitials: youInitialsOf(email) })
    const intentArt = await deps.gov.latestMirandaArtifact(sessionId, 'intent_summary')
    const qc = await deps.gov.latestMirandaArtifact(sessionId, 'qc_report')
    const draft = await deps.gov.latestMirandaArtifact(sessionId, 'spec_draft')
    const intentPanel = renderIntentPanel(intentArt?.content, s, token, sessionId, qc?.content, draft?.content)
    const composer = s.state === 'publicado'
      ? `<div class="mir-composer"><p class="sub">Sesión publicada como <code>${escapeHtml(s.piCode ?? '')}</code>.</p></div>`
      : `<div class="mir-composer">
           <form method="post" action="/miranda/api/s/${escapeHtml(sessionId)}/message" class="mir-send">
             <input type="hidden" name="_csrf" value="${token}">
             <textarea name="text" rows="2" placeholder="Escríbele a Miranda…" required></textarea>
             <button class="add">Enviar</button>
           </form>
         </div>`
    // El sidebar es discreto mientras no haya un resumen de intención que mostrar.
    const intentEmpty = !intentArt
    const convInner = `<h2>Conversación</h2>
           <div class="mir-thread">${chat}</div>
           ${composer}`
    return pg(
      s.title,
      `<p><a href="/miranda">← Sesiones</a> · <span class="tag">${escapeHtml(STATE_LABEL[s.state] ?? s.state)}</span></p>
       ${renderMirCols(convInner, intentPanel, intentEmpty)}`,
      'chat',
    )
  }

  return { tryHandle }
}

/**
 * Panel de intención de la sesión: «Resumen de intención» (título + resumen + validar + preview),
 * self-check, publicar y el DSL, apilados como tarjeta **plana** (no hay disclosure envolvente — el
 * plegado ahora es de la COLUMNA entera, ver `renderMirCols`). Función pura (server-rendered, cero JS). */
export function renderIntentPanel(
  intentJson: string | undefined,
  s: MirandaSession,
  token: string,
  sessionId: string,
  qcJson?: string,
  draftYaml?: string,
): string {
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
  const preview = draftYaml ? `<p><a href="/miranda/preview/${escapeHtml(sessionId)}" target="_blank">Ver preview (con tu RLS) ↗</a></p>` : ''
  const dslToggle = draftYaml
    ? `<details style="margin-top:12px"><summary class="sub">ver DSL (read-only)</summary><pre style="overflow:auto;background:var(--card);padding:12px;border-radius:8px;font-size:12px">${escapeHtml(draftYaml)}</pre></details>`
    : ''
  return `<h2>Resumen de intención</h2>${summary}${validateBtn}${preview}${qcPanel}${publishBtn}${dslToggle}`
}

/**
 * Ensambla la grilla de dos columnas (conversación + sidebar de intención) con el mecanismo de
 * **plegado de la columna derecha**, CSS-only: un `<input type="checkbox">` oculto (accesible por
 * teclado) más `<label>` como botón; `:has(> .col-toggle:checked)` en `PAGE_CSS` dirige el grid a una
 * sola columna y oculta el sidebar, de modo que la conversación se expande a ancho completo. Dos
 * afordancias `<label for>`: «Ocultar ›» dentro del sidebar (visible al expandir) y una pestaña
 * «‹ Intención» fija al borde derecho (visible solo al colapsar, para reabrir). Cero JS.
 * El estado NO persiste entre turnos (cada envío recarga la página → default expandido). */
export function renderMirCols(convInner: string, asideInner: string, intentEmpty: boolean): string {
  const id = 'mir-col-toggle'
  const emptyCls = intentEmpty ? ' mir-intent--empty' : ''
  return `<div class="mir-cols">
         <input type="checkbox" class="col-toggle" id="${id}" aria-label="Plegar u ocultar la columna de intención">
         <section class="mir-conv">${convInner}</section>
         <aside class="mir-intent${emptyCls}"><label for="${id}" class="mir-collapse-btn" title="Ocultar la columna de intención">Ocultar ›</label>${asideInner}</aside>
         <label for="${id}" class="mir-reopen" title="Mostrar la columna de intención">‹ Intención</label>
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
 * NO soporta links/imágenes/HTML embebido (superficie de ataque innecesaria para el texto de Miranda).
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

/** Formateo inline (negrita, código) sobre texto YA escapado. El código se protege primero para que
 *  un `**` dentro de un backtick no se interprete como negrita. */
function formatSpans(escaped: string): string {
  const codes: string[] = []
  // 2a) proteger spans de codigo con un centinela del area de uso privado Unicode (U+E000/U+E001):
  //     no colisiona con digitos del texto y no sobrevive como HTML. El contenido va verbatim en <code>.
  let s = escaped.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code)
    return `\uE000${codes.length - 1}\uE001`
  })
  // 2b) negrita.
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
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
export function renderChat(rows: { role: string; content: string }[], opts: { youInitials?: string } = {}): string {
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
    parts.push(
      `<div class="turn turn--${side}"><div class="av2" aria-hidden="true">${escapeHtml(ini)}</div><div class="turn-b"><div class="cap">${who}</div><div class="bubble">${mdInline(text)}</div></div></div>`,
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
