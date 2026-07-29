// D16 · declaración de LLAVES DE NEGOCIO en el DSL (`data.<dataset>.anchor`).
// El anchor dice a qué entidad gobernada corresponden las filas de un dataset y qué columnas
// identifican una fila — es lo que permite clavar un comentario en un REGISTRO (y que lo dicho sobre
// la empleada 4021 sea lo mismo se mire desde el PI que se mire). Es DESCRIPTIVO: no autoriza nada.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSpec, validateSpec } from '@vergis/mira'

const SCHEMA = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('../schema/mira-spec.schema.json', import.meta.url))), 'utf8'),
) as object
const CAPS = ['mock-sql', 'render-html-piece']
const validate = (spec: string) => validateSpec(parseSpec(spec), { capabilities: CAPS, schema: SCHEMA })

/** Spec testigo con un dataset que declara shape.fields — el anchor se inyecta por bloque. */
const spec = (anchor: string): string => `
mira_version: "1.0"
identity: { id: pi-anchor, display_name: "Anchor", classification: internal }
piece:
  layout: rows
  elements:
    - table: { data: empleados, columns: [{ field: rut, label: RUT }] }
data:
  empleados:
    capability: mock-sql
    params: { sql: "select rut, nombre, sueldo from dbo.dim_empleado" }
    shape:
      type: rows
      fields: { rut: string, nombre: string, sueldo: number }
${anchor}
quality: {}
delivery:
  render: [{ format: html, target: web }]
`

describe('anchor · declaración válida', () => {
  it('un dataset SIN anchor sigue siendo válido (el gesto de comentar simplemente no se ofrece)', () => {
    expect(() => validate(spec(''))).not.toThrow()
    const s = parseSpec(spec('')) as { data: Record<string, { anchor?: unknown }> }
    expect(s.data['empleados'].anchor).toBeUndefined()
  })

  it('acepta entidad calificada + llave simple, y la conserva en el spec parseado', () => {
    const s = validate(spec('    anchor: { entity: dbo.dim_empleado, key: [rut] }'))
    expect(s.data['empleados'].anchor).toEqual({ entity: 'dbo.dim_empleado', key: ['rut'] })
  })

  it('acepta llave compuesta y columna de display', () => {
    const s = validate(spec('    anchor: { entity: dbo.dim_empleado, key: [rut, nombre], display: nombre }'))
    expect(s.data['empleados'].anchor).toMatchObject({ key: ['rut', 'nombre'], display: 'nombre' })
  })
})

describe('anchor · rechazos fail-loud', () => {
  it('entidad sin esquema → rechazo (una referencia de una parte no unifica entre PIs)', () => {
    expect(() => validate(spec('    anchor: { entity: dim_empleado, key: [rut] }'))).toThrow(/calificada por esquema|schema/i)
  })

  it('llave vacía → rechazo (sin llave no hay registro al que clavar el comentario)', () => {
    expect(() => validate(spec('    anchor: { entity: dbo.dim_empleado, key: [] }'))).toThrow()
  })

  it('columna de llave inexistente en shape.fields → rechazo (quedaría anclado a undefined)', () => {
    expect(() => validate(spec('    anchor: { entity: dbo.dim_empleado, key: [codigo] }'))).toThrow(/codigo/)
  })

  it('display inexistente en shape.fields → rechazo', () => {
    expect(() => validate(spec('    anchor: { entity: dbo.dim_empleado, key: [rut], display: apellido }'))).toThrow(/apellido/)
  })

  it('propiedad desconocida dentro del anchor → rechazo del schema (nada de autorización se cuela)', () => {
    expect(() => validate(spec('    anchor: { entity: dbo.dim_empleado, key: [rut], grant: all }'))).toThrow()
  })
})

describe('anchor · sin shape.fields declarado', () => {
  it('no se puede verificar la columna, pero la entidad y la llave sí se exigen', () => {
    const sinShape = (anchor: string): string => `
mira_version: "1.0"
identity: { id: pi-anchor2, display_name: "Anchor2", classification: internal }
piece: { table: { data: t, columns: [{ field: id, label: ID }] } }
data:
  t:
    capability: mock-sql
    params: { sql: "select id from dbo.cosa" }
${anchor}
quality: {}
delivery:
  render: [{ format: html, target: web }]
`
    expect(() => validate(sinShape('    anchor: { entity: dbo.cosa, key: [lo_que_sea] }'))).not.toThrow()
    // El schema ya rechaza la entidad de una sola parte; el validador semántico es la segunda barrera.
    expect(() => validate(sinShape('    anchor: { entity: cosa, key: [id] }'))).toThrow()
  })
})
