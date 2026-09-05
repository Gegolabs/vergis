/**
 * El formato de una guía de Daftar (`estudios/guia-json-daftar.md`), tal cual: H3 NO lo cambia. Los
 * tipos son DELIBERADAMENTE laxos (`unknown` en las respuestas, opcionales en todo) porque el
 * instrumento es contenido de instancia y el nodo no lo valida — lo sirve y lo renderiza como está.
 */

export interface EstudianteInfo {
  name: string
  grade: string
}

export interface Ejercicio {
  text?: string
  options?: string[]
  answer?: unknown
  answers?: Record<string, string>
  left?: string
  right?: string
  [k: string]: unknown
}

export interface Seccion {
  id?: string
  title?: string
  type?: string
  instructions?: string
  categories?: string[]
  exercises?: Ejercicio[]
  [k: string]: unknown
}

export interface Guia {
  title?: string
  subtitle?: string
  subject?: string
  group?: string
  sprint?: string
  sprintOrder?: number
  variant?: string
  mode?: string
  new?: boolean
  code?: string
  institution?: string
  department?: string
  student?: string
  invalidated?: boolean
  confidence?: boolean
  sections?: Seccion[]
  [k: string]: unknown
}

export interface RevisionSeccion {
  score?: string
  form?: string
  comments?: unknown[]
  [k: string]: unknown
}

export interface ProgresoSeccion {
  answers?: unknown[]
  checked?: boolean
  score?: { correct?: number; total?: number }
  review?: RevisionSeccion | null
  [k: string]: unknown
}

export interface Progreso {
  guideId?: string
  sections?: Record<string, ProgresoSeccion>
  totalSections?: number
  locked?: boolean
  _startedAt?: string | null
  _finishedAt?: string | null
  [k: string]: unknown
}

/** `choice_of`: acepta el formato viejo (índice pelado) y el nuevo `{choice, conf}`. */
export function choiceOf(sa: unknown): unknown {
  if (sa && typeof sa === 'object' && !Array.isArray(sa)) return (sa as Record<string, unknown>)['choice']
  return sa
}

/** `conf_of`: letra S/C/A, o `undefined` si la guía no pide confianza. */
export function confOf(sa: unknown): string | undefined {
  if (sa && typeof sa === 'object' && !Array.isArray(sa)) {
    const c = (sa as Record<string, unknown>)['conf']
    return c === null || c === undefined ? undefined : String(c)
  }
  return undefined
}

export const CONF_TITLES: Record<string, string> = { S: 'Seguro', C: 'Me costó', A: 'Adiviné' }

/** El `re.findall` del tokenizador de `highlight`, con el mismo patrón e `IGNORECASE`. */
export function tokenizar(text: string): string[] {
  return text.match(/[a-záéíóúñü]+|[^a-záéíóúñü\s]+|\s+/gi) ?? []
}

/** `re.match(r'[a-záéíóúñü]+', tok, re.IGNORECASE)` — ancla al INICIO, como `re.match`. */
export function esPalabra(tok: string): boolean {
  return /^[a-záéíóúñü]+/i.test(tok)
}
