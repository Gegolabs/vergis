// #348 — un dataset declarado en dos archivos de VERGIS_POLICIES. Dentro de un archivo el duplicado ya
// era fail-loud (`dataset-duplicate`); entre archivos ganaba el último de la lista sin decir nada, y un
// `grant: all` posterior podía pisar una RLS. Se prueba en tres alturas: la fusión pura, la recarga en
// caliente (validate-before-swap) y el arranque REAL de serve-rls (proceso aparte, como #228).

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { VergisError } from '@vergis/botler'
import { isPublic, mergePolicyStores, parsePolicyStore } from '@vergis/policy'
import { loadPolicyStore, reloadPolicyStoreInPlace } from '../server/policy-store-load'

const RLS = `policies:\n  - dataset: dbo.fact_saldos\n    rls: [{ column: empresa, claim: groups, op: in }]\n    default: deny\n`
const GRANT = `policies:\n  - dataset: dbo.fact_saldos\n    grant: all\n`
const OTRO = `policies:\n  - dataset: dbo.dim_empresa\n    grant: all\n`

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'vergis-348-'))
}
function archivo(d: string, nombre: string, contenido: string): string {
  const p = join(d, nombre)
  writeFileSync(p, contenido, 'utf8')
  return p
}
/** El error estructurado que lanzó `fn`, o falla el test si no lanzó. */
function lanzado(fn: () => unknown): VergisError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(VergisError)
    return e as VergisError
  }
  throw new Error('no lanzó')
}

describe('#348 · fusión de archivos del policy store', () => {
  it('rls en el primero y grant: all en el segundo ⇒ lanza nombrando los DOS archivos (el orden que motivó la regla)', () => {
    const files = [
      { path: '/gov/finanzas.yaml', policies: parsePolicyStore({ policies: [{ dataset: 'dbo.fact_saldos', rls: [{ column: 'empresa', claim: 'groups', op: 'in' }], default: 'deny' }] }) },
      { path: '/gov/cartera.yaml', policies: parsePolicyStore({ policies: [{ dataset: 'dbo.fact_saldos', grant: 'all' }] }) },
    ]
    const e = lanzado(() => mergePolicyStores(files))
    expect(e.structured.code).toBe('dataset-duplicate-across-files')
    expect(e.structured.value).toEqual(['/gov/finanzas.yaml', '/gov/cartera.yaml'])
    expect(e.message).toContain('/gov/finanzas.yaml')
    expect(e.message).toContain('/gov/cartera.yaml')
  })

  it('el orden inverso (grant: all primero) lanza igual: la RLS no depende de la posición en la lista', () => {
    const files = [
      { path: 'b.yaml', policies: parsePolicyStore({ policies: [{ dataset: 'dbo.fact_saldos', grant: 'all' }] }) },
      { path: 'a.yaml', policies: parsePolicyStore({ policies: [{ dataset: 'dbo.fact_saldos', rls: [{ column: 'empresa', claim: 'groups', op: 'in' }], default: 'deny' }] }) },
    ]
    expect(lanzado(() => mergePolicyStores(files)).structured.code).toBe('dataset-duplicate-across-files')
  })

  it('declaraciones IDÉNTICAS en dos archivos también lanzan (elección registrada en el PR: un dato, un solo lugar)', () => {
    const decl = { policies: [{ dataset: 'dbo.fact_saldos', grant: 'all' }] }
    const files = [
      { path: 'a.yaml', policies: parsePolicyStore(decl) },
      { path: 'b.yaml', policies: parsePolicyStore(decl) },
    ]
    expect(lanzado(() => mergePolicyStores(files)).structured.code).toBe('dataset-duplicate-across-files')
  })

  it('control: datasets distintos en archivos distintos se funden sin error', () => {
    const d = dir()
    const m = loadPolicyStore([archivo(d, 'a.yaml', RLS), archivo(d, 'b.yaml', OTRO)])
    expect([...m.keys()].sort()).toEqual(['dbo.dim_empresa', 'dbo.fact_saldos'])
    expect(isPublic(m.get('dbo.fact_saldos')!)).toBe(false)
  })
})

describe('#348 · recarga en caliente: la colisión se rechaza y el store vigente sigue sirviendo', () => {
  it('un segundo archivo editado para declarar el mismo dataset con grant: all NO pisa la RLS vigente', () => {
    const d = dir()
    const a = archivo(d, 'finanzas.yaml', RLS)
    const b = archivo(d, 'cartera.yaml', OTRO)
    const store = loadPolicyStore([a, b])
    const referencia = store
    expect(isPublic(store.get('dbo.fact_saldos')!)).toBe(false)

    writeFileSync(b, GRANT + `  - dataset: dbo.dim_empresa\n    grant: all\n`, 'utf8')
    const r = reloadPolicyStoreInPlace(store, [a, b])

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain(a)
      expect(r.error).toContain(b)
    }
    expect(store).toBe(referencia)
    expect(store.size).toBe(2)
    expect(isPublic(store.get('dbo.fact_saldos')!), 'la recarga rechazada abrió la RLS').toBe(false)
  })

  it('control: una recarga sin colisión SÍ reemplaza el contenido en la misma referencia', () => {
    const d = dir()
    const a = archivo(d, 'a.yaml', RLS)
    const store = loadPolicyStore([a])
    writeFileSync(a, GRANT, 'utf8')
    expect(reloadPolicyStoreInPlace(store, [a])).toEqual({ ok: true })
    expect(isPublic(store.get('dbo.fact_saldos')!)).toBe(true)
  })
})

const RAIZ = resolve(__dirname, '..')
const TSX = join(RAIZ, 'node_modules', '.bin', 'tsx')

function arrancar(policies: string[]): { status: number | null; salida: string } {
  const d = dir()
  mkdirSync(join(d, 'out'))
  mkdirSync(join(d, 'specs'))
  const r = spawnSync(TSX, [join(RAIZ, 'server', 'serve-rls.ts')], {
    cwd: RAIZ,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      VERGIS_ENGINE: 'clickhouse',
      VERGIS_OUT: join(d, 'out'),
      VERGIS_SPECS_DIR: join(d, 'specs'),
      VERGIS_POLICIES: policies.join(','),
      // Sin VERGIS_DATASETS: el arranque muere DESPUÉS de cargar las políticas. Es el control: si las
      // políticas pasan, la falla que se ve es ésta y no la de la colisión.
      VERGIS_DATASETS: '',
    },
  })
  return { status: r.status, salida: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

describe('#348 · arranque real de serve-rls', () => {
  it('dos archivos con el mismo dataset ⇒ el boot muere nombrando los dos archivos', () => {
    const d = dir()
    const a = archivo(d, 'finanzas.yaml', RLS)
    const b = archivo(d, 'cartera.yaml', GRANT)
    const { status, salida } = arrancar([a, b])
    expect(status).toBe(1)
    expect(salida).toContain('dataset-duplicate-across-files')
    expect(salida).toContain(a)
    expect(salida).toContain(b)
  }, 130_000)

  it('control: sin colisión el boot pasa la carga de políticas y muere más adelante, por otra causa', () => {
    const d = dir()
    const { status, salida } = arrancar([archivo(d, 'finanzas.yaml', RLS), archivo(d, 'dims.yaml', OTRO)])
    expect(status).toBe(1)
    expect(salida).not.toContain('dataset-duplicate')
    expect(salida).toMatch(/falta VERGIS_DATASETS/)
  }, 130_000)
})
