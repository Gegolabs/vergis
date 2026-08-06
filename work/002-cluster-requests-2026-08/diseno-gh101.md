# Diseño · Issue #101 — Estado de las ingestas en la vista transversal de Fuentes

**Rol:** documento de diseño ejecutable (contrato de delegación wingcoding). El ejecutor arranca en frío: todo lo que necesita está aquí o en las rutas exactas citadas. Repo: `/Users/cesar/wworkspace/productos/vergis` (monorepo TypeScript; `packages/capabilities` = librería; `server/` = módulos de `serve-rls`; `tests/` = vitest).

**Issue:** [Gegolabs/vergis#101] — `/admin/sources` lista todas las fuentes (oferta, dominio, procesos, entidades) pero SIN estado: en una instancia con 7 dominios hay que abrir 7 pantallas de Frescura para responder «¿mis ingestas corrieron?». Pedido: por proceso, (1) última corrida con desenlace, (2) schedule observado (la ausencia es información), (3) salud con el mismo criterio de la Frescura — con enlace al detalle. Un proceso sin `engine_ref` debe decir que no es observable, no mostrarse vacío. No es pantalla nueva: son columnas sobre lo ya construido, y la vista se queda donde vive (no se muda de sección).

**BASE ASUMIDA (declarada): `main` + #105 + #99 mergeados.** Este diseño se apoya en dos diseños hermanos SELLADOS y no los contradice:

- **#105** (`work/002-cluster-requests-2026-08/diseno-gh105.md`): la proyección `ingestion_run` + `ingestion_process_state` en el GovernanceStore, con contrato de lectura **sellado expresamente para esta vista** (su D6): `IngestionRunSnapshot` / `listRunSnapshots()`. Su D8 sella además el tipo `FreshnessProjectionMeta` (en `server/admin.ts`) y los SEIS textos de staleness que esta vista HEREDA tal cual. Su D9 sella `freshnessPollMs` (default 300 000; `0` = lazo apagado) declarado ANTES de `createAdmin` en `serve-rls.ts`.
- **#99** (`work/002-cluster-requests-2026-08/diseno-gh99.md`): la página de una corrida `/admin/dominio/<id>/corrida?proc=<processId>&started=<ISO>` (su D5), con gate de dominio y estados de ausencia declarados. Sus enlaces usan el `startedAt` EXACTO del `RunRecord` — y la proyección de #105 lo guarda tal cual (su D2), así que el enlace desde esta vista casa exacto.

Las citas `archivo:línea` de abajo son contra `main` HEAD `63b6816` (2026-08-06, pre-merge de #105/#99): los números pueden correr tras esos merges — **la referencia estable es el nombre del símbolo**, no la línea.

---

## ¿Cuál es la realidad del código sobre la que se diseña?

Hechos verificados contra el código (2026-08-06, rama `main`, HEAD `63b6816`):

1. **La vista vive en `/admin/sources`, es solo-admin y hoy no tiene estado.** Ruta en `server/admin.ts:371-375` (`if (!isAdmin) return denyPlatform()`); render en `sourcesPage` (`admin.ts:837-859`): tabla `Fuente | Oferta | Dominio | Procesos → entidades | Conectada por`, una `<tr>` por FUENTE, con los procesos apilados en una celda (`procCell`, `admin.ts:841-845`). La bajada declara el hueco que el issue ataca: «La frescura (brecha vs. demanda, corridas, schedule) se gestiona en cada dominio» (`admin.ts:855`). En el sidebar vive en el scope de plataforma (`admin.ts:188` → scope `config`; entrada `Fuentes`, `admin.ts:611`).
2. **`procCell` ya resuelve el `engine_ref` por proceso** y ya declara el no-observable: `p.engine ? engineKind(p.engine.jobType) : null` → `· sin motor (no observable)` o `· Spark Job` / `⚠ migrar a Spark Job` si Notebook (`admin.ts:842-843`; `engineKind` en `admin.ts:861-868`). Debajo lista las entidades de salida (`outsOf`).
3. **El dato de la vista viene de `sourceRegistry`** (`AdminDeps`, `admin.ts:124`), cableado en `serve-rls.ts:1101-1104`: tres listados del govStore (`listSources` + `listProcesses` + `listProcessOutputs`), CERO llamadas al motor. `listSources` ordena por `source_id ASC` (`governance-store.ts:710`), `listProcesses` por `process_id ASC` (`governance-store.ts:763`). `SourceRow.domain` es **opcional** (`governance-store.ts:102-110`), `ProcessRow.engine` es opcional (`governance-store.ts:120-127`).
4. **El render de estado de una corrida ya existe en Frescura y es la vara de coherencia:** `statusBadge` (`✓ Listo` / `✕ Falló` / `⏳ Procesando` / `⏳ En cola` / `⊘ Cancelada` / `⊘ Omitida (duplicada)` — `admin.ts:713-723`), `fmtWhen` (edad relativa `hace 2 h`, fecha ISO si ≥ 1 día — `admin.ts:732-740`), `runErrorLine` (error recortado a 300 — `admin.ts:726-730`), y la celda `freshnessHealthCell` (`admin.ts:872-881`) con bandera ` · ✕ fallida` / ` · ⚠️ atrasada` / ` · ✓`. La columna «Schedule motor» de Frescura pinta `sin motor` / `secondsToDuration(s)` / `sin schedule` (`admin.ts:1076-1080`; `secondsToDuration` da ISO-8601 legible, p. ej. `PT2H` — `freshness.ts:50-61`).
5. **La salud es UNA clasificación, pura y probada:** `classifyProcess(runs, requiredCadenceSeconds, nowMs)` → `ProcessHealth { lastStatus, lastSuccessAt, ageSeconds, failed, missed }` (`ingestion-observability.ts:25-46`); `failed = lastStatus === 'Failed'`; `missed = sin éxito reciente vs cadencia`. La cadencia requerida por proceso la da `deriveIngestionMap` (`freshness.ts:126-157`), que EXCLUYE procesos event-driven (sin cadencia que derivar). El insumo (`freshnessInputs`) vive en `serve-rls.ts:1003` y lee solo el govStore + demandas (local).
6. **En la base asumida (#105), `domainFreshness` ya lee SOLO la proyección**: `listRunSnapshots()` sin opts (default 10 corridas/proceso) → mapeo síncrono con `runs` solo si `observedAt != null`, `health` vía `classifyProcess`, y `projection: { observedAt, stale, lastError, off }` con `stale = off || edad > 3 × freshnessPollMs` (diseño #105, sección `serve-rls.ts` punto 2). Esa fórmula y esos textos son los que esta vista hereda.
7. **La bandera de Frescura con `health` indefinido dice `· ✓`** (`admin.ts:879`: `r.health?.failed ? … : r.health?.missed ? … : ' · ✓'`) — es decir, hoy una entidad event-driven cuya última corrida FALLÓ luce `✕ Falló … · ✓`. Ningún test lo asserta (los fixtures de `tests/admin-frescura-routes.test.ts:20-34` traen `health` definido); D4 lo corrige al compartir el render.
8. **Tests actuales de la vista**: `tests/admin-frescura-routes.test.ts:76-87` — GET `/admin/sources` como admin contiene `SAP B1` y `fct_saldos`; steward recibe 403. Son asserts de `toContain`: reestructurar la tabla no los rompe. Patrón de test: `createAdmin` con deps mockeadas + `mockReq`/`mockRes` (`tests/admin-frescura-routes.test.ts:36-73`).
9. **El colspan del vacío es literal**: `colspan="5"` cuando no hay fuentes (`admin.ts:857`) — con columnas nuevas debe volverse dinámico.
10. **El dashboard ya resume ingestión en un tile** (`admin.ts:674-682`, solo `unsatisfiable` del mapa derivado) — no es la vista de estado pedida y no se toca.

**Cero conjeturas de mecanismo pendientes:** todo lo afirmado arriba está leído del código citado; lo que depende de #105/#99 está referido a sus decisiones selladas, no re-derivado.

---

## ¿Cuáles son las decisiones de diseño? (selladas, con racional)

**D1 — El estado llega por una dependencia nueva `processStates` que lee SOLO la proyección de #105: una lectura para toda la tabla, cero motor en el request path.**
`AdminDeps` gana `processStates?: () => Promise<ProcessIngestionState[]>` (por proceso observable: última(s) corrida(s), schedule observado, salud, meta de proyección). El wiring la implementa con `listRunSnapshots()` (UNA llamada, default 10 corridas/proceso — las mismas entradas que la Frescura de #105, hecho 6) + `deriveIngestionMap` para las cadencias. `sourcesPage` hace `Promise.all([sourceRegistry(), processStates()])` — sin awaits por fila. Racional: el contrato D6 de #105 fue sellado PARA esta vista; separar registro (topología) de estado (observación) mantiene a `sourceRegistry` intacto y a la página utilizable sin motor.

**D2 — Sin `processStates` cableada, la página es EXACTAMENTE la de hoy.**
La dep es opcional y el wiring la provee solo si `fabricWiring.engine` existe (misma condición que enciende el lazo de #105). Instancias ClickHouse (sin run-history — diseño #99, hecho 5) y los tests existentes (que no la pasan) rinden la tabla actual de 5 columnas sin editar un assert. Racional: regresión cero observable; no se fabrican columnas de estado donde no hay quien las observe.

**D3 — Anclaje por PROCESO: una `<tr>` por proceso, con las celdas de la fuente en `rowspan`. Columnas exactas (con estado): `Fuente | Oferta | Dominio | Proceso → entidades | Schedule | Última corrida | Conectada por`.**
El issue pide columnas «por proceso» — con N procesos por fuente eso exige fila por proceso, no celdas apiladas. La primera fila de cada fuente lleva `Fuente`/`Oferta`/`Dominio`/`Conectada por` con `rowspan="N"`; fuente sin procesos = una fila con `—` en las celdas de proceso/estado. La salud NO es columna aparte: viaja como bandera dentro de «Última corrida», igual que en Frescura (hecho 4) — el desenlace y su interpretación se leen juntos. Racional: coherencia visual con la vista que el usuario ya sabe leer, y una tabla que escala en filas (procesos), no en anchura.

**D4 — La celda «Última corrida» es EL MISMO render de Frescura, extraído a un helper compartido `runStateCell`; una sola fuente de textos, cero segunda clasificación.**
Se extrae de `freshnessHealthCell` (tal como quede implementada por #105/#99) la parte que rinde corridas + salud + proyección: `statusBadge(runs[0].status) fmtWhen(runs[0].startedAt) · bandera` + `runErrorLine` + enlace «Ver log» opcional + nota de proyección. `freshnessHealthCell` pasa a ser `prefijo de motor` + `runStateCell(...)`; `sourcesPage` llama `runStateCell` directo (el tipo de motor ya vive en la celda del proceso — hecho 2). **Los textos sellados por #105 (D8) y #99 no cambian ni una letra; los tests existentes de ambos frentes pasan sin editar** — ese es el juez de la extracción. La salud viene precalculada en el wiring con `classifyProcess` + el mapa derivado (la MISMA llamada, mismos insumos que la Frescura de #105 — hecho 6): no se inventa clasificación nueva. Único delta de conducta, sellado y honesto: con `health` indefinido (proceso sin cadencia requerida: event-driven o sin demanda), la bandera es ` · ✕ fallida` si `runs[0].status === 'Failed'` (el MISMO criterio `failed` de `classifyProcess`, hecho 5) y ` · ✓` en el resto; ` · ⚠️ atrasada` solo existe con cadencia. Esto corrige de paso el `✕ Falló … · ✓` contradictorio de Frescura (hecho 7) — ningún assert vigente lo observa.

**D5 — Columna «Schedule»: la semántica sellada de #105, heredada.**
Proyección fría (`observedAt: null`) → `—` (afirmar «sin schedule» sería afirmar lo no observado — #105 D8); `scheduleSeconds: null` observado → `sin schedule` (la ausencia ES información — pedido 2 del issue); si no → `secondsToDuration(scheduleSeconds)` (ISO legible, igual que Frescura — hecho 4). Sin motor → `—` (la declaración de no-observable vive en «Última corrida», D6).

**D6 — Proceso sin `engine_ref`: estado DECLARADO, nunca celda vacía — y la declaración vive en una sola celda.**
Con columnas de estado, «Última corrida» dice `no observable (sin motor)` y «Schedule» dice `—`; la coletilla `· sin motor (no observable)` de `procCell` se OMITE en ese modo (la columna de estado es ahora su dueña — decirlo dos veces por fila es ruido). Sin `processStates` (D2), `procCell` queda como hoy, coletilla incluida. Distinción sellada que el issue exige: «no observable» (sin motor) ≠ «sin corridas» (motor observado que nunca corrió) ≠ «esperando el primer refresco del motor» (proyección fría) — tres textos distintos, los dos últimos heredados de Frescura/#105 vía `runStateCell`.

**D7 — Staleness visible: los SEIS estados/textos de #105 (D8) se heredan tal cual, por celda, sin banner nuevo.**
`runStateCell` rinde la nota de proyección con los textos sellados: `esperando el primer refresco del motor` (fría, lazo activo) · `el motor no respondió al refresco — sin datos aún (se reintenta solo)` (fría + error) · sin línea extra (fresca sana) · `⚠ el último refresco falló — datos de ⟨fmtWhen(observedAt)⟩` · `⚠ datos de ⟨fmtWhen(observedAt)⟩ — el refresco no está corriendo` (stale) · `refresco apagado — datos de …` / `refresco apagado — sin datos` (off). Racional: cero textos nuevos = cero deriva entre vistas; el helper compartido lo garantiza por construcción.

**D8 — Enlaces: la celda «Dominio» enlaza a la Frescura del dominio; la última corrida enlaza «Ver log» a la página de #99.**
(a) `Dominio` deja de ser texto: `<a href="/admin/dominio/<domain>/frescura">` (el detalle sigue viviendo ahí — fuera de alcance del issue moverlo). (b) Junto a la última corrida: ` · Ver log` → `/admin/dominio/<domain>/corrida?proc=<processId>&started=<encodeURIComponent(runs[0].startedAt)>` — mismo patrón y mismo gating que #99 en Frescura: solo si `deps.runLogs` está cableada y hay corrida. Ambos enlaces exigen `source.domain` presente: una fuente sin dominio no enlaza (no hay Frescura que abrir, y la página de #99 valida pertenencia por el dominio de la fuente — su D6 devolvería `sin-convencion`; no se ofrece un enlace que nace muerto). Racional: el pedido del issue («con enlace al detalle») con las dos superficies hermanas exactas, sin rutas nuevas.

**D9 — Orden y agrupación: fuentes ordenadas por (dominio ASC, sin-dominio al final, luego id de fuente); procesos dentro de la fuente en su orden de registro.**
La pregunta del issue es por instancia pero se responde dominio a dominio: agrupar por dominio convierte la tabla en un barrido vertical de 7 bloques en vez de un salpicado. La agrupación es por ORDEN (el `rowspan` + la columna Dominio ya la hacen visible); sin headers de sección ni subtablas. Orden estable y determinista (los tests lo observan). Racional: máxima legibilidad con cero estructura nueva.

**D10 — Fail-safe de la página: si `processStates()` lanza, la tabla rinde SIN columnas de estado con un aviso, nunca un 500 ni celdas mentirosas.**
`sourcesPage` envuelve la llamada en `catch` → banner `<p class="msg err">⚠ No se pudo leer el estado de las ingestas — se muestra solo el registro.</p>` + tabla modo-sin-estado (D2). La lectura es SQLite local (improbable que falle), pero el instrumento declara su propio fallo en vez de confundirlo con «sin datos» (Norma 7, corolario de instrumentos).

**D11 — La bajada de la página dice la verdad de cada modo; la vista NO se muda de sección.**
Con estado: `Registro y estado de las fuentes: cada fuente, su <b>oferta</b>, su dominio y sus procesos de ingestión con su <b>última corrida</b>, su <b>schedule observado</b> y su salud. El detalle (brecha vs. demanda, corridas, cadencia) vive en la <b>Frescura</b> de cada dominio.` Sin estado: el texto actual (`admin.ts:855`) queda tal cual. Sin rastros evolutivos. La ruta, el gate solo-admin, la entrada del sidebar y el scope quedan EXACTOS (el issue lo pide expreso: reporta el *ser*, se queda en gestión de plataforma).

**D12 — Fuera de alcance declarado (sin scope creep):** mover o reemplazar la Frescura por dominio; disparar/reintentar corridas desde la vista; métricas históricas, tendencias o SLA; tiles/resúmenes agregados (el dashboard actual no se toca — hecho 10); notificaciones (#100); TODO lo del lazo/proyección (`server/freshness-loop.ts`, `governance-store.ts` — territorio de #105) y del acceso a logs (`run-logs.ts`, `admin-corrida.ts` — territorio de #99); `docs/frescura-oferta-demanda.md` (lo actualiza #105).

**Cero preguntas abiertas.** Ambigüedad no prevista ⇒ resolver con el principio: fail-closed honesto (nunca afirmar lo no observado), textos heredados antes que textos nuevos, y sin tocar las reglas duras.

---

## ¿Qué contratos y tipos exactos se introducen?

### `server/admin.ts` (TOCAR — tipo, dep, helper compartido, render)

```ts
/** Estado observado de UN proceso de ingestión (issue #101) — leído de la proyección local (#105),
 *  jamás del motor en el request path. Lo arma el wiring; el render solo pinta. */
export interface ProcessIngestionState {
  processId: string
  /** Corridas conocidas, más reciente primero ([] con proyección fría). */
  runs: RunRecord[]
  /** Schedule observado (null = sin schedule). Solo significativo con projection.observedAt != null. */
  scheduleSeconds: number | null
  /** Salud (classifyProcess) — undefined si el proceso no tiene cadencia requerida (event-driven /
   *  sin demanda) o la proyección está fría. */
  health?: ProcessHealth
  /** Meta de la proyección (#105): observedAt / stale / lastError / off. */
  projection: FreshnessProjectionMeta
}

// AdminDeps gana:
/** Estado por proceso para la vista de Fuentes (issue #101). Opcional: sin él, la vista es el
 *  registro puro (sin columnas de estado) — instancias sin motor. */
processStates?: () => Promise<ProcessIngestionState[]>
```

**Helper compartido `runStateCell` (extracción, no invención).** Función local de `admin.ts`:

```ts
/** Render compartido del estado de corridas de un proceso (Frescura #105 y Fuentes #101): desenlace +
 *  edad + bandera de salud + error + «Ver log» (#99) + nota de proyección. Una sola fuente de textos. */
function runStateCell(s: {
  runs: RunRecord[]
  health?: ProcessHealth
  projection?: FreshnessProjectionMeta
  runHref?: string | null      // enlace «Ver log» de la última corrida (#99); null/undefined = sin enlace
}): string
```

Semántica exacta (los textos son los YA sellados por #105 D8 / #99 — el ejecutor los extrae del `freshnessHealthCell` implementado, no los reescribe):

1. Proyección fría / con error / stale / off ⇒ los seis estados de D7, con las corridas que correspondan (fría ⇒ sin corridas que mostrar).
2. Con datos y `runs` vacío ⇒ `sin corridas` (+ nota de proyección si aplica).
3. Con corridas ⇒ `statusBadge(runs[0].status) fmtWhen(runs[0].startedAt)<span class="sub">⟨bandera⟩</span>` + (` · <a href>Ver log</a>` si `runHref`) + `runErrorLine(runs[0])` + nota de proyección si aplica.
4. **Bandera (D4):** `health?.failed` ⇒ ` · ✕ fallida`; si no, `health?.missed` ⇒ ` · ⚠️ atrasada`; si no, sin `health` y `runs[0].status === 'Failed'` ⇒ ` · ✕ fallida`; resto ⇒ ` · ✓`.

`freshnessHealthCell(r, …)` se reescribe como: prefijo (`sin motor` / tipo de motor + alerta Notebook, intacto) + `runStateCell({ runs, health: r.health, projection: r.projection, runHref })` — mismos parámetros que le haya dado #99 para el href. **Regresión observable: cero** — los tests de `tests/admin-frescura-routes.test.ts` (incluidos los agregados por #105 T4 y #99 T5) pasan sin editar un assert.

**`sourcesPage` (reescritura del render, misma ruta y gate):**

1. `const [reg, states] = await Promise.all([deps.sourceRegistry!(), statesSafe()])` donde `statesSafe = async () => deps.processStates ? { ok: true, map: new Map((await deps.processStates()).map((s) => [s.processId, s])) } : { ok: false }` con `catch` ⇒ `{ ok: false, aviso: true }` (D10). `conEstado = ok`.
2. Orden (D9): `sources` ordenadas por `(s.domain ?? '￿', s.id)` (sin-dominio al final); `procsOf` conserva el orden de `listProcesses`.
3. Por fuente: primera fila con `Fuente`/`Oferta`/`Dominio`/`Conectada por` en `rowspan=max(1, nProcs)`; celda Dominio = enlace a `/admin/dominio/<domain>/frescura` si `s.domain` (D8a), texto `—` si no.
4. Por proceso, celda «Proceso → entidades» = `procCell` actual SIN la coletilla `sin motor (no observable)` cuando `conEstado` (D6); luego, si `conEstado`:
   - sin `p.engine` ⇒ Schedule `<span class="sub">—</span>` · Última corrida `<span class="sub">no observable (sin motor)</span>`;
   - con `p.engine` ⇒ `st = map.get(p.id)`; Schedule según D5; Última corrida = `runStateCell({ runs: st?.runs ?? [], health: st?.health, projection: st?.projection ?? { observedAt: null, stale: false, lastError: null, off: false }, runHref })` con `runHref` = enlace de #99 (D8b) solo si `deps.runLogs && s.domain && st?.runs[0]`.
   (Un proceso con engine ausente del listado de estados es proyección fría por definición — el fallback de `projection` lo rinde como tal.)
5. Fuente sin procesos ⇒ una fila con `—` en las celdas de proceso (+ estado si `conEstado`). Tabla vacía ⇒ `colspan` dinámico (`conEstado ? 7 : 5` — hecho 9).
6. Cabecera de tabla y bajada según modo (D3/D11); banner de D10 si `aviso`.

### `server/serve-rls.ts` (TOCAR — solo el wiring de la dep nueva)

Dentro del objeto de `createAdmin({...})` (junto a `sourceRegistry`/`domainFreshness`), y usando `freshnessPollMs` ya declarado por #105 antes de `createAdmin`:

```ts
// Estado por proceso para la vista de Fuentes (#101): lo último conocido de la proyección (#105) +
// salud con la MISMA clasificación de Frescura. Una lectura de proyección por GET; el motor, jamás.
processStates: fabricWiring.engine
  ? async () => {
      const f = await freshnessInputs()
      const reqOf = new Map(deriveIngestionMap(f.mapInput).map((m) => [m.processId, m.requiredCadenceSeconds]))
      const snaps = new Map((await govStore.listRunSnapshots()).map((s) => [s.processId, s]))
      const off = freshnessPollMs <= 0
      return f.procs
        .filter((p) => p.engine)
        .map((p) => {
          const s = snaps.get(p.id)
          const observedAt = s?.observedAt ?? null
          const runs = observedAt ? (s?.runs ?? []) : []
          const req = reqOf.get(p.id)
          const health = observedAt && req != null ? classifyProcess(runs, req, Date.now()) : undefined
          const stale = off || (observedAt != null && Date.now() - Date.parse(observedAt) > 3 * freshnessPollMs)
          return {
            processId: p.id, runs,
            scheduleSeconds: observedAt ? (s?.scheduleSeconds ?? null) : null,
            health,
            projection: { observedAt, stale, lastError: s?.lastError ?? null, off },
          }
        })
    }
  : undefined,
```

Es deliberadamente la MISMA fórmula del `domainFreshness` de #105 (hecho 6) — duplicación mínima aceptada y declarada; **el `domainFreshness` implementado por #105 NO se toca** (refactorizarlo a un helper común queda fuera: menor diff, cero riesgo de regresión sobre un frente recién sellado). `freshnessInputs` expone `procs` y `mapInput` (contrato de #105 `FreshnessLoopDeps.inputs` — misma función del wiring).

---

## ¿Qué tareas, con qué territorio y qué «hecho cuando»?

Orden: T1 → T2 → T3. T2 depende de T1 (tipos). Toda edición cae DENTRO del territorio de su tarea.

### T1 — Render: helper compartido + columnas de estado en Fuentes

**Territorio:** tocar `server/admin.ts` (`ProcessIngestionState`, `AdminDeps.processStates`, extracción de `runStateCell`, reescritura de `freshnessHealthCell` como composición, reescritura de `sourcesPage`), crear `tests/admin-sources-estado.test.ts` (patrón `mockReq`/`mockRes` copiado de `tests/admin-frescura-routes.test.ts:36-73`).
**Hecho cuando:** `npx vitest run tests/admin-sources-estado.test.ts tests/admin-frescura-routes.test.ts tests/admin-cargas.test.ts` verde — los dos últimos SIN editar (la extracción del helper no puede mover un texto). El test nuevo monta `createAdmin` con `sourceRegistry` + `processStates` FAKE (y `runLogs` mock mínimo cuando el caso lo pida) y observa el SÍNTOMA en el HTML del GET `/admin/sources`:

1. **Sana:** proceso con corrida `Completed` reciente (startedAt relativo a `Date.now()`) ⇒ la página contiene `✓ Listo`, `hace `, ` · ✓`, y el schedule `PT2H` (de `scheduleSeconds: 7200`).
2. **Fallida:** última corrida `Failed` con `error` ⇒ `✕ Falló`, ` · ✕ fallida`, y el mensaje de error recortado presente.
3. **Atrasada:** `health.missed: true` ⇒ ` · ⚠️ atrasada`.
4. **Fallida sin cadencia (D4):** `health: undefined` + última `Failed` ⇒ ` · ✕ fallida` (no ` · ✓`).
5. **Proyección fría:** `projection.observedAt: null` (lazo activo) ⇒ contiene `esperando el primer refresco del motor` Y la celda Schedule de ese proceso es `—` (no `sin schedule`).
6. **Sin schedule observado:** `observedAt` presente + `scheduleSeconds: null` ⇒ `sin schedule`.
7. **Stale / off:** `stale: true` ⇒ `el refresco no está corriendo`; `off: true` ⇒ `refresco apagado`.
8. **No observable:** proceso sin `engine` ⇒ `no observable (sin motor)` y esa fila NO contiene `/corrida?`.
9. **Enlaces:** con `runLogs` presente y fuente con dominio ⇒ la celda Dominio contiene `href="/admin/dominio/cartera/frescura"` y la corrida contiene `corrida?proc=p_sap&amp;started=` (encoding real del HTML); SIN `runLogs` ⇒ la página no contiene `/corrida?`; fuente sin `domain` ⇒ ni enlace a frescura ni a corrida.
10. **Orden (D9):** dos fuentes con dominios `zeta` y `alfa` + una sin dominio ⇒ aparecen en el HTML en orden `alfa`, `zeta`, sin-dominio.
11. **Rowspan:** fuente con DOS procesos ⇒ `rowspan="2"` y dos filas de proceso.
12. **Sin `processStates` (D2):** la página NO contiene la cabecera `Última corrida` ni `/corrida?`, y SÍ contiene `sin motor (no observable)` para el proceso sin engine (modo actual intacto).
13. **Fail-safe (D10):** `processStates` que lanza ⇒ 200 con `No se pudo leer el estado de las ingestas` y tabla en modo sin-estado.
14. **Una lectura (D1):** contador en el fake ⇒ `processStates` se invoca EXACTAMENTE una vez por GET.
15. **Gate intacto:** steward no-admin ⇒ 403 (mismo assert que hoy, en el archivo nuevo con sus propias deps).

### T2 — Wiring de producción

**Territorio:** tocar `server/serve-rls.ts` (solo: `processStates` en el objeto de `createAdmin`, con el código de la sección de contratos; imports que falten de `@vergis/capabilities` — `classifyProcess` ya se importa hoy).
**Hecho cuando:** `npm run typecheck` y `npm run build` verdes, y `npx vitest run tests/serve-rls.test.ts tests/acceptance.test.ts` verde (esos tests no cablean Fabric: sin `engine`, `processStates` queda `undefined` y nada cambia — regresión cero).

### T3 — Juez completo

**Hecho cuando:** `npm run typecheck && npm test && npm run build` — los tres verdes, con `tests/admin-sources-estado.test.ts` incluido en `npm test`.

### G-M1 — Gate diferido/manual (instancia viva — NO es de CI; se declara, no bloquea el merge)

Requiere la instancia GH con la proyección de #105 poblada (skill `mira-ops`): abrir `/admin/sources` y verificar el síntoma del issue resuelto — TODOS los dominios y sus últimas corridas en UNA pantalla, edades plausibles, «Ver log» aterrizando en la página de #99 de la corrida correcta (el `started` casa exacto — #105 D2), y la carga de la página sin latencia de motor (proyección local).

---

## ¿Qué NO se toca? (reglas duras)

- **NADA del territorio de #105**: `server/freshness-loop.ts`, `packages/capabilities/src/governance-store.ts` (tablas/`listRunSnapshots`), `packages/capabilities/src/ingestion-observability.ts`, el bloque del lazo y el `domainFreshness` de `serve-rls.ts` (la única edición en `serve-rls.ts` es AGREGAR la propiedad `processStates` al objeto de `createAdmin`).
- **NADA del territorio de #99**: `run-logs.ts`, `admin-corrida.ts`, `admin-cargas.ts`, la ruta `corrida` y su `corridaPage` — esta vista solo CONSTRUYE hrefs hacia ella con el patrón exacto de su D5.
- **Los textos sellados de #105 (D8) y #99 (D7) se heredan tal cual** — la extracción de `runStateCell` mueve código, no palabras. Los tests existentes de `admin-frescura-routes` y `admin-cargas` (incluidos los que #105/#99 agregaron) pasan SIN editar un assert.
- **Ruta, gate y ubicación intactos**: `/admin/sources` sigue solo-admin (`denyPlatform`), en el mismo scope y con la misma entrada de sidebar (D11). Ninguna ruta nueva, ningún POST nuevo, ningún CSRF nuevo (la vista es GET puro).
- No tocar: `fabric-engine.ts`, `intake*.ts`, `freshness.ts`, `packages/policy`, miranda*, notas*, master-data*, engines de serving, el dashboard (`admin.ts:648-691`).
- No modificar tests existentes; los casos nuevos viven en `tests/admin-sources-estado.test.ts`.
- Sin dependencias npm nuevas. UI en español; los textos sellados de este diseño (D5/D6/D10/D11) se usan tal cual — los tests los observan.

## ¿Quién juzga?

`npm run typecheck && npm test && npm run build` — los tres verdes, incluyendo `tests/admin-sources-estado.test.ts` nuevo y TODOS los suites existentes sin editar. El síntoma (una pantalla responde «¿mis ingestas corrieron?» para toda la instancia, con estados, edades y enlaces correctos, y la proyección fría dice sus palabras) lo observan los casos 1-15 de T1 con proyección fake; su confirmación contra la instancia viva es G-M1 (diferido, declarado).

## ¿Qué riesgos quedan y cómo los acota el diseño?

| Riesgo | Acotación |
|---|---|
| La extracción de `runStateCell` altera un texto sellado de #105/#99 | El juez la ata: los tests de esos frentes deben pasar SIN editar (T1); la regla dura lo prohíbe expreso. |
| Segunda clasificación de salud que derive de la de Frescura | No existe: `health` viene de la MISMA `classifyProcess` con los MISMOS insumos (snapshots default + mapa derivado — hecho 6); el único caso extra (sin cadencia) usa el mismo criterio `failed` (D4) y está testeado (T1-c4). |
| El delta de D4 (fallida sin cadencia) sorprende en Frescura | Es corrección de una contradicción visible (`✕ Falló … · ✓`, hecho 7), sin assert vigente que lo observe; queda declarado aquí y encodado en T1-c4. |
| Fórmula de staleness duplicada entre `domainFreshness` (#105) y `processStates` | Duplicación de 2 líneas, sellada idéntica y declarada; unificarla exigiría tocar territorio de #105 recién mergeado — se prefiere el diff mínimo. Si divergen algún día, los textos heredados delatan el drift en tests. |
| Tabla con rowspan mal armado (filas corridas) | Estructura sellada en la sección de contratos + asserts de estructura (T1-c11) y de vacío con colspan dinámico (hecho 9). |
| Enlace «Ver log» hacia una corrida que la página de #99 no resuelva | El href usa el `startedAt` exacto de la proyección, que #105 D2 guarda tal cual lo entrega el motor — la cadena casa con el historial que #99 consulta; y el enlace lleva a una PÁGINA que declara sus ausencias (#99 D7), nunca a un blob. |
| Primera vuelta post-deploy: toda la tabla «fría» | Estado honesto heredado (`esperando el primer refresco del motor`, T1-c5); el lazo de #105 nace encendido (su D9) y puebla en minutos. |
| Instancia sin motor ve columnas vacías | No las ve: sin `engine` no hay `processStates` y la página es la de hoy (D2, T1-c12). |

---

*Diseño: Fable 5 (rol diseñador, ww:wingcoding) · 2026-08-06 · Issue #101 · Base declarada: main + #105 + #99 mergeados. Toda afirmación de mecanismo está verificada contra el código citado (HEAD `63b6816`) o referida a una decisión sellada de los diseños hermanos; el gate que exige instancia viva está declarado como G-M1.*
