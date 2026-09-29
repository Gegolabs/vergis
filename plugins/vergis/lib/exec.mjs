// exec.mjs — `vergis-ops exec`: un ACTO gobernado sobre la instalación. Cada forma sabe su clase:
//
//   exec run --class <clase> -- '<sh>'        un comando del operador, con la clase que él declara
//   exec service <nombre> reload|recreate|prevalidate
//   exec rollout <install|promote|rollback|status|retire|prune|tool|ring-args> …
//
// Lo que ninguna forma hace, porque son invariantes del Producto y no se configuran: `down -v`, tocar
// el lease, editar `ring.args` o `active.caddy` a mano (classify.mjs).

import { EXIT, fail, out, err } from './util.mjs'
import { resolveInstallation } from './declaration.mjs'
import { runRemote } from './transport.mjs'
import { CLASSES, CUTTING, enforceGate, forbiddenReason } from './classify.mjs'
import { pollerRunning } from './poller.mjs'

export function evidenceLine(g) {
  if (g.gate === 'free') return `gate: free (${g.why})`
  if (!g.evidence) return `gate: ${g.gate} (${g.why}) — sin permiso que pedir; la red la pone quien ejecuta: respaldo, plan de reversa, verificación medida`
  const e = g.evidence
  return `gate: ${g.gate} (${g.why}) · autoriza ${e.authority}: «${e.window ?? e.approval}»${e.impact ? ` · impacto declarado: ${e.impact}` : ''}`
}

/** Aplica el gate con la evidencia de la línea de comando. `measured` = hay un poller corriendo. */
export async function gate(decl, ins, cls, o) {
  const measured = CUTTING.has(cls) ? await pollerRunning(decl, ins) : true
  return enforceGate(ins, cls, { window: o.window, impact: o.impact, approval: o.approval, measured })
}

async function execRun(decl, ins, o) {
  const cls = o.class
  if (!cls) fail(EXIT.NOT_RUN, 'exec run: declara la clase del acto con --class <clase> (' + CLASSES.join(' · ') + '). El plugin no adivina si un comando corta.')
  const cmd = (o.rest ?? []).join(' ').trim()
  if (!cmd) fail(EXIT.NOT_RUN, "exec run: falta el comando después de `--` (p. ej. exec run --class read -- 'docker ps')")
  const why = forbiddenReason(cmd)
  if (why) fail(EXIT.NOT_RUN, `exec run: no se ejecuta — ${why}. Es un invariante del Producto, no un gate: ninguna aprobación lo habilita.`)
  const g = await gate(decl, ins, cls, o)
  out(`== vergis-ops exec run · ${ins.id} · clase ${cls} ==`)
  out(`   ${evidenceLine(g)}`)
  const r = await runRemote(decl, ins, cmd)
  for (const l of r.lines) out(`   | ${l}`)
  if (r.rc !== 0) {
    out(`⚠ el comando salió ${r.rc} en el host (exit 1): el transporte midió bien; el acto falló.`)
    return EXIT.FINDING
  }
  out('✓ ejecutado (exit 0).')
  return EXIT.OK
}

export async function runExec(common, o) {
  const [form, ...args] = o._
  const { decl, ins } = resolveInstallation(common)
  if (form === 'run') return execRun(decl, ins, o)
  if (form === 'service') return (await import('./service.mjs')).execService(decl, ins, args, o)
  if (form === 'rollout') return (await import('./rollout.mjs')).execRollout(decl, ins, args, o)
  err('uso: vergis-ops exec run --class <clase> -- <sh> · exec service <nombre> reload|recreate|prevalidate · exec rollout <acto> …')
  return EXIT.NOT_RUN
}
