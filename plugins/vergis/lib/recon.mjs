// recon.mjs — `vergis-ops recon`: desde dónde se parte, SIN tocar nada. Corre check, health, el
// contrato, el estado de los anillos y la paridad (si hay espejo), y dice la distancia entre la versión
// del plugin y la del nodo. Un drift previo se REPORTA antes de seguir — no se repara de paso: desplegar
// sobre él mezcla el cambio propio con el ajeno.

import { EXIT, out, worst, OpsExit } from './util.mjs'
import { resolveInstallation, pluginVersion } from './declaration.mjs'
import { runCheck } from './check.mjs'
import { measureHealth, describe } from './health.mjs'
import { measureParity } from './parity.mjs'
import { contractSummary } from './contract.mjs'
import { runRemote } from './transport.mjs'

async function paso(nombre, fn) {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof OpsExit) {
      out(`   ✗ ${nombre}: ${e.message.split('\n')[0]} (exit ${e.code})`)
      return e.code
    }
    throw e
  }
}

export async function runRecon(common) {
  const codes = []
  codes.push(await runCheck(common))
  if (codes[0] === EXIT.NOT_RUN) return EXIT.NOT_RUN
  const { decl, ins } = resolveInstallation(common)
  out(`== vergis-ops recon · ${ins.id} ==`)
  codes.push(await paso('health', async () => {
    const h = await measureHealth(decl, ins)
    out(`   health: borde ${h.edge.ok ? 'OK' : 'MAL'} ${describe(h.edge)} · activo ${h.active ?? '—'}`)
    for (const r of h.rings) out(`     anillo ${r.name}: ${describe(r)}`)
    return h.code
  }))
  codes.push(await paso('contrato', async () => {
    const c = await contractSummary(decl, ins)
    for (const l of c.lines) out(`  ${l}`)
    // Sin contrato no se clasifica: no es un drift, pero cada acto sobre lo montado pasará a interrupción.
    return c.code === EXIT.OK ? EXIT.OK : EXIT.PARTIAL
  }))
  codes.push(await paso('anillos', async () => {
    const r = await runRemote(decl, ins, 'if [ -f "$VO_TOOL" ]; then sh "$VO_TOOL" status; else echo "NOTOOL $VO_TOOL"; fi')
    for (const l of r.lines) out(`     ${l}`)
    const nodeVer = r.lines.map((l) => /activo:\s*([0-9][^\s]*)/.exec(l)?.[1]).find(Boolean)
    const pv = pluginVersion()
    if (pv && nodeVer && pv !== nodeVer) out(`   ℹ el plugin es ${pv} y el nodo activo corre ${nodeVer}: normal por el lockstep (lo posterior se lee del nodo), pero una actualización pendiente del plugin no debería pasar inadvertida`)
    return r.lines.some((l) => l.startsWith('NOTOOL')) ? EXIT.PARTIAL : EXIT.OK
  }))
  if (ins.mirror) {
    codes.push(await paso('parity', async () => {
      const p = await measureParity(decl, ins)
      for (const l of p.lines) out(`  ${l}`)
      return p.code
    }))
  } else out('   parity: la instalación no declara mirror.families — no hay espejo contra el cual medir')
  const code = worst(codes)
  out(code === EXIT.OK ? '✓ RECON LIMPIO (exit 0): se puede partir de acá.' : `⚠ RECON (exit ${code}): lo de arriba se reporta ANTES de actuar, no se repara de paso.`)
  return code
}
