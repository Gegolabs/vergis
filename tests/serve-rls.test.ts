// Paso 5 (nivel CI, hermético) · render por-consumidor con RLS, SIN Docker.
//
// Prueba que runSpec sirve un PI consultando vía `execute-sql-ch` con los claims del
// consumidor: la fuente filtra y el HTML sale segmentado. El transporte es un FAKE que
// simula ClickHouse con `emulate` (la semántica de la policy generada) — el mismo arnés
// diferencial del paso 4, ahora end-to-end por el render. La corrida VIVA contra ClickHouse
// real vive en `scripts/serve-rls-proof.ts` (Docker, bajo demanda).

import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runSpec } from '@vergis/cli'
import { identityFromHeaders } from '@vergis/botler'
import { createExecuteSqlClickHouse, type ChTransport } from '@vergis/capabilities'
import { compileClickHouse, emulate, parseAudience, type Policy } from '@vergis/policy'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SPEC = join(ROOT, 'examples', 'rls-areas.yaml')

type Row = { area: string; total: number; present: number }
const STORE: Row[] = [
  { area: 'Producción', total: 120, present: 110 },
  { area: 'Finanzas', total: 40, present: 38 },
  { area: 'Comercial', total: 60, present: 55 },
  { area: 'RRHH', total: 25, present: 22 },
]

const ENFORCEMENT = compileClickHouse(
  parseAudience({ rls: [{ column: 'area', claim: 'groups', op: 'in' }], default: 'deny' }) as Policy,
  { database: 'demo', table: 'areas', role: 'consumer_role' },
)!

// Fake transport: filtra el store con los settings inyectados (semántica de la ROW POLICY).
const transport: ChTransport = async (req) => ({
  rows: STORE.filter((r) => emulate(ENFORCEMENT, req.settings, r as unknown as Record<string, unknown>)) as unknown as Record<string, unknown>[],
})

let work: string
beforeAll(() => { work = mkdtempSync(join(tmpdir(), 'serve-rls-')) })
afterAll(() => { rmSync(work, { recursive: true, force: true }) })

async function render(groups: string): Promise<string> {
  const out = await runSpec({
    specPath: SPEC,
    baseDir: work,
    identity: identityFromHeaders(groups ? { 'x-forwarded-groups': groups } : {}),
    extraCapabilities: [createExecuteSqlClickHouse({ url: 'http://ch:8123', user: 'botler' }, ENFORCEMENT, { transport })],
  })
  expect(out.ok).toBe(true)
  return out.html ?? ''
}

describe('Paso 5 · serve con RLS — el dashboard sale segmentado por consumidor', () => {
  it('Producción ve solo Producción', async () => {
    const html = await render('Producción')
    expect(html).toContain('Producción')
    for (const a of ['Finanzas', 'Comercial', 'RRHH']) expect(html).not.toContain(a)
  })

  it('Finanzas ve solo Finanzas', async () => {
    const html = await render('Finanzas')
    expect(html).toContain('Finanzas')
    for (const a of ['Producción', 'Comercial', 'RRHH']) expect(html).not.toContain(a)
  })

  it('rol multi-Área {Producción,Comercial} ve esas dos y solo esas', async () => {
    const html = await render('Producción,Comercial')
    expect(html).toContain('Producción')
    expect(html).toContain('Comercial')
    for (const a of ['Finanzas', 'RRHH']) expect(html).not.toContain(a)
  })

  it('runSpec expone el HTML renderizado (servir per-request sin pasar por disco)', async () => {
    const html = await render('RRHH')
    expect(html.length).toBeGreaterThan(0)
    expect(html).toContain('RRHH')
  })
})
