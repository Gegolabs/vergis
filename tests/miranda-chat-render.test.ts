import { describe, it, expect } from 'vitest'
import { mdInline, renderChat, renderTraceDetail, renderProceso, renderIntentPanel, renderCanvas, renderMirCols, youInitialsOf } from '../server/miranda'
import { PAGE_CSS } from '../server/ui'
import type { MirandaSession } from '@vergis/capabilities'

/** Cuenta ocurrencias no solapadas de `needle` en `hay`. */
function count(hay: string, needle: string): number {
  let n = 0
  let idx = hay.indexOf(needle)
  while (idx !== -1) {
    n += 1
    idx = hay.indexOf(needle, idx + needle.length)
  }
  return n
}

/** Fila de mensaje tal como la almacena el store: content = JSON del contenido Anthropic. */
const row = (role: string, content: unknown) => ({ role, content: JSON.stringify(content) })
const assistantText = (t: string) => row('assistant', [{ type: 'text', text: t }])
const toolUse = (id: string) => row('assistant', [{ type: 'tool_use', id, name: 'run_probe', input: {} }])
const toolResult = (id: string) => row('tool', [{ type: 'tool_result', tool_use_id: id, content: '{"rows":[]}' }])

describe('mdInline · formateo', () => {
  it('negrita **x** → <strong>, sin ** crudo', () => {
    const out = mdInline('hola **mundo**')
    expect(out).toContain('<strong>mundo</strong>')
    expect(out).not.toContain('**')
  })
  it('código `x` → <code>, sin backtick crudo', () => {
    const out = mdInline('usa `dbo.v_saldos` aquí')
    expect(out).toContain('<code>dbo.v_saldos</code>')
    expect(out).not.toContain('`')
  })
  it('doble salto → dos <p>', () => {
    const out = mdInline('primer párrafo\n\nsegundo párrafo')
    expect(count(out, '<p>')).toBe(2)
    expect(out).toContain('<p>primer párrafo</p>')
    expect(out).toContain('<p>segundo párrafo</p>')
  })
  it('salto simple → <br> dentro del mismo párrafo', () => {
    const out = mdInline('línea a\nlínea b')
    expect(count(out, '<p>')).toBe(1)
    expect(out).toContain('línea a<br>línea b')
  })
  it('lista con `- ` → <ul><li>', () => {
    const out = mdInline('- uno\n- dos')
    expect(out).toBe('<ul><li>uno</li><li>dos</li></ul>')
  })
  it('lista ordenada `N. ` → <ol><li>', () => {
    const out = mdInline('1. uno\n2. dos')
    expect(out).toBe('<ol><li>uno</li><li>dos</li></ol>')
  })
  it('dígitos del texto NO se comen por el centinela de código', () => {
    // regresión: un centinela naïf de solo-dígitos rompería aquí.
    const out = mdInline('tengo 5 empresas y 10 medidas')
    expect(out).toContain('5')
    expect(out).toContain('10')
    expect(out).not.toContain('<code>')
  })
})

describe('mdInline · seguridad (escapar-primero)', () => {
  it('<script> queda neutralizado (nunca etiqueta real)', () => {
    const out = mdInline('<script>alert(1)</script>')
    expect(out).not.toContain('<script')
    expect(out).toContain('&lt;script&gt;')
  })
  it('<img onerror> queda neutralizado', () => {
    const out = mdInline('<img src=x onerror=alert(1)>')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
  })
  it('HTML dentro de **negrita** se escapa; solo el ** produce <strong>', () => {
    const out = mdInline('**<b>malicioso</b>**')
    expect(out).toContain('<strong>')
    expect(out).toContain('&lt;b&gt;')
    expect(out).not.toContain('<b>malicioso')
  })
  it('HTML dentro de `código` se escapa y queda verbatim dentro de <code>', () => {
    const out = mdInline('`<img onerror=x>`')
    expect(out).toContain('<code>&lt;img onerror=x&gt;</code>')
    expect(out).not.toContain('<img')
  })
  it('comillas y ampersand se escapan', () => {
    const out = mdInline('a & "b" \'c\'')
    expect(out).toContain('&amp;')
    expect(out).toContain('&quot;')
    expect(out).toContain('&#39;')
  })
})

// Fix de la verificación de la Etapa B (plan 101): con entrega-primero Miranda escribe el link del
// reporte como markdown `[Ver reporte](/miranda/preview/…)`; sin soporte de links el usuario veía el
// markdown CRUDO. mdInline ahora los renderiza con un ALLOWLIST DE ESQUEMAS duro (default-deny).
describe('mdInline · links markdown con allowlist de esquemas', () => {
  it('link relativo mismo-origen → <a href="/ruta"> que navega en la misma pestaña (sin target)', () => {
    const out = mdInline('👉 [Ver reporte](/miranda/preview/s1)')
    expect(out).toContain('<a href="/miranda/preview/s1">Ver reporte</a>')
    expect(out).not.toContain('target=') // relativo: misma pestaña
    expect(out).not.toContain('[Ver reporte]') // el markdown crudo desapareció
  })

  it('link externo http(s) → target="_blank" + rel="noopener noreferrer"', () => {
    const out = mdInline('[docs](https://ejemplo.com/x)')
    expect(out).toContain('<a href="https://ejemplo.com/x"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('>docs</a>')
  })

  it('esquema peligroso (javascript:) → texto plano, SIN <a> y SIN exponer la url', () => {
    const out = mdInline('[click](javascript:alert(1))')
    expect(out).not.toContain('<a')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('click') // el label queda como texto plano
  })

  it('otros esquemas fuera del allowlist (data:, vbscript:, file:, //host) → texto plano sin <a>', () => {
    for (const url of ['data:text/html,x', 'vbscript:msgbox', 'file:///etc/passwd', '//evil.com/x']) {
      const out = mdInline(`[x](${url})`)
      expect(out).not.toContain('<a')
      expect(out).toContain('x')
    }
  })

  it('la url con comillas/&lt;/&gt; queda escapada en el href (escapar-primero intacto)', () => {
    const out = mdInline('[x](/r?a="1"&b=<2>)')
    expect(out).toContain('<a href="/r?a=&quot;1&quot;&amp;b=&lt;2&gt;">x</a>')
    expect(out).not.toContain('"1"') // sin comillas crudas que rompan el atributo
  })

  it('negrita + link combinados: **[x](/r)** → <strong> envolviendo el <a>', () => {
    const out = mdInline('**[x](/r)**')
    expect(out).toContain('<strong><a href="/r">x</a></strong>')
  })

  it('un link dentro de `código` NO se convierte — queda literal en <code>', () => {
    const out = mdInline('`[x](/r)`')
    expect(out).toContain('<code>[x](/r)</code>')
    expect(out).not.toContain('<a href')
  })
})

describe('renderChat · burbujas y Markdown', () => {
  it('mensaje del asistente renderiza negrita/código reales, no crudos', () => {
    const html = renderChat([assistantText('El PI usa `dbo.v_saldos` y es **clave**.')])
    expect(html).toContain('<strong>clave</strong>')
    expect(html).toContain('<code>dbo.v_saldos</code>')
    expect(html).not.toContain('**clave**')
    expect(html).toContain('>Miranda<') // el nombre va como caption, no como línea «Miranda:»
    expect(html).not.toContain('Miranda:')
  })
  it('inyección en el texto del mensaje queda neutralizada', () => {
    const html = renderChat([assistantText('<script>alert(1)</script>')])
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })
})

// Plan 102 · Etapa C: la conversación se lee LIMPIA — las cajas de traza de herramienta ya NO se pintan
// inline (se omiten en renderChat); su detalle vive consolidado en la sección «Proceso» de la ficha.
describe('renderChat · conversación limpia, sin traza inline (plan 102 etapa C)', () => {
  it('las rachas de tools se OMITEN; solo quedan los mensajes humanos + texto de Miranda', () => {
    const rows = [
      row('user', 'quiero saldos por empresa'),
      toolUse('t1'),
      toolResult('t1'),
      toolUse('t2'),
      toolResult('t2'),
      toolUse('t3'),
      toolResult('t3'),
      assistantText('Listo, exploré el dato.'),
    ]
    const html = renderChat(rows)
    // Cero rastro de la caja de traza inline.
    expect(html).not.toContain('exploró los datos')
    expect(html).not.toContain('trace-d')
    expect(html).not.toContain('<summary class="trace">')
    // Los mensajes humanos SÍ (chat normal): el del usuario y el texto de Miranda.
    expect(html).toContain('quiero saldos por empresa')
    expect(html).toContain('Listo, exploré el dato.')
    expect(count(html, 'turn--you')).toBe(1)
    expect(count(html, 'turn--miranda')).toBe(1)
  })
  it('una racha SIN texto alrededor no deja nada visible en el chat', () => {
    const html = renderChat([toolUse('t1'), toolResult('t1')])
    expect(html).not.toContain('trace-d')
    expect(html).not.toContain('exploró los datos')
  })
  it('dos rachas separadas por texto → los textos quedan, la traza no', () => {
    const rows = [
      toolUse('t1'),
      toolResult('t1'),
      assistantText('Voy a revisar otra tabla.'),
      toolUse('t2'),
      toolResult('t2'),
      assistantText('Confirmado.'),
    ]
    const html = renderChat(rows)
    expect(html).not.toContain('exploró los datos')
    expect(html).toContain('Voy a revisar otra tabla.')
    expect(html).toContain('Confirmado.')
    expect(count(html, 'turn--miranda')).toBe(2)
  })
})

describe('renderChat · lados de la burbuja (sensación de chat)', () => {
  it('la burbuja del asistente lleva la marca de lado izquierdo (Miranda)', () => {
    const html = renderChat([assistantText('Hola')])
    expect(html).toContain('turn--miranda')
    expect(html).not.toContain('turn--you')
    expect(html).toContain('class="bubble"')
  })
  it('la burbuja del usuario lleva la marca de lado derecho (Tú)', () => {
    const html = renderChat([row('user', 'quiero un PI de saldos')])
    expect(html).toContain('turn--you')
    expect(html).not.toContain('turn--miranda')
  })
  it('un intercambio user→assistant produce un lado de cada tipo, en orden', () => {
    const html = renderChat([row('user', 'hola'), assistantText('hola, ¿qué PI?')])
    expect(count(html, 'turn--you')).toBe(1)
    expect(count(html, 'turn--miranda')).toBe(1)
    expect(html.indexOf('turn--you')).toBeLessThan(html.indexOf('turn--miranda'))
  })
  it('las iniciales de «Tú» se inyectan en el avatar (ya escapadas)', () => {
    const html = renderChat([row('user', 'hola')], { youInitials: 'CO' })
    expect(html).toContain('>CO<')
  })
})

// Plan 102 · Etapa C: el detalle de pasos (antes inline en la conversación) vive ahora en la sección
// «Proceso» de la ficha técnica, consolidado por sesión y a demanda. Reusa renderTraceDetail → CERO
// pérdida de información: mismo detalle por paso, solo cambia DÓNDE se ve.
describe('renderProceso · el detalle de pasos vive en la ficha (plan 102 etapa C)', () => {
  const probe = (id: string, sql: string) =>
    row('assistant', [{ type: 'tool_use', id, name: 'run_probe', input: { sql, why: 'validar el grano' } }])
  const describe_ = (id: string, name: string) =>
    row('assistant', [{ type: 'tool_use', id, name: 'describe_table', input: { name } }])
  const result = (id: string, content: string) => row('tool', [{ type: 'tool_result', tool_use_id: id, content }])
  const asStr = (rows: { role: string; content: unknown }[]) => rows.map((r) => ({ role: r.role, content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content) }))

  it('la sección «Proceso» consolida los pasos de la sesión (rótulo con el conteo)', () => {
    const html = renderProceso(asStr([probe('t1', 'SELECT 1'), result('t1', '{"rows":[]}')]))
    expect(html).toContain('<h3>Proceso</h3>')
    expect(html).toContain('exploró los datos (1 paso)')
    expect(html).toContain('trace-body')
  })

  it('varias tools → el conteo total de la sesión (plural)', () => {
    const html = renderProceso(asStr([probe('t1', 'a'), result('t1', 'x'), describe_('t2', 'dbo.v'), result('t2', 'y'), probe('t3', 'b'), result('t3', 'z')]))
    expect(html).toContain('exploró los datos (3 pasos)')
  })

  it('sin pasos → sin sección (no se inventa)', () => {
    expect(renderProceso(asStr([row('user', 'hola'), assistantText('¿qué PI?')]))).toBe('')
  })

  it('muestra los NOMBRES de tool y los argumentos clave de cada paso', () => {
    const html = renderProceso(asStr([
      probe('t1', 'SELECT * FROM dbo.v_saldos'),
      result('t1', '{"rows":[{"empresa":"ACME"}]}'),
      describe_('t2', 'dbo.v_clientes'),
      result('t2', '{"columns":["id","nombre"]}'),
    ]))
    expect(html).toContain('<code>run_probe</code>')
    expect(html).toContain('<code>describe_table</code>')
    expect(html).toContain('SELECT * FROM dbo.v_saldos')
    expect(html).toContain('dbo.v_clientes')
    expect(html).toContain('ACME')
  })

  it('un tool_result con markup queda ESCAPADO (un <script> nunca es etiqueta real)', () => {
    const html = renderProceso(asStr([probe('t1', 'SELECT 1'), result('t1', '<script>alert(1)</script>')]))
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })

  it('un resultado LARGO se trunca con marca explícita', () => {
    const big = 'x'.repeat(5000)
    const html = renderProceso(asStr([probe('t1', 'SELECT 1'), result('t1', big)]))
    expect(html).toContain('… (truncado)')
    expect(html).not.toContain('x'.repeat(5000))
  })

  it('la ficha (renderIntentPanel) incluye la sección «Proceso» cuando la sesión tuvo pasos', () => {
    const msgs = asStr([row('user', 'hola'), probe('t1', 'SELECT 1'), result('t1', 'ok'), assistantText('listo')])
    const session = { id: 's1', title: 'PI', state: 'borrador' as MirandaSession['state'] }
    const html = renderIntentPanel(undefined, session, 'tok', 's1', undefined, undefined, undefined, undefined, msgs)
    expect(html).toContain('<h3>Proceso</h3>')
    // vive DENTRO de la ficha (disclosure cerrado por defecto → a demanda).
    expect(html.indexOf('<h3>Proceso</h3>')).toBeGreaterThan(html.indexOf('<details class="mir-ficha">'))
  })

  it('renderTraceDetail: input string arbitrario se escapa (no solo objetos)', () => {
    const html = renderTraceDetail([
      [{ type: 'tool_use', id: 't1', name: 'raw_tool', input: '<img onerror=alert(1)>' }],
      [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
    ] as never)
    expect(html).toContain('<code>raw_tool</code>')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
  })
})

describe('renderIntentPanel · ficha técnica cerrada por defecto (plan 101 etapa B)', () => {
  const session = (state: MirandaSession['state']): MirandaSession => ({ id: 's1', title: 'PI de saldos', state })
  const intent = JSON.stringify({
    titulo: 'Saldos por empresa',
    pregunta_de_negocio: '¿Cuánto debe cada empresa?',
    audiencia: 'Finanzas',
    grano: 'empresa',
    medidas: [{ nombre: 'saldo', definicion: 'suma de cuentas' }],
    pendientes_de_datos: [],
  })
  const qc = JSON.stringify({ veredicto: 'APROBADA', brechas: [] })
  const draft = 'mira_version: "1.0"\nidentity:\n  id: saldos'

  it('la ficha es un <details> CERRADO por defecto (sin atributo open) con el nombre canónico', () => {
    const html = renderIntentPanel(intent, session('borrador'), 'tok', 's1')
    expect(html).toContain('<details class="mir-ficha">') // cerrado: no lleva `open`
    expect(html).not.toContain('mir-ficha" open')
    expect(html).toContain('>Ficha técnica</summary>') // nombre canónico (constante FICHA_TECNICA)
    expect(html).not.toContain('<h2>Resumen de intención</h2>') // el viejo título plano desapareció
  })

  it('la ficha contiene las tres secciones: Intención + validar, Verificación (self-check), Definición técnica (DSL)', () => {
    const html = renderIntentPanel(intent, session('borrador'), 'tok', 's1', qc, draft)
    expect(html).toContain('<h3>Intención</h3>')
    expect(html).toContain('Saldos por empresa')
    expect(html).toContain('Esto es lo que quiero') // «validar intención» mudado ADENTRO
    expect(html).toContain('<h3>Verificación</h3>')
    expect(html).toContain('APROBADA')
    expect(html).toContain('<h3>Definición técnica</h3>')
    expect(html).toContain('mira_version') // el DSL vive en la ficha, a demanda
    // El «Esto es lo que quiero» está DENTRO del <details> de la ficha.
    const fichaStart = html.indexOf('<details class="mir-ficha">')
    expect(html.indexOf('Esto es lo que quiero')).toBeGreaterThan(fichaStart)
  })

  it('la ficha NO contiene acciones: ni «Publicar» ni el link al reporte (etapa C los mudó al lienzo)', () => {
    const html = renderIntentPanel(intent, session('autochequeado'), 'tok', 's1', qc, draft)
    expect(html).not.toContain('/publish')
    expect(html).not.toContain('/miranda/preview/s1')
    // la ficha guarda solo la justificación (sus tres secciones).
    expect(html.startsWith('<details class="mir-ficha">')).toBe(true)
  })

  it('sin resumen, la ficha muestra el texto de vacío en la sección Intención', () => {
    const html = renderIntentPanel(undefined, session('borrador'), 'tok', 's1')
    expect(html).toContain('<details class="mir-ficha">')
    expect(html).toContain('<h3>Intención</h3>')
    expect(html).toContain('Aún no hay un resumen de intención')
    // sin draft: no hay sección Definición técnica ni Verificación.
    expect(html).not.toContain('<h3>Definición técnica</h3>')
    expect(html).not.toContain('<h3>Verificación</h3>')
  })
})

// Plan 101 · Etapa C: la 2ª columna es el LIENZO — el reporte generado embebido por el MISMO riel RLS
// (`/miranda/preview/<sid>`, mismo-origen) + link «desprendido» standalone. Sin draft → placeholder,
// NO la ficha. «Publicar» se reubica junto al lienzo. Server-render, cero JS.
describe('renderCanvas · lienzo del reporte (plan 101 etapa C)', () => {
  const session = (state: MirandaSession['state']): MirandaSession => ({ id: 's1', title: 'PI', state })
  const draft = 'mira_version: "1.0"\nidentity:\n  id: saldos'

  it('con draft → embebe el preview por el riel RLS en un <iframe> mismo-origen', () => {
    const html = renderCanvas('s1', session('borrador'), 'tok', draft)
    expect(html).toContain('<iframe class="mir-canvas" src="/miranda/preview/s1"')
    // el src apunta al riel RLS (mismo que el standalone) — sin canal lateral.
    expect(html).toContain('src="/miranda/preview/s1"')
  })

  it('con draft → link «desprendido» standalone con target="_blank" + rel de seguridad', () => {
    const html = renderCanvas('s1', session('borrador'), 'tok', draft)
    expect(html).toContain('href="/miranda/preview/s1"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('Abrir desprendido')
  })

  it('sin draft → placeholder sobrio, NO la ficha ni el iframe', () => {
    const html = renderCanvas('s1', session('borrador'), 'tok', undefined)
    expect(html).toContain('El reporte aparecerá aquí cuando esté listo')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('mir-ficha')
  })

  it('«Publicar» se reubica en el lienzo cuando la sesión está autochequeada', () => {
    const html = renderCanvas('s1', session('autochequeado'), 'tok', draft)
    expect(html).toContain('/miranda/api/s/s1/publish')
    expect(html).toContain('>Publicar</button>')
  })

  it('publicar solo aparece en el estado autochequeado (no en borrador)', () => {
    expect(renderCanvas('s1', session('borrador'), 'tok', draft)).not.toContain('/publish')
  })

  it('sin JS: el lienzo no emite <script> ni handlers on*', () => {
    const html = renderCanvas('s1', session('autochequeado'), 'tok', draft)
    expect(html).not.toMatch(/<script|\son\w+=/i)
  })
})

// Plan 102 · Etapa B: panel del reporte desacoplado y expandible.
describe('canvas v2 · desacoplado + expandible (plan 102 etapa B)', () => {
  const session = (state: MirandaSession['state']): MirandaSession => ({ id: 's1', title: 'PI', state })
  const draft = 'mira_version: "1.0"\nidentity:\n  id: saldos'

  it('el iframe ya NO trae el cap de alto viejo (min(72vh,680px)); ancho completo', () => {
    expect(PAGE_CSS).not.toContain('min(72vh,680px)')
    expect(PAGE_CSS).toContain('.mir-canvas{width:100%')
  })

  it('control «Ampliar»: label + checkbox CSS-only, cero JS', () => {
    const canvas = renderCanvas('s1', session('borrador'), 'tok', draft)
    expect(canvas).toContain('class="mir-canvas-expand" for="mir-expand"') // el label
    expect(canvas).toContain('⤢ Ampliar')
    expect(canvas).not.toMatch(/<script|\son\w+=/i) // sin JS
    const cols = renderMirCols('<h2>Conv</h2>', 'aside', false)
    expect(cols).toContain('class="mir-expand-toggle" id="mir-expand"') // el checkbox hermano de .mir-cols
    expect(cols).not.toMatch(/<script|\son\w+=/i)
  })

  it('coexiste con el colapso de gaveta: dos checkboxes distintos, y ampliar gana en el CSS', () => {
    const cols = renderMirCols('c', 'a', false)
    expect(cols).toContain('id="mir-col-toggle"') // colapso de gaveta (derecha)
    expect(cols).toContain('id="mir-expand"') // ampliar (colapsa izquierda)
    // Las reglas de ampliar van DESPUÉS de las de colapso de gaveta (source order → ganan si ambas aplican).
    expect(PAGE_CSS.indexOf('.mir-expand-toggle:checked')).toBeGreaterThan(PAGE_CSS.indexOf('.col-toggle:checked'))
    // Ampliar re-muestra la gaveta (por si col-toggle la ocultó) y oculta la conversación.
    expect(PAGE_CSS).toContain('.mir-cols:has(> .mir-expand-toggle:checked) .mir-conv{display:none}')
    expect(PAGE_CSS).toContain('.mir-cols:has(> .mir-expand-toggle:checked) .mir-intent{display:flex}')
  })

  it('el uso de sesión vive DENTRO de la ficha (maquinaria), no suelto', () => {
    const html = renderIntentPanel(undefined, session('borrador'), 'tok', 's1', undefined, undefined, 850, 1000)
    expect(html).toContain('<details class="mir-ficha">')
    expect(html).toContain('Uso de la sesión')
    // «Uso de la sesión» aparece DESPUÉS del <details> de la ficha (está adentro).
    expect(html.indexOf('Uso de la sesión')).toBeGreaterThan(html.indexOf('<details class="mir-ficha">'))
    expect(html).toContain('mir-budget')
  })

  it('sin presupuesto → no hay sección de uso (no se inventa)', () => {
    const html = renderIntentPanel(undefined, session('borrador'), 'tok', 's1')
    expect(html).not.toContain('Uso de la sesión')
  })
})

describe('renderMirCols · gaveta con divisor punteado + tirador (CSS-only, work/093)', () => {
  it('trae el checkbox oculto, el divisor punteado y el tirador SOBRE el divisor (no dentro de la tarjeta)', () => {
    const html = renderMirCols('<h2>Conversación</h2>', '<h2>Resumen de intención</h2>', false)
    // checkbox oculto que dirige el grid vía :has().
    expect(html).toContain('<input type="checkbox" class="col-toggle" id="mir-col-toggle"')
    // divisor punteado dedicado = borde de la gaveta.
    expect(html).toContain('class="mir-divider"')
    // tirador de gaveta (reubicado al divisor) y afordancia de reapertura (gaveta cerrada).
    expect(html).toContain('class="mir-drawer-pull"')
    expect(html).toContain('class="mir-reopen"')
    // ambos controles apuntan al mismo checkbox.
    expect(count(html, 'for="mir-col-toggle"')).toBe(2)
    // el sidebar y la conversación siguen presentes.
    expect(html).toContain('class="mir-conv"')
    expect(html).toContain('class="mir-intent')
    // el control de plegado ya NO vive dentro de la tarjeta: desapareció el viejo botón in-card…
    expect(html).not.toContain('mir-collapse-btn')
    // …y el tirador aparece ANTES del <aside> de la tarjeta (vive en el divisor, no en la tarjeta).
    const pullIdx = html.indexOf('mir-drawer-pull')
    const asideIdx = html.indexOf('<aside class="mir-intent')
    expect(pullIdx).toBeGreaterThan(-1)
    expect(pullIdx).toBeLessThan(asideIdx)
  })

  it('marca el sidebar como vacío cuando corresponde', () => {
    expect(renderMirCols('c', 'a', true)).toContain('mir-intent mir-intent--empty')
    expect(renderMirCols('c', 'a', false)).not.toContain('mir-intent--empty')
  })

  it('PAGE_CSS: divisor punteado presente; colapsado ⇒ grid 1 col, gaveta+divisor ocultos, reapertura visible', () => {
    // divisor vertical punteado.
    expect(PAGE_CSS).toContain('.mir-divider{')
    expect(PAGE_CSS).toContain('border-left:2px dashed var(--border)')
    // el borde de reapertura también es punteado (gaveta cerrada en el borde derecho).
    expect(PAGE_CSS).toContain('.mir-reopen{display:none')
    // colapso: una columna, gaveta y divisor ocultos, reapertura visible.
    expect(PAGE_CSS).toContain('.mir-cols:has(> .col-toggle:checked){grid-template-columns:1fr}')
    expect(PAGE_CSS).toContain('.mir-cols:has(> .col-toggle:checked) .mir-intent{display:none}')
    expect(PAGE_CSS).toContain('.mir-cols:has(> .col-toggle:checked) .mir-divider{display:none}')
    expect(PAGE_CSS).toContain('.mir-cols:has(> .col-toggle:checked) .mir-reopen{display:block}')
  })
})

describe('youInitialsOf', () => {
  it('deriva iniciales del email (local separado por . _ -)', () => {
    expect(youInitialsOf('carlos.ortiz@consultora.test')).toBe('CO')
    expect(youInitialsOf('especificador@consultora.test')).toBe('C')
  })
  it('sin email → «Tú»', () => {
    expect(youInitialsOf(undefined)).toBe('Tú')
    expect(youInitialsOf('')).toBe('Tú')
  })
})
