/**
 * Superficie HTTP de la CONSOLA SQL (issue #306) — el ingeniero elige un Conector registrado,
 * escribe T-SQL, lo ejecuta y ve el resultset **viendo exactamente las filas y columnas que un PI de
 * Mira le mostraría a él, jamás más**. Regla rectora del issue: *«la Consola acota, nunca amplía»*.
 *
 * Lo que garantiza eso NO está en este archivo, y decirlo importa porque es donde la tentación vive:
 * acá no hay lista negra de palabras, ni regex de tablas, ni detector de `sp_set_session_context`.
 * Todos ésos son coladores (`EXEC('DR'+'OP …')`, `sp_executesql`, `OPENROWSET`, vistas) y darían una
 * falsa sensación de seguridad. Lo que garantiza es el MOTOR: los permisos del principal de consola
 * y `@read_only` sobre las claves del claim — medidos por Conector al arrancar
 * (`engines/fabric.ts#verificarConectorConsola`), fail-closed, misma doctrina que
 * `verifyFabricServability`.
 *
 * Este módulo pone lo que sí es suyo: el scope de la superficie, el CSRF, los topes de ejecución, el
 * log append-only con el ACTOR REAL del gate, y la página.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { escapeHtml, vtCsvCell, xlsxUnaHoja, type ConsolaResultado, type SqlConnectionProfile } from '@vergis/capabilities'
import { AppendOnlyLog } from '@vergis/botler'
import type { IdentityContext } from '@vergis/botler'
import type { ConsolaConfig } from './config'
import type { ConsolaConectorEstado } from './engines/fabric'
import { PAGE_CSS, csrfFactory, requireCsrf, CsrfError } from './ui'
import { readJsonBody } from './http-util'

export interface ConsolaHandler {
  tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
}

/** Una tabla del árbol de esquema, leída BAJO EL PRINCIPAL DE CONSOLA (muestra lo que ése ve). */
export interface EsquemaTabla {
  tabla: string
  columnas: { nombre: string; tipo: string }[]
}

export interface ConsolaDeps {
  config: ConsolaConfig
  /** Identidad del gate: `user` + `claims`. JAMÁS se lee un actor del body. */
  identityOf(headers: IncomingMessage['headers']): IdentityContext
  /** ¿Tiene el scope de la capacidad? (admin ∨ miembro del grupo declarado). */
  hasScope(email: string | undefined): Promise<boolean>
  /** ¿Es admin de plataforma? (solo para leer el historial de otra persona). */
  isAdmin(email: string | undefined): Promise<boolean>
  secret: string
  /** Estado VIVO del gate por Conector (`validate-before-swap`, como `piState`). */
  estado(): Map<string, ConsolaConectorEstado>
  /** Base de datos de cada ref (para mostrarla en la bandeja). */
  databaseDe(ref: string): string | undefined
  ejecutar(input: { ref: string; sql: string }, identity: IdentityContext, signal: AbortSignal): Promise<ConsolaResultado>
  esquema(ref: string): Promise<EsquemaTabla[]>
  log: ConsolaLog
  brandTitle?: string
  /** Menú de avatar ya renderizado para esta identidad (el marco de la plataforma). */
  avatar?(email: string): Promise<string>
}

// ═══ I4 · el log append-only de la Consola ═══════════════════════════════════════════════════════
//
// Archivo PROPIO (`consola-audit.log`), no el del admin: son familias distintas, con volúmenes y
// lectores distintos, y un archivo por familia permite podar o rotar la consola sin tocar la cadena
// de la auditoría administrativa.

export interface ConsolaLog {
  inicio(e: { actor: string; ref: string; sql: string; claims: string[] }): void
  fin(e: {
    actor: string
    ref: string
    sql: string
    claims: string[]
    inicio: string
    duracionMs: number
    estado: 'ok' | 'error' | 'timeout' | 'cancelado'
    filas: number
    truncado: boolean
    recordsets: number
    error: string | null
  }): void
  historial(limite: number, actor?: string): HistorialEntrada[]
}

export interface HistorialEntrada {
  ts: string
  actor: string
  ref: string
  sql: string
  estado: string
  filas: number
  duracionMs: number
  error: string | null
}

/**
 * Abre el log. `claims` guarda los NOMBRES de los claims inyectados, **jamás sus valores**: el valor
 * de un claim es un dato de la persona (su área, su cargo, su nodo) y la regla ya rige en el serving
 * (`serve-rls.ts`: se nombra el claim, nunca su valor).
 */
export function createConsolaLog(path: string, leerArchivo: (p: string) => string = (p) => readFileSync(p, 'utf8')): ConsolaLog {
  const log = new AppendOnlyLog(path, undefined, { retain: false })
  return {
    inicio(e) {
      log.append({ type: 'consola-inicio', ...e })
    },
    fin(e) {
      log.append({ type: 'consola-ejecucion', ...e })
    },
    historial(limite, actor) {
      let texto: string
      try {
        texto = leerArchivo(path)
      } catch {
        return [] // el archivo aún no existe: historial vacío, no un error
      }
      const salida: HistorialEntrada[] = []
      const lineas = texto.split('\n')
      // De atrás hacia adelante: lo último ejecutado es lo primero que interesa.
      for (let i = lineas.length - 1; i >= 0 && salida.length < limite; i -= 1) {
        const l = lineas[i]!.trim()
        if (!l) continue
        try {
          const e = JSON.parse(l) as Record<string, unknown>
          if (e['type'] !== 'consola-ejecucion') continue
          if (actor && String(e['actor'] ?? '').toLowerCase() !== actor.toLowerCase()) continue
          salida.push({
            ts: String(e['ts'] ?? ''),
            actor: String(e['actor'] ?? ''),
            ref: String(e['ref'] ?? ''),
            sql: String(e['sql'] ?? ''),
            estado: String(e['estado'] ?? ''),
            filas: Number(e['filas'] ?? 0),
            duracionMs: Number(e['duracionMs'] ?? 0),
            error: e['error'] == null ? null : String(e['error']),
          })
        } catch {
          /* línea no-JSON: se ignora, como en el resto de los lectores de log del server */
        }
      }
      return salida
    },
  }
}

// ═══ I1 · validación del sub-perfil `consola` ════════════════════════════════════════════════════

/**
 * Valida los sub-perfiles `consola` de `VERGIS_CONNECTIONS`. **Pura** y eager: se corre al parsear,
 * antes de tocar la red, igual que `credentialProviderFor` (#66).
 *
 * Las dos reglas y por qué son fatales y no avisos:
 *  - `consola` NO puede declarar `server`/`database`/`port`: apuntar a otro destino no sería «el
 *    mismo Conector con otro principal» — sería un Conector distinto sin gate propio.
 *  - `consola.clientId` igual al del padre es CONFIG ROTA, no una redundancia: el principal de
 *    serving es Admin de los workspaces, así que ejecutar SQL libre bajo él es bypass completo. Un
 *    aviso dejaría la Consola abierta con la garantía rota.
 */
export function validarPerfilesConsola(profiles: Record<string, SqlConnectionProfile>): void {
  for (const [ref, perfil] of Object.entries(profiles)) {
    const sub = perfil.consola as (Record<string, unknown> & { clientId?: string }) | undefined
    if (!sub) continue
    const prohibidos = ['server', 'database', 'port'].filter((k) => sub[k] !== undefined)
    if (prohibidos.length) {
      throw new Error(
        `database_ref '${ref}': el sub-perfil 'consola' no admite ${prohibidos.join('/')} — hereda el destino del perfil padre (mismo Conector, otro principal).`,
      )
    }
    if (sub.clientId && perfil.clientId && sub.clientId === perfil.clientId) {
      throw new Error(
        `database_ref '${ref}': el sub-perfil 'consola' declara el MISMO clientId que el perfil de serving. ` +
          'Ejecutar SQL libre bajo el principal de serving es un bypass completo (es Admin de los workspaces).',
      )
    }
  }
}

/**
 * ¿Esta identidad ve la entrada «Consola SQL» en el menú del avatar? **Una sola definición** para
 * todas las superficies que pintan ese menú — el catálogo, `/admin` y `/impresiones`. Es la lección
 * de #307: cuando cada marco arma su `avatarMenu(...)` por su cuenta, el prop nace y muere en el
 * primero, y la capacidad queda invisible donde nadie la puso. Fail-closed: sin flag o sin store de
 * gobierno no la ve nadie.
 */
export async function consolaMenuScope(
  cfg: { enabled: boolean; scopeGroup: string },
  gov: { isMember(group: string, email: string): Promise<boolean> } | null | undefined,
  emailLc: string,
  isAdmin: boolean,
): Promise<boolean> {
  if (!cfg.enabled || !gov) return false
  return isAdmin || gov.isMember(cfg.scopeGroup, emailLc)
}

// ═══ I5 · el handler ═════════════════════════════════════════════════════════════════════════════

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
const html = (res: ServerResponse, code: number, body: string): void => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Tope del texto SQL aceptado (el `readBody` corta el stream, no solo rechaza la promesa). */
const MAX_SQL_BYTES = 64 * 1024
/** Tope del contenido de UNA celda que viaja a la página (una celda enorme no tumba el navegador). */
const MAX_CELDA = 32 * 1024

export function createConsola(deps: ConsolaDeps): ConsolaHandler {
  const csrf = csrfFactory(deps.secret)
  /** Una consulta EN VUELO por identidad — es lo que le da sentido a «cancelar». */
  const enVuelo = new Map<string, AbortController>()
  /**
   * Consultas en vuelo en TODO el nodo. Default 1 (§config): la Consola corre contra la misma
   * capacidad de producción de la que cuelgan los PIs y compite con lo que está sirviendo.
   */
  let concurrentes = 0

  const ofrecibles = (): { ref: string; database: string | undefined; verificadoEn: string }[] =>
    [...deps.estado().entries()]
      .filter(([, e]) => e.ofrecible)
      .map(([ref, e]) => ({ ref, database: deps.databaseDe(ref), verificadoEn: e.verificadoEn }))

  async function tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const rawUrl = req.url ?? '/'
    const path = rawUrl.split('?')[0].replace(/\/+$/, '') || '/consola'
    if (path !== '/consola' && !path.startsWith('/consola/')) return false
    const query = new URLSearchParams(rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '')
    const identity = deps.identityOf(req.headers)
    const email = (identity.user ?? '').toLowerCase()

    // Sin scope: 403 en TODA ruta, y **sin revelar si la capacidad está encendida** — mismo trato
    // que Miranda. Quien no tiene el scope no aprende nada del nodo por preguntar.
    if (!(await deps.hasScope(email))) {
      html(res, 403, pagina('Sin acceso', `<p class="msg err">No tienes el scope <code>${escapeHtml(deps.config.scopeGroup)}</code>. Pídeselo a un administrador.</p><p><a href="/">← Catálogo</a></p>`))
      return true
    }
    const token = csrf(email)

    try {
      if (path === '/consola' && req.method === 'GET') {
        const disponibles = ofrecibles()
        if (!deps.config.enabled || disponibles.length === 0) {
          html(res, 503, pagina('Consola no disponible', motivosHtml(deps, disponibles.length)))
          return true
        }
        html(res, 200, await paginaConsola(deps, email, token, disponibles))
        return true
      }
      if (path === '/consola/conectores' && req.method === 'GET') {
        json(res, 200, { conectores: ofrecibles() })
        return true
      }
      const mEsq = path.match(/^\/consola\/([^/]+)\/esquema$/)
      if (mEsq && req.method === 'GET') {
        const ref = decodeURIComponent(mEsq[1]!)
        // Un ref existente pero NO ofrecible responde igual que uno inexistente: quien no puede
        // usarlo tampoco tiene por qué saber que existe.
        const est = deps.estado().get(ref)
        if (!est?.ofrecible) {
          json(res, 404, { error: 'Conector no disponible.' })
          return true
        }
        // Las tablas que el Conector cubre por `DENY SELECT` —no por política— NO se listan: el
        // principal de consola no puede leerlas, y ofrecer en el árbol lo que la ejecución va a
        // rechazar es una promesa que la ejecución no cumple. El filtro sale del ESTADO DEL GATE
        // (lo medido), no de lo que el metadato quiera mostrar.
        const excluidas = new Set(est.medido.tablasExcluidasPorPermiso ?? [])
        const tablas = (await deps.esquema(ref)).filter((t) => !excluidas.has(t.tabla))
        json(res, 200, { tablas })
        return true
      }
      if (path === '/consola/ejecutar' && req.method === 'POST') {
        return await ejecutar(req, res, identity, email, token)
      }
      if (path === '/consola/cancelar' && req.method === 'POST') {
        const body = (await readJsonBody(req, 4096)) as Record<string, string>
        requireCsrf(body, token)
        const ctl = enVuelo.get(email)
        if (ctl) ctl.abort()
        json(res, 200, { cancelada: Boolean(ctl) })
        return true
      }
      if (path === '/consola/historial' && req.method === 'GET') {
        const limite = Math.min(500, Math.max(1, Number(query.get('limite') ?? 50) || 50))
        const pedido = (query.get('actor') ?? '').toLowerCase()
        // El historial ajeno es de admin. Un no-admin que lo pida ve el SUYO, no un 403: pedir el de
        // otro no es un ataque, y responderle con el propio es la respuesta útil.
        const actor = pedido && (await deps.isAdmin(email)) ? pedido : email
        json(res, 200, { entradas: deps.log.historial(limite, actor) })
        return true
      }
      json(res, 404, { error: 'Ruta no encontrada.' })
      return true
    } catch (e) {
      if (e instanceof CsrfError) {
        json(res, 403, { error: e.message })
        return true
      }
      throw e
    }
  }

  async function ejecutar(
    req: IncomingMessage,
    res: ServerResponse,
    identity: IdentityContext,
    email: string,
    token: string,
  ): Promise<boolean> {
    let body: Record<string, string>
    try {
      body = (await readJsonBody(req, MAX_SQL_BYTES)) as Record<string, string>
    } catch (e) {
      // `readBody` corta el stream al exceder el límite: el 413 es el desenlace correcto.
      json(res, /demasiado grande/.test(e instanceof Error ? e.message : '') ? 413 : 400, { error: e instanceof Error ? e.message : String(e) })
      return true
    }
    requireCsrf(body, token)
    const ref = String(body['ref'] ?? '')
    const texto = String(body['sql'] ?? '')
    if (!texto.trim()) {
      json(res, 400, { error: 'No hay SQL que ejecutar.' })
      return true
    }
    // El ref se valida contra el ESTADO VIVO antes de tocar la capability: sin esto, el gate
    // dependería de que el cliente solo ofrezca lo ofrecible — o sea, de nada.
    if (!deps.estado().get(ref)?.ofrecible) {
      json(res, 404, { error: 'Conector no disponible.' })
      return true
    }
    if (enVuelo.has(email)) {
      json(res, 409, { error: 'Ya tienes una consulta en curso: cancélala o espera a que termine.' })
      return true
    }
    if (concurrentes >= deps.config.maxConcurrentes) {
      // Sin decir de quién: el nombre de quien está consultando no es asunto del que espera.
      json(res, 503, { error: 'Consola ocupada: hay una consulta en curso de otra persona. Reintenta en unos segundos.' })
      return true
    }

    const claims = Object.keys(identity.claims ?? {}).sort()
    const inicio = new Date().toISOString()
    const ctl = new AbortController()
    enVuelo.set(email, ctl)
    concurrentes += 1
    deps.log.inicio({ actor: email, ref, sql: texto, claims })
    const t0 = Date.now()
    try {
      const r = await deps.ejecutar({ ref, sql: texto }, identity, ctl.signal)
      deps.log.fin({
        actor: email, ref, sql: texto, claims, inicio, duracionMs: r.duracionMs, estado: 'ok',
        filas: r.filas, truncado: r.truncado, recordsets: r.recordsets.length, error: null,
      })
      json(res, 200, { estado: 'ok', ...recortar(r) })
      return true
    } catch (e) {
      const motivo = (e as { motivo?: string }).motivo
      const estado = motivo === 'consola/timeout' ? 'timeout' : motivo === 'consola/cancelado' ? 'cancelado' : 'error'
      const mensaje = e instanceof Error ? e.message : String(e)
      deps.log.fin({
        actor: email, ref, sql: texto, claims, inicio, duracionMs: Date.now() - t0, estado,
        filas: 0, truncado: false, recordsets: 0, error: mensaje,
      })
      // El error del MOTOR es un resultado, no una falla del nodo: va con 200 y su estado adentro
      // (el que escribe SQL necesita leer el mensaje del motor tal cual para corregir su consulta).
      if (estado === 'error') json(res, 200, { estado: 'error', error: mensaje, recordsets: [], filas: 0, truncado: false, duracionMs: Date.now() - t0 })
      else json(res, estado === 'timeout' ? 408 : 200, { estado, error: mensaje })
      return true
    } finally {
      enVuelo.delete(email)
      concurrentes -= 1
    }
  }

  return { tryHandle }
}

/** Recorta las celdas enormes antes de mandarlas a la página (marcadas, nunca truncadas en silencio). */
function recortar(r: ConsolaResultado): ConsolaResultado {
  return {
    ...r,
    recordsets: r.recordsets.map((rs) => ({
      columnas: rs.columnas,
      filas: rs.filas.map((f) => f.map((v) => (typeof v === 'string' && v.length > MAX_CELDA ? `${v.slice(0, MAX_CELDA)}…` : v))),
    })),
  }
}

const pagina = (titulo: string, cuerpo: string): string =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${escapeHtml(titulo)}</title><style>${PAGE_CSS}${CONSOLA_CSS}</style></head><body>` +
  `<h1>${escapeHtml(titulo)}</h1>${cuerpo}` +
  `<script>(function(){var t='oscuro';try{t=localStorage.getItem('vergis:index-theme')||'oscuro'}catch(e){}document.documentElement.setAttribute('data-theme',t)})();</script></body></html>`

/** El 503 dice POR QUÉ, y por Conector: el operador no tiene que adivinar cuál falló ni de qué. */
function motivosHtml(deps: ConsolaDeps, ofrecibles: number): string {
  if (!deps.config.enabled) {
    return `<p class="msg err">La Consola SQL está apagada en este nodo (<code>VERGIS_CONSOLA_ENABLED</code>).</p><p><a href="/">← Catálogo</a></p>`
  }
  const filas = [...deps.estado().entries()]
    .map(([ref, e]) => `<tr><td><code>${escapeHtml(ref)}</code></td><td>${e.ofrecible ? 'ofrecible' : escapeHtml(e.motivo ?? '—')}</td></tr>`)
    .join('')
  return (
    `<p class="msg err">Ningún Conector pasa el gate de la Consola (${ofrecibles} ofrecible(s)).</p>` +
    (filas ? `<table><tr><th>Conector</th><th>Motivo</th></tr>${filas}</table>` : '<p>No hay Conectores con sub-perfil <code>consola</code>.</p>') +
    `<p>El detalle vive en <a href="/contrato">/contrato</a> (sección <code>consola</code>).</p><p><a href="/">← Catálogo</a></p>`
  )
}

const CONSOLA_CSS = `
body.cons{max-width:none;padding:0;display:flex;min-height:100vh}
.cons-tray{width:270px;flex:none;background:var(--card);border-right:1px solid var(--border);padding:18px 14px;box-sizing:border-box;overflow:auto;max-height:100vh}
.cons-main{flex:1;padding:22px 26px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;min-width:0}
.faceta{margin-bottom:16px}.faceta>b{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px}
.cons-arbol{font-size:12px;max-height:38vh;overflow:auto}
.cons-arbol details{margin:2px 0}.cons-arbol summary{cursor:pointer;color:var(--fg)}
.cons-arbol button{background:none;border:none;color:var(--muted);font-size:11px;padding:2px 6px;text-align:left;display:block;width:100%}
.cons-arbol button:hover{color:var(--accent)}
#sql{width:100%;min-height:180px;font-family:ui-monospace,Menlo,monospace;font-size:13px;background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:9px;padding:12px;box-sizing:border-box}
.cons-res{flex:1;overflow:auto;border:1px solid var(--border);border-radius:9px;background:var(--card);min-height:120px}
.cons-res table{margin:0;font-size:12.5px}.cons-res th{position:sticky;top:0;background:var(--card)}
.cons-barra{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.cons-aviso{font-size:12px;color:var(--muted);border-left:3px solid var(--accent);padding:6px 10px;margin:0}
.cons-err{color:var(--err);font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;padding:10px}
.cons-hist{font-size:11.5px;max-height:26vh;overflow:auto}
.cons-hist button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--muted);padding:4px 6px;border-radius:5px;font-family:ui-monospace,Menlo,monospace}
.cons-hist button:hover{background:var(--bg);color:var(--fg)}
.cons-tabs{display:flex;gap:6px}.cons-tabs button{background:var(--card);border:1px solid var(--border);color:var(--muted);padding:5px 11px;font-size:12px}
.cons-tabs button.on{color:var(--fg);border-color:var(--accent)}`

async function paginaConsola(
  deps: ConsolaDeps,
  email: string,
  token: string,
  conectores: { ref: string; database: string | undefined; verificadoEn: string }[],
): Promise<string> {
  const avatar = deps.avatar ? await deps.avatar(email) : ''
  const opciones = conectores
    .map((c) => `<option value="${escapeHtml(c.ref)}">${escapeHtml(c.ref)}${c.database ? ` · ${escapeHtml(c.database)}` : ''}</option>`)
    .join('')
  const cfg = JSON.stringify({
    token,
    maxRows: deps.config.maxRows,
    timeoutMs: deps.config.timeoutMs,
    maxConcurrentes: deps.config.maxConcurrentes,
  })
  const bandeja =
    `<div class="faceta"><b>Conector</b><select id="ref" style="width:100%">${opciones}</select></div>` +
    `<div class="faceta"><b>Esquema</b><div class="cons-arbol" id="arbol">…</div></div>` +
    `<div class="faceta"><b>Límites</b><div style="font-size:11.5px;color:var(--muted)">` +
    `${deps.config.maxRows} filas · ${Math.round(deps.config.timeoutMs / 1000)} s · ` +
    `${deps.config.maxConcurrentes === 1 ? 'una consulta a la vez en el nodo' : `${deps.config.maxConcurrentes} consultas a la vez`}</div></div>` +
    `<div class="faceta"><b>Descargar</b><div class="cons-tabs"><button id="dl-csv">CSV</button><button id="dl-json">JSON</button><button id="dl-xlsx">XLSX</button></div></div>` +
    `<div class="faceta"><b>Historial</b><div class="cons-hist" id="hist">…</div></div>`
  const cuerpo =
    `<div class="cons-barra"><b style="color:var(--fg);font-size:14px">Consola SQL</b>` +
    `<button class="add" id="run">Ejecutar (⌘/Ctrl+Enter)</button>` +
    `<button id="cancel">Cancelar</button>` +
    `<label style="cursor:pointer">Cargar .sql<input type="file" id="archivo" accept=".sql,text/plain" style="display:none"></label>` +
    `<span id="estado"></span></div>` +
    `<p class="cons-aviso">Esta consola muestra <b>lo que Mira mostraría <i>a ti</i></b>: tus filas, y las columnas con regla siempre enmascaradas. ` +
    `Es de solo lectura, garantizada por los permisos del principal de la conexión. Para administrar la fuente usa el SQL endpoint de Fabric con tu cuenta.</p>` +
    `<textarea id="sql" spellcheck="false" placeholder="SELECT TOP 100 * FROM [dbo].[…]"></textarea>` +
    `<div class="cons-tabs" id="tabs"></div>` +
    `<div class="cons-res" id="res"></div>`
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(deps.brandTitle ?? 'Vergis')} · Consola SQL</title><style>${PAGE_CSS}${CONSOLA_CSS}</style></head><body class="cons">` +
    avatar +
    `<aside class="cons-tray">${bandeja}</aside><main class="cons-main">${cuerpo}</main>` +
    `<script>(function(){var t='oscuro';try{t=localStorage.getItem('vergis:index-theme')||'oscuro'}catch(e){}document.documentElement.setAttribute('data-theme',t)})();</script>` +
    `<script>var VERGIS_CONSOLA=${cfg};\n${vtCsvCell.toString()}\n${xlsxUnaHoja.toString()}\n${CONSOLA_JS}</script>` +
    `</body></html>`
  )
}

/**
 * Runtime del navegador. Sin dependencias (ADR-001) y sin editor con resaltado: un `<textarea>` con
 * el árbol de esquema clicable cubre el MVP, y meter un editor costaría la primera dependencia de
 * front del producto.
 *
 * El export es CLIENT-SIDE sobre el resultset ya recibido, así que hereda la audiencia por
 * construcción: **exporta lo que se vio**, truncado incluido, sin un camino de datos nuevo. La regla
 * de celda del CSV es `vtCsvCell` —la misma función del export de los PIs, emitida acá por
 * `.toString()`—, así que la neutralización de fórmulas no se reimplementa.
 */
const CONSOLA_JS = String.raw`
(function(){
  var $=function(s){return document.querySelector(s)};
  var ultimo=null, recordsetActivo=0, pagina=0, PAG=100;
  function post(url,body){return fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {code:r.status,json:j}})})}
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML}
  function estado(t){$('#estado').textContent=t}

  function pintar(){
    var res=$('#res'), tabs=$('#tabs');
    tabs.innerHTML=''; res.innerHTML='';
    if(!ultimo){return}
    if(ultimo.estado==='error'){res.innerHTML='<div class="cons-err">'+esc(ultimo.error)+'</div>';return}
    var rs=ultimo.recordsets||[];
    if(!rs.length){res.innerHTML='<p style="padding:12px;color:var(--muted)">La consulta no devolvió filas.</p>';return}
    rs.forEach(function(r,i){
      var b=document.createElement('button'); b.textContent='Resultado '+(i+1)+' ('+r.filas.length+')';
      if(i===recordsetActivo)b.className='on';
      b.onclick=function(){recordsetActivo=i;pagina=0;pintar()};
      tabs.appendChild(b);
    });
    var r=rs[recordsetActivo]; if(!r)return;
    var desde=pagina*PAG, hasta=Math.min(r.filas.length,desde+PAG);
    var h='<table><tr>'+r.columnas.map(function(c){return '<th title="'+esc(c.tipo)+'">'+esc(c.nombre)+'</th>'}).join('')+'</tr>';
    for(var f=desde;f<hasta;f++){h+='<tr>'+r.filas[f].map(function(v){return '<td>'+(v==null?'<span style="color:var(--muted)">NULL</span>':esc(v))+'</td>'}).join('')+'</tr>'}
    h+='</table>';
    if(r.filas.length>PAG){
      h+='<div style="padding:8px;display:flex;gap:8px;align-items:center"><button id="prev">◀</button><span style="font-size:12px;color:var(--muted)">'+(desde+1)+'–'+hasta+' de '+r.filas.length+'</span><button id="next">▶</button></div>';
    }
    res.innerHTML=h;
    if($('#prev'))$('#prev').onclick=function(){if(pagina>0){pagina--;pintar()}};
    if($('#next'))$('#next').onclick=function(){if((pagina+1)*PAG<r.filas.length){pagina++;pintar()}};
  }

  function ejecutar(){
    var ta=$('#sql');
    var texto=(ta.selectionStart!==ta.selectionEnd)?ta.value.slice(ta.selectionStart,ta.selectionEnd):ta.value;
    if(!texto.trim()){estado('sin SQL');return}
    estado('ejecutando…'); ultimo=null; pintar();
    var t0=Date.now();
    post('/consola/ejecutar',{_csrf:VERGIS_CONSOLA.token,ref:$('#ref').value,sql:texto}).then(function(r){
      if(r.code===409||r.code===503||r.code===403||r.code===404||r.code===413){estado(r.json.error||('HTTP '+r.code));return}
      ultimo=r.json; recordsetActivo=0; pagina=0;
      var msg=r.json.estado==='ok'?(r.json.filas+' fila(s) · '+(r.json.duracionMs||(Date.now()-t0))+' ms'+(r.json.truncado?' · TRUNCADO a '+VERGIS_CONSOLA.maxRows:'')):(r.json.estado+': '+(r.json.error||''));
      estado(msg); pintar(); historial();
    }).catch(function(e){estado('error de red: '+e.message)});
  }

  function historial(){
    fetch('/consola/historial?limite=25',{headers:{accept:'application/json'}}).then(function(r){return r.json()}).then(function(j){
      var h=$('#hist'); h.innerHTML='';
      (j.entradas||[]).forEach(function(e){
        var b=document.createElement('button');
        b.textContent=(e.estado==='ok'?'✓':'✗')+' '+e.sql.replace(/\s+/g,' ').slice(0,42);
        b.title=e.ts+' · '+e.ref+' · '+e.estado+' · '+e.filas+' fila(s)';
        b.onclick=function(){$('#sql').value=e.sql;$('#ref').value=e.ref};
        h.appendChild(b);
      });
      if(!h.children.length)h.innerHTML='<span style="color:var(--muted)">(sin ejecuciones)</span>';
    });
  }

  function esquema(){
    var ref=$('#ref').value, a=$('#arbol'); a.textContent='…';
    fetch('/consola/'+encodeURIComponent(ref)+'/esquema').then(function(r){return r.json()}).then(function(j){
      a.innerHTML='';
      (j.tablas||[]).forEach(function(t){
        var d=document.createElement('details');
        d.innerHTML='<summary>'+esc(t.tabla)+'</summary>';
        t.columnas.forEach(function(c){
          var b=document.createElement('button'); b.textContent=c.nombre+' · '+c.tipo;
          b.onclick=function(){insertar(c.nombre)};
          d.appendChild(b);
        });
        d.querySelector('summary').ondblclick=function(){insertar('['+t.tabla.split('.').join('].[')+']')};
        a.appendChild(d);
      });
      if(!a.children.length)a.innerHTML='<span style="color:var(--muted)">(sin objetos visibles para el principal de consola)</span>';
    }).catch(function(){a.innerHTML='<span style="color:var(--err)">no se pudo leer el esquema</span>'});
  }
  function insertar(txt){var ta=$('#sql');var p=ta.selectionStart;ta.value=ta.value.slice(0,p)+txt+ta.value.slice(ta.selectionEnd);ta.focus();ta.selectionStart=ta.selectionEnd=p+txt.length}

  function filasVistas(){var r=(ultimo&&ultimo.recordsets)?ultimo.recordsets[recordsetActivo]:null;return r||{columnas:[],filas:[]}}
  function bajar(nombre,blob){var u=URL.createObjectURL(blob);var a=document.createElement('a');a.href=u;a.download=nombre;a.click();setTimeout(function(){URL.revokeObjectURL(u)},1000)}
  function nombre(ext){return 'consola-'+$('#ref').value+'-'+new Date().toISOString().slice(0,10)+'.'+ext}

  document.addEventListener('DOMContentLoaded',function(){});
  $('#run').onclick=ejecutar;
  $('#cancel').onclick=function(){post('/consola/cancelar',{_csrf:VERGIS_CONSOLA.token}).then(function(r){estado(r.json.cancelada?'cancelada':'no había consulta en curso')})};
  $('#ref').onchange=esquema;
  $('#sql').addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();ejecutar()}});
  $('#archivo').addEventListener('change',function(e){var f=e.target.files[0];if(!f)return;var r=new FileReader();r.onload=function(){$('#sql').value=String(r.result)};r.readAsText(f)});
  $('#dl-csv').onclick=function(){
    var v=filasVistas();
    var lin=[v.columnas.map(function(c){return vtCsvCell(c.nombre,';')}).join(';')];
    v.filas.forEach(function(f){lin.push(f.map(function(x){return vtCsvCell(x,';')}).join(';'))});
    bajar(nombre('csv'),new Blob(['﻿'+lin.join('\r\n')],{type:'text/csv;charset=utf-8'}));
  };
  $('#dl-json').onclick=function(){
    var v=filasVistas();
    var out=v.filas.map(function(f){var o={};v.columnas.forEach(function(c,i){o[c.nombre]=f[i]===undefined?null:f[i]});return o});
    bajar(nombre('json'),new Blob([JSON.stringify(out,null,2)],{type:'application/json'}));
  };
  $('#dl-xlsx').onclick=function(){
    var v=filasVistas();
    var bytes=xlsxUnaHoja(v.columnas.map(function(c){return c.nombre}),v.filas);
    bajar(nombre('xlsx'),new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  };
  esquema(); historial();
})();`
