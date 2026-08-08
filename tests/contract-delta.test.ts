// DELTA DEL CONTRATO OPERATIVO ENTRE VERSIONES (issue #139, Nivel 2).
//
// La aceptación está primero: el replay del incidente del 2026-08-07 — cuando apareció el watch de
// políticas, la regla del operador «restart solo por tabla gobernada nueva» quedó obsoleta y nadie se
// lo dijo. El delta computado la nombra obsoleta solo: `watches.added` trae el watch y
// `env.nowReloadable` trae `VERGIS_POLICIES`.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContractSnapshot } from '../server/contract'
import {
  projectContract,
  projectionHash,
  diffProjections,
  createContractJournal,
  JOURNAL_RETENTION,
  type ContractProjection,
} from '../server/contract-delta'

function work(): string {
  return mkdtempSync(join(tmpdir(), 'vergis-delta-'))
}

/** Snapshot fabricado: el arnés inyecta la versión acá (VERGIS_VERSION es import build-time). */
function snap(over: Partial<ContractSnapshot> = {}): ContractSnapshot {
  return {
    version: '0.15.0',
    engine: 'fabric',
    startedAt: '2026-08-08T00:00:00.000Z',
    hotReload: true,
    watches: [],
    signals: [],
    reloads: { last: null, recent: [] },
    artifacts: [],
    env: { bootOnly: [], reloadableContent: [], unknown: [] },
    caveats: [],
    ...over,
  }
}

const journalPath = (dir: string): string => join(dir, 'contrato', 'journal.json')
const readJournal = (dir: string): { entries: { version: string; boots: number; projection: ContractProjection }[] } =>
  JSON.parse(readFileSync(journalPath(dir), 'utf8')) as never

// ── 1 y 2 · el costo asimétrico en ambas direcciones ───────────────────────────────────────────────
describe('delta · replay del incidente 2026-08-07 (aceptación del Nivel 2)', () => {
  it('el watch de políticas que aparece INVALIDA la regla del operador: added + nowReloadable', () => {
    const antes = projectContract(
      snap({
        watches: [{ envs: ['VERGIS_SPECS_DIR'], paths: ['/specs'], reloads: 'specs: rebuild del descubrimiento' }],
        env: { bootOnly: ['VERGIS_POLICIES', 'PORT'], reloadableContent: ['VERGIS_SPECS_DIR'], unknown: [] },
      }),
    )
    const despues = projectContract(
      snap({
        watches: [
          { envs: ['VERGIS_SPECS_DIR'], paths: ['/specs'], reloads: 'specs: rebuild del descubrimiento' },
          { envs: ['VERGIS_POLICIES'], paths: ['/policies/p.yaml'], reloads: 'gobierno completo: validate-before-swap' },
        ],
        env: { bootOnly: ['PORT'], reloadableContent: ['VERGIS_POLICIES', 'VERGIS_SPECS_DIR'], unknown: [] },
      }),
    )
    const d = diffProjections(antes, despues)
    expect(d.watches.added).toEqual([
      { envs: ['VERGIS_POLICIES'], reloads: 'gobierno completo: validate-before-swap' },
    ])
    expect(d.watches.removed).toEqual([])
    // EL dato que invalida la regla vieja: cambiar políticas ya NO exige restart.
    expect(d.env.nowReloadable).toEqual(['VERGIS_POLICIES'])
    expect(d.env.nowBootOnly).toEqual([])
    // No es un added/removed disfrazado: la clave ya existía, cambió de clase.
    expect(d.env.added).toEqual([])
    expect(d.env.removed).toEqual([])
  })

  it('la reclasificación inversa se nombra sola: reloadable → bootOnly ⇒ nowBootOnly (AHORA exige restart)', () => {
    const antes = projectContract(snap({ env: { bootOnly: [], reloadableContent: ['VERGIS_POLICIES'], unknown: [] } }))
    const despues = projectContract(snap({ env: { bootOnly: ['VERGIS_POLICIES'], reloadableContent: [], unknown: [] } }))
    const d = diffProjections(antes, despues)
    expect(d.env.nowBootOnly).toEqual(['VERGIS_POLICIES'])
    expect(d.env.nowReloadable).toEqual([])
  })

  it('altas y bajas de env viajan con su clase', () => {
    const antes = projectContract(snap({ env: { bootOnly: ['VERGIS_ANNOTATION_SECRET'], reloadableContent: [], unknown: [] } }))
    const despues = projectContract(snap({ env: { bootOnly: ['VERGIS_PDF_TIMEOUT_MS'], reloadableContent: [], unknown: [] } }))
    const d = diffProjections(antes, despues)
    expect(d.env.added).toEqual([{ key: 'VERGIS_PDF_TIMEOUT_MS', class: 'bootOnly' }])
    expect(d.env.removed).toEqual([{ key: 'VERGIS_ANNOTATION_SECRET', class: 'bootOnly' }])
  })
})

// ── 3 · identidad de un watch (D7) ─────────────────────────────────────────────────────────────────
describe('delta · identidad de un watch para el diff (D7)', () => {
  const w = (envs: string[], reloads: string): ContractSnapshot['watches'][0] => ({ envs, paths: ['/x'], reloads })

  it('mismos envs y `reloads` reescrito ⇒ modified (no added+removed)', () => {
    const d = diffProjections(
      projectContract(snap({ watches: [w(['VERGIS_POLICIES'], 'recarga políticas')] })),
      projectContract(snap({ watches: [w(['VERGIS_POLICIES'], 'gobierno completo: validate-before-swap')] })),
    )
    expect(d.watches.added).toEqual([])
    expect(d.watches.removed).toEqual([])
    expect(d.watches.modified).toEqual([
      {
        before: { envs: ['VERGIS_POLICIES'], reloads: 'recarga políticas' },
        after: { envs: ['VERGIS_POLICIES'], reloads: 'gobierno completo: validate-before-swap' },
      },
    ])
  })

  it('mismo `reloads` y envs distintos ⇒ modified (cambió qué envs configuran el watch)', () => {
    const d = diffProjections(
      projectContract(snap({ watches: [w(['VERGIS_DOMAIN'], 'gobierno de dominio')] })),
      projectContract(snap({ watches: [w(['VERGIS_DOMAIN', 'VERGIS_INTAKE'], 'gobierno de dominio')] })),
    )
    expect(d.watches.modified).toHaveLength(1)
    expect(d.watches.modified[0].after.envs).toEqual(['VERGIS_DOMAIN', 'VERGIS_INTAKE'])
    expect(d.watches.added).toEqual([])
    expect(d.watches.removed).toEqual([])
  })

  it('envs y `reloads` ambos distintos ⇒ added + removed (son watches distintos)', () => {
    const d = diffProjections(
      projectContract(snap({ watches: [w(['VERGIS_A'], 'recarga A')] })),
      projectContract(snap({ watches: [w(['VERGIS_B'], 'recarga B')] })),
    )
    expect(d.watches.added).toEqual([{ envs: ['VERGIS_B'], reloads: 'recarga B' }])
    expect(d.watches.removed).toEqual([{ envs: ['VERGIS_A'], reloads: 'recarga A' }])
    expect(d.watches.modified).toEqual([])
  })

  it('señales por clave natural: `action` distinto ⇒ modified; señal nueva ⇒ added', () => {
    const d = diffProjections(
      projectContract(snap({ signals: [{ signal: 'SIGHUP', action: 'recarga gobierno' }] })),
      projectContract(
        snap({
          signals: [
            { signal: 'SIGHUP', action: 'recarga completa de gobierno + specs' },
            { signal: 'SIGTERM', action: 'apagado ordenado' },
          ],
        }),
      ),
    )
    expect(d.signals.modified).toEqual([
      { before: { signal: 'SIGHUP', action: 'recarga gobierno' }, after: { signal: 'SIGHUP', action: 'recarga completa de gobierno + specs' } },
    ])
    expect(d.signals.added).toEqual([{ signal: 'SIGTERM', action: 'apagado ordenado' }])
    expect(d.signals.removed).toEqual([])
  })

  it('un caveat reescrito aparece como removed + added (el texto ES el contrato del caveat)', () => {
    const d = diffProjections(
      projectContract(snap({ caveats: ['un pool abierto conserva sus credenciales'] })),
      projectContract(snap({ caveats: ['un pool ya abierto conserva sus credenciales hasta el restart'] })),
    )
    expect(d.caveats.removed).toEqual(['un pool abierto conserva sus credenciales'])
    expect(d.caveats.added).toEqual(['un pool ya abierto conserva sus credenciales hasta el restart'])
  })
})

// ── 4 · la proyección (D2) ─────────────────────────────────────────────────────────────────────────
describe('delta · proyección diffable (D2)', () => {
  const ruidosa = snap({
    startedAt: '2026-08-08T11:22:33.000Z',
    watches: [{ envs: ['VERGIS_POLICIES'], paths: ['/policies/instancia-acme.yaml'], reloads: 'gobierno' }],
    reloads: { last: { at: 'x', reason: 'boot', ok: true }, recent: [{ at: 'x', reason: 'boot', ok: true }] },
    artifacts: [
      { source: 'policies', path: '/policies/instancia-acme.yaml', sha256: 'abc', loadedAt: 'x', diskSha256: 'abc', pending: false },
    ],
    env: { bootOnly: ['PORT'], reloadableContent: ['VERGIS_POLICIES'], unknown: ['VERGIS_TYPO_DE_ESTA_INSTANCIA'] },
  })

  it('descarta paths, artifacts, reloads, startedAt y env.unknown — solo NOMBRES y textos autorados', () => {
    const p = projectContract(ruidosa)
    const body = JSON.stringify(p)
    expect(body).not.toContain('/policies/instancia-acme.yaml')
    expect(body).not.toContain('VERGIS_TYPO_DE_ESTA_INSTANCIA')
    expect(body).not.toContain('2026-08-08T11:22:33.000Z')
    expect(body).not.toContain('abc')
    expect(Object.keys(p).sort()).toEqual(['caveats', 'env', 'signals', 'watches'])
    expect(Object.keys(p.env).sort()).toEqual(['bootOnly', 'reloadableContent'])
    expect(p.watches).toEqual([{ envs: ['VERGIS_POLICIES'], reloads: 'gobierno' }])
  })

  it('es determinista: dos snapshots con los arreglos permutados dan la MISMA huella', () => {
    const a = snap({
      watches: [
        { envs: ['B_ENV', 'A_ENV'], paths: ['/1'], reloads: 'zeta' },
        { envs: ['C_ENV'], paths: ['/2'], reloads: 'alfa' },
      ],
      signals: [
        { signal: 'SIGTERM', action: 'apaga' },
        { signal: 'SIGHUP', action: 'recarga' },
      ],
      env: { bootOnly: ['Z', 'A'], reloadableContent: ['C_ENV', 'A_ENV', 'B_ENV'], unknown: ['RUIDO'] },
      caveats: ['segundo', 'primero'],
    })
    const b = snap({
      watches: [
        { envs: ['C_ENV'], paths: ['/otro-path'], reloads: 'alfa' },
        { envs: ['A_ENV', 'B_ENV'], paths: ['/1'], reloads: 'zeta' },
      ],
      signals: [
        { signal: 'SIGHUP', action: 'recarga' },
        { signal: 'SIGTERM', action: 'apaga' },
      ],
      env: { bootOnly: ['A', 'Z'], reloadableContent: ['A_ENV', 'B_ENV', 'C_ENV'], unknown: [] },
      caveats: ['primero', 'segundo'],
    })
    expect(projectionHash(projectContract(a))).toBe(projectionHash(projectContract(b)))
    expect(diffProjections(projectContract(a), projectContract(b))).toEqual(
      diffProjections(projectContract(a), projectContract(a)),
    )
  })
})

// ── 5 · el journal (D3, D4) ────────────────────────────────────────────────────────────────────────
describe('delta · journal persistente (D3, D4)', () => {
  it('el primer `observe` crea <dir>/contrato/journal.json con la entrada de la versión', () => {
    const dir = work()
    createContractJournal({ dir }).observe(snap({ version: '0.15.0' }))
    expect(existsSync(journalPath(dir))).toBe(true)
    const j = readJournal(dir)
    expect(j.entries).toHaveLength(1)
    expect(j.entries[0]).toMatchObject({ version: '0.15.0', boots: 1 })
    rmSync(dir, { recursive: true, force: true })
  })

  it('segundo boot, misma versión y contexto ⇒ UNIÓN: la env vista solo en el boot 1 sobrevive y `boots` sube', () => {
    const dir = work()
    // Boot 1: rama con Miranda encendida (su env se consume).
    createContractJournal({ dir }).observe(snap({ env: { bootOnly: ['MIRANDA_MODEL', 'PORT'], reloadableContent: [], unknown: [] } }))
    // Boot 2 (proceso nuevo, misma versión): Miranda apagada — su clave no se consume en ESTA rama.
    createContractJournal({ dir }).observe(snap({ env: { bootOnly: ['PORT'], reloadableContent: [], unknown: [] } }))
    const e = readJournal(dir).entries[0]
    expect(e.boots).toBe(2)
    // Dentro de una versión el contrato real no se achica: el «encogimiento» es una rama no tomada.
    expect(e.projection.env.bootOnly).toEqual(['MIRANDA_MODEL', 'PORT'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('contexto distinto ⇒ REEMPLAZO: ninguna clave queda a la vez bootOnly y reloadable (nada de quimeras)', () => {
    const dir = work()
    createContractJournal({ dir }).observe(
      snap({ hotReload: true, watches: [{ envs: ['VERGIS_POLICIES'], paths: ['/p'], reloads: 'gobierno' }], env: { bootOnly: [], reloadableContent: ['VERGIS_POLICIES'], unknown: [] } }),
    )
    // El operador apagó el hot-reload bajo la MISMA versión: sin watches, la clave vuelve a bootOnly.
    createContractJournal({ dir }).observe(
      snap({ hotReload: false, watches: [], env: { bootOnly: ['VERGIS_POLICIES'], reloadableContent: [], unknown: [] } }),
    )
    const e = readJournal(dir).entries[0]
    expect(e.projection.env.bootOnly).toEqual(['VERGIS_POLICIES'])
    expect(e.projection.env.reloadableContent).toEqual([])
    expect(e.projection.watches).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it('versión nueva ⇒ append, y la referencia por recencia apunta a la anterior', () => {
    const dir = work()
    createContractJournal({ dir }).observe(snap({ version: '0.15.0' }))
    const j2 = createContractJournal({ dir })
    const s16 = snap({ version: '0.16.0', watches: [{ envs: ['VERGIS_POLICIES'], paths: ['/p'], reloads: 'gobierno' }], env: { bootOnly: [], reloadableContent: ['VERGIS_POLICIES'], unknown: [] } })
    j2.observe(s16)
    expect(readJournal(dir).entries).toHaveLength(2)
    const d = j2.delta(s16)!
    expect(d.reason).toBeNull()
    expect(d.reference).toMatchObject({ version: '0.15.0', engine: 'fabric', hotReload: true })
    expect(d.unchanged).toBe(false)
    expect(d.changes!.watches.added).toEqual([{ envs: ['VERGIS_POLICIES'], reloads: 'gobierno' }])
    expect(j2.versions()).toEqual(['0.15.0', '0.16.0'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('rollback 0.16 → 0.15: la referencia es 0.16 (recencia de la instancia, no orden semver)', () => {
    const dir = work()
    let t = Date.parse('2026-08-01T00:00:00.000Z')
    const clock = (): Date => new Date((t += 60_000))
    createContractJournal({ dir, now: clock }).observe(snap({ version: '0.15.0' }))
    createContractJournal({ dir, now: clock }).observe(snap({ version: '0.16.0' }))
    const j3 = createContractJournal({ dir, now: clock })
    const s15 = snap({ version: '0.15.0' })
    j3.observe(s15)
    expect(j3.delta(s15)!.reference!.version).toBe('0.16.0')
    rmSync(dir, { recursive: true, force: true })
  })

  it(`conserva ${JOURNAL_RETENTION} entradas por recencia sin expulsar jamás la de la versión corriente`, () => {
    const dir = work()
    let t = Date.parse('2026-01-01T00:00:00.000Z')
    const clock = (): Date => new Date((t += 60_000))
    // La 0.0.0 es la MÁS ANTIGUA; luego corren JOURNAL_RETENTION versiones nuevas… y al final vuelve.
    createContractJournal({ dir, now: clock }).observe(snap({ version: '0.0.0' }))
    for (let i = 1; i <= JOURNAL_RETENTION; i += 1) {
      createContractJournal({ dir, now: clock }).observe(snap({ version: `9.${i}.0` }))
    }
    const j = createContractJournal({ dir, now: clock })
    j.observe(snap({ version: '0.0.0' }))
    const vs = j.versions()
    expect(vs).toHaveLength(JOURNAL_RETENTION)
    expect(vs).toContain('0.0.0')
    rmSync(dir, { recursive: true, force: true })
  })

  it('archivo corrupto ⇒ se parte de journal vacío, no lanza, y la próxima persistencia lo sobrescribe', () => {
    const dir = work()
    createContractJournal({ dir }).observe(snap({ version: '0.15.0' }))
    writeFileSync(journalPath(dir), '{esto no es json')
    const j = createContractJournal({ dir })
    expect(j.versions()).toEqual([])
    const s = snap({ version: '0.16.0' })
    expect(() => j.observe(s)).not.toThrow()
    expect(j.delta(s)!.reason).toBe('primer-registro')
    expect(readJournal(dir).entries.map((e) => e.version)).toEqual(['0.16.0'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('`version: null` (ausencia honesta del build) ⇒ no escribe journal y el delta lo dice', () => {
    const dir = work()
    const j = createContractJournal({ dir })
    const s = snap({ version: null })
    j.observe(s)
    expect(existsSync(journalPath(dir))).toBe(false)
    expect(j.delta(s)).toMatchObject({ reason: 'version-desconocida', reference: null, changes: null })
    rmSync(dir, { recursive: true, force: true })
  })

  it('directorio no escribible ⇒ `observe` no lanza y el delta reporta `journal-no-disponible`', () => {
    const dir = work()
    chmodSync(dir, 0o500) // r-x: no se puede crear <dir>/contrato
    const j = createContractJournal({ dir })
    const s = snap({ version: '0.15.0' })
    expect(() => j.observe(s)).not.toThrow()
    expect(j.delta(s)).toMatchObject({ reason: 'journal-no-disponible', reference: null, changes: null })
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  })

  it('un GET con la MISMA huella no reescribe el archivo (el GET típico no toca disco)', async () => {
    const dir = work()
    const j = createContractJournal({ dir })
    const s = snap({ version: '0.15.0' })
    j.observe(s) // boot
    const before = statSync(journalPath(dir)).mtimeMs
    await new Promise((r) => setTimeout(r, 10))
    j.observe(s) // GET
    j.observe(s) // GET
    expect(statSync(journalPath(dir)).mtimeMs).toBe(before)
    expect(readJournal(dir).entries[0].boots).toBe(1) // los GET no cuentan boots
    rmSync(dir, { recursive: true, force: true })
  })

  it('un GET con huella DISTINTA converge la entrada (lectura de env perezosa, D4·2)', () => {
    const dir = work()
    const j = createContractJournal({ dir })
    j.observe(snap({ version: '0.15.0', env: { bootOnly: ['PORT'], reloadableContent: [], unknown: [] } }))
    j.observe(snap({ version: '0.15.0', env: { bootOnly: ['PORT', 'VERGIS_TARDIA'], reloadableContent: [], unknown: [] } }))
    const e = readJournal(dir).entries[0]
    expect(e.projection.env.bootOnly).toEqual(['PORT', 'VERGIS_TARDIA'])
    expect(e.boots).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })
})

// ── 6 y 7 · unchanged y ?desde= ────────────────────────────────────────────────────────────────────
describe('delta · respuesta (D5, D6)', () => {
  it('proyecciones idénticas con referencia presente ⇒ unchanged:true («tus reglas siguen vigentes»)', () => {
    const dir = work()
    createContractJournal({ dir }).observe(snap({ version: '0.15.0', caveats: ['una limitación'] }))
    const j = createContractJournal({ dir })
    const s = snap({ version: '0.16.0', caveats: ['una limitación'] })
    j.observe(s)
    const d = j.delta(s)!
    expect(d.unchanged).toBe(true)
    expect(d.reference!.version).toBe('0.15.0')
    expect(d.changes).not.toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it('instancia virgen ⇒ primer-registro con changes null (no se inventa un delta contra la nada)', () => {
    const dir = work()
    const j = createContractJournal({ dir })
    const s = snap({ version: '0.15.0' })
    j.observe(s)
    expect(j.delta(s)).toMatchObject({ reason: 'primer-registro', reference: null, changes: null, unchanged: false })
    rmSync(dir, { recursive: true, force: true })
  })

  it('`desde` registrado diffea contra ESA entrada; no registrado ⇒ null (el handler arma el 404)', () => {
    const dir = work()
    let t = Date.parse('2026-01-01T00:00:00.000Z')
    const clock = (): Date => new Date((t += 60_000))
    createContractJournal({ dir, now: clock }).observe(snap({ version: '0.14.0', caveats: ['viejo'] }))
    createContractJournal({ dir, now: clock }).observe(snap({ version: '0.15.0', caveats: ['viejo'] }))
    const j = createContractJournal({ dir, now: clock })
    const s = snap({ version: '0.16.0', caveats: ['viejo', 'nuevo'] })
    j.observe(s)
    expect(j.delta(s)!.reference!.version).toBe('0.15.0') // por recencia
    const desde14 = j.delta(s, '0.14.0')!
    expect(desde14.reference!.version).toBe('0.14.0')
    expect(desde14.changes!.caveats.added).toEqual(['nuevo'])
    expect(j.delta(s, '0.9.0')).toBeNull()
    expect(j.versions()).toEqual(['0.14.0', '0.15.0', '0.16.0'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('`contextChanged` avisa cuando parte del delta puede deberse a la config, no a la versión', () => {
    const dir = work()
    createContractJournal({ dir }).observe(snap({ version: '0.15.0', engine: 'fabric', hotReload: true }))
    const j = createContractJournal({ dir })
    const s = snap({ version: '0.16.0', engine: 'clickhouse', hotReload: false })
    j.observe(s)
    expect(j.delta(s)!.contextChanged).toEqual({
      engine: { reference: 'fabric', current: 'clickhouse' },
      hotReload: { reference: true, current: false },
    })
    rmSync(dir, { recursive: true, force: true })
  })

  it('el delta JAMÁS expone valores de env ni paths de instancia', () => {
    const dir = work()
    createContractJournal({ dir }).observe(snap({ version: '0.15.0' }))
    const j = createContractJournal({ dir })
    const s = snap({
      version: '0.16.0',
      watches: [{ envs: ['VERGIS_POLICIES'], paths: ['/policies/acme-secreto.yaml'], reloads: 'gobierno' }],
      env: { bootOnly: [], reloadableContent: ['VERGIS_POLICIES'], unknown: ['VERGIS_TYPO'] },
    })
    j.observe(s)
    const body = JSON.stringify(j.delta(s))
    expect(body).toContain('VERGIS_POLICIES')
    expect(body).not.toContain('/policies/acme-secreto.yaml')
    expect(body).not.toContain('VERGIS_TYPO')
    expect(readFileSync(journalPath(dir), 'utf8')).not.toContain('/policies/acme-secreto.yaml')
    rmSync(dir, { recursive: true, force: true })
  })
})
