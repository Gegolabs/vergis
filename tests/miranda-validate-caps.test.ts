// H0 del frente #113 (canales de salida): Miranda dejaba de prometer lo que no existe.
//
// La grieta medida: `MIRANDA_VALIDATE_CAPS` anunciaba `send-email` y `send-slack` como capabilities
// válidas de un draft, pero ninguna de las dos existe en el repo ni la registra el catálogo de
// serving. Consecuencia: Miranda validaba OK un spec con un canal `send-email` que `Botler.register`
// rechazaba después con `channel-capability-not-catalogued`.
//
// Este archivo mide las DOS mitades de la cadena:
//   (a) la lista que construye `mirandaValidateCaps` ya no promete esas dos capabilities;
//   (b) con esa lista, `validateSpec` rechaza un spec con canal `send-email` con ese código —
//       el experimento que confirma (o habría refutado) la cadena §1.4 del diseño.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VergisError } from '@vergis/botler'
import { parseSpec, validateSpec } from '@vergis/mira'
import { mirandaValidateCaps } from '../server/miranda'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object

// Serving de Fabric: un solo conector enforcing (server/serve-rls.ts, `SERVING_CAPS`).
const CAPS = mirandaValidateCaps(['execute-sql-dwh'])

/** Spec mínima válida; el canal de `delivery` es el parámetro del experimento. */
const specConCanal = (capability: string): string => `
mira_version: "1.0"
identity: { id: pi-h0-canales, display_name: "H0 canales", classification: internal }
piece:
  layout: rows
  elements:
    - kpi: { label: "Total", format: int_0, agg: { dataset: datos, op: sum, field: n } }
data:
  datos:
    capability: execute-sql-dwh
    params: { sql: "SELECT area, n FROM dbo.datos" }
    shape: { type: rows, fields: { area: string, n: integer } }
quality:
  freshness: { source_watermark: required, max_age: P1D, watermark_field: datos.area }
delivery:
  render: [{ format: html, target: web }]
  channels:
    - { type: push, capability: ${capability} }
`

describe('H0 #113 · la lista de capabilities de Miranda no promete lo que no existe', () => {
  it('(a) mirandaValidateCaps no contiene send-email ni send-slack', () => {
    expect(CAPS).not.toContain('send-email')
    expect(CAPS).not.toContain('send-slack')
  })

  it('(a·bis) sí contiene el serving inyectado y los canales realmente catalogados', () => {
    expect(CAPS).toEqual(['execute-sql-dwh', 'publicar-artefacto', 'render-html-piece', 'render-csv-piece'])
  })

  it('la spec testigo con un canal REAL (publicar-artefacto) valida OK — el rechazo de abajo es del canal, no de la spec', () => {
    expect(() => validateSpec(parseSpec(specConCanal('publicar-artefacto')), { capabilities: CAPS, schema: SCHEMA })).not.toThrow()
  })

  it('(b) un spec con canal send-email es rechazado con channel-capability-not-catalogued', () => {
    let caught: unknown
    try {
      validateSpec(parseSpec(specConCanal('send-email')), { capabilities: CAPS, schema: SCHEMA })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(VergisError)
    const s = (caught as VergisError).structured
    expect(s.error).toBe('mira/spec-invalid')
    expect(s.code).toBe('channel-capability-not-catalogued')
    expect(s.path).toBe('delivery.channels[0].capability')
    expect(s.value).toBe('send-email')
  })

  it('(b·bis) lo mismo con send-slack', () => {
    expect(() => validateSpec(parseSpec(specConCanal('send-slack')), { capabilities: CAPS, schema: SCHEMA })).toThrow(
      /send-slack/,
    )
  })
})
