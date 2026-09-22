// EL EMISOR del Datadoc (CAP-197), portado del generador de instancia.
//
// Dos cosas se miden acá, y la primera es la que no se puede dejar de medir: que **ningún literal de
// la instancia que lo originó** sobreviva en el motor. La lista es cerrada y se corre sobre CADA
// archivo emitido — sin este test, el nombre del cliente vuelve en el primer merge distraído y nadie
// lo nota hasta que otra instancia abre su catálogo y lee el nombre de un tercero.
//
// La segunda es que una entidad cuyo conteo NO se pidió no muestre un número: el modelo ya decidió,
// pero es el render el que lo escribe, y una plantilla puede deshacer una decisión de seguridad.

import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { renderDatadoc, paginaSinBuild } from '../server/datadoc-render'
import { ensamblar } from '../server/datadoc-modelo'
import type { ModeloConexion } from '../server/datadoc-introspect'
import { parseSemanticaConfig } from '../server/semantica-config'
import { parseDomainsConfig } from '@vergis/capabilities'

const T0 = '2026-09-21T12:00:00.000Z'

const modeloConexion: ModeloConexion = {
  ref: 'finanzas',
  database: 'wh_finanzas',
  server: 'endpoint.example',
  medidoEn: T0,
  ms: 120,
  objetos: [
    { ref: 'dbo.fact_saldos', schema: 'dbo', nombre: 'fact_saldos', esVista: false },
    { ref: 'dbo.gobernada', schema: 'dbo', nombre: 'gobernada', esVista: false },
    { ref: 'dbo.v_saldos', schema: 'dbo', nombre: 'v_saldos', esVista: true },
  ],
  columnas: {
    'dbo.fact_saldos': [{ nombre: 'Fecha_Carga', ordinal: 1, tipo: 'date', nulable: false }],
    'dbo.gobernada': [{ nombre: 'area', ordinal: 1, tipo: 'nvarchar(50)', nulable: false }],
  },
  vistasDef: { 'dbo.v_saldos': 'CREATE VIEW …' },
  linaje: [{ vista: 'dbo.v_saldos', base: 'dbo.fact_saldos', schemabound: true }],
  gobierno: {
    'dbo.fact_saldos': { clase: 'abierta', politicas: [{ secpol: 'secpol_a', habilitada: true, predicado: 'x', funcion: 'dbo.fn_a', clase: 'abierta' }] },
    'dbo.gobernada': { clase: 'filtrada', politicas: [{ secpol: 'secpol_g', habilitada: true, predicado: 'y', funcion: 'dbo.fn_g', clase: 'filtrada' }] },
  },
  conteos: { 'dbo.fact_saldos': 1234 },
  esquemas: ['dbo'],
  errores: [],
}

const modelo = ensamblar({
  modelos: [modeloConexion],
  refs: ['finanzas', 'caida'],
  fallidas: { caida: 'ETIMEDOUT' },
  domains: parseDomainsConfig({ domains: [{ id: 'fin', label: 'Finanzas', connections: ['finanzas'] }] }),
  now: () => new Date(T0),
})

const archivos = renderDatadoc({ modelo, brandTitle: 'Productos de Información', timezone: 'America/Santiago' })
const porRuta = new Map(archivos.map((a) => [a.rel, a.contenido]))

/**
 * ⚠ LA LISTA CERRADA: literales de la instancia que originó el emisor. Ninguno puede aparecer en un
 * motor genérico — ni el nombre del proyecto, ni el del cliente, ni el de una herramienta que esa
 * instancia usaba, ni su resolución interna, ni la ruta de su generador.
 */
const PROHIBIDOS = [
  'A.R.B.O.L.',
  'ARBOL',
  'Grupo Hijuelas',
  'Hijuelas',
  'PowerBI',
  'Power BI',
  'R-007',
  'César',
  'gen-datadoc.mjs',
  'work/213',
  'work/217',
  'secpol-fct_asistencia_dia',
  'Borrador interno',
  'Ratio',
]

describe('⚠ el motor no lleva un solo literal de la instancia que lo originó', () => {
  it.each(PROHIBIDOS)('ningún archivo emitido contiene «%s»', (prohibido) => {
    const culpables = archivos.filter((a) => a.contenido.includes(prohibido)).map((a) => a.rel)
    // REFUTARÍA: un solo archivo acá significa que otra instancia abriría su catálogo y leería el
    // nombre de un tercero.
    expect(culpables, `«${prohibido}» aparece en: ${culpables.join(', ')}`).toEqual([])
  })

  it('el título sale de la marca de la plataforma, no de un nombre cableado', () => {
    expect(porRuta.get('index.html')).toContain('Productos de Información · Datadoc')
  })

  it('sin marca declarada, el título es simplemente «Datadoc»', () => {
    const sinMarca = renderDatadoc({ modelo })
    expect(sinMarca.find((a) => a.rel === 'index.html')!.contenido).toContain('<title>Datadoc</title>')
  })
})

describe('el sitio que se emite', () => {
  it('trae las páginas fijas, la hoja, el índice del buscador, el marco y una página por entidad', () => {
    expect(porRuta.has('index.html')).toBe(true)
    expect(porRuta.has('seguridad.html')).toBe(true)
    expect(porRuta.has('todas-las-entidades.html')).toBe(true)
    expect(porRuta.has('marco.html')).toBe(true)
    expect(porRuta.has('datadoc.css')).toBe(true)
    expect(porRuta.has('search-index.js')).toBe(true)
    expect(porRuta.has('dominios/fin.html')).toBe(true)
    // La URL de una entidad se ancla en la CONEXIÓN, no en el dominio: el dominio es una etiqueta que
    // puede reagrupar conexiones sin que la entidad cambie de lugar.
    expect(porRuta.has('entidades/finanzas--dbo.fact_saldos.html')).toBe(true)
  })

  it('los enlaces son todos relativos: el build se descarga, se comprime y sigue navegando', () => {
    for (const a of archivos) {
      if (!a.rel.endsWith('.html')) continue
      expect(a.contenido, `${a.rel} tiene un href absoluto`).not.toMatch(/href="\/(?!\/)/)
    }
  })

  it('`search-index.js` es JS VÁLIDO y declara la variable (fetch no funciona por file://)', () => {
    const ctx: { DATADOC_INDEX?: unknown[] } = {}
    vm.createContext(ctx)
    vm.runInContext(porRuta.get('search-index.js')!, ctx)
    expect(Array.isArray(ctx.DATADOC_INDEX)).toBe(true)
    expect(ctx.DATADOC_INDEX).toHaveLength(3)
    expect((ctx.DATADOC_INDEX as { n: string }[]).map((e) => e.n)).toContain('dbo.fact_saldos')
  })
})

describe('⚠ una entidad cuyo conteo NO se pidió no muestra un número', () => {
  const pagina = porRuta.get('entidades/finanzas--dbo.gobernada.html')!
  it('la página de la entidad filtrada dice «no medidas» y no una cifra', () => {
    expect(pagina).toContain('no medidas (tabla gobernada por RLS con filtro)')
    // REFUTARÍA: cualquier número junto a «Filas» en una tabla que la RLS filtra.
    expect(pagina).not.toMatch(/<b>Filas:<\/b> [\d.]+</)
  })
  it('la abierta sí muestra su conteo', () => {
    expect(porRuta.get('entidades/finanzas--dbo.fact_saldos.html')).toContain('<b>Filas:</b> 1.234')
  })
  it('la página de seguridad explica POR QUÉ falta el número, en vez de dejar un guion mudo', () => {
    expect(porRuta.get('seguridad.html')).toMatch(/no pide.*conteo/s)
  })
})

describe('la degradación honesta se ve en las tres superficies', () => {
  it('el sello de la portada marca la conexión caída con su motivo', () => {
    const idx = porRuta.get('index.html')!
    expect(idx).toContain('NO medida')
    expect(idx).toContain('ETIMEDOUT')
    expect(idx).toContain('Conexiones medidas: <b>1 de 2</b>')
  })
  it('la página del dominio técnico de la conexión caída lo declara', () => {
    expect(porRuta.get('dominios/caida.html')).toContain('NO medida en esta corrida')
  })
  it('una conexión sin dominio declarado se rotula como tal, sin inventarle uno', () => {
    expect(porRuta.get('dominios/caida.html')).toContain('conexión sin dominio declarado')
  })
})

describe('el texto de instancia llega escapado a la página', () => {
  it('un `<script>` en una descripción sale como texto en el HTML emitido', () => {
    const semantica = parseSemanticaConfig({
      semantica: { conexiones: [{ conexion: 'finanzas', entidades: { 'dbo.fact_saldos': { descripcion: '<script>alert(1)</script> del `hecho`' } } }] },
    })
    const m = ensamblar({ modelos: [modeloConexion], refs: ['finanzas'], semantica, now: () => new Date(T0) })
    const html = renderDatadoc({ modelo: m }).find((a) => a.rel === 'entidades/finanzas--dbo.fact_saldos.html')!.contenido
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<code>hecho</code>')
  })
})

describe('el aviso de catálogo rancio', () => {
  it('se declara en la portada y los conteos desaparecen del sitio entero', () => {
    const m = ensamblar({ modelos: [modeloConexion], refs: ['finanzas'], rancio: { razon: 'watch:policies', desde: T0 }, now: () => new Date(T0) })
    const fs = renderDatadoc({ modelo: m })
    expect(fs.find((a) => a.rel === 'index.html')!.contenido).toContain('Catálogo marcado rancio')
    for (const a of fs) expect(a.contenido, a.rel).not.toContain('1.234')
  })
})

describe('paginaSinBuild', () => {
  it('dice «aún no generado» y apunta a Administración — no un 404 pelado', () => {
    const html = paginaSinBuild('Productos de Información')
    expect(html).toContain('Datadoc aún no generado')
    expect(html).toContain('/admin/datadoc')
    // Autocontenida: no hay build del que leer una hoja de estilos.
    expect(html).not.toContain('datadoc.css')
  })
})
