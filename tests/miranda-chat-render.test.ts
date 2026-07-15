import { describe, it, expect } from 'vitest'
import { mdInline, renderChat, renderTraceDetail, renderIntentPanel, youInitialsOf } from '../server/miranda'
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

describe('renderIntentPanel · panel colapsable', () => {
  const session = (state: MirandaSession['state']): MirandaSession => ({ id: 's1', title: 'PI de saldos', state })
  const intent = JSON.stringify({
    titulo: 'Saldos por empresa',
    pregunta_de_negocio: '¿Cuánto debe cada empresa?',
    audiencia: 'Finanzas',
    grano: 'empresa',
    medidas: [{ nombre: 'saldo', definicion: 'suma de cuentas' }],
    pendientes_de_datos: [],
  })

  it('el resumen de intención va dentro de un <details> (con summary del título)', () => {
    const html = renderIntentPanel(intent, session('borrador'), 'tok', 's1')
    expect(html).toContain('<details class="mir-intent-d"')
    expect(html).toContain('<summary>')
    expect(html).toContain('Resumen de intención')
    expect(html).toContain('Saldos por empresa')
  })

  it('abierto por default cuando HAY resumen', () => {
    const html = renderIntentPanel(intent, session('borrador'), 'tok', 's1')
    expect(html).toContain('<details class="mir-intent-d" open>')
  })

  it('cerrado (sin open) y con hint «(vacío)» cuando NO hay resumen', () => {
    const html = renderIntentPanel(undefined, session('borrador'), 'tok', 's1')
    expect(html).toContain('<details class="mir-intent-d">')
    expect(html).not.toContain('mir-intent-d" open')
    expect(html).toContain('(vacío)')
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
