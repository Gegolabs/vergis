/**
 * COTEJO DEL CATÁLOGO DE CAPACIDADES — ¿`docs/capacidades.md` nombra todo lo que la máquina declara?
 *
 * El defecto que cierra (#264): desde afuera del repo no hay lista que leer, así que una petición
 * que la plataforma ya satisface se abre igual como issue. El catálogo la contesta con un
 * identificador; pero un catálogo escrito a mano envejece en silencio, y un índice que envejece es
 * peor que ninguno — miente con la autoridad del repo.
 *
 * ── Lo que este instrumento SÍ hace ────────────────────────────────────────────────────────────
 *   1. **Numeración**: IDs `CAP-NN` con formato válido, sin duplicados, sin huecos hacia atrás. Un
 *      hueco es válido SOLO si ese ID aparece en la tabla de retiradas con estado `retirada` — la
 *      regla del catálogo es que un número jamás se reusa ni se recicla al borrar una fila.
 *   2. **Cobertura de lo declarado en máquina**: deriva del código y del schema los conjuntos
 *      CERRADOS de la superficie del DSL —tipos de pieza, tokens de formato, tokens de `sort`,
 *      claves de `interactions`, claves de `controls` y de `filters`, clasificaciones— y exige que
 *      CADA elemento esté citado, entre backticks, en alguna fila del catálogo.
 *
 * ── Lo que NO hace, y hay que decirlo ──────────────────────────────────────────────────────────
 * **No sabe si el catálogo está completo.** Lo único que deriva son los conjuntos cerrados de
 * arriba; el resto de la superficie —endpoints, gobierno, plano de control, frescura, ingesta,
 * Miranda— se barrió A MANO sobre `CHANGELOG.md`, `docs/` y el código, y puede tener omisiones.
 * Un verde de este script dice «lo que la máquina declara está citado», jamás «el catálogo está
 * completo».
 *
 * **Y sabe reportar su propio fallo.** Cada derivación está anclada a una construcción concreta del
 * código; si esa construcción se mueve o se renombra, el script **falla ruidoso** nombrando el
 * ancla que no encontró, en vez de derivar una lista vacía y aprobar por omisión — que es la forma
 * en que un control se muere sin que nadie lo apague.
 *
 * Uso:
 *   npm run capacidades:cotejo
 *
 * La misma función la invoca `tests/capacidades-catalogo.test.ts`, para que corra en CI sin tocar
 * `build.yml` — y con control negativo (fixtures que DEBEN reprobar).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** Raíz del repo, resuelta desde este archivo (el script no depende del cwd de quien lo invoca). */
export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Un conjunto cerrado derivado de la máquina: qué es, dónde se declara, y sus valores literales. */
export interface ConjuntoDerivado {
  /** Nombre legible del conjunto, como aparecerá en el reporte. */
  nombre: string
  /** Dónde se declara, para que el lector pueda ir a verificarlo. */
  origen: string
  /** Los valores literales que el catálogo debe citar. */
  valores: string[]
}

export interface Hallazgo {
  /** `numeracion` (IDs) o `cobertura` (algo declarado en máquina y no citado). */
  clase: 'numeracion' | 'cobertura'
  detalle: string
}

/** Error de ANCLA: la derivación no encontró la construcción que dice leer. No es un hallazgo del
 *  catálogo — es el instrumento diciendo que no pudo medir, que es distinto de medir y salir verde. */
export class AnclaPerdida extends Error {
  constructor(ancla: string, archivo: string) {
    super(`el cotejo no encontró su ancla «${ancla}» en ${archivo} — la derivación NO se pudo hacer`)
    this.name = 'AnclaPerdida'
  }
}

function leer(rel: string): string {
  return readFileSync(join(RAIZ, rel), 'utf8')
}

/** Extrae con un regex anclado, o falla ruidoso nombrando el ancla que no estaba. */
function extraer(texto: string, re: RegExp, ancla: string, archivo: string): string {
  const m = re.exec(texto)
  if (!m || m[1] === undefined) throw new AnclaPerdida(ancla, archivo)
  return m[1]
}

/** Los literales `'x'` de un fragmento de código, en orden y sin repetir. */
function literales(fragmento: string): string[] {
  const out = [...fragmento.matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
  return [...new Set(out)]
}

// ── Las derivaciones ─────────────────────────────────────────────────────────────────────────────
// Cada una nombra su ancla. Si el código se reorganiza, acá se rompe (ruidoso), no allá (en silencio).

/**
 * Deriva de la máquina los conjuntos cerrados de la superficie del DSL.
 *
 * Los tipos de pieza, los formatos y los tokens de `sort` NO viven en el schema JSON —el schema
 * declara `piece` como objeto opaco y la semántica la implementa el validador (divergencia conocida,
 * `work/001-…/04-mira-policy.md` §18)—, así que se derivan de las constantes del validador y del
 * formateador único. Lo que sí vive en el schema se lee del schema.
 */
export function derivarConjuntos(): ConjuntoDerivado[] {
  const validate = leer('packages/mira/src/dsl/validate.ts')
  const runtime = leer('packages/capabilities/src/table-runtime.ts')
  const schema = JSON.parse(leer('schema/mira-spec.schema.json')) as {
    properties: Record<string, { properties?: Record<string, unknown>; items?: { properties?: Record<string, unknown> } }>
  }

  const tipos = literales(
    extraer(validate, /const ELEMENT_TYPES = new Set\(\[([^\]]*)\]\)/, 'const ELEMENT_TYPES', 'validate.ts'),
  )

  // El formateador único: `vtFormat` es el que viaja al browser y el que usa el render server-side,
  // así que sus tokens SON los formatos del producto. Se acota al cuerpo de la función para no
  // barrer comparaciones de `format` de otras cosas.
  const cuerpoFormat = extraer(
    runtime,
    /export function vtFormat\(([\s\S]*?)\n\}/,
    'export function vtFormat',
    'table-runtime.ts',
  )
  const formatos = [...new Set([...cuerpoFormat.matchAll(/format === '([a-z0-9_]+)'/g)].map((m) => m[1] as string))]

  const sort = literales(
    extraer(
      validate,
      /const known = (raw === 'magnitude'[^\n]*)/,
      "const known = raw === 'magnitude'",
      'validate.ts',
    ),
  )

  // Claves del namespace client-side `interactions`, leídas de la interfaz del spec.
  const bloqueInteractions = extraer(
    validate,
    /\n {2}interactions\?: \{\n([\s\S]*?)\n {2}\}/,
    'interactions?: { … }',
    'validate.ts',
  )
  const interactions = [...bloqueInteractions.matchAll(/^ {4}(\w+)\??:/gm)].map((m) => m[1] as string)

  const propsDe = (bloque: string): string[] => {
    const p = schema.properties[bloque]
    const props = p?.items?.properties ?? p?.properties
    if (!props) throw new AnclaPerdida(`properties.${bloque}`, 'mira-spec.schema.json')
    return Object.keys(props)
  }

  const clasificacion = (
    (schema.properties['identity']?.properties?.['classification'] as { enum?: string[] } | undefined)?.enum ?? []
  ).slice()
  if (clasificacion.length === 0) throw new AnclaPerdida('identity.classification.enum', 'mira-spec.schema.json')

  return [
    { nombre: 'tipos de pieza del DSL', origen: 'packages/mira/src/dsl/validate.ts · ELEMENT_TYPES', valores: tipos },
    { nombre: 'tokens de formato', origen: 'packages/capabilities/src/table-runtime.ts · vtFormat', valores: formatos },
    { nombre: 'tokens de `sort` de un chart', origen: 'packages/mira/src/dsl/validate.ts · vocabulario cerrado de sort', valores: sort },
    { nombre: 'claves de `interactions`', origen: 'packages/mira/src/dsl/validate.ts · MiraSpec.interactions', valores: interactions },
    {
      // Cualificadas a propósito: exigir `id` a secas sería un requisito que cualquier texto cumple
      // por accidente. `controls[].id` solo aparece si alguien nombró esa clave de ese bloque.
      nombre: 'claves de un `control` de cabecera',
      origen: 'schema/mira-spec.schema.json · controls[]',
      valores: propsDe('controls').map((k) => `controls[].${k}`),
    },
    {
      nombre: 'claves de un `filter` de bandeja',
      origen: 'schema/mira-spec.schema.json · filters[]',
      valores: propsDe('filters').map((k) => `filters[].${k}`),
    },
    { nombre: 'clasificaciones de un PI', origen: 'schema/mira-spec.schema.json · identity.classification', valores: clasificacion },
  ]
}

// ── El catálogo ──────────────────────────────────────────────────────────────────────────────────

export interface Catalogo {
  /** IDs `CAP-NN` que aparecen como primera celda de una fila de tabla del catálogo vigente. */
  ids: number[]
  /** IDs declarados con estado `retirada` (su número se conserva; jamás se reusa). */
  retiradas: number[]
  /** Todo lo que viaja entre backticks en el cuerpo del catálogo — el vocabulario que cita. */
  citados: string[]
  /** IDs mal formados encontrados (p. ej. `CAP-7` en vez de `CAP-07`). */
  malFormados: string[]
}

/**
 * Parsea `docs/capacidades.md`. Una fila del catálogo es una fila de tabla Markdown cuya PRIMERA
 * celda es un ID; una fila cuya última celda dice `retirada` declara el retiro de ese número.
 */
export function parsearCatalogo(md: string): Catalogo {
  const ids: number[] = []
  const retiradas: number[] = []
  const malFormados: string[] = []
  for (const linea of md.split('\n')) {
    if (!linea.startsWith('|')) continue
    const celdas = linea.split('|').slice(1, -1).map((c) => c.trim())
    const primera = celdas[0]
    if (!primera) continue
    const m = /^`?(CAP-(\d+))`?$/.exec(primera)
    if (!m) continue
    // El formato es `CAP-NN`: dos dígitos como mínimo, para que el orden lexicográfico no mienta.
    if ((m[2] as string).length < 2) malFormados.push(m[1] as string)
    const n = Number(m[2])
    // El retiro se declara con una celda que dice EXACTAMENTE `retirada` (con o sin backticks). No
    // vale que la palabra aparezca dentro de una frase: `_retirado/` es una ruta del intake, no un
    // estado, y un reconocedor laxo convertiría esa fila en el permiso para un hueco.
    if (celdas.some((c) => c.replace(/`/g, '').trim().toLowerCase() === 'retirada')) retiradas.push(n)
    else ids.push(n)
  }
  const citados = [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string)
  return { ids, retiradas, citados, malFormados }
}

/**
 * ¿El catálogo cita este valor? Vale la cita exacta (`` `abbr` ``) y la cita dentro de una expresión
 * mayor delimitada por no-identificadores (`` `sort: value:<serie>` `` cita `value:`), que es como se
 * escriben de verdad. Lo que NO vale es el calce por substring a secas: `id` calzaría dentro de
 * `identity` y el control aprobaría por accidente.
 */
export function estaCitado(valor: string, citados: string[]): boolean {
  const esc = valor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|[^A-Za-z0-9_])${esc}($|[^A-Za-z0-9_])`)
  return citados.some((c) => c === valor || re.test(c))
}

/**
 * El cotejo, puro: catálogo (texto) × conjuntos derivados → hallazgos. Sin I/O, para que el test
 * pueda alimentarlo con fixtures y comprobar que SABE reprobar.
 */
export function cotejar(md: string, conjuntos: ConjuntoDerivado[]): Hallazgo[] {
  const cat = parsearCatalogo(md)
  const hallazgos: Hallazgo[] = []

  for (const mal of cat.malFormados) {
    hallazgos.push({ clase: 'numeracion', detalle: `ID mal formado: «${mal}» — el formato es CAP-NN (dos dígitos)` })
  }

  const vistos = new Set<number>()
  for (const n of [...cat.ids, ...cat.retiradas]) {
    if (vistos.has(n)) hallazgos.push({ clase: 'numeracion', detalle: `ID duplicado: CAP-${String(n).padStart(2, '0')}` })
    vistos.add(n)
  }

  if (vistos.size > 0) {
    const max = Math.max(...vistos)
    for (let n = 1; n <= max; n++) {
      if (vistos.has(n)) continue
      hallazgos.push({
        clase: 'numeracion',
        detalle: `hueco sin explicar: CAP-${String(n).padStart(2, '0')} no aparece ni como capacidad vigente ni como retirada (un número jamás se reusa: si la capacidad se retiró, su fila se conserva con estado «retirada»)`,
      })
    }
  }

  for (const conj of conjuntos) {
    const faltan = conj.valores.filter((v) => !estaCitado(v, cat.citados))
    for (const v of faltan) {
      hallazgos.push({
        clase: 'cobertura',
        detalle: `«${v}» (${conj.nombre}, declarado en ${conj.origen}) no está citado en ninguna fila del catálogo`,
      })
    }
  }

  return hallazgos
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

function main(): void {
  const conjuntos = derivarConjuntos()
  const md = leer('docs/capacidades.md')
  const cat = parsearCatalogo(md)
  const hallazgos = cotejar(md, conjuntos)

  console.log('── Cotejo del catálogo de capacidades · docs/capacidades.md ──\n')
  console.log(`  capacidades vigentes: ${cat.ids.length}   ·   retiradas: ${cat.retiradas.length}`)
  console.log('  conjuntos derivados de la máquina y exigidos al catálogo:')
  for (const c of conjuntos) console.log(`    · ${c.nombre} (${c.valores.length}) — ${c.origen}`)
  console.log('')

  const numeracion = hallazgos.filter((h) => h.clase === 'numeracion')
  const cobertura = hallazgos.filter((h) => h.clase === 'cobertura')

  if (numeracion.length) {
    console.log('✗ NUMERACIÓN:')
    for (const h of numeracion) console.log(`    ${h.detalle}`)
    console.log('')
  }
  if (cobertura.length) {
    console.log('✗ DECLARADO EN MÁQUINA Y NO CITADO EN EL CATÁLOGO:')
    for (const h of cobertura) console.log(`    ${h.detalle}`)
    console.log('')
  }
  if (!hallazgos.length) console.log('✓ Numeración sana y todo lo declarado en máquina está citado.\n')

  console.log('  Esto NO dice que el catálogo esté completo: lo derivado mecánicamente son solo los')
  console.log('  conjuntos cerrados del DSL de arriba. El resto se barrió a mano sobre CHANGELOG,')
  console.log('  docs/ y el código, y puede tener omisiones.')

  process.exit(hallazgos.length ? 1 : 0)
}

// Solo cuando se ejecuta como script (el test importa las funciones sin disparar el CLI).
if (process.argv[1] && process.argv[1].endsWith('capacidades-cotejo.ts')) main()
