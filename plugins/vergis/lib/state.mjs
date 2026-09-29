// state.mjs — el estado LOCAL del operador (candados, registro del poller y del CN-1, calibraciones
// de marcas). Vive fuera de cualquier repo: es de la máquina que opera, no de la instalación.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { sha256 } from './util.mjs'

export function stateDir() {
  const base = process.env.VERGIS_OPS_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'vergis-ops')
  mkdirSync(base, { recursive: true })
  return base
}

function recordPath(declPath, installationId, kind) {
  const dir = join(stateDir(), 'instalaciones', sha256(`${declPath}#${installationId}`).slice(0, 16))
  mkdirSync(dir, { recursive: true })
  return join(dir, `${kind}.json`)
}

export function readRecord(declPath, installationId, kind) {
  const p = recordPath(declPath, installationId, kind)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function writeRecord(declPath, installationId, kind, value) {
  writeFileSync(recordPath(declPath, installationId, kind), JSON.stringify(value, null, 2) + '\n')
}
