/**
 * Publicación de un PI nacido por chat (WP6). Al publicar: (1) asigna código `PI-NNN` desde la secuencia
 * del store (semilla 101 — serie separada de Jira, sin colisión); (2) escribe el YAML al directorio de
 * specs con cabecera de PROCEDENCIA (sesión, versión de draft, fecha) — el hot-reload existente lo
 * levanta; (3) marca la sesión `publicado` y congela sus artefactos.
 *
 * GATES EN CÓDIGO (no solo prompt): solo se publica una sesión `autochequeado`, con un último qc_report
 * SIN brechas B/M, y con un draft que valida contra el DSL. Miranda NO decide alcance de gobierno.
 */
import YAML from 'yaml'
import { hasBlockingGaps, type SelfCheckResult } from './qc'

/** Subconjunto del store que publish necesita (seam testeable). */
export interface PublishStore {
  getMirandaSession(id: string): Promise<{ id: string; title: string; state: string; piCode?: string } | null>
  latestMirandaArtifact(id: string, kind: 'spec_draft' | 'qc_report' | 'intent_summary'): Promise<{ version: number; content: string } | null>
  nextMirandaPiCode(): Promise<number>
  setMirandaPiCode(id: string, piCode: string): Promise<void>
  setMirandaState(id: string, state: 'publicado'): Promise<void>
}

export interface PublishDeps {
  store: PublishStore
  /** Valida el draft final contra el DSL (schema + capabilities de instancia). */
  validateDraft(yaml: string): { ok: true } | { ok: false; error: string }
  /** Escribe la spec al SPECS_DIR (el server la implementa). */
  writeSpec(filename: string, content: string): Promise<void>
  /** Anuncio opcional (patrón espejo Slack). No-fatal: un fallo no revierte la publicación. */
  announce?: (message: string) => Promise<void>
  now?: () => string
}

export interface PublishResult {
  code: string
  slug: string
  filename: string
  draftVersion: number
}

export class PublishBlocked extends Error {}

/** slug estable desde un texto (minúsculas, sin acentos, no-alfanum → `-`). */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Compone la cabecera de procedencia (comentarios YAML). */
function provenanceHeader(code: string, title: string, sessionId: string, draftVersion: number, date: string): string {
  const bar = '# ' + '─'.repeat(60)
  return [
    bar,
    `# ${code} · ${title}`,
    `# Generado por Miranda (chat). NO editar a mano salvo por el mismo flujo conversacional.`,
    `# Procedencia: sesión ${sessionId} · draft v${draftVersion} · ${date}`,
    `# El ledger completo (transcript + resúmenes + qc) vive en la sesión, exportada a git.`,
    bar,
    '',
  ].join('\n')
}

/**
 * Publica el PI de una sesión. Lanza `PublishBlocked` si algún gate no se cumple (el server lo traduce
 * a un mensaje para el usuario). Devuelve el código asignado y el archivo escrito.
 */
export async function publishSpec(sessionId: string, deps: PublishDeps): Promise<PublishResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const session = await deps.store.getMirandaSession(sessionId)
  if (!session) throw new PublishBlocked(`No existe la sesión '${sessionId}'.`)
  if (session.state === 'publicado') throw new PublishBlocked('La sesión ya fue publicada.')
  if (session.state !== 'autochequeado') {
    throw new PublishBlocked(`Solo se publica desde 'autochequeado' (la sesión está en '${session.state}'). Valida el resumen y corre el self-check antes.`)
  }
  const draft = await deps.store.latestMirandaArtifact(sessionId, 'spec_draft')
  if (!draft) throw new PublishBlocked('No hay draft para publicar.')
  const qc = await deps.store.latestMirandaArtifact(sessionId, 'qc_report')
  if (!qc) throw new PublishBlocked('Falta el self-check (qc_report). Córrelo antes de publicar.')
  let report: SelfCheckResult
  try {
    report = JSON.parse(qc.content) as SelfCheckResult
  } catch {
    throw new PublishBlocked('El último qc_report no es legible. Vuelve a correr el self-check.')
  }
  if (hasBlockingGaps(report.brechas)) {
    throw new PublishBlocked('El último self-check tiene brechas B/M abiertas. Resuélvelas y vuelve a chequear antes de publicar.')
  }
  const validated = deps.validateDraft(draft.content)
  if (!validated.ok) throw new PublishBlocked(`El draft no valida contra el DSL: ${validated.error}`)

  // Asignar código de la secuencia (semilla 101).
  const n = await deps.store.nextMirandaPiCode()
  const code = `PI-${n}`
  const slug = slugify(code) // 'pi-101' — el slug de serving (discovery lee identity.code)

  // Inyectar identity.code = PI-NNN para que discovery lo rutee por ese código, y re-serializar.
  const parsed = (YAML.parse(draft.content) ?? {}) as { identity?: Record<string, unknown> }
  parsed.identity = { ...(parsed.identity ?? {}), code }
  const body = YAML.stringify(parsed)
  const filename = `pi${n}-${slugify(session.title || code)}.yaml`
  const content = provenanceHeader(code, session.title || code, sessionId, draft.version, now()) + body

  await deps.writeSpec(filename, content)
  await deps.store.setMirandaPiCode(sessionId, code)
  await deps.store.setMirandaState(sessionId, 'publicado')

  if (deps.announce) {
    try {
      await deps.announce(`🤖 Miranda publicó ${code} · ${session.title || code} (draft v${draft.version}).`)
    } catch {
      /* no-fatal: el anuncio no revierte la publicación */
    }
  }
  return { code, slug, filename, draftVersion: draft.version }
}
