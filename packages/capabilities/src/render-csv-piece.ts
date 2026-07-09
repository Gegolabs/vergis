import { VergisError, type Capability } from '@vergis/botler'
import type { ResolvedNode, TableColumn } from './piece-types'

/**
 * `render-csv-piece` — árbol de pieza resuelto (compuesto por Mira) → artefacto CSV de LA(S) TABLA(S).
 *
 * Diseño (work/052 §3.6):
 *  - Se exportan SOLO las tablas del árbol (KPIs/charts/semáforos son presentación; el dato tabular
 *    es lo que un consumidor quiere re-procesar). Sin tablas → fail-loud (pedir csv de un PI sin
 *    tablas es un error de spec, no un CSV vacío silencioso).
 *  - Headers = labels de las columnas declaradas; valores RAW sin formatear (el CSV es para máquinas
 *    y planillas: `0.432`, no `43.2%`). Date → ISO `YYYY-MM-DD`.
 *  - Las columnas de ANOTACIÓN (`annotation: true`) se omiten: son enriquecimiento de la capa de viz,
 *    no dato del PI.
 *  - VARIAS tablas → un solo CSV concatenado por SECCIONES: cada tabla precedida por una fila-título
 *    (`# <título>`, una sola celda) y separada de la anterior por una línea en blanco. Un CSV por
 *    tabla obligaría a multiplicar artefactos/nombres; la concatenación seccionada mantiene 1 PI = 1
 *    artefacto y cualquier planilla la abre legible.
 *  - Escaping RFC 4180: se citan los valores con coma, comilla o salto de línea; `"` interna → `""`.
 *  - `bom` (opt-in, default off): antepone el BOM UTF-8 (`﻿`). Excel en Windows asume la codificación
 *    local (no UTF-8) al abrir un CSV sin BOM → los acentos salen como mojibake. El BOM se lo dice. Off por
 *    defecto porque muchos parsers de máquina lo tratan como un caracter espurio de la 1ª celda.
 */
const UTF8_BOM = '﻿'
export const renderCsvPiece: Capability = {
  name: 'render-csv-piece',
  async execute(params: unknown): Promise<unknown> {
    const { piece, title, bom } = (params ?? {}) as { piece?: ResolvedNode; title?: string; bom?: boolean }
    if (!piece) throw new Error('render-csv-piece: falta el árbol de pieza (piece)')
    const tables = collectTables(piece)
    if (tables.length === 0) {
      throw new VergisError({
        error: 'render-csv-piece',
        code: 'csv-no-tables',
        message: `El PI '${title ?? '—'}' declara render csv pero su pieza no contiene ninguna tabla.`,
        remediation: 'Quitar el render csv o añadir un elemento table a la pieza (el CSV exporta tablas).',
      })
    }
    const sections = tables.map((t, i) => tableToCsv(t, tables.length > 1 ? t.title ?? `tabla_${i + 1}` : undefined))
    return { csv: (bom ? UTF8_BOM : '') + sections.join('\n') }
  },
}

/** Recolecta TODAS las tablas del árbol de pieza (DFS, en orden de aparición). */
function collectTables(node: ResolvedNode, acc: ResolvedNode[] = []): ResolvedNode[] {
  if (node.type === 'table') acc.push(node)
  for (const c of node.elements ?? []) collectTables(c, acc)
  return acc
}

/** Una tabla → líneas CSV. Con `sectionTitle`, se antepone la fila-título `# <título>`. */
function tableToCsv(table: ResolvedNode, sectionTitle?: string): string {
  const cols = (table.columnsSpec ?? []).filter((c) => !c.annotation)
  const rows = table.rows ?? []
  const lines: string[] = []
  if (sectionTitle != null) lines.push(csvField(`# ${sectionTitle}`))
  lines.push(cols.map((c) => csvField(c.label ?? c.field)).join(','))
  for (const r of rows) lines.push(cols.map((c) => csvField(rawValue(r[c.field]))).join(','))
  return lines.join('\n') + '\n'
}

/** Valor RAW para CSV: sin formatear (números tal cual); Date → ISO fecha; null/undefined → vacío. */
function rawValue(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v)
  // Neutralización de formula injection: una celda de TEXTO que empieza con un caracter de fórmula
  // (`= + - @`, tab o CR) se ejecuta al abrir en Excel/Sheets. Se antepone `'` solo a strings —
  // los números crudos (que el diseño exige sin formatear) quedan intactos.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) return `'${s}`
  return s
}

/** Escapa un campo según RFC 4180: se cita si contiene coma, comilla o salto de línea. */
function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
