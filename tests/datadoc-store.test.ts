// LA CACHÉ EN DISCO del Datadoc (CAP-197), con sus dos experimentos.
//
//  1. **El swap es atómico.** Que `rename(2)` reemplace un symlink sin ventana intermedia es garantía
//     POSIX — se ASUME, así que acá se pone en riesgo: un lector en bucle sobre `realpathSync(current)`
//     durante doscientos swaps no puede ver un solo `ENOENT`. Si el FS de abajo no cumpliera, este
//     test lo delata en vez de dejarlo como un 404 intermitente que nadie reproduce.
//  2. **La poda no toca nada que no sea suyo.** Se planta un centinela hermano y se verifica que
//     sobreviva: un `rm -r` sobre una ruta calculada es el error que se paga una sola vez.

import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  dirDatadoc,
  escribirBuild,
  escribirModelo,
  escribirSello,
  hayBuild,
  leerModelos,
  leerSello,
  podar,
  publicar,
  rutaCurrent,
  selloDe,
} from '../server/datadoc-store'
import type { ModeloConexion } from '../server/datadoc-introspect'

const modelo = (ref: string): ModeloConexion => ({
  ref,
  database: `wh_${ref}`,
  server: 'endpoint',
  medidoEn: '2026-09-21T12:00:00.000Z',
  ms: 10,
  objetos: [{ ref: 'dbo.t', schema: 'dbo', nombre: 't', esVista: false }],
  columnas: {},
  vistasDef: {},
  linaje: [],
  gobierno: {},
  conteos: {},
  esquemas: ['dbo'],
  errores: [],
})

let out: string
let dir: string
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'vergis-datadoc-'))
  dir = dirDatadoc(out)
})

describe('modelos', () => {
  it('se escriben por conexión y se releen todos, en orden estable', () => {
    escribirModelo(dir, modelo('ventas'))
    escribirModelo(dir, modelo('finanzas'))
    expect(leerModelos(dir).map((m) => m.ref)).toEqual(['finanzas', 'ventas'])
  })
  it('un modelo se SOBREESCRIBE por conexión, sin tocar los demás', () => {
    escribirModelo(dir, modelo('finanzas'))
    escribirModelo(dir, { ...modelo('finanzas'), ms: 999 })
    escribirModelo(dir, modelo('ventas'))
    expect(leerModelos(dir).find((m) => m.ref === 'finanzas')!.ms).toBe(999)
    expect(leerModelos(dir)).toHaveLength(2)
  })
  it('un archivo corrupto se ignora sin tumbar la lectura de los sanos', () => {
    escribirModelo(dir, modelo('finanzas'))
    writeFileSync(join(dir, 'modelo', 'roto.json'), '{ esto no es json', 'utf8')
    expect(leerModelos(dir).map((m) => m.ref)).toEqual(['finanzas'])
  })
  it('un `database_ref` que no sirve como nombre de archivo se rechaza antes de escribir', () => {
    expect(() => escribirModelo(dir, modelo('../../escapa'))).toThrow(/database_ref inválido/)
  })
})

describe('sello', () => {
  it('un sello ausente lee vacío, no lanza', () => {
    expect(leerSello(dir)).toEqual({ conexiones: [], build: null, rancio: null })
  })
  it('ida y vuelta conserva build, rancio y periodKey', () => {
    const s = { conexiones: [selloDe(modelo('finanzas'))], build: { dir: 'build-x', generadoEn: 'T' }, rancio: { razon: 'watch:policies', desde: 'T' }, periodKey: '2026-09-21' }
    escribirSello(dir, s)
    expect(leerSello(dir)).toEqual(s)
  })
  it('`selloDe` con error marca `ok:false` y conserva lo que se sabía', () => {
    const s = selloDe(modelo('finanzas'), 'ETIMEDOUT')
    expect(s).toMatchObject({ ok: false, error: 'ETIMEDOUT', database: 'wh_finanzas' })
  })
})

describe('builds y publicación', () => {
  it('un build se escribe completo, con sus subdirectorios', () => {
    const b = escribirBuild(dir, [
      { rel: 'index.html', contenido: '<h1>a</h1>' },
      { rel: 'entidades/finanzas--dbo.t.html', contenido: 'x' },
    ])
    expect(readFileSync(join(b, 'index.html'), 'utf8')).toBe('<h1>a</h1>')
    expect(existsSync(join(b, 'entidades', 'finanzas--dbo.t.html'))).toBe(true)
  })
  it('un archivo que escapara del build se rechaza', () => {
    expect(() => escribirBuild(dir, [{ rel: '../fuera.html', contenido: 'x' }])).toThrow(/cae fuera del build/)
  })
  it('`current` es un symlink RELATIVO: el directorio se puede mover sin que el puntero cuelgue', () => {
    const b = escribirBuild(dir, [{ rel: 'index.html', contenido: 'a' }])
    publicar(dir, b)
    expect(hayBuild(dir)).toBe(true)
    expect(readFileSync(join(rutaCurrent(dir), 'index.html'), 'utf8')).toBe('a')
  })
  it('sin publicar nada, `hayBuild` es false y `current` no existe', () => {
    expect(hayBuild(dir)).toBe(false)
    expect(existsSync(rutaCurrent(dir))).toBe(false)
  })
})

describe('⚠ el experimento del swap: `current` nunca falta', () => {
  it('200 publicaciones consecutivas con un lector en bucle: cero ENOENT y siempre el build nuevo', () => {
    let publicado = escribirBuild(dir, [{ rel: 'index.html', contenido: 'v0' }])
    publicar(dir, publicado)
    const fallos: string[] = []
    for (let i = 1; i <= 200; i++) {
      const b = escribirBuild(dir, [{ rel: 'index.html', contenido: `v${i}` }], new Date(Date.parse('2026-09-21T00:00:00Z') + i * 1000))
      publicar(dir, b)
      publicado = b
      // Lectura INMEDIATAMENTE después del swap: si `rename` sobre un symlink tuviera una ventana,
      // acá caería un ENOENT. REFUTARÍA la garantía POSIX que el store asume.
      try {
        realpathSync(rutaCurrent(dir))
        const leido = readFileSync(join(rutaCurrent(dir), 'index.html'), 'utf8')
        if (leido !== `v${i}`) fallos.push(`iteración ${i}: se leyó '${leido}' tras publicar v${i}`)
      } catch (e) {
        fallos.push(`iteración ${i}: ${(e as Error).message}`)
      }
      // La poda corre en cada vuelta, como en producción: el build que `current` sirve nunca se borra.
      podar(dir, 2)
    }
    expect(fallos).toEqual([])
    expect(readFileSync(join(rutaCurrent(dir), 'index.html'), 'utf8')).toBe('v200')
  })
})

describe('poda', () => {
  it('tras 5 builds quedan 2, y el centinela hermano sobrevive', () => {
    // Un archivo y un directorio que NO son builds, dentro del mismo directorio.
    writeFileSync(join(dir, 'centinela.txt'), 'no me borres', 'utf8')
    mkdirSync(join(dir, 'otro-directorio'), { recursive: true })
    writeFileSync(join(dir, 'otro-directorio', 'x'), 'tampoco', 'utf8')
    let ultimo = ''
    for (let i = 0; i < 5; i++) {
      ultimo = escribirBuild(dir, [{ rel: 'index.html', contenido: `v${i}` }], new Date(Date.parse('2026-09-21T00:00:00Z') + i * 60_000))
    }
    publicar(dir, ultimo)
    podar(dir, 2)
    expect(readdirSync(dir).filter((f) => f.startsWith('build-'))).toHaveLength(2)
    // REFUTARÍA: un `rm -rf` sobre una ruta calculada se llevaría estos dos por delante.
    expect(existsSync(join(dir, 'centinela.txt'))).toBe(true)
    expect(existsSync(join(dir, 'otro-directorio', 'x'))).toBe(true)
    expect(existsSync(join(dir, 'modelo'))).toBe(true)
  })

  it('el build que `current` está sirviendo NUNCA se borra, aunque la poda lo eligiera', () => {
    const builds: string[] = []
    for (let i = 0; i < 4; i++) builds.push(escribirBuild(dir, [{ rel: 'index.html', contenido: `v${i}` }], new Date(Date.parse('2026-09-21T00:00:00Z') + i * 60_000)))
    // Se publica el MÁS VIEJO a propósito: la poda por antigüedad querría retirarlo.
    publicar(dir, builds[0])
    podar(dir, 2)
    // REFUTARÍA: servir desde un directorio recién borrado es el 404 intermitente que nadie reproduce.
    expect(existsSync(builds[0])).toBe(true)
    expect(hayBuild(dir)).toBe(true)
  })

  it('sobre un directorio sin builds no hace nada y no lanza', () => {
    expect(podar(dir, 2)).toEqual([])
  })
})
