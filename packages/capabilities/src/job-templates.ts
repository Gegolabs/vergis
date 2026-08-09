/**
 * PLANTILLAS DE JOB de la instancia — el manifiesto `VERGIS_JOB_TEMPLATES` y el render de sus partes
 * (issue #107 fase 2, D3 y D11 del diseño).
 *
 * Qué declara una plantilla: el tipo de item del motor, sus parámetros y las partes de definición
 * (archivos JSON junto al manifiesto, con placeholders). El código del convertidor NO vive aquí (D2):
 * la plantilla solo APUNTA a él. Las plantillas las versiona el repo de la instancia (flujo
 * repo→despliegue), no un editor in-app.
 *
 * Reparto con `server/instance-config.ts`: aquí se valida la FORMA del manifiesto y las reglas de
 * render; allá se leen del disco el manifiesto y sus partes (seam `ReadFile`) y se envuelve el error
 * con ENV + ruta. Este módulo no toca disco.
 *
 * La regla que sostiene la seguridad del render (D11): un placeholder es el VALOR COMPLETO de un
 * string dentro del JSON ya parseado, y la sustitución ocurre sobre la estructura parseada — jamás
 * por concatenación de texto. Un valor de parámetro con `"`, `}` o `{{otro}}` adentro no puede
 * romper la definición ni inyectar claves: entra como string y sale como string.
 */

import { requireRootKey } from './config-root'
import { canonicalDefinitionSha256 } from './definition-canonical'

/** Mismo criterio de slug que el resto de la config declarativa (`governance-config.ts`). */
const SLUG_RE = /^[a-z][a-z0-9_-]*$/
/** Nombre de parámetro: es también el nombre dentro de `{{...}}`, por eso sin guiones ni espacios. */
const PARAM_RE = /^[a-z][a-z0-9_]*$/
/** Cualquier cosa con forma de placeholder, para detectar los mal puestos (embebidos, con espacios). */
const PLACEHOLDER_SCAN = /\{\{[^{}]*\}\}/g
/** El mismo patrón sin `g`: `.test()` sobre un regex global arrastra `lastIndex` entre llamadas. */
const PLACEHOLDER_ANY = /\{\{[^{}]*\}\}/

export interface JobTemplateParam {
  name: string
  label: string
  /** Sin valor, un parámetro `required` rompe el render; uno opcional se sustituye por cadena vacía. */
  required: boolean
}

/** Una parte de la definición: su `path` en el motor y el archivo que la contiene, relativo al manifiesto. */
export interface JobTemplatePart {
  path: string
  file: string
}

export interface JobTemplate {
  id: string
  label: string
  /** La versiona el repo de la instancia; Vergis solo la registra en cada publicación (D3). */
  version: string
  /** Tipo de item del motor (p. ej. `SparkJobDefinition`). */
  itemType: string
  params: JobTemplateParam[]
  parts: JobTemplatePart[]
}

export interface JobTemplatesConfig {
  templates: JobTemplate[]
}

/** Una part ya renderizada, lista para el cliente de autoría. */
export interface RenderedPart {
  path: string
  payloadBase64: string
}

export interface RenderedDefinition {
  parts: RenderedPart[]
  /** El sha CANÓNICO (Δ1): la misma identidad que usan el ledger y el read-back. */
  sha256: string
}

function obj(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>
}

function reqString(o: Record<string, unknown>, field: string, where: string): string {
  const v = o[field]
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${where}: '${field}' debe ser un string no vacío.`)
  return v
}

function asList(raw: unknown, where: string, key: string): unknown[] {
  if (!Array.isArray(raw)) throw new Error(`${where}: \`${key}\` debe ser una lista.`)
  return raw
}

/**
 * Valida `job-templates.yaml` (`VERGIS_JOB_TEMPLATES`). Mismo contrato de tres estados que el resto
 * de la config de instancia: clave raíz `templates` ausente → error; `templates: []` → cero
 * plantillas, legítimo y visible en el conteo del arranque.
 */
export function parseJobTemplatesConfig(doc: unknown): JobTemplatesConfig {
  const raw = asList(requireRootKey(doc, 'job-templates', 'templates'), 'job-templates', 'templates')
  const seen = new Set<string>()
  const templates = raw.map((t, i) => {
    const o = obj(t)
    const where = `job-templates: plantilla #${i}`
    const id = reqString(o, 'id', where)
    if (!SLUG_RE.test(id)) throw new Error(`${where}: id inválido '${id}' (esperado [a-z][a-z0-9_-]*).`)
    if (seen.has(id)) throw new Error(`job-templates: id de plantilla duplicado '${id}'.`)
    seen.add(id)
    const donde = `job-templates: plantilla '${id}'`
    // `version` va como STRING a propósito: un `version: 1.0` sin comillas es el número 1 en YAML y
    // «1.0» y «1.10» colapsarían al mismo valor. El error lo dice para que se arregle en el archivo.
    const version = o['version']
    if (typeof version !== 'string' || version.trim() === '') {
      throw new Error(`${donde}: 'version' debe ser un string no vacío (entre comillas: version: "1.0").`)
    }

    const params = asList(o['params'] ?? [], donde, 'params').map((p, j) => {
      const po = obj(p)
      const dondeParam = `${donde}: params #${j}`
      const name = reqString(po, 'name', dondeParam)
      if (!PARAM_RE.test(name)) throw new Error(`${dondeParam}: nombre de parámetro inválido '${name}' (esperado [a-z][a-z0-9_]*).`)
      const label = po['label']
      if (label != null && typeof label !== 'string') throw new Error(`${dondeParam}: 'label' debe ser un string.`)
      const required = po['required']
      if (required != null && typeof required !== 'boolean') throw new Error(`${dondeParam}: 'required' debe ser booleano.`)
      return { name, label: (label as string | undefined) ?? name, required: (required as boolean | undefined) ?? true }
    })
    const nombresParam = new Set<string>()
    for (const p of params) {
      if (nombresParam.has(p.name)) throw new Error(`${donde}: parámetro duplicado '${p.name}'.`)
      nombresParam.add(p.name)
    }

    const parts = asList(o['parts'], donde, 'parts').map((p, j) => {
      const po = obj(p)
      const dondePart = `${donde}: parts #${j}`
      return { path: reqString(po, 'path', dondePart), file: reqString(po, 'file', dondePart) }
    })
    if (parts.length === 0) throw new Error(`${donde}: 'parts' no puede estar vacío (una definición sin partes no es publicable).`)
    const paths = new Set<string>()
    for (const p of parts) {
      if (paths.has(p.path)) throw new Error(`${donde}: part duplicada '${p.path}'.`)
      paths.add(p.path)
    }

    return { id, label: reqString(o, 'label', donde), version, itemType: reqString(o, 'itemType', donde), params, parts }
  })
  return { templates }
}

/** Recorre un valor parseado juntando los placeholders bien puestos; lanza ante los mal puestos. */
function collectPlaceholders(value: unknown, where: string, out: Set<string>): void {
  if (typeof value === 'string') {
    const hits = value.match(PLACEHOLDER_SCAN)
    if (!hits) return
    const interior = hits[0].slice(2, -2)
    // D11: el placeholder es el valor COMPLETO del string, y su interior es un nombre de parámetro.
    if (hits.length !== 1 || hits[0] !== value || !PARAM_RE.test(interior)) {
      throw new Error(
        `${where}: placeholder mal puesto en '${value}' — un placeholder debe ser el VALOR COMPLETO de un ` +
          `string JSON y con la forma {{nombre_de_parametro}} (sin espacios ni texto alrededor).`,
      )
    }
    out.add(interior)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectPlaceholders(v, `${where}[${i}]`, out))
    return
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Un placeholder en una CLAVE inyectaría estructura: exactamente lo que D11 impide.
    if (PLACEHOLDER_ANY.test(k)) {
      throw new Error(`${where}: placeholder en la clave '${k}' — los parámetros solo sustituyen VALORES, nunca claves.`)
    }
    collectPlaceholders(v, `${where}.${k}`, out)
  }
}

/** Sustituye en la estructura ya parseada: un string que ES un placeholder se reemplaza por su valor. */
function substitute(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === 'string') {
    const m = /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(value)
    return m ? (values[m[1]] ?? '') : value
  }
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => substitute(v, values))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitute(v, values)
  return out
}

/**
 * Parsea las partes de una plantilla y cruza sus placeholders contra los parámetros declarados.
 * Lo usan el arranque (para que un manifiesto incoherente NO levante el servidor) y el render.
 *
 * `partFiles` va indexado por el `path` de la part (no por su `file`): dentro de una plantilla el
 * path es único, y es el identificador con el que el motor conoce la parte.
 */
export function parseTemplateParts(tpl: JobTemplate, partFiles: Record<string, string>): { path: string; doc: unknown }[] {
  const donde = `plantilla '${tpl.id}'`
  const declarados = new Set(tpl.params.map((p) => p.name))
  const usados = new Set<string>()
  const docs = tpl.parts.map((part) => {
    const contenido = partFiles[part.path]
    if (contenido == null) throw new Error(`${donde}: falta el contenido de la parte '${part.path}' (archivo ${part.file}).`)
    let doc: unknown
    try {
      doc = JSON.parse(contenido)
    } catch (e) {
      throw new Error(`${donde}: la parte '${part.path}' (${part.file}) no es JSON válido: ${e instanceof Error ? e.message : String(e)}`)
    }
    collectPlaceholders(doc, `${donde}: parte '${part.path}'`, usados)
    return { path: part.path, doc }
  })

  for (const nombre of usados) {
    if (!declarados.has(nombre)) throw new Error(`${donde}: la definición usa el placeholder '{{${nombre}}}' pero 'params' no lo declara.`)
  }
  for (const p of tpl.params) {
    if (!usados.has(p.name)) throw new Error(`${donde}: el parámetro '${p.name}' está declarado pero ninguna parte lo usa como '{{${p.name}}}'.`)
  }
  return docs
}

/**
 * Renderiza la definición de una plantilla con los valores dados. PURA: no toca disco ni red.
 *
 * Reglas (D11): placeholder sin valor → error; valor sin placeholder → error; la sustitución ocurre
 * sobre el JSON parseado, así que un valor con `"`, `}` o con forma de placeholder entra como string
 * y no puede alterar la estructura.
 *
 * El `sha256` devuelto es el CANÓNICO (Δ1) — la única identidad de una definición en todo el sistema.
 */
export function renderTemplate(tpl: JobTemplate, partFiles: Record<string, string>, values: Record<string, string>): RenderedDefinition {
  const donde = `plantilla '${tpl.id}'`
  const docs = parseTemplateParts(tpl, partFiles)
  const declarados = new Set(tpl.params.map((p) => p.name))

  for (const clave of Object.keys(values)) {
    if (!declarados.has(clave)) throw new Error(`${donde}: se dio un valor para '${clave}', que la plantilla no declara como parámetro.`)
  }
  const efectivos: Record<string, string> = {}
  for (const p of tpl.params) {
    const v = values[p.name]
    if (v == null || (typeof v === 'string' && v.trim() === '')) {
      if (p.required) throw new Error(`${donde}: falta el valor del parámetro requerido '${p.name}' (${p.label}).`)
      efectivos[p.name] = ''
      continue
    }
    if (typeof v !== 'string') throw new Error(`${donde}: el valor de '${p.name}' debe ser un string.`)
    efectivos[p.name] = v
  }

  const parts = docs.map((d) => ({
    path: d.path,
    payloadBase64: Buffer.from(JSON.stringify(substitute(d.doc, efectivos)), 'utf8').toString('base64'),
  }))
  return { parts, sha256: canonicalDefinitionSha256(parts) }
}
