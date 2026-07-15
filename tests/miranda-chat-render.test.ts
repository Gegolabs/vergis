import { describe, it, expect } from 'vitest'
import { mdInline, renderChat } from '../server/miranda'

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
    expect(html).toContain('Miranda:')
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
