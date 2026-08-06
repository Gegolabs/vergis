# Diseño #107 — Gestión de cargas por rol: de «observable» a «gestionable»

**Issue:** [Gegolabs/vergis#107] `feat(intake): gestión de cargas por rol — de «observable» a «gestionable»` (origen: instancia GH, pendiente `P-37`).
**Rol de este documento:** contrato de delegación (ww:wingcoding). Lo ejecuta un agente Opus en frío: todo lo que necesita está aquí o referenciado por ruta exacta.
**Repo:** `/Users/cesar/wworkspace/productos/vergis` (monorepo TS; workspaces `packages/*` + `server/` + `tests/` vitest).
**Gates:** `npm run typecheck` && `npm test` && `npm run build`. Producto pre-launch: rige el criterio de excelencia, sin scope creep.

**BASE = main + #105.** Este diseño ASUME mergeado el diseño de #105 (`diseno-gh105.md`, mismo directorio): existe `server/freshness-loop.ts` (`createFreshnessLoop`, lazo observar→alertar→reconciliar con debounce), la proyección `ingestion_run`/`ingestion_process_state` en el GovernanceStore, y el render de Frescura lee SOLO la proyección. #62 (registro de cargas `intake_upload`) ya está en main. Si al arrancar #105 aún no está en main, rebasar sobre su rama antes de empezar. Nada de #105/#62/#63 se re-diseña aquí; sus decisiones selladas se respetan (en particular D5–D12 de #105).

---

## ¿Qué pide el issue?

Hoy el andamiaje de ingestión —crear, publicar y agendar un job de carga— vive solo en el lab del operador: el usuario de la instancia **ve** el estado (Frescura, historial, log) pero no **gestiona**. El pedido: que un **perfil autorizado** pueda dar de alta un proceso de ingestión, publicarlo y fijarle cadencia **desde la plataforma**, con corte por rol (el resto sigue en solo-lectura) y fail-closed (sin rol declarado, nadie gestiona). El issue mismo ancla la solución en «la costura que ya existe (`IngestionEngineClient`: run-history, get/set schedule)».

## ¿Cuál es la realidad del código sobre la que se diseña?

Hechos verificados contra el código (2026-08-06, rama `main`, HEAD `63b6816` — #62 ya mergeado):

1. **La superficie Fabric que el repo consume son EXACTAMENTE cuatro familias de operaciones** (grep de todos los `fetch` a `api.fabric.microsoft.com` + DFS en `packages/capabilities/src`):
   - OneLake DFS: read/write/list/copy/remove de archivos (`intake-onelake.ts:98-178` y write-path).
   - `POST /workspaces/{ws}/items/{item}/jobs/instances` — **disparar** un job de un item YA existente (`createFabricJobs.runNow`, `intake-onelake.ts:185-202`).
   - `GET  …/jobs/instances` — **run-history** del item (`createFabricJobStatus.listInstances`, `intake-onelake.ts:227-250`).
   - `GET/POST/PATCH …/jobs/{jobType}/schedules` — **leer/fijar el schedule** del item (`createFabricScheduler`, `fabric-engine.ts:55-113`; el PATCH/POST envía `enabled: true` + configuración Cron).
   **No existe en el repo ninguna llamada que cree, actualice o publique un ITEM** (SJD/pipeline/notebook) ni su definición. «Publicar un SJD» es hoy acción del lab de la instancia, fuera de este repo.
2. **El registro de fuentes/procesos ya tiene TODOS los métodos de escritura, pero solo los llama la semilla.** `SourceRegistryStore` (`governance-store.ts:130-144`) declara `upsertSource`/`deleteSource`/`setTableSource`/`upsertProcess`/`deleteProcess`/`setProcessOutput`/`removeProcessOutput`, todos implementados con validación (`SLUG_RE`, `validateOferta`, engine_ref exige workspace+item, jobType default `Pipeline` — `governance-store.ts:697-795`). Ningún handler del server los invoca en runtime: la única escritura es la **semilla de arranque** desde `VERGIS_SOURCES` (yaml → `SqliteGovernanceStore.open(seed)`, `serve-rls.ts:774-789`, `governance-store.ts:430-452`), que re-siembra en cada boot con `ON CONFLICT DO UPDATE` (label/oferta/connected_by se pisan; domain y engine con COALESCE). **No hay `deleteTableSource`** en la interfaz.
3. **`VERGIS_SOURCES` NO participa del hot-reload.** El watcher de gobierno de dominio recarga conexiones + `VERGIS_DOMAINS` + `VERGIS_INTAKE` (`serve-rls.ts:1450-1455`); las fuentes/procesos solo entran al arrancar. Corolario: hoy un alta de proceso = editar el yaml en la VM **y reiniciar** — exactamente el cuello de botella que el issue denuncia.
4. **El modelo de roles existente tiene dos clases + un override de grupo** (`server/admin.ts:1-16,161-176`; `packages/capabilities/src/domain.ts:54-64`; doc canónica `docs/gestion-de-dominio.md` §1):
   - **admin de plataforma** — `AdminStore` en el GovernanceStore, gestionable in-app (`/admin/roles`). Gatea las secciones de Plataforma (Usuarios y Roles · Grupos · **Fuentes** · Settings) con `denyPlatform()` (403).
   - **steward de dominio** — correos en `domains.yaml` (`DomainDecl.stewards`) O miembros de un default-steward-group (`VERGIS_DEFAULT_STEWARD_GROUPS` → grupos de Mira). Gatea `/admin/dominio/<id>/*` (Frescura, Cargas, Maestra) vía `canMng`.
   - El gate de `/admin` es «admin O steward de algún dominio»; el acceso denegado se audita (`admin-access-denied`).
   - Además, la **demanda** de un PI la editan los colaboradores/dueños del PI (`pi-config.ts:115-133`), con techo validado.
5. **La cadencia NO es un número libre: se DERIVA.** `requiredCadence(proceso) = max(mín(demandas de los PIs), oferta de la fuente)` (`freshness.ts:76-84`; doc `docs/frescura-oferta-demanda.md` §3-4: «Mira es la fuente de verdad de la cadencia y la empuja al schedule del motor»). «Fijarle cadencia» en este producto = editar los INSUMOS de la derivación (oferta de la fuente; demanda del PI) + empujar el resultado (botón «Aplicar cadencia» hoy; lazo de reconcile de #105 al mergear).
6. **«Aplicar cadencia» existente**: POST a `/admin/dominio/<id>/frescura` (steward, CSRF) → `deps.applyCadence(processId, by)` → `getScheduleSeconds` + `reconcilePlan` + `setScheduleSeconds` si `set` + audit `frescura-aplicar-cadencia` (`admin.ts:280-292`, `serve-rls.ts:1144-1155`). #105 lo conserva (su D12) y le agrega re-observación de la proyección.
7. **`/admin/sources` es GET-only y solo-admin**: la vista Fuentes pinta el registro (fuente · oferta · dominio · procesos→entidades · conectada por) sin un solo form (`admin.ts:371-375,837-859`).
8. **Un schedule DESHABILITADO en el motor se lee igual que uno activo.** `getScheduleSeconds` toma `all.find((s) => s.enabled) ?? all[0]` y devuelve sus segundos (`fabric-engine.ts:91-95`): el shape parcial `FabricSchedule` ya modela `enabled` (lectura). Corolario: el reconcile de #105 (`reconcilePlan(desired, actual)`) da `noop` sobre un schedule deshabilitado cuyo intervalo coincide — **no lo re-habilita solo**; y `setScheduleSeconds` siempre escribe `enabled: true` (`fabric-engine.ts:78-88`) — re-habilita cuando empuja.
9. **Precedente de precedencia runtime-sobre-semilla ya construido en este mismo store**: los grupos de Mira se re-siembran en cada boot, pero un miembro removido in-app deja **tombstone** (`mira_group_seed_removed`) y el re-sembrado no lo resucita (`governance-store.ts:264,414-428,534-543`). Es el patrón exacto que el registro de fuentes necesita al volverse editable.
10. **El lazo de #105 lee sus insumos EN CADA TICK** (`inputs()` → `freshnessInputs()` → `govStore.listProcesses()` + demandas): un proceso dado de alta en el store entra al lazo (observación, alertas, reconcile) en el tick siguiente, **sin restart** — la convivencia alta↔lazo es natural, no requiere señal.
11. **Patrones de la casa que este diseño reusa tal cual**: POST + CSRF (`requireCsrf`/`csrfFactory`) + PRG con `msg` + audit append-only por mutación (`admin-roles-write`, `platform-setting`, `frescura-aplicar-cadencia`); errores de validación re-renderizan la página con 400/409; `ensureColumns` para migración de columnas (`governance-store.ts:267-274`); tests de rutas admin con `createAdmin` + deps mockeadas + `mockReq`/`mockRes` (`tests/admin-frescura-routes.test.ts`, `tests/admin-handler.test.ts`).

Conjeturas etiquetadas (Norma 6/7 — nada de esto se afirma como hecho):

- **[Conjetura C1]** La API REST de Fabric ofrece creación/actualización de items con definición (familia *Items – Create/Update Item Definition*). Proviene de conocimiento general, **no está verificada desde este repo ni contra el tenant**, y el repo no la consume. Por eso la fase 2 (abajo) queda **declarada, no diseñada**, con gate humano.
- **[Conjetura C2]** Fabric acepta `PATCH …/schedules/{id}` con `{ enabled: false, configuration: <eco de la leída> }` para pausar sin alterar la configuración. El endpoint y el verbo ya se consumen (hecho 1) y el campo `enabled` ya se escribe en `true`; el valor `false` no se ha ejercido contra motor vivo. → test con motor fake + gate manual G-M1. (Contexto: TODO el scheduler contra Fabric vivo está pendiente del G-M1 de #105.)
- **[Conjetura C3]** El sql.js empacado soporta `INSERT … SELECT … WHERE … ON CONFLICT DO UPDATE … WHERE …` (upsert condicional). El repo ya usa `INSERT … SELECT … WHERE NOT EXISTS … ON CONFLICT DO NOTHING` (`governance-store.ts:422-427`); la variante con `DO UPDATE … WHERE` es estándar de SQLite ≥3.24 pero no está ejercida aquí. Si el ejecutor la encuentra no soportada, la alternativa equivalente es leer `managed_at` antes y decidir en TS — el test T1 juzga la CONDUCTA, no el SQL.

---

## ¿Qué permite el motor HOY — y qué manda eso sobre el alcance?

| Capacidad pedida por el issue | ¿En la API que el repo consume? | Veredicto de alcance |
|---|---|---|
| **Fijar cadencia** a un proceso (schedule del item) | ✅ `jobs/{jobType}/schedules` GET/POST/PATCH (hecho 1) | **Fase 1** — ya existe el empuje; falta gestionarlo por rol de punta a punta (editar oferta in-app). |
| **Activar/desactivar** un proceso (pausar el schedule) | ✅ mismo endpoint; `enabled:false` es [Conjetura C2] acotada | **Fase 1** — con test fake + gate manual. |
| **Dar de alta un proceso** que apunta a un item YA publicado (workspace/item/jobType) + su fuente + sus salidas | ✅ es estado de Vergis (GovernanceStore, métodos ya implementados — hecho 2); el motor solo se LEE | **Fase 1** — el grueso del issue. |
| **Crear/publicar el item** (SJD/pipeline) en Fabric desde Vergis | ❌ ninguna llamada de autoría de items en el repo (hecho 1); [Conjetura C1] | **Fase 2** — declarada, no diseñada. Gate humano. |
| Alta in-app de **slots de intake** (landing + metadata + trigger) | n/a (config de instancia `VERGIS_INTAKE`, con hot-reload sin restart — hecho 3) | **Fuera de alcance declarado** (ver D10). |

**Declaración honesta de fase:** la fase que este documento manda a construir es MÁS CHICA que el pedido literal del issue. «Publicarlo» (crear/desplegar la definición del job en el motor) **no está al alcance de la API que Vergis consume hoy**, y además la definición misma (el código del convertidor) es terreno de la instancia (ADR-001: Vergis no parsea planillas; los diseños #62/#63 sellan la misma separación — *Vergis declara y propaga; el convertidor ejecuta*). La fase 1 entrega: **declarar procesos apuntando a definiciones ya publicadas + gestionar su cadencia + pausar/reanudar + todo por rol, con auditoría y fail-closed**. El issue **queda abierto** tras mergear la fase 1, con el comentario sellado en la última sección de este documento.

---

## ¿Cuáles son las decisiones de diseño? (selladas, con racional)

**D1 — Sin rol nuevo: el corte por rol se resuelve con el modelo existente.** Admin de plataforma = **conectar** (alta/edición/baja de fuentes, procesos, salidas y mapeos — acto técnico, transversal); steward del dominio = **operar** (aplicar cadencia — ya lo tiene —, pausar/reanudar); colaboradores del PI = **demanda** (ya existe, `pi-config`). Racional: (a) la doctrina canónica ya hace este corte a propósito (`docs/gestion-de-dominio.md` §1 «Fuentes (plataforma) vs Frescura (dominio) — un corte deliberado») y el criterio de excelencia no encuentra razón para un tercer mecanismo de rol: un «gestor de cargas» nuevo duplicaría al steward con otro nombre; (b) el pedido del issue («que exista un rol con esa potestad y que el resto siga en solo-lectura») se satisface: quien no es admin ni steward no ve ni un form (fail-closed ya vigente: sin `VERGIS_ADMIN_SEED`/stewards declarados, nadie gestiona — hecho 4); (c) la instancia puede delegar sin tocar código: nombrar admin al perfil autorizado (in-app, `/admin/roles`) o declararlo steward.

**D2 — Alcance de la fase 1 sellado (y el resto declarado fase 2).** Fase 1 = (i) CRUD in-app del registro de fuentes/procesos/salidas/mapeos en `/admin/sources` (admin), donde el proceso apunta a un item del motor **ya publicado**; (ii) pausar/reanudar por proceso en Frescura (steward); (iii) el guard de `applyCadence` sobre pausados; (iv) convivencia con el lazo de #105. Fase 2 (NO se construye aquí) = publicar/actualizar definiciones de items en el motor desde Vergis; exige verificar [Conjetura C1] contra el tenant, decidir el modelo de autoría (la definición es de la instancia) y su propio diseño — **gate humano exclusivo**.

**D3 — El registro de fuentes se vuelve propiedad del runtime con precedencia «lo editado in-app gana a la semilla».** La semilla `VERGIS_SOURCES` sigue existiendo (bootstrap declarativo, idempotente — nada cambia para instancias que no editan in-app), pero: (a) toda escritura in-app marca la fila (`managed_at`); (b) el re-sembrado de arranque **no pisa filas marcadas** (upsert condicional); (c) una baja in-app deja **tombstone** (`source_registry_removed`) y el re-sembrado no resucita el id; (d) un alta in-app de un id tombstoneado limpia el tombstone. Racional: es el patrón ya construido para los grupos (hecho 9) — dos escritores con precedencia declarada, sin drift silencioso. La alternativa (semilla solo-si-tabla-vacía) rompería a las instancias que hoy gestionan por yaml; la alternativa contraria (yaml siempre gana) convertiría cada edición in-app en una mentira con fecha de vencimiento en el próximo reboot — exactamente lo que la Norma 6 prohíbe institucionalizar.

**D4 — Superficies UI:** la gestión del registro vive en `/admin/sources` (la vista Fuentes gana forms: alta/edición/baja de fuente, alta/edición/baja de proceso con engine_ref, salidas proceso→tabla, mapeos tabla→fuente), porque es su casa doctrinal (hecho 4/7). La operación por proceso (pausar/reanudar) vive en `/admin/dominio/<id>/frescura`, junto a «Aplicar cadencia», porque es contrato del dominio. No se crea ninguna página nueva: se completan las dos existentes.

**D5 — Pausa de primera clase, con la verdad en Vergis y el empuje por la costura.** `ingestion_process` gana `paused_at`/`paused_by`. **Pausar** (steward): (1) `engine.setScheduleEnabled(processId, false)` — PATCH del schedule con `enabled:false` eco de configuración ([Conjetura C2]); (2) solo si el motor aceptó, `setProcessPaused(id, true, by)` + audit. Si el motor falla, NADA se registra (fail-closed: jamás un «pausado» en el producto con el motor corriendo). **Reanudar**: (1) `setProcessPaused(id, false, by)`; (2) `engine.setScheduleSeconds(id, desired)` — el camino existente, que escribe `enabled:true` con la cadencia derivada (hecho 8); si (2) falla, el lazo de #105 converge en el tick siguiente (el proceso ya no está pausado y su `desired` difiere o la ventana de debounce lo permite) — degradación honesta, visible en la página. Un proceso **sin schedule** en el motor no se puede pausar (error claro), y `setScheduleEnabled(ref, false)` sin schedule es no-op.

**D6 — Convivencia con el lazo de #105 (sellada por fase):** fase 1 (observar) **incluye** a los pausados — sus corridas y schedule siguen siendo visibles (la pausa no apaga la observabilidad); fase 2 (alertar) **excluye** a los pausados — un `missed` sobre un proceso pausado a propósito es ruido que entrena a ignorar alertas; fase 3 (reconciliar) **excluye** a los pausados — el lazo jamás re-habilita lo que un steward pausó (además del seguro estructural del hecho 8: `noop` sobre schedule deshabilitado con intervalo igual). El botón «Aplicar cadencia» **rechaza** procesos pausados (mensaje: `El proceso está pausado — reanúdalo antes de aplicar cadencia.`) y la UI no lo ofrece en filas pausadas. El alta/edición de registro convive sin señal alguna: el lazo relee el store en cada tick (hecho 10). La edición de oferta cambia el `desired` derivado → el lazo empuja de inmediato (D10 de #105: desired distinto no espera debounce).

**D7 — Validaciones fail-closed en la ruta (defensa en profundidad con el store):** ids slug (`SLUG_RE` — el store ya lanza); oferta `validateOferta` (ídem); **`sourceId` del proceso debe existir** en el registro (el store NO tiene FK — la ruta lo verifica y rechaza 400); **`domain` de la fuente, si viene, debe ser un dominio declarado** (`deps.domains` — un typo dejaría la fuente huérfana de toda vista de steward en silencio); engine_ref = **tripleta completa o nada** (workspace+item+jobType; parcial se rechaza); **baja de fuente con procesos o mapeos que la referencian → 409** (se listan los dependientes en el mensaje); baja de proceso → el store ya cascadea sus salidas (hecho 2, `deleteProcess`); CSRF en todo POST; todo deny se audita (`admin-access-denied` ya lo hace para el gate; los 400/409 re-renderizan con el error). La baja del registro **NO toca el motor** (el item y su schedule quedan como estén) — la página lo dice con sus palabras.

**D8 — Auditoría: eventos append-only sellados, sin tabla nueva.** Cada mutación del registro emite `{ type: 'sources-write', op: 'source-upsert'|'source-delete'|'process-upsert'|'process-delete'|'output-add'|'output-remove'|'table-map'|'table-map-remove', target: <id|ref>, by, …detalle }` (detalle: `oferta`/`domain` en source-upsert; `source`/`engine` en process-upsert; `table` en outputs/mapeos). Pausar/reanudar emite `{ type: 'frescura-pausa', process, paused: boolean, by }`. Racional: mismo trato que roles/grupos/settings (hecho 11) — el ESTADO vigente vive en el store (con `connected_by`, `managed`, `paused_by`/`paused_at` visibles en la UI); las ACCIONES son evidencia del audit log. Ninguna consulta del producto necesita indexar acciones de gestión (a diferencia de #62, donde `history()` sí consultaba — por eso aquélla migró a tabla y ésta no).

**D9 — La costura `IngestionEngineClient` gana UNA operación: `setScheduleEnabled(processRef, enabled)`.** Es la única capacidad remota nueva de todo el diseño, y va por la costura (no un cliente paralelo en el wiring) porque es SU razón de ser: el seam del motor. Impl. Fabric en `createFabricScheduler`: listar schedules, target = `find(enabled) ?? all[0]`; sin target → no-op si `enabled=false`, error claro si `enabled=true` (para habilitar se usa `setScheduleSeconds`); con target → `PATCH …/schedules/{id}` body `{ enabled, configuration: target.configuration }`. Nota de coordinación: #105 declaró `ingestion-observability.ts` intocable **para su ejecutor**; este diseño ejecuta DESPUÉS (base = main + #105) y la extensión es aditiva. Los fakes de `IngestionEngineClient` en `tests/freshness-loop.test.ts` (de #105) ganan el stub del método — cambio de #107, declarado en territorio.

**D10 — Fuera de alcance declarado (sin scope creep):** alta in-app de **slots de intake** (config de instancia con hot-reload sin restart — hecho 3; su DSL de metadata `#76/#95` es contrato con el convertidor, config-as-code); **run-now por proceso** (el re-run existe por slot en la consola de Cargas; duplicarlo por proceso no lo pide el issue); **edición de demanda** (ya existe con su propio rol, hecho 4); columnas de estado en `/admin/sources` (**#101**, que consumirá la proyección de #105); cualquier autoría de definiciones en el motor (fase 2). La vista Fuentes conserva su tabla actual; solo gana forms y badges de procedencia.

**Cero preguntas abiertas.** Ambigüedad no prevista ⇒ resolver con el principio: fail-closed honesto (nunca afirmar lo no observado, nunca registrar lo que el motor no aceptó), aditivo, por rol, y sin tocar las reglas duras.

---

## ¿Qué contratos y tipos exactos se introducen?

### `packages/capabilities/src/governance-store.ts` (TOCAR)

Migraciones (patrón `ensureColumns`, junto a las existentes en `open()`):

```ts
ensureColumns(db, 'source', ['managed_at TEXT'])
ensureColumns(db, 'ingestion_process', ['managed_at TEXT', 'paused_at TEXT', 'paused_by TEXT'])
```

DDL nuevo (tombstones del registro, precedente `mira_group_seed_removed`):

```sql
CREATE TABLE IF NOT EXISTS source_registry_removed (
  kind TEXT NOT NULL,          -- 'source' | 'process'
  id TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
```

Cambios de interfaz (aditivos; `SourceRegistryStore`):

```ts
export interface SourceRow {
  // …existente…
  /** true = fila gestionada in-app (la semilla no la pisa). */
  managed?: boolean
}
export interface ProcessRow {
  // …existente…
  managed?: boolean
  /** Pausa explícita (D5): el lazo no reconcilia ni alerta; el schedule del motor está deshabilitado. */
  pausedAt?: string
  pausedBy?: string
}
export interface SourceRegistryStore {
  /** `managed: true` = escritura in-app: marca managed_at, limpia tombstone. La semilla no lo pasa. */
  upsertSource(id: string, label: string, oferta: string, opts?: { domain?: string; connectedBy?: string; managed?: boolean }): Promise<void>
  /** Deja tombstone: el re-sembrado no resucita el id. */
  deleteSource(id: string): Promise<void>
  deleteTableSource(tableRef: string): Promise<void>                    // NUEVO
  upsertProcess(id: string, label: string, sourceId: string, engine?: EngineRef, opts?: { managed?: boolean }): Promise<void>
  deleteProcess(id: string): Promise<void>                              // ahora deja tombstone
  setProcessPaused(processId: string, paused: boolean, by?: string): Promise<void>  // NUEVO
  // …resto sin cambio…
}
```

Semántica exacta:

1. **Semilla (`open()`):** las filas de `seed.sources`/`seed.processes` se saltan si su id tiene tombstone (`INSERT … SELECT … WHERE NOT EXISTS`, patrón línea 422) y su `DO UPDATE` **no aplica** cuando `managed_at IS NOT NULL` ([Conjetura C3]: la forma SQL o su equivalente en TS — el test juzga conducta). El upsert de semilla **jamás toca** `managed_at`/`paused_at`/`paused_by`.
2. **`upsertSource`/`upsertProcess` con `managed: true`:** setean `managed_at = now()`, borran el tombstone de su id, y el `ON CONFLICT` conserva `paused_at`/`paused_by` (editar un proceso no lo des-pausa).
3. **`deleteSource`/`deleteProcess`:** borran la fila (+ cascada de `process_output` como hoy) e insertan tombstone (`OR IGNORE`).
4. **`setProcessPaused(id, true, by)`** → `paused_at = now()`, `paused_by = normEmail(by)`; **`(id, false)`** → ambos NULL. Sobre id inexistente: lanza (`Proceso desconocido`).
5. `listSources`/`listProcesses` pueblan `managed`/`pausedAt`/`pausedBy`.

### `packages/capabilities/src/ingestion-observability.ts` (TOCAR — solo la interfaz de la costura)

```ts
export interface IngestionEngineClient {
  // …los tres métodos existentes SIN cambio…
  /** Habilita/deshabilita el schedule del proceso sin tocar su configuración (pausa/reanudación).
   *  enabled=false sin schedule: no-op. enabled=true sin schedule: lanza (usar setScheduleSeconds). */
  setScheduleEnabled(processRef: string, enabled: boolean): Promise<void>
}
```

### `packages/capabilities/src/fabric-engine.ts` (TOCAR)

`FabricScheduler` gana `setScheduleEnabled(engine: EngineRef, enabled: boolean): Promise<void>` con la semántica de D9 (PATCH `{ enabled, configuration: target.configuration }`, timeout 30 s, error con status+cuerpo recortado como los demás). `createFabricEngineClient` lo expone resolviendo `processRef` → `EngineRef` (proceso sin engine_ref: no-op si `enabled=false`, lanza si `true` — coherente con `setScheduleSeconds`).

### `packages/capabilities/src/index.ts` (TOCAR — exports)

Sin exports nuevos de tipos (las interfaces cambiadas ya se exportan); verificar que `ProcessRow`/`SourceRow` sigan saliendo del mismo bloque.

### `server/admin.ts` (TOCAR — rutas + render)

`AdminDeps` gana:

```ts
/** Escritura del registro de fuentes (D3/D4). Sin él, /admin/sources queda GET-only como hoy. */
sourcesAdmin?: SourceRegistryStore
/** Pausa/reanudación de un proceso (D5): motor primero, store después. Lo implementa el wiring. */
pauseProcess?: (processId: string, paused: boolean, by: string) => Promise<void>
```

Rutas nuevas (todas: solo-admin vía `denyPlatform()` para las de `/admin/sources`; CSRF; audit D8; éxito → PRG a `/admin/sources?msg=…`; error de validación → 400/409 re-renderizando `sourcesPage` con el mensaje):

- `POST /admin/sources/source` — upsert fuente (`id`,`label`,`oferta`,`domain`). Valida D7 (domain declarado o vacío). `connectedBy = email`, `managed: true`.
- `POST /admin/sources/source-delete` — 409 si tiene procesos o mapeos dependientes (listados en el mensaje).
- `POST /admin/sources/process` — upsert proceso (`id`,`label`,`source`,`engine_workspace`,`engine_item`,`engine_job_type`). Valida: source existente; tripleta completa o los tres vacíos.
- `POST /admin/sources/process-delete`
- `POST /admin/sources/output-add` · `POST /admin/sources/output-remove` (`process`,`table`)
- `POST /admin/sources/table-map` · `POST /admin/sources/table-map-remove` (`table`,`source`)

`sourcesPage` (mismo archivo): conserva la tabla actual y gana (solo si `deps.sourcesAdmin`) los forms de alta/edición (edición = form pre-poblado vía `?edit=<id>` como hace `entityPage`), botones de baja con `confirm()` nativo (pauta `postForm`), y un badge de procedencia por fila: `semilla (yaml)` vs `gestionada in-app` (desde `managed`). Texto fijo junto a la baja de proceso: `La baja solo saca el proceso del registro de Mira — el item del motor y su schedule no se tocan.`

Frescura (mismo archivo): el POST existente de `/admin/dominio/<id>/frescura` pasa a rutear por `f['accion']`: ausente o `'aplicar'` → `applyCadence` (conducta idéntica a hoy — los tests vigentes no se tocan); `'pausar'`/`'reanudar'` → `deps.pauseProcess(process, accion==='pausar', email)` con PRG (`Proceso pausado.` / `Proceso reanudado.` / `Error: …`). `DomainEntityFreshness` gana `paused?: { at: string; by?: string }`; el render: fila pausada muestra `⏸ pausado por ⟨by⟩ · ⟨fmtWhen(at)⟩`, oculta «Aplicar», ofrece «Reanudar»; fila activa con schedule observado (`actualScheduleSeconds != null` y proyección no fría, D8 de #105) ofrece «Pausar».

### `server/serve-rls.ts` (TOCAR — wiring)

1. `createAdmin({ …, sourcesAdmin: govStore, pauseProcess })`.
2. `pauseProcess`: pausar = `engine.setScheduleEnabled(id, false)` → `govStore.setProcessPaused(id, true, by)` → audit `frescura-pausa`; reanudar = `setProcessPaused(id, false, by)` → audit → `engine.setScheduleSeconds(id, desired)` con catch logueado (D5; `desired` del mapa derivado, como `applyCadence`). Sin `fabricWiring.engine` → lanza `Sin conexión al motor`.
3. `applyCadence` gana el guard de pausado (primera línea tras resolver el proceso: si `paused`, lanzar con el texto de D6).
4. `domainFreshness`: puebla `paused` desde `procById` (aditivo al mapeo post-#105).

### `server/freshness-loop.ts` (TOCAR — filtros de D6)

Fase 2 y fase 3 filtran `p.pausedAt == null`; fase 1 (observar) NO filtra. Comentario de cabecera actualizado con la regla («la pausa apaga alerta y reconcile, nunca la observación»).

### Docs (TOCAR)

- `docs/gestion-de-dominio.md`: §1 — Fuentes deja de ser solo «registro técnico» de lectura: conectar/editar fuentes y procesos es gestión de plataforma in-app; la pausa/cadencia por proceso es gestión de dominio. Sin rastros evolutivos.
- `docs/frescura-oferta-demanda.md`: tabla «8 · Estado de implementación» — fila nueva de gestión por rol (registro editable in-app con precedencia sobre semilla; pausa por proceso); mencionar que la semilla `VERGIS_SOURCES` no pisa lo gestionado in-app.

---

## ¿Qué tareas, con qué territorio y qué «hecho cuando»?

Un solo ejecutor, secuencial T1 → T2 → T3 → T4 → T5 → T6. Rama sugerida: `feat/gestion-cargas-por-rol-107`. Base: main con #105 mergeado (verificar con `git log --oneline` que exista el commit de #105 — el que crea `server/freshness-loop.ts`; si no, rebasar sobre su rama). Toda edición cae DENTRO del territorio de su tarea.

### T1 — Store: precedencia, tombstones, pausa (`packages/capabilities`)

**Territorio:** tocar `packages/capabilities/src/governance-store.ts`, tocar `packages/capabilities/src/index.ts` (si hiciera falta export), tocar `tests/governance-store.test.ts` (agregar casos; los existentes NO se modifican).
**Hecho cuando:** `npx vitest run tests/governance-store.test.ts` verde, cubriendo como mínimo: upsert in-app (`managed:true`) marca `managed` y un `open()` posterior con semilla del mismo id **no pisa** label/oferta/domain; fila solo-semilla SÍ se re-siembra (conducta actual intacta); delete de fuente/proceso + re-`open()` con la semilla que los trae → **no resucitan**; upsert in-app posterior del mismo id limpia el tombstone y la fila vive; `setProcessPaused` true/false roundtrip con `pausedBy` normalizado y persistencia por archivo (`open(file)` → pausar → reabrir → sigue pausado); editar un proceso pausado (upsert managed) conserva la pausa; `deleteTableSource` elimina el mapeo y no toca otros; `deleteProcess` sigue cascadeando `process_output`; `setProcessPaused` sobre id inexistente lanza.

### T2 — Costura del motor (`ingestion-observability.ts` + `fabric-engine.ts`)

**Territorio:** tocar `packages/capabilities/src/ingestion-observability.ts` (solo la interfaz), tocar `packages/capabilities/src/fabric-engine.ts`, tocar `tests/frescura-frente-b.test.ts` (agregar casos), tocar `tests/freshness-loop.test.ts` (SOLO agregar el stub `setScheduleEnabled` a los fakes existentes — sus asserts no se tocan en esta tarea).
**Hecho cuando:** `npx vitest run tests/frescura-frente-b.test.ts tests/freshness-loop.test.ts` verde, con casos nuevos (fetch fake, patrón existente del archivo): `setScheduleEnabled(ref,false)` con un schedule enabled → PATCH a `…/schedules/<id>` con body `enabled:false` y `configuration` eco de la leída; sin schedules → **cero** llamadas de escritura y resuelve; `enabled:true` sin schedule → lanza con mensaje que nombra `setScheduleSeconds`; error HTTP → lanza con status; vía `createFabricEngineClient`, proceso sin engine_ref → no-op con `false` y lanza con `true`.

### T3 — Server: CRUD de Fuentes + pausa en Frescura (`server/admin.ts`)

**Territorio:** tocar `server/admin.ts`, crear `tests/admin-sources.test.ts`, tocar `tests/admin-frescura-routes.test.ts` (agregar casos; los existentes NO se modifican).
**Hecho cuando:** `npx vitest run tests/admin-sources.test.ts tests/admin-frescura-routes.test.ts` verde. `admin-sources.test.ts` (arnés `createAdmin` + `SqliteGovernanceStore.open(null)` real como `sourcesAdmin` + mocks del resto) cubre como mínimo: **(a)** no-admin → 403 en GET con forms ausentes y en todo POST de `/admin/sources/*` (y el steward NO admin también 403); **(b)** alta de fuente válida → 302, fila en el store con `connectedBy` = email y `managed`, audit `sources-write` con op/target/by; **(c)** oferta inválida → 400 con mensaje y sin fila; domain no declarado → 400; id no-slug → 400; **(d)** alta de proceso con tripleta parcial → 400; con source inexistente → 400; con tripleta completa → 302 y `engine` en el store; **(e)** baja de fuente con proceso dependiente → 409 nombrando el proceso; sin dependientes → 302 y tombstone efectivo (re-open con semilla no la revive — puede delegarse a T1, aquí basta la fila ausente); **(f)** output-add/remove y table-map/map-remove reflejados en el store; **(g)** CSRF inválido → 403 en todos; **(h)** GET sin `sourcesAdmin` → página actual sin forms (regresión cero). `admin-frescura-routes.test.ts` agrega: POST `accion=pausar` invoca `pauseProcess(id,true,email)` y redirige con `Proceso pausado.`; `accion=reanudar` análogo; POST sin `accion` sigue llamando `applyCadence` (fixtures existentes sin editar); fila con `paused` renderiza `⏸ pausado por` + botón Reanudar y NO el botón Aplicar ni Pausar; fila activa con schedule observado renderiza Pausar.

### T4 — Wiring + lazo (`server/serve-rls.ts`, `server/freshness-loop.ts`)

**Territorio:** tocar `server/serve-rls.ts` (deps nuevas, `pauseProcess`, guard en `applyCadence`, `paused` en `domainFreshness`), tocar `server/freshness-loop.ts` (filtros D6 + comentario), tocar `tests/freshness-loop.test.ts` (agregar casos).
**Hecho cuando:** `npx vitest run tests/freshness-loop.test.ts tests/serve-rls.test.ts tests/acceptance.test.ts` verde. Casos nuevos del lazo (arnés de #105: store real + engine fake + now inyectado): proceso pausado con drift de schedule → **cero** `setScheduleSeconds` en N ticks; proceso pausado vencido de cadencia → **cero** alertas (y uno NO pausado en el mismo tick sí alerta — el filtro no apaga la fase); proceso pausado → su observación SÍ se registra (snapshot con runs/schedule frescos); despausar (limpiar en el store) → el tick siguiente reconcilia. `serve-rls`/`acceptance` no cablean Fabric: sin `engine` nada nuevo se activa — regresión cero.

### T5 — Docs + comentario del issue

**Territorio:** tocar `docs/gestion-de-dominio.md`, tocar `docs/frescura-oferta-demanda.md`.
**Hecho cuando:** ambos docs reflejan D3/D4/D5 sin rastros evolutivos, y el comentario de la última sección de este documento queda publicado en el issue #107 (lo publica el orquestador/humano al mergear — el ejecutor solo verifica que el texto del doc siga siendo fiel a lo construido y reporta cualquier divergencia).

### T6 — Juez completo

**Hecho cuando:** `npm run typecheck && npm test && npm run build` — los tres verdes en el árbol integrado, con TODOS los tests nuevos incluidos en `npm test`.

### G-M1 — Gate diferido/manual (motor vivo — NO es de CI; se declara, no bloquea el merge)

Requiere la instancia GH (Fabric vivo; skill `mira-ops`): (1) validar [Conjetura C2] — pausar un proceso real y verificar en el motor que el schedule quedó `enabled:false` con su configuración intacta; reanudar y verificar `enabled:true` con la cadencia derivada; (2) alta in-app de un proceso apuntando a un item real → aparece observable en Frescura al tick siguiente sin restart; (3) reiniciar el server y verificar que las filas gestionadas in-app sobreviven a la re-siembra de `VERGIS_SOURCES` y que las borradas no resucitan; (4) confirmar que el lazo no empuja schedule a los pausados (log callado + audit sin `frescura-reconcile` de esos procesos).

---

## ¿Qué NO se toca? (reglas duras)

- **Las funciones puras de `ingestion-observability.ts`** (`classifyProcess`, `reconcilePlan`, `freshnessAlerts`, `diffAlertState`, `parseAlertState`) y `RunRecord`: la ÚNICA edición permitida en ese archivo es el método nuevo de la interfaz `IngestionEngineClient` (D9).
- **Los invariantes de #104/#105 en el lazo**: hidratación en el primer tick, persistencia del estado de alertas solo en transición, textos de Slack, semántica de la proyección (D5/D6/D8 de #105), debounce D10. Los filtros de D6 se AGREGAN; nada se reordena.
- **El contrato de lectura `listRunSnapshots` (D6 de #105)** no cambia de forma: #101 lo consumirá tal cual.
- **`applyCadence` conserva ruta, CSRF y evento `frescura-aplicar-cadencia`** (D12 de #105); solo gana el guard de pausado.
- **No tocar**: `server/multipart.ts`, `intake.ts`, el write-path de `intake-onelake.ts`, `admin-cargas.ts` y todo el territorio de #62/#63 (`intake_upload`, `intake_revert`, precheck, backfill), `freshness.ts` (la matemática de derivación), miranda*, notas*, master-data*, `packages/policy`, engines de serving, el pipeline/SJD de la instancia (fuera del repo).
- **La semilla de grupos y sus tombstones** (`mira_group_seed_removed`) no se generalizan ni se renombran: el registro usa SU tabla propia.
- **La forma de los eventos de audit ya escritos** (append-only): los eventos nuevos son tipos nuevos.
- No modificar tests existentes salvo AGREGAR casos (excepción declarada: los fakes de `tests/freshness-loop.test.ts` ganan el stub `setScheduleEnabled` — sus asserts no se editan).
- Sin dependencias npm nuevas. UI en español; textos sellados de D5/D6/D7 tal cual.
- Atención al leer `server/admin.ts`: un safeguard automático a veces corta su lectura — leer por rangos si pasa.

## ¿Quién juzga?

`npm run typecheck && npm test && npm run build` — los tres verdes, incluyendo `tests/admin-sources.test.ts` nuevo y los casos agregados en `tests/governance-store.test.ts`, `tests/frescura-frente-b.test.ts`, `tests/freshness-loop.test.ts` y `tests/admin-frescura-routes.test.ts`. El síntoma (un admin da de alta un proceso sin tocar la VM; un steward pausa y el lazo no lo revive; un no-autorizado no puede nada) lo observan T3/T4 con stores reales y motor fake. La conducta contra Fabric vivo y la supervivencia al reboot real quedan en G-M1 (diferido, declarado). El deploy a la VM es hand-off humano (skill `mira-ops`).

## Reparto de autoridad

- **Decide el ejecutor:** nombres de helpers privados, layout HTML de los forms dentro de la pauta existente, la forma SQL del upsert condicional (o su equivalente en TS — [Conjetura C3]), organización interna de los tests. Registra en el reporte final.
- **Consulta antes:** cualquier cambio a los textos sellados, a los eventos de audit, a la forma de la costura (D9), o a los intocables.
- **Exclusivo del humano:** publicar el comentario en el issue, deploy, correr G-M1, decidir la fase 2 (y verificar [Conjetura C1] contra el tenant).

## ¿Qué riesgos quedan y cómo los acota el diseño?

| Riesgo | Acotación |
|---|---|
| [C2] Fabric rechaza el PATCH `enabled:false` (pausa inoperante en vivo) | El fallo del motor aborta la pausa ANTES de registrarla (D5: nada queda «pausado» en falso); test fake sella el contrato del lado Vergis; G-M1 lo verifica en vivo. Si falla allá, es un fix de `fabric-engine.ts` (forma del body), no un rediseño. |
| Alguien deshabilita el schedule DIRECTO en el motor (drift no visto: Vergis muestra la cadencia leída del schedule apagado — hecho 8) | Riesgo pre-existente, no introducido aquí. Se detecta por la alerta `missed` (el proceso deja de correr) y por G-M1. Extender la proyección con `enabled` observado es territorio del contrato D6 de #105 → se difiere a #101 o a un issue propio; declarado, no callado. |
| La re-siembra pisa una edición in-app (mentira con fecha de reboot) | D3: `managed_at` + tombstones con test de round-trip por archivo (T1) y verificación en vivo (G-M1.3). |
| Un admin borra una fuente y deja procesos/mapeos colgando | D7: 409 con dependientes nombrados; el store además cascadea salidas solo en la baja de proceso. |
| El lazo re-habilita un proceso pausado | Doble seguro: filtro explícito de fase 3 (D6, con test T4) + estructural (hecho 8: `noop` sobre schedule deshabilitado de intervalo igual). |
| Reanudar con el motor caído deja pausa a medias | D5: el flag se limpia primero y el empuje lo repite el lazo al tick siguiente (convergencia); la página muestra el estado real (proyección de #105). |
| Un steward gestiona el registro transversal (escalada horizontal) | Las rutas de `/admin/sources/*` pasan TODAS por `denyPlatform()` (solo admin); test T3-a lo asserta con un steward no-admin. |
| El alcance de fase 1 se lee como cierre del issue | El comentario sellado de abajo lo explicita; el issue queda abierto con la fase 2 etiquetada. |

---

## ¿Qué comentario deja el issue abierto y honesto? (texto sellado, publicar al mergear la fase 1)

> **Fase 1 mergeada — el issue queda abierto para la fase 2.**
>
> Lo que entra con esta fase (todo por rol, con auditoría y fail-closed):
> - **Alta/edición/baja in-app** de fuentes, procesos (con su `engine_ref` a un item del motor **ya publicado**), salidas y mapeos, en Plataforma → Fuentes (admins). Lo gestionado in-app sobrevive a la re-siembra de `sources.yaml`; lo borrado no resucita.
> - **Cadencia por rol**: oferta editable in-app (admin) + demanda por PI (colaboradores, ya existente) + empuje al motor («Aplicar cadencia» y el lazo de reconcile de #105).
> - **Pausar/reanudar** un proceso desde Frescura (stewards del dominio): deshabilita/rehabilita el schedule en el motor; el lazo automático respeta la pausa.
>
> Lo que NO entra, y por qué: **crear/publicar la definición del job (SJD/pipeline) en el motor desde Vergis**. La API de Fabric que Vergis consume hoy dispara jobs, lee historial y gestiona schedules — no autora items; y la definición del convertidor es terreno de la instancia (misma separación de #62/#63: Vergis declara y propaga, el convertidor ejecuta). Habilitarlo exige verificar la API de autoría de items contra el tenant y un diseño propio de «publicación» (plantillas de la instancia, versionado, permisos del SP). Esa es la **fase 2** de este issue: queda aquí, pendiente y con gate humano.

---

*Diseño Fable (ww:wingcoding) · cluster 002 · 2026-08-06 · Issue #107 · Base declarada: main + #105. Toda operación remota que este diseño asume está verificada en el código citado (las cuatro familias de la API consumida — hecho 1) o etiquetada [Conjetura C1–C3] con su gate; la fase implementable hoy es menor que el pedido del issue y está declarada como tal, con el comentario de issue sellado.*
