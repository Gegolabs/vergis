/**
 * PLUGIN `vergis` · V5 — dos fronteras que una revisión no garantiza y una prueba sí.
 *
 * D5 · CERO LITERALES DE INSTALACIÓN EN EL PLUGIN. El plugin viaja a todo operador de Vergis: un hecho de
 * una instalación escrito adentro (su VM, su raíz, sus contenedores, su cuenta técnica) es exactamente el
 * defecto que el plugin existe para cerrar — los instrumentos del primer adoptante nacieron con esos
 * hechos como valores por omisión. La lista es de HECHOS, no de prefijos: «Mira» es una familia de Let
 * del Producto y el plugin la nombra legítimamente, igual que `schema/mira-spec.schema.json`.
 *
 * REGLA DE LA LISTA: no se acorta. Una instalación que se sume la alarga; una excepción nueva lleva su
 * razón, pasa por el orquestador y queda en el CHANGELOG.
 *
 * D3 · NINGÚN `vergis-ops.json` FUERA DE `tests/fixtures/`. En el repo del Producto se publica y se avisa,
 * no se opera: si una sesión de este repo no encuentra una declaración, ningún verbo toca una instalación
 * real. La regla es de ESTA casa y vive acá, no en el CLI, para que ningún cliente la herede.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { PLUGIN, RAIZ } from './plugin-helpers'

/** Hechos de instalación, por instalación. `re` cuando la forma admite espaciado variable. */
const LITERALES: { instalacion: string; literal: string; re?: RegExp }[] = [
  { instalacion: 'GH', literal: 'grupohijuelas' },
  { instalacion: 'GH', literal: 'rg-arbol' },
  { instalacion: 'GH', literal: 'vm-vergis' },
  { instalacion: 'GH', literal: '/opt/mira' },
  { instalacion: 'GH', literal: 'arboltec' },
  { instalacion: 'GH', literal: 'mira-slack-relay' },
  { instalacion: 'GH', literal: 'mira-caddy' },
  { instalacion: 'GH', literal: 'mira-vergis' },
  { instalacion: 'GH', literal: '-p mira', re: /(^|\s)-p\s+mira\b/ },
  { instalacion: 'GH', literal: '"compose_project": "mira"', re: /"compose_project"\s*:\s*"mira"/ },
  { instalacion: 'estudios', literal: '/opt/estudios' },
  { instalacion: 'estudios', literal: 'estudios-caddy' },
  { instalacion: 'estudios', literal: 'soveria-host' },
  { instalacion: 'estudios', literal: 'jumpserver-key' },
]

/**
 * Excepciones, cada una con su razón. Ninguna de ellas contiene un literal de la lista de arriba — están
 * escritas acá para que quien piense en acortar la lista por un falso positivo encuentre antes la regla:
 * lo legítimo no colisiona con un HECHO de instalación, solo con un prefijo.
 */
const EXCEPCIONES = [
  { que: '`schema/mira-spec.schema.json` y cualquier cita a él', razon: 'es el esquema del Let Mira, del Producto' },
  { que: 'la palabra «Mira» y la familia `mira` en `lets`, `watch:specs` y afines', razon: 'familia de Let del Producto, no una instalación' },
  { que: 'los fixtures de `tests/fixtures/`', razon: 'existen para probar declaraciones y no viajan en el plugin' },
]

function archivos(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...archivos(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

/** Hallazgos `{archivo, literal, instalacion}` en un conjunto de textos. */
export function escanear(textos: { archivo: string; texto: string }[]) {
  const hallazgos: { archivo: string; literal: string; instalacion: string }[] = []
  for (const { archivo, texto } of textos) {
    for (const l of LITERALES) {
      if (l.re ? l.re.test(texto) : texto.includes(l.literal)) hallazgos.push({ archivo, literal: l.literal, instalacion: l.instalacion })
    }
  }
  return hallazgos
}

describe('D5 · cero literales de instalación en plugins/vergis/**', () => {
  it('el árbol del plugin no trae ningún hecho de ninguna instalación', () => {
    const textos = archivos(PLUGIN).filter((f) => statSync(f).size < 2_000_000).map((f) => ({ archivo: relative(RAIZ, f), texto: readFileSync(f, 'utf8') }))
    expect(textos.length).toBeGreaterThan(10) // el escaneo miró algo: un árbol vacío pasaría verde
    expect(escanear(textos)).toEqual([])
  })

  for (const l of LITERALES) {
    it(`sabe reprobar: «${l.literal}» (${l.instalacion}) inyectado en un archivo del plugin se detecta`, () => {
      const h = escanear([{ archivo: 'plugins/vergis/skills/ops/SKILL.md', texto: `texto legítimo\nun paso con ${l.literal} adentro\n` }])
      expect(h.map((x) => x.literal)).toContain(l.literal)
    })
  }

  it('pasa con las excepciones legítimas: el esquema del Let Mira citado en una skill, y la familia mira', () => {
    const texto = 'Valida el spec contra `schema/mira-spec.schema.json`. La familia de Let `mira` recarga por `watch:specs` (Mira).'
    expect(escanear([{ archivo: 'plugins/vergis/skills/ops/SKILL.md', texto }])).toEqual([])
    expect(EXCEPCIONES.length).toBe(3)
  })
})

/** Las declaraciones fuera de `tests/fixtures/` en una lista de rutas del repo. */
export function declaracionesSueltas(rutas: string[]): string[] {
  return rutas.filter((r) => /(^|\/)vergis-ops\.json$/.test(r) && !r.startsWith('tests/fixtures/'))
}

describe('D3 · ningún vergis-ops.json fuera de tests/fixtures/ en el repo del Producto', () => {
  it('el repo (índice + archivos nuevos no ignorados) no trae ninguno', () => {
    const git = (...a: string[]) => execFileSync('git', ['-C', RAIZ, ...a], { encoding: 'utf8' }).split('\n').filter(Boolean)
    const rutas = [...git('ls-files'), ...git('ls-files', '--others', '--exclude-standard')]
    expect(rutas.length).toBeGreaterThan(100)
    expect(declaracionesSueltas(rutas)).toEqual([])
  })
  it('sabe reprobar: un vergis-ops.json en la raíz o en cualquier otra parte se detecta', () => {
    expect(declaracionesSueltas(['vergis-ops.json'])).toEqual(['vergis-ops.json'])
    expect(declaracionesSueltas(['deploy/rollout/bench/vergis-ops.json'])).toHaveLength(1)
    expect(declaracionesSueltas(['tests/fixtures/plugin/banco/vergis-ops.json'])).toEqual([])
  })
})
