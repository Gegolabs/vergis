// check.mjs — `vergis-ops check`: ¿la declaración se puede usar? Sale con 0 o con 2, y NOMBRA el
// defecto. Las advertencias (repo público, tag móvil) no suben el exit.
//
// Toca el host UNA vez por instalación, y solo para leer: la SONDA del instrumento (#376) — ¿el
// contenedor donde va a vivir el poller trae con qué correrlo? Descubrirlo en `poller start` es
// descubrirlo en medio del acto. Si la sonda MIDE que no puede, es un defecto (2); si NO PUDO medir
// (transporte, contenedor ausente o detenido), sale 7 y lo dice — jamás 0. `--offline` la salta y lo
// declara: es el modo de autorar la declaración antes de que el host exista.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { EXIT, OpsExit, out, shq } from './util.mjs'
import { loadDeclaration, localPath, mirrorRoot } from './declaration.mjs'
import { composeServices, composeProjectName, movableTag, serviceOfContainer } from './compose.mjs'
import { runRemote } from './transport.mjs'
import { PROBE_SH, probeRefusal } from './poller.mjs'

/** El servicio del compose del que se derivan los anillos: el mismo que `exec rollout ring-args` toma por omisión. */
const RING_TEMPLATE = 'vergis'

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

export async function runCheck({ cwd, flag, installation }, { offline = false } = {}) {
  const decl = loadDeclaration({ cwd, flag })
  const errors = decl.errors.map((e) => e.message)
  const warnings = []
  const notes = []

  if (decl.doc && errors.length === 0) {
    const list = installation ? decl.doc.installations.filter((i) => i.id === installation) : decl.doc.installations
    if (installation && list.length === 0) errors.push(`--installation «${installation}» no está declarada`)
    for (const ins of list) checkInstallation(decl, ins, errors, warnings, notes)
  }

  // La sonda del instrumento, en el host — solo si la declaración ya es usable (sin ella no hay transporte).
  const unmeasured = []
  if (decl.doc && errors.length === 0) {
    const list = installation ? decl.doc.installations.filter((i) => i.id === installation) : decl.doc.installations
    for (const ins of list) {
      if (offline) { notes.push(`«${ins.id}» instrumento: NO sondeé sus herramientas en el host (--offline)`); continue }
      await probeInstrument(decl, ins, errors, notes, unmeasured)
    }
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
  if (unmeasured.length) {
    for (const u of unmeasured) out(`   ? ${u}`)
    out(`⚠ MEDÍ A MEDIAS (exit 7): la declaración es usable, pero no pude sondear el instrumento de ${unmeasured.length} instalación(es) — el poller podría no correr ahí, y se sabría recién en \`poller start\`.`)
    return EXIT.PARTIAL
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
      if (f.kind === 'sweep' && st.isDirectory()) {
        for (const x of f.exclude ?? []) {
          if (!existsSync(resolve(p, x.path))) warnings.push(`${tag} familia «${f.id}»: la exclusión «${x.path}» no está en el espejo — el barrido del host la ignora igual, así que un archivo con ese nombre en el host no se mide ni se reporta como SOLO-HOST. Si ya no existe, quítala de exclude`)
        }
      }
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
      const why = movableTag(s.image, { built: s.build })
      if (why) warnings.push(`${tag} el servicio «${name}» usa un tag móvil (${s.image}: ${why}): lo que corre no se puede nombrar`)
    }
    // La memoria de los anillos sale del servicio plantilla del compose (#372). Advertencia y no defecto:
    // no bloquea ninguna lectura, y el acto donde importa —`exec rollout ring-args`— se niega sin ella.
    const tpl = svcs[RING_TEMPLATE]
    if (tpl && !tpl.memLimit) {
      warnings.push(`${tag} el servicio plantilla «${RING_TEMPLATE}» no declara la memoria del anillo (mem_limit, o deploy.resources.limits.memory): \`exec rollout ring-args\` se negará hasta que el compose la declare — sin ella, los anillos nuevos nacerían con un valor que nadie decidió`)
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

  instrumentHost(ins, compose, notes, tag)
}

/**
 * ¿Qué servicio aloja el poller? `instrument.container` si se declara; si no, el borde (`RINGS_EDGE`,
 * con el default de la herramienta). Recrear ese servicio mata la medición, y `exec service … recreate`
 * se niega mientras el poller corra ahí: acá se dice ANTES, para que no se descubra en la ventana.
 */
function instrumentHost(ins, compose, notes, tag) {
  const declared = ins.instrument?.container
  const edgeEnv = ins.rings?.env?.RINGS_EDGE
  const ct = declared ?? edgeEnv ?? (ins.rings?.env_file ? null : 'caddy')
  const origin = declared ? 'instrument.container' : edgeEnv ? 'RINGS_EDGE, por omisión' : 'el borde por omisión de la herramienta'
  if (!ct) {
    notes.push(`${tag} instrumento: vive en el borde (RINGS_EDGE), definido en rings.env_file, que check no lee (vive en el host). La guardia de \`exec service … recreate\` lo averigua en el host.`)
    return
  }
  if (!compose) {
    notes.push(`${tag} instrumento: vive en «${ct}» (${origin}); sin el compose en el espejo no sé qué servicio es. La guardia de \`exec service … recreate\` lo averigua en el host.`)
    return
  }
  const svcs = composeServices(compose.text)
  const svc = serviceOfContainer(svcs, ct, ins.host?.compose_project ?? composeProjectName(compose.text))
  if (!svc) {
    notes.push(`${tag} instrumento: vive en «${ct}» (${origin}), que no es un contenedor de ningún servicio del compose del espejo: ningún \`exec service … recreate\` lo toca.`)
    return
  }
  const moveHint = declared ? '' : ' Para recrearlo con el corte medido, mueve antes el instrumento a un contenedor de vida larga que ese acto no recree (instrument.container).'
  notes.push(`${tag} instrumento: vive en «${ct}» (${origin}) = servicio «${svc}». \`exec service ${svc} recreate\` se niega mientras el poller corra ahí.${moveHint}`)
}

/**
 * ¿El contenedor del instrumento trae con qué correr el poller? La misma sonda que `poller start` corre
 * en su viaje (#376), acá antes del acto: `sh` con las herramientas de `poller.sh`, o `node` para su
 * hermano `poller-node.mjs`. Lo medido negativo es un defecto; lo no medido va a `unmeasured`.
 */
async function probeInstrument(decl, ins, errors, notes, unmeasured) {
  const tag = `«${ins.id}»`
  const ct = ins.instrument?.container ? shq(ins.instrument.container) : '"$RINGS_EDGE"'
  let r
  try {
    r = await runRemote(decl, ins, String.raw`VO_CT=${ct}
${PROBE_SH}
vo_instr_probe || true`)
  } catch (e) {
    if (!(e instanceof OpsExit)) throw e
    unmeasured.push(`${tag} instrumento: no pude sondearlo — ${e.message.split('\n')[0]} (exit ${e.code})`)
    return
  }
  const pr = probeRefusal(r.lines)
  if (pr?.measured) { errors.push(`${tag} instrumento: ${pr.text}`); return }
  if (pr) { unmeasured.push(`${tag} instrumento: ${pr.text}`); return }
  const ok = r.lines.find((l) => l.startsWith('INSTR '))?.split(' ')
  if (!ok) { unmeasured.push(`${tag} instrumento: la sonda no respondió`); return }
  notes.push(`${tag} instrumento: «${ok[1]}» puede alojar el poller — ${ok[2] === 'node' ? 'con `poller-node.mjs` (trae node, no las herramientas de `poller.sh`)' : 'con `poller.sh`'} (sondeado en el host)`)
}
