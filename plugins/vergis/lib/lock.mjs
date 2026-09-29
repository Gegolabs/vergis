// lock.mjs — el CANDADO por instalación, en la máquina del operador (D7).
//
// Existe porque un canal como `az vm run-command` se serializa en el host: dos instrumentos lanzados a
// la vez no se suman, se pisan (`Conflict`, o peor, la respuesta de uno le llega al otro). El candado
// hace que dos corridas del plugin contra la MISMA instalación se esperen en vez de competir. No
// elimina la serialización —es de Azure—: la reduce a colisiones con actores ajenos al plugin.
//
// `mkdir` es atómico en un FS local: el primero que lo crea gana. Un candado cuyo dueño ya no vive
// (mismo host, pid muerto) se recupera; uno de otro host o con el pid vivo, se espera.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { EXIT, fail, sha256, sleep } from './util.mjs'
import { stateDir } from './state.mjs'

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

export async function withLock(declPath, installationId, fn, { waitMs } = {}) {
  const dir = join(stateDir(), 'locks')
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, `${sha256(`${declPath}#${installationId}`).slice(0, 16)}.lock`)
  const budget = waitMs ?? Number(process.env.VERGIS_OPS_LOCK_WAIT_MS ?? 120_000)
  const t0 = Date.now()
  let announced = false
  for (;;) {
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), installation: installationId }))
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let owner = null
      try {
        owner = JSON.parse(readFileSync(join(lock, 'owner'), 'utf8'))
      } catch {
        // Recién creado y sin dueño escrito todavía: se espera un tick.
      }
      if (owner && owner.host === hostname() && !alive(owner.pid)) {
        rmSync(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() - t0 > budget) {
        fail(EXIT.BUSY, `transporte ocupado: otra corrida de vergis-ops opera «${installationId}» (${owner ? `pid ${owner.pid} en ${owner.host}, desde ${owner.at}` : 'dueño ilegible'}) y no soltó el candado en ${Math.round(budget / 1000)} s. No se intercala: se espera o se reintenta.`)
      }
      if (!announced) {
        process.stderr.write(`⏳ otra corrida de vergis-ops opera «${installationId}»${owner ? ` (pid ${owner.pid})` : ''}: espero el candado…\n`)
        announced = true
      }
      await sleep(250)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}
