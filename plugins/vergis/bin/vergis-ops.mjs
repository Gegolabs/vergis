#!/usr/bin/env node
// vergis-ops — el CLI del plugin `vergis`: opera UNA instalación de Vergis declarada en el
// `vergis-ops.json` del repo del operador. Node ≥ 22, sin dependencias.
//
// Verbos:
//   check                          ¿la declaración se puede usar? (local; 0 o 2)
//   recon                          check + health + contract + parity + estado de anillos, sin tocar nada
//   health                         el predicado canónico por el borde, y la fase de cada anillo
//   contract [classify <archivo> | wait <archivo> | env <VAR>]
//                                  lo que el NODO declara: qué recarga en caliente, qué tomó
//   smoke [<ruta> [--needle t]…] [--identity id] [--rls]
//                                  todas las vistas de todos los Lets (o una ruta), con needles y RLS
//   marks calibrar|contar|vigencia|ruta …
//                                  marcas de dato con su corrida discriminante
//   parity [--family id] [--dry-run]
//                                  espejo↔host por sha256, con la guardia G1
//   poller start|stop|count|cn1 …  el poller de corte (RUNBOOK §0.3) y su control negativo
//   publish <archivo> [--pretest …] [--window …] [--impact …] [--approval …]
//                                  publicar un archivo del espejo, con respaldo y verificación de sha
//   exec service <nombre> reload|recreate|prevalidate · exec rollout <acto> … · exec run --class <c> -- <sh>
//                                  un acto gobernado: clasificado, con su gate
//
// Opciones globales: --installation <id> · --declaration <ruta> (solo pruebas, solo transporte local)
//
// Salida (D7): 0 medí · 1 hallazgo · 2 no corrí · 3 respuesta cruzada · 4 transporte ocupado ·
//              5 remoto mudo · 6 transporte · 7 medí a medias.

import { EXIT, EXIT_NAME, OpsExit, err } from '../lib/util.mjs'

const [major] = process.versions.node.split('.').map(Number)
if (major < 22) {
  err(`vergis-ops: exige Node ≥ 22 (corre ${process.versions.node}). La skill vergis:setup dice cómo instalarlo.`)
  process.exit(EXIT.NOT_RUN)
}

/** Separa opciones `--k v` / `--flag` de posicionales. `--` corta: lo que sigue es literal. */
export function parseArgs(argv, flags = new Set()) {
  const o = { _: [], rest: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      o.rest = argv.slice(i + 1)
      break
    }
    if (a.startsWith('--')) {
      const k = a.slice(2)
      if (flags.has(k)) o[k] = true
      else {
        const v = argv[i + 1]
        if (v === undefined) throw new OpsExit(EXIT.NOT_RUN, `--${k} exige un valor`)
        if (Array.isArray(o[k])) o[k].push(v)
        else if (o[k] !== undefined) o[k] = [o[k], v]
        else o[k] = v
        i++
      }
    } else o._.push(a)
  }
  return o
}

const FLAGS = new Set(['dry-run', 'json', 'rls', 'help', 'no-pull', 'redigest', 'rmi', 'apply', 'no-schema-gate', 'keep-tool'])

async function main() {
  const argv = process.argv.slice(2)
  const verb = argv[0]
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
    const fin = src.findIndex((l, i) => i > 1 && !l.startsWith('//'))
    process.stdout.write(src.slice(1, fin).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n')
    return verb ? EXIT.OK : EXIT.NOT_RUN
  }
  const o = parseArgs(argv.slice(1), FLAGS)
  const common = { cwd: process.cwd(), flag: o.declaration, installation: o.installation }
  switch (verb) {
    case 'check':
      return (await import('../lib/check.mjs')).runCheck(common)
    case 'recon':
      return (await import('../lib/recon.mjs')).runRecon(common, o)
    case 'health':
      return (await import('../lib/health.mjs')).runHealth(common, o)
    case 'contract':
      return (await import('../lib/contract.mjs')).runContract(common, o)
    case 'smoke':
      return (await import('../lib/smoke.mjs')).runSmoke(common, o)
    case 'marks':
      return (await import('../lib/marks.mjs')).runMarks(common, o)
    case 'parity':
      return (await import('../lib/parity.mjs')).runParity(common, o)
    case 'poller':
      return (await import('../lib/poller.mjs')).runPoller(common, o)
    case 'publish':
      return (await import('../lib/publish.mjs')).runPublish(common, o)
    case 'exec':
      return (await import('../lib/exec.mjs')).runExec(common, o)
    default:
      throw new OpsExit(EXIT.NOT_RUN, `verbo desconocido «${verb}» (check · recon · health · contract · smoke · marks · parity · poller · publish · exec)`)
  }
}

main().then(
  (code) => process.exit(code ?? EXIT.OK),
  (e) => {
    if (e instanceof OpsExit) {
      err(`✗ ${EXIT_NAME[e.code] ?? ''} (exit ${e.code}): ${e.message}`)
      process.exit(e.code)
    }
    err(`✗ NO CORRÍ (exit 2): error inesperado del CLI — ${e?.stack ?? e}`)
    process.exit(EXIT.NOT_RUN)
  },
)
