// Prueba VIVA del paso 4: la Capability real (`createExecuteSqlClickHouse` con su
// transporte fetch real) consultando un ClickHouse real con la ROW POLICY emitida por
// el compilador. No es el emulador — es el motor. Confirma que la inyección de claims
// `vergis_claim_*` por query-param HTTP filtra de verdad, por consumidor.
//
// Requiere el ClickHouse de fase2-xcheck arriba (puerto 18124, user `botler`,
// policy `vergis_claim_groups`). Uso: tsx scripts/live-rls-proof.ts
//
// No es parte de `npm test` (hermético, sin Docker). Es prueba de aceptación bajo demanda.

import { createExecuteSqlClickHouse } from '@vergis/capabilities'
import { identityFromHeaders } from '@vergis/botler'
import { compileClickHouse, parseAudience, type Policy } from '@vergis/policy'

const URL = process.env['CH_URL'] ?? 'http://localhost:18124'
const SQL = 'SELECT area, count() AS n, sum(present) AS present FROM vergis.areas GROUP BY area ORDER BY area'

const AUDIENCE = { rls: [{ column: 'area', claim: 'groups', op: 'in' }], default: 'deny' }
const enforcement = compileClickHouse(parseAudience(AUDIENCE) as Policy, {
  database: 'vergis',
  table: 'areas',
  role: 'consumer_role',
})!

const cap = createExecuteSqlClickHouse({ url: URL, user: 'botler', database: 'vergis' }, enforcement)

type Row = { area: string; n: string; present: string }
const areasOf = (rows: Row[]) => rows.map((r) => r.area).sort()

async function query(groups: string): Promise<Row[]> {
  // identidad armada como la armaría el server desde la cabecera del gate.
  const headers = groups ? { 'x-forwarded-groups': groups } : {}
  const identity = identityFromHeaders(headers)
  const out = (await cap.execute({ sql: SQL }, identity)) as { rows: Row[] }
  return out.rows
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

const cases: { name: string; groups: string; expect: string[] }[] = [
  { name: 'Producción → solo Producción', groups: 'Producción', expect: ['Producción'] },
  { name: 'Finanzas → solo Finanzas', groups: 'Finanzas', expect: ['Finanzas'] },
  { name: 'multi {Producción,Comercial} → ambas', groups: 'Producción,Comercial', expect: ['Comercial', 'Producción'] },
  { name: 'sin grupo → 0 filas (default-deny)', groups: '', expect: [] },
  { name: "grupo inexistente 'Marte' → 0 filas", groups: 'Marte', expect: [] },
  { name: "injection-safe: \"'; DROP POLICY--\" → 0 filas", groups: "'; DROP POLICY pol_areas--", expect: [] },
]

console.log(`\nPrueba VIVA de RLS por consumidor contra ${URL}\n`)
for (const c of cases) {
  const rows = await query(c.groups)
  const got = areasOf(rows)
  assert(JSON.stringify(got) === JSON.stringify(c.expect), `${c.name}  (got: [${got.join(', ')}])`)
}

// Pooling-safe en vivo: dos consumidores seguidos por la MISMA instancia/capability.
const a = areasOf(await query('Producción'))
const b = areasOf(await query('Finanzas'))
assert(
  JSON.stringify(a) === '["Producción"]' && JSON.stringify(b) === '["Finanzas"]',
  `pooling-safe vivo: A=[${a}] luego B=[${b}] sin fuga`,
)

console.log(process.exitCode ? '\nFALLÓ\n' : '\nVERDE — la RLS real filtra por consumidor vía la Capability.\n')
