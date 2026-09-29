// parity.mjs — `vergis-ops parity`: ¿lo que corre en el host es lo que el espejo dice que corre?
//
// Motor portado de la sonda de paridad del primer adoptante (su diseño y sus lecciones intactos),
// con el mapa leído de `mirror.families` en vez de cableado. READ-ONLY sobre el host: lo único que
// escribe allá es su temporal de desborde de detalle, y el resumen lo dice.
//
// Clases de la salida (distintas hasta el exit):
//   DRIFT      en los dos lados con sha256 distinto
//   AUSENTE    par fijo del mapa que no existe en el host
//   SOLO-REPO  archivo de una familia barrida que está en el espejo y no en el host (nunca desplegado)
//   SOLO-HOST  archivo en el host sin contraparte en el espejo (grave en specs: el nodo re-escanea el
//              directorio, así que un yaml huérfano SE SIRVE)
//   ERR        existe en el host y no se pudo hashear — NO es drift, es no-medición
//   HYG        AppleDouble `._*`: se reporta, no sube el exit
//   EXCL       exclusión declarada con motivo: se lista para que no sea un silencio
//
// Invariantes: ningún exit ≤ 1 sin centinela apareado Y cuentas reconciliadas · «no está» ≠ «no pude
// leerlo» · un ERR no se vuelve DRIFT por comodidad.
//
// G1, la guardia de montajes: antes de tocar el host, cada montaje del compose espejado tiene que estar
// cubierto por una familia o declarado en `mirror.unmirrored` con su motivo (los `env_file` se excluyen
// solos: son secretos). Un montaje sin cubrir ⇒ 2: la sonda no mide con un inventario que sabe
// incompleto, y así el envejecimiento del mapa se vuelve RUIDOSO en vez de silencioso.
//
// Inyector `PARIDAD_FAULT` (solo controles negativos; solo puede DAÑAR):
//   hash → 1 (DRIFT) · path → 1 (AUSENTE) · mute → 5 · dir → 7 (ERR) · count → 7 (cuentas rotas)

import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve, sep } from 'node:path'
import { EXIT, fail, out, err, sha256File, worst } from './util.mjs'
import { resolveInstallation, requireKey, mirrorRoot } from './declaration.mjs'
import { runRemote } from './transport.mjs'
import { mirroredCompose } from './check.mjs'
import { composeMounts } from './compose.mjs'

const MAX_DETAIL = 30

function walk(dir) {
  const outp = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('._') || e.name === '.DS_Store') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) outp.push(...walk(p))
    else if (e.isFile()) outp.push(p)
  }
  return outp.sort()
}

/** El manifiesto local: `{ sha, host, kind, family, local }` por par, más las exclusiones y los barridos. */
export function manifest(decl, ins, only) {
  const fams = requireKey(ins, 'mirror.families', 'parity')
  const root = mirrorRoot(decl, ins)
  const hostRoot = ins.host.root.replace(/\/+$/, '')
  const pairs = []
  const excluded = []
  const sweeps = []
  const selected = fams.filter((f) => !only || f.id === only)
  if (only && !selected.length) fail(EXIT.NOT_RUN, `--family «${only}» no está en mirror.families (${[...new Set(fams.map((f) => f.id))].join(' · ')})`)
  for (const f of selected) {
    const loc = resolve(root, f.local)
    const hostBase = `${hostRoot}/${f.remote}`
    if (!existsSync(loc)) {
      if (f.optional) { excluded.push(`EXCL       ${f.local} ausente en el espejo (opcional) — el par «${f.id}» no se midió`); continue }
      fail(EXIT.NOT_RUN, `el mapa declara «${f.local}» (familia ${f.id}) y no existe en el espejo`)
    }
    if (f.kind === 'fixed') {
      pairs.push({ sha: sha256File(loc), host: hostBase, kind: 'fixed', family: f.id, local: loc })
      continue
    }
    const exc = new Map((f.exclude ?? []).map((x) => [x.path, x.reason]))
    let depth = 1
    const seen = new Set()
    for (const p of walk(loc)) {
      const rel = relative(loc, p).split(sep).join('/')
      if (exc.has(rel)) { seen.add(rel); continue }
      depth = Math.max(depth, rel.split('/').length)
      pairs.push({ sha: sha256File(p), host: `${hostBase}/${rel}`, kind: 'sweep', family: f.id, local: p })
    }
    // TODA exclusión declarada se lista, esté o no en el espejo (#371): la ruta entra igual en la lista
    // que el barrido del host ignora, así que una exclusión sin archivo local silencia el host — y un
    // silencio que no se lista es exactamente lo que EXCL existe para impedir.
    for (const [rel, reason] of exc) {
      excluded.push(`EXCL       ${f.remote}/${rel}  (${reason})${seen.has(rel) ? '' : ' — NO está en el espejo: en el host se ignora igual, sin medirse'}`)
    }
    // La profundidad del barrido del host es la del espejo: lo que el espejo no declara en un nivel
    // que él mismo no usa, no se le reclama al host.
    sweeps.push({ dir: hostBase, depth, excl: [...exc.keys()].map((r) => `${hostBase}/${r}`) })
  }
  for (const p of pairs) {
    if (/\s/.test(p.host) || /\s/.test(p.local)) fail(EXIT.NOT_RUN, `ruta con espacios, el manifiesto no las soporta: ${p.local} → ${p.host}`)
  }
  return { pairs, excluded, sweeps }
}

/** G1: montajes del compose espejado sin cubrir. `null` si no hay compose en el espejo. */
export function guardG1(decl, ins) {
  const compose = mirroredCompose(decl, ins)
  if (!compose) return null
  const covered = new Set(ins.mirror.families.map((f) => f.remote.split('/')[0]))
  for (const u of ins.mirror.unmirrored ?? []) covered.add(u.path.split('/')[0])
  const mounts = composeMounts(compose.text, ins.host.root)
  return mounts.filter((m) => !m.secret && !covered.has(m.path)).map((m) => m.full)
}

function remoteBody(m, fault) {
  const man = m.pairs.map((p) => `${p.sha} ${p.host} ${p.kind}`)
  if (fault === 'hash' && man.length) man[0] = man[0].replace(/^[0-9a-f]{64}/, '0'.repeat(64))
  const sweeps = m.sweeps.map((s) => `${s.dir}:${s.depth}`).join(' ')
  const excl = m.sweeps.flatMap((s) => s.excl)
  return String.raw`MAN=$VO_T/man
cat > "$MAN" <<'VO_MANIFEST_EOF'
${man.join('\n')}
VO_MANIFEST_EOF
cat > "$VO_T/excl" <<'VO_EXCL_EOF'
${excl.join('\n')}
VO_EXCL_EOF
DET=/tmp/vergis-ops-paridad-$$.txt
SWEEPS='${sweeps}'
MAXDET=${MAX_DETAIL}
awk '{print $2}' "$MAN" > "$VO_T/paths"
n=0; ok=0; drift=0; solo_repo=0; err=0; solo_host=0; hyg=0; det=0; over=0
emit() { if [ "$det" -lt "$MAXDET" ]; then printf '%s\n' "$1"; det=$((det+1)); else printf '%s\n' "$1" >> "$DET"; over=$((over+1)); fi; }
while read -r sha path kind; do
  [ -n "$sha" ] || continue
  n=$((n+1))
  if [ ! -e "$path" ]; then
    if [ "$kind" = fixed ]; then emit "AUSENTE    $path"; else emit "SOLO-REPO  $path"; fi
    solo_repo=$((solo_repo+1)); continue
  fi
  got=$(vo_sha "$path")
  if [ -z "$got" ]; then emit "ERR        $path  (existe; no se pudo hashear — ilegible o no es un archivo regular)"; err=$((err+1)); continue; fi
  if [ "$got" = "$sha" ]; then ok=$((ok+1)); else emit "DRIFT      $path  host=$(printf '%s' "$got" | cut -c1-16) espejo=$(printf '%s' "$sha" | cut -c1-16)"; drift=$((drift+1)); fi
done < "$MAN"
for entry in $SWEEPS; do
  d=${'$'}{entry%:*}; depth=${'$'}{entry##*:}
  if [ ! -d "$d" ]; then emit "AUSENTE    $d/  (directorio del mapa no existe en el host)"; continue; fi
  find "$d" -maxdepth "$depth" -type f 2>/dev/null | LC_ALL=C sort > "$VO_T/found"
  while read -r f; do
    [ -n "$f" ] || continue
    b=$(basename "$f")
    case "$b" in
      ._*) emit "HYG        $f  (AppleDouble: metadata de macOS colada por un envío sin COPYFILE_DISABLE)"; hyg=$((hyg+1)); continue ;;
      *.bak-*|*.bak.*|*.tar.gz|*.tgz|*.env|*.pyc) continue ;;
    esac
    case "$f" in *__pycache__*) continue ;; esac
    grep -qxF "$f" "$VO_T/paths" && continue
    grep -qxF "$f" "$VO_T/excl" && continue
    emit "SOLO-HOST  $f"; solo_host=$((solo_host+1))
  done < "$VO_T/found"
done
[ "$over" -gt 0 ] && printf '%s\n' "…y $over línea(s) más; detalle completo en el host: $DET"
${fault === 'count' ? 'n=$((n+1))   # PARIDAD_FAULT=count' : ''}
printf 'PARIDAD total=%s ok=%s drift=%s solo_host=%s solo_repo=%s err=%s hyg=%s over=%s\n' "$n" "$ok" "$drift" "$solo_host" "$solo_repo" "$err" "$hyg" "$over"`
}

function dirtySet(root) {
  const r = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const top = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim()
  return new Set(r.stdout.split('\n').filter(Boolean).map((l) => resolve(top, l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop())))
}

/** Mide y devuelve `{ code, text[] }`. `quiet` para que otros verbos lo compongan. */
export async function measureParity(decl, ins, { family, dryRun = false } = {}) {
  const fault = process.env.PARIDAD_FAULT || ''
  if (fault && !['hash', 'path', 'mute', 'dir', 'count'].includes(fault)) fail(EXIT.NOT_RUN, `PARIDAD_FAULT=«${fault}» no existe (hash · path · mute · dir · count)`)
  if (fault) err(`!! PARIDAD_FAULT=${fault} — INYECTOR DE FALLAS ACTIVO (solo controles negativos) !!`)
  const lines = []
  const g1 = guardG1(decl, ins)
  if (g1 && g1.length) {
    fail(EXIT.NOT_RUN, `G1 SIN-MAPEO — el compose espejado monta cosas que el mapa no cubre:\n${g1.map((x) => `     · ${x}`).join('\n')}\n   La sonda NO mide con un inventario que sabe incompleto. Arreglo: una familia en mirror.families, o una entrada en mirror.unmirrored con su motivo.`)
  }
  if (g1 === null) lines.push('   · G1 no corrió: el compose (host.compose_file) no está en el espejo')
  const m = manifest(decl, ins, family)
  const hostRoot = ins.host.root.replace(/\/+$/, '')
  if (fault === 'path') m.pairs.push({ sha: '1'.repeat(64), host: `${hostRoot}/NO-EXISTE-fault-${Date.now()}.yaml`, kind: 'fixed', family: '(inyectado)', local: '(inyectado)' })
  if (fault === 'dir') m.pairs.push({ sha: '2'.repeat(64), host: hostRoot, kind: 'fixed', family: '(inyectado)', local: '(inyectado)' })
  if (!m.pairs.length) fail(EXIT.NOT_RUN, 'el manifiesto quedó vacío')
  const body = remoteBody(m, fault)
  if (dryRun) {
    lines.push(`== vergis-ops parity · DRY-RUN · ${ins.id} · ${m.pairs.length} pares · script ${Buffer.byteLength(body)} B ==`)
    for (const p of m.pairs) lines.push(`   ${p.sha.slice(0, 16)}  ${p.host}  ${p.kind}  ${p.family}`)
    for (const e of m.excluded) lines.push(`   ${e}`)
    lines.push(`   barridos del host: ${m.sweeps.map((s) => `${s.dir} (profundidad ${s.depth})`).join(' · ') || '—'}`)
    lines.push('DRY-RUN: no se tocó el host. exit 0')
    return { code: EXIT.OK, lines }
  }
  const t0 = Date.now()
  const r = await runRemote(decl, ins, body, { mute: fault === 'mute' })
  const sum = r.lines.find((l) => l.startsWith('PARIDAD '))
  if (!sum) fail(EXIT.MUTE, 'el host no devolvió el resumen de la paridad (el remoto falló antes de contar).')
  const kv = Object.fromEntries(sum.slice(8).split(' ').map((p) => p.split('=')).map(([k, v]) => [k, Number(v)]))
  const dirty = dirtySet(mirrorRoot(decl, ins))
  const byHost = new Map(m.pairs.map((p) => [p.host, p]))
  lines.push(`== vergis-ops parity · ${ins.id}${family ? ` · familia ${family}` : ''} · ${m.pairs.length} pares · ${((Date.now() - t0) / 1000).toFixed(1)} s ==`)
  const detail = r.lines.filter((l) => /^(DRIFT|AUSENTE|SOLO-REPO|SOLO-HOST|ERR|HYG|…y )/.test(l))
  if (!detail.length) lines.push('   (sin discrepancias)')
  for (const l of detail) {
    const p = byHost.get(l.split(/\s+/)[1])
    const mark = p && dirty && dirty.has(p.local) ? '  ⚠espejo-sin-commitear' : ''
    lines.push(`   ${l}${mark}`)
  }
  for (const e of m.excluded) lines.push(`   ${e}`)
  lines.push(`   -- cuentas: total=${kv.total} ok=${kv.ok} drift=${kv.drift} solo_repo=${kv.solo_repo} solo_host=${kv.solo_host} err=${kv.err} hyg=${kv.hyg} --`)
  let recon = true
  if (kv.total !== kv.ok + kv.drift + kv.solo_repo + kv.err) { lines.push(`   ✗ CUENTAS NO CUADRAN: total=${kv.total} ≠ ok+drift+solo_repo+err`); recon = false }
  if (kv.total !== m.pairs.length) { lines.push(`   ✗ CUENTAS NO CUADRAN: el host contó ${kv.total} entradas y se enviaron ${m.pairs.length}`); recon = false }
  if (!recon || kv.err > 0 || kv.over > 0) {
    lines.push('⚠ MEDICIÓN PARCIAL (exit 7): lo no medido está listado arriba; no se cuenta como OK.')
    return { code: EXIT.PARTIAL, lines }
  }
  if (kv.drift || kv.solo_host || kv.solo_repo) {
    lines.push('⚠ HAY DRIFT (exit 1): el host no sirve lo que el espejo dice. Se reporta, no se repara de paso: quién actúa y con qué red lo dicen los gates de la instalación.')
    return { code: EXIT.FINDING, lines }
  }
  lines.push(`✓ PARIDAD TOTAL (exit 0): ${kv.ok}/${m.pairs.length} pares idénticos, sin SOLO-HOST ni ERR.`)
  return { code: EXIT.OK, lines }
}

export async function runParity(common, o) {
  const { decl, ins } = resolveInstallation(common)
  const r = await measureParity(decl, ins, { family: o.family, dryRun: !!o['dry-run'] })
  for (const l of r.lines) out(l)
  return worst([r.code])
}

