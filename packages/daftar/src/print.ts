/**
 * Port FIEL de `render_print` y sus ayudantes (`server.py` de Daftar, ~l. 380-580): la guía con las
 * respuestas del estudiante, para imprimir y entregar en el colegio.
 *
 * «Fiel» acá tiene una vara medida, no declarada: `tests/daftar-print.test.ts` compara la salida de
 * este módulo contra el HTML que el Python produce sobre las MISMAS fixtures sintéticas, tipo por
 * tipo de ejercicio. Por eso se conservan sus rarezas —`text` sin escapar en `fill`/`classify`/
 * `true_false`/`compare`, la leyenda de `highlight` que aparece cuando el número del ejercicio
 * contiene «1.», el `letters` de ocho caracteres— en vez de «arreglarlas» al portar.
 */
import { esc } from './html'
import type { Guia, Progreso, Seccion, Ejercicio, EstudianteInfo } from './tipos'
import { choiceOf, confOf, CONF_TITLES, tokenizar, esPalabra } from './tipos'

export const CATEGORY_COLORS: [string, string][] = [
  ['#e74c3c', '#f8d7da'],
  ['#17a2b8', '#d1ecf1'],
  ['#28a745', '#d4edda'],
  ['#d4a017', '#fff3cd'],
]

const PRINT_CSS = `
  @page { margin: 2cm 1.5cm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #222;
  }
  .print-header {
    text-align: center;
    margin-bottom: 1.5em;
    padding-bottom: 0.75em;
    border-bottom: 2px solid #333;
  }
  .print-header h1 { font-size: 14pt; margin-bottom: 0.15em; }
  .print-header h2 { font-size: 12pt; font-weight: normal; color: #555; }
  .print-header .meta { font-size: 9pt; color: #777; margin-top: 0.3em; }
  .print-header .student {
    margin-top: 0.5em;
    font-size: 11pt;
  }
  .print-header .student-name {
    border-bottom: 1px solid #333;
    padding: 0 1em;
    font-weight: 600;
  }
  .section {
    margin-bottom: 1.2em;
    page-break-inside: avoid;
  }
  .section-title {
    font-size: 11pt;
    font-weight: 700;
    color: #2c6fbb;
    margin-bottom: 0.15em;
  }
  .section-instructions {
    font-size: 10pt;
    color: #555;
    font-style: italic;
    margin-bottom: 0.5em;
  }
  .exercise {
    margin-bottom: 0.5em;
    padding-left: 0.3em;
  }
  .ex-num {
    font-weight: 700;
    color: #888;
    margin-right: 0.3em;
  }
  .student-answer {
    display: inline-block;
    border-bottom: 1.5px solid #333;
    padding: 0 0.4em;
    min-width: 60px;
    font-weight: 600;
    color: #222;
    font-size: 10pt;
  }
  .student-answer.empty {
    color: #ccc;
    font-style: italic;
    font-weight: 400;
  }
  .word-tag {
    display: inline-block;
    padding: 0 0.3em;
    border-radius: 3px;
    font-weight: 600;
    font-size: 10pt;
    margin: 0 0.05em;
    text-decoration: underline;
    text-decoration-thickness: 2px;
  }
  .word-plain { display: inline; font-size: 10pt; }
  .legend {
    font-size: 9pt;
    color: #555;
    margin-bottom: 0.4em;
  }
  .legend-swatch {
    display: inline-block;
    width: 10px; height: 10px;
    border-radius: 2px;
    margin-right: 0.15em;
    vertical-align: middle;
  }
  .mc-option { margin-left: 1.5em; }
  .conf-tag {
    display: inline-block; font-size: 8.5pt; font-weight: 700;
    border: 1px solid #999; border-radius: 3px; padding: 0 0.3em; margin-left: 0.4em;
  }
  .mc-option.selected { font-weight: 700; }
  .free-text-answer {
    margin: 0.3em 0 0.3em 1.5em;
    padding: 0.4em 0.6em;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 10pt;
    white-space: pre-wrap;
    min-height: 2em;
  }
  .print-footer {
    margin-top: 2em;
    padding-top: 0.5em;
    border-top: 1px solid #ccc;
    text-align: center;
    font-size: 8pt;
    color: #aaa;
  }
  @media print {
    .no-print { display: none; }
  }
  .no-print {
    text-align: center;
    margin-bottom: 1em;
  }
  .no-print button {
    background: #2c6fbb; color: white; border: none;
    border-radius: 6px; padding: 0.5em 1.5em;
    font-size: 11pt; font-weight: 600; cursor: pointer;
  }
  .no-print button:hover { background: #245a9e; }
  .no-print a { margin-left: 1em; color: #2c6fbb; font-size: 10pt; }
  .no-print .status { font-size: 9pt; color: #888; margin-top: 0.3em; }
`

export interface PrintOpts {
  blank?: boolean
  /** Estudiantes de la spec (reemplaza el `STUDENT_INFO` de `server.py`). */
  estudiantes: Record<string, EstudianteInfo>
  /** Prefijo del Let (`/estudios`) para el enlace «Volver». En Python era `/` a secas. */
  base: string
}

export function renderPrint(guide: Guia, progress: Progreso, opts: PrintOpts): string {
  const blank = !!opts.blank
  const title = esc(guide.title ?? '')
  const subtitle = esc(guide.subtitle ?? '')
  const institution = esc(guide.institution ?? '')
  const department = esc(guide.department ?? '')
  const sections = guide.sections ?? []
  const progSections = progress.sections ?? {}

  const sectionsHtml: string[] = []
  sections.forEach((section, si) => {
    const answers = (progSections[String(si)]?.answers ?? []) as unknown[]
    sectionsHtml.push(renderSection(section, answers, blank))
  })

  const hasProgress = Object.keys(progSections).length > 0
  const status = blank
    ? 'Versión en blanco — para llenar a mano'
    : hasProgress
      ? 'Guía completada por el estudiante'
      : 'Sin respuestas registradas — el estudiante aún no ha trabajado esta guía en Daftar'

  const studentKey = guide.student ?? 'sebas'
  const info = opts.estudiantes[studentKey] ?? { name: studentKey, grade: '' }
  const studentName = esc(info.name)
  const studentGrade = esc(info.grade)

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${title} — ${studentName}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
  <div class="no-print">
    <button onclick="window.print()">Imprimir / Guardar PDF</button>
    <a href="${opts.base}/">← Volver</a>
    <div class="status">${status}</div>
  </div>
  <div class="print-header">
    <h1>${title}</h1>
    <h2>${subtitle}</h2>
    <div class="meta">${institution} — ${department}</div>
    <div class="student">Nombre: <span class="student-name">${studentName}</span> &nbsp; Curso: ${studentGrade}</div>
  </div>
  ${sectionsHtml.join('')}
  <div class="print-footer">
    Daftar · Generado con Wingworking
  </div>
</body>
</html>`
}

function renderSection(section: Seccion, answers: unknown[], blank: boolean): string {
  const sid = section.id ?? ''
  const titleNum = sid ? `${sid.toUpperCase()}. ` : ''
  const title = esc(section.title ?? '')
  const instructions = section.instructions ?? ''
  const exercises = section.exercises ?? []
  const instrHtml = instructions ? `<div class="section-instructions">${esc(instructions)}</div>` : ''
  const exHtml = exercises.map((ex, i) => renderExercise(section, ex, i, i < answers.length ? answers[i] : null, blank))
  return `<div class="section">
  <div class="section-title">${titleNum}${title}</div>
  ${instrHtml}
  ${exHtml.join('')}
</div>`
}

function renderExercise(section: Seccion, ex: Ejercicio, index: number, sa: unknown, blank: boolean): string {
  const stype = section.type ?? ''
  const num = `<span class="ex-num">${index + 1}.</span>`
  if (stype === 'highlight') return renderHighlight(section, ex, num, sa)
  if (stype === 'classify') return renderClassify(ex, num, sa)
  if (stype === 'fill') return renderFill(ex, num, sa)
  if (stype === 'true_false') return renderTrueFalse(ex, num, sa)
  if (stype === 'compare') return renderCompare(ex, num, sa)
  if (stype === 'multiple_choice') return renderMultipleChoice(ex, num, sa)
  if (stype === 'free_text') return renderFreeText(ex, num, sa, blank)
  return `<div class="exercise">${num} ${esc(ex.text ?? '')}</div>`
}

/** `_answer_span`: vacío ⇔ `None` o string en blanco. Un 0 o un `false` SÍ se muestran (como Python). */
function answerSpan(value: unknown): string {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return '<span class="student-answer empty">___</span>'
  }
  return `<span class="student-answer">${esc(String(value))}</span>`
}

function renderHighlight(section: Seccion, ex: Ejercicio, num: string, sa: unknown): string {
  const text = ex.text ?? ''
  const categories = section.categories ?? []
  const tags = (sa && typeof sa === 'object' && !Array.isArray(sa) ? sa : {}) as Record<string, unknown>

  let legend = ''
  if (num.includes('1.')) {
    const swatches = categories.map((cat, ci) => {
      const bg = CATEGORY_COLORS[ci % CATEGORY_COLORS.length]![1]
      return `<span class="legend-swatch" style="background:${bg}"></span>${esc(cat)}`
    })
    legend = `<div class="legend">${swatches.join(' &nbsp; ')}</div>`
  }

  const parts: string[] = []
  for (const tok of tokenizar(text)) {
    const clean = tok.toLowerCase()
    const catIdx = tags[clean]
    if (catIdx !== undefined && catIdx !== null && Number.isInteger(catIdx) && (catIdx as number) >= 0 && (catIdx as number) < categories.length) {
      const i = catIdx as number
      const bg = CATEGORY_COLORS[i % CATEGORY_COLORS.length]![1]
      parts.push(`<span class="word-tag" style="background:${bg}" title="${esc(categories[i])}">${esc(tok)}</span>`)
    } else if (esPalabra(tok)) {
      parts.push(`<span class="word-plain">${esc(tok)}</span>`)
    } else {
      parts.push(esc(tok))
    }
  }
  return `${legend}<div class="exercise">${num} ${parts.join('')}</div>`
}

// `text` SIN escapar: el Python lo interpola crudo en estos cuatro (las guías traen `<b>`/`<i>` ahí).
function renderClassify(ex: Ejercicio, num: string, sa: unknown): string {
  return `<div class="exercise">${num} ${ex.text ?? ''} ${answerSpan(sa)}</div>`
}
function renderFill(ex: Ejercicio, num: string, sa: unknown): string {
  return `<div class="exercise">${num} ${ex.text ?? ''} ${answerSpan(sa)}</div>`
}
function renderTrueFalse(ex: Ejercicio, num: string, sa: unknown): string {
  return `<div class="exercise">${num} ${answerSpan(sa)} ${ex.text ?? ''}</div>`
}
function renderCompare(ex: Ejercicio, num: string, sa: unknown): string {
  return `<div class="exercise">${num} ${ex.left ?? ''} ${answerSpan(sa)} ${ex.right ?? ''}</div>`
}

function renderMultipleChoice(ex: Ejercicio, num: string, sa: unknown): string {
  const text = ex.text ?? ''
  const options = ex.options ?? []
  const letters = 'ABCDEFGH'
  const choice = choiceOf(sa)
  const selected = choice !== null && choice !== undefined && String(choice) !== '' ? Number(choice) : -1
  const conf = confOf(sa)
  const confHtml = conf
    ? ` <span class="conf-tag" title="${CONF_TITLES[conf] ?? conf}">Confianza: ${esc(String(conf))}</span>`
    : ''
  const optsHtml = options.map((opt, oi) => {
    const cls = oi === selected ? 'mc-option selected' : 'mc-option'
    const marker = oi === selected ? ' ←' : ''
    return `<div class="${cls}">${letters[oi]}. ${opt}${marker}</div>`
  })
  return `<div class="exercise">${num} ${text}${confHtml}\n${optsHtml.join('')}</div>`
}

function renderFreeText(ex: Ejercicio, num: string, sa: unknown, blank: boolean): string {
  const text = ex.text ?? ''
  const content = typeof sa === 'string' && sa.trim() ? esc(sa) : ''
  let answerHtml: string
  if (content) answerHtml = `<div class="free-text-answer">${content}</div>`
  else if (blank) answerHtml = '<div class="free-text-answer" style="height:8em">&nbsp;</div>'
  else answerHtml = '<div class="free-text-answer" style="color:#ccc">Sin respuesta</div>'
  return `<div class="exercise">${num} ${text}\n${answerHtml}</div>`
}
