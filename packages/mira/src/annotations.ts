// Anotaciones de la capa de VIZ — extraído de mira.ts (NEXT · Ola 3·B).
// Enriquecimiento post-render (NO toca el path de datos/RLS): dadas las claves visibles de una tabla,
// fusiona una columna editable con el valor compartido + el token de escritura firmado que provee el
// llamador (`resolve`). El origen del dato y la firma viven fuera de Mira; acá solo se fusiona.
import type { ResolvedNode } from './compose'

/**
 * Contexto de anotaciones que el llamador (server) inyecta vía `params.annotations`. Mira solo
 * fusiona la columna en la pieza; el origen del dato y la firma del token los provee `resolve`.
 */
export interface AnnotationContext {
  /** Identificador del PI (clave de partición de las anotaciones). */
  piId: string
  /** Etiqueta de la columna. Default "Anotaciones". */
  label?: string
  /** Endpoint POST para escribir una anotación. */
  endpoint: string
  /** Campo-clave del registro. Default: la primera columna de la tabla. */
  keyField?: string
  /** Dataset de la tabla destino. Si viene, la anotación se aplica a la primera tabla cuyo
   *  `dataset` coincida; sin él, a la primera tabla del árbol (DFS, comportamiento clásico). */
  dataset?: string
  /** Dadas las claves visibles, devuelve {clave → {valor compartido, token de escritura firmado}}. */
  resolve(keys: string[]): Promise<Record<string, { value: string; token: string }>>
}

const ANN_VALUE_FIELD = '__ann'
const ANN_TOKEN_FIELD = '__anntok'

/** Encuentra la tabla destino en el árbol (DFS): la primera cuyo `dataset` coincida, o la primera. */
function findTargetTable(node: ResolvedNode, dataset?: string): ResolvedNode | undefined {
  if (node.type === 'table' && (!dataset || node.dataset === dataset)) return node
  for (const c of node.elements ?? []) {
    const f = findTargetTable(c, dataset)
    if (f) return f
  }
  return undefined
}

/** Fusiona la columna de anotación en la tabla destino (por dataset o la primera), por clave de registro. */
export async function applyAnnotations(piece: ResolvedNode, ann: AnnotationContext): Promise<void> {
  const table = findTargetTable(piece, ann.dataset)
  if (!table || !table.columnsSpec || table.columnsSpec.length === 0) return
  // ANTI-ALIASING: `composePiece` copia los ARREGLOS de filas pero no los OBJETOS-fila — mutarlos acá
  // contaminaría con `__ann`/`__anntok` cualquier otro payload que comparta las filas (p.ej.
  // `interactive.datasets`) y, con el data-cache activo, quedaría escrito DENTRO del valor cacheado.
  // Se reemplazan las filas de la tabla destino por copias superficiales antes de mutar.
  const rows = (table.rows ?? []).map((r) => ({ ...r }))
  table.rows = rows
  const keyField = ann.keyField ?? table.columnsSpec[0].field
  const keys = [...new Set(rows.map((r) => String(r[keyField] ?? '')))]
  const map = await ann.resolve(keys)
  for (const r of rows) {
    const k = String(r[keyField] ?? '')
    r[ANN_VALUE_FIELD] = map[k]?.value ?? ''
    r[ANN_TOKEN_FIELD] = map[k]?.token ?? ''
  }
  table.columnsSpec.push({ field: ANN_VALUE_FIELD, label: ann.label ?? 'Anotaciones', annotation: true })
  table.annotation = {
    valueField: ANN_VALUE_FIELD,
    tokenField: ANN_TOKEN_FIELD,
    keyField,
    endpoint: ann.endpoint,
    label: ann.label ?? 'Anotaciones',
  }
}
