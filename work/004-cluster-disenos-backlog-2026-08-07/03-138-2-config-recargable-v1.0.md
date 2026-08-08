# 004·03 · Diseño — config recargable sin recrear el proceso — issue #138 pieza 2

**Estado: diseño ejecutable, gated por el OK de César sobre D1–D3.** Elabora el boceto
`work/003-cluster-solicitudes-2026-08-07/03-diseno-env-recargable-v1.0.md` hasta contrato ejecutable:
aquél sella el replanteo (en Docker el env de un contenedor es inmutable — la pieza real es **mover de
env a vía vigilada todo lo que merezca cambiar en caliente**) y deja tres decisiones abiertas; este
documento las sella como propuestas, define los contratos módulo a módulo y baja las tres fases a
hitos con juez. Lo que el boceto ya inventarió no se repite: se cita.

---

## 1 · Estado actual verificado

### 1.1 · La vía recargable existente (el patrón a extender)

- **Instalación de watches**: todo watch pasa por `contract.watch(meta, paths, onChange)`, que
  registra la entrada en el contrato **y** llama `watchPaths` en la misma llamada — imposible que
  driften (`server/contract.ts:131-136`; doctrina en `server/serve-rls.ts:163-166`).
- **Validate-before-swap**: `reloadLiveList` (listas vivas, swap por splice in-place;
  `server/hot-reload.ts:116-138`) y `swapRecordInPlace` (registros vivos por clave, diff en conteos
  sin valores; `server/hot-reload.ts:146-162`). Un archivo roto conserva lo vigente y loguea.
- **Recargas hoy instaladas** (`server/serve-rls.ts:1700-1748`): specs
  (`VERGIS_SPECS_DIR`/`VERGIS_SPECS`, líneas 1703-1719), políticas (`VERGIS_POLICIES`, 1720-1726),
  gobierno de dominio (`VERGIS_CONNECTIONS`+`VERGIS_DOMAINS`+`VERGIS_INTAKE`, 1730-1744, con envs
  **derivadas** de qué archivos existen, 1734-1737). `SIGHUP` fuerza la recarga completa de gobierno
  (1745-1746).
- **`reloadGovernance(reason)`** (`server/serve-rls.ts:1645-1690`): dominio primero, luego políticas
  (swap del `Map` vivo tras parsear todo OK), invalidación del result-cache, rebuild de specs,
  `contract.record` con artefactos hasheados, re-bootstrap fail-closed con radio de daño por motor.

### 1.2 · La clasificación del contrato es DERIVADA — la reclasificación automática ya existe

`snapshot()` calcula `reloadableContent` como la unión de las `envs` de los watches instalados y
`bootOnly` como lo consumido menos eso (`server/contract.ts:174-177`). `loadInstanceConfig` recibe
`contractEnv` — un Proxy sobre `process.env` que registra cada acceso como consumo
(`server/serve-rls.ts:170-177`, 875). **Consecuencia verificada: registrar un watch nuevo con
`contract.watch({ envs: ['VERGIS_NOTIFY', …] }, …)` mueve esas envs de `bootOnly` a
`reloadableContent` sin tocar el contrato** — la exigencia del brief («la reclasificación debe ser
automática») se cumple por construcción del código ya mergeado; este diseño no necesita añadirle
mecanismo, solo usarlo.

### 1.3 · La carga boot-only y sus consumidores, artefacto por artefacto

`loadInstanceConfig(contractEnv)` corre una vez, top-level y fatal (`server/instance-config.ts:77-118`,
`server/serve-rls.ts:875`). Cómo consume cada pieza el proceso — esto decide qué tan lejos está cada
una de ser recargable:

| Pieza | Consumo verificado | Distancia a recargable |
|---|---|---|
| `notify` (destinos) | Sinks construidos UNA vez en `const alertSinks`/`reportSinks` (`serve-rls.ts:880-881`); el lazo de frescura recibe el closure de fan-out **solo si había destinos al boot** (`serve-rls.ts:1206`, spread condicional); `fanout` itera el arreglo a call-time (`server/notify.ts:283-291`) | Corta: arreglos vivos + quitar el condicional |
| `notify.report` (cadencia) | `createReportLoop` captura `cfg.schedule` en construcción y el lazo solo se arma si había `report:` al boot (`serve-rls.ts:1223-1243`; `server/report.ts:426,447-458`) | Media: pasar de valor capturado a provider |
| `piOwners` | `let piOwners` module-level (`serve-rls.ts:476`), reasignado en 915; consultado a call-time SOLO al bootstrapear un PI sin gobierno (`serve-rls.ts:600-619`); `bootstrapPi` es idempotente y retorna temprano si el PI ya tiene gobierno (`packages/capabilities/src/governance-store.ts:733-747`) | Corta: swap del mapa; la semántica lazy ya es la correcta |
| `sourceReg` | Sembrado en `SqliteGovernanceStore.open` (`governance-store.ts:588-619`) con guardas `managed_at` + tombstones `source_registry_removed`; los lectores (lazo de frescura, as-of, vistas) re-leen el store **por tick/request** (`serve-rls.ts:1163-1189`) | Corta: extraer la siembra a un método re-invocable |
| `groupSeeds` | Sembrado en `open` (`governance-store.ts:572-587`): miembros `INSERT … DO NOTHING` saltando tombstones `mira_group_seed_removed`; label upsert yaml-owned | Corta en mecanismo, sensible en semántica (§D1) |
| `publicUrl` | `VERGIS_PUBLIC_URL` es un **env escalar** (no archivo): irreductiblemente de arranque. Invariante de boot: destinos > 0 exigen URL (`instance-config.ts:89-91`). Capturada por los lazos en construcción (`serve-rls.ts:1211,1235`) | No aplica: queda boot-only; la recarga debe **re-verificar el invariante** (§4.4) |
| `entities` (master-data) | Cablea esquema/stores/admin al boot (`serve-rls.ts:888,917-919`) | Declarada boot-only con caveat (boceto §inventario; D6) |
| `VERGIS_IDENTITY_MAP` | `const IDENTITY_MAP` parseado al boot (`serve-rls.ts:438-444`); `createIdentity` captura la referencia y `enrichFromMap` la lee **por llamada** (`server/identity.ts:21-56`) | Corta en mecanismo, autorización viva (fase 3) |
| Escalares (`VERGIS_INDEX_TITLE` · `VERGIS_DATA_CACHE_TTL_MS` · `VERGIS_REFRESH_MS` · `VERGIS_INTERACTIVE_MAX_ROWS`) | Validados en `configFromEnv` (`server/config.ts:276-281`); consumo: título con **precedencia in-app ya cableada** (abajo), TTL envuelve el conector una vez (`serve-rls.ts:402-406`), refresh arma un `setInterval` una vez (`serve-rls.ts:343`), max-rows se inyecta por request (`serve-rls.ts:520,1530`) | §D2 — el producto ya tiene una vía caliente para escalares |

### 1.4 · El precedente decisivo para los tunables: `platform_setting`

El producto **ya tiene** una vía caliente, auditada y con superficie admin para escalares de
operación: la tabla `platform_setting` (`governance-store.ts:391-393,1011-1023`), editada desde
Administración (`server/admin.ts:439-456`, página en 909-931), con **precedencia in-app > env
resuelta a request-time**: `idxTitle = (governance ? await governance.getSetting('index_title') :
null) || INDEX_TITLE` (`serve-rls.ts:671`). Los settings de notas usan la misma vía
(`admin.ts:439-441`). Este precedente reordena la decisión (a) del boceto — ver D2.

### 1.5 · La semántica managed-vs-semilla vigente (#101/#105/#107), verificada

- **Fuentes/procesos**: la siembra SALTA ids tombstoneados (`source_registry_removed`) y NO pisa
  filas con `managed_at` sellado; jamás toca `managed_at` (`governance-store.ts:588-619`). Un alta
  in-app revoca el tombstone (`governance-store.ts:869-878,895`). Doctrina escrita: «runtime gana
  sobre la config» (`governance-store.ts:400-402`).
- **Grupos**: miembros semilla con `INSERT … DO NOTHING` + tombstone por miembro
  (`mira_group_seed_removed`, `governance-store.ts:361-369,572-587`); `removeMember` deja tombstone,
  `addMember` lo revoca (`governance-store.ts:694-713`); no existe rename in-app (solo
  create/delete/addMember/removeMember, `governance-store.ts:653-671`) → el label es yaml-owned sin
  conflicto posible. `deleteGroup` borra el grupo Y sus tombstones: un grupo semilla borrado in-app
  **reaparece en el siguiente `open()`** — semántica vigente documentada («un grupo recreado parte de
  cero», `governance-store.ts:667-668`).
- **Dueños de PI**: `bootstrapPi` solo escribe si el PI **no tiene** registro de gobierno
  (`governance-store.ts:733-747`) — el mapa semilla es un default de primer contacto, nunca una
  fuente que pise gobierno existente.

---

## 2 · Decisiones selladas

### D1 · Recargar GROUPS/PI_OWNERS/SOURCES = re-correr la MISMA proyección idempotente del arranque `[aprobada por César · 2026-08-08]`

**Sellada: la recarga re-ejecuta exactamente la siembra de `open()` — ni más ni menos.** La pregunta
del boceto («¿re-siembra o solo entidades nuevas?») se disuelve al verificar §1.5: la siembra vigente
**ya es** «lo gestionado in-app gana» por construcción — guardas `managed_at`, tombstones por id y
por miembro, `bootstrapPi` que retorna temprano. Re-correrla en caliente no pisa nada que un restart
de hoy no pisaría: **cambia el cuándo, no el qué**. No se inventa semántica nueva; la doctrina de
#101/#105/#107 queda sellada como la semántica de la recarga.

Consecuencias que se documentan (no se «arreglan» — son la semántica vigente, coherente):

- Dueño cambiado en `pi-owners.yaml` NO re-aplica a un PI ya bootstrapeado (el traspaso de dueño es
  operación in-app); SÍ aplica a PIs que aún no tienen gobierno.
- Un grupo semilla borrado in-app reaparece al re-sembrar (hoy: al siguiente restart; con esto: al
  siguiente toque del yaml). Para eliminarlo de verdad se retira del yaml — el contrato lo declara
  como caveat colocado (§4.6).
- La semilla nunca REMUEVE: retirar una fuente/miembro del yaml no lo borra del store (la baja es
  in-app y deja tombstone). El yaml es piso declarativo, no espejo.

**Alternativa descartada — recarga «solo entidades nuevas» (diff contra el yaml previo):** exige
retener el estado anterior del archivo y decidir caso a caso qué es «nuevo», duplica la lógica de
guardas que el store ya posee, y produce una semántica DISTINTA a la del restart — el operador tendría
que aprender dos conductas para el mismo archivo según cómo entró. Peor herramienta, más código.

### D2 · Tunables: la vía caliente es `platform_setting` (in-app > env); NO se crea `VERGIS_TUNABLES` `[aprobada por César · 2026-08-08]`

**Sellada: los escalares que merecen cambio en caliente se gestionan como settings de plataforma en
Administración, con la precedencia que el producto ya cablea para `index_title`
(`serve-rls.ts:671`): `platform_setting` (in-app) > env (default de arranque) > default de código.**
El env deja de ser «el valor» y pasa a ser «el default de la instancia»; el cambio caliente es una
operación de admin auditada (`admin.ts:456` ya audita `platform-setting`), persistente entre
restarts, sin tocar el filesystem del contenedor.

Esto responde la pregunta del boceto («¿precedencia archivo > env, o archivo-only?») disolviéndola:
**no hay archivo**. La pregunta de precedencia archivo-vs-env solo existe si se crea la tercera
fuente; el criterio de excelencia manda no crearla.

**Alternativa descartada — archivo `VERGIS_TUNABLES` vigilado con precedencia archivo > env (la del
boceto):** crearía una SEGUNDA fuente caliente en paralelo a `platform_setting` — dos verdades
calientes cuya precedencia mutua habría que inventar y explicar (¿settings in-app sobre el archivo,
o el archivo sobre los settings?), sin superficie de edición, sin auditoría, y con un formato nuevo
que mantener. El único caso que serviría mejor es la instancia SIN bloque de gobierno (sin
Administración) — y esa instancia es el arnés de dev, donde reiniciar es gratis. Descartada por
redundante con una vía existente mejor.

Alcance de fase 2 (por escalar, según su consumo verificado en §1.3): `interactive_max_rows`
(inyección por request — trivial), `data_cache_ttl_ms` (el wrapper pasa a leer TTL por provider),
`refresh_ms` (re-arme del timer al cambiar). `index_title` ya está. Escalares nuevos nacen settings.

### D3 · Alcance: la fase 1 cierra la pieza 2 del issue; las fases 2 y 3 quedan diseñadas con disparador `[aprobada por César · 2026-08-08]`

**Sellada: implementar fase 1 (notify completo + pi-owners + sources) da por resuelta la pieza 2 de
#138.** El incidente y el issue nombran «destinos de aviso»; el inventario del boceto ubica ahí el
valor alto/riesgo bajo. Las fases 2 y 3 valen por sí mismas pero su costo no lo justifica hoy un
incidente real:

- **Fase 2 (tunables)** — disparador: la primera vez que cambiar un escalar en producción duela de
  verdad (hoy ninguno ha exigido un cambio caliente).
- **Fase 3 (groups + identity-map)** — disparador: la primera operación real de instancia que pida
  cambiar membresía semilla o mapeo de identidad sin ventana de reinicio. `VERGIS_IDENTITY_MAP`
  además toca autorización viva: se implementa solo con su experimento adversarial (§5, F3-H2).

**Alternativa descartada — paquete completo de una vez:** infla el PR que César debe revisar,
mezcla riesgo bajo (avisos) con autorización viva (identity map), y construye para escalares una
necesidad que aún no ocurrió.

### D4 · Granularidad de la recarga: por archivo, validate-before-swap, nunca all-or-nothing

`loadInstanceConfig` es fatal y monolítica **a propósito para el boot** (#117: un archivo roto debe
tumbar el arranque). Esa conducta es la equivocada para la recarga: un `notify.yaml` roto no debe
impedir que un `sources.yaml` sano entre. La recarga opera **por slice** con el patrón vigente de
`reloadDomainGovernance` (`serve-rls.ts:1625-1643`): cada archivo se re-parsea con su propio parser;
el que falla conserva su estado vigente y loguea; los demás entran. El boot no cambia.

### D5 · El invariante de `VERGIS_PUBLIC_URL` en recarga: falla el swap del slice, jamás el proceso

El invariante de boot (destinos > 0 ⇒ URL pública, `instance-config.ts:89-91`) debe re-verificarse
al recargar notify — y como el env es inmutable en el contenedor, la URL **no puede aparecer en
caliente**: si el yaml recargado declara destinos y la instancia no tiene `VERGIS_PUBLIC_URL`, el
slice notify se RECHAZA (vigente conservado, log nombrando la variable, `contract.record` con
`ok:false`). Tumban el proceso solo los errores de boot; una recarga jamás.

### D6 · Lo irreductiblemente de arranque se declara donde el operador pregunta

`VERGIS_MASTER_DATA` y `VERGIS_DATASETS` quedan boot-only **con caveat colocado** (`contract.caveat`,
patrón de `serve-rls.ts:254-259`) explicando el motivo (arrastran esquema/DDL y superficies cableadas;
`BOUND` se fija al arranque — boceto §inventario). Las RUTAS de todos los archivos, los secretos y el
wiring (`VERGIS_ENGINE`, `PORT`/`HOST`, `MIRANDA_*`, etc.) ya salen `bootOnly` derivados solos.

### D7 · SIGHUP recarga TODO lo recargable

`SIGHUP` hoy equivale a `watch:policies` (`serve-rls.ts:1745-1746`). Con la config de instancia
recargable, la promesa «fuerza la recarga completa» debe seguir siendo verdad: el handler pasa a
invocar también `reloadInstanceSlices('SIGHUP')` (§4.3). Un operador con el archivo ya montado y el
watch perdido (p. ej. bind-mount con inotify no propagado) tiene así una vía manual garantizada.

---

## 3 · Arquitectura — módulos y contratos

### 3.1 · `server/instance-config.ts` — slices recargables como dato exportado

El módulo gana una tabla **derivada de los mismos parsers del boot** (no una lista paralela):

```ts
/** Un slice recargable de la config de instancia: env → parser. El boot y la recarga usan LA MISMA
 *  entrada; divergir es imposible por construcción. */
export interface InstanceSlice<T> {
  env: 'VERGIS_NOTIFY' | 'VERGIS_PI_OWNERS' | 'VERGIS_SOURCES'   // fase 3 añade VERGIS_GROUPS
  parse: (doc: unknown) => T
}

export const RELOADABLE_SLICES: {
  notify: InstanceSlice<NotifyConfig>
  piOwners: InstanceSlice<Record<string, string>>
  sources: InstanceSlice<SourcesConfig>
}

/** Re-parsea UN slice desde disco. Lanza con el patrón de `loadOne` (ENV + ruta absoluta en el
 *  mensaje). `undefined` si el env no está declarado. PURA respecto del proceso: no swapea nada. */
export function loadSlice<T>(env: EnvLike, slice: InstanceSlice<T>, readFile?: ReadFile): T | undefined
```

`loadOne` (hoy privada, `instance-config.ts:61-70`) pasa a ser el corazón de `loadSlice`;
`loadInstanceConfig` queda intacta en firma y conducta (boot fatal, #117).

### 3.2 · `packages/capabilities/src/governance-store.ts` — la siembra como operación de primera clase

La siembra inline de `open()` (`governance-store.ts:572-620`) se extrae a una función compartida y se
expone como método:

```ts
/** Re-corre la proyección semilla → store con las guardas vigentes (managed_at, tombstones,
 *  DO NOTHING de miembros). Idempotente; es EXACTAMENTE lo que open() ejecuta al arranque (misma
 *  función interna). Lanza ante semilla inválida SIN haber escrito (valida antes de tocar la DB). */
reseed(seed: Pick<GovernanceSeed, 'groups' | 'sources' | 'tableSources' | 'processes' | 'processOutputs'>): Promise<void>
```

Detalle que la extracción debe respetar: `validateOferta` corre HOY por fila dentro del loop
(`governance-store.ts:592`) — con archivos parciales podía dejar siembra a medias en el boot (donde
da igual: el proceso muere). En `reseed` la validación completa corre **antes** del primer `db.run`
(validate-before-write), para que una recarga rechazada no deje el store a medio sembrar. La firma
con `Pick` permite a fase 1 sembrar solo `sources*` y a fase 3 añadir `groups` sin tocar el contrato.

### 3.3 · `server/serve-rls.ts` — el orquestador `reloadInstanceSlices`

```ts
/** Recarga los slices de config de instancia declarados, POR ARCHIVO (D4). Nunca lanza. */
function reloadInstanceSlices(reason: string): void
```

Conducta por slice (cada uno en su try/catch, con su `contract.record` y su artefacto por `source`):

1. **`notify`** — `loadSlice(...)` → re-verificar el invariante D5 → `createSinks(forEvent(next,
   'alerts'))` y `createSinks(forEvent(next, 'reports'))` (que LANZAN ante `passEnv` ausente o
   `caFile` ilegible, `notify.ts:221-256` — el validate-before-swap los atrapa y conserva lo
   vigente) → splice in-place de los arreglos vivos `alertSinks`/`reportSinks` → swap del bloque
   `report` vivo (§3.4). `contract.record({reason, ok}, [{source:'notify', path}])`.
2. **`piOwners`** — `loadSlice(...)` → `swapRecordInPlace(piOwners, next)` → log del diff en
   conteos. `piOwners` pasa de `let` reasignable a **objeto vivo `const`** poblado por splice (el
   consumo por clave a call-time, `serve-rls.ts:603,618`, no cambia).
3. **`sources`** — `loadSlice(...)` → `governance.reseed({ sources, tableSources, processes,
   processOutputs })`. Los lectores no se tocan: frescura/as-of/vistas ya re-leen el store por
   tick/request (§1.3). Sin bloque de gobierno (`governance === null`) el slice se salta con log —
   y su watch ni se registra (§3.5).

Cambios de wiring que la recarga exige (los «casos feos» del brief, resueltos en el cableado):

- **El lazo de frescura recibe el fan-out SIEMPRE** — el spread condicional de `serve-rls.ts:1206`
  se elimina: `notify: (n) => fanout(alertSinks, n, …)` incondicional. `fanout` sobre arreglo vacío
  es no-op (`notify.ts:283-291`), y así los destinos que aparecen en caliente empiezan a recibir
  avisos **sin reconstruir el lazo en vuelo**. El swap del arreglo es síncrono (single-thread): un
  tick en curso ve el arreglo pre-swap o post-swap, nunca un estado intermedio; un `send` ya
  despachado termina contra su destino viejo (at-most-once intacto).
- **Dedup por transición y destinos nuevos**: el estado de alertas vive en el lazo, no en los sinks
  — un destino nuevo NO recibe replay de alertas ya en curso; se estrena con las transiciones
  futuras. Coherente con at-most-once; se documenta en el caveat de notify (§4.6).

### 3.4 · `server/report.ts` — la cadencia como provider

`createReportLoop` pasa de capturar `cfg.schedule`/`timezone` a consultarlos por tick:

```ts
export interface ReportLoopConfig {
  /** Se consulta POR TICK: null = reporte apagado (tick no-op). La tz se re-resuelve con él. */
  schedule: () => ReportSchedule | null
  baseUrl: string
  freshnessPollMs: number
  engineCabled: boolean
}
```

El lazo se arma **incondicionalmente** cuando hay bloque de gobierno (el interval de 60 s,
`report.ts:31`, es costo nulo); con `schedule() === null` cada tick retorna temprano. Así `report:`
puede aparecer, cambiar de hora/cadencia o desaparecer en caliente. Dos invariantes de boot se
re-verifican en la recarga del slice notify (patrón D5): `report:` sin bloque de gobierno
(`serve-rls.ts:883-884`) rechaza el slice; el estado interno del lazo (`lastDueAt`/ventana) se
computa por tick desde el schedule vigente, así que un cambio de hora simplemente redefine el
próximo due — el catch-up existente (`report.ts:12`) cubre la ventana.

### 3.5 · Registro del watch — un solo watch para la config de instancia

En el bloque `HOT_RELOAD` (`serve-rls.ts:1700+`), con el patrón derivado de 1730-1744:

```ts
const instanceTargets = [
  ...(contract.env('VERGIS_NOTIFY')    ? [resolve(contract.env('VERGIS_NOTIFY') as string)]    : []),
  ...(contract.env('VERGIS_PI_OWNERS') ? [resolve(contract.env('VERGIS_PI_OWNERS') as string)] : []),
  ...(governance && contract.env('VERGIS_SOURCES') ? [resolve(contract.env('VERGIS_SOURCES') as string)] : []),
]
if (instanceTargets.length) {
  contract.watch(
    { envs: [/* derivadas igual que los paths */], reloads: 'config de instancia (avisos + dueños + registro de fuentes), por archivo' },
    instanceTargets,
    () => reloadInstanceSlices('watch:instancia'),
  )
}
process.on('SIGHUP', …)  // el handler existente añade reloadInstanceSlices('SIGHUP') — D7
```

Un solo watch con recarga por-archivo adentro (el debounce de `watchPaths` ya coalesce ráfagas;
recargar los tres slices es barato e idempotente — mismo criterio que el watch de gobierno de
dominio, `serve-rls.ts:1727-1729`). **La reclasificación del contrato ocurre sola** en este punto
(§1.2): `VERGIS_NOTIFY`, `VERGIS_PI_OWNERS` y `VERGIS_SOURCES` pasan a `reloadableContent`;
`VERGIS_PUBLIC_URL` permanece `bootOnly` — que es la verdad.

### 3.6 · Fase 2 — contratos de los tunables (D2)

- Claves de setting (mismo naming que `index_title`): `data_cache_ttl_ms` · `refresh_ms` ·
  `interactive_max_rows`. Resolución `setting ?? env ?? default` en un helper único
  `tunable(key, envValue, fallback)` para que la precedencia viva en UN lugar.
- `withResultCache(cap, { ttlMs })` acepta `ttlMs: number | (() => number)` — el wrapper se instala
  SIEMPRE que env o setting puedan encender el caché, y lee el TTL efectivo por entrada; TTL 0 =
  bypass (no cachear, no servir hits).
- El timer de re-ingesta (`serve-rls.ts:343`) pasa a re-armarse: un scheduler chico que lee el
  valor efectivo al vencer cada ciclo (`setTimeout` encadenado, no `setInterval`) — cambiarlo en
  caliente reprograma el próximo tick sin tocar el proceso.
- `interactive_max_rows` se resuelve donde ya se inyecta por request (`serve-rls.ts:520,1530`).
- Superficie: los campos entran a la página de settings existente (`admin.ts:909-931`), con
  auditoría `platform-setting` (patrón `admin.ts:456`).
- Contrato: los envs siguen `bootOnly` (verdad: el ENV exige restart) + caveat colocado: «el valor
  efectivo de estos escalares es el setting de plataforma (Administración), cambiable en caliente;
  el env es solo el default de arranque».

### 3.7 · Fase 3 — grupos e identity map

- **`VERGIS_GROUPS`**: añadir `groups` al `reseed` del slice (el contrato de §3.2 ya lo admite) y
  el env al watch derivado. Semántica: D1, sin código nuevo en el store.
- **`VERGIS_IDENTITY_MAP`**: `IDENTITY_MAP` pasa de `const` posiblemente-null a **objeto vivo**
  (cuando el env está declarado): la recarga parsea + valida forma (`Record<string,
  Record<string, string | string[]>>`, emails en minúscula) y hace `swapRecordInPlace`.
  `enrichFromMap` lee por llamada (§1.3) → el swap aplica al siguiente request. Fail-closed
  verificado en la semántica existente: un email que desaparece del mapa pierde sus claims del
  directorio → default-deny (`identity.ts:48-56`). Validate-before-swap estricto: JSON roto o forma
  inválida conserva el mapa vigente (a diferencia del notify, acá conservar es MÁS seguro que
  vaciar: vaciar degradaría a default-deny masivo por un typo).

---

## 4 · Los casos feos, uno a uno

| # | Caso | Resolución de diseño |
|---|---|---|
| 4.1 | Notify recargado con destinos nuevos y el lazo de frescura en vuelo | Arreglos vivos + fan-out incondicional (§3.3). El tick en curso termina con el arreglo que capturó al entrar a `fanout`; el siguiente usa el nuevo. Sin replay de alertas en curso (dedup por transición vive en el lazo). |
| 4.2 | Destinos aparecen en caliente y la instancia no tiene `VERGIS_PUBLIC_URL` | D5: slice rechazado, vigente conservado, log nombra la variable, `contract.record ok:false`. El operador ve en `/contrato` que la recarga falló y por qué; añadir la URL exige el restart que el env siempre exigió. |
| 4.3 | Destino email nuevo cuyo `passEnv` no existe en el entorno | `createSinks` lanza (`notify.ts:234-237`) → validate-before-swap conserva lo vigente. El secreto es env: no puede aparecer en caliente; el mensaje lo nombra. Mismo tratamiento para `caFile` ilegible (ese SÍ puede arreglarse en caliente montando el PEM y re-tocando el yaml). |
| 4.4 | `report:` aparece en caliente en instancia sin bloque de gobierno | Re-verificación del invariante de `serve-rls.ts:883-884` en la recarga → slice rechazado (D5). |
| 4.5 | GROUPS que «pisa» membresía in-app | No ocurre: verificado §1.5 — miembros con `DO NOTHING` + tombstones; runtime gana. Lo único yaml-owned es el label (no hay rename in-app: sin conflicto). |
| 4.6 | Grupo semilla borrado in-app resucita al tocar el yaml | Semántica vigente de `open()` (D1) — la recarga la hace llegar antes, no la crea. Caveat colocado en el contrato: «la baja definitiva de un grupo semilla se hace retirándolo del yaml; la baja in-app de un grupo aún declarado revive con la siguiente siembra». |
| 4.7 | Dueño de PI cambiado en el yaml no re-aplica a PI ya gobernado | Correcto por D1 (`bootstrapPi` idempotente). El traspaso es in-app. Se documenta en el `reloads` del watch para que `/contrato` lo diga. |
| 4.8 | Archivo decapitado (perdió la clave raíz) | Los parsers LANZAN desde #117 (`requireRootKey` — p. ej. `notify.ts:109-111`, `governance-config.ts:67-71`) → conserva vigente. Ya resuelto por la infraestructura; los tests lo re-verifican por slice. |
| 4.9 | Save atómico (rename de inode) sobre el yaml vigilado | `watchPaths` vigila el directorio filtrando por basename precisamente por esto (`hot-reload.ts:56-65`). Heredado. |
| 4.10 | Dos slices tocados en una ráfaga, uno roto | D4: el sano entra, el roto conserva vigente; dos `contract.record` separados con `source` propio — `/contrato` muestra el artefacto roto como `pending` (hash de disco ≠ cargado). |

---

## 5 · Plan de construcción

Convenciones de los gates (todos los hitos): `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`;
el juez es el exit code sin pipes que lo enmascaren. Gate global de cada PR: `npx tsc --noEmit &&
npx vitest run`. Los tests nombrados abajo son los NUEVOS que el hito debe dejar; Norma 7: cada test
de mecanismo se lista con el resultado que lo refutaría.

### Fase 1 — notify + pi-owners + sources (cierra la pieza 2)

**F1-H1 · `reseed` en el store** — territorio: `packages/capabilities/src/governance-store.ts`,
`tests/governance-store.test.ts`.
Extraer la siembra compartida; método `reseed` con validate-before-write (§3.2).
*Hecho cuando* `npx vitest run tests/governance-store.test.ts` pasa con estos casos nuevos:
(1) `reseed` con fila `managed_at` sellado y yaml distinto → la fila NO cambia (refutaría: cambia);
(2) `reseed` con id tombstoneado → no resucita (refutaría: reaparece);
(3) alta in-app tras tombstone + `reseed` → sí entra (tombstone revocado);
(4) `reseed` con `oferta` inválida en la fila N → **ninguna** fila escrita (refutaría: filas 1..N−1
escritas — el modo de falla que la extracción podría introducir);
(5) `open()` y `reseed` sobre el mismo seed dejan el store idéntico (misma proyección).

**F1-H2 · Slices en `instance-config`** — territorio: `server/instance-config.ts`,
`tests/instance-config.test.ts`.
`RELOADABLE_SLICES` + `loadSlice` (§3.1); `loadInstanceConfig` intacta (sus tests actuales no se
tocan y deben seguir verdes).
*Hecho cuando* los tests nuevos cubren: env no declarado → `undefined`; archivo roto → lanza
nombrando ENV + ruta; decapitado (sin clave raíz) → lanza (4.8).

**F1-H3 · Orquestador + wiring + watch** — territorio: `server/serve-rls.ts` (bloques §875-915,
§1195-1243, §1700-1748), `tests/hot-reload.test.ts` o test nuevo `tests/instance-reload.test.ts`.
`reloadInstanceSlices` (§3.3), arreglos vivos de sinks, fan-out incondicional, `piOwners` vivo,
watch derivado + SIGHUP (§3.5, D7), caveats D6.
*Hecho cuando*:
(1) test: lazo de frescura construido con 0 destinos → splice de un sink al arreglo → el siguiente
tick ENTREGA por el sink nuevo (refutaría: no entrega — el condicional de 1206 seguía);
(2) test: recarga notify con destinos y sin `publicUrl` → arreglo vigente intacto + `ok:false` en
el ring del contrato (refutaría: swap ocurrió);
(3) test: `createSinks` que lanza (passEnv ausente) → vigente intacto (4.3);
(4) test del contrato: tras registrar el watch, `snapshot().env.reloadableContent` contiene
`VERGIS_NOTIFY`/`VERGIS_PI_OWNERS`/`VERGIS_SOURCES` y `bootOnly` NO (refutaría: siguen bootOnly —
la reclasificación automática prometida no ocurre);
(5) test: swap de `piOwners` → `piGovSummary` de un PI sin gobierno usa el dueño nuevo; el de un PI
ya bootstrapeado no cambia (D1/4.7).

**F1-H4 · Reporte con schedule vivo** — territorio: `server/report.ts`, `server/serve-rls.ts`
(§1223-1243), `tests/report.test.ts`.
Provider por tick (§3.4); lazo armado con gobierno presente aunque no haya `report:` al boot.
*Hecho cuando*: (1) test: provider null → tick no-op; provider pasa a devolver schedule → el
siguiente due se computa y el envío sale (refutaría: hace falta reconstruir el lazo); (2) test:
cambio de `at` en caliente → el próximo envío respeta la hora nueva; (3) los tests vigentes de
`report.test.ts` siguen verdes con la firma nueva.

**F1-H5 · Verificación integrada (el experimento de la Norma 7 para el mecanismo completo)** —
territorio: ninguno (corrida, no código); opcionalmente `tests/acceptance.test.ts`.
Con el arnés de dev: arrancar con `VERGIS_NOTIFY` de 0 destinos → editar el yaml montado añadiendo
un webhook de prueba → **sin tocar el proceso**, forzar una transición de frescura → el aviso llega
al webhook y `GET /contrato` muestra la recarga en el ring y el artefacto notify sin `pending`.
*Refutaría el diseño entero*: el aviso no llega, o llega solo tras restart. Documentar la corrida
(comando + salida) en el PR.

### Fase 2 — tunables por `platform_setting` (disparador: D3)

**F2-H1 · Helper de precedencia + claves** — `server/serve-rls.ts`, `server/admin.ts`,
`tests/admin-handler.test.ts`. *Hecho cuando* el setting guardado gana al env y el env gana al
default, demostrado por test para las tres claves (refutaría: env gana al setting).
**F2-H2 · Consumidores vivos** — `packages/botler` (`withResultCache` con TTL-provider),
`serve-rls.ts` (timer encadenado, max-rows por request), tests de cada uno. *Hecho cuando* un
cambio de setting altera la conducta SIN restart, por test: TTL 0→N enciende hits; `refresh_ms`
cambiado reprograma el próximo tick (medible con clock inyectado).
**F2-H3 · Caveats + contrato** — caveat colocado §3.6; test de snapshot.

### Fase 3 — groups + identity map (disparador: D3)

**F3-H1 · GROUPS al reseed + watch** — `serve-rls.ts`, `tests/governance-store.test.ts`. *Hecho
cuando* los casos 4.5/4.6 están cubiertos por test contra `reseed` (miembro in-app sobrevive;
tombstone respetado; label yaml-owned actualiza).
**F3-H2 · IDENTITY_MAP vivo** — `serve-rls.ts` (§438-444), `server/identity.ts` sin cambios,
test nuevo. *Hecho cuando*: (1) swap del mapa → el siguiente request resuelve claims nuevos;
(2) email retirado del mapa → default-deny inmediato (refutaría: conserva claims — habría caché
de identidad que este diseño no detectó); (3) JSON roto → mapa vigente conservado.

---

## 6 · Gate y sensibilidad al envejecimiento

**Gate:** el OK de César sobre D1, D2 y D3 (las tres marcadas revocables). D4–D7 son diseño técnico
bajo su paraguas; revocarlas no requiere ceremonia, solo coherencia.

**Qué re-verificar si esto envejece antes de implementarse:** (1) los anclajes de línea de
`serve-rls.ts` — es el archivo más caliente del repo; los bloques se citan también por nombre para
sobrevivir renumeraciones; (2) que `contract.ts` no haya ganado clasificaciones nuevas (este diseño
depende de que `reloadableContent` se derive SOLO de watches, `contract.ts:174-177`); (3) el diseño
01 de este cluster (#139 N2, delta del contrato): si introduce un shape de snapshot versionado, los
tests de F1-H3(4) deben apuntar al shape vigente; (4) si Miranda gana escritura sobre
`platform_setting`, revisar D2 (la precedencia sigue, la superficie crece).

## 7 · Riesgos y no-metas

- **No-meta: recarga de `VERGIS_MASTER_DATA` y `VERGIS_DATASETS`** — declarados boot-only con
  motivo (D6; boceto §inventario). Reabrir solo con un incidente que lo pague.
- **No-meta: espejo declarativo** (que retirar del yaml borre del store) — contradiría la doctrina
  managed-gana (D1). Si algún día se quiere, es un modo explícito nuevo, no un cambio de default.
- **No-meta: recarga de secretos** (gate, CSRF, API keys, `passEnv`) — son env; la vía es restart,
  y el contrato ya lo declara.
- **Riesgo: deriva boot↔recarga** — mitigado por construcción (mismos parsers vía
  `RELOADABLE_SLICES`, misma proyección vía `reseed` compartido con `open()`); el test F1-H1(5) lo
  vigila.
- **Riesgo: el swap de sinks email deja conexiones SMTP a medias** — no aplica: los sinks abren
  conexión POR envío (`sendSmtp` en cada `send`, `notify.ts:240-245`); no hay pool que herede
  destinos viejos. (Verificado en `createSinks`; el análogo real — pools mssql — ya tiene su caveat,
  `serve-rls.ts:254-259`.)
- **Riesgo: ráfaga de ediciones sobre el mismo yaml** — coalescida por el debounce heredado de
  `watchPaths` (200 ms); la recarga es idempotente, una recarga «de más» es un no-op logueado.

---
• 🤖 Claude (Fable) · diseño del frente #138·2 · cluster 004
