// Tipos compartidos del render de piezas — extraídos de render-html-piece.ts (NEXT · Ola 3·B).
// Módulo NEUTRAL de tipos: lo importan tanto render-html-piece como los renderers extraídos
// (render-table, …) sin crear ciclo de imports. Aquí no vive lógica, solo el contrato del árbol
// resuelto (ResolvedNode) y las opciones/señales del render.
import type { DashboardMeta, ThemeTokens } from './themes'

export interface FilterSpec {
  dataset: string
  field: string
  label?: string
  multi?: boolean
}
export interface Interactive {
  datasets: Record<string, Record<string, unknown>[]>
  /** Los filtros disponibles que viven en la bandeja. */
  filters: FilterSpec[]
}
export interface PagesNav {
  items: { id: string; title: string }[]
  active: string
}
/** Control de cabecera ya resuelto por Mira: opciones + valor(es) seleccionado(s). */
export interface ControlResolved {
  id: string
  /** Clave de contexto que fija (default = `id`); dos controles con igual `param` = llaves alternativas. */
  param?: string
  label: string
  /** Opciones: pares `{value, label}` (el render tolera `string[]` con label = value por compat). */
  options: (string | { value: string; label: string })[]
  /** Valor VIGENTE (la llave; multi: los valores unidos por ", "). */
  value: string
  /** Etiqueta del valor vigente para el print/summary (default = `value`). */
  displayLabel?: string
  /** Solo multi-select: los valores seleccionados. */
  values?: string[]
  /** `true` si el control es multi-select (grupo de checkboxes en la gaveta). */
  multi?: boolean
}
/** Valor(es) de una clave de contexto a preservar en la navegación (multi-select → varios). */
export type CarryCtx = Record<string, string | string[]>
export interface RenderParams {
  piece: ResolvedNode
  title?: string
  theme?: string
  /** Paleta inicial del theme (default por tipo de PI; el usuario la cambia en la gaveta). */
  palette?: string
  meta?: DashboardMeta
  interactive?: Interactive
  /** PI multi-vista: barra de navegación de páginas (links `?page=<id>`). */
  pages?: PagesNav
  /** Controles de cabecera (server-side): selectores que fijan `:ctx.<id>` en las queries. */
  controls?: ControlResolved[]
  /** Contexto que toda navegación (nav de páginas, drills, selectores) debe preservar (p.ej. la semana). */
  carryCtx?: CarryCtx
}

export interface TableColumn {
  field: string
  label?: string
  format?: string
  align?: string
  colorscale?: boolean
  /** Override del auto-on: orden por esta columna (default: true). */
  sortable?: boolean
  /** Override del auto-on: búsqueda por esta columna (default: true). */
  searchable?: boolean
  /** Override de la heurística: faceta de filtro (default: auto por cardinalidad). */
  filter?: boolean
  /** Override de la heurística: disponible para agrupar (default: igual que filter). */
  groupBy?: boolean
  /** Columna de anotación (editable; enriquecimiento de la capa de viz). */
  annotation?: boolean
}
export interface Aggregation {
  dataset?: string
  op: 'sum' | 'ratio' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct'
  field?: string
  num?: string
  den?: string
}

export interface ResolvedNode {
  layout?: string
  columns?: number
  elements?: ResolvedNode[]
  type?: string
  content?: string
  value?: unknown
  label?: string
  format?: string
  accent?: string
  comparison?: unknown
  comparisonLabel?: string
  agg?: Aggregation
  comparisonAgg?: Aggregation
  size?: string
  span?: number
  rows?: Record<string, unknown>[]
  dimensionField?: string
  metricField?: string
  orientation?: string
  title?: string
  columnsSpec?: TableColumn[]
  labelField?: string
  presentField?: string
  totalField?: string
  pctField?: string
  thresholds?: { green?: number; yellow?: number }
  dataset?: string
  summary?: { value?: unknown; label?: string; format?: string; accent?: string; agg?: Aggregation; dataset?: string }
  /** Tabla: `false` desactiva la interactividad (orden/filtro/búsqueda/agrupar) → tabla estática. */
  interactive?: boolean
  /** Tabla: meta de anotaciones (columna editable compartida). */
  annotation?: { valueField: string; tokenField: string; keyField: string; endpoint: string; label: string }
  /** Tabla: acciones de drill-through por fila (a la vista `to` pasando las claves `by`). */
  drills?: Drill[]
}

/** Una acción de drill-through: a la vista `to`, pasando una o más claves de contexto `by`. */
export interface Drill {
  to: string
  by: string[]
  label?: string
}

export interface RenderOpts {
  tokens: ThemeTokens
  interactive: boolean
  /** Contexto a preservar en los hrefs de drill (p.ej. la semana del control de cabecera). */
  carry: CarryCtx
  /** Señales que el render acumula para decidir qué CSS/runtime inyectar arriba. Evita re-inspeccionar
   *  el HTML ya emitido (`body.includes('class="table vtable"')`), frágil ante un rename de clase. */
  signals: RenderSignals
}

/** Qué features aparecieron en el árbol renderizado (las marca quien las emite, no un sniff de string). */
export interface RenderSignals {
  /** Hay al menos una tabla INTERACTIVA (runtime de orden/filtro/búsqueda + gaveta + CSS interactivo). */
  interactiveTable: boolean
  /** Hay celdas de acciones de drill (`vt-actions`) → requiere DRILL_ACTIONS_CSS. */
  drillActions: boolean
}
