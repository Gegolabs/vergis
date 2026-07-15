/**
 * Cinturón de herramientas de Miranda — una función por tool. Cada tool recibe su `input` (ya parseado
 * del tool_use del modelo) + el `MirandaToolContext`, y devuelve un `ToolResult` JSON-serializable que
 * el loop reenvía al modelo como `tool_result`. Los errores se DEVUELVEN (no se lanzan): el modelo debe
 * verlos y corregir. Las probes pasan por `guardProbeSql` antes de tocar el dato.
 */
import { guardProbeSql, SqlGuardError } from './sql-guard'
import type { MirandaToolContext } from './context'
import { validateIntentSummary } from '../intent'
import { nivelForName, nivelOf, probeableNames, type AccionDeCierre, type NivelAcceso, ACCIONES_DE_CIERRE, NIVELES_ACCESO } from '../catalog'

/** Error cuando una fuente conocida NO es consultable directamente (nivel ≠ gestionado). El mensaje
 *  es INTERNO (lo lee el modelo, no el usuario): explica por qué se rechaza y qué hacer, sin filtrarse
 *  a la voz — el modelo tiene prohibido exponer niveles/objetos al usuario. */
function noConsultableError(name: string): { error: string } {
  return {
    error: `'${name}' es una fuente conocida pero NO está en la capa de datos servible: no se puede describir, perfilar ni consultar directamente. Solo las fuentes ya servibles lo permiten. No inventes su contenido. Si el usuario la necesita, regístrala con create_data_request (con su nivel y acción de cierre) y háblale en términos de EXPECTATIVA DE ENTREGA, nunca de su estado técnico.`,
  }
}

export type ToolResult = Record<string, unknown>

/** `repr()` de un valor de celda: revela espacios/mayúsculas de los strings (guard de realizabilidad
 *  — el caso `'TC '` vs `'TC'` debe verse). null → NULL; números → tal cual. */
export function repr(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'string') return `'${v}'`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Date) return `'${v.toISOString()}'`
  return `'${String(v)}'`
}

function reprRow(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(row)) out[k] = repr(v)
  return out
}

export async function catalogTables(_input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  // Expone TODAS las fuentes del censo CON su nivel para que el modelo razone la expectativa de entrega.
  // `probeable` (true solo en gestionado) le dice de un vistazo cuáles puede describir/perfilar/consultar.
  return {
    _nota: 'Fuentes del catálogo con su nivel INTERNO. Solo las `probeable` se consultan directamente; del resto habla por EXPECTATIVA DE ENTREGA (jamás nombres de nivel/objeto/sistema al usuario).',
    tables: ctx.catalog.map((c) => {
      const nivel = nivelOf(c)
      const out: Record<string, unknown> = { name: c.name, nivel, probeable: nivel === 'gestionado' }
      if (c.schema) out['schema'] = c.schema
      if (c.description) out['description'] = c.description
      if (c.rows_estimate != null) out['rows_estimate'] = c.rows_estimate
      if (c.dominio) out['dominio'] = c.dominio
      if (c.sistema) out['sistema'] = c.sistema
      if (c.dueno) out['dueno'] = c.dueno
      if (c.artefacto) out['artefacto'] = c.artefacto
      if (c.quien_sabe) out['quien_sabe'] = c.quien_sabe
      return out
    }),
  }
}

export async function describeTable(input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  const name = String((input as { name?: unknown })?.name ?? '').trim()
  if (!name) return { error: 'describe_table requiere `name`.' }
  const nivel = nivelForName(ctx.catalog, name)
  if (nivel === undefined) return { error: `'${name}' no está en el catálogo. Usa catalog_tables para ver las fuentes disponibles.` }
  if (nivel !== 'gestionado') return noConsultableError(name)
  try {
    const [columns, sample] = await Promise.all([ctx.columnsOf(name), ctx.sampleRows(name, 3)])
    return { table: name, columns, sample: sample.map(reprRow), note: 'sample en repr(): las comillas revelan espacios y mayúsculas.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function profileColumn(input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  const table = String((input as { table?: unknown })?.table ?? '').trim()
  const column = String((input as { column?: unknown })?.column ?? '').trim()
  const top = Math.min(100, Math.max(1, Number((input as { top?: unknown })?.top ?? 20) || 20))
  if (!table || !column) return { error: 'profile_column requiere `table` y `column`.' }
  const nivel = nivelForName(ctx.catalog, table)
  if (nivel === undefined) return { error: `'${table}' no está en el catálogo. Usa catalog_tables para ver las fuentes disponibles.` }
  if (nivel !== 'gestionado') return noConsultableError(table)
  try {
    const rows = await ctx.profileColumn(table, column, top)
    return { table, column, top, values: rows.map((r) => ({ value: repr(r.value), count: r.count })), note: 'valores en repr().' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function runProbe(input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  const sql = String((input as { sql?: unknown })?.sql ?? '')
  const why = String((input as { why?: unknown })?.why ?? '').trim()
  if (!sql.trim()) return { error: 'run_probe requiere `sql`.' }
  if (!why) return { error: 'run_probe requiere `why` (motivo de la probe, para auditoría).' }
  let guarded
  try {
    // Allowlist = SOLO las fuentes gestionadas (probeables). Una probe contra una fuente no-servible
    // (SAP, Buk, Transtecnia, Excel…) la rechaza la guardia — no vuelve a toparse con «Invalid object name».
    guarded = guardProbeSql(sql, { allowlist: probeableNames(ctx.catalog) })
  } catch (e) {
    if (e instanceof SqlGuardError) return { error: `Probe rechazada por la guardia: ${e.message}` }
    return { error: e instanceof Error ? e.message : String(e) }
  }
  const res = await ctx.runProbe(guarded.sql, why)
  if ('error' in res) return { error: res.error, executed_sql: guarded.sql }
  return { executed_sql: guarded.sql, row_count: res.rows.length, rows: res.rows.map(reprRow) }
}

export async function listPis(_input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  return { pis: ctx.listSpecs() }
}

export async function readSpec(input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  const code = String((input as { code?: unknown })?.code ?? '').trim()
  if (!code) return { error: 'read_spec requiere `code`.' }
  const yaml = ctx.readSpec(code)
  if (yaml == null) return { error: `No existe la spec '${code}'.` }
  return { code, yaml }
}

export async function saveDraft(input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  const yaml = String((input as { yaml?: unknown })?.yaml ?? '')
  if (!yaml.trim()) return { error: 'save_draft requiere `yaml`.' }
  const v = ctx.validateDraft(yaml)
  if (!v.ok) return { ok: false, error: v.error }
  const { version } = await ctx.saveDraft(yaml)
  return { ok: true, version }
}

export async function updateIntentSummary(input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  const v = validateIntentSummary(input)
  if (!v.ok) return { ok: false, error: v.error }
  const { version } = await ctx.updateIntent(v.summary)
  return { ok: true, version, note: 'Resumen actualizado; si la sesión estaba validada, vuelve a borrador (debe re-validarse).' }
}

export async function renderPreview(_input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  try {
    const { url } = await ctx.renderPreview()
    return { url }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function runSelfCheck(_input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  try {
    const r = await ctx.runSelfCheck()
    return { veredicto: r.veredicto, brechas: r.brechas }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function createDataRequest(input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  const descripcion = String((input as { descripcion?: unknown })?.descripcion ?? '').trim()
  const tablas = Array.isArray((input as { tablas_faltantes?: unknown })?.tablas_faltantes)
    ? ((input as { tablas_faltantes: unknown[] }).tablas_faltantes as unknown[]).map((t) => String(t))
    : []
  if (!descripcion) return { error: 'create_data_request requiere `descripcion`.' }
  const rawNivel = (input as { nivel?: unknown })?.nivel
  const nivel = typeof rawNivel === 'string' && (NIVELES_ACCESO as readonly string[]).includes(rawNivel) ? (rawNivel as NivelAcceso) : undefined
  const rawAccion = (input as { accion_de_cierre?: unknown })?.accion_de_cierre
  const accionDeCierre =
    typeof rawAccion === 'string' && (ACCIONES_DE_CIERRE as readonly string[]).includes(rawAccion) ? (rawAccion as AccionDeCierre) : undefined
  await ctx.createDataRequest(descripcion, tablas, { nivel, accionDeCierre })
  return { ok: true, note: 'Requerimiento de datos registrado (handoff a César+Claude). Miranda especifica; la construcción es de ellos en esta fase.' }
}
