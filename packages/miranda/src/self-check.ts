/**
 * Self-check QC① interiorizado (visión §«El QC① no muere: se interioriza»). Es una llamada SEPARADA al
 * modelo (juez ≠ autor) con la rúbrica y el método QC① montados por la instancia + el draft + el resumen
 * de intención + los resultados de las probes de reconciliación/perfiles. Salida JSON FORZADA por una
 * tool (`emit_qc_report`) con el MISMO vocabulario cerrado del método (veredicto + brechas B/M/m/i).
 *
 * El gate de publish (WP6) vive en CÓDIGO, no en el prompt: rechaza si el último qc_report tiene B/M
 * abiertas o si la sesión no está `validado`.
 */
import YAML from 'yaml'
import type { AnthropicTransport, ToolUseBlock } from './transport'
import type { ToolDefinition } from './tools/registry'
import { VEREDICTOS, SEVERIDADES, hasBlockingGaps, type SelfCheckResult, type Veredicto, type Severidad, type Brecha } from './qc'
import { crossCheckForma } from './forma'
import { normalizeIntent, type FormaVista } from './intent'

export type { SelfCheckResult, Brecha } from './qc'

export interface SelfCheckDeps {
  transport: AnthropicTransport
  model: string
  /** Rúbrica + método QC① (montados desde MIRANDA_RUBRIC_DIR). Opcional: sin ella, el juez usa lo mínimo. */
  rubric?: string
  /** El draft DSL a juzgar. */
  draftYaml: string
  /** El resumen de intención vigente (JSON serializado). */
  intentSummary: string
  /** Contexto de realizabilidad: perfiles repr() de las columnas usadas + probes de reconciliación,
   *  ensamblado por el llamador desde las tool-calls previas (guard anti-`'TC '`). */
  probeContext?: string
  /** Las `database_ref` configuradas en los perfiles de conexión de este despliegue (mismo valor que
   *  el contexto de tools). `undefined` = el llamador no las conoce (compat) → no se cruzan. */
  configuredRefs?: string[]
  maxTokens?: number
}

const REPORT_TOOL: ToolDefinition = {
  name: 'emit_qc_report',
  description: 'Emite el veredicto del QC① y las brechas encontradas. Es la ÚNICA salida válida.',
  input_schema: {
    type: 'object',
    properties: {
      veredicto: { type: 'string', enum: VEREDICTOS as unknown as string[] },
      brechas: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            sev: { type: 'string', enum: SEVERIDADES as unknown as string[] },
            brecha: { type: 'string' },
            donde: { type: 'string' },
            recomendacion: { type: 'string' },
          },
          required: ['id', 'sev', 'brecha', 'donde', 'recomendacion'],
        },
      },
    },
    required: ['veredicto', 'brechas'],
  } as ToolDefinition['input_schema'],
}

const JUDGE_IDENTITY = `Eres el QC① de Miranda: un revisor de specs de PI SEPARADO del autor (juez ≠ autor).
Tu trabajo es detectar si el draft es CONSTRUIBLE sin ambigüedad, REALIZABLE contra el dato real, y si sus
cifras RECONCILIAN. Vocabulario CERRADO de veredictos: APROBADA · APROBABLE · NO_APROBABLE · NO_REVISABLE.
Severidades: B bloqueante · M mayor · m menor · i informativo. Clases de brecha que SIEMPRE debes cazar:
- filtro literal que no calza con el perfil real de la columna (p.ej. 'TC ' con espacio vs 'TC') → M o B;
- medida agregada SIN probe de reconciliación en el contexto → M;
- promesa de datos que el catálogo no respalda → B;
- autorización escrita en el spec (debe ser authz-blind) → B.
Emite SIEMPRE tu resultado llamando a la tool emit_qc_report; no escribas prosa.`

/** Construye el system prompt del juez. */
export function buildJudgeSystem(rubric?: string): string {
  return rubric && rubric.trim() ? `${JUDGE_IDENTITY}\n\nRÚBRICA Y MÉTODO QC①:\n${rubric.trim()}` : JUDGE_IDENTITY
}

function normalizeReport(input: unknown): SelfCheckResult {
  const o = (input ?? {}) as Record<string, unknown>
  const veredicto = (VEREDICTOS as readonly string[]).includes(String(o['veredicto'])) ? (o['veredicto'] as Veredicto) : 'NO_REVISABLE'
  const rawBrechas = Array.isArray(o['brechas']) ? (o['brechas'] as unknown[]) : []
  const brechas: Brecha[] = rawBrechas.map((b, i) => {
    const r = (b ?? {}) as Record<string, unknown>
    const sev = (SEVERIDADES as readonly string[]).includes(String(r['sev'])) ? (r['sev'] as Severidad) : 'i'
    return {
      id: String(r['id'] ?? `G${i + 1}`),
      sev,
      brecha: String(r['brecha'] ?? ''),
      donde: String(r['donde'] ?? ''),
      recomendacion: String(r['recomendacion'] ?? ''),
    }
  })
  return { veredicto, brechas }
}

/** Corre el self-check y devuelve el veredicto normalizado (vocabulario cerrado). */
export async function runSelfCheck(deps: SelfCheckDeps): Promise<SelfCheckResult> {
  const userParts = [
    `RESUMEN DE INTENCIÓN (lo que el usuario validó):\n${deps.intentSummary}`,
    `DRAFT DSL A JUZGAR:\n${deps.draftYaml}`,
  ]
  if (deps.probeContext && deps.probeContext.trim()) {
    userParts.push(`CONTEXTO DE REALIZABILIDAD (perfiles repr() + probes de reconciliación):\n${deps.probeContext.trim()}`)
  } else {
    userParts.push('CONTEXTO DE REALIZABILIDAD: (ninguna probe adjunta — evalúa esto como una posible brecha de reconciliación).')
  }
  const resp = await deps.transport.createMessage({
    model: deps.model,
    system: buildJudgeSystem(deps.rubric),
    messages: [{ role: 'user', content: userParts.join('\n\n') }],
    tools: [REPORT_TOOL],
    tool_choice: { type: 'tool', name: 'emit_qc_report' },
    max_tokens: deps.maxTokens ?? 2048,
  })
  const toolUse = (resp.content as { type: string }[]).find((b): b is ToolUseBlock => b.type === 'tool_use') as ToolUseBlock | undefined
  if (!toolUse) return { veredicto: 'NO_REVISABLE', brechas: [{ id: 'G0', sev: 'B', brecha: 'El juez no emitió un reporte estructurado.', donde: 'self-check', recomendacion: 'Reintentar el self-check.' }] }
  const report = normalizeReport(toolUse.input)
  const withForma = mergeFormaCross(report, deps.intentSummary, deps.draftYaml)
  return mergeRefsCross(withForma, deps.draftYaml, deps.configuredRefs)
}

/** Extrae `vistas[]` del resumen de intención serializado (tolerante: JSON ilegible → sin vistas). */
function declaredVistas(intentJson: string): FormaVista[] | undefined {
  try {
    const o = JSON.parse(intentJson) as Record<string, unknown>
    return normalizeIntent(o).vistas
  } catch {
    return undefined
  }
}

/**
 * Funde el cruce de FORMA por vista (enforcement en código) al reporte del juez. Si el cruce agrega
 * brechas B/M y el veredicto del juez era APROBADA, se degrada a APROBABLE (una M es incompatible con
 * APROBADA en el vocabulario del método). IDs `FORMA-N` estables entre rondas.
 */
export function mergeFormaCross(report: SelfCheckResult, intentJson: string, draftYaml: string): SelfCheckResult {
  const formaBrechas = crossCheckForma(declaredVistas(intentJson), draftYaml)
  if (formaBrechas.length === 0) return report
  const brechas = [...report.brechas, ...formaBrechas]
  const veredicto: Veredicto = report.veredicto === 'APROBADA' && hasBlockingGaps(brechas) ? 'APROBABLE' : report.veredicto
  return { veredicto, brechas }
}

/**
 * Cruce de `database_ref` (enforcement en CÓDIGO — bug destapado por entrega-primero, arnés
 * 2026-07-17): el autor puede copiar una `database_ref` de un EJEMPLO del documento DSL que no existe
 * en los perfiles de conexión de este entorno; el juez-modelo no la caza (no conoce los perfiles) y el
 * error revienta recién al servir la preview (500 del riel). Aquí se valida cada dataset del draft
 * contra las refs configuradas y se emite brecha BLOQUEANTE con mensaje accionable (causa + refs
 * válidas), para que el autor se auto-corrija en el MISMO turno, antes de la preview.
 * `configuredRefs === undefined` = el llamador no conoce los perfiles (compat) → no se cruza.
 * Un YAML ilegible o sin `data` no es asunto de este cruce (lo cazan el validador y el juez).
 * IDs estables `REF-N` (orden de los datasets en el draft).
 */
export function crossCheckRefs(draftYaml: string, configuredRefs?: string[]): Brecha[] {
  if (configuredRefs === undefined) return []
  let spec: Record<string, unknown>
  try {
    spec = (YAML.parse(draftYaml) ?? {}) as Record<string, unknown>
  } catch {
    return []
  }
  const data = spec['data']
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return []
  const valid = new Set(configuredRefs)
  const listado = configuredRefs.length > 0 ? configuredRefs.join(', ') : '(ninguna)'
  const brechas: Brecha[] = []
  let n = 1
  for (const [dataset, defRaw] of Object.entries(data as Record<string, unknown>)) {
    const def = (defRaw ?? {}) as Record<string, unknown>
    const params = (def['params'] ?? {}) as Record<string, unknown>
    const ref = params['database_ref']
    if (typeof ref !== 'string' || ref === '' || valid.has(ref)) continue
    brechas.push({
      id: `REF-${n++}`,
      sev: 'B',
      brecha: `El dataset '${dataset}' usa database_ref '${ref}', que NO está configurada en los perfiles de conexión de este entorno: la preview/serving fallaría al conectar.`,
      donde: `data.${dataset}.params.database_ref`,
      recomendacion: `Usa la database_ref de la entrada de catálogo de la fuente (jamás una copiada de un ejemplo del DSL). Las configuradas en este entorno son: ${listado}.`,
    })
  }
  return brechas
}

/**
 * Funde el cruce de `database_ref` al reporte del juez (mismo contrato que `mergeFormaCross`): las
 * brechas REF-N son B, así que un veredicto APROBADA se degrada a APROBABLE; el gate de publish (en
 * código) las honra igual que cualquier B.
 */
export function mergeRefsCross(report: SelfCheckResult, draftYaml: string, configuredRefs?: string[]): SelfCheckResult {
  const refBrechas = crossCheckRefs(draftYaml, configuredRefs)
  if (refBrechas.length === 0) return report
  const brechas = [...report.brechas, ...refBrechas]
  const veredicto: Veredicto = report.veredicto === 'APROBADA' && hasBlockingGaps(brechas) ? 'APROBABLE' : report.veredicto
  return { veredicto, brechas }
}
