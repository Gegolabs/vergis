/**
 * Consola de CARGAS por dominio (issue #58, compone #53/#55/#56/#57) — `/admin/dominio/<id>/cargas`.
 *
 * La vivencia completa de la operación de carga, por slot:
 *   · ACTIVIDAD: línea de tiempo que correlaciona cargas de archivos (audit log: quién/cuándo/tamaño)
 *     con corridas de conversión (jobs/instances: estado/duración/motivo) — el historial PRO.
 *   · LOG de la última conversión (#55) y estado con motivo (#53).
 *   · LANDING: archivos activos, con marca de RESIDUO (#57: anteriores a la última corrida completada
 *     → se re-procesarán) y acción de RETIRO (a `_retirado/`, reversible).
 *   · ARCHIVO (`_processed/`): lo ya procesado, con acción de REACTIVAR (copiar de vuelta al landing)
 *     — el rollback honesto: retirar + re-correr revierte pipelines por-clave; reactivar re-materializa.
 *   · RE-RUN: correr la conversión de nuevo (run-now del trigger).
 *   · COHERENCIA (#56): aviso ruidoso si el trigger del slot no está registrado como proceso.
 *
 * Este módulo es PURO (datos → HTML): el fetch de datos y los POST (CSRF + steward + audit) viven en
 * admin.ts / serve-rls. Helpers de render locales a propósito (evita ciclo de imports con admin.ts).
 */
import { escapeHtml, slotLogPath, type IntakeSlot, type RunRecord, type RunStatus, type OneLakeEntry } from '@vergis/capabilities'

/** Evento de carga del audit log (type=intake). */
export interface IntakeUploadEvent {
  ts: string
  filename: string
  bytes: number
  by: string
  ok: boolean
  triggered: boolean
  /** SHA-256 del contenido (issue #62): identidad de la carga, independiente del nombre. */
  sha256?: string
  /** Si el contenido es idéntico a una carga previa del slot: `<filename> · <ts>` de aquella. */
  dupOf?: string
}

/** Operaciones de la consola — las inyecta el wiring (serve-rls) y las consume admin.ts. */
export interface CargasOps {
  history(slot: IntakeSlot, limit: number): Promise<IntakeUploadEvent[]>
  runs(slot: IntakeSlot, top: number): Promise<RunRecord[]>
  log(slot: IntakeSlot): Promise<string | null>
  landing(slot: IntakeSlot): Promise<OneLakeEntry[]>
  archived(slot: IntakeSlot): Promise<OneLakeEntry[]>
  rerun(slot: IntakeSlot, by: string): Promise<void>
  retire(slot: IntakeSlot, filename: string, by: string): Promise<void>
  restore(slot: IntakeSlot, archivedPath: string, by: string): Promise<void>
  /** «Revertir esta carga» (issue #63): saca el archivo de `_processed/<clave>/` a `_retirado/`; si la
   *  clave tiene versión previa archivada, la reactiva al landing y re-corre la conversión (last-wins
   *  restaura el estado anterior). `compensada=false` = clave sin versión previa (dato queda sin origen). */
  revert?(slot: IntakeSlot, archivedPath: string, by: string): Promise<{ clave: string; compensada: boolean; reactivado?: string }>
}

/** Todo lo que la página necesita de UN slot, ya fetcheado (tolerante: 'error' no rompe la página). */
export interface SlotCargas {
  slot: IntakeSlot
  runs: RunRecord[] | 'error'
  history: IntakeUploadEvent[] | 'error'
  log: string | null
  landing: OneLakeEntry[] | 'error'
  archived: OneLakeEntry[] | 'error'
  /** #56: ¿el processRef del trigger está registrado como proceso (con engine_ref)? */
  procesoRegistrado: boolean
}

// ─── Helpers de render (locales: sin ciclo con admin.ts) ────────────────────
function badge(s: RunStatus): string {
  switch (s) {
    case 'Completed': return '<b style="color:var(--accent)">✓ Listo</b>'
    case 'Failed': return '<b style="color:var(--err)">✕ Falló</b>'
    case 'InProgress': return '⏳ Procesando'
    case 'NotStarted': return '⏳ En cola'
    case 'Cancelled': return '⊘ Cancelada'
    case 'Deduped': return '⊘ Omitida'
    default: return escapeHtml(s)
  }
}
function when(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const d = new Date(t)
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`
}
function dur(r: RunRecord): string {
  if (!r.endedAt) return ''
  const ms = Date.parse(r.endedAt) - Date.parse(r.startedAt)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}
const baseName = (p: string): string => p.split('/').pop() ?? p

/** Inicio de la última corrida COMPLETADA (frontera del residuo, #57). */
export function lastCompletedStart(runs: RunRecord[] | 'error'): number | null {
  if (runs === 'error') return null
  const done = runs.filter((r) => r.status === 'Completed').map((r) => Date.parse(r.startedAt)).filter((t) => !Number.isNaN(t))
  return done.length ? Math.max(...done) : null
}

/** ¿El archivo es RESIDUO? (anterior a la última corrida completada → la próxima corrida lo re-procesa). */
export function esResiduo(entry: OneLakeEntry, lastCompleted: number | null): boolean {
  if (lastCompleted == null) return false
  const t = Date.parse(entry.lastModified)
  return !Number.isNaN(t) && t < lastCompleted
}

/** Línea de tiempo fusionada: cargas + corridas, más reciente primero. */
export function timeline(history: IntakeUploadEvent[] | 'error', runs: RunRecord[] | 'error', limit = 30): { ts: string; html: string }[] {
  const items: { ts: string; html: string }[] = []
  if (history !== 'error') {
    for (const h of history) {
      items.push({
        ts: h.ts,
        html: `<td>${when(h.ts)}</td><td>📤 Carga</td><td>${escapeHtml(h.filename)} <span class="sub">· ${kb(h.bytes)} · ${escapeHtml(h.by)}</span>${h.dupOf ? `<div class="sub" style="color:var(--yellow,#d97706)">⚠ contenido idéntico a ${escapeHtml(h.dupOf)} — re-procesarlo no cambia el dato</div>` : ''}</td><td>${h.ok ? (h.triggered ? '<span class="sub">disparó conversión</span>' : '<span class="sub">recibido (land-only)</span>') : '<b style="color:var(--err)">rechazada</b>'}</td>`,
      })
    }
  }
  if (runs !== 'error') {
    for (const r of runs) {
      const motivo = r.error ? `<div class="sub" style="color:var(--err)">${escapeHtml(r.error.length > 240 ? r.error.slice(0, 240) + '…' : r.error)}</div>` : ''
      items.push({
        ts: r.startedAt,
        html: `<td>${when(r.startedAt)}</td><td>⚙️ Conversión</td><td>${badge(r.status)}${dur(r) ? ` <span class="sub">· ${dur(r)}</span>` : ''}${motivo}</td><td></td>`,
      })
    }
  }
  return items.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, limit)
}

const csrf = (token: string): string => `<input type="hidden" name="_csrf" value="${token}">`
const postForm = (action: string, token: string, fields: Record<string, string>, label: string, confirmMsg?: string): string =>
  `<form method="post" action="${escapeHtml(action)}" style="display:inline"${confirmMsg ? ` onsubmit="return confirm('${escapeHtml(confirmMsg)}')"` : ''}>${csrf(token)}${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('')}<button class="add">${escapeHtml(label)}</button></form>`

/** El cuerpo HTML de la consola (se envuelve con adminPage en admin.ts). */
export function cargasBody(domainId: string, domainLabel: string, slots: SlotCargas[], token: string, uploadFormOf: (slot: IntakeSlot) => string): string {
  const back = `<p class="sub"><a href="/admin/dominio/${escapeHtml(domainId)}">← ${escapeHtml(domainLabel)}</a></p>`
  if (!slots.length) {
    return `${back}<p class="sub">Este dominio no tiene slots de ingesta declarados (instancia: <code>intake/slots.yaml</code>).</p>`
  }
  const action = `/admin/dominio/${escapeHtml(domainId)}/cargas`
  const secciones = slots.map((sc) => {
    const s = sc.slot
    const lastDone = lastCompletedStart(sc.runs)
    const last = sc.runs !== 'error' && sc.runs.length ? sc.runs[0] : null

    // #56 · coherencia declarativa: trigger sin proceso registrado = sin observabilidad de entidad.
    const coherencia = s.trigger && !sc.procesoRegistrado
      ? `<p class="msg err">⚠ El trigger de este slot (<code>${escapeHtml(s.trigger.processRef)}</code>) no está registrado como proceso en <a href="/admin/sources">Fuentes</a> → la entidad no aparece en Frescura ni la vigila el monitor. Registrarlo en <code>sources.yaml</code>.</p>`
      : ''

    // #62 (capa «delta neto cero»): el pipeline emite `[delta] sin cambios en el dato` en su log
    // cuando la corrida dejó el dato idéntico (convención del contrato de ingesta) → badge honesto.
    const sinCambios = last?.status === 'Completed' && !!sc.log && sc.log.includes('[delta] sin cambios en el dato')
    const estado = last
      ? `${badge(last.status)}${sinCambios ? ' <span class="sub">· sin cambios en el dato</span>' : ''} ${when(last.startedAt)}${dur(last) ? ` <span class="sub">· ${dur(last)}</span>` : ''}${last.error ? `<div class="sub" style="color:var(--err)">${escapeHtml(last.error.slice(0, 300))}</div>` : ''}`
      : sc.runs === 'error' ? '<span class="sub">motor no respondió</span>' : '<span class="sub">sin corridas</span>'

    const rerun = s.trigger ? postForm(action, token, { slot: s.id, accion: 'rerun' }, 'Correr conversión de nuevo', 'La conversión re-procesará TODOS los archivos del landing. ¿Continuar?') : ''

    const logHtml = sc.log?.trim()
      ? `<details class="guia"><summary class="sub">Log de la última conversión</summary><pre class="sub" style="white-space:pre-wrap;overflow-x:auto;max-height:260px;overflow-y:auto">${escapeHtml((sc.log.length > 4000 ? '…' + sc.log.slice(-4000) : sc.log).trim())}</pre></details>`
      : ''

    const landingRows = sc.landing === 'error'
      ? `<tr><td colspan="4" class="sub">No se pudo listar el landing (reintentá refrescando).</td></tr>`
      : sc.landing.filter((e) => !e.isDirectory).map((e) => {
          const residuo = esResiduo(e, lastDone)
          return `<tr${residuo ? ' style="color:var(--err)"' : ''}><td>${escapeHtml(baseName(e.path))}</td><td>${kb(e.size)}</td><td>${when(e.lastModified)}${residuo ? ' <b>⚠ residuo</b><div class="sub">anterior a la última conversión: se RE-PROCESARÁ en la próxima corrida</div>' : ''}</td><td>${postForm(action, token, { slot: s.id, accion: 'retire', archivo: baseName(e.path) }, 'Retirar', `Retirar «${baseName(e.path)}» del landing (va a _retirado/, reversible). ¿Continuar?`)}</td></tr>`
        }).join('') || `<tr><td colspan="4" class="sub">Landing vacío — nada pendiente de procesar.</td></tr>`

    const archivedRows = sc.archived === 'error'
      ? `<tr><td colspan="4" class="sub">No se pudo listar el archivo de procesados.</td></tr>`
      : sc.archived.filter((e) => !e.isDirectory).slice(0, 60).map((e) =>
          `<tr><td>${escapeHtml(e.path.replace(/^.*_processed\//, ''))}</td><td>${kb(e.size)}</td><td>${when(e.lastModified)}</td><td>${postForm(action, token, { slot: s.id, accion: 'restore', archivo: e.path }, 'Reactivar', `Copiar «${baseName(e.path)}» de vuelta al landing para re-procesarlo. ¿Continuar?`)} ${postForm(action, token, { slot: s.id, accion: 'revert', archivo: e.path }, 'Revertir', `Revertir la carga «${baseName(e.path)}»: sale del histórico a _retirado/ y, si su clave tiene versión previa, se re-materializa el estado anterior. ¿Continuar?`)}</td></tr>`,
        ).join('') || `<tr><td colspan="4" class="sub">Sin procesados archivados todavía.</td></tr>`

    return `<h2>${escapeHtml(s.label)} <span class="sub c">${escapeHtml(s.id)}</span></h2>
    ${coherencia}
    <p><b>Última conversión:</b> ${estado} ${rerun ? `<span style="margin-left:12px">${rerun}</span>` : ''}</p>
    ${logHtml}
    <h3 class="sub">Subir archivos</h3>
    ${uploadFormOf(s)}
    <h3 class="sub">Actividad</h3>
    <table><thead><tr><th>Cuándo</th><th>Evento</th><th>Detalle</th><th></th></tr></thead>
    <tbody>${timeline(sc.history, sc.runs).map((i) => `<tr>${i.html}</tr>`).join('') || `<tr><td colspan="4" class="sub">Sin actividad registrada.</td></tr>`}</tbody></table>
    <h3 class="sub">Landing (por procesar)</h3>
    <table><thead><tr><th>Archivo</th><th>Tamaño</th><th>Recibido</th><th></th></tr></thead><tbody>${landingRows}</tbody></table>
    <h3 class="sub">Procesados (archivo histórico)</h3>
    <table><thead><tr><th>Archivo</th><th>Tamaño</th><th>Procesado</th><th></th></tr></thead><tbody>${archivedRows}</tbody></table>`
  }).join('<hr style="border:0;border-top:1px solid var(--border);margin:28px 0">')

  const guia = `<details class="guia"><summary>¿Cómo funciona el ciclo de una carga? (y cómo revertirla)</summary>
    <p class="sub">Subís archivos → aterrizan en el <b>landing</b> → la conversión corre (automática al subir, o con «Correr conversión de nuevo») → el resultado queda en «Actividad» con su log. Los pipelines procesan por clave (semana, OC): <b>retirar</b> un archivo del landing y re-correr revierte lo que ese archivo aportó; <b>reactivar</b> uno del histórico lo vuelve a materializar. Un archivo marcado <b style="color:var(--err)">⚠ residuo</b> quedó de una corrida anterior y se re-procesará — retiralo si no corresponde.</p>
  </details>`
  return `${back}<p class="sub">Operación de cargas del dominio: historial, estado y log de cada conversión, y el ciclo completo del landing (retirar / reactivar / re-correr).</p>${guia}${secciones}`
}
