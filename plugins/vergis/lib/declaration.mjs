// declaration.mjs — resolver la declaración y la instalación (D3, D4).
//
// El sombrero lo decide la declaración, no el repo: sin `vergis-ops.json`, los verbos que tocan una
// instalación se niegan; con él, se opera — viva donde viva. La frontera de la casa del Producto (que
// una sesión de su repo no pueda resolver una instalación real) se construye EN ese repo: `--declaration`
// solo admite transporte `local`, y la suite del Producto prohíbe un `vergis-ops.json` fuera de sus
// fixtures. Así ningún cliente hereda una regla que es de otra casa.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, fail } from './util.mjs'
import { validate } from './schema.mjs'

export const DECL_NAME = 'vergis-ops.json'
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SCHEMA_PATH = join(PLUGIN_ROOT, 'schema', 'vergis-ops.schema.json')

export const NO_DECL_MSG =
  'acá no hay instalación declarada (no encontré vergis-ops.json subiendo desde este directorio). ' +
  'Si esto es el repo del Producto: el Producto publica y avisa, no opera. ' +
  'Si es el repo del operador: declara la instalación (skill vergis:setup) y corre `vergis-ops check`.'

export function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
}

export function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/** Sube desde `start` buscando `vergis-ops.json`, como `git` busca `.git`. */
export function findDeclaration(start) {
  let dir = resolve(start)
  for (;;) {
    const p = join(dir, DECL_NAME)
    if (existsSync(p)) return p
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/**
 * Carga y valida la declaración. Devuelve `{ path, dir, doc, errors, viaFlag }`. No elige instalación:
 * eso es `selectInstallation`. Un JSON inválido o un esquema violado NO lanzan acá — `check` los lista
 * todos; los demás verbos llaman a `requireValid`.
 */
export function loadDeclaration({ cwd = process.cwd(), flag } = {}) {
  let path
  if (flag) {
    path = resolve(cwd, flag)
    if (!existsSync(path)) fail(EXIT.NOT_RUN, `--declaration: no existe «${path}»`)
  } else {
    path = findDeclaration(cwd)
    if (!path) fail(EXIT.NOT_RUN, NO_DECL_MSG)
  }
  const dir = dirname(path)
  let doc
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return { path, dir, doc: null, errors: [{ message: `JSON inválido en ${path}: ${e.message}` }], viaFlag: !!flag }
  }
  const errors = validate(loadSchema(), doc).map((e) => ({ ...e }))
  // Reglas que el esquema no expresa: ids únicos.
  if (Array.isArray(doc?.installations)) {
    const seen = new Map()
    doc.installations.forEach((ins, i) => {
      if (!ins || typeof ins.id !== 'string') return
      if (seen.has(ins.id)) errors.push({ message: `installations[${i}].id: «${ins.id}» está repetido (también en installations[${seen.get(ins.id)}])` })
      else seen.set(ins.id, i)
    })
  }
  // La frontera del Producto: `--declaration` es para pruebas y SOLO con transporte local.
  if (flag && Array.isArray(doc?.installations)) {
    doc.installations.forEach((ins, i) => {
      const k = ins?.transport?.kind
      if (k && k !== 'local') {
        errors.push({ message: `installations[${i}] («${ins.id}»): --declaration solo admite transporte «local» (llegó «${k}»). Una instalación real se opera desde el repo del operador, donde vive su vergis-ops.json.` })
      }
    })
  }
  return { path, dir, doc, errors, viaFlag: !!flag }
}

export function requireValid(decl) {
  if (decl.errors.length) {
    fail(EXIT.NOT_RUN, `la declaración ${decl.path} no es válida — corre \`vergis-ops check\`:\n  · ${decl.errors.map((e) => e.message).join('\n  · ')}`)
  }
  return decl
}

/** Elige la instalación. Con más de una, `--installation` es obligatorio: no hay instalación por omisión. */
export function selectInstallation(decl, id) {
  const all = decl.doc.installations
  if (id) {
    const ins = all.find((x) => x.id === id)
    if (!ins) fail(EXIT.NOT_RUN, `--installation «${id}» no está declarada (hay: ${all.map((x) => x.id).join(' · ')})`)
    return ins
  }
  if (all.length > 1) {
    fail(EXIT.NOT_RUN, `la declaración tiene ${all.length} instalaciones (${all.map((x) => x.id).join(' · ')}): nombra una con --installation <id>. No hay instalación por omisión.`)
  }
  return all[0]
}

/** Exige una clave opcional que el verbo necesita; si falta, sale con 2 NOMBRÁNDOLA. */
export function requireKey(ins, dotted, verb) {
  let v = ins
  for (const k of dotted.split('.')) v = v == null ? undefined : v[k]
  if (v === undefined || (Array.isArray(v) && v.length === 0)) {
    fail(EXIT.NOT_RUN, `${verb}: la instalación «${ins.id}» no declara «${dotted}», y este verbo la necesita. Declárala en vergis-ops.json (esquema: ${SCHEMA_PATH}).`)
  }
  return v
}

export function localPath(decl, p) {
  return isAbsolute(p) ? p : resolve(decl.dir, p)
}

export function mirrorRoot(decl, ins) {
  return localPath(decl, ins.mirror?.root ?? '.')
}

/** Lo que casi todo verbo hace primero: declaración válida + la instalación elegida. */
export function resolveInstallation({ cwd, flag, installation }) {
  const decl = requireValid(loadDeclaration({ cwd, flag }))
  const ins = selectInstallation(decl, installation)
  return { decl, ins }
}
