/**
 * Cinturón de herramientas de Miranda — una función por tool. Cada tool recibe su `input` (ya parseado
 * del tool_use del modelo) + el `MirandaToolContext`, y devuelve un `ToolResult` JSON-serializable que
 * el loop reenvía al modelo como `tool_result`. Los errores se DEVUELVEN (no se lanzan): el modelo debe
 * verlos y corregir. Las probes pasan por `guardProbeSql` antes de tocar el dato.
 */
import { guardProbeSql, SqlGuardError } from './sql-guard'
import type { MirandaToolContext } from './context'
import { isProtectedColumn, probeVeto, shieldNote, shieldUnknown, UNKNOWN_SHIELD, type ColumnShield } from './columns'
import { validateIntentSummary } from '../intent'

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

/** Identificador simple: lo único que se proyecta en una muestra (anti-inyección; ver `sampleRows`). */
const IDENT_RE = /^[A-Za-z0-9_]+$/

/** El escudo del objeto, nunca una excepción: si el seam falla, el objeto queda protegido entero. */
async function shieldOf(ctx: MirandaToolContext, table: string): Promise<ColumnShield> {
  try {
    return (await ctx.columnShield(table)) ?? UNKNOWN_SHIELD
  } catch {
    return UNKNOWN_SHIELD
  }
}

export async function catalogTables(_input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  return {
    tables: ctx.catalog.map((c) => ({
      name: c.name,
      schema: c.schema,
      description: c.description,
      rows_estimate: c.rows_estimate,
    })),
  }
}

export async function describeTable(input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  const name = String((input as { name?: unknown })?.name ?? '').trim()
  if (!name) return { error: 'describe_table requiere `name`.' }
  if (!ctx.isAllowed(name)) return { error: `'${name}' no está en el catálogo permitido. Usa catalog_tables para ver los disponibles.` }
  try {
    // El esquema se pide SIEMPRE y entero: la columna protegida se nombra con su tipo (§4.4). Lo que
    // cambia es la muestra, que se pide con proyección explícita de lo sondeable — nunca `SELECT *`.
    const [columns, shield] = await Promise.all([ctx.columnsOf(name), shieldOf(ctx, name)])
    const protegidas = columns.filter((c) => isProtectedColumn(shield, c.name)).map((c) => c.name)
    // Una columna cuyo nombre no es un identificador simple no se proyecta (no se puede interpolar sin
    // riesgo): queda fuera de la muestra, que es el lado seguro del error.
    const sondeables = columns.filter((c) => !isProtectedColumn(shield, c.name) && IDENT_RE.test(c.name)).map((c) => c.name)
    let sample: Record<string, unknown>[] = []
    let sampleError: string | undefined
    if (sondeables.length > 0) {
      try {
        sample = await ctx.sampleRows(name, 3, sondeables)
      } catch (e) {
        // Que la muestra falle no borra el esquema: nombrar la columna es la mitad del contrato.
        sampleError = e instanceof Error ? e.message : String(e)
      }
    }
    const permitido = new Set(sondeables.map((c) => c.toLowerCase()))
    // Recorte de cinturón y tirantes: aunque la proyección ya excluyó lo protegido, ninguna clave que
    // no sea sondeable sale de acá (un motor que devuelva de más no puede filtrar el dato).
    const rows = sample.map((r) => reprRow(Object.fromEntries(Object.entries(r).filter(([k]) => permitido.has(k.toLowerCase())))))
    const note = [
      'sample en repr(): las comillas revelan espacios y mayúsculas.',
      shieldNote(shield, protegidas),
      sampleError ? `La muestra no se pudo tomar (${sampleError}); el esquema de arriba sí es real.` : undefined,
    ]
      .filter(Boolean)
      .join(' ')
    return {
      table: name,
      columns: columns.map((c) => (isProtectedColumn(shield, c.name) ? { name: c.name, type: c.type, protegida: true } : { name: c.name, type: c.type })),
      columnas_protegidas: protegidas,
      sample: rows,
      note,
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function profileColumn(input: unknown, ctx: MirandaToolContext): Promise<ToolResult> {
  const table = String((input as { table?: unknown })?.table ?? '').trim()
  const column = String((input as { column?: unknown })?.column ?? '').trim()
  const top = Math.min(100, Math.max(1, Number((input as { top?: unknown })?.top ?? 20) || 20))
  if (!table || !column) return { error: 'profile_column requiere `table` y `column`.' }
  if (!ctx.isAllowed(table)) return { error: `'${table}' no está en el catálogo permitido.` }
  try {
    // El perfil ES un sondeo de valores (top-N con conteos): sobre una columna con regla no se produce
    // NADA — ni valores, ni conteos, ni cardinalidad. La respuesta la nombra: existe, y no se sondea.
    const shield = await shieldOf(ctx, table)
    if (isProtectedColumn(shield, column)) {
      return {
        table,
        column,
        protegida: true,
        error: shieldUnknown(shield)
          ? `No se pudo determinar la política de columna de '${table}': no se sondea ninguna de sus columnas (fail-closed). Usa describe_table para ver el esquema.`
          : `La columna '${column}' está protegida por una regla de columna de la política: existe y se nombra (describe_table la lista con su tipo), pero no se sondea — ni valores, ni conteos, ni cardinalidad.`,
      }
    }
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
    guarded = guardProbeSql(sql, { allowlist: ctx.catalog.map((c) => c.name) })
  } catch (e) {
    if (e instanceof SqlGuardError) return { error: `Probe rechazada por la guardia: ${e.message}` }
    return { error: e instanceof Error ? e.message : String(e) }
  }
  // Segunda guardia, ORTOGONAL a la del SQL: la primera decide qué objetos se pueden tocar; esta,
  // qué columnas. Corre ANTES de ejecutar — una probe vetada no llega nunca al motor.
  const shields = await Promise.all(guarded.tables.map(async (t) => ({ table: t, shield: await shieldOf(ctx, t) })))
  const veto = probeVeto(guarded.sql, shields)
  if (veto) return { error: `Probe rechazada por el plano de columna: ${veto}`, executed_sql: guarded.sql }
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
    const { url, identities, compare_url } = await ctx.renderPreview()
    // Los campos del roster solo aparecen si la instancia lo declaró (superficie cero sin roster).
    return identities?.length ? { url, identities, compare_url } : { url }
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
  await ctx.createDataRequest(descripcion, tablas)
  return { ok: true, note: 'Requerimiento de datos registrado (handoff a César+Claude). Miranda especifica; la construcción es de ellos en esta fase.' }
}
