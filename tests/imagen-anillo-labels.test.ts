import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SCHEMA_VERSION, NOTAS_SCHEMA_VERSION, MASTER_DATA_SCHEMA_VERSION, EVALUACIONES_SCHEMA_VERSION } from '@vergis/capabilities'

/**
 * EL CONTRATO PÚBLICO DEL ANILLO EN LA IMAGEN (issue #210 · I9).
 *
 * La imagen declara qué versión de esquema del store embebido soporta el código que lleva dentro
 * (`vergis.schema` y `vergis.schema.stores`), para que un conmutador de anillos pueda negarse a un
 * rollback incompatible SIN arrancar el candidato.
 *
 * Un label es un literal en el `Dockerfile` y la verdad es una constante en TypeScript: eso es una
 * pareja que DRIFTEA, y un label que miente es peor que no tenerlo — le da un «sí» barato a la única
 * comprobación que se hace antes de tocar el plano de control. Estas pruebas son el guard:
 *
 *  · el número del label == la constante del código (los tres stores, uno por uno);
 *  · las CLAVES del mapa == los stores que el server cablea de verdad (`embeddedStores()`), así que
 *    agregar un store embebido sin declararlo en la imagen también se pone rojo;
 *  · el `Dockerfile` NO declara `org.opencontainers.image.*`: esos los inyecta el workflow desde la
 *    metadata de git, y dos fuentes del mismo dato es la otra forma de driftear.
 *
 * Falsificación ejecutada (2026-08-18): con `vergis.schema="2"` en el `Dockerfile` y `SCHEMA_VERSION=1`
 * en el código, la primera prueba falla nombrando ambos números. El guard sabe reprobar.
 */

const RAIZ = resolve(__dirname, '..')
const DOCKERFILE = readFileSync(join(RAIZ, 'Dockerfile'), 'utf8')
const SERVE = readFileSync(join(RAIZ, 'server/serve-rls.ts'), 'utf8')

/** Lee un label del `Dockerfile` tolerando la continuación de línea (`\`) de un LABEL multi-clave. */
function label(clave: string): string {
  const m = DOCKERFILE.match(new RegExp(`${clave.replace(/\./g, '\\.')}="([^"]*)"`))
  if (!m) throw new Error(`el Dockerfile no declara el label ${clave}`)
  return m[1]!
}

/** El mapa `nombre=versión,...` del label, parseado. */
function mapaDeStores(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const par of label('vergis.schema.stores').split(',')) {
    const [nombre, valor] = par.split('=')
    expect(nombre, `par mal formado en vergis.schema.stores: "${par}"`).toBeTruthy()
    expect(valor, `par mal formado en vergis.schema.stores: "${par}"`).toMatch(/^\d+$/)
    out[nombre!.trim()] = Number(valor)
  }
  return out
}

describe('los labels de esquema de la imagen (I9)', () => {
  it('vergis.schema declara el esquema del store de gobierno que soporta ESTE código', () => {
    expect(Number(label('vergis.schema'))).toBe(SCHEMA_VERSION)
  })

  it('vergis.schema.stores declara CADA store con la versión de su constante', () => {
    expect(mapaDeStores()).toEqual({
      gobierno: SCHEMA_VERSION,
      notas: NOTAS_SCHEMA_VERSION,
      'data-maestra': MASTER_DATA_SCHEMA_VERSION,
      evaluaciones: EVALUACIONES_SCHEMA_VERSION,
    })
  })

  it('el mapa nombra EXACTAMENTE los stores embebidos que el server cablea', () => {
    // `embeddedStores()` (server/serve-rls.ts) es la lista que alimenta el bloque `control` de
    // `/contrato`. Si aparece un store nuevo ahí y nadie lo declara en la imagen, el conmutador
    // compararía contra un mapa incompleto y creería que puede promover. Esta aserción lo impide.
    const cuerpo = SERVE.slice(SERVE.indexOf('function embeddedStores()'))
    const bloque = cuerpo.slice(0, cuerpo.indexOf('\n}\n'))
    const cableados = [...bloque.matchAll(/out\.push\(\{\s*name:\s*'([^']+)'/g)].map((m) => m[1]!)
    expect(cableados.length, 'no se pudo leer embeddedStores(): ¿cambió su forma?').toBeGreaterThan(0)
    expect(new Set(Object.keys(mapaDeStores()))).toEqual(new Set(cableados))
  })

  it('no duplica los labels OCI que inyecta el workflow de build', () => {
    // `docker/metadata-action` los produce desde la metadata de git (`steps.meta.outputs.labels`).
    // Declararlos también acá crearía dos fuentes del mismo dato, y la del Dockerfile envejecería.
    expect(DOCKERFILE).not.toMatch(/^\s*LABEL\s+org\.opencontainers/m)
    expect(DOCKERFILE).not.toMatch(/LABEL[^\n]*org\.opencontainers\.image\./)
  })
})
