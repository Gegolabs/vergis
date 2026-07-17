import { describe, it, expect } from 'vitest'
import { mdInline, renderChat, renderTraceDetail, renderIntentPanel, renderCanvas, renderMirCols, youInitialsOf } from '../server/miranda'
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

describe('renderChat · colapso de la traza de herramientas', () => {
  it('varias tools consecutivas → UNA sola señal con el conteo de pasos', () => {
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
    expect(count(html, 'exploró los datos')).toBe(1)
    expect(html).toContain('(3 pasos)')
    // no debe quedar rastro de las señales antiguas por-paso.
    expect(html).not.toContain('resultado de herramienta')
    expect(html).not.toContain('usó una herramienta')
    // el texto final SÍ se renderiza como burbuja.
    expect(html).toContain('Listo, exploré el dato.')
  })
  it('un solo paso de herramienta → "1 paso" (singular)', () => {
    const html = renderChat([toolUse('t1'), toolResult('t1')])
    expect(count(html, 'exploró los datos')).toBe(1)
    expect(html).toContain('(1 paso)')
  })
  it('dos rachas separadas por texto → dos señales distintas', () => {
    const rows = [
      toolUse('t1'),
      toolResult('t1'),
      assistantText('Voy a revisar otra tabla.'),
      toolUse('t2'),
      toolResult('t2'),
      assistantText('Confirmado.'),
    ]
    const html = renderChat(rows)
    expect(count(html, 'exploró los datos')).toBe(2)
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

describe('renderChat · disclosure de la traza (detalle por paso)', () => {
  // Fixtures con inputs/results reales (no vacíos como el helper de arriba).
  const probe = (id: string, sql: string) =>
    row('assistant', [{ type: 'tool_use', id, name: 'run_probe', input: { sql, why: 'validar el grano' } }])
  const describe_ = (id: string, name: string) =>
    row('assistant', [{ type: 'tool_use', id, name: 'describe_table', input: { name } }])
  const result = (id: string, content: string) => row('tool', [{ type: 'tool_result', tool_use_id: id, content }])

  it('la racha de tools va dentro de un <details class="trace-d"> (colapsable), no de un <div> plano', () => {
    const html = renderChat([probe('t1', 'SELECT 1'), result('t1', '{"rows":[]}')])
    expect(html).toContain('<details class="trace-d">')
    expect(html).toContain('<summary class="trace">')
    // el summary conserva la señal con el conteo (comportamiento de 090).
    expect(html).toContain('exploró los datos')
    expect(html).toContain('(1 paso)')
  })

  it('el detalle muestra los NOMBRES de tool de cada paso al expandir', () => {
    const html = renderChat([
      probe('t1', 'SELECT * FROM dbo.v_saldos'),
      result('t1', '{"rows":[{"empresa":"ACME"}]}'),
      describe_('t2', 'dbo.v_clientes'),
      result('t2', '{"columns":["id","nombre"]}'),
    ])
    expect(html).toContain('<code>run_probe</code>')
    expect(html).toContain('<code>describe_table</code>')
    // los argumentos clave visibles.
    expect(html).toContain('SELECT * FROM dbo.v_saldos')
    expect(html).toContain('dbo.v_clientes')
    // el resultado se muestra.
    expect(html).toContain('ACME')
  })

  it('un tool_result con markup queda ESCAPADO (un <script> nunca es etiqueta real)', () => {
    const html = renderChat([probe('t1', 'SELECT 1'), result('t1', '<script>alert(1)</script>')])
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })

  it('un resultado LARGO se trunca con marca explícita', () => {
    const big = 'x'.repeat(5000)
    const html = renderChat([probe('t1', 'SELECT 1'), result('t1', big)])
    expect(html).toContain('… (truncado)')
    // no se vuelca el resultado completo.
    expect(html).not.toContain('x'.repeat(5000))
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
