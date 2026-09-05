/**
 * Port FIEL de `render_report` y sus ayudantes (`server.py` de Daftar, ~l. 586-1226): el instrumento
 * corregido — preguntas, respuestas del estudiante, corrección automática y revisión del corrector.
 *
 * La vara de «fiel» es medida, no declarada: `tests/daftar-report.test.ts` compara contra el HTML que
 * el Python produce sobre las MISMAS fixtures sintéticas, un test por tipo de ejercicio. Por eso se
 * conservan sus decisiones —el redondeo bancario de `round()`, la nota `pct*7/100`, el `letters` de
 * cinco caracteres, el resumen de confianza solo en `multiple_choice`— en vez de reinterpretarlas.
 */
import { esc, pyRound, pyFloat, pad2 } from './html'
import type { Guia, Progreso, Seccion, Ejercicio, ProgresoSeccion, RevisionSeccion, EstudianteInfo } from './tipos'
import { choiceOf, confOf, CONF_TITLES, tokenizar, esPalabra } from './tipos'
import { CATEGORY_COLORS } from './print'

const REPORT_CSS = `
  @page { margin: 1.5cm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 11pt; line-height: 1.6; color: #2d3436;
    background: #f8f9fa;
  }
  .rpt-wrap { max-width: 800px; margin: 0 auto; padding: 1.5rem 1rem 3rem; }

  /* Header card */
  .rpt-header {
    background: #fff; border-radius: 10px; padding: 1.5rem;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 1.25rem; text-align: center;
  }
  .rpt-header h1 { font-size: 1.3rem; color: #2c6fbb; }
  .rpt-header h2 { font-size: 1rem; font-weight: 400; color: #636e72; margin-top: 0.1rem; }
  .rpt-student { font-size: 0.85rem; color: #636e72; margin-top: 0.4rem; }
  .rpt-score-row {
    display: flex; justify-content: center; align-items: center;
    gap: 1rem; margin-top: 1rem; flex-wrap: wrap;
  }
  .rpt-score-card {
    padding: 0.6rem 1.2rem; border-radius: 8px; text-align: center;
  }
  .rpt-score-card.main { font-size: 1.8rem; font-weight: 800; }
  .rpt-score-card.great { background: #d4edda; color: #1e7e34; }
  .rpt-score-card.ok { background: #fff3cd; color: #856404; }
  .rpt-score-card.bad { background: #fadbd8; color: #c0392b; }
  .rpt-score-card .label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; }
  .rpt-score-card .value { font-size: 1.1rem; font-weight: 700; }
  .rpt-score-card.sub { background: #f0f0f0; color: #555; }
  .rpt-time { font-size: 0.8rem; color: #636e72; margin-top: 0.5rem; }
  .rpt-actions {
    display: flex; justify-content: center; gap: 0.75rem;
    margin-top: 1rem; flex-wrap: wrap;
  }
  .rpt-btn {
    border: none; border-radius: 6px; padding: 0.5rem 1.25rem;
    font-size: 0.85rem; font-weight: 600; cursor: pointer;
    text-decoration: none; display: inline-block;
  }
  .rpt-btn.primary { background: #2c6fbb; color: #fff; }
  .rpt-btn.primary:hover { background: #245a9e; }
  .rpt-btn.secondary { background: #fff; color: #2c6fbb; border: 1px solid #dee2e6; }
  .rpt-btn.secondary:hover { background: #dfe9f5; }
  @media print {
    .rpt-actions { display: none !important; }
    body { background: #fff !important; font-size: 9pt; line-height: 1.3; }
    .rpt-wrap { padding: 0; max-width: 100%; }
    .rpt-header {
      box-shadow: none; border-radius: 0; padding: 0.75rem 0;
      margin-bottom: 0.5rem; border-bottom: 2px solid #000;
    }
    .rpt-header h1 { color: #000; font-size: 12pt; }
    .rpt-header h2 { color: #444; font-size: 10pt; }
    .rpt-score-card {
      background: #fff !important; color: #000 !important;
      border: 1.5px solid #000;
    }
    .rpt-score-card.main { font-size: 1.3rem; }
    .rpt-score-card .label, .rpt-score-card .value { color: #000 !important; }
    .rpt-section {
      box-shadow: none; border-radius: 0; padding: 0.4rem 0;
      margin-bottom: 0.4rem; border-bottom: 1px solid #bbb;
    }
    .rpt-section-title { color: #000; font-size: 9.5pt; }
    .rpt-section-badge {
      background: #fff !important; color: #000 !important;
      border: 1px solid #000;
    }
    .rpt-instructions { font-size: 7.5pt; }
    .rpt-ex {
      font-size: 8.5pt; padding: 0.2rem 0.4rem; margin-bottom: 0.2rem;
      background: #fff !important; border-radius: 0;
      border-left: 3px solid #bbb;
    }
    .rpt-ex.correct { border-left-color: #aaa; }
    .rpt-ex.incorrect { border-left-color: #aaa; border-left-style: dashed; }
    .rpt-ex.neutral { border-left-color: #ccc; }
    .rpt-answer { color: #000 !important; font-weight: 600; }
    .rpt-answer.wrong { text-decoration: line-through; }
    .rpt-answer.right::after { content: " ✓"; color: green; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .rpt-answer.wrong::after { content: " ✗"; color: red; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .rpt-expected { font-size: 7.5pt; color: #555; }
    .rpt-review {
      background: #fff !important; border-left: 2px solid #000;
      border-radius: 0; font-size: 7.5pt; color: #333;
      padding: 0.15rem 0.4rem; margin-top: 0.15rem;
    }
    .rpt-mc-opt { color: #000 !important; font-weight: normal !important; }
    .rpt-mc-right { font-weight: 700 !important; color: #000 !important; }
    .rpt-mc-wrong { font-weight: 700 !important; color: #000 !important; text-decoration: line-through; }
    .rpt-mc-expected { color: #555 !important; }
    .rpt-student-text {
      background: #fff !important; border: 1px solid #bbb;
      border-radius: 0; font-size: 8pt; padding: 0.15rem 0.4rem;
    }
    .rpt-footer { font-size: 7pt; }
  }

  /* Section card */
  .rpt-section {
    background: #fff; border-radius: 10px; padding: 1.25rem;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 1rem;
  }
  .rpt-section-head {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid #eee;
  }
  .rpt-section-title { font-size: 1rem; font-weight: 700; color: #2c6fbb; }
  .rpt-section-badge {
    font-size: 0.75rem; font-weight: 700; padding: 0.2rem 0.6rem;
    border-radius: 12px;
  }
  .rpt-section-badge.perfect { background: #d4edda; color: #1e7e34; }
  .rpt-section-badge.good { background: #fff3cd; color: #856404; }
  .rpt-section-badge.low { background: #fadbd8; color: #c0392b; }
  .rpt-section-badge.reviewed { background: #e8d5f5; color: #6c3483; }
  .rpt-section-badge.pending { background: #f0f0f0; color: #888; }
  .rpt-instructions { font-size: 0.8rem; color: #888; font-style: italic; margin-bottom: 0.5rem; }

  /* Exercise items */
  .rpt-ex {
    margin-bottom: 0.5rem; padding: 0.6rem 0.75rem; border-radius: 6px;
    border-left: 4px solid #dee2e6; font-size: 0.9rem;
  }
  .rpt-ex.correct { border-left-color: #27ae60; background: #f0faf4; }
  .rpt-ex.incorrect { border-left-color: #e74c3c; background: #fdf2f1; }
  .rpt-ex.neutral { border-left-color: #3498db; background: #f0f6fc; }
  .rpt-ex-num { font-weight: 700; color: #aaa; margin-right: 0.3rem; }
  .rpt-question { color: #555; }
  .rpt-answer { font-weight: 600; }
  .rpt-answer.right { color: #27ae60; }
  .rpt-answer.wrong { color: #e74c3c; }
  .rpt-expected { font-size: 0.8rem; color: #999; margin-top: 0.15rem; }
  .rpt-review {
    margin-top: 0.4rem; padding: 0.5rem 0.7rem;
    background: #f3e8fc; border-radius: 6px; border-left: 3px solid #8e44ad;
    font-size: 0.8rem; color: #6c3483;
  }
  .rpt-mc-opt { margin-left: 1.5em; }
  .rpt-conf {
    display: inline-block; font-size: 0.72rem; font-weight: 700;
    background: #eef1f4; color: #555; border-radius: 4px;
    padding: 0.05rem 0.4rem; margin-left: 0.4rem;
  }
  .rpt-conf.danger { background: #fadbd8; color: #c0392b; }
  .rpt-conf-summary {
    margin-top: 0.6rem; padding: 0.4rem 0.6rem; border-radius: 6px;
    background: #eef1f4; color: #555; font-size: 0.8rem;
  }
  .rpt-conf-summary.danger { background: #fadbd8; color: #c0392b; font-weight: 600; }
  .rpt-mc-right { font-weight: 700; color: #27ae60; }
  .rpt-mc-wrong { font-weight: 700; color: #e74c3c; }
  .rpt-mc-expected { color: #27ae60; }
  .rpt-student-text {
    font-style: italic; color: #444; margin: 0.3rem 0;
    padding: 0.5rem 0.7rem; background: #f8f9fa; border-radius: 6px;
    font-size: 0.85rem; white-space: pre-wrap; border: 1px solid #eee;
  }

  /* Footer */
  .rpt-footer {
    text-align: center; padding: 1.5rem; font-size: 0.75rem; color: #aaa;
  }

  @media (max-width: 480px) {
    .rpt-wrap { padding: 1rem 0.5rem; }
    .rpt-section { padding: 1rem; }
    .rpt-score-row { flex-direction: column; }
  }
`

export interface ReportOpts {
  /** Estudiantes de la spec (reemplaza el `STUDENT_INFO` de `server.py`). */
  estudiantes: Record<string, EstudianteInfo>
  /** Prefijo del Let (`/estudios`) para el enlace «Volver». En Python era `/` a secas. */
  base: string
}

export function renderReport(guide: Guia, prog: Progreso, opts: ReportOpts): string {
  const title = esc(guide.title ?? '')
  const subtitle = esc(guide.subtitle ?? '')
  const institution = esc(guide.institution ?? '')
  const sections = guide.sections ?? []
  const studentKey = guide.student ?? 'sebas'
  const info = opts.estudiantes[studentKey] ?? { name: studentKey, grade: '' }
  const studentName = esc(info.name)
  const studentGrade = esc(info.grade)
  const progSections = prog.sections ?? {}

  // Totales
  let autoC = 0
  let autoT = 0
  let revC = 0
  let revT = 0
  const formGrades: string[] = []
  sections.forEach((_section, si) => {
    const sp = progSections[String(si)] ?? {}
    const score = sp.score ?? {}
    if ((score.total ?? 0) > 0) {
      autoC += score.correct ?? 0
      autoT += score.total ?? 0
    }
    const review = sp.review
    if (review && review.score) {
      const m = /^(\d+)\s*\/\s*(\d+)/.exec(review.score)
      if (m) {
        revC += Number(m[1])
        revT += Number(m[2])
      }
    }
    if (review && review.form) formGrades.push(review.form)
  })

  const totalC = autoC + revC
  const totalT = autoT + revT
  const totalPct = totalT > 0 ? pyRound((totalC / totalT) * 100) : 0
  const nota = pyRound((totalPct * 7) / 100, 1)

  // Peor nota de forma (F es la peor, A la mejor). `max` de Python conserva el PRIMERO ante empate.
  const formOrder = ['A', 'B', 'C', 'D', 'F']
  let worstForm = ''
  if (formGrades.length) {
    let mejor = formGrades[0]!
    let mejorK = formOrder.indexOf(mejor) === -1 ? 99 : formOrder.indexOf(mejor)
    for (const g of formGrades.slice(1)) {
      const k = formOrder.indexOf(g) === -1 ? 99 : formOrder.indexOf(g)
      if (k > mejorK) {
        mejor = g
        mejorK = k
      }
    }
    worstForm = mejor
  }

  // Tiempo
  let timeHtml = ''
  if (prog._startedAt && prog._finishedAt) {
    const started = Date.parse(prog._startedAt)
    const finished = Date.parse(prog._finishedAt)
    if (Number.isFinite(started) && Number.isFinite(finished)) {
      const elapsed = Math.trunc((finished - started) / 1000)
      const m = Math.floor(elapsed / 60)
      const s = elapsed - m * 60
      timeHtml = `<div class="rpt-time">Tiempo: ${pad2(m)}:${pad2(s)}</div>`
    }
  }

  const sectionsHtml = sections.map((section, si) => reportSection(section, progSections[String(si)] ?? {}))

  const scoreCls = totalPct >= 80 ? 'great' : totalPct >= 50 ? 'ok' : 'bad'
  const autoPct = autoT > 0 ? pyRound((autoC / autoT) * 100) : 0
  const revPctHtml = revT > 0 ? `${revC}/${revT}` : 'pendiente'
  const formDisplay = worstForm ? ` | ${worstForm}` : ''

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Reporte</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="rpt-wrap">
  <div class="rpt-header">
    <h1>${title}</h1>
    <h2>${subtitle}</h2>
    <div class="rpt-student">${institution} — ${studentName} — ${studentGrade}</div>
    <div class="rpt-score-row">
      <div class="rpt-score-card main ${scoreCls}">${totalPct}%${formDisplay}<br><span style="font-size:0.6em;opacity:0.7">nota ${pyFloat(nota)}${formDisplay}</span></div>
      <div>
        <div class="rpt-score-card sub"><div class="label">Automática</div><div class="value">${autoC}/${autoT} (${autoPct}%)</div></div>
        <div class="rpt-score-card sub" style="margin-top:0.4rem"><div class="label">Redacción</div><div class="value">${revPctHtml}</div></div>
      </div>
    </div>
    ${timeHtml}
    <div class="rpt-actions">
      <button class="rpt-btn primary" onclick="setTimeout(function(){window.print()},100)">Imprimir reporte</button>
      <a class="rpt-btn secondary" href="${opts.base}/">← Volver a Daftar</a>
    </div>
  </div>

  ${sectionsHtml.join('')}

  <div class="rpt-footer">Daftar · Generado con Wingworking</div>
</div>
</body>
</html>`
}

function reportSection(section: Seccion, sp: ProgresoSeccion): string {
  const sid = section.id ?? ''
  const titleNum = sid ? `${sid.toUpperCase()}. ` : ''
  const title = esc(section.title ?? '')
  const stype = section.type ?? ''
  const instructions = section.instructions ?? ''
  const exercises = section.exercises ?? []
  const answers = (sp.answers ?? []) as unknown[]
  const score = sp.score ?? {}
  const review = sp.review ?? null

  let badge = ''
  if (stype === 'free_text' && review) {
    badge = `<span class="rpt-section-badge reviewed">${esc(review.score ?? '')}</span>`
  } else if ((score.total ?? 0) > 0) {
    const pct = pyRound(((score.correct ?? 0) / (score.total ?? 1)) * 100)
    const cls = pct === 100 ? 'perfect' : pct >= 60 ? 'good' : 'low'
    badge = `<span class="rpt-section-badge ${cls}">${score.correct}/${score.total}</span>`
  } else if (stype === 'free_text') {
    badge = '<span class="rpt-section-badge pending">Pendiente</span>'
  }

  const instrHtml = instructions ? `<div class="rpt-instructions">${esc(instructions)}</div>` : ''

  const exHtml = exercises.map((ex, ei) => {
    const sa = ei < answers.length ? answers[ei] : null
    let reviewComment: unknown = null
    if (review && review.comments && ei < review.comments.length) reviewComment = review.comments[ei]
    return reportExercise(section, ex, ei, sa, reviewComment)
  })

  const confHtml = reportConfSummary(section, answers)

  return `<div class="rpt-section">
  <div class="rpt-section-head">
    <span class="rpt-section-title">${titleNum}${title}</span>
    ${badge}
  </div>
  ${instrHtml}
  ${exHtml.join('')}
  ${confHtml}
</div>`
}

/** Conteo de confianza de la sección. Vacío si la guía no la pide o es de otro tipo. */
function reportConfSummary(section: Seccion, answers: unknown[]): string {
  if (section.type !== 'multiple_choice') return ''
  const tally: Record<string, [number, number]> = { S: [0, 0], C: [0, 0], A: [0, 0] }
  let seen = false
  const exercises = section.exercises ?? []
  exercises.forEach((ex, ei) => {
    const sa = ei < answers.length ? answers[ei] : null
    const conf = confOf(sa)
    if (!conf || !(conf in tally)) return
    const choice = choiceOf(sa)
    if (choice === null || choice === undefined || String(choice) === '') return
    seen = true
    tally[conf]![Number(choice) === (ex.answer ?? 0) ? 0 : 1] += 1
  })
  if (!seen) return ''
  const items = (['S', 'C', 'A'] as const).map((k) => `<b>${k}</b> ${tally[k]![0]} correctas`).join(' · ')
  const danger = tally['S']![1]
  const cls = danger ? 'rpt-conf-summary danger' : 'rpt-conf-summary'
  return `<div class="${cls}">Confianza declarada: ${items} — errores con S (los peligrosos): ${danger}</div>`
}

function reportExercise(section: Seccion, ex: Ejercicio, index: number, sa: unknown, reviewComment: unknown): string {
  const stype = section.type ?? ''
  const num = `<span class="rpt-ex-num">${index + 1}.</span>`
  if (stype === 'free_text') return reportFreeText(ex, num, sa, reviewComment)
  if (stype === 'highlight') return reportHighlight(section, ex, num, sa)
  if (stype === 'classify') return reportClassify(ex, num, sa)
  if (stype === 'fill') return reportFill(ex, num, sa)
  if (stype === 'true_false') return reportTrueFalse(ex, num, sa)
  if (stype === 'compare') return reportCompare(ex, num, sa)
  if (stype === 'multiple_choice') return reportMc(ex, num, sa)
  return ''
}

/** `_normaliza` del `_is_correct_fill`: minúscula, sin `.`/`,`/`$`, guiones unificados. */
function normFill(s: string, conEmDash: boolean): string {
  let v = s.trim().toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/\$/g, '')
  // El lado del ESTUDIANTE usa `re.sub(r"[−–—]", "-")` (los tres guiones); el lado ESPERADO solo
  // reemplaza `−` y `–`, no `—`. La asimetría es del Python y se conserva.
  v = conEmDash ? v.replace(/[−–—]/g, '-') : v.replace(/−/g, '-').replace(/–/g, '-')
  return v
}

function esCorrectoFill(ex: Ejercicio, sa: unknown): boolean {
  if (sa === null || sa === undefined) return false
  const v = normFill(String(sa), true)
  const raw = ex.answer ?? []
  const expected = Array.isArray(raw) ? raw : [String(raw)]
  return expected.some((e) => v === normFill(String(e), false))
}

function reportFill(ex: Ejercicio, num: string, sa: unknown): string {
  const text = esc(ex.text ?? '')
  const correct = esCorrectoFill(ex, sa)
  const cls = correct ? 'correct' : sa ? 'incorrect' : 'neutral'
  const saTxt = sa ? esc(String(sa)) : '—'
  const ansCls = correct ? 'right' : 'wrong'
  let expected = ''
  if (!correct && sa) {
    const exp = ex.answer ?? []
    expected = `<div class="rpt-expected">Respuesta correcta: ${esc(String(Array.isArray(exp) ? exp[0] : exp))}</div>`
  }
  return `<div class="rpt-ex ${cls}">${num} ${text} <span class="rpt-answer ${ansCls}">${saTxt}</span>${expected}</div>`
}

function reportClassify(ex: Ejercicio, num: string, sa: unknown): string {
  const text = esc(ex.text ?? '')
  const correctAns = (ex.answer ?? '') as string
  const isCorrect = sa === correctAns
  const cls = isCorrect ? 'correct' : sa ? 'incorrect' : 'neutral'
  const saTxt = sa ? esc(String(sa)) : '—'
  const ansCls = isCorrect ? 'right' : 'wrong'
  const expected = !isCorrect && sa ? `<div class="rpt-expected">Respuesta correcta: ${esc(correctAns)}</div>` : ''
  return `<div class="rpt-ex ${cls}">${num} ${text} → <span class="rpt-answer ${ansCls}">${saTxt}</span>${expected}</div>`
}

function reportTrueFalse(ex: Ejercicio, num: string, sa: unknown): string {
  const text = esc(ex.text ?? '')
  const correctAns = ex.answer ? 'V' : 'F'
  const isCorrect = sa === correctAns
  const cls = isCorrect ? 'correct' : sa ? 'incorrect' : 'neutral'
  const saTxt = sa ? esc(String(sa)) : '—'
  const ansCls = isCorrect ? 'right' : 'wrong'
  const expected = !isCorrect && sa ? `<div class="rpt-expected">Respuesta correcta: ${correctAns}</div>` : ''
  return `<div class="rpt-ex ${cls}">${num} <span class="rpt-answer ${ansCls}">[${saTxt}]</span> ${text}${expected}</div>`
}

function reportCompare(ex: Ejercicio, num: string, sa: unknown): string {
  const left = esc(ex.left ?? '')
  const right = esc(ex.right ?? '')
  const correctAns = (ex.answer ?? '') as string
  const isCorrect = sa === correctAns
  const cls = isCorrect ? 'correct' : sa ? 'incorrect' : 'neutral'
  const saTxt = sa ? esc(String(sa)) : '—'
  const ansCls = isCorrect ? 'right' : 'wrong'
  const expected = !isCorrect && sa ? `<div class="rpt-expected">Respuesta correcta: ${esc(correctAns)}</div>` : ''
  return `<div class="rpt-ex ${cls}">${num} ${left} <span class="rpt-answer ${ansCls}">${saTxt}</span> ${right}${expected}</div>`
}

function reportMc(ex: Ejercicio, num: string, sa: unknown): string {
  const text = esc(ex.text ?? '')
  const options = ex.options ?? []
  const correctIdx = (ex.answer ?? 0) as number
  const letters = 'ABCDE'
  const choice = choiceOf(sa)
  const selected = choice !== null && choice !== undefined && String(choice) !== '' ? Number(choice) : -1
  const isCorrect = selected === correctIdx
  const cls = isCorrect ? 'correct' : selected >= 0 ? 'incorrect' : 'neutral'
  const conf = confOf(sa)
  let confHtml = ''
  if (conf) {
    const verdict = isCorrect ? 'correcta' : selected >= 0 ? 'errada' : 'sin responder'
    const confCls = conf === 'S' && selected >= 0 && !isCorrect ? 'rpt-conf danger' : 'rpt-conf'
    confHtml = `<span class="${confCls}" title="${CONF_TITLES[conf] ?? conf}">${esc(String(conf))} · ${verdict}</span>`
  }
  let optsHtml = ''
  options.forEach((opt, oi) => {
    let marker = ''
    let clsOpt = 'rpt-mc-opt'
    if (oi === selected && isCorrect) {
      marker = ' ✓'
      clsOpt = 'rpt-mc-opt rpt-mc-right'
    } else if (oi === selected && !isCorrect) {
      marker = ' ✗'
      clsOpt = 'rpt-mc-opt rpt-mc-wrong'
    } else if (oi === correctIdx && !isCorrect && selected >= 0) {
      marker = ' ←'
      clsOpt = 'rpt-mc-opt rpt-mc-expected'
    }
    optsHtml += `<div class="${clsOpt}">${letters[oi]}. ${esc(opt)}${marker}</div>`
  })
  return `<div class="rpt-ex ${cls}">${num} ${text}${confHtml}${optsHtml}</div>`
}

function reportHighlight(section: Seccion, ex: Ejercicio, num: string, sa: unknown): string {
  const text = ex.text ?? ''
  const categories = section.categories ?? []
  const correctAnswers = (ex.answers ?? {}) as Record<string, string>
  const tags = (sa && typeof sa === 'object' && !Array.isArray(sa) ? sa : {}) as Record<string, unknown>

  const parts: string[] = []
  let allCorrect = true
  for (const tok of tokenizar(text)) {
    const clean = tok.toLowerCase()
    const expectedCat = Object.prototype.hasOwnProperty.call(correctAnswers, clean) ? correctAnswers[clean] : undefined
    const studentCatIdx = Object.prototype.hasOwnProperty.call(tags, clean) ? tags[clean] : undefined

    if (expectedCat !== undefined && expectedCat !== null) {
      const expIdx = categories.indexOf(expectedCat)
      if (studentCatIdx !== undefined && studentCatIdx !== null && Number(studentCatIdx) === expIdx) {
        const bg = CATEGORY_COLORS[((expIdx % CATEGORY_COLORS.length) + CATEGORY_COLORS.length) % CATEGORY_COLORS.length]![1]
        parts.push(`<span style="background:${bg};padding:0 3px;border-radius:3px;font-weight:600" title="${esc(expectedCat)}">${esc(tok)}</span>`)
      } else {
        allCorrect = false
        parts.push(`<span style="background:#fadbd8;padding:0 3px;border-radius:3px;text-decoration:underline" title="Correcto: ${esc(expectedCat)}">${esc(tok)}</span>`)
      }
    } else if (esPalabra(tok)) {
      if (studentCatIdx !== undefined && studentCatIdx !== null && Number(studentCatIdx) >= 0) {
        allCorrect = false
        parts.push(`<span style="background:#fadbd8;padding:0 3px;border-radius:3px" title="No debía etiquetarse">${esc(tok)}</span>`)
      } else {
        parts.push(esc(tok))
      }
    } else {
      parts.push(esc(tok))
    }
  }
  const cls = allCorrect ? 'correct' : 'incorrect'
  return `<div class="rpt-ex ${cls}">${num} ${parts.join('')}</div>`
}

function reportFreeText(ex: Ejercicio, num: string, sa: unknown, reviewComment: unknown): string {
  const text = esc(ex.text ?? '')
  const hasAnswer = typeof sa === 'string' && sa.trim() !== ''
  const cls = 'neutral'

  const answerHtml = hasAnswer
    ? `<div class="rpt-student-text">${esc(sa)}</div>`
    : '<div style="color:#ccc;font-style:italic;font-size:9pt">Sin respuesta</div>'

  let reviewHtml = ''
  if (reviewComment) {
    if (typeof reviewComment === 'object' && !Array.isArray(reviewComment)) {
      const rc = reviewComment as Record<string, unknown>
      const fondo = esc(String(rc['fondo'] ?? ''))
      const forma = esc(String(rc['forma'] ?? ''))
      const comment = esc(String(rc['comment'] ?? ''))
      reviewHtml = `<div class="rpt-review"><strong>Fondo: ${fondo} | Forma: ${forma}</strong><br>${comment}</div>`
    } else {
      reviewHtml = `<div class="rpt-review">${esc(String(reviewComment))}</div>`
    }
  }
  return `<div class="rpt-ex ${cls}">${num} <span class="rpt-question">${text}</span>${answerHtml}${reviewHtml}</div>`
}
