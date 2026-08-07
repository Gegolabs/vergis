# 003·A · Diseño — contrato operativo consultable (`/contrato`) — issue #139 Nivel 1

**Para el ejecutor (Opus):** este documento es tu brief completo. Arrancas en frío: todo lo que necesitas está aquí o en las rutas citadas. Fuentes de verdad, en orden de precedencia: (1) este documento, (2) el código vigente en `main`, (3) el issue #139 (`gh issue view 139`). Si el código contradice una línea citada aquí (el archivo se movió), manda el código: adapta el anclaje, no el diseño.

## ¿Qué se construye?

Un endpoint **`GET /contrato`** que expone, **derivado del estado vivo del proceso**, el contrato operativo del nodo: qué rutas se vigilan y qué recarga cada watch, si `SIGHUP` está disponible y qué hace, qué variables de entorno son de arranque, la última recarga (cuándo, qué la disparó, con qué resultado) y el hash de cada artefacto efectivamente cargado.

**Aceptación del issue (el gate del frente):** un operador —humano o agente— puede responder «¿este cambio exige reiniciar?» y «¿el nodo tomó mi archivo?» **preguntándole al binario que corre**, sin leer código, sin `docker logs` y sin manual externo.

## Principio rector: derivado, no declarado

Un dato entra al contrato **solo si la misma llamada que lo produce lo registra**. El patrón es envolver, no duplicar: la función que instala el watch es la que registra el watch; la lectura de env que pasa por el registro es la que queda registrada. Un arreglo estático de strings que alguien deba mantener a mano es exactamente lo que el issue rechaza. La única excepción son los `caveats` (limitaciones emergentes no derivables), que se registran **colocados en el sitio del código que posee la limitación**.

## Decisiones selladas

- **D1 — Ruta `/contrato`, top-level.** Vecino de `/healthz`, no extensión (el issue lo pide así; `/healthz` se mantiene reducido y **no se toca**). Precedente de rutas reservadas que sombrean slugs: `/admin`, `/miranda`, `/impresiones`.
- **D2 — Solo admins.** El contrato expone rutas del contenedor y nombres de env (jamás valores): es superficie de operación, no de consumo. Gate: token del proxy (ya global en `routes.ts`) **y** `isAdmin(email)` del store de gobierno, inyectado. Sin store de gobierno → 403 con mensaje claro («el contrato operativo requiere la Administración habilitada»). Método ≠ GET → 405.
- **D3 — JSON, claves en inglés, textos humanos en español.** Consistente con `/healthz` (`ok`, `engine`, `phase`). Sin vista HTML en N1.
- **D4 — Nunca valores de env ni secretos.** Solo NOMBRES de variables y rutas de archivos. Los perfiles de conexión no se hashean con su contenido en claro en el payload — sha256 del archivo es aceptable (no revela el contenido).
- **D5 — `pending` por comparación de hash.** Para cada artefacto cargado, el GET calcula el sha256 del archivo **en disco ahora** y lo compara con el sha256 **cargado**: distinto ⇒ `pending: true` (hay un cambio en disco que el nodo aún no tomó). Archivos chicos (YAML), endpoint de baja frecuencia: leer disco en el GET es aceptable.
- **D6 — La versión del producto sale de `VERGIS_VERSION`** (`packages/capabilities/src/version.ts` — fuente única, build-time, PR #135). No se lee package.json en runtime.

## Módulo nuevo: `server/contract.ts`

```ts
export interface WatchEntry { envs: string[]; paths: string[]; reloads: string }
export interface SignalEntry { signal: string; action: string }
export interface ArtifactState { source: string; path: string; sha256: string; loadedAt: string }
export interface ReloadEvent { at: string; reason: string; ok: boolean; error?: string; policies?: number; servablePis?: number }

export interface ContractRegistry {
  /** ÚNICO camino para instalar un watch registrado: llama a watchPaths (hot-reload.ts) Y registra.
   *  Devuelve el unwatch de watchPaths. Registrar y vigilar en una llamada = imposible que driften. */
  watch(meta: { envs: string[]; reloads: string }, paths: string[], onChange: () => void): () => void
  /** Registra un manejador de señal (colocado junto al process.on). */
  signal(entry: SignalEntry): void
  /** Lectura de env QUE REGISTRA la clave como consumida-de-arranque. Para los process.env directos
   *  de serve-rls fuera de configFromEnv (bloque clickhouse, MIRANDA_PROBE_DB, etc.). */
  env(key: string): string | undefined
  /** Declara claves consumidas por configFromEnv (ver configEnvKeys abajo). */
  envKeys(keys: string[]): void
  /** Limitación emergente no derivable, colocada en el sitio que la posee. */
  caveat(text: string): void
  /** Registra una recarga (o el boot, reason='boot') + hashea los artefactos recién cargados.
   *  Guarda la última por tipo y un ring de las 20 más recientes. Los artefactos REEMPLAZAN a los
   *  previos del mismo source (un reload de policies no borra el registro de specs). */
  record(event: Omit<ReloadEvent, 'at'>, artifacts?: { source: string; path: string }[]): void
  /** Snapshot puro para el endpoint (calcula `pending` leyendo disco; ver D5). */
  snapshot(now?: () => Date): ContractSnapshot
}

export interface ContractSnapshot {
  version: string | null       // VERGIS_VERSION
  engine: string
  startedAt: string
  hotReload: boolean           // lo fija serve-rls al construir (HOT_RELOAD)
  watches: WatchEntry[]
  signals: SignalEntry[]
  reloads: { last: ReloadEvent | null; recent: ReloadEvent[] }
  artifacts: (ArtifactState & { diskSha256: string | null; pending: boolean })[]
  env: {
    bootOnly: string[]           // consumidas y sin vía de recarga
    reloadableContent: string[]  // la RUTA es de arranque, el CONTENIDO se recarga (envs de watches)
    unknown: string[]            // presentes en process.env con prefijo VERGIS_/MIRANDA_ y jamás consumidas
  }
  caveats: string[]
}

export function createContractRegistry(opts: { engine: string; hotReload: boolean; envSource?: Record<string, string | undefined> }): ContractRegistry
export function createContractHandler(deps: { registry: ContractRegistry; isAdmin: ((email: string | undefined) => Promise<boolean>) | null }): (req, res) => Promise<boolean>
```

Notas de implementación:

- Hasheo: `createHash('sha256')` sobre el contenido del archivo; si `readFileSync` falla al registrar, se guarda el evento con `error` en vez de tumbar la recarga (el contrato jamás rompe el serving). Si falla en el GET (archivo borrado), `diskSha256: null`, `pending: true`.
- Clasificación de env en `snapshot()`: `reloadableContent` = unión de `envs` de los watches registrados; `bootOnly` = (claves de `envKeys()` ∪ claves leídas vía `registry.env()`) − `reloadableContent`; `unknown` = claves de `envSource` (default `process.env`) que matchean `/^(VERGIS_|MIRANDA_)/` y no están en ninguno de los dos conjuntos. `unknown` atrapa typos y envs deprecados — valor operacional gratis.
- El handler responde `application/json`, sin cache (`cache-control: no-store`).

## `server/config.ts` — derivar las claves consumidas

Agregar y exportar:

```ts
/** Claves de env que configFromEnv consume DE VERDAD (derivado: se corre sobre un Proxy que registra
 *  accesos). Branch-dependiente por diseño: si Miranda está apagada, sus claves no aparecen — y es
 *  verdad: no se consumieron. */
export function configEnvKeys(env: Env = process.env): string[]
```

Implementación: envolver `env` en un `Proxy` cuyo `get`/`has` registra la clave, correr `configFromEnv(proxied, () => 'x')` dentro de try/catch (una config inválida no debe romper la enumeración: se devuelven las claves registradas hasta el fallo), devolver las claves únicas ordenadas.

## Cableado en `server/serve-rls.ts`

1. Crear el registry temprano (tras `configFromEnv`): `const contract = createContractRegistry({ engine: ENGINE, hotReload: HOT_RELOAD, ... })` — ojo: `HOT_RELOAD` hoy se define en la línea ~1560; muévelo arriba junto al resto de la config o crea el registry con un setter. Registrar `contract.envKeys(configEnvKeys())`.
2. Reemplazar los `process.env['X']` directos de serve-rls por `contract.env('X')` **solo en serve-rls.ts** (bloque clickhouse líneas ~243–246, `VERGIS_GATE_CLAIMS` ~388, `MIRANDA_PROBE_DB` ~1427, `VERGIS_DOMAINS`/`VERGIS_INTAKE` ~1639-1640, `VERGIS_OUT` del bloque notas ~694, los que encuentres con `grep -n "process.env" server/serve-rls.ts`). Mismo valor, misma semántica — solo queda registrado.
3. Sustituir las TRES llamadas a `watchPaths` del bloque hot-reload (líneas ~1624, ~1633, ~1642) por `contract.watch(...)`:
   - specs: `envs: SPECS_DIR ? ['VERGIS_SPECS_DIR'] : ['VERGIS_SPECS']`, `reloads: 'specs: rebuild del descubrimiento + re-verificación por-PI (fabric)'`
   - policies: `envs: ['VERGIS_POLICIES']`, `reloads: 'gobierno completo: políticas (validate-before-swap) + rebuild specs + re-verificación'`
   - dominio: `envs` según qué archivos existan (`VERGIS_CONNECTIONS`/`VERGIS_DOMAINS`/`VERGIS_INTAKE`), `reloads: 'gobierno completo (conexiones + dominios + slots) + re-verificación'`
4. Junto al `process.on('SIGHUP', ...)` (~1643): `contract.signal({ signal: 'SIGHUP', action: 'fuerza la recarga completa de gobierno (equivale a watch:policies)' })`.
5. En `reloadGovernance` (éxito, ~1604) y en el watcher de specs (~1626): `contract.record({ reason, ok, policies: store.size, servablePis: discover().length }, artifacts)` con los artefactos del caso (policies: cada ruta de `POLICY_PATHS`; dominio: los archivos de `domainGovTargets`; specs: los `specPath` de `discover()`). En fallo: `record({ reason, ok: false, error })` sin artefactos (lo vigente se conserva — el contrato lo refleja porque los artefactos previos no se reemplazan).
6. En el boot (tras el primer `loadPolicyStoreInto`/descubrimiento): `contract.record({ reason: 'boot', ok: true, ... }, todosLosArtefactos)`.
7. Caveats colocados: donde se computan las `injections` de fabric (~316-324): `contract.caveat('las inyecciones de claims del canal de serving se fijan al arranque: un claim NUEVO en una política requiere restart (work/045)')`; en el bloque clickhouse (BOUND/UNION_INJECTIONS ~264-267) el equivalente; en `reloadDomainGovernance`: `contract.caveat('un pool SQL ya abierto conserva las credenciales previas hasta reciclarse: un perfil de conexión cambiado aplica a conexiones futuras')`.
8. `routes.ts`: nueva dep opcional `getContract?: () => ((req, res) => Promise<boolean>) | null`; dispatch de `/contrato` **después** del gate de token y junto a los otros handlers de gestión (antes del gate `ready` — el contrato debe responder aunque el motor no haya verificado). Inyectarla en `createRequestHandler` (~serve-rls.ts:662) con `isAdmin: governance ? (email) => govStore.isAdmin(email) : null` — cuidado: `governance`/`govStore` se asignan en el bootstrap async del bloque de administración; usa un getter en call-time como hacen `getAdmin`/`getPiConfig`.

## Reglas duras

- **NO editar** `server/admin.ts` ni `server/healthz` (el bloque healthz de routes.ts queda idéntico).
- **NO tocar** contratos de packages/ (salvo importar `VERGIS_VERSION`, ya exportado).
- Ningún valor de env ni secreto en el payload ni en logs nuevos.
- El contrato jamás afecta el serving: cualquier error interno del registro se traga con log (`console.error`), nunca propaga a `reloadGovernance` ni al boot.

## Territorio

`server/contract.ts` (nuevo) · `server/serve-rls.ts` · `server/routes.ts` · `server/config.ts` · `tests/contract.test.ts` (nuevo) · `tests/routes.test.ts` o equivalente si necesita la dep nueva (busca el test existente del router). Nada más.

## Hecho cuando (todo verificable por comando)

1. `npm run typecheck` · `npm test` · `npm run build` verdes.
2. Test unitario del registry: watch registrado aparece en snapshot; `record` con artefacto → sha256 correcto del contenido escrito; reescribir el archivo sin `record` → `pending: true`; `env()`/`envKeys()`/`unknown` clasifican como se espera (incluye un `VERGIS_TYPO` en el envSource fake → `unknown`).
3. Test de integración por `createRequestHandler`: `/contrato` sin admin → 403; con admin (isAdmin fake true) → 200 JSON con `watches`, `reloads.last`, `artifacts`, `env`; POST → 405; sin governance (`isAdmin: null`) → 403.
4. **El escenario del issue**: en un test que arma registry + archivo real en tmpdir, se escribe una política, se llama `record` (simulando el watch), y el GET refleja el sha256 nuevo con `pending: false`; se reescribe sin `record` → `pending: true`. (El operador puede confirmar que el nodo tomó su archivo.)
5. La suite existente completa sigue verde (ningún comportamiento previo cambia; los reemplazos `process.env` → `contract.env` son transparentes).

## Entrega

Rama `feat/139-contrato-operativo` desde `main`. Commits en español, estilo del repo (`feat(contrato): …`), terminados en `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. NO pushees ni abras PR: el orquestador integra desde tu worktree. Reporta: qué cambiaste por archivo, resultados exactos de los tres gates, y cualquier divergencia con este diseño con su porqué.

---
• 🤖 Claude (Fable) · diseño del frente A · cluster 003
