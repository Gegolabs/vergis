// La SUPERFICIE de la capa de notas en un PI servido: la bandeja, las llaves de fila y el marcador.
//
// Lo que se defiende acá:
//  · los actos (Imprimir · Anotar) viven en la BANDEJA, no sueltos en el cuerpo;
//  · una tabla sin `anchor` no emite llaves ni ofrece el gesto (fail-closed, D16);
//  · la llave de fila del servidor y la del runtime son la MISMA cadena (si divergen, el marcador
//    aparece o no según por dónde se pregunte);
//  · solo viajan las llaves CON comentarios (render escaso: el payload no delata filas no servidas);
//  · sin contexto de notas, el PI se sirve exactamente como antes.
import { describe, it, expect } from 'vitest'
import {
  renderHtmlPiece,
  llaveCanonicaDeFila,
  canonicalKey,
  llaveDeFila,
  NOTAS_RUNTIME_SOURCE,
  renderCsvPiece,
  type ResolvedNode,
  type NotasRenderContext,
} from '@vergis/capabilities'

const NOTAS: NotasRenderContext = {
  imprimirUrl: '/pi-16/imprimir',
  notasUrl: '/pi-16/notas',
  comentariosUrl: '/pi-16/comentarios',
  impresionesUrl: '/impresiones',
  csrf: 'tok-123',
  page: 'principal',
}

const tabla = (ancla?: ResolvedNode['ancla']): ResolvedNode => ({
  type: 'table',
  dataset: 'empleados',
  interactive: true,
  columnsSpec: [
    { field: 'rut', label: 'RUT' },
    { field: 'nombre', label: 'Nombre' },
  ],
  rows: [
    { rut: 4021, nombre: 'Ana' },
    { rut: 9999, nombre: 'Beto' },
  ],
  ancla,
})

const ANCLA = {
  dataset: 'empleados',
  entity: 'dbo.dim_empleado',
  key: ['rut'],
  comentarios: { [llaveCanonicaDeFila({ rut: 4021 }, ['rut'])]: { count: 2, porCampo: { '': 1, nombre: 1 } } },
}

const render = (params: Record<string, unknown>): Promise<string> =>
  renderHtmlPiece.execute(params, { agent: 'test' }).then((o) => (o as { html: string }).html)

/** Solo el `<tbody>` servido: las filas, sin el código del runtime que las decora después. */
function cuerpoTabla(html: string): string {
  const m = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)
  return m ? m[1] : ''
}

/** El payload JSON embebido de la tabla (lo que el runtime hidrata). */
function payloadDe(html: string): Record<string, unknown> {
  const m = /<script type="application\/json" class="vtable-data">([\s\S]*?)<\/script>/.exec(html)
  if (!m) throw new Error('la tabla no embebió su payload')
  return JSON.parse(m[1].replace(/\\u003c/g, '<')) as Record<string, unknown>
}

describe('capa de notas · la bandeja', () => {
  it('con contexto de notas, la bandeja ofrece Imprimir y Anotar', async () => {
    const html = await render({ piece: tabla(ANCLA), notas: NOTAS })
    expect(html).toContain('vt-notas-kit')
    expect(html).toContain('notas-imprimir')
    expect(html).toContain('notas-anotar')
    // Y viven DENTRO del panel de la bandeja, no sueltos en el cuerpo.
    expect(html.indexOf('tray-panel-controles')).toBeLessThan(html.indexOf('vt-notas-kit'))
  })

  it('el contexto viaja como JSON, no interpolado en el script (el recorte lo escribe el usuario)', async () => {
    const html = await render({ piece: tabla(ANCLA), notas: { ...NOTAS, ctx: { area: '</script><script>alert(1)</script>' } } })
    expect(html).toContain('id="vergis-notas"')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('\\u003c')
  })

  it('sin contexto de notas, el PI se sirve sin superficie de notas', async () => {
    const html = await render({ piece: tabla(ANCLA) })
    expect(html).not.toContain('vt-notas-kit')
    expect(html).not.toContain('id="vergis-notas"')
    expect(html).not.toContain('NOTAS-RUNTIME')
  })

  it('el runtime de notas se inyecta DESPUÉS del de tabla (decora un tbody que ya existe)', async () => {
    const html = await render({ piece: tabla(ANCLA), notas: NOTAS })
    expect(html.indexOf('vtBootstrap')).toBeLessThan(html.indexOf("getElementById('vergis-notas')"))
  })
})

describe('capa de notas · llaves de fila y marcadores', () => {
  it('una tabla ANCLADA emite la llave canónica de cada fila', async () => {
    const html = await render({ piece: tabla(ANCLA), notas: NOTAS })
    expect(html).toContain(`data-nkey="{&quot;rut&quot;:&quot;4021&quot;}"`)
    expect(html).toContain('data-ndataset="empleados"')
  })

  it('una tabla SIN anchor no emite llaves: el gesto no se ofrece (fail-closed)', async () => {
    const html = await render({ piece: tabla(undefined), notas: NOTAS })
    // Ninguna FILA lleva llave. Se mira el tbody, no el documento: el runtime menciona `data-nkey`
    // en sus selectores, y eso es código, no una llave servida.
    expect(cuerpoTabla(html)).not.toContain('data-nkey')
    expect(payloadDe(html).ancla).toBeUndefined()
    // Con anchor, en cambio, el mismo tbody sí las lleva.
    expect(cuerpoTabla(await render({ piece: tabla(ANCLA), notas: NOTAS }))).toContain('data-nkey')
  })

  it('solo viajan las llaves CON comentarios (render escaso)', async () => {
    const html = await render({ piece: tabla(ANCLA), notas: NOTAS })
    const ancla = payloadDe(html).ancla as { comentarios: Record<string, { count: number }> }
    // La 4021 tiene comentarios; la 9999 no aparece — el payload no delata filas sin conversación.
    expect(Object.keys(ancla.comentarios)).toEqual([llaveCanonicaDeFila({ rut: 4021 }, ['rut'])])
    expect(ancla.comentarios[llaveCanonicaDeFila({ rut: 4021 }, ['rut'])].count).toBe(2)
  })

  it('la llave del SERVIDOR y la del STORE coinciden exactamente', () => {
    const fila = { rut: 4021, nombre: 'Ana' }
    expect(llaveCanonicaDeFila(fila, ['rut'])).toBe(canonicalKey(llaveDeFila(fila, ['rut'])))
    // Coerción a texto: `4021` numérico y `"4021"` textual son la MISMA llave.
    expect(llaveCanonicaDeFila({ rut: 4021 }, ['rut'])).toBe(llaveCanonicaDeFila({ rut: '4021' }, ['rut']))
    // Llave compuesta: el orden de las columnas no cambia la llave.
    expect(llaveCanonicaDeFila({ a: 1, b: 2 }, ['b', 'a'])).toBe(llaveCanonicaDeFila({ a: 1, b: 2 }, ['a', 'b']))
  })

  it('el runtime de tabla construye la llave con el MISMO algoritmo que el servidor', async () => {
    // vtNKey es la implementación cliente; se evalúa aislada y se compara con la del servidor.
    const src = /function vtNKey\(r, key\)\{[\s\S]*?\n\}/.exec(NOTAS_RUNTIME_SOURCE + '')
    // vtNKey vive en el runtime de TABLA; se importa desde ahí para compararlo.
    const { TABLE_RUNTIME_SOURCE } = await import('@vergis/capabilities')
    const m = /function vtNKey\(r, key\)\{[\s\S]*?\n\}/.exec(TABLE_RUNTIME_SOURCE)
    expect(m).not.toBeNull()
    const vtNKey = new Function(`${m![0]}; return vtNKey;`)() as (r: Record<string, unknown>, k: string[]) => string
    for (const fila of [{ rut: 4021 }, { rut: '4021' }, { a: 1, b: 'x' }] as Record<string, unknown>[]) {
      const key = Object.keys(fila)
      expect(vtNKey(fila, key)).toBe(llaveCanonicaDeFila(fila, key))
    }
    expect(src).toBeNull() // el runtime de notas NO duplica el algoritmo: lo consume del de tabla
  })
})

describe('capa de notas · lo que NO viaja', () => {
  it('el export CSV no lleva llaves ni comentarios: es dato del PI, no la conversación sobre él', async () => {
    const out = (await renderCsvPiece.execute({ piece: tabla(ANCLA) }, { agent: 'test' })) as { csv: string }
    expect(out.csv).toBe('RUT,Nombre\n4021,Ana\n9999,Beto\n')
    expect(out.csv).not.toContain('nkey')
    expect(out.csv).not.toContain('comentario')
  })

  it('el marcador se dibuja solo sobre llaves servidas: el runtime lee el payload, no consulta el store', () => {
    // El runtime jamás pide «todos los comentarios de la entidad»: usa `payload.ancla.comentarios`,
    // que el server pobló con las llaves de las filas ya RLS-filtradas.
    expect(NOTAS_RUNTIME_SOURCE).toContain('payload.ancla')
    expect(NOTAS_RUNTIME_SOURCE).toContain('(ancla.comentarios||{})[llaveTxt]')
  })
})
