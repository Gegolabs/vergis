/**
 * Registro de tools: arma el array de definiciones (schema Anthropic tool-use) y el dispatcher que
 * ejecuta una tool por nombre contra el `MirandaToolContext`. El loop del agente (WP3) consume ambos.
 */
import type { MirandaToolContext } from './context'
import {
  catalogTables,
  describeTable,
  profileColumn,
  runProbe,
  listPis,
  readSpec,
  saveDraft,
  updateIntentSummary,
  renderPreview,
  runSelfCheck,
  createDataRequest,
  type ToolResult,
} from './tools'

export type { MirandaToolContext, ToolResult }
export type { CatalogEntry, SpecRef } from './context'

/** Definición de una tool en el formato de la Messages API de Anthropic. */
export interface ToolDefinition {
  name: string
  description: string
  input_schema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
}

type ToolFn = (input: unknown, ctx: MirandaToolContext) => Promise<ToolResult>

interface ToolEntry {
  def: ToolDefinition
  fn: ToolFn
}

const OBJ = (properties: Record<string, unknown> = {}, required: string[] = []): ToolDefinition['input_schema'] => ({
  type: 'object',
  properties,
  required,
})

const ENTRIES: ToolEntry[] = [
  {
    def: { name: 'catalog_tables', description: 'Lista los objetos (tablas/vistas) del catálogo de instancia que puedes consultar. SOLO el allowlist — no hay acceso abierto al esquema.', input_schema: OBJ() },
    fn: catalogTables,
  },
  {
    def: {
      name: 'describe_table',
      description: 'Devuelve columnas+tipos y 3 filas de muestra (en repr(): las comillas revelan espacios/mayúsculas). Úsalo para aterrizar la realizabilidad antes de escribir SQL.',
      input_schema: OBJ({ name: { type: 'string', description: 'Nombre del objeto del catálogo.' } }, ['name']),
    },
    fn: describeTable,
  },
  {
    def: {
      name: 'profile_column',
      description: 'Top-N valores distintos de una columna con su conteo, en repr(). Detecta trampas como \'TC \' (con espacio) vs \'TC\'.',
      input_schema: OBJ({ table: { type: 'string' }, column: { type: 'string' }, top: { type: 'integer', description: 'default 20, máx 100' } }, ['table', 'column']),
    },
    fn: profileColumn,
  },
  {
    def: {
      name: 'run_probe',
      description: 'Ejecuta un SELECT de exploración (≤500 filas, forzado). Un solo SELECT, sin CTE/DML. `why` se registra para auditoría. Úsalo para reconciliar cifras antes del self-check.',
      input_schema: OBJ({ sql: { type: 'string' }, why: { type: 'string', description: 'Por qué corres esta probe.' } }, ['sql', 'why']),
    },
    fn: runProbe,
  },
  {
    def: { name: 'list_pis', description: 'Lista las specs de PI existentes como ejemplares (read-only).', input_schema: OBJ() },
    fn: listPis,
  },
  {
    def: { name: 'read_spec', description: 'Devuelve el YAML de una spec existente como ejemplar (read-only). NO la edites: es de otro proceso.', input_schema: OBJ({ code: { type: 'string' } }, ['code']) },
    fn: readSpec,
  },
  {
    def: {
      name: 'save_draft',
      description: 'Valida el draft con el parser+validador del DSL y lo guarda como versión nueva (append-only). Devuelve errores estructurados si no valida. NUNCA escribe al directorio de specs (eso es publish).',
      input_schema: OBJ({ yaml: { type: 'string', description: 'El spec DSL completo (YAML).' } }, ['yaml']),
    },
    fn: saveDraft,
  },
  {
    def: {
      name: 'update_intent_summary',
      description: 'Actualiza el resumen de intención que el usuario valida (JSON estructurado, nunca YAML). Cada campo debe ser verificable por el usuario sin saber del DSL. Si la sesión estaba validada, vuelve a borrador.',
      input_schema: OBJ(
        {
          titulo: { type: 'string' },
          pregunta_de_negocio: { type: 'string' },
          audiencia: { type: 'string' },
          fuentes: { type: 'array' },
          grano: { type: 'string' },
          medidas: { type: 'array' },
          dimensiones: { type: 'array' },
          controles: { type: 'array' },
          vistas: {
            type: 'array',
            description:
              'Forma visual POR VISTA (validable sin ver el DSL): una entrada por vista/página con {nombre, forma: tabla|dashboard|mixta, piezas: [tarjetas|graficos|tabla]}. La forma debe calzar con las piezas del draft.',
            items: {
              type: 'object',
              properties: {
                nombre: { type: 'string' },
                forma: { type: 'string', enum: ['tabla', 'dashboard', 'mixta'] },
                piezas: { type: 'array', items: { type: 'string', enum: ['tarjetas', 'graficos', 'tabla'] } },
              },
              required: ['nombre', 'forma'],
            },
          },
          reglas: { type: 'array' },
          estados_o_casos_borde: { type: 'array' },
          criterios_de_aceptacion: { type: 'array' },
          fuera_de_alcance: { type: 'array' },
          pendientes_de_datos: { type: 'array' },
        },
        ['titulo', 'pregunta_de_negocio', 'audiencia', 'grano'],
      ),
    },
    fn: updateIntentSummary,
  },
  {
    def: {
      name: 'render_preview',
      description:
        'Registra el último draft como preview efímera servida por el riel RLS real y devuelve su URL. Si la instancia declaró identidades inspeccionables, devuelve también una URL por etiqueta (`identities`) y la del comparador lado a lado (`compare_url`): ofrécelas para verificar que la RLS hace lo que la política dice.',
      input_schema: OBJ(),
    },
    fn: renderPreview,
  },
  {
    def: { name: 'run_self_check', description: 'Corre el self-check QC① (juez separado) sobre el draft + resumen + probes. Devuelve veredicto y brechas. Obligatorio antes de publicar.', input_schema: OBJ() },
    fn: runSelfCheck,
  },
  {
    def: {
      name: 'create_data_request',
      description: 'Registra un requerimiento de datos (handoff a César+Claude) cuando la intención pide datos que el catálogo NO tiene. Miranda especifica; NO construye datos en esta fase.',
      input_schema: OBJ({ descripcion: { type: 'string' }, tablas_faltantes: { type: 'array' } }, ['descripcion']),
    },
    fn: createDataRequest,
  },
]

export interface ToolRegistry {
  /** Definiciones para pasar a la Messages API (`tools`). */
  definitions: ToolDefinition[]
  /** Nombres registrados. */
  names: string[]
  /** Ejecuta una tool por nombre. Una tool desconocida devuelve un error estructurado (no lanza). */
  invoke(name: string, input: unknown): Promise<ToolResult>
}

export function buildToolRegistry(ctx: MirandaToolContext): ToolRegistry {
  const byName = new Map(ENTRIES.map((e) => [e.def.name, e]))
  return {
    definitions: ENTRIES.map((e) => e.def),
    names: ENTRIES.map((e) => e.def.name),
    async invoke(name, input) {
      const entry = byName.get(name)
      if (!entry) return { error: `Tool desconocida: '${name}'.` }
      return entry.fn(input, ctx)
    },
  }
}
