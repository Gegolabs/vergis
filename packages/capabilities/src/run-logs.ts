/**
 * Logs POR CORRIDA de un proceso de ingestión (issue #99) — lógica PURA.
 *
 * CONTRATO DE INGESTA (lado escritor — código de terreno, p. ej. el SJD de la instancia):
 * al FINAL de cada corrida (éxito, aborto `✖ ABORTADO` o `✖ ERROR no controlado` — el mismo
 * punto donde escribe su `_ingest_log.txt`), el proceso escribe ADEMÁS su log completo, inmutable,
 * en `<dir>/run-<YYYYMMDDTHHMMSSZ>.txt`, donde el timestamp es el ARRANQUE del script en UTC y
 * `<dir>` default es `Files/code/_logs`. RETENCIÓN: el escritor conserva los últimos
 * RUN_LOG_RETENTION archivos y poda el resto — el producto solo LEE (jamás poda: dos escritores
 * sobre el mismo directorio es una carrera).
 *
 * La correlación corrida↔archivo es por timestamp con ventana (no por id de instancia del motor):
 * el script arranca DESPUÉS del startTimeUtc del job instance y escribe ANTES de (o apenas tras)
 * su endTimeUtc — los márgenes absorben cola/boot/skew. [Los márgenes contra motor vivo: gate
 * manual del despliegue; sin confirmar aún.]
 */
import type { OneLakeEntry } from './intake-onelake'
import type { RunRecord } from './ingestion-observability'

/** Directorio default de logs por corrida (relativo al Lakehouse). */
export const RUN_LOG_DIR_DEFAULT = 'Files/code/_logs'
/** Retención que el contrato exige al escritor (archivos). El producto la DECLARA, no la aplica. */
export const RUN_LOG_RETENTION = 60

/** Margen hacia atrás: el script puede escribir su nombre con un reloj ligeramente adelantado. */
const MARGEN_ANTES_MS = 120_000
/** Margen hacia adelante respecto del fin de la corrida. */
const MARGEN_DESPUES_MS = 300_000
/** Sin `endedAt`, la ventana se cierra a 24 h del arranque. */
const VENTANA_ABIERTA_MS = 86_400_000

const RUN_LOG_RE = /^run-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.(?:txt|log)$/i

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Nombre canónico del log de una corrida arrancada en `startedAtIso` (lado escritor / tests). */
export function runLogFileName(startedAtIso: string): string {
  const ms = Date.parse(startedAtIso)
  if (!Number.isFinite(ms)) throw new Error(`run-logs: ISO inválido '${startedAtIso}'.`)
  const d = new Date(ms)
  const ts =
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  return `run-${ts}.txt`
}

/** Epoch ms del timestamp de un nombre `run-YYYYMMDDTHHMMSSZ.txt|.log` (case-insensitive; el
 *  nombre puede venir con path — se toma el basename). null si no sigue la convención. */
export function parseRunLogTimestamp(name: string): number | null {
  const base = String(name ?? '').replace(/^.*\//, '')
  const m = RUN_LOG_RE.exec(base)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m as unknown as string[]
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  if (!Number.isFinite(ms)) return null
  // Rechaza fechas imposibles (p.ej. mes 13) que Date.UTC normalizaría en silencio.
  const back = new Date(ms)
  if (back.getUTCMonth() + 1 !== Number(mo) || back.getUTCDate() !== Number(d)) return null
  return ms
}

/** Resolución del log de UNA corrida contra el listado del directorio `_logs/`. */
export type RunLogResolution =
  | { kind: 'match'; entry: OneLakeEntry }
  | { kind: 'en-curso' }
  | { kind: 'purgado' }
  | { kind: 'sin-log' }

/** Ventana sellada (D3): candidato si ts ∈ [startedAt−120 s, endedAt+300 s] (sin endedAt:
 *  [startedAt−120 s, startedAt+86 400 s]). Gana el de menor |ts − startedAt|; empate → más reciente. */
export function resolveRunLog(run: RunRecord, entries: OneLakeEntry[]): RunLogResolution {
  const started = Date.parse(run.startedAt)
  const ended = run.endedAt ? Date.parse(run.endedAt) : NaN
  const conTs: { entry: OneLakeEntry; ts: number }[] = []
  for (const e of entries ?? []) {
    if (!e || e.isDirectory) continue
    const ts = parseRunLogTimestamp(e.path)
    if (ts == null) continue
    conTs.push({ entry: e, ts })
  }

  if (Number.isFinite(started)) {
    const desde = started - MARGEN_ANTES_MS
    const hasta = Number.isFinite(ended) ? ended + MARGEN_DESPUES_MS : started + VENTANA_ABIERTA_MS
    const candidatos = conTs.filter((c) => c.ts >= desde && c.ts <= hasta)
    if (candidatos.length) {
      let mejor = candidatos[0]!
      for (const c of candidatos.slice(1)) {
        const dc = Math.abs(c.ts - started)
        const dm = Math.abs(mejor.ts - started)
        if (dc < dm || (dc === dm && c.ts > mejor.ts)) mejor = c
      }
      return { kind: 'match', entry: mejor.entry }
    }
  }

  if (run.status === 'InProgress' || run.status === 'NotStarted') return { kind: 'en-curso' }

  if (Number.isFinite(started) && conTs.length) {
    const masViejo = Math.min(...conTs.map((c) => c.ts))
    if (masViejo > started + MARGEN_DESPUES_MS) return { kind: 'purgado' }
  }

  return { kind: 'sin-log' }
}

const REDACTADO = '«…redactado…»'
const CLAVES = 'client_secret|clientsecret|password|pwd|accountkey|sharedaccesskey|sas|secret|token'
const PAR_RE = new RegExp(`\\b(${CLAVES})(\\s*["']?\\s*[=:]\\s*["']?)([^\\s;,"']+)`, 'gi')
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g

/** Defensa en profundidad (D9): enmascara secretos obvios con `«…redactado…»`. */
export function redactSecrets(text: string): string {
  if (!text) return text
  return text.replace(JWT_RE, REDACTADO).replace(PAR_RE, (_m, k: string, sep: string) => `${k}${sep}${REDACTADO}`)
}
