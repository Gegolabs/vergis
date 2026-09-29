// schema.mjs — validador del SUBCONJUNTO de JSON Schema que usa `schema/vergis-ops.schema.json`.
//
// Por qué uno propio y no ajv: el CLI es Node sin dependencias (el plugin se instala como un
// directorio, sin `npm install`). Por qué no una validación escrita a mano en el CLI: serían dos
// fuentes de la misma regla, y driftean. Este validador LEE el esquema publicado, así que el esquema es
// la única fuente; y la suite del Producto corre cada fixture por este validador y por ajv, y exige
// que coincidan (`tests/plugin-schema.test.ts`). Si el esquema empieza a usar una palabra clave que
// este validador no conoce, falla ruidoso nombrándola en vez de aprobar por omisión.

const KNOWN = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description', 'type', 'const', 'enum', 'required',
  'properties', 'additionalProperties', 'propertyNames', 'pattern', 'minItems', 'minLength', 'minimum',
  'maximum', 'items', 'oneOf', 'anyOf',
])

function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (Number.isInteger(v)) return 'integer'
  return typeof v
}

function typeMatches(v, t) {
  const ty = typeOf(v)
  if (t === 'number') return ty === 'number' || ty === 'integer'
  return ty === t
}

function fmtPath(path) {
  return path.length ? path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('').replace(/^\./, '') : '(raíz)'
}

/**
 * Valida `value` contra `schema` (con `$defs` de `root`). Devuelve una lista de errores
 * `{ path, message, missing? }` — vacía si valida. `missing` lleva la ruta de la clave obligatoria
 * ausente, para que `check` la NOMBRE.
 */
export function validate(root, value) {
  const errors = []
  walk(root, root, value, [], errors)
  return errors
}

function resolveRef(root, ref) {
  const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref)
  if (!m || !root.$defs || !root.$defs[m[1]]) throw new Error(`esquema: $ref no soportado o inexistente «${ref}»`)
  return root.$defs[m[1]]
}

function walk(root, schema, value, path, errors) {
  for (const k of Object.keys(schema)) {
    if (!KNOWN.has(k)) throw new Error(`esquema: palabra clave «${k}» no soportada por el validador del CLI (en ${fmtPath(path)})`)
  }
  if (schema.$ref) {
    walk(root, resolveRef(root, schema.$ref), value, path, errors)
    return
  }
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push({ path, message: `${fmtPath(path)}: se esperaba ${schema.type}, llegó ${typeOf(value)}` })
    return
  }
  if ('const' in schema && value !== schema.const) {
    errors.push({ path, message: `${fmtPath(path)}: debe ser ${JSON.stringify(schema.const)}` })
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `${fmtPath(path)}: debe ser uno de ${schema.enum.map((e) => JSON.stringify(e)).join(' · ')} (llegó ${JSON.stringify(value)})` })
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push({ path, message: `${fmtPath(path)}: «${value}» no calza con ${schema.pattern}` })
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `${fmtPath(path)}: no puede ser vacío` })
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `${fmtPath(path)}: mínimo ${schema.minimum}` })
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `${fmtPath(path)}: máximo ${schema.maximum}` })
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `${fmtPath(path)}: exige al menos ${schema.minItems} elemento(s)` })
    }
    if (schema.items) value.forEach((v, i) => walk(root, schema.items, v, [...path, i], errors))
  }
  if (typeOf(value) === 'object') {
    for (const req of schema.required ?? []) {
      if (!(req in value)) {
        const p = [...path, req]
        errors.push({ path: p, missing: fmtPath(p), message: `falta la clave obligatoria «${fmtPath(p)}»` })
      }
    }
    const props = schema.properties ?? {}
    for (const [k, v] of Object.entries(value)) {
      if (schema.propertyNames) walk(root, schema.propertyNames, k, [...path, k], errors)
      if (k in props) walk(root, props[k], v, [...path, k], errors)
      else if (schema.additionalProperties === false) {
        errors.push({ path: [...path, k], message: `${fmtPath([...path, k])}: clave no reconocida por el esquema` })
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        walk(root, schema.additionalProperties, v, [...path, k], errors)
      }
    }
  }
  if (schema.anyOf) {
    const results = schema.anyOf.map((s) => { const e = []; walk(root, s, value, path, e); return e })
    if (!results.some((e) => e.length === 0)) errors.push(...results[0])
  }
  if (schema.oneOf) {
    const results = schema.oneOf.map((s) => { const e = []; walk(root, s, value, path, e); return e })
    const ok = results.filter((e) => e.length === 0).length
    if (ok === 0) {
      // Discriminador: si una rama fija `kind` con const y el valor lo trae, los errores de ESA rama
      // son los que dicen algo útil; si no, se reporta el conjunto de alternativas.
      const kind = typeOf(value) === 'object' ? value.kind : undefined
      const idx = schema.oneOf.findIndex((s) => s.properties?.kind?.const !== undefined && s.properties.kind.const === kind)
      if (idx >= 0) errors.push(...results[idx])
      else if (kind !== undefined) {
        const kinds = schema.oneOf.map((s) => s.properties?.kind?.const).filter(Boolean)
        errors.push({ path: [...path, 'kind'], message: `${fmtPath([...path, 'kind'])}: «${kind}» no es un tipo conocido (${kinds.join(' · ')})` })
      } else {
        const missing = results.flat().filter((e) => e.missing)
        if (missing.length) errors.push({ path, missing: missing.map((e) => e.missing).join(' o '), message: `falta la clave obligatoria «${missing.map((e) => e.missing).join('» o «')}»` })
        else errors.push({ path, message: `${fmtPath(path)}: no calza con ninguna de las alternativas del esquema` })
      }
    } else if (ok > 1) {
      errors.push({ path, message: `${fmtPath(path)}: calza con más de una alternativa excluyente (¿se declararon las dos a la vez?)` })
    }
  }
}
