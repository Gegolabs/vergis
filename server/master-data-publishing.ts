import type { MasterDataEntity, MasterDataStore, Publisher, PublishTargetResult, ReplicaCountResult } from '@vergis/capabilities'

/** Texto de un error cualquiera (los del driver SQL no siempre son `Error`). */
const causa = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * CABLEADO de la publicación de data maestra para el ambiente de Administración (#262).
 *
 * Vive fuera de `serve-rls` porque es la pieza que el issue vino a arreglar y merece medirse sin
 * levantar un servidor: recibe un `Publisher` cualquiera —el real habla con Fabric; el del arnés,
 * con nada— y devuelve las dos deps que consume `createAdmin`.
 *
 * Las dos reglas que lo definen, y que el bucle anterior violaba:
 *
 * 1. **Un target que falla no cancela a los siguientes.** El bucle original era
 *    `for (const t of targets) await publisher.publish(...)`: el primer `throw` abortaba el resto, así
 *    que con dos consumidores el segundo se quedaba con datos viejos por un problema que no era suyo.
 *    Acá cada target va en su propio `try`. Se mantiene **secuencial** a propósito: publicar es
 *    DDL + INSERT fila a fila contra un warehouse, y paralelizarlo cambiaría la carga sobre el motor
 *    sin que nadie lo haya medido — lo que el issue pide es aislamiento, no concurrencia.
 * 2. **El resultado se devuelve, no se traga.** Cada target vuelve como `{ok}` o `{ok:false,error}`
 *    para que la pantalla pueda decir qué pasó y con qué causa.
 */
export function masterDataPublishing(
  publisher: Publisher,
  mdStore: Pick<MasterDataStore, 'list'>,
): {
  onWrite: (entity: MasterDataEntity) => Promise<PublishTargetResult[]>
  replicaStatus: (entity: MasterDataEntity) => Promise<ReplicaCountResult[]>
} {
  return {
    async onWrite(entity) {
      const targets = entity.targets ?? []
      if (!targets.length) return []
      const rows = await mdStore.list(entity)
      const out: PublishTargetResult[] = []
      for (const t of targets) {
        try {
          await publisher.publish(entity, rows, { database_ref: t.database_ref })
          out.push({ database_ref: t.database_ref, ok: true })
        } catch (e) {
          out.push({ database_ref: t.database_ref, ok: false, error: causa(e) })
        }
      }
      return out
    },
    async replicaStatus(entity) {
      const targets = entity.targets ?? []
      const out: ReplicaCountResult[] = []
      for (const t of targets) {
        try {
          out.push({ database_ref: t.database_ref, count: await publisher.count(entity, { database_ref: t.database_ref }) })
        } catch (e) {
          // Jamás un 0 de consuelo: la pantalla dirá «no se pudo leer» con esta causa.
          out.push({ database_ref: t.database_ref, error: causa(e) })
        }
      }
      return out
    },
  }
}
