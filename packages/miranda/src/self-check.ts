/**
 * Self-check QC① interiorizado (visión §«El QC① no muere: se interioriza»). Es una llamada SEPARADA al
 * modelo (juez ≠ autor) con la rúbrica y el método QC① montados por la instancia + el draft + el resumen
 * de intención + los resultados de las probes de reconciliación/perfiles. Salida JSON FORZADA por una
 * tool (`emit_qc_report`) con el MISMO vocabulario cerrado del método (veredicto + brechas B/M/m/i).
 *
 * El gate de publish (WP6) vive en CÓDIGO, no en el prompt: rechaza si el último qc_report tiene B/M
 * abiertas o si la sesión no está `validado`.
 */
import type { AnthropicTransport, ToolUseBlock } from './transport'
import type { ToolDefinition } from './tools/registry'
import { VEREDICTOS, SEVERIDADES, type SelfCheckResult, type Veredicto, type Severidad, type Brecha } from './qc'

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
  return normalizeReport(toolUse.input)
}
