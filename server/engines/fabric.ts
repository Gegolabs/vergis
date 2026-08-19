/**
 * Motor C (Fabric push-down) — LÓGICA PURA de la verificación de servibilidad POR PI (issue #52).
 *
 * La unidad de fail-closed es EL PI, no el proceso: cada PI verifica que TODAS sus tablas gobernadas
 * tengan artefacto `SECURITY POLICY` nativo en la fuente; el que no verifica no se sirve (con motivo
 * accionable) y los demás siguen. Solo se consultan las conexiones EN USO por algún PI descubierto —
 * una conexión declarada que nadie usa no puede tumbar nada.
 *
 * HERENCIA DE GOBIERNO VÍA VISTAS (issue #54): una tabla servida SIN entrada en el policy store puede
 * ser una VISTA-CONTRATO (`v_<entidad>`) sobre una base gobernada — la RLS sustantiva es data-anchored
 * en la base y filtra a través de la vista, así que exigirle a la vista política + secpol propias solo
 * duplicaba artefactos. El gate resuelve el linaje vista→base en la fuente (sys.sql_expression_
 * dependencies, SOLO vistas `WITH SCHEMABINDING` y dependencias intra-database — certeza o nada) y
 * acepta la vista si TODAS sus bases (transitivo) están gobernadas y verificadas. Linaje no derivable
 * → se exige la declaración explícita, como siempre (fail-closed).
 *
 * VISTA DE MÁSCARA (issue #163 H8): la vista `[schema].[vw_mask_<tabla>]` que emite el compilador
 * (`FabricEnforcement.maskView`) NO es schemabound A PROPÓSITO — serlo tomaría rehén la proyección
 * entera (issue #164) y bloquearía el `ALTER COLUMN … ADD MASKED` del propio cinturón. Sin este
 * eslabón, un PI que la nombrara quedaba no-servible: fail-closed correcto, capacidad inalcanzable.
 * Se reconoce por DOS legs INDEPENDIENTES que se exigen juntas (ver `admitMaskViews`), nunca por el
 * nombre; el resto de las vistas no-schemabound sigue sin herencia, exactamente como antes.
 *
 * INDETERMINACIÓN ≠ VEREDICTO: si la consulta a una conexión falla (credencial vencida, warehouse
 * pausado), no sabemos si el artefacto está o no. Un PI que YA verificaba conserva su veredicto sano
 * (validate-before-swap: un fallo transitorio no degrada lo que servía); uno nuevo o ya degradado
 * queda no-servible (fail-closed en frío). Un veredicto DEFINITIVO (la conexión respondió y el
 * artefacto NO está) siempre gana: ningún camino afloja el fail-closed.
 */
import { columnRules, type PolicyDecl } from '@vergis/policy'

/** SQL de verificación: tablas con SECURITY POLICY habilitada en la fuente. */
export const SYS_SECURITY_POLICIES_SQL =
  `SELECT OBJECT_SCHEMA_NAME(pr.target_object_id) AS sch, OBJECT_NAME(pr.target_object_id) AS tbl ` +
  `FROM sys.security_policies p JOIN sys.security_predicates pr ON pr.object_id = p.object_id WHERE p.is_enabled = 1`

/** SQL de linaje vista→base. Dependencias resueltas intra-database (`referenced_id IS NOT NULL`;
 * cross-db queda fuera → sin certeza no hay herencia) y `is_schema_bound` **como columna**, no como
 * filtro: las dos poblaciones se separan en el cliente porque valen distinto —schemabound = linaje
 * que no puede cambiar bajo los pies sin DDL sobre la vista, y es el único que hereda por sí solo;
 * no-schemabound = evidencia que SOLO sirve para CORROBORAR una vista de máscara declarada (H8)—.
 * Traerlas en UNA query mantiene el costo en 2 RTT por conexión (issue #138·3).
 * Puede repetir pares (una fila por columna referenciada) — se dedupe. */
export const SYS_VIEW_LINEAGE_SQL =
  `SELECT OBJECT_SCHEMA_NAME(d.referencing_id) AS vsch, OBJECT_NAME(d.referencing_id) AS vname, ` +
  `OBJECT_SCHEMA_NAME(d.referenced_id) AS bsch, OBJECT_NAME(d.referenced_id) AS bname, ` +
  `m.is_schema_bound AS bound ` +
  `FROM sys.sql_expression_dependencies d ` +
  `JOIN sys.views v ON v.object_id = d.referencing_id ` +
  `JOIN sys.sql_modules m ON m.object_id = v.object_id ` +
  `WHERE d.referenced_id IS NOT NULL`

/**
 * SQL del **centinela de desenmascarado** (#238) — dos legs, y la primera existe para poder
 * distinguir «no está instalado» de «está y enmascara».
 *
 * `UNMASK_PROBE_SCHEMAS_SQL` localiza los centinelas (el nombre lo fija el emisor, ver
 * `FabricUnmaskProbe`); `unmaskProbeReadSQL` lee uno. Sin esa separación, un `SELECT` sobre una
 * tabla ausente devolvería un error indistinguible de una credencial vencida — y el gate trataría
 * «falta re-aplicar la DDL» como «el warehouse no respondió», que son remediaciones distintas.
 */
export const UNMASK_PROBE_TABLE_NAME = 'vergis_unmask_probe'
export const UNMASK_PROBE_EXPECTED = 'VERGIS-UNMASK-OK'
export const UNMASK_PROBE_SCHEMAS_SQL =
  `SELECT s.name AS sch FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id ` +
  `WHERE t.name = N'${UNMASK_PROBE_TABLE_NAME}'`
export function unmaskProbeReadSQL(schema: string): string {
  // El schema viene de `sys`, no del usuario: no hay interpolación de dato ajeno acá.
  return `SELECT TOP 1 [probe] AS [probe] FROM [${schema}].[${UNMASK_PROBE_TABLE_NAME}];`
}

/**
 * Qué se sabe de la capacidad de desenmascarar del principal con el que el serving se conecta.
 *
 * Los tres estados son los del instrumento, y **ninguno se colapsa con otro** (Norma 7, corolario
 * de instrumentos): `capable` y `incapable` son mediciones; `uninstrumented` es la confesión de que
 * no hay con qué medir. Un instrumento que devolviera «incapable» cuando en realidad no pudo medir
 * apagaría PIs sanos y entrenaría a desconfiar del gate.
 */
export type UnmaskCapability = 'capable' | 'incapable' | 'uninstrumented'

/** Lo que la verificación necesita saber de un PI (proyección de `Report`). */
export interface VerifiablePi {
  slug: string
  tables: string[]
  databaseRefs: string[]
}

/** Estado de gobierno observable en UNA conexión: tablas con secpol + linaje de vistas schemabound. */
export interface SourceState {
  protectedTables: Set<string>
  /** vista (`schema.vista`) → tablas/vistas base directas (`schema.objeto`). SOLO schemabound: es el
   *  linaje que hereda gobierno por sí solo. */
  viewLineage: Map<string, string[]>
  /**
   * Linaje observado de vistas NO-schemabound. **No hereda nada por sí mismo**: es evidencia de
   * corroboración para una vista de máscara DECLARADA (H8) — sirve para desmentir una declaración
   * que no calza con la fuente, jamás para bendecir una vista que nadie declaró. Opcional: una
   * `SourceState` sin este campo se comporta EXACTAMENTE como antes de H8 (ninguna vista
   * no-schemabound hereda).
   */
  unboundViewLineage?: Map<string, string[]>
  /**
   * Capacidad de desenmascarar medida en ESTA conexión (#238), o ausente si no se midió.
   *
   * Ausente ⇒ el gate se comporta EXACTAMENTE como antes de #238: ninguna leg nueva se evalúa. Es
   * la misma disciplina de `unboundViewLineage` — una capacidad nueva no puede cambiar el veredicto
   * de un llamador que todavía no la produce.
   */
  unmask?: UnmaskCapability
}

/**
 * Una vista de máscara DECLARADA por el emisor compilado (`FabricEnforcement.maskView`): qué vista
 * es y sobre qué tabla base se emitió. El emisor es el ÚNICO que sabe el nombre exacto que emitió
 * (`maskViewName` del target lo puede sobreescribir), y por eso la declaración es la primera leg del
 * reconocimiento — el nombre por convención NO lo es (ver `admitMaskViews`).
 */
export interface MaskViewDecl {
  /** Vista emitida — `schema.vista` o `[schema].[vista]` (se normaliza). */
  view: string
  /** Tabla base sobre la que se emitió — `schema.tabla` o `[schema].[tabla]`. */
  base: string
}

/**
 * Candidatas a vista de máscara derivadas del policy store: toda tabla con reglas de columna tiene,
 * por convención del emisor, una `vw_mask_<tabla>` en su mismo schema (`fabric.ts`: el nombre por
 * defecto es `vw_mask_${table}`).
 *
 * DERIVAR EL NOMBRE POR CONVENCIÓN NO ES CONFIAR EN EL NOMBRE, y la diferencia es toda la seguridad
 * de esto: acá solo se produce una CANDIDATA. `admitMaskViews` la acepta únicamente si además la
 * fuente confirma que esa vista lee EXACTAMENTE esa base y la base declara reglas de columna. Una
 * vista fabricada por un tercero con el nombre justo no pasa la corroboración de `sys`.
 *
 * LÍMITE: si la instancia generó su DDL con un `maskViewName` propio, la convención no la encuentra
 * y el PI que la nombre queda NO SERVIBLE — ruidoso y fail-closed, jamás en claro. La vía entonces
 * es declararla, no aflojar el reconocimiento.
 */
export function maskViewCandidates(store: Map<string, PolicyDecl>): MaskViewDecl[] {
  return [...store.entries()]
    .filter(([, policy]) => columnRules(policy).length > 0)
    .map(([table]) => {
      const dot = table.lastIndexOf('.')
      const schema = dot > 0 ? table.slice(0, dot) : 'dbo'
      const name = dot > 0 ? table.slice(dot + 1) : table
      return { view: `${schema}.vw_mask_${name}`, base: table }
    })
}

/**
 * Schemas donde buscar el centinela de #238: los del policy store que declaran reglas de columna.
 *
 * Es la misma derivación que `maskViewCandidates` —el store como única fuente— y por la misma razón:
 * el emisor instala el centinela exactamente cuando emite plano de columna, así que preguntar por él
 * en un schema sin reglas de columna sería medir donde no hay nada que medir.
 */
export function unmaskProbeSchemas(store: Map<string, PolicyDecl>): string[] {
  const out = new Set<string>()
  for (const [table, policy] of store) {
    if (columnRules(policy).length === 0) continue
    const dot = table.lastIndexOf('.')
    out.add(dot > 0 ? table.slice(0, dot) : 'dbo')
  }
  return [...out]
}

/** Normaliza una referencia `[schema].[objeto]` a `schema.objeto` (el emisor entrega la calificada). */
function normalizeRef(ref: string): string {
  return ref.replace(/[[\]]/g, '').trim()
}

/** Veredicto de UN PI: servible, o no-servible con motivo accionable. */
export type PiVerdict = { ok: true } | { ok: false; reason: string }

/** Una herencia aplicada (para el log del gate): la vista sirvió por el gobierno de sus bases. */
export interface InheritedGovernance {
  slug: string
  view: string
  bases: string[]
  /** Presente SOLO cuando la herencia vino por una vista de máscara declarada+corroborada (H8). La
   *  herencia clásica (schemabinding) NO trae el campo: su forma es byte-idéntica a la de siempre. */
  via?: 'mask-view'
}

export interface FabricVerifyResult {
  /** Veredicto por slug — el swap al estado vivo lo hace el llamador (tras evaluar TODO). */
  state: Map<string, PiVerdict>
  /** Conexiones consultadas (solo las EN USO por algún PI). */
  usedRefs: string[]
  /** Fallos de consulta por conexión (indeterminación, no veredicto). */
  refErrors: Map<string, string>
  /** Herencias vista→base aplicadas (issue #54) — el llamador las loguea. */
  inherited: InheritedGovernance[]
  /** Linaje agregado de las conexiones que respondieron (para la visibilidad del índice). */
  viewLineage: Map<string, string[]>
}

/**
 * `sourceStateOf` real de Motor C: el estado de gobierno de UNA conexión (secpol + linaje de vistas).
 *
 * Las dos consultas de sistema son INDEPENDIENTES entre sí, así que se lanzan juntas y se esperan con
 * `Promise.all`: la latencia por conexión es ≈ 1 × RTT en vez de 2 × (issue #138·3). La semántica de
 * error no cambia: si cualquiera de las dos rechaza, el par rechaza y el llamador
 * (`verifyFabricServability`) trata ese ref como INDETERMINADO, no como veredicto.
 */
export function createFabricSourceStateOf(
  execute: (input: { database_ref: string; sql: string }) => Promise<{ rows: Record<string, unknown>[] }>,
  /**
   * Schemas donde buscar el centinela de #238 — los que el llamador sabe, por el policy store, que
   * tienen reglas de columna. **Ausente o vacío ⇒ no se mide nada y `SourceState.unmask` no viaja**:
   * el gate se comporta EXACTAMENTE como antes de #238, byte por byte.
   *
   * Por qué los pone el LLAMADOR y no se descubren acá: descubrirlos exigiría una consulta previa,
   * y eso convertiría el arranque en frío en DOS olas de round-trips en vez de una — justo el costo
   * que #138·3 acotó. El llamador ya tiene el store en la mano; pedirle el dato es gratis y el
   * sondeo viaja en la MISMA ola que las dos consultas de sistema.
   */
  unmaskSchemas: string[] = [],
): (databaseRef: string) => Promise<SourceState> {
  const schemas = [...new Set(unmaskSchemas)]
  return async (databaseRef: string): Promise<SourceState> => {
    const [prot, lin, probeSchemas, ...lecturas] = (await Promise.all([
      execute({ database_ref: databaseRef, sql: SYS_SECURITY_POLICIES_SQL }),
      execute({ database_ref: databaseRef, sql: SYS_VIEW_LINEAGE_SQL }),
      // Las dos legs del centinela viajan en esta MISMA ola. La de descubrimiento existe para poder
      // distinguir «no está instalado» de «está y enmascara»: sin ella, un `SELECT` sobre una tabla
      // ausente daría un error indistinguible de una credencial vencida, y el gate confundiría
      // «falta re-aplicar la DDL» con «el warehouse no respondió» — remediaciones distintas.
      schemas.length > 0 ? execute({ database_ref: databaseRef, sql: UNMASK_PROBE_SCHEMAS_SQL }) : Promise.resolve({ rows: [] }),
      // Las lecturas se toleran individualmente: si el centinela no existe en ese schema, el error es
      // esperado y lo resuelve el descubrimiento. Un error CON centinela presente sí es indeterminación.
      ...schemas.map((sch) =>
        execute({ database_ref: databaseRef, sql: unmaskProbeReadSQL(sch) }).then(
          (r) => r,
          () => null,
        ),
      ),
    ])) as [
      { rows: { sch: string; tbl: string }[] },
      { rows: { vsch: string; vname: string; bsch: string; bname: string; bound?: unknown }[] },
      { rows: { sch: string }[] },
      ...({ rows: { probe?: unknown }[] } | null)[],
    ]
    const viewLineage = new Map<string, string[]>()
    const unboundViewLineage = new Map<string, string[]>()
    for (const row of lin.rows) {
      const v = `${row.vsch}.${row.vname}`
      const b = `${row.bsch}.${row.bname}`
      // El bit de T-SQL puede llegar como 1, true o '1' según el driver. Se exige la forma POSITIVA
      // reconocida: cualquier otra cosa cae al cubo no-schemabound, que es el que NO hereda solo —
      // un driver que devuelva algo inesperado degrada hacia el lado seguro, nunca al revés.
      const bound = row.bound === 1 || row.bound === true || row.bound === '1'
      const target = bound ? viewLineage : unboundViewLineage
      const bases = target.get(v) ?? []
      if (!bases.includes(b)) target.set(v, [...bases, b])
    }
    // ── #238 · la capacidad de desenmascarar, MEDIDA en esta conexión ────────────────────────────
    // El reconocimiento es «leí el valor conocido» vs «leí otra cosa» — NO se compara contra el
    // literal del motor (`xxxx` hoy): si `default()` cambiara de forma, esto seguiría valiendo.
    let unmask: UnmaskCapability | undefined
    if (schemas.length > 0) {
      const instalados = new Set(probeSchemas.rows.map((r) => r.sch))
      const conCentinela = schemas.filter((sch) => instalados.has(sch))
      if (conCentinela.length === 0) {
        unmask = 'uninstrumented'
      } else {
        const valores = conCentinela.map((sch) => {
          const r = lecturas[schemas.indexOf(sch)]
          // Centinela presente cuya lectura falló: NO se degrada a `incapable` —eso sería inventar un
          // veredicto—. Se propaga, y el llamador lo trata como indeterminación.
          if (r === null) throw new Error(`el centinela de '${sch}' existe pero no se pudo leer`)
          return r.rows.length > 0 ? String(r.rows[0]!.probe ?? '') : ''
        })
        // Basta que UN centinela lea enmascarado para declarar la capacidad ausente: la capacidad es
        // del principal, no del schema, así que dos lecturas discordantes solo pueden significar algo
        // más raro — y ahí el lado seguro es el que apaga.
        unmask = valores.every((v) => v === UNMASK_PROBE_EXPECTED) ? 'capable' : 'incapable'
      }
    }
    return { protectedTables: new Set(prot.rows.map((row) => `${row.sch}.${row.tbl}`)), viewLineage, unboundViewLineage, ...(unmask ? { unmask } : {}) }
  }
}

/**
 * Decide qué vistas de máscara DECLARADAS se admiten como linaje, y por qué se rechaza cada una.
 *
 * EL CRITERIO, y la línea que no se cruza: la exigencia de `SCHEMABINDING` es lo que hace confiable
 * el linaje vista→base, así que aflojarla «para las vistas de máscara» exige un reconocedor que NO
 * sea falsificable por quien pueda crear vistas. Por eso NO se reconoce por el nombre: `vw_mask_x`
 * es una convención pública, y cualquiera con `CREATE VIEW` en un schema podría fabricar una vista
 * con ese nombre y quedar bendecido. Se exigen TRES legs, todas, y ninguna implica a las otras:
 *
 *  1. **Autoría** — el par (vista, base) viene DECLARADO por el emisor compilado
 *     (`FabricEnforcement.maskView`), que es el único que conoce el nombre real que emitió (el target
 *     puede sobreescribirlo con `maskViewName`). Sin declaración no hay camino: una vista
 *     no-schemabound que nadie declaró no hereda nada, igual que antes de H8.
 *  2. **Corroboración en la fuente** — `sys` tiene que confirmar que esa vista lee EXACTAMENTE esa
 *     base y nada más (una sola dependencia, resuelta intra-database). Una declaración que miente
 *     sobre su base, o que apunta a una vista que no existe, se cae acá: la declaración por sí sola
 *     sería confianza en la configuración, no evidencia.
 *  3. **Coherencia con el gobierno** — la base tiene que estar en el policy store Y declarar reglas
 *     de columna: sin reglas de columna el emisor NO habría emitido vista de máscara (`buildMaskView`
 *     devuelve `null`), así que la declaración está rancia o es falsa. Se usa el MISMO helper que el
 *     emisor (`columnRules`) para que las dos lecturas no puedan divergir.
 *
 * Lo que este reconocedor NO defiende, dicho para que nadie lo suponga: un actor con DDL sobre la
 * vista emitida puede reemplazar su cuerpo por uno sin las máscaras y el gate no lo vería (no se
 * compara el texto del módulo). Ese actor tiene, por construcción, el mismo privilegio que hace
 * falta para tirar la SECURITY POLICY de la base — está fuera del modelo de amenaza del gate desde
 * el issue #52. Lo que sí se cierra es el vector barato: alguien con `CREATE VIEW` y nada más.
 */
function admitMaskViews(
  decls: MaskViewDecl[],
  unbound: Map<string, string[]>,
  store: Map<string, PolicyDecl>,
): { edges: Map<string, string>; rejected: Map<string, string> } {
  const edges = new Map<string, string>()
  const rejected = new Map<string, string>()
  const byView = new Map<string, Set<string>>()
  for (const d of decls) {
    const v = normalizeRef(d.view)
    byView.set(v, (byView.get(v) ?? new Set<string>()).add(normalizeRef(d.base)))
  }
  for (const [view, bases] of byView) {
    // Dos declaraciones del MISMO nombre con bases distintas: no hay forma de saber cuál sirve el
    // motor (last-wins sería elegir al azar el gobierno de un PI). Se rechazan las dos.
    if (bases.size !== 1) {
      rejected.set(view, `declarada más de una vez con bases distintas (${[...bases].sort().join(', ')})`)
      continue
    }
    const base = [...bases][0]!
    const observed = unbound.get(view)
    if (!observed) {
      rejected.set(view, `declarada sobre '${base}' pero la fuente no reporta esa vista (o su dependencia no resuelve intra-database)`)
      continue
    }
    if (observed.length !== 1 || observed[0] !== base) {
      rejected.set(view, `declarada sobre '${base}' pero la fuente la ve leyendo ${observed.map((b) => `'${b}'`).join(', ')}`)
      continue
    }
    const pol = store.get(base)
    if (!pol) {
      rejected.set(view, `su base '${base}' no tiene política en el store`)
      continue
    }
    if (columnRules(pol).length === 0) {
      rejected.set(view, `su base '${base}' no declara reglas de columna: sin ellas el emisor no emite vista de máscara (declaración rancia)`)
      continue
    }
    edges.set(view, base)
  }
  return { edges, rejected }
}

export async function verifyFabricServability(opts: {
  pis: VerifiablePi[]
  store: Map<string, PolicyDecl>
  /** Estado de gobierno (secpol + linaje) de esa conexión. */
  sourceStateOf: (databaseRef: string) => Promise<SourceState>
  /** Estado previo (para conservar veredictos sanos ante indeterminación). */
  previous?: Map<string, PiVerdict>
  /**
   * Vistas de máscara emitidas por el compilador (#163 H8), tal como las declara
   * `FabricEnforcement.maskView`. Ausente (el caso de hoy) ⇒ ninguna vista no-schemabound hereda:
   * el gate se comporta EXACTAMENTE como antes. Declararlas NO alcanza para heredar — ver
   * `admitMaskViews`, que las corrobora contra la fuente y contra el store.
   */
  maskViews?: MaskViewDecl[]
}): Promise<FabricVerifyResult> {
  const { pis, store, sourceStateOf, previous } = opts
  const maskDecls = opts.maskViews ?? []

  // Solo las conexiones EN USO: la unión de los database_ref de los PI descubiertos.
  const usedRefs = [...new Set(pis.flatMap((p) => p.databaseRefs))]
  const stateByRef = new Map<string, SourceState>()
  const refErrors = new Map<string, string>()
  await Promise.all(
    usedRefs.map(async (ref) => {
      try {
        stateByRef.set(ref, await sourceStateOf(ref))
      } catch (e) {
        refErrors.set(ref, e instanceof Error ? e.message : String(e))
      }
    }),
  )
  // Linaje agregado (solo refs que respondieron): también alimenta la visibilidad del índice.
  const viewLineage = new Map<string, string[]>()
  for (const s of stateByRef.values()) for (const [v, bases] of s.viewLineage) viewLineage.set(v, [...new Set([...(viewLineage.get(v) ?? []), ...bases])])
  // Las vistas de máscara ADMITIDAS entran al linaje agregado que devuelve el gate: ese mapa es lo
  // que alimenta `canAccess` (visibilidad del índice, issue #54). Sin esta línea el PI podría ser
  // servible y aun así invisible — la vista no resolvería a ninguna política heredada.
  const unboundAll = new Map<string, string[]>()
  for (const s of stateByRef.values()) for (const [v, bases] of s.unboundViewLineage ?? []) unboundAll.set(v, [...new Set([...(unboundAll.get(v) ?? []), ...bases])])
  for (const [v, base] of admitMaskViews(maskDecls, unboundAll, store).edges) if (!viewLineage.has(v)) viewLineage.set(v, [base])

  const state = new Map<string, PiVerdict>()
  const inherited: InheritedGovernance[] = []
  for (const pi of pis) {
    const okRefs = pi.databaseRefs.filter((r) => stateByRef.has(r))
    const errRefs = pi.databaseRefs.filter((r) => refErrors.has(r))
    const protectedTables = new Set(okRefs.flatMap((r) => [...stateByRef.get(r)!.protectedTables]))
    const lineage = new Map<string, string[]>()
    for (const r of okRefs) for (const [v, bases] of stateByRef.get(r)!.viewLineage) lineage.set(v, [...new Set([...(lineage.get(v) ?? []), ...bases])])
    // Vistas de máscara: se admiten con la evidencia de LAS CONEXIONES DE ESTE PI (mismo criterio que
    // el linaje schemabound). La arista admitida se suma al linaje SOLO si el nombre no viene ya del
    // linaje schemabound: ante colisión manda la evidencia fuerte, que no depende de declaración.
    const unbound = new Map<string, string[]>()
    for (const r of okRefs) for (const [v, bases] of stateByRef.get(r)!.unboundViewLineage ?? []) unbound.set(v, [...new Set([...(unbound.get(v) ?? []), ...bases])])
    const { edges: maskEdges, rejected: maskRejected } = admitMaskViews(maskDecls, unbound, store)
    const viaMask = new Set<string>()
    for (const [v, base] of maskEdges) if (!lineage.has(v)) { lineage.set(v, [base]); viaMask.add(v) }

    // Resolver cada tabla del PI a sus HOJAS GOBERNADAS (BFS con guard de ciclos): una entrada del
    // store es hoja; una vista con linaje expande a sus bases; sin política NI linaje = no-gobernable.
    // INVARIANTE (sin cambios): toda hoja gobernada debe tener artefacto nativo. Una pública se
    // manifiesta con su SECURITY POLICY allow-all (doc 018) → "sin artefacto" = fuga.
    const needed = new Set<string>() // hojas gobernadas a verificar contra la secpol
    const unresolved: string[] = [] // sin política ni linaje derivable
    const piInherited: InheritedGovernance[] = []
    for (const t of pi.tables) {
      if (store.has(t)) {
        needed.add(t)
        continue
      }
      const seen = new Set<string>([t])
      const queue = [...(lineage.get(t) ?? [])]
      const bases: string[] = []
      let dead = queue.length === 0
      while (queue.length) {
        const b = queue.shift()!
        if (seen.has(b)) continue // ciclo defensivo: sys no debería producirlo
        seen.add(b)
        if (store.has(b)) {
          bases.push(b)
          continue
        }
        const deeper = lineage.get(b)
        if (!deeper?.length) {
          dead = true // una base sin política ni linaje corta la herencia (certeza o nada)
          break
        }
        queue.push(...deeper)
      }
      // Una herencia válida resuelve a AL MENOS una hoja gobernada: un ciclo de vistas sin base real
      // dejaría `bases` vacío y pasaría en silencio — certeza o nada.
      if (dead || bases.length === 0) {
        unresolved.push(t)
        continue
      }
      for (const b of bases) needed.add(b)
      // `via` solo se estampa en la herencia por vista de máscara: la clásica conserva su forma
      // literal (el log y sus aserciones de regresión no cambian ni un campo).
      piInherited.push(viaMask.has(t) ? { slug: pi.slug, view: t, bases, via: 'mask-view' } : { slug: pi.slug, view: t, bases })
    }

    if (needed.size > 0 && pi.databaseRefs.length === 0) {
      state.set(pi.slug, { ok: false, reason: `sus data-entries no declaran database_ref: no se puede verificar la RLS nativa de ${[...needed].join(', ')}.` })
      continue
    }
    const missing = [...needed].filter((t) => !protectedTables.has(t))

    // ── #238 · la precondición de desenmascarado, ANTES de poder declarar servible ────────────────
    // Solo aplica a PIs cuyas tablas declaran reglas de columna: sin plano de columna la capacidad
    // no cambia nada y exigirla apagaría PIs sanos. Se lee del MISMO helper que usa el emisor
    // (`columnRules`), para que las dos lecturas no puedan divergir.
    const needsUnmask = [...needed].some((t) => {
      const p = store.get(t)
      return p ? columnRules(p).length > 0 : false
    })
    const caps = okRefs.map((r) => stateByRef.get(r)!.unmask).filter((c): c is UnmaskCapability => c !== undefined)
    // MEDIDO Y AUSENTE ⇒ veredicto definitivo, y gana sobre todo lo demás: la vista de máscara
    // devuelve la máscara en AMBAS ramas del `CASE`, así que el PI serviría una capacidad muerta sin
    // que nada lo gritara. Servir enmascarado «con advertencia» se descartó en el diseño: la persona
    // con derecho no puede distinguir eso de «no traigo el claim».
    if (needsUnmask && caps.includes('incapable')) {
      state.set(pi.slug, {
        ok: false,
        reason:
          `el principal de serving NO puede desenmascarar (medido con el centinela ` +
          `${UNMASK_PROBE_TABLE_NAME}): el DDM enmascara en la lectura de la tabla, río arriba de la ` +
          `vista, y el claim de columna dejaría de conceder nada (#238). Concede al principal la ` +
          `capacidad de leer el valor real de las columnas gobernadas (en Fabric, rol Member del ` +
          `workspace; o GRANT UNMASK donde el motor lo soporte) — es cláusula del contrato de instancia.`,
      })
      continue
    }
    // SIN INSTRUMENTO ⇒ indeterminación, NO veredicto. Es el estado de una instancia que todavía no
    // regeneró su DDL: el centinela nace con el setup del emisor. Se trata como una conexión que no
    // respondió —el PI que YA servía conserva su veredicto sano— porque apagarlo sería castigar una
    // migración pendiente con un corte de servicio, y lo que falta acá es medición, no gobierno.
    const unmaskIndeterminado = needsUnmask && caps.length > 0 && caps.includes('uninstrumented')

    if (unresolved.length === 0 && missing.length === 0 && !unmaskIndeterminado) {
      state.set(pi.slug, { ok: true }) // veredicto definitivo: todo gobierno presente
      inherited.push(...piInherited)
      continue
    }
    if (errRefs.length > 0 || unmaskIndeterminado) {
      // INDETERMINADO: lo que falta (secpol o linaje) podría vivir en la conexión que no respondió.
      // Conservar el veredicto sano previo; en frío o ya degradado → fail-closed con el motivo.
      const prev = previous?.get(pi.slug)
      if (prev?.ok) {
        state.set(pi.slug, prev)
        continue
      }
      if (errRefs.length > 0) {
        state.set(pi.slug, {
          ok: false,
          reason: `no se pudo verificar la RLS nativa: conexión ${errRefs.map((r) => `'${r}'`).join(', ')} no respondió (${errRefs.map((r) => refErrors.get(r)).join(' · ')}).`,
        })
        continue
      }
      state.set(pi.slug, {
        ok: false,
        reason:
          `no se pudo verificar que el principal de serving desenmascara: el centinela ` +
          `${UNMASK_PROBE_TABLE_NAME} no está instalado en la fuente (#238). Regenera y re-aplica la ` +
          `DDL de la política — el centinela nace con ella. Sin medirlo no se sirve un PI con reglas ` +
          `de columna: la vista podría estar concediendo nada.`,
      })
      continue
    }
    // DEFINITIVO: las conexiones respondieron y el gobierno NO está. Fail-closed aunque antes sirviera.
    const reasons: string[] = []
    if (unresolved.length) {
      // El SITIO es la mitad del diagnóstico: si el objeto no resuelto fue DECLARADO como vista de
      // máscara, el motivo útil no es «sin linaje» sino POR QUÉ no se admitió esa declaración.
      const notas = unresolved.filter((t) => maskRejected.has(t)).map((t) => `${t}: ${maskRejected.get(t)}`)
      reasons.push(
        `tabla(s) sin política en el store y sin linaje de vista derivable: ${unresolved.join(', ')}. ` +
          `Declara la entidad en el policy store, o sírvela como vista WITH SCHEMABINDING sobre una base gobernada (herencia).` +
          (notas.length ? ` Vista(s) de máscara declarada(s) pero NO admitida(s) — ${notas.join(' · ')}.` : ''),
      )
    }
    if (missing.length) {
      reasons.push(
        `tabla(s) sin artefacto SECURITY POLICY en la fuente (gobernada → predicado-filtro; pública → allow-all): ` +
          `${missing.join(', ')}. Aplica la SECURITY POLICY (deploy/fabric-pushdown/, regenerada desde la política) antes de servir.`,
      )
    }
    state.set(pi.slug, { ok: false, reason: reasons.join(' Además: ') })
  }
  return { state, usedRefs, refErrors, inherited, viewLineage }
}
