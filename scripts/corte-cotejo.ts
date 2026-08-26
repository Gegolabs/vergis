/**
 * COTEJO DEL CORTE — ¿la sección del CHANGELOG declara lo que el tag va a contener?
 *
 * El defecto que cierra (causa raíz de #242, `PENDINGS.md`): al cortar una versión, lo que se compara
 * es **lo que el humano recuerda**, no lo que el tag trae. La entrada de anillos I7+I8 quedó bajo
 * «Sin publicar» con su código dentro de `v0.21.0`, y lo detectó una revisión de custodia por
 * casualidad. Una casualidad no es un control.
 *
 * ── Lo que este instrumento SÍ hace ────────────────────────────────────────────────────────────
 * Lista las referencias `#NNN` que aparecen en los commits del rango y las contrasta contra el texto
 * de la sección del CHANGELOG. Reporta las dos direcciones, porque las dos duelen:
 *
 *   · **en el código, no en la sección** — la versión traería un cambio que no declara;
 *   · **en la sección, no en el código** — la versión declararía algo que su tag no contiene (el caso
 *     inverso de #242, y el que produce un CHANGELOG que miente hacia arriba).
 *
 * ── Lo que NO hace, y hay que decirlo ──────────────────────────────────────────────────────────
 * **No mapea entrada→commit**: eso exigiría una convención que hoy no existe. Coteja por número de
 * issue/PR, así que un cambio que nadie referenció en su mensaje de commit le es INVISIBLE. Su
 * salida es un insumo para el cotejo a mano, no un veredicto — y por eso el «verde» de este script
 * dice «no encontré discrepancias por número», jamás «la sección está completa».
 *
 * El único supuesto que hace sobre el repo es el prefijo convencional del commit (`feat(`, `fix(`,
 * `docs(`…), y lo usa solo para bajar el ruido: los tipos que no cambian el Producto no exigen
 * entrada. Se declara acá porque si esa convención se abandona, este filtro empieza a callar.
 *
 * Uso:
 *   npm run corte:cotejo                          # último tag → HEAD, contra «Sin publicar»
 *   npm run corte:cotejo -- --desde v0.20.1 --hasta v0.21.0 --seccion 0.21.0
 *   npm run corte:cotejo -- ... --changelog /tmp/changelog-de-entonces.md   # retro-test
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Tipos de commit que NO exigen entrada de CHANGELOG: no cambian lo que el operador consume. */
const SIN_ENTRADA = new Set(['docs', 'chore', 'test', 'ci', 'style', 'refactor'])

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

// `--match 'v*'` NO es cosmético: sin él, `git describe` agarra el tag más reciente CUALQUIERA, y
// este árbol tiene tags que no son versiones (los `sov-preclose-*` del aparato de cierre de sesión).
// El primer uso real de este script cotejó contra uno de ésos — o sea que el instrumento arrancó
// midiendo el rango equivocado, y lo delató su propia salida. Queda escrito para que nadie lo quite.
const desde = arg('desde') ?? git('describe', '--tags', '--abbrev=0', '--match', 'v*')
const hasta = arg('hasta') ?? 'HEAD'
const seccion = arg('seccion') ?? 'Sin publicar'

/** Un commit del rango, con lo que hace falta para juzgarlo. */
interface Commit {
  sha: string
  asunto: string
  tipo: string
  refs: number[]
}

const commits: Commit[] = git('log', '--no-merges', '--format=%h%x09%s', `${desde}..${hasta}`)
  .split('\n')
  .filter(Boolean)
  .map((linea) => {
    const [sha, asunto] = linea.split('\t') as [string, string]
    const tipo = /^([a-z]+)[(:]/.exec(asunto)?.[1] ?? ''
    const refs = [...asunto.matchAll(/#(\d+)/g)].map((m) => Number(m[1]))
    return { sha, asunto, tipo, refs }
  })

/** El texto de la sección pedida: desde su encabezado `## X` hasta el siguiente `## ` del mismo nivel. */
function textoDeSeccion(md: string, titulo: string): string {
  const lineas = md.split('\n')
  const i = lineas.findIndex((l) => l.startsWith('## ') && l.slice(3).trim().startsWith(titulo))
  if (i < 0) throw new Error(`el CHANGELOG no tiene una sección «## ${titulo}»`)
  const j = lineas.findIndex((l, k) => k > i && l.startsWith('## '))
  return lineas.slice(i, j < 0 ? undefined : j).join('\n')
}

// `--changelog` existe para el retro-test: cotejar una sección contra el CHANGELOG **tal como estaba
// al taggear** (`git show v0.21.0:CHANGELOG.md > /tmp/x.md`) es la única forma de comprobar que este
// instrumento habría atrapado el defecto que dice cerrar, en vez de afirmarlo.
const changelog = arg('changelog') ?? 'CHANGELOG.md'
const texto = textoDeSeccion(readFileSync(changelog, 'utf8'), seccion)
const declaradas = new Set([...texto.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))

const exigibles = commits.filter((c) => !SIN_ENTRADA.has(c.tipo))
const enCodigo = new Set(exigibles.flatMap((c) => c.refs))

// La unidad de juicio es el COMMIT, no la referencia suelta: un asunto suele traer el issue Y el PR
// (`… (#248) (#249)`), y la sección nombra uno solo. Basta con que UNA de sus referencias esté
// declarada para que el cambio esté declarado — exigir todas convierte la numeración del PR en ruido
// y entrena a ignorar la salida, que es la forma en que un control se muere sin que nadie lo apague.
const sinDeclarar = exigibles.filter((c) => c.refs.length > 0 && !c.refs.some((r) => declaradas.has(r)))
const sinCodigo = [...declaradas].filter((r) => !enCodigo.has(r))
const mudos = exigibles.filter((c) => c.refs.length === 0)

console.log(`── Cotejo del corte · ${desde}..${hasta} contra «${seccion}» ──\n`)
console.log(`  commits en el rango: ${commits.length} (${exigibles.length} exigen entrada por su tipo)`)
console.log(`  referencias declaradas en la sección: ${declaradas.size}\n`)

if (sinDeclarar.length) {
  console.log('✗ EN EL CÓDIGO, NO EN LA SECCIÓN — la versión traería esto sin declararlo:')
  for (const c of sinDeclarar) console.log(`    ${c.sha}  ${c.asunto}`)
  console.log('')
}
if (sinCodigo.length) {
  console.log('⚠ EN LA SECCIÓN, NO EN EL CÓDIGO DEL RANGO — se declararía algo que este tag no trae,')
  console.log('  o la referencia entró por un commit anterior (comprobar antes de mover nada):')
  console.log(`    ${sinCodigo.map((r) => `#${r}`).join(' ')}\n`)
}
if (mudos.length) {
  console.log('· Commits sin ninguna referencia: este cotejo NO los ve. Míralos a mano:')
  for (const c of mudos) console.log(`    ${c.sha}  ${c.asunto}`)
  console.log('')
}
if (!sinDeclarar.length) console.log('✓ Ninguna referencia del código quedó fuera de la sección.')
console.log('\n  Esto NO dice que la sección esté completa: coteja por número, y un cambio que nadie')
console.log('  referenció le es invisible. Es insumo para el cotejo a mano, no un veredicto.')

process.exit(sinDeclarar.length ? 1 : 0)
