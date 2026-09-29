// check.mjs — `vergis-ops check`: ¿la declaración se puede usar? Sale con 0 o con 2, y NOMBRA el
// defecto. Es local: no toca el host. Las advertencias (repo público, tag móvil) no suben el exit.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { EXIT, out } from './util.mjs'
import { loadDeclaration, localPath, mirrorRoot } from './declaration.mjs'
import { composeServices, movableTag } from './compose.mjs'

function git(cwd, ...args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

/** ¿Este archivo local quedaría versionado? `null` si no está dentro de un repo git. */
function versionable(file) {
  const dir = dirname(file)
  const top = git(dir, 'rev-parse', '--show-toplevel')
  if (top.status !== 0) return null
  const ign = git(top.stdout.trim(), 'check-ignore', '-q', file)
  return ign.status !== 0 // 0 = ignorado · 1 = NO ignorado
}

/** El compose del espejo: la familia `fixed` cuyo destino es `host.compose_file`. */
export function mirroredCompose(decl, ins) {
  if (!ins.mirror || !ins.host?.compose_file) return null
  const root = ins.host.root.replace(/\/$/, '')
  const fam = ins.mirror.families.find((f) => f.kind === 'fixed' && `${root}/${f.remote}` === ins.host.compose_file)
  if (!fam) return null
  const p = resolve(mirrorRoot(decl, ins), fam.local)
  return existsSync(p) ? { family: fam, path: p, text: readFileSync(p, 'utf8') } : null
}

function githubRepoOf(dir) {
  const r = git(dir, 'remote', 'get-url', 'origin')
  if (r.status !== 0) return null
  const m = /github\.com[:/]([^/]+)\/([^/.\s]+?)(\.git)?\s*$/.exec(r.stdout.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

export function runCheck({ cwd, flag, installation }) {
  const decl = loadDeclaration({ cwd, flag })
  const errors = decl.errors.map((e) => e.message)
  const warnings = []
  const notes = []

  if (decl.doc && errors.length === 0) {
    const list = installation ? decl.doc.installations.filter((i) => i.id === installation) : decl.doc.installations
    if (installation && list.length === 0) errors.push(`--installation «${installation}» no está declarada`)
    for (const ins of list) checkInstallation(decl, ins, errors, warnings, notes)
  }

  // Superficie: la declaración es inventario operativo — no secreto, pero no público (D4).
  if (decl.doc) {
    const repo = githubRepoOf(decl.dir)
    if (repo) {
      const gh = spawnSync('gh', ['repo', 'view', repo, '--json', 'visibility', '-q', '.visibility'], { encoding: 'utf8' })
      if (gh.error) notes.push(`no pude medir la visibilidad de ${repo}: falta \`gh\` (la advertencia de repo público no corrió)`)
      else if (gh.status !== 0) notes.push(`no pude medir la visibilidad de ${repo} (gh salió ${gh.status})`)
      else if (gh.stdout.trim() === 'PUBLIC') {
        warnings.push(`el repo ${repo} es PÚBLICO: la declaración expone topología, cuentas técnicas e identidades de sondeo. No lleva secretos, pero no debería ser pública.`)
      }
    }
  }

  out(`== vergis-ops check · ${decl.path} ==`)
  for (const n of notes) out(`   · ${n}`)
  for (const w of warnings) out(`   ⚠ ${w}`)
  if (errors.length) {
    for (const e of errors) out(`   ✗ ${e}`)
    out(`✗ NO USABLE (exit 2): ${errors.length} defecto(s). Ningún verbo opera con esta declaración hasta que check salga 0.`)
    return EXIT.NOT_RUN
  }
  out(`✓ DECLARACIÓN USABLE (exit 0): ${decl.doc.installations.map((i) => i.id).join(' · ')}${warnings.length ? ` — con ${warnings.length} advertencia(s) que no suben el exit` : ''}`)
  return EXIT.OK
}

function checkInstallation(decl, ins, errors, warnings, notes) {
  const tag = `«${ins.id}»`

  // Secretos inline en rings.env: el token va por archivo, jamás por valor.
  for (const k of Object.keys(ins.rings?.env ?? {})) {
    if (/TOKEN|SECRET|PASSWORD/.test(k) && !k.endsWith('_FILE')) {
      errors.push(`${tag} rings.env.${k}: parece un secreto inline. Declara la ruta del archivo que lo contiene (p. ej. RINGS_GATE_TOKEN_FILE)`)
    }
  }

  // La llave del transporte ssh: fuera de git.
  const idf = ins.transport?.identity_file
  if (idf) {
    const p = idf.startsWith('~/') ? join(homedir(), idf.slice(2)) : localPath(decl, idf)
    if (!existsSync(p)) errors.push(`${tag} transport.identity_file: no existe «${p}»`)
    else if (versionable(p) === true) errors.push(`${tag} transport.identity_file: «${p}» está dentro de un repo git y NO está ignorado — una llave no se versiona (agrégala al .gitignore o muévela fuera del repo)`)
  }

  // El espejo: cada `local` existe, con la forma que su `kind` exige.
  if (ins.mirror) {
    const root = mirrorRoot(decl, ins)
    if (!existsSync(root)) errors.push(`${tag} mirror.root: no existe «${root}»`)
    for (const f of ins.mirror.families) {
      const p = resolve(root, f.local)
      if (!existsSync(p)) {
        if (f.optional) notes.push(`${tag} familia «${f.id}»: «${f.local}» no está (opcional: la paridad lo dirá y no lo medirá)`)
        else errors.push(`${tag} mirror.families «${f.id}»: la ruta local «${f.local}» no existe (${p})`)
        continue
      }
      const st = statSync(p)
      if (f.kind === 'fixed' && !st.isFile()) errors.push(`${tag} familia «${f.id}» es fixed y «${f.local}» no es un archivo`)
      if (f.kind === 'sweep' && !st.isDirectory()) errors.push(`${tag} familia «${f.id}» es sweep y «${f.local}» no es un directorio`)
      if (f.kind === 'fixed' && f.exclude?.length) errors.push(`${tag} familia «${f.id}»: exclude solo tiene sentido en sweep`)
    }
  }

  // La norma que funda los gates existe.
  if (ins.governance?.source) {
    const p = localPath(decl, ins.governance.source)
    if (!existsSync(p)) errors.push(`${tag} governance.source: la norma citada no existe (${p}). Una declaración que cita una norma inexistente no tiene quién la corrija`)
  }
  for (const k of ['acts_log', 'cuts_log']) {
    const v = ins.governance?.[k]
    if (v && !existsSync(localPath(decl, v))) notes.push(`${tag} governance.${k}: «${v}» todavía no existe`)
  }

  // Los servicios contra el compose del espejo; los tags móviles, como advertencia.
  const compose = mirroredCompose(decl, ins)
  if (compose) {
    const svcs = composeServices(compose.text)
    for (const s of ins.services ?? []) {
      if (!(s.name in svcs)) errors.push(`${tag} services «${s.name}»: no está en el compose del espejo (${compose.family.local}; servicios: ${Object.keys(svcs).join(' · ') || 'ninguno reconocido'})`)
    }
    for (const [name, s] of Object.entries(svcs)) {
      const why = movableTag(s.image)
      if (why) warnings.push(`${tag} el servicio «${name}» usa un tag móvil (${s.image}: ${why}): lo que corre no se puede nombrar`)
    }
  } else if (ins.services?.length) {
    notes.push(`${tag} services: no pude cotejarlos contra el compose — el compose (host.compose_file) no está en el espejo`)
  }

  // La consistencia con el inventario de accesos del repo, si lo hay.
  const res = join(decl.dir, 'RESOURCES.md')
  if (existsSync(res)) {
    const txt = readFileSync(res, 'utf8')
    const t = ins.transport ?? {}
    const must = t.kind === 'az-run-command' ? [t.resource_group, t.vm] : t.kind === 'ssh' ? [t.host] : []
    for (const v of must) {
      if (v && !txt.includes(v)) errors.push(`${tag} ${v}: el transporte lo nombra y RESOURCES.md no — el acceso tiene que estar en el inventario del repo`)
    }
  }
}
