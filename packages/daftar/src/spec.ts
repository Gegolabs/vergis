/**
 * La spec del Let Daftar (`daftar.yaml`) — su discriminador es `daftar_version`.
 *
 * Es DELIBERADAMENTE mínima: identidad del Let y el padrón de estudiantes (lo que en `server.py` era
 * la constante `STUDENT_INFO`). Los instrumentos NO viven acá: son archivos de
 * `VERGIS_INSTRUMENTOS_DIR`, releídos en caliente (D-75). La spec dice quién es el Let; el directorio
 * dice qué se puede rendir hoy.
 */
import YAML from 'yaml'

export interface EstudianteSpec {
  name: string
  grade: string
}

export interface DaftarSpec {
  daftar_version: string
  identity: { code: string; display_name?: string }
  estudiantes: Record<string, EstudianteSpec>
}

const CLAVE = /^[a-z0-9][a-z0-9_-]*$/

/**
 * Parsea y VALIDA. Validador a mano (no `ajv`) porque son cuatro reglas y el mensaje de error tiene
 * que decir qué falta: el operador que escribe este YAML es el que monta la instancia, no un
 * desarrollador. `schema/daftar-spec.schema.json` publica el mismo contrato para editores y CI.
 */
export function parseDaftarSpec(text: string): DaftarSpec {
  const doc: unknown = YAML.parse(text)
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('la spec de Daftar no es un objeto YAML')
  const raw = doc as Record<string, unknown>
  if (raw['daftar_version'] === undefined) throw new Error('falta `daftar_version` (es el discriminador de la familia)')
  const identity = raw['identity']
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) throw new Error('falta el bloque `identity`')
  const code = (identity as Record<string, unknown>)['code']
  if (typeof code !== 'string' || !CLAVE.test(code)) {
    throw new Error(`\`identity.code\` debe ser una clave en minúsculas ([a-z0-9][a-z0-9_-]*); llegó ${JSON.stringify(code)}`)
  }
  const displayName = (identity as Record<string, unknown>)['display_name']
  if (displayName !== undefined && typeof displayName !== 'string') throw new Error('`identity.display_name` debe ser texto')
  const est = raw['estudiantes']
  if (typeof est !== 'object' || est === null || Array.isArray(est)) throw new Error('falta el bloque `estudiantes` (clave → { name, grade })')
  const estudiantes: Record<string, EstudianteSpec> = {}
  for (const [k, v] of Object.entries(est as Record<string, unknown>)) {
    if (!CLAVE.test(k)) throw new Error(`clave de estudiante inválida: '${k}' (minúsculas, sin espacios)`)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`el estudiante '${k}' debe ser un objeto { name, grade }`)
    const o = v as Record<string, unknown>
    if (typeof o['name'] !== 'string' || !o['name']) throw new Error(`el estudiante '${k}' no declara \`name\``)
    if (o['grade'] !== undefined && typeof o['grade'] !== 'string') throw new Error(`\`grade\` del estudiante '${k}' debe ser texto`)
    estudiantes[k] = { name: o['name'], grade: (o['grade'] as string) ?? '' }
  }
  if (Object.keys(estudiantes).length === 0) throw new Error('`estudiantes` está vacío — un evaluador sin padrón no sirve a nadie')
  return {
    daftar_version: String(raw['daftar_version']),
    identity: { code, ...(typeof displayName === 'string' ? { display_name: displayName } : {}) },
    estudiantes,
  }
}
