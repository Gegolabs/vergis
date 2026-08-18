// Tipos compartidos del render de piezas — extraídos de render-html-piece.ts (NEXT · Ola 3·B).
// Módulo NEUTRAL de tipos: lo importan tanto render-html-piece como los renderers extraídos
// (render-table, …) sin crear ciclo de imports. Aquí no vive lógica, solo el contrato del árbol
// resuelto (ResolvedNode) y las opciones/señales del render.
import type { DashboardMeta, ThemeTokens } from './themes'
import type { NotasRenderContext, TablaAncla } from './notas-render'

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
  /** `true` si el control es multi-select (grupo de checkboxes en la bandeja). */
  multi?: boolean
}
/**
 * Un filtro de bandeja ya resuelto por Mira (#82): sus opciones vigentes (cascadeadas) y la selección
 * efectiva. Su superficie es el tab «Controles» de la bandeja + un chip removible en la cara.
 * Semántica: SUSTRACCIÓN opcional (sin selección = documento completo) — a diferencia del control de
 * cabecera, que es ALCANCE (siempre acota).
 */
export interface FilterResolved {
  id: string
  label: string
  multi: boolean
  options: string[]
  selected: string[]
}

/** Valor(es) de una clave de contexto a preservar en la navegación (multi-select → varios). */
export type CarryCtx = Record<string, string | string[]>
export interface RenderParams {
  piece: ResolvedNode
  title?: string
  theme?: string
  /** Paleta inicial del theme (default por tipo de PI; el usuario la cambia en la bandeja). */
  palette?: string
  meta?: DashboardMeta
  interactive?: Interactive
  /** PI multi-vista: barra de navegación de páginas (links `?page=<id>`). */
  pages?: PagesNav
  /** Controles de cabecera (server-side): selectores que fijan `:ctx.<id>` en las queries. */
  controls?: ControlResolved[]
  /** Contexto que toda navegación (nav de páginas, drills, selectores) debe preservar (p.ej. la semana). */
  carryCtx?: CarryCtx
  /** Capa de NOTAS (vergis#84): endpoints + CSRF + recorte vigente. Ausente ⇒ el PI se sirve sin
   *  bandeja de notas ni marcadores (p.ej. el render de una impresión congelada, que es read-only). */
  notas?: NotasRenderContext
  /** Filtros de bandeja resueltos (#82): control en la bandeja, chip en la cara. */
  filters?: FilterResolved[]
  /** Selección activa de filtros, a preservar en toda navegación (`flt.<id>` repetido). */
  fltCarry?: Record<string, string[]>
  /**
   * Modo PRINT (issue #65 · D4): el documento se rinde para PAPEL (el sidecar HTML→PDF, o el print
   * del navegador). Mismo pipeline, misma identidad, mismo árbol resuelto — pero sin maquinaria: sin
   * shell de bandeja, sin ningún `<script>` (en un motor de print el JS no corre, así que mandarlo
   * solo puede mentir) y con las tablas estáticas y completas. La CARA sí se conserva: banda de
   * contexto, chips de filtros y banner de staleness imprimen el estado bajo el que se generó.
   */
  print?: boolean
  /**
   * URL de descarga del PDF server-side de ESTE documento (issue #65 · D9). Presente ⇒ la bandeja
   * emite el grupo «Descargar» con el botón «Descargar PDF». Ausente ⇒ no existe el botón (la feature
   * está apagada: sin `VERGIS_PDF_SERVICE_URL` no hay ni endpoint ni botón — el mismo `if`).
   */
  pdfUrl?: string
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
}
export interface Aggregation {
  dataset?: string
  op: 'sum' | 'ratio' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct'
  field?: string
  num?: string
  den?: string
}

/**
 * Criterio de orden de las categorías de un `distribution`, YA NORMALIZADO por compose (#81).
 * El DSL declara `sort: magnitude | chrono | value:<serie>` (o el token legacy `-campo`); compose lo
 * resuelve contra las métricas declaradas y el render solo lo aplica.
 * - `magnitude` — orden por magnitud descendente (contrato histórico; en agrupado, por la SUMA de las
 *   series). Es el default cuando el spec no declara `sort`.
 * - `chrono` — NO se re-ordena: manda el orden de llegada de las filas, es decir el `ORDER BY` del
 *   SQL, que es quien conoce el calendario. El motor NO parsea meses ni fechas.
 * - `value` — orden por UNA serie declarada (`field`, con su `label` para trazar el spec).
 * - `field` — token legacy (`-campo` / `campo`) del modo mono; compose ya pre-ordenó las filas.
 */
export type ChartSort =
  | { kind: 'magnitude' }
  | { kind: 'chrono' }
  | { kind: 'value'; field: string; label: string }
  | { kind: 'field'; field: string; desc: boolean }

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
  /** `distribution` multi-métrica: 2+ series agrupadas (barras). Presente ⇒ modo agrupado. */
  metricsSpec?: { field: string; label: string }[]
  /** `distribution` agrupado: apila las series en vez de yuxtaponerlas (#203). */
  stacked?: boolean
  /** `distribution`: criterio de orden de las categorías, ya normalizado por compose (#81). */
  sortSpec?: ChartSort
  orientation?: string
  title?: string
  /** `series`: campo del eje x (categórico/ordinal; el SQL manda el orden de las filas). */
  xField?: string
  /** `series`: 1..N series (formato wide, una columna por serie). */
  seriesSpec?: { field: string; label: string }[]
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
  /** Tabla: acciones de drill-through por fila (a la vista `to` pasando las claves `by`). */
  drills?: Drill[]
  /** Tabla: llave de negocio declarada por su dataset (`anchor`) + lo ya comentado sobre las filas
   *  servidas. Presente ⇒ cada fila lleva su llave canónica y el gesto de comentar se ofrece;
   *  ausente ⇒ no se ofrece (fail-closed, D16). */
  ancla?: TablaAncla
}

/** Una acción de drill-through: a la vista `to`, pasando una o más claves de contexto `by`. */
export interface Drill {
  to: string
  by: string[]
  label?: string
}

export interface RenderOpts {
  tokens: ThemeTokens
  /** Mapa hex→CSS var para abrir los colores horneados del SVG al conmutador de Apariencia (#78). */
  chartVars?: Record<string, string>
  /**
   * Sufijo de query con los filtros de bandeja activos (`&flt.k=v…`), YA serializado. Se calcula una
   * vez server-side y se anexa a todo href de navegación (drills incluidos), también en el runtime
   * client-side de la tabla — así el carry de los `flt.` no se re-implementa en dos lugares.
   */
  fltQ?: string
  interactive: boolean
  /** Modo PRINT (issue #65 · D5): las tablas se rinden estáticas y COMPLETAS (sin runtime, sin
   *  scroll-wrapper, sin payload JSON, sin drills) hasta `TABLE_PRINT_MAX_ROWS`. */
  print?: boolean
  /** Contexto a preservar en los hrefs de drill (p.ej. la semana del control de cabecera). */
  carry: CarryCtx
  /** Señales que el render acumula para decidir qué CSS/runtime inyectar arriba. Evita re-inspeccionar
   *  el HTML ya emitido (`body.includes('class="table vtable"')`), frágil ante un rename de clase. */
  signals: RenderSignals
}

/** Qué features aparecieron en el árbol renderizado (las marca quien las emite, no un sniff de string). */
export interface RenderSignals {
  /** Hay al menos una tabla INTERACTIVA (runtime de orden/filtro/búsqueda + bandeja + CSS interactivo). */
  interactiveTable: boolean
  /** Hay celdas de acciones de drill (`vt-actions`) → requiere DRILL_ACTIONS_CSS. */
  drillActions: boolean
  /** Hay al menos una celda con color de magnitud emitido (#210) → requiere MAGNITUDE_CSS y el
   *  interruptor de la bandeja. La marca quien la emite: un interruptor que no enciende nada es
   *  peor que su ausencia, y una tabla ESTÁTICA también puede traer magnitud. */
  magnitude: boolean
}
