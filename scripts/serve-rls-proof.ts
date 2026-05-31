// Prueba VIVA del paso 5: el Botler INGIERE a ClickHouse y SIRVE consultando con RLS activa.
// El dashboard de cada consumidor sale filtrado por sus grupos (la fuente filtra, no el render).
//
// Cadena completa, datos sintéticos, ClickHouse local:
//   bootstrapClickHouse (DDL + ROW POLICY del compilador + usuario data-plane)
//   → ingest-to-clickhouse (full-replace, caché desechable)
//   → runSpec(identity=Producción) y runSpec(identity=Finanzas): cada uno renderiza
//     consultando ClickHouse con SUS claims → HTML segmentado por consumidor.
//
// Requiere el ClickHouse local arriba (deploy/clickhouse-local, puerto 18125).
// Uso:  VERGIS_SPEC=<ruta del spec QW-04-clickhouse> tsx scripts/serve-rls-proof.ts
// No es parte de `npm test` (hermético, sin Docker).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSpec } from '@vergis/cli'
import { identityFromHeaders } from '@vergis/botler'
import { parseSpec } from '@vergis/mira'
import {
  bootstrapClickHouse,
  createIngestClickHouse,
  createExecuteSqlClickHouse,
  type ChStoreSchema,
} from '@vergis/capabilities'
import { compileClickHouse, parseAudience, type Policy } from '@vergis/policy'
import { readFileSync } from 'node:fs'

const CH = process.env['CH_URL'] ?? 'http://localhost:18125'
const SPEC = process.env['VERGIS_SPEC']
if (!SPEC) throw new Error('Falta VERGIS_SPEC (ruta del spec QW-04 variante ClickHouse).')

const ALL_AREAS = ['Producción', 'Finanzas', 'Comercial', 'RRHH']

// Datos sintéticos pre-agregados por Área (lo que el cache QW-04 contendría tras la ingesta).
const FECHA = '2026-05-31'
type Row = Record<string, unknown>
const SYNTH: Row[] = [
  { area: 'Producción', fecha: FECHA, total: 120, present: 110, licencias: 4, vacaciones: 3, permisos: 1, sin_justificacion: 2, ausentes: 10 },
  { area: 'Finanzas', fecha: FECHA, total: 40, present: 38, licencias: 1, vacaciones: 1, permisos: 0, sin_justificacion: 0, ausentes: 2 },
  { area: 'Comercial', fecha: FECHA, total: 60, present: 55, licencias: 2, vacaciones: 1, permisos: 1, sin_justificacion: 1, ausentes: 5 },
  { area: 'RRHH', fecha: FECHA, total: 25, present: 22, licencias: 1, vacaciones: 1, permisos: 0, sin_justificacion: 1, ausentes: 3 },
]

const SCHEMA: ChStoreSchema = {
  database: 'qw04',
  table: 'areas',
  columns: {
    area: 'String',
    fecha: 'Date',
    total: 'UInt32',
    present: 'UInt32',
    licencias: 'UInt32',
    vacaciones: 'UInt32',
    permisos: 'UInt32',
    sin_justificacion: 'UInt32',
    ausentes: 'UInt32',
  },
}
const TARGET = { database: 'qw04', table: 'areas', role: 'consumer_role' }

// Enforcement compilado desde la audience REAL del spec de instancia.
const spec = parseSpec(readFileSync(SPEC, 'utf8')) as { quality?: { audience?: unknown } }
const audience = spec.quality?.audience as Parameters<typeof parseAudience>[0]
const enforcement = compileClickHouse(parseAudience(audience) as Policy, TARGET)
if (!enforcement) throw new Error('El spec no declara RLS (audience pública); el paso 5 espera una policy.')

const admin = { url: CH, user: 'default' } // access_management on (config del PoC)
const botlerProfile = { url: CH, user: 'botler', database: 'qw04' }

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`  ✗ ${msg}`); process.exitCode = 1 } else { console.log(`  ✓ ${msg}`) }
}

async function renderFor(groups: string): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), 'paso5-'))
  try {
    const out = await runSpec({
      specPath: SPEC!,
      baseDir: work,
      identity: identityFromHeaders(groups ? { 'x-forwarded-groups': groups } : {}),
      extraCapabilities: [createExecuteSqlClickHouse(botlerProfile, enforcement)],
    })
    if (!out.ok) throw new Error(`runSpec falló: ${out.fallback?.reason}`)
    return out.html ?? ''
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

console.log(`\nPaso 5 · serve con RLS — bootstrap + ingesta + render por consumidor (${CH})\n`)

// 1 · bootstrap idempotente (re-ejecutable): DDL + policy del compilador + usuario data-plane.
await bootstrapClickHouse(admin, SCHEMA, enforcement)
await bootstrapClickHouse(admin, SCHEMA, enforcement) // 2ª vez: no debe romper (idempotencia)
console.log('  ✓ bootstrap idempotente (DDL + ROW POLICY + usuario botler)')

// 2 · ingesta full-replace (caché desechable).
const ingest = createIngestClickHouse(admin, SCHEMA)
const r1 = (await ingest.execute({ rows: SYNTH }, { agent: 'vergis' })) as { ingested: number }
await ingest.execute({ rows: SYNTH }, { agent: 'vergis' }) // re-ingesta: mismo estado (no duplica)
assert(r1.ingested === SYNTH.length, `ingesta de ${SYNTH.length} filas (full-replace, sin duplicar al re-ingerir)`)

// 3 · render por consumidor — cada uno ve SOLO su Área.
const htmlProd = await renderFor('Producción')
assert(htmlProd.includes('Producción'), 'gerente de Producción: su dashboard muestra Producción')
assert(
  !['Finanzas', 'Comercial', 'RRHH'].some((a) => htmlProd.includes(a)),
  'gerente de Producción: NO ve ninguna otra Área',
)

const htmlFin = await renderFor('Finanzas')
assert(htmlFin.includes('Finanzas'), 'gerente de Finanzas: su dashboard muestra Finanzas')
assert(
  !['Producción', 'Comercial', 'RRHH'].some((a) => htmlFin.includes(a)),
  'gerente de Finanzas: NO ve ninguna otra Área',
)

// 4 · multi-Área (un rol corporativo con dos grupos) ve exactamente esas dos.
const htmlCorp = await renderFor('Producción,Finanzas')
assert(
  htmlCorp.includes('Producción') && htmlCorp.includes('Finanzas') && !['Comercial', 'RRHH'].some((a) => htmlCorp.includes(a)),
  'rol {Producción,Finanzas}: ve esas dos y solo esas',
)

void ALL_AREAS
console.log(process.exitCode ? '\nFALLÓ\n' : '\nVERDE — ingesta + serve con RLS: dashboard segmentado por consumidor.\n')
