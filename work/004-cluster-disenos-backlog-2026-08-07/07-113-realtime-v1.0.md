# 07 · Diseño — Realtime: plano de cambio + SSE (#113) — v1.0

**Frente:** #113 · Realtime — «Botler persistente + SSE»: que un Producto de Información refleje cambios sin recarga.
**Horizonte:** largo plazo → **ARQUITECTURA DECIDIDA** (cortes de módulos, contratos, decisiones irreversibles) + primer hito ejecutable. Donde la precisión sería fingida hoy, se declara (§7).

---

## 1 · Estado actual verificado

Todo lo afirmado en esta sección se leyó en el código el 2026-08-07; las anclas son `archivo:línea` de ese estado.

1. **Todo el ciclo es request-response.** El único punto de render es `runPi` (`server/serve-rls.ts:497-530`), llamado por `renderReport` (`server/serve-rls.ts:532-535`) desde el router en cada GET del PI (`server/routes.ts:212`). No existe ningún push del servidor al navegador; el HTML lleva `cache-control: no-store` (`server/routes.ts:149-150`).
2. **El Botler es efímero por corrida.** `runSpec` construye un `new Botler(...)` por invocación (`packages/cli/src/run.ts:137`), lo arranca (`run.ts:143`), invoca el Botlet Mira y lo detiene (`run.ts:181`). Cada corrida produce su propio log hash-encadenado (`run.ts:197-198`; DoD del walking skeleton, `README.md:20-23`). Lo que sí persiste entre requests son cachés de parseo: schema y spec memoizados por (ruta, mtime) (`run.ts:14-36`).
3. **El render es por consumidor y la RLS es data-anchored.** La identidad sale de las cabeceras del gate por request (`identityFor`, `server/serve-rls.ts:444` y `504`); los claims se inyectan en el motor enforcing (`SERVING_CAPS`, `serve-rls.ts:198`; fabric por `sp_set_session_context`, clickhouse por ROW POLICY — cabecera del archivo, `serve-rls.ts:10-17`). El caché de resultados es **opt-in** (`VERGIS_DATA_CACHE_TTL_MS > 0`) y forma su clave con params + user + claims normalizados (`serve-rls.ts:397-406`; `packages/botler/src/result-cache.ts:53-62`), con `clear()` global que el hot-reload de gobierno ya invoca (`serve-rls.ts:1663-1665`).
4. **El nodo ya tiene lazos persistentes** (proceso vivo con timers, no Botler):
   - **Lazo de frescura** (#105): cada `VERGIS_FRESHNESS_POLL_MS` (default 300 000 ms, `serve-rls.ts:1196`) observa run-history + schedule de cada proceso del motor y escribe la proyección por lote (`server/freshness-loop.ts:102-117`), con guard anti-solape (`freshness-loop.ts:87-92`). Solo arranca con motor cableado (`serve-rls.ts:1199`).
   - **Re-ingesta clickhouse**: timer `REFRESH_MS` que dispara `ingestAll()` (`serve-rls.ts:343`), serializado por mutex FIFO (`serve-rls.ts:305-330`).
   - **Reporte periódico** (#102) y **purga de retención de notas** (`serve-rls.ts:1237-1238`, `830-832`).
5. **La señal de «el dato se movió» ya se computa, para otro fin.** `createAsOfProvider` deriva el corte as-of por PI desde `processOutputs` (tabla→proceso) + `lastSuccessAt` del run-history (`packages/capabilities/src/ingestion-observability.ts:234-285`, en particular `278` y `260`); `runPi` lo consulta por request (`serve-rls.ts:507`). El mapeo PI→tablas vive en `Report.tables` (`server/discovery.ts:21-30`).
6. **Cambios de spec y gobierno ya emiten eventos internos**: `contract.watch` sobre el dir de specs dispara `discovery.rebuild()` (`serve-rls.ts:1703-1719`); `reloadGovernance` recarga políticas + conexiones + re-verificación (`serve-rls.ts:1645-1690`); `SIGHUP` fuerza la recarga (`serve-rls.ts:1745`). La maquinaria de watch/debounce es genérica (`server/hot-reload.ts:15-81`).
7. **Proxy y gate.** El despliegue de referencia es Caddy (TLS) → oauth2-proxy (OIDC) → vergis:8080 solo en red interna (`deploy/compose.reference.yml:94-104`, `124-150`). El gate secret A10 exige `x-gate-token` en **cada** request salvo `/healthz` (`server/routes.ts:77-79`; opt-in `serve-rls.ts:426-431`). El shutdown drena con `server.close()` y un timeout duro de 10 s (`serve-rls.ts:1567-1575`).
8. **El patrón «feature apagada = superficie idéntica»** ya existe dos veces y es el molde de este frente: `renderPdf` ausente ⇒ `/<slug>/pdf` ni se intercepta (`server/routes.ts:39-45`, `170`); `pdfUrl` viaja por `runSpec` → bandeja de Mira solo cuando la feature está ON (`serve-rls.ts:526`, `packages/cli/src/run.ts:97-99`, `packages/mira/src/mira.ts:191-193`).
9. **El core es single-node por edición**: «functionally complete on single-node»; HA/K8s es Enterprise (`README.md:62`).

---

## 2 · Decisiones selladas

### D1 · Qué se vuelve persistente: un **plano de cambio**, no el render

**Sellado:** el render sigue siendo por-request bajo la identidad del consumidor. Lo que se vuelve persistente es un **plano de suscripción/invalidación** — un bus de cambio in-process + distribución SSE — montado *encima* del request-response actual.

**Las dos opciones, pesadas contra el criterio de excelencia** (diseñando como si nada estuviera implementado):

- **(a) Botler residente con renders vivos**: un runtime que mantiene el estado renderizado de cada PI y empuja actualizaciones. Falla por diseño, no por costo: el render es **por consumidor** (§1.3) — no existe «el HTML del PI», existen N_identidades × N_PIs documentos. Mantenerlos vivos exige o (i) renderizar por cada identidad conectada en cada cambio (reconstruir el request-response con peor forma), o (ii) empujar dato y filtrarlo en el borde — un **segundo lugar donde la identidad toca el dato**, que duplica el camino enforcing que hoy es único (el motor). Aun con costo cero de construcción, (a) es la arquitectura peor.
- **(b) Plano de señal sobre request-response**: el servidor detecta «algo de este PI cambió», lo anuncia sin dato, y el consumidor re-obtiene por el camino normal (gate + identidad + RLS + caché). Un solo camino enforcing; el estado persistente es minúsculo (versión por PI + conexiones abiertas); la degradación a hoy es estructural.

**Sobre el título del issue** («Botler persistente»): lo que el issue nombra queda satisfecho por el **proceso-nodo persistente** que ya hospeda lazos vivos (§1.4) y que ahora formaliza el plano de cambio como pieza de primera clase. Promover el `Botler` de `packages/botler` a residente no aporta a este frente y costaría la garantía de log hash-encadenado por corrida (§1.2); si algún frente futuro lo exige (p. ej. Botlets con estado propio), es decisión aparte — no se sella aquí.

### D2 · Cómo viaja el cambio: **evento-señal**, jamás evento-dato

**Sellado:** el evento SSE **no lleva dato** — ni filas, ni agregados, ni nombres de tablas, ni conteos. Lleva exactamente: slug del PI, clase de cambio (`data | spec | gobierno`), timestamp e id monotónico. El refresco resultante es un request normal que pasa por **todos** los gates de hoy (token del gate, `ready`, `piBlocked`, `canOpenPi`, identidad → RLS).

**Racional:** es la única semántica en la que «la RLS no se relaja» es un teorema y no una promesa: por construcción no existe payload que pueda filtrar lo que la identidad no vería. La alternativa evento-dato exigiría evaluar la política por conexión suscrita en cada cambio — el punto (ii) descartado en D1. El costo aceptado: un re-render completo por señal (mitigado por el result-cache §D8 y las cachés de parseo §1.2).

Una sutileza sellada con el mismo criterio: el **canal en sí** tampoco filtra. El endpoint es por-PI y está detrás de `canOpenPi`, así que recibir señales de un PI ya implica poder abrirlo; y la señal `data` se emite por PI (derivada de tablas), no nombra la tabla ni el proceso.

### D3 · De dónde nace la señal: **productores in-process detrás de un bus**, no CDC

**Sellado:** cuatro productores, todos ya existentes como eventos internos del nodo (§1.4-1.6), publican a un bus único:

| Productor | Clase | Dónde se engancha (hoy) |
|---|---|---|
| P1 · Specs | `spec` | El callback del watch de specs, tras `discovery.rebuild()` ok (`serve-rls.ts:1703-1719`) |
| P2 · Gobierno | `gobierno` | Final de `reloadGovernance` exitoso (`serve-rls.ts:1645-1690`) — afecta a **todos** los PIs (`publish('*')`) |
| P3 · Datos (clickhouse) | `data` | Final de `ingestAll()` exitoso (`serve-rls.ts:309-330`) — los PIs cuyas tablas están en `BOUND` |
| P4 · Datos (fabric) | `data` | Fase 1 del lazo de frescura (`freshness-loop.ts:102-117`): diff de `lastSuccessAt` del lote observado contra el snapshot previo ⇒ procesos con corrida nueva exitosa ⇒ tablas (`processOutputs`) ⇒ PIs (`Report.tables`) |

**Racional:** el lazo de frescura **ya observa** exactamente el fenómeno que necesitamos («este proceso corrió con éxito otra vez») con la cadencia que la instancia ya eligió (§1.4); la topología proceso→tabla→PI **ya existe** y ya alimenta el as-of (§1.5). Un CDC (change feed por tabla en Fabric / materialized-view triggers en ClickHouse) daría granularidad sub-minuto al precio de una integración por motor y un plano de credenciales nuevo — y la latencia de la señal quedaría igual acotada por la ingesta misma (el dato del PI cambia cuando el proceso corre, no antes). **CDC queda como productor futuro detrás del mismo contrato del bus** (§3.1), que es el corte estable; no-meta hoy (§6).

**Consecuencia declarada:** la latencia de la señal `data` en fabric = cadencia del lazo (default 5 min). En un despliegue sin motor cableado o con el lazo apagado (`VERGIS_FRESHNESS_POLL_MS=0`, `serve-rls.ts:1199`) solo viven P1-P3 — el contrato lo dice explícito (§3.2, semántica de `caps`).

### D4 · Transporte: **SSE por PI**, `GET /<slug>/eventos`

**Sellado:** Server-Sent Events, un stream por (PI, pestaña), ruta `GET /<slug>/eventos`, interceptada por el router **solo** cuando el handler está inyectado (patrón `renderPdf`, §1.8), con **exactamente los gates de la página del PI**: token del gate (ya cubre toda ruta no-healthz, `routes.ts:77-79`), gate `ready`, `piBlocked`, `canOpenPi`, identidad resuelta al conectar.

**Racional vs WebSocket:** el canal es estrictamente unidireccional (D2); SSE es HTTP plano — atraviesa la cadena Caddy→oauth2-proxy→vergis como cualquier GET, la cookie de sesión del SSO viaja sola (EventSource envía credenciales same-origin — comportamiento de plataforma web), y la reconexión con `Last-Event-ID` viene gratis del navegador. WebSocket exigiría upgrade a través de dos proxies y un manejo de auth propio, para una capacidad (bidireccionalidad) que este diseño rechaza a propósito.

### D5 · Vida de la conexión e identidad: **TTL de stream + reconexión que re-valida**

**Sellado:**

- **Latido**: comentario SSE (`: latido`) cada 25 s. Mantiene viva la conexión a través de idle-timeouts de proxies y detecta clientes muertos (write falla ⇒ se limpia la suscripción).
- **TTL del stream**: el servidor **cierra** cada stream a los 15 min (configurable). El navegador reconecta solo (con el `retry:` que el stream declara, default 5 000 ms), y la reconexión atraviesa el proxy de nuevo — **la sesión SSO y los gates se re-evalúan en cada (re)conexión**. Así la ventana de identidad-rancia del canal queda acotada por diseño sin tocar el proxy; y como por el canal no viaja dato (D2), una identidad revocada a mitad de stream a lo sumo recibe señales 15 min de más — su próximo render (donde sí hay dato) ya la rechaza.
- **Ids y reconexión**: id de evento `"<bootEpochMs>-<n>"` (contador por proceso). Un `Last-Event-ID` cuyo prefijo no es el boot actual, o menor que la última versión del PI, produce **un evento `cambio` inmediato** al conectar — fail-safe: ante cualquier duda, «revisa». **Jamás replay de historia**: el bus no persiste eventos (no hay nada que un evento perdido obligue a reconstruir — el estado verdadero siempre está a un GET de distancia).
- **SIGTERM**: los streams abiertos se terminan explícitamente en el drain — `server.close()` espera conexiones vivas y un SSE no termina solo; sin esto, todo shutdown con un espectador conectado consumiría el timeout duro de 10 s (`serve-rls.ts:1567-1575`).

### D6 · Opt-in doble y degradación estructural

**Sellado:** la feature enciende con **dos llaves, ambas necesarias**:

1. **Instancia**: `VERGIS_REALTIME=1` (validado en `config.ts`, patrón `pdf`/`miranda` — `server/config.ts:57-59`). Sin él: el handler SSE no se inyecta ⇒ `/<slug>/eventos` cae al slug-lookup → 404 de siempre; `runSpec` no recibe `live` ⇒ ni un byte de script en el HTML. Superficie **idéntica a hoy**.
2. **Spec** (mandato del frente: opt-in por spec): bloque opcional `realtime:` en el DSL (§3.4). Un spec sin el bloque se sirve exactamente como hoy aunque la instancia tenga la llave puesta.

**Degradación fail-closed a request-response, en tres capas:** (i) sin llaves, nada existe; (ii) con llaves y el stream caído (proxy que no lo pasa, red, navegador viejo), el PI es el de hoy — la página no depende del canal para nada, el script solo *agrega* señales; (iii) con canal vivo y señal perdida, el peor caso es «el usuario recarga a mano», que es hoy. No existe estado en el que la feature rota deje al PI peor que sin ella.

**Racional de la doble llave:** la del spec expresa intención del PI (un informe mensual no quiere banner de frescura; un tablero de sala sí); la de instancia expresa capacidad de la infra (una instancia cuyo proxy no fue verificado para streams no debe dejar que un spec la encienda — la verificación del proxy es por-despliegue, §5/§7).

### D7 · Comportamiento del cliente `[propuesta — revocable por César]`

**Propuesta recomendada:** dos modos declarables en el spec, default **`notify`**:

- **`notify` (default)**: al recibir señal, la bandeja del PI muestra un aviso discreto y persistente — «Hay una versión más reciente de este documento · Actualizar» — y el refresco ocurre **al clic** (un `location.reload()` que conserva `?page/ctx/flt` porque recarga la URL vigente). El documento **no se reescribe bajo la mirada del lector**: un PI es un documento leído, citado y discutido; que mute solo mientras alguien lo señala en una reunión es peor UX que el aviso.
- **`auto`**: para wallboards/salas de operación — re-fetch de la URL vigente con `credentials: same-origin` y swap del contenido. El detalle del swap (morph con preservación de scroll/foco vs reemplazo del contenedor) se decide en su hito (§7 — precisión fingida hoy).

**Alternativa descartada:** auto-refresh como default. Descartada por la razón de producto de arriba, no por costo. Es decisión de producto/UX ⇒ le pertenece a César.

### D8 · La señal invalida el caché de resultados

**Sellado:** un `data` o `gobierno` publicado en el bus dispara `servingCap.clear()` cuando el conector está envuelto (`withResultCache` expone `clear()`, `packages/botler/src/result-cache.ts:33-36,103-106`; el server ya lo llama en el reload de gobierno, `serve-rls.ts:1663-1665`).

**Racional:** sin esto, la señal es auto-contradictoria: invita a re-render y el re-render sirve el hit viejo hasta vencer el TTL — el consumidor «actualiza» y ve lo mismo. El `clear()` es global (no hay invalidación por clave); aceptado: el TTL del caché es corto por diseño y la frecuencia de señal la acota la ingesta. Extender `CachedCapability` con invalidación selectiva es no-meta (§6).

### D9 · El bus coalesce; el orden de emisión es tras-el-swap

**Sellado:** (i) el bus **coalesce** por (PI, clase) con ventana corta (500 ms, reusa `debounce` de `server/hot-reload.ts:15-30`): una recarga de gobierno que re-verifica N PIs no debe metrallar N×M eventos; (ii) todo productor publica **después** de que el estado nuevo quedó swapeado (tras `rebuild()` ok, tras `reloadGovernance` ok, tras `ingestAll` ok, tras `recordObservations`): una señal que llegara antes del swap haría al cliente re-renderizar el estado viejo — la señal debe ser *posterior* al hecho, siempre.

---

## 3 · Arquitectura y contratos

### 3.1 · Módulo `server/change-bus.ts` (nuevo) — el corte estable

Puro, sin HTTP, testeable en frío. Es **el** contrato al que se enchufan productores presentes (P1-P4) y futuros (CDC, motores nuevos):

```ts
export type ChangeKind = 'data' | 'spec' | 'gobierno'

export interface ChangeEvent {
  pi: string           // slug
  kind: ChangeKind
  at: string           // ISO del momento de publicación
  id: string           // "<bootEpochMs>-<n>" — monotónico por proceso
}

export interface ChangeBus {
  /** Publica un cambio. `'*'` = todos los PIs vigentes (el bus consulta `slugs()` al emitir). */
  publish(pi: string | '*', kind: ChangeKind): void
  /** Suscripción por PI. Devuelve el unsubscribe. Un listener que lanza se loguea y se desuscribe. */
  subscribe(pi: string, fn: (e: ChangeEvent) => void): () => void
  /** Última versión emitida del PI (id) o null si nunca cambió en esta vida del proceso. */
  versionOf(pi: string): string | null
}

export function createChangeBus(deps: {
  slugs: () => string[]                 // catálogo vivo: () => discover().map(r => r.slug)
  clock?: () => number
  coalesceMs?: number                   // default 500
  log?: (line: string) => void
}): ChangeBus
```

Además, dos helpers puros para P4 (viven aquí para testearse sin el lazo):

```ts
/** Procesos cuyo lastSuccessAt AVANZÓ entre el snapshot previo y el lote observado. */
export function procesosConCorridaNueva(
  prev: { processId: string; lastSuccessAt: string | null }[],
  lote: { processId: string; lastSuccessAt: string | null }[],
): string[]

/** processIds → slugs afectados, vía processOutputs (tabla) → Report.tables. */
export function pisAfectados(
  processIds: string[],
  processOutputs: { processId: string; tableRef: string }[],
  reports: { slug: string; tables: string[] }[],
): string[]
```

### 3.2 · Módulo `server/sse.ts` (nuevo) — el glue HTTP

```ts
export interface SseDeps {
  bus: ChangeBus
  heartbeatMs?: number   // default 25_000
  streamTtlMs?: number   // default 900_000 (15 min) — D5
  retryMs?: number       // default 5_000
  log?: (line: string) => void
}

export interface SseHandler {
  /** Toma el request YA autorizado (el router aplicó los gates del PI) y lo vuelve stream. */
  handle(req: IncomingMessage, res: ServerResponse, report: { slug: string }): void
  /** Cierra todos los streams vivos (SIGTERM — D5). */
  closeAll(): void
  /** Observabilidad: streams vivos (diagnóstico/tests). */
  stats(): { open: number }
}

export function createSseHandler(deps: SseDeps): SseHandler
```

**Contrato del stream** (lo que un cliente ve en el wire):

```
HTTP/1.1 200
content-type: text/event-stream; charset=utf-8
cache-control: no-store
x-accel-buffering: no

retry: 5000

: caps data,spec,gobierno        ← primera línea: clases que ESTE nodo puede emitir (sin lazo de
                                   frescura, `data` se omite en fabric — el cliente sabe qué esperar)
: latido                         ← cada heartbeatMs

event: cambio
id: 1754580000000-42
data: {"pi":"ventas","kind":"data","at":"2026-08-07T18:40:00.000Z"}
```

Semántica de error: fallo **antes** de escribir cabeceras ⇒ `fail()` normal del router; fallo **después** (write roto, TTL) ⇒ `res.end()` y limpieza de la suscripción — el cliente reconecta solo. Reconexión con `Last-Event-ID` de otro boot o menor que `versionOf(pi)` ⇒ evento `cambio` inmediato (D5).

### 3.3 · Router (`server/routes.ts`) — una dep opcional, un intercept

Se agrega a `RouteDeps` (patrón `renderPdf`, `routes.ts:39-45`):

```ts
/** Stream de cambios del PI (issue #113). AUSENTE = feature apagada: `/<slug>/eventos` NI SIQUIERA
 *  se intercepta (cae al slug-lookup → 404 de siempre). */
sseHandler?: (req: IncomingMessage, res: ServerResponse, report: Report) => void
```

Match `/<slug>/eventos` **en la misma posición y con los mismos gates** que `/<slug>/pdf` (`routes.ts:169-201`): tras token de gate y `ready`, con `piBlocked` (503 con motivo) y `canOpenPi` (403) — la autorización del canal es exactamente la de la página.

### 3.4 · El spec (DSL) y el cliente

**Schema** (`schema/mira-spec.schema.json`, hoy con top-level `mira_version · identity · piece · pages · controls · filters · data · quality · delivery` — verificado): se agrega el bloque **opcional**:

```yaml
realtime:
  refresh: notify   # notify (default) | auto — D7
```

Sigue siendo authz-blind: declara presentación (cómo reflejar frescura), jamás quién ve qué.

**Plumbing** (calco de `pdfUrl`, §1.8): `RunOptions` gana `live?: { url: string; mode: 'notify' | 'auto' }` (`packages/cli/src/run.ts` — junto a `pdfUrl`, hoy `run.ts:97-99`); el server lo puebla en `runPi` solo si (llave de instancia ∧ el spec declara `realtime` ∧ no es `print`) — espejo exacto de `pdfUrl` en `serve-rls.ts:526`; Mira lo baja hasta el render de la bandeja (`packages/mira/src/mira.ts:191-193, 471, 497`), que emite el fragmento cliente: un `<script>` inline sin dependencias que abre `new EventSource(liveUrl)`, ignora `: latido`, y ante `cambio` ejecuta el modo (banner o re-fetch). El congelado de una impresión y el modo print **no** llevan el script (mismos motivos que el PDF sin notas, `serve-rls.ts:544-545`).

### 3.5 · Wiring en `serve-rls.ts` (productores y ciclo de vida)

```
config.realtime.enabled (VERGIS_REALTIME, server/config.ts)
        │
        ├─ bus = createChangeBus({ slugs: () => discover().map(r => r.slug) })
        ├─ sse = createSseHandler({ bus, ... })  →  RouteDeps.sseHandler
        │
        ├─ P1: callback del watch de specs (serve-rls.ts:1703-1719), tras rebuild ok:
        │       slugs afectados no derivables del watch → publish('*', 'spec')  [ver §7-c]
        ├─ P2: final de reloadGovernance ok (serve-rls.ts:1645-1690): publish('*', 'gobierno')
        ├─ P3: final de ingestAll ok (clickhouse, serve-rls.ts:309-330):
        │       pisAfectados(tablas de BOUND) → publish(slug, 'data')
        ├─ P4: lazo de frescura — dep nueva opcional en FreshnessLoopDeps:
        │       onCorridasNuevas?: (processIds: string[]) => void
        │       llamada en fase 1 TRAS recordObservations (freshness-loop.ts:115), con
        │       procesosConCorridaNueva(snapshotPrevio, lote); el server la cablea a
        │       pisAfectados(...) → publish(slug, 'data')
        │
        ├─ suscriptor interno: on data|gobierno → (servingCap as CachedCapability).clear?.()   [D8]
        └─ SIGTERM (serve-rls.ts:1567-1575): sse.closeAll() antes de server.close()            [D5]
```

Nota P4: el snapshot previo para el diff se lee con `listRunSnapshots()` (ya consumido por el server en `serve-rls.ts:1291`) **antes** de `recordObservations` del tick — el lazo ya tiene el store en sus deps (`freshness-loop.ts:54`); `lastSuccessAt` se deriva con `classifyProcess` (`ingestion-observability.ts:260`), que el lazo ya importa.

### 3.6 · Autorización — resumen del invariante

| Superficie | Gate | Dato que porta |
|---|---|---|
| `GET /<slug>/eventos` | token de gate + `ready` + `piBlocked` + `canOpenPi` + identidad, re-evaluados en **cada (re)conexión** (D5) | Solo `{pi, kind, at, id}` — cero dato de negocio (D2) |
| Re-render disparado | Los de hoy, sin cambio alguno (`routes.ts:202-214`) | El de siempre, RLS-filtrado por el motor enforcing |

**El invariante:** no existe rama nueva por la que dato gobernado alcance a un consumidor. La feature entera puede razonarse como «un motivo más para que el navegador haga el GET que ya hacía».

---

## 4 · Plan de construcción

### Hito 1 — el plano de cambio servido (ejecutable por un Opus en frío)

**Territorio de archivos:**
- Nuevos: `server/change-bus.ts`, `server/sse.ts`, `tests/change-bus.test.ts`, `tests/sse.test.ts` (nombres de test según convención vigente del suite — verificar el patrón de `tests/` al ejecutar).
- Editados: `server/config.ts` (bloque `realtime` con `VERGIS_REALTIME`, patrón del bloque `pdf`), `server/routes.ts` (dep `sseHandler` + intercept `/<slug>/eventos` calcado del bloque pdf `routes.ts:169-201`), `server/freshness-loop.ts` (dep opcional `onCorridasNuevas` + lectura del snapshot previo en fase 1), `server/serve-rls.ts` (wiring §3.5 completo, incluido `closeAll()` en SIGTERM y el suscriptor de `clear()`).
- **No se toca**: `packages/mira`, `packages/cli`, `schema/` (eso es Hito 2 — este hito no emite cliente).

**Contenido:** todo §3.1, §3.2, §3.3 y §3.5 tal como están contratados. El registro del contrato operativo (#139) debe reflejar la env nueva vía `contract.env('VERGIS_REALTIME')` y un `caveat` colocado si el lazo de frescura está apagado («este nodo no emite `data`») — coherente con cómo el archivo registra todo lo demás (`serve-rls.ts:162-177`).

**Hecho cuando (verificable por comando):**
1. `npm test` y `npm run typecheck` en verde (sin pipes que enmascaren exit codes).
2. Tests herméticos nuevos que **sabrían fallar** (Norma 7 — cada uno es el experimento que refuta su mecanismo):
   - bus: publish→subscribe entrega; coalescing colapsa ráfaga en 1 evento; `'*'` se expande con `slugs()` vivo; listener que lanza se desuscribe sin tumbar a los demás; ids monotónicos.
   - sse (sobre `http.createServer` en puerto efímero): el stream emite `: caps` y `: latido` **antes** de cualquier evento — el arnés distingue «canal vivo sin eventos» de «no conecté» (corolario de instrumentos, Norma 7); un publish llega como frame `event: cambio` bien formado; `Last-Event-ID` viejo produce evento inmediato; TTL cierra y `closeAll()` cierra.
   - freshness-loop: con snapshot previo sembrado, una corrida nueva exitosa en el lote invoca `onCorridasNuevas` con ese processId; una observación fallida o sin avance, no.
   - router: sin `sseHandler`, `GET /x/eventos` responde el 404 de siempre; con handler, respeta `piBlocked` (503) y `canOpenPi` (403).
3. Verificación manual contra el arnés de dev (`HOST=127.0.0.1` + `VERGIS_DEV_IDENTITY`, `serve-rls.ts:157-159, 185-194`): `curl -N http://127.0.0.1:PORT/<slug>/eventos` muestra `: caps` y latidos; tocar un spec del `VERGIS_SPECS_DIR` produce un `cambio` de clase `spec` en el stream.

**Juez:** los gates del repo (suite hermética + typecheck) — recordando que «Cierra #N» no cierra issues (keyword en inglés) al preparar el PR.

### Hito 2 — el cliente (banner `notify`) y el opt-in por spec

Schema (`realtime:` §3.4) + `RunOptions.live` + bandeja de Mira con el script inline y el banner. Se elabora a nivel ejecutable **al destrabar** (§5): la superficie de la bandeja y de `RunOptions` es de las que más se mueven (§7-b).

### Hito 3 — modo `auto` (wallboard)

Re-fetch + swap con preservación de estado de lectura. El algoritmo de swap se decide aquí, con la página real de entonces delante (§7-d).

### Hito 4 — verificación del despliegue real

Medir el stream **a través de** Caddy + oauth2-proxy del despliegue vigente antes de dar la feature por servible en producción (skill `mira-ops` para operar; §7-a). Produce la config de proxy que el compose de referencia deba incorporar.

---

## 5 · Destranque

**¿Qué lo prioriza?** El primer consumidor concreto que pida «sin recarga»: un PI de sala de operaciones/wallboard en una instancia viva, o un uso donde la reunión ocurre con el PI proyectado y el dato corre por debajo (origen del frente: instancia GH, pendiente P-34 — cuerpo del issue #113). Señal secundaria: cuando #100/#102 entrenen a los consumidores a esperar inmediatez, la brecha con la pantalla estática se vuelve visible.

**Qué re-verificar al destrabar** (partes del diseño sensibles a envejecer):

1. **La forma del lazo de frescura** (`server/freshness-loop.ts`): P4 se engancha a su fase 1 y a `listRunSnapshots`; el archivo se reescribe con frecuencia (#105→#107 ya lo mutaron dos veces). Verificar deps y momento del `recordObservations`.
2. **La superficie de `RunOptions` y de la bandeja de Mira**: el plumbing de `live` está calcado de `pdfUrl` (`run.ts:97-99`, `mira.ts:191-193`) — confirmar que el patrón siga siendo ese y no haya nacido un canal mejor para pasar contexto de serving al render.
3. **El orden de dispatch del router** (`routes.ts:62-215`): el intercept de `/eventos` debe seguir cayendo tras los mismos gates que la página del PI; rutas nuevas (Miranda creció así) pueden haber movido el orden.
4. **El stack de proxy vigente y su comportamiento con streams** — *la conjetura mayor de este diseño* (§7-a): correr el experimento del Hito 4 **antes** de construir el cliente del Hito 2, no después.
5. **La semántica de `clear()` del result-cache** (`result-cache.ts:103-106`): si para entonces existe invalidación selectiva, D8 se refina a invalidar por PI.
6. **Si el nodo dejó de ser single-node** (`README.md:62`): el bus in-process asume un proceso; multi-réplica exige externalizarlo (el contrato §3.1 es la costura prevista, pero la pieza concreta —¿el GovernanceStore como relay? ¿un pub/sub?— se diseña entonces).
7. **El bloque `realtime:` contra la rúbrica de convenciones** si #111 ya existe al destrabar (naming del DSL).

---

## 6 · Riesgos y no-metas

**Riesgos:**

- **Proxies que bufferizan** el stream ⇒ el cliente conecta y no recibe nada. Mitigado por diseño (la feature degradada = hoy, D6) y por el Hito 4 como gate de producción. El header `x-accel-buffering: no` del contrato §3.2 es señal a proxies que lo honran — **no verificado contra Caddy/oauth2-proxy concretos** (§7-a).
- **Manada de re-renders** tras una señal `'*'` (gobierno): N espectadores re-piden a la vez. Acotado por: coalescing (D9), el modo default `notify` (el re-render espera el clic humano, D7) y el result-cache si la instancia lo activa. Si un despliegue `auto` masivo lo vuelve real, jitter aleatorio en el cliente es la palanca — se decide en el Hito 3.
- **Conexiones vivas como recurso**: cada pestaña abierta es un socket sostenido en un server single-process. El TTL (D5) y el latido (limpieza de muertos) lo acotan; `stats()` lo hace observable. Sin límite duro por diseño hoy — si un despliegue lo exige, es un `maxStreams` con 503 y `retry` largo.
- **Señal sin cambio visible**: una corrida exitosa que no alteró filas del consumidor produce banner sin diferencia perceptible. Aceptado: la señal es «hay corte nuevo» (coherente con el as-of del header, #108), no «tus filas cambiaron» — prometer lo segundo exigiría evaluar dato por identidad (rechazado en D1/D2).

**No-metas (selladas):**

- **CDC** por tabla (Fabric change feed / triggers CH) — productor futuro detrás del bus, no parte de este frente.
- **Evento-dato / render push** — rechazado con racional en D1/D2, no diferido.
- **Multi-réplica / fan-out externo** — terreno Enterprise (`README.md:62`); aquí solo se deja la costura (§3.1).
- **Invalidación selectiva del result-cache** — D8 usa el `clear()` existente.
- **WebSocket / interactividad bidireccional** — fuera del propósito del canal.
- **Realtime sobre impresiones congeladas o modo print** — contradiría su promesa de documento (§3.4).

---

## 7 · Precisión que hoy sería fingida (declarada)

- **(a) Comportamiento de Caddy y oauth2-proxy con SSE** — flags de flush, idle-timeouts, si el stream atraviesa sin buffering: **conjetura, sin verificar** — no es derivable de este repo (el compose de referencia no configura streaming, `deploy/compose.reference.yml:124-150`) y la literatura no sustituye la medición en el despliegue real. Es exactamente el experimento del Hito 4, y va **antes** del cliente.
- **(b) El shape final de `live` en `RunOptions`/bandeja** — contratado por calco de `pdfUrl`, pero esa superficie se mueve; el Hito 2 se elabora al destrabar.
- **(c) Granularidad de la señal `spec`** — el watch actual reconstruye el catálogo entero sin decir qué archivo cambió (`serve-rls.ts:1703-1719`); afinar a por-slug requiere pasar el filename del watcher (disponible en `hot-reload.ts:62`) — decisión menor que se toma en el Hito 1 con el código delante; el contrato del bus la soporta igual (`publish(slug|'*')`).
- **(d) El algoritmo de swap del modo `auto`** — morph vs reemplazo, preservación de scroll/foco: se decide en el Hito 3 con la página real.
- **(e) Los valores por defecto** de TTL/latido/coalescing (15 min / 25 s / 500 ms) son puntos de partida razonados, no medidos; el Hito 4 los calibra contra los timeouts reales de la cadena de proxies.

---
• 🤖 Claude (Fable) · diseño del frente #113 realtime · cluster 004
