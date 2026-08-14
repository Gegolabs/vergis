// El render de gráficos NO hace E/S — ni de red ni de disco.
//
// El control que fija todo esto: el primer test levanta un servidor HTTP local y demuestra que
// **sin las defensas el fetch ocurre de verdad**. Sin ese control, los tests de abajo pasarían
// también si Vega nunca hubiera intentado cargar nada, y estaríamos verificando el vacío.
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { createRequire } from 'node:module'
import { vegaLiteToSvg } from '../packages/capabilities/src/render-chart'

// `vega`/`vega-lite` son dependencias DEL PAQUETE `capabilities`, no de la raíz: el control tiene que
// resolverlas desde ahí, igual que lo hace el módulo que prueba.
const req = createRequire(new URL('../packages/capabilities/src/render-chart.ts', import.meta.url))
const vega = (await import(req.resolve('vega'))) as typeof import('vega')
const { compile } = (await import(req.resolve('vega-lite'))) as typeof import('vega-lite')

const specConUrl = (url: string) =>
  ({
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    data: { url },
    mark: 'bar',
    encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } },
  }) as never

const specInline = {
  $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
  data: { values: [{ a: 'x', b: 1 }, { a: 'y', b: 2 }] },
  mark: 'bar',
  encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } },
} as never

describe('render de gráficos · sin E/S', () => {
  it('CONTROL DEL INSTRUMENTO: sin defensas, Vega SÍ sale a la red (si esto no se cumple, los demás tests no prueban nada)', async () => {
    let hits = 0
    const srv = http.createServer((_req, res) => {
      hits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ a: 'x', b: 1 }]))
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as { port: number }).port
    try {
      const vg = compile(specConUrl(`http://127.0.0.1:${port}/d.json`)).spec
      const view = new vega.View(vega.parse(vg as vega.Spec), { renderer: 'none' })
      await view.runAsync()
      view.finalize()
      expect(hits).toBe(1) // el fetch ocurrió: el instrumento sabe detectarlo
    } finally {
      srv.close()
    }
  })

  it('el spec con `data.url` se RECHAZA, y el error nombra dónde estaba', async () => {
    await expect(vegaLiteToSvg(specConUrl('http://127.0.0.1:9/d.json'))).rejects.toThrow(/datos externos en 'spec\.data\.url'/)
  })

  it('rechaza también `file://` — el vector de disco es el mismo camino', async () => {
    await expect(vegaLiteToSvg(specConUrl('file:///etc/hosts'))).rejects.toThrow(/E\/S|datos externos/)
  })

  it('rechaza una `url` ANIDADA (capa/lookup), no solo la de primer nivel', async () => {
    const anidado = {
      $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
      layer: [
        { data: { values: [{ a: 'x', b: 1 }] }, mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } },
        { data: { url: 'http://127.0.0.1:9/otro.json' }, mark: 'line', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } },
      ],
    } as never
    await expect(vegaLiteToSvg(anidado)).rejects.toThrow(/datos externos/)
  })

  it('con la URL apuntando a un servidor VIVO tampoco lo toca: cero hits (no es que la red fallara)', async () => {
    let hits = 0
    const srv = http.createServer((_req, res) => {
      hits += 1
      res.end('[]')
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as { port: number }).port
    try {
      await expect(vegaLiteToSvg(specConUrl(`http://127.0.0.1:${port}/d.json`))).rejects.toThrow()
      expect(hits).toBe(0)
    } finally {
      srv.close()
    }
  })

  it('el camino normal sigue funcionando: datos inline rinden SVG', async () => {
    const svg = await vegaLiteToSvg(specInline)
    expect(svg).toContain('<svg')
    expect(svg.length).toBeGreaterThan(500)
  })
})
