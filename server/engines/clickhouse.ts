/**
 * Motor B (ClickHouse) — LÓGICA PURA del binding de datasets a enforcement. Módulo del refactor
 * createApp() (A14).
 *
 * `computeBound` compila, para cada dataset del nodo, su `ClickHouseEnforcement` DESDE EL STORE actual.
 * Es la pieza clave del fix A11: hoy el monolito computa `BOUND` UNA vez al arranque y `reloadGovernance`
 * re-bootstrapea con esa enforcement VIEJA — endurecer una policy en caliente (`grant: all` → `rls`)
 * queda como no-op y la tabla se sigue sirviendo sin ROW POLICY (fuga). Recomputar el bound desde el
 * store nuevo antes del re-bootstrap cierra esa fuga. Esta función ES ese `recompile`.
 *
 * El plumbing de SQL vivo (bootstrap/ingesta contra ClickHouse) se compone encima en el paso del
 * núcleo (app.ts); acá vive lo puro y testeable.
 */
import { compileClickHouse, type ClickHouseEnforcement, type PolicyDecl } from '@vergis/policy'
import type { ChColumnType, ChStoreSchema } from '@vergis/capabilities'

export interface DatasetCfg {
  /** `db.tabla` de la réplica gobernada en ClickHouse. */
  table: string
  columns: Record<string, ChColumnType>
  ingest?: { database_ref: string; sql: string }
  seed?: Record<string, unknown>[]
}

export interface BoundDataset {
  schema: ChStoreSchema
  enforcement: ClickHouseEnforcement | null
  cfg: DatasetCfg
}

/**
 * Compila cada dataset a su schema + enforcement DESDE `store`. Fail-closed: dataset sin política
 * lanza (default-deny). Llamarla con el store NUEVO en el reload es el `recompile` que cierra A11.
 */
export function computeBound(datasets: DatasetCfg[], store: Map<string, PolicyDecl>, targetRole: string): BoundDataset[] {
  return datasets.map((cfg) => {
    const [database, table] = cfg.table.split('.')
    if (!database || !table) throw new Error(`Dataset '${cfg.table}' debe ser 'db.tabla'.`)
    const policy = store.get(cfg.table)
    if (!policy) {
      throw new Error(`Sin política para '${cfg.table}' en el policy store. Default-deny: declara la entidad/grant — el dato no se sirve sin política.`)
    }
    const schema: ChStoreSchema = { database, table, columns: cfg.columns }
    // El fallo de compilación tumba el ARRANQUE, y es deliberado: es la misma conducta que la línea
    // de arriba —un dataset sin política tampoco deja arrancar— y la alternativa sería servir la
    // tabla sin el gobierno que su policy declara. Fail-closed en el borde más barato.
    //
    // Lo que sí se agrega es CONTEXTO: sin el nombre del dataset, un error del compilador (p. ej. una
    // regla de columna sobre este back-end, que no sabe enmascarar — issue #163) llega al operador
    // como un mensaje sin sitio, y el sitio es la mitad del diagnóstico. La causa original viaja
    // entera: se re-lanza envuelto, no traducido.
    try {
      return { schema, enforcement: compileClickHouse(policy, { database, table, role: targetRole }), cfg }
    } catch (e) {
      const causa = e instanceof Error ? e.message : String(e)
      throw new Error(`Dataset '${cfg.table}': el gobierno declarado no se puede aplicar en ClickHouse — ${causa}`, { cause: e })
    }
  })
}

/** UNIÓN de las inyecciones de claim de todos los datasets (un canal para servir varias tablas). */
export function unionInjections(bound: BoundDataset[]): { setting: string; claim: string }[] {
  return [...new Map(bound.flatMap((b) => b.enforcement?.injections ?? []).map((inj) => [inj.setting, inj])).values()]
}
