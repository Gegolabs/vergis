/**
 * Página de UNA corrida de ingestión (issue #99) — datos → HTML, PURO.
 *
 * El log del ÉXITO importa tanto como el del fallo: `Completed` no garantiza que el dato quedó bien
 * (el DELETE/INSERT con conteos vive en el log de la corrida exitosa). Por eso la página es una sola
 * para cualquier desenlace, y se alcanza desde toda corrida listada (Cargas y Frescura).
 *
 * La ausencia de log es un ESTADO, no un vacío: cinco palabras distintas (D7) — `sin-convencion`,
 * `motor-fallo`, `en-curso`, `purgado`, `sin-log`. «No pude medir» jamás se muestra como «no hay».
 *
 * El log mostrado es el del CONTRATO (lo escribe el propio proceso, ver `run-logs.ts`), pasado por
 * `redactSecrets` como defensa en profundidad. Helpers de render locales a propósito (evita ciclo de
 * imports con admin.ts, misma razón que admin-cargas.ts).
 */
import { escapeHtml, redactSecrets, RUN_LOG_RETENTION, type RunRecord, type RunStatus } from '@vergis/capabilities'

export type CorridaResolucion =
  | { kind: 'sin-convencion' }
  | { kind: 'motor-fallo'; detalle: string }
  | { kind: 'match'; nombre: string; lastModified: string; texto: string; truncado: boolean }
  | { kind: 'en-curso' }
  | { kind: 'purgado' }
  | { kind: 'sin-log'; dirVacio: boolean }

export interface CorridaView {
  domainId: string
  /** Label del slot o id del proceso. */
  titulo: string
  /** Cargas o Frescura. */
  volverHref: string
  volverLabel: string
  /** null = la corrida no está en el historial del motor. */
  run: RunRecord | null
  resolucion: CorridaResolucion
  /** Complemento (D10): consola del motor a nivel workspace. */
  consolaMotorHref?: string
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

function resolucionHtml(r: CorridaResolucion): string {
  switch (r.kind) {
    case 'sin-convencion':
      return `<p class="sub">Este origen no declara logs por corrida. Slots: se derivan de su <code>log:</code>; procesos: declara <code>logs:</code> en <code>sources.yaml</code>.</p>`
    case 'motor-fallo':
      return `<p class="msg err">No se pudo consultar el almacén de logs (el motor no respondió). Esto no significa que el log no exista — reintenta refrescando.</p>${r.detalle ? `<p class="sub">${escapeHtml(r.detalle)}</p>` : ''}`
    case 'en-curso':
      return `<p class="sub">La corrida está en curso: el log se escribe al final. Refresca cuando termine.</p>`
    case 'purgado':
      return `<p class="sub">El log de esta corrida ya fue purgado por retención.</p>`
    case 'sin-log':
      return `<p class="sub">El proceso no alcanzó a escribir el log de esta corrida (murió antes de escribir, o el motor no llegó a arrancarlo).${r.dirVacio ? ' Este proceso aún no escribe logs por corrida (contrato <code>_logs/</code>).' : ''}</p>`
    case 'match':
      return `<p class="sub">${escapeHtml(r.nombre)}${r.lastModified ? ` · ${when(r.lastModified)}` : ''}${r.truncado ? ' · (truncado: se muestra el final)' : ''}</p>
      <pre style="white-space:pre-wrap;overflow:auto;max-height:420px">${escapeHtml(redactSecrets(r.texto))}</pre>`
  }
}

/** El cuerpo HTML de la página de una corrida (se envuelve con adminPage en admin.ts). */
export function corridaBody(v: CorridaView): string {
  const back = `<p class="sub"><a href="${escapeHtml(v.volverHref)}">← ${escapeHtml(v.volverLabel)}</a></p>`
  const cabecera = v.run
    ? `<p><b>${badge(v.run.status)}</b> ${when(v.run.startedAt)}${dur(v.run) ? ` <span class="sub">· ${dur(v.run)}</span>` : ''}${v.run.error ? `<div class="sub" style="color:var(--err)">${escapeHtml(v.run.error.slice(0, 300))}</div>` : ''}</p>`
    : `<p class="sub">Corrida no encontrada en el historial del motor (el historial retiene pocas corridas).</p>`
  // Sin corrida en el historial no se resuelve log alguno — pero las dos causas que NO dependen de la
  // corrida (el origen no declara logs; el motor no respondió) sí se dicen: callarlas sería un vacío.
  const cuerpo = v.run || v.resolucion.kind === 'sin-convencion' || v.resolucion.kind === 'motor-fallo'
    ? resolucionHtml(v.resolucion)
    : ''
  const pie = `<p class="sub">Retención: los logs de las últimas ${RUN_LOG_RETENTION} corridas — los poda el propio proceso.</p>`
  const consola = v.consolaMotorHref
    ? `<p class="sub"><a href="${escapeHtml(v.consolaMotorHref)}" target="_blank" rel="noopener noreferrer">Abrir la consola del motor (Fabric) ↗</a></p>`
    : ''
  return `${back}<h2>${escapeHtml(v.titulo)}</h2>${cabecera}${cuerpo}${pie}${consola}`
}
