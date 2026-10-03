// COTEJO DEL CATÁLOGO DE CAPACIDADES (#264) — el mismo instrumento que `npm run capacidades:cotejo`,
// corriendo en CI sin tocar `build.yml`: la suite ya corre entera en el gate, así que un test que
// invoca la función del script es todo lo que hace falta para que el catálogo no envejezca en silencio.
//
// La aceptación está primero, y es el CONTROL NEGATIVO: antes de creerle un verde al cotejo, se le
// exige reprobar catálogos que están mal a propósito. Un instrumento que no sabe reportar el fallo
// produce datos con cara de verdad — un verde suyo diría «no encontré nada» y se leería «no hay nada».
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RAIZ,
  cotejar,
  parsearCatalogo,
  estaCitado,
  derivarConjuntos,
  versionesPublicadas,
  type ConjuntoDerivado,
} from '../scripts/capacidades-cotejo'

/** Conjunto derivado de mentira, para los fixtures: dos tipos de pieza que el catálogo debe citar. */
const FIXTURE_CONJUNTOS: ConjuntoDerivado[] = [
  { nombre: 'tipos de pieza', origen: 'fixture', valores: ['kpi', 'table'] },
]

const catalogoSano = `
| ID | Capacidad | Cómo se llama | Desde | Dónde |
|--|--|--|--|--|
| \`CAP-01\` | Indicador | \`kpi\` | ≤0.9 | x |
| \`CAP-02\` | Tabla | \`table\` | ≤0.9 | x |
`

describe('control negativo — el cotejo sabe reprobar', () => {
  it('el fixture sano pasa (sin él, los de abajo no probarían nada)', () => {
    expect(cotejar(catalogoSano, FIXTURE_CONJUNTOS)).toEqual([])
  })

  it('reprueba un ID duplicado', () => {
    const md = catalogoSano.replace('`CAP-02`', '`CAP-01`')
    const h = cotejar(md, FIXTURE_CONJUNTOS)
    expect(h.some((x) => x.clase === 'numeracion' && /duplicado: CAP-01/.test(x.detalle))).toBe(true)
  })

  it('reprueba un hueco en la numeración que nadie declaró retirado', () => {
    const md = catalogoSano.replace('`CAP-01`', '`CAP-03`')
    const h = cotejar(md, FIXTURE_CONJUNTOS)
    expect(h.some((x) => /hueco sin explicar: CAP-01/.test(x.detalle))).toBe(true)
  })

  it('ACEPTA el hueco cuando ese número aparece declarado como retirada', () => {
    const md = `${catalogoSano.replace('`CAP-01`', '`CAP-03`')}
| \`CAP-01\` | Anotaciones por HMAC | \`VERGIS_ANNOTATION_SECRET\` | retirada | la capa de notas |
`
    expect(cotejar(md, FIXTURE_CONJUNTOS)).toEqual([])
  })

  it('reprueba un ID mal formado (un solo dígito)', () => {
    const md = catalogoSano.replace('`CAP-01`', '`CAP-1`')
    const h = cotejar(md, FIXTURE_CONJUNTOS)
    expect(h.some((x) => /mal formado/.test(x.detalle))).toBe(true)
  })

  it('reprueba un tipo del schema que ninguna fila cita', () => {
    const md = catalogoSano.replace('`table`', '`tabla-que-no-existe`')
    const h = cotejar(md, FIXTURE_CONJUNTOS)
    expect(h.some((x) => x.clase === 'cobertura' && /«table»/.test(x.detalle))).toBe(true)
  })

  it('NO se conforma con un calce por substring — `id` dentro de `identity` no es una cita', () => {
    expect(estaCitado('id', ['identity.id'])).toBe(true) // delimitado por un punto: sí es cita
    expect(estaCitado('id', ['identity'])).toBe(false) // adentro de otra palabra: no lo es
  })

  it('un catálogo vacío no aprueba por omisión', () => {
    const h = cotejar('sin tablas acá', FIXTURE_CONJUNTOS)
    expect(h.filter((x) => x.clase === 'cobertura')).toHaveLength(2)
  })
})

describe('el catálogo real', () => {
  const md = readFileSync(join(RAIZ, 'docs', 'capacidades.md'), 'utf8')

  it('deriva sus conjuntos del schema y del código sin perder ninguna ancla', () => {
    const conjuntos = derivarConjuntos()
    // Si una derivación pierde su ancla, `derivarConjuntos` lanza `AnclaPerdida` y este test truena
    // nombrándola — que es justo lo contrario de derivar una lista vacía y aprobar por omisión.
    expect(conjuntos.length).toBeGreaterThan(0)
    for (const c of conjuntos) expect(c.valores.length, `conjunto vacío: ${c.nombre}`).toBeGreaterThan(0)
  })

  it('tiene numeración sana y cita todo lo que la máquina declara', () => {
    const hallazgos = cotejar(md, derivarConjuntos())
    expect(hallazgos.map((h) => h.detalle)).toEqual([])
  })

  it('no está vacío — un catálogo sin filas pasaría los checks de arriba por vacuidad', () => {
    expect(parsearCatalogo(md).ids.length).toBeGreaterThan(50)
  })
})

describe('columna «Desde» (#335) — control negativo', () => {
  const PUB = ['0.9.0', '0.32.0', '0.42.0']
  const conDesde = (celda: string) =>
    `| ID | Capacidad | Cómo | Desde | Dónde |\n|--|--|--|--|--|\n| \`CAP-01\` | Indicador | \`kpi\` | ${celda} | x |\n| \`CAP-02\` | Tabla | \`table\` | ≤0.9 | x |\n`
  const versionHallazgos = (celda: string) =>
    cotejar(conDesde(celda), FIXTURE_CONJUNTOS, PUB).filter((h) => h.clase === 'version')

  it('acepta cada forma legítima (sin ellas, los rechazos de abajo no prueban nada)', () => {
    for (const ok of ['0.32.0', '`0.32.0`', '≤0.9', '—', 'sin publicar', 'sin publicar · 0.43.0', '0.9.0 · 0.42.0', '0.32.0 (#12)', '0.9.0 (desde 0.42.0: `lets`)'])
      expect(versionHallazgos(ok), ok).toEqual([])
  })

  it('reprueba una celda mal escrita', () => {
    expect(versionHallazgos('v0.32').some((h) => /ortografía/.test(h.detalle))).toBe(true)
    expect(versionHallazgos('pronto').length).toBe(1)
  })

  it('reprueba una versión inventada (no está en el CHANGELOG)', () => {
    expect(versionHallazgos('0.31.0').some((h) => /no está en el historial/.test(h.detalle))).toBe(true)
  })

  it('reprueba «sin publicar» con una versión ya cortada — el caso de d32d421', () => {
    expect(versionHallazgos('sin publicar · 0.42.0').some((h) => /ya está en el CHANGELOG/.test(h.detalle))).toBe(true)
  })

  it('un pipe escapado dentro de otra celda no corre la columna «Desde»', () => {
    const md = '| `CAP-01` | Indicador | `a \\| b` | 0.32.0 | x |\n'
    expect(cotejar(md, [], PUB)).toEqual([])
    expect(parsearCatalogo(md).versiones[0]?.celda).toBe('0.32.0')
  })

  it('el historial de releases se deriva del CHANGELOG y falla ruidoso si no encuentra ninguno', () => {
    expect(versionesPublicadas('## 0.42.0 — x\n## 0.41.0 — y')).toEqual(['0.42.0', '0.41.0'])
    expect(() => versionesPublicadas('sin encabezados')).toThrow(/no encontró su ancla/)
  })
})

describe('el catálogo real — columna «Desde»', () => {
  it('es coherente con el historial de releases del CHANGELOG', () => {
    const md = readFileSync(join(RAIZ, 'docs', 'capacidades.md'), 'utf8')
    const pub = versionesPublicadas(readFileSync(join(RAIZ, 'CHANGELOG.md'), 'utf8'))
    expect(cotejar(md, [], pub).filter((h) => h.clase === 'version')).toEqual([])
  })
})
