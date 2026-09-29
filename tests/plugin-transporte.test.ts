/**
 * PLUGIN `vergis` · V3 — el transporte con contrato cerrado (D7).
 *
 * Con un `az` y un `ssh` FALSOS (`tests/fixtures/plugin/fake-*.sh`) se reproducen las caras del canal que
 * el lab midió en producción, y se afirma que el CLI las nombra con el código correcto en vez de
 * confundirlas: sin centinela → 5 · centinela de otro nonce → 3 · cortada antes del centinela → 5 ·
 * cortada por el principio → 7 · `Conflict` persistente → 4 · cuenta distinta de `expected_account` →
 * 2 SIN ejecutar nada · dos corridas a la vez contra la misma instalación → no se intercalan.
 *
 * Cada caso lleva su control positivo (el mismo fake en modo `ok` sale 0): sin él, un transporte que
 * siempre fallara pasaría todos los casos negativos.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cli, cliAsync, declarar, FIX, minima, tmp } from './plugin-helpers'

const AZ = join(FIX, 'fake-az.sh')
const SSH = join(FIX, 'fake-ssh.sh')

function azDecl(root: string): string {
  return declarar(
    minima(
      {
        transport: { kind: 'az-run-command', resource_group: 'rg-prueba', vm: 'vm-prueba', expected_account: 'op@ejemplo.test' },
        governance: { gates: { read: 'free' } },
      },
      root,
    ),
  )
}

const ECO = ['exec', 'run', '--class', 'read', '--', 'echo hola-desde-el-host; echo segunda-linea']

describe('transporte az-run-command con un az falso', () => {
  const root = tmp()
  const dir = azDecl(root)
  const env = (mode: string, extra: Record<string, string> = {}) => ({ VERGIS_OPS_AZ: AZ, FAKE_AZ_MODE: mode, VERGIS_OPS_STATE_DIR: tmp(), ...extra })

  it('control positivo: modo ok sale 0 y entrega la salida del host', () => {
    const r = cli(ECO, { cwd: dir, env: env('ok') })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/hola-desde-el-host/)
    expect(r.out).toMatch(/segunda-linea/)
  })

  it('salida sin centinela → 5 (remoto mudo)', () => {
    const r = cli(ECO, { cwd: dir, env: env('mute') })
    expect(r.code, r.all).toBe(5)
    expect(r.all).toMatch(/remoto mudo/)
  })

  it('centinela de otro nonce → 3 (respuesta cruzada), tras reintentar', () => {
    const r = cli(ECO, { cwd: dir, env: env('cross') })
    expect(r.code, r.all).toBe(3)
    expect(r.all).toMatch(/respuesta cruzada/)
    expect(r.all).not.toMatch(/hola-desde-el-host/) // el resultado de OTRA corrida no se entrega
  })

  it('salida truncada antes del centinela → 5', () => {
    const r = cli(ECO, { cwd: dir, env: env('truncate') })
    expect(r.code, r.all).toBe(5)
  })

  it('salida cortada por el principio (centinela presente, faltan líneas) → 7', () => {
    const r = cli(ECO, { cwd: dir, env: env('headcut') })
    expect(r.code, r.all).toBe(7)
    expect(r.all).toMatch(/salida cortada por el transporte/)
  })

  it('Conflict persistente → 4', () => {
    const r = cli(ECO, { cwd: dir, env: env('conflict') })
    expect(r.code, r.all).toBe(4)
    expect(r.all).toMatch(/Conflict/)
  })

  it('cuenta distinta de expected_account → 2 SIN ejecutar nada en el host', () => {
    const log = join(tmp(), 'az.log')
    const r = cli(ECO, { cwd: dir, env: env('ok', { FAKE_AZ_ACCOUNT: 'otra@ejemplo.test', FAKE_LOG: log }) })
    expect(r.code, r.all).toBe(2)
    expect(r.all).toMatch(/exige «op@ejemplo\.test»/)
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').not.toMatch(/start/) // run-command jamás se invocó
  })

  it('dos corridas simultáneas contra la misma instalación no se intercalan (candado)', async () => {
    const log = join(tmp(), 'az.log')
    const state = tmp()
    const e = { VERGIS_OPS_AZ: AZ, FAKE_AZ_MODE: 'slow', FAKE_AZ_SLEEP: '2', FAKE_LOG: log, VERGIS_OPS_STATE_DIR: state }
    const [a, b] = await Promise.all([cliAsync(ECO, { cwd: dir, env: e }), cliAsync(ECO, { cwd: dir, env: e })])
    expect(a.code, a.all).toBe(0)
    expect(b.code, b.all).toBe(0)
    const ev = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' '))
    expect(ev.map((x) => x[0])).toEqual(['start', 'end', 'start', 'end']) // nunca start,start
    expect(Number(ev[2]![1])).toBeGreaterThanOrEqual(Number(ev[1]![1]))
    expect(a.all + b.all).toMatch(/espero el candado/)
  }, 30_000)

  it('el candado vence: con la otra corrida ocupándolo más allá de la espera → 4', async () => {
    const state = tmp()
    const e = { VERGIS_OPS_AZ: AZ, FAKE_AZ_MODE: 'slow', FAKE_AZ_SLEEP: '3', VERGIS_OPS_STATE_DIR: state }
    const larga = cliAsync(ECO, { cwd: dir, env: e })
    await new Promise((r) => setTimeout(r, 800))
    const corta = await cliAsync(ECO, { cwd: dir, env: { ...e, VERGIS_OPS_LOCK_WAIT_MS: '500' } })
    expect(corta.code, corta.all).toBe(4)
    expect(corta.all).toMatch(/transporte ocupado/)
    expect((await larga).code).toBe(0)
  }, 30_000)
})

describe('transporte ssh con un ssh falso', () => {
  const root = tmp()
  const dir = declarar(minima({ transport: { kind: 'ssh', host: 'h.ejemplo', user: 'op', sudo: true }, governance: { gates: { read: 'free' } } }, root))

  it('control positivo: corre con BatchMode y sudo sh -s', () => {
    const log = join(tmp(), 'ssh.log')
    const r = cli(ECO, { cwd: dir, env: { VERGIS_OPS_SSH: SSH, FAKE_LOG: log, VERGIS_OPS_STATE_DIR: tmp() } })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toMatch(/hola-desde-el-host/)
    const args = readFileSync(log, 'utf8')
    expect(args).toMatch(/BatchMode=yes/)
    expect(args).toMatch(/op@h\.ejemplo sudo sh -s/)
  })

  it('el transporte cae (ssh 255) → 6', () => {
    const r = cli(ECO, { cwd: dir, env: { VERGIS_OPS_SSH: SSH, FAKE_SSH_MODE: 'fail', VERGIS_OPS_STATE_DIR: tmp() } })
    expect(r.code, r.all).toBe(6)
  })
})

describe('el remoto no existe como la declaración dice', () => {
  it('la raíz de la instalación no existe en el host: el acto falla y se dice (exit 1), sin fingir éxito', () => {
    const dir = declarar(minima({ governance: { gates: { read: 'free' } } }, '/no/existe/vergis-ops'))
    const r = cli(ECO, { cwd: dir, env: { VERGIS_OPS_STATE_DIR: tmp() } })
    expect(r.code, r.all).toBe(1)
    expect(r.all).toMatch(/no existe en el host/)
  })
})
