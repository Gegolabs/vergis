/**
 * Guías de carga (issue #346) — qué se le explica al usuario cuando un archivo no entra — lógica PURA.
 *
 * El reparto, que es la decisión entera de este módulo:
 *
 *   · El JOB declara **qué pasó**: un código estable `familia` o `familia/especifico` y los datos del
 *     caso, en el sufijo `⟦…⟧` de su línea de desenlace (`run-logs.ts`, contrato `_logs/` §2).
 *   · La INSTANCIA declara **cómo se le explica**: un catálogo de guías en el bloque raíz `guias:` del
 *     mismo YAML de intake (hereda su recarga en caliente con validate-before-swap, sin env nueva).
 *   · El PRODUCTO **junta las dos cosas al mostrar** (`resolverGuia`) y trae la semilla: 13 familias,
 *     cada una con su ACTOR y una guía genérica.
 *
 * **El actor vive en la familia, no en la guía.** El error más caro que esto cierra no es la jerga:
 * es que una falla del proceso se presente igual que un archivo mal armado, y el usuario reintente algo
 * que no puede arreglar. Una guía puede redactar mejor; no puede cambiar de quién es el problema — el
 * actor es el único dato que debe ser verdadero aunque el texto esté mal redactado. Por eso una
 * entrada de guía con clave `actor:` es error de validación, y una familia del Producto no admite que
 * la instancia la redeclare.
 *
 * **Familias abiertas.** Las 13 del Producto son semilla, no lista cerrada: la instancia puede declarar
 * familias propias en `guias.familias`, con su actor OBLIGATORIO. Un guard nuevo cuya falla no calce en
 * las 13 no tiene que esperar un release del Producto para tener actor y guía.
 *
 * **Se resuelve al mostrar, nunca se persiste la redacción.** El registro de cargas guarda el código y
 * los datos (el hecho); la guía se resuelve al renderizar. Corregir una guía mejora de inmediato las
 * cargas pasadas.
 *
 * **Lo que este módulo NO hace:** reconocer el texto técnico con expresiones regulares para asignarle
 * una guía. Una guía mal asignada fabrica una causa — peor que el texto técnico. Sin código, no hay guía.
 */
import { requireRootKey } from './config-root'
import { parseIntakeConfig, type IntakeSlot } from './intake'
import { DESENLACE_CODIGO_RE } from './run-logs'

/** Quién tiene que actuar ante un desenlace de la familia. */
export type GuiaActor = 'usuario' | 'operador' | 'nadie'
export const GUIA_ACTORES: readonly GuiaActor[] = ['usuario', 'operador', 'nadie']

/** Datos del caso de un desenlace con código: escalar, o lista si el job la declaró así. */
export type GuiaParams = Record<string, string | string[]>

/** El texto de una guía, SIN interpolar (con marcadores `{clave}`). */
export interface GuiaTexto {
  titulo: string
  quePaso: string
  queHacer: string[]
}

/** Una familia de desenlace con su actor y su guía genérica. */
export interface FamiliaDesenlace {
  familia: string
  actor: GuiaActor
  guia: GuiaTexto
  origen: 'producto' | 'instancia'
}

/**
 * Una declaración del catálogo de la instancia, ya validada. Lista PLANA (familias y entradas en el
 * orden declarado) para que el catálogo viva en la misma forma de lista viva que los slots
 * (`reloadLiveList` intercambia listas): así la recarga en caliente no necesita un mecanismo nuevo.
 */
export type GuiaDecl =
  | { tipo: 'familia'; familia: string; actor: GuiaActor; guia: GuiaTexto }
  | { tipo: 'entrada'; codigo: string; slots?: string[]; guia: GuiaTexto }

/** Qué nivel de la precedencia resolvió la guía (de más específico a más genérico). */
export type GuiaNivel = 'entrada-slot' | 'entrada' | 'familia-slot' | 'familia-entrada' | 'familia-generica'

/** La guía ya resuelta e interpolada para UN desenlace. */
export interface GuiaResuelta {
  codigo: string
  familia: string
  /** Siempre el de la FAMILIA, nunca el de la entrada. */
  actor: GuiaActor
  nivel: GuiaNivel
  /** Identidad de la DECLARACIÓN que resolvió (`entrada:<codigo>@<slots|*>` o
   *  `familia:<origen>:<familia>`): dos códigos que caen en la misma guía comparten clave — es lo que
   *  suma frecuencias en «Errores frecuentes». */
  clave: string
  /** ¿La redactó la instancia? `false` = cayó a la guía genérica de una familia del Producto — es lo
   *  que la señal de cobertura del operador cuenta como «con código, sin guía de instancia». */
  deInstancia: boolean
  titulo: string
  quePaso: string
  queHacer: string[]
}

/** La línea de actor que la plataforma antepone a toda guía (celda de Cargas y correo). */
export const LINEA_ACTOR: Record<GuiaActor, string> = {
  usuario: 'Hay que corregir el archivo',
  operador: 'No es por tu archivo: el equipo ya fue avisado',
  nadie: 'No tienes que hacer nada',
}

/** Texto que reemplaza a un marcador `{clave}` cuyo dato el job no informó: la vista no se rompe. */
export const DATO_NO_INFORMADO = '(dato no informado)'

const f = (familia: string, actor: GuiaActor, titulo: string, quePaso: string, queHacer: string[]): FamiliaDesenlace => ({
  familia,
  actor,
  guia: { titulo, quePaso, queHacer },
  origen: 'producto',
})

/**
 * Las 13 familias del Producto, derivadas de los guards reales de los jobs de la primera instancia y
 * redactadas SIN vocabulario de ninguna instancia (el Producto no se ajusta a su beta tester: «maestro
 * de tiendas» es de la instancia, «el archivo tiene que venir completo» es genérico).
 *
 * `volumen-anomalo` es `usuario` porque el primer paso es suyo (revisar que el archivo sea el correcto);
 * si la baja es real, quien decide forzar la carga es el operador — y así lo dice la guía. No es
 * «siempre es culpa del archivo».
 */
export const FAMILIAS_PRODUCTO: readonly FamiliaDesenlace[] = [
  f('formato', 'usuario', 'El archivo no tiene la forma que se espera',
    'Las columnas, los encabezados o las hojas del archivo no calzan con lo que espera esta carga. Para no cargar datos corridos, no se cargó nada.',
    ['Revisa que sea el tipo de archivo correcto para esta carga.', 'Descárgalo de nuevo desde su sistema de origen, sin agregar, borrar ni mover columnas u hojas.', 'Súbelo de nuevo.']),
  f('archivo-vacio', 'usuario', 'El archivo no trae datos',
    'El archivo no tiene filas con datos que se puedan cargar.',
    ['Revisa que el archivo tenga datos y que sea la versión correcta.', 'Súbelo de nuevo.']),
  f('lectura-incompleta', 'usuario', 'El archivo no se pudo leer completo',
    'Una parte del archivo no se pudo leer, y cargar solo una parte daría números incompletos, así que no se cargó.',
    ['Ábrelo y guárdalo de nuevo en su formato original.', 'Revisa que no esté protegido ni dañado.', 'Súbelo de nuevo.']),
  f('duplicado', 'usuario', 'Hay datos repetidos donde cada uno debe ser único',
    'El archivo trae más de una fila para algo que debe aparecer una sola vez, y así no se puede saber cuál vale.',
    ['Busca las filas repetidas en el archivo.', 'Deja una sola fila por cada una.', 'Súbelo de nuevo.']),
  f('valor-invalido', 'usuario', 'Hay valores que no se pueden leer',
    'Algunas celdas traen un valor que no corresponde: una fecha, un número o un código mal escrito.',
    ['Revisa las celdas que indica el detalle técnico.', 'Corrige el valor en el archivo.', 'Súbelo de nuevo.']),
  f('referencia-ausente', 'usuario', 'El archivo nombra datos que todavía no están registrados',
    'El archivo hace referencia a elementos que la plataforma todavía no conoce, así que no se cargó.',
    ['Revisa en el detalle técnico cuáles faltan.', 'Carga primero el archivo que los registra.', 'Vuelve a subir este archivo.']),
  f('catalogo-incompleto', 'usuario', 'El archivo tiene que venir completo',
    'Este archivo reemplaza una lista completa, y el que subiste dejaría fuera elementos que ya se están usando, así que no se aplicó.',
    ['Parte de la versión completa vigente, no de una planilla nueva.', 'Agrega o corrige lo que necesites sin borrar lo que ya existe.', 'Súbelo completo.']),
  f('conflicto-declaracion', 'usuario', 'El contenido no calza con lo que se declaró',
    'Lo que trae el archivo contradice su nombre, su carpeta o los datos que indicaste al subirlo. No se adivina cuál es el correcto, así que no se cargó.',
    ['Revisa que el nombre y los datos que indicaste al subir correspondan al contenido.', 'Corrige el nombre, o busca el archivo correcto.', 'Súbelo de nuevo.']),
  f('descuadre', 'usuario', 'Dos archivos que deben cuadrar no cuadran',
    'Los totales de este archivo no calzan con los de otro archivo relacionado, y cargar números que no cuadran sería peor, así que no se cargó.',
    ['Revisa que los dos archivos sean del mismo período y de la misma versión.', 'Si uno de los dos cambió, súbelo primero y después este.']),
  f('volumen-anomalo', 'usuario', 'El archivo trae muchos menos datos que lo ya cargado',
    'Comparado con lo que ya está cargado, este archivo trae bastante menos. Eso suele pasar con una versión antigua o incompleta, así que no se aplicó.',
    ['Revisa que sea la versión correcta y que esté completa.', 'Si subiste una versión antigua, sube la correcta.', 'Si la baja es real, avísale al equipo: ellos pueden autorizar la carga.']),
  f('en-espera', 'nadie', 'El archivo está esperando a otro',
    'Para procesar este archivo hace falta otro que todavía no llega. Quedó en espera y no se perdió.',
    ['No tienes que hacer nada con este archivo: se procesará solo cuando llegue el otro.']),
  f('desplazado', 'nadie', 'Un archivo más reciente lo reemplazó',
    'Llegó otro archivo más reciente del mismo tipo, y rige el más nuevo. Este no se usó.',
    ['No tienes que hacer nada. Si querías que rigiera este, súbelo de nuevo.']),
  f('falla-plataforma', 'operador', 'No es por tu archivo: falló el proceso de carga',
    'El proceso que carga los archivos tuvo un problema propio y se detuvo. Tu archivo no tiene la culpa.',
    ['No lo corrijas ni lo vuelvas a subir.', 'El equipo ya fue avisado y te contará cuando esté resuelto.']),
]

const FAMILIAS_PRODUCTO_POR_NOMBRE = new Map(FAMILIAS_PRODUCTO.map((x) => [x.familia, x]))
const FAMILIA_RE = /^[a-z][a-z0-9-]*$/

/** La familia de un código (`catalogo-incompleto/maestro-tiendas` ⇒ `catalogo-incompleto`). */
export const familiaDeCodigo = (codigo: string): string => codigo.split('/')[0] ?? codigo

/**
 * La familia que rige un código: la de la instancia si la declaró, si no la del Producto. `null` = el
 * código es inválido o su familia no existe en ninguno de los dos — se trata como «sin código».
 */
export function familiaDe(codigo: string | undefined | null, catalogo: readonly GuiaDecl[]): FamiliaDesenlace | null {
  if (!codigo || !DESENLACE_CODIGO_RE.test(codigo)) return null
  const nombre = familiaDeCodigo(codigo)
  for (const d of catalogo) if (d.tipo === 'familia' && d.familia === nombre) return { familia: d.familia, actor: d.actor, guia: d.guia, origen: 'instancia' }
  return FAMILIAS_PRODUCTO_POR_NOMBRE.get(nombre) ?? null
}

// ─── Parse y validación del bloque `guias:` ─────────────────────────────────────────────────────────

const CLAVES_GUIAS = new Set(['familias', 'entradas'])
const CLAVES_FAMILIA = new Set(['familia', 'actor', 'titulo', 'que_paso', 'que_hacer'])
const CLAVES_ENTRADA = new Set(['codigo', 'slots', 'titulo', 'que_paso', 'que_hacer'])

function textoNoVacio(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${where} debe ser un texto no vacío.`)
  return v.trim()
}

function parseTexto(o: Record<string, unknown>, where: string): GuiaTexto {
  const titulo = textoNoVacio(o['titulo'], `${where}.titulo`)
  const quePaso = textoNoVacio(o['que_paso'], `${where}.que_paso`)
  const qh = o['que_hacer']
  if (!Array.isArray(qh) || qh.length === 0) throw new Error(`${where}.que_hacer debe ser una lista con al menos un paso.`)
  const queHacer = qh.map((p, i) => textoNoVacio(p, `${where}.que_hacer[${i}]`))
  return { titulo, quePaso, queHacer }
}

function mapa(v: unknown, where: string): Record<string, unknown> {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where} debe ser un mapa.`)
  return v as Record<string, unknown>
}

/**
 * Valida el bloque raíz `guias:` del YAML de intake contra los slots YA parseados de ese mismo
 * documento. Ausente = catálogo vacío (legítimo: toda falla con código cae a la guía genérica de su
 * familia). Fail-closed y estricto —el bloque nace sin deuda—: una clave desconocida, una familia que
 * repite una del Producto, una entrada con `actor:`, un código de familia desconocida, un slot
 * inexistente o un `que_hacer` vacío **lanzan**, nombrando la guía. Ese `throw` es la invariante: el
 * chequeo de arranque lo acusa y la recarga en caliente conserva las guías vigentes.
 */
export function parseIntakeGuias(doc: unknown, slots: readonly IntakeSlot[]): GuiaDecl[] {
  const raw = doc != null && typeof doc === 'object' ? (doc as Record<string, unknown>)['guias'] : undefined
  if (raw === undefined) return []
  const g = mapa(raw, 'intake: `guias`')
  for (const k of Object.keys(g)) if (!CLAVES_GUIAS.has(k)) throw new Error(`intake: \`guias\` con clave desconocida '${k}' (esperadas: familias, entradas).`)
  const out: GuiaDecl[] = []

  const propias = new Map<string, GuiaActor>()
  const famRaw = g['familias']
  if (famRaw != null) {
    if (!Array.isArray(famRaw)) throw new Error('intake: `guias.familias` debe ser una lista.')
    famRaw.forEach((x, i) => {
      const o = mapa(x, `intake: guias.familias #${i}`)
      const familia = String(o['familia'] ?? '')
      const where = `intake: familia de guía '${familia || `#${i}`}'`
      if (!FAMILIA_RE.test(familia)) throw new Error(`${where}: 'familia' inválida (esperado [a-z][a-z0-9-]*).`)
      for (const k of Object.keys(o)) if (!CLAVES_FAMILIA.has(k)) throw new Error(`${where}: clave desconocida '${k}'.`)
      if (FAMILIAS_PRODUCTO_POR_NOMBRE.has(familia))
        throw new Error(`${where}: ya es una familia del Producto — su actor es fijo y no se redeclara (para redactar su guía, usa una entrada con codigo: ${familia}).`)
      if (propias.has(familia)) throw new Error(`${where}: familia duplicada.`)
      const actor = o['actor']
      if (!GUIA_ACTORES.includes(actor as GuiaActor)) throw new Error(`${where}: 'actor' es obligatorio y debe ser usuario | operador | nadie.`)
      propias.set(familia, actor as GuiaActor)
      out.push({ tipo: 'familia', familia, actor: actor as GuiaActor, guia: parseTexto(o, where) })
    })
  }

  const slotIds = new Set(slots.map((s) => s.id))
  const alcances = new Map<string, Set<string>>() // codigo → slots ya cubiertos ('*' = sin slots)
  const entRaw = g['entradas']
  if (entRaw != null) {
    if (!Array.isArray(entRaw)) throw new Error('intake: `guias.entradas` debe ser una lista.')
    entRaw.forEach((x, i) => {
      const o = mapa(x, `intake: guias.entradas #${i}`)
      const codigo = String(o['codigo'] ?? '')
      const where = `intake: guía '${codigo || `#${i}`}'`
      if ('actor' in o) throw new Error(`${where}: no admite 'actor' — el actor lo fija la familia '${familiaDeCodigo(codigo)}', y una guía no puede cambiar de quién es el problema.`)
      for (const k of Object.keys(o)) if (!CLAVES_ENTRADA.has(k)) throw new Error(`${where}: clave desconocida '${k}'.`)
      if (!DESENLACE_CODIGO_RE.test(codigo)) throw new Error(`${where}: 'codigo' inválido (esperado familia o familia/especifico, en minúsculas).`)
      const fam = familiaDeCodigo(codigo)
      if (!FAMILIAS_PRODUCTO_POR_NOMBRE.has(fam) && !propias.has(fam))
        throw new Error(`${where}: la familia '${fam}' no es del Producto ni está declarada en guias.familias.`)
      let entSlots: string[] | undefined
      if (o['slots'] !== undefined) {
        const s = o['slots']
        if (!Array.isArray(s) || s.length === 0) throw new Error(`${where}: 'slots' debe ser una lista no vacía (sin 'slots', la guía aplica a todos).`)
        entSlots = s.map((x2) => String(x2))
        for (const id of entSlots) if (!slotIds.has(id)) throw new Error(`${where}: el slot '${id}' no existe.`)
      }
      // Ambigüedad = dos entradas del mismo código que compiten por el mismo slot: la precedencia no
      // podría elegir. Una con slots y otra sin ellos NO compiten (la de slots es más específica).
      const cubiertos = alcances.get(codigo) ?? new Set<string>()
      for (const id of entSlots ?? ['*']) {
        if (cubiertos.has(id)) throw new Error(`${where}: duplicada para ${id === '*' ? 'todos los slots' : `el slot '${id}'`}.`)
        cubiertos.add(id)
      }
      alcances.set(codigo, cubiertos)
      const decl: GuiaDecl = { tipo: 'entrada', codigo, guia: parseTexto(o, where) }
      if (entSlots) decl.slots = entSlots
      out.push(decl)
    })
  }
  return out
}

/**
 * El catálogo de guías desde el documento de intake COMPLETO: parsea los slots (mismo parser que la
 * lista viva de slots, así un archivo de slots roto rompe también las guías — y las dos conservan lo
 * vigente) y valida `guias:` contra ellos. Es la forma que consumen el arranque y la recarga.
 */
export function parseIntakeGuiasConfig(doc: unknown): GuiaDecl[] {
  requireRootKey(doc, 'intake', 'slots')
  return parseIntakeGuias(doc, parseIntakeConfig(doc))
}

// ─── Resolución e interpolación ─────────────────────────────────────────────────────────────────────

/**
 * Una lista para personas: «58», «58 y 88», «58, 88 y 95», «58, 88, 95 y 12» y, pasado ese largo,
 * «58, 88, 95 y 7 más». Hasta 4 elementos se nombran todos; con 5 o más, los 3 primeros y cuántos
 * faltan — el detalle completo está en el motivo técnico, plegado debajo.
 */
export function formatoLista(xs: readonly string[]): string {
  const v = xs.map((x) => String(x).trim()).filter(Boolean)
  if (v.length === 0) return ''
  if (v.length === 1) return v[0]!
  if (v.length <= 4) return `${v.slice(0, -1).join(', ')} y ${v[v.length - 1]}`
  return `${v.slice(0, 3).join(', ')} y ${v.length - 3} más`
}

/** Reemplaza `{clave}` por su dato; un marcador sin dato queda como «(dato no informado)». Solo se
 *  tocan marcadores con la gramática de clave (`{[a-z][a-z0-9_]*}`): cualquier otra llave es texto. */
export function interpolarGuia(texto: string, datos: Record<string, string | string[] | undefined>, sinDato: string = DATO_NO_INFORMADO): string {
  return texto.replace(/\{([a-z][a-z0-9_]*)\}/g, (_m, k: string) => {
    const v = datos[k]
    if (v === undefined) return sinDato
    const s = Array.isArray(v) ? formatoLista(v) : String(v)
    return s.trim() ? s : sinDato
  })
}

/**
 * La guía de UN desenlace, con precedencia de lo específico a lo genérico:
 *
 *   1. entrada con el código exacto cuyo `slots` incluye el slot
 *   2. entrada con el código exacto, sin `slots`
 *   3. entrada con el código de la FAMILIA sola (p. ej. `formato`) cuyo `slots` incluye el slot
 *   4. entrada con el código de la familia sola, sin `slots`
 *   5. guía genérica de la familia (la de `guias.familias` o la del Producto)
 *   6. sin guía (`null`): sin código, código inválido o familia desconocida
 *
 * El ACTOR sale siempre de la familia. `{archivo}` y `{slot}` los pone la plataforma; el resto sale de
 * los datos del caso, y un dato de la plataforma no lo puede pisar el job.
 */
export function resolverGuia(
  slot: { id: string; label?: string },
  codigo: string | undefined | null,
  params: GuiaParams | undefined | null,
  catalogo: readonly GuiaDecl[],
  archivo?: string,
  /** Texto para un marcador sin dato. Default «(dato no informado)»; la página «Errores frecuentes»,
   *  que muestra guías sin un caso concreto, pasa «…». */
  sinDato: string = DATO_NO_INFORMADO,
): GuiaResuelta | null {
  const fam = familiaDe(codigo, catalogo)
  if (!fam || !codigo) return null
  const entradas = catalogo.filter((d): d is Extract<GuiaDecl, { tipo: 'entrada' }> => d.tipo === 'entrada')
  const buscar = (c: string, conSlot: boolean) =>
    entradas.find((e) => e.codigo === c && (conSlot ? !!e.slots?.includes(slot.id) : !e.slots))
  let texto: GuiaTexto = fam.guia
  let nivel: GuiaNivel = 'familia-generica'
  let clave = `familia:${fam.origen}:${fam.familia}`
  const candidatos: [string, boolean, GuiaNivel][] = [
    [codigo, true, 'entrada-slot'],
    [codigo, false, 'entrada'],
    [fam.familia, true, 'familia-slot'],
    [fam.familia, false, 'familia-entrada'],
  ]
  for (const [c, conSlot, n] of candidatos) {
    const e = buscar(c, conSlot)
    if (e) {
      texto = e.guia
      nivel = n
      clave = `entrada:${e.codigo}@${e.slots?.join(',') ?? '*'}`
      break
    }
  }
  const datos: Record<string, string | string[] | undefined> = { ...(params ?? {}), slot: slot.label ?? slot.id }
  if (archivo !== undefined) datos['archivo'] = archivo
  else delete datos['archivo']
  return {
    codigo,
    familia: fam.familia,
    actor: fam.actor,
    nivel,
    clave,
    deInstancia: nivel !== 'familia-generica' || fam.origen === 'instancia',
    titulo: interpolarGuia(texto.titulo, datos, sinDato),
    quePaso: interpolarGuia(texto.quePaso, datos, sinDato),
    queHacer: texto.queHacer.map((p) => interpolarGuia(p, datos, sinDato)),
  }
}

/**
 * Las guías que APLICAN a un slot, para la página «Errores frecuentes»: toda entrada de la instancia
 * sin `slots` o con el slot en su lista, y las familias propias de la instancia. Sin interpolar datos
 * de ningún caso (no hay caso): los marcadores de datos quedan como «(dato no informado)» salvo
 * `{slot}`. Las genéricas del Producto no se listan acá — aparecen solo si su código ocurrió (lo decide
 * quien arma la página con el conteo).
 */
export function guiasDelSlot(slot: { id: string; label?: string }, catalogo: readonly GuiaDecl[]): string[] {
  // Un código por guía: dos entradas del mismo código (una del slot, otra general) resuelven a UNA
  // sola guía para este slot — la precedencia elige; la página no la lista dos veces.
  const out: string[] = []
  const add = (c: string): void => {
    if (!out.includes(c)) out.push(c)
  }
  for (const d of catalogo) {
    if (d.tipo === 'entrada' && (!d.slots || d.slots.includes(slot.id))) add(d.codigo)
    if (d.tipo === 'familia') add(d.familia)
  }
  return out
}
