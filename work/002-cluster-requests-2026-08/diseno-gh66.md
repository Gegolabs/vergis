# Diseño — issue #66 · `CredentialProvider`: puerto de credencial inyectable (passwordless-ready)

**Cluster:** `work/002-cluster-requests-2026-08` · Ola A · **Rol:** Fable diseña, Opus implementa.
**Issue:** Gegolabs/vergis#66 — «feat(auth): puerto de credencial (passwordless / workload identity) — reemplazar el clientSecret hardcodeado por un CredentialProvider inyectable».
**Repo:** `/Users/cesar/wworkspace/productos/vergis` (monorepo TS; workspaces `packages/*`; `server/`; tests vitest en `tests/`).
**Gates (el juez):** `npm run typecheck` && `npm test` && `npm run build` — más los tests nuevos de este diseño. Los flujos contra AAD/IMDS/Fabric REALES son **gate manual diferido** (ver §Gates manuales).

Este documento es autocontenido: el ejecutor no necesita la conversación que lo originó. Ante contradicción entre este doc y el texto del issue, **manda este doc** (las decisiones de abajo sellan lo que el issue dejaba abierto). Ante contradicción entre este doc y el código actual, manda este doc (es un cambio deliberado).

---

## ¿Qué problema se resuelve?

Hoy la autenticación contra Fabric es `client_credentials` con `clientSecret` explícito, cableado como **parámetro obligatorio** en cinco sitios:

1. `packages/capabilities/src/aad-token.ts` — `createTokenProvider(creds: SpCreds)` exige `clientSecret` (POST a AAD con `client_secret` en el body, línea 49).
2. `packages/capabilities/src/execute-sql-dwh.ts` — `SqlConnectionProfile.clientSecret: string` obligatorio; `authentication: { type: 'azure-active-directory-service-principal-secret', ... }` (líneas 10–17, 75–82).
3. `packages/capabilities/src/master-data-publish.ts` — ídem mssql (línea 92).
4. `packages/capabilities/src/master-data-store.ts` — ídem mssql (líneas 135–138).
5. `server/serve-rls.ts` — `createTokenProvider({ tenantId: sp.tenantId, clientId: sp.clientId, clientSecret: sp.clientSecret })` (línea 813).

Consecuencia: el secreto del SP debe materializarse en la VM (perfil JSON de `VERGIS_CONNECTIONS`), es de larga duración, hay que rotarlo, y ya se fugó una vez (incidente GH 2026-07-13). El pedido: **un puerto de credencial** — una sola fuente de token, implementaciones intercambiables (secret hoy; token federado / managed identity mañana) — sin que el secreto sea parte obligatoria del contrato.

## ¿Cuál es el flujo actual de credenciales? (verificado contra el código)

Dos caminos consumen la credencial del SP:

- **Camino REST (token bearer):** `createTokenProvider(SpCreds)` → `TokenProvider.getToken(scope): Promise<string>` con caché por scope + dedupe in-flight + margen 60 s. Consumidores: `intake-onelake.ts` (×4: `createOneLakeIntake`, `createOneLakeReader`, `createFabricJobs`, `createFabricJobStatus`) y `fabric-engine.ts` (×2: `createFabricScheduler`, engine client). El único constructor del provider real es `server/serve-rls.ts:813`, a partir del perfil `VERGIS_INTAKE_SP` de `VERGIS_CONNECTIONS`.
- **Camino SQL (driver mssql):** las 3 capabilities mssql arman `sql.config.authentication` inline desde el perfil, tipo `azure-active-directory-service-principal-secret`.

Los perfiles llegan por `VERGIS_CONNECTIONS` (JSON inline o ruta a archivo; `server/serve-rls.ts:183–197`), con hot-reload por swap in-place del record (línea 1280+). `packages/cli/src/main.ts`/`run.ts` cargan el mismo shape para el CLI. `server/deployment-check.ts:70–75` solo valida que el env sea JSON o ruta existente (no toca campos del perfil).

## ¿Qué está verificado y qué es conjetura? (Norma 6/7)

**Hechos verificados en este árbol (2026-08-06):**

- `mssql@12.5.4` y `tedious@19.2.1` instalados (`package-lock.json`). `@azure/identity@4.13.1` presente **solo como transitiva de tedious** (nadie del repo la importa; `aad-token.ts` lo documenta y `grep` lo confirma).
- tedious 19.2.1 acepta estos `authentication.type` (validación en `node_modules/tedious/lib/connection.js:302`): `default`, `ntlm`, **`token-credential`**, `azure-active-directory-password`, `azure-active-directory-access-token`, `azure-active-directory-msi-vm`, `azure-active-directory-msi-app-service`, `azure-active-directory-service-principal-secret`, `azure-active-directory-default`.
- El tipo `token-credential` exige `options.credential` que pase `isTokenCredential` de `@azure/core-auth` — **duck-typing**: objeto con método `getToken` (y sin `signRequest`, cualquier aridad sirve; verificado en `node_modules/@azure/core-auth/dist/commonjs/tokenCredential.js:29–39`). En el login federado, tedious llama `credentials.getToken(tokenScope)` donde `tokenScope = new URL('/.default', fedAuthInfoToken.spn)` — **el servidor SQL anuncia el scope** — y usa solo `tokenResponse.token` (chequeo de null aparte); `expiresOnTimestamp` no se usa en ese camino (`connection.js:2452–2500`).
- Los modos `msi-vm`, `default` y `service-principal-secret` de tedious delegan en `@azure/identity` (`ManagedIdentityCredential`, `DefaultAzureCredential`, `ClientSecretCredential`; `connection.js:2464–2480`).
- mssql 12.5.4 pasa `config.authentication` **tal cual** a tedious (`Object.assign(..., this.config.authentication)` en `node_modules/mssql/lib/tedious/connection-pool.js:19–37`) → cualquier tipo de tedious es alcanzable desde `sql.config`.
- Los tipos: `@types/mssql@12.3.0` define `authentication?: tds.ConnectionAuthentication`, y la unión de tedious **incluye** `TokenCredentialAuthentication` (`node_modules/tedious/lib/connection.d.ts:169–210`) → el camino `token-credential` typechequea sin casts.

**Conjeturas declaradas (no medidas en este árbol; su medición es el gate manual de §Gates manuales):**

- El contrato del IMDS de Azure (`GET http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=...`, header `Metadata: true`, respuesta `{access_token, expires_in}` con `expires_in` a veces string) — es el contrato documentado por Azure, **sin corrida propia**.
- Que un contenedor docker-compose en la VM Azure alcance `169.254.169.254` (link-local ruteada por el host) — **se asume**, verificación en la VM.
- Que Fabric acepte la Managed Identity de la VM como principal con permisos (el propio issue lo marca como matiz por-servicio) y que el SQL endpoint de Fabric complete el flujo `fedAuthInfo` → `token-credential` — **sin confirmar**.
- El flujo federado (`client_assertion` desde `AZURE_FEDERATED_TOKEN_FILE`) es el patrón estándar de workload identity federation (RFC 7521/7523 + AAD) — la forma del body espeja el flujo secret ya probado, pero **no hay corrida propia** contra AAD con assertion.

---

## Decisiones selladas

**D1 — El puerto.** `CredentialProvider` con dos métodos: `getToken(scope): Promise<{ token: string; expiresAt: number }>` (token bearer para cualquier scope AAD — OneLake, Fabric REST, y el scope que anuncie un SQL endpoint) y `sqlAuth(): SqlAuth` (el objeto `authentication` para mssql). *Racional:* los dos caminos reales del repo consumen credencial con dos formas distintas; el puerto las ofrece ambas desde **una** fuente de decisión. El retorno rico (`expiresAt`) es lo que necesita el adaptador TokenCredential; los consumidores REST toman `.token`.

**D2 — Cachea el puerto, no el caller.** La caché por scope + dedupe in-flight + margen de 60 s (mecanismo existente de `aad-token.ts`, ya testeado) vive **dentro** del provider, común a los tres modos. Los callers jamás cachean. *Racional:* es el diseño actual, correcto; el pool de tedious además llama `getToken` en cada conexión nueva → la caché lo vuelve barato.

**D3 — Selección por PERFIL, no por env global.** Cada perfil de `VERGIS_CONNECTIONS` gana un campo opcional `auth: 'secret' | 'federated' | 'imds'`. Ausente ⇒ `'secret'` (compatibilidad exacta con la config viva de la VM: los perfiles actuales no cambian ni un byte). **No** se introduce `VERGIS_AUTH_MODE` global. *Racional:* las credenciales ya viven por-perfil (`VERGIS_CONNECTIONS` soporta multi-SP, p. ej. `VERGIS_INTAKE_SP`); un knob global sería una segunda fuente de verdad que puede contradecir a los perfiles. Explícito > detección por presencia de envs: un modo que «se activa solo» porque apareció una variable es una sorpresa de seguridad; acá el modo se declara y lo que falla, falla con nombre.

**D4 — Integración mssql: el modo secret conserva el tipo nativo probado; los modos passwordless van por `token-credential`.**
- `auth: 'secret'` → `sqlAuth()` devuelve `{ type: 'azure-active-directory-service-principal-secret', options: { tenantId, clientId, clientSecret } }` — **idéntico al wire actual de producción**; cero riesgo de regresión en el default.
- `auth: 'federated' | 'imds'` → `sqlAuth()` devuelve `{ type: 'token-credential', options: { credential: <adaptador sobre este mismo provider> } }`. El adaptador satisface el duck-typing verificado y hace que **toda** adquisición de token (REST y SQL) fluya por el puerto: una sola caché, una sola implementación por modo.
- Se **descarta** usar `azure-active-directory-msi-vm` / `azure-active-directory-default` de tedious. *Racional:* delegan en `@azure/identity` (verificado), lo que partiría la adquisición en dos stacks (el nuestro para REST, el de Azure para SQL) con dos cachés y dos modos de fallo; y `DefaultAzureCredential` prueba fuentes en un orden opaco que contradice el fail-closed explícito de D3.

**D5 — CERO dependencias nuevas de producción; `@azure/identity` NO se justifica.** Ni se declara ni se importa (sigue transitiva de tedious, intocada). `federated` = POST `fetch` a `login.microsoftonline.com` con `client_assertion` (espejo del flujo secret existente, ±10 líneas); `imds` = GET `fetch` al IMDS (±20 líneas). *Racional:* el repo ya tiene el patrón fetch+caché+timeout probado en `aad-token.ts` (comentario de cabecera: «CAMINO ROBUSTO, CERO SUPPLY-CHAIN»); `@azure/identity` arrastra la familia msal para reemplazar ~30 líneas de HTTP plano. El costo real de la dep (superficie supply-chain en el camino de credenciales, precisamente) supera su beneficio.

**D6 — `TokenProvider`/`SpCreds`/`createTokenProvider` se RETIRAN; nace `TokenSource` para los consumidores REST.** Pre-launch, sin alias de deprecación. El puerto completo es `CredentialProvider`; los consumidores que solo necesitan bearer declaran la vista angosta `type TokenSource = Pick<CredentialProvider, 'getToken'>` (segregación de interfaz: los fakes de test no deben verse obligados a implementar `sqlAuth`). Los 6 call-sites REST pasan de `` `Bearer ${await tokens.getToken(S)}` `` a `` `Bearer ${(await tokens.getToken(S)).token}` ``.

**D7 — Fail-closed con validación EAGER y sin IO en construcción.** `credentialProviderFor(perfil)` valida el modo y sus campos **al construir** y lanza con mensaje que nombra etiqueta (database_ref), modo y campo faltante; no hace red ni disco al construir (el archivo federado se lee en cada adquisición, porque rota). `server/serve-rls.ts` valida TODOS los perfiles dentro de `parseConnections()` → un perfil irresoluble **aborta el arranque** con error claro (y en hot-reload cae en el catch existente del watcher, que loguea sin tumbar el proceso). Requisitos por modo: `secret` ⇒ `tenantId`+`clientId`+`clientSecret`; `federated` ⇒ `tenantId`+`clientId`+archivo resoluble (`federatedTokenFile` del perfil, o env `AZURE_FEDERATED_TOKEN_FILE`); `imds` ⇒ nada obligatorio (`clientId` opcional para user-assigned MI).

**D8 — Home del puerto: `aad-token.ts` se transforma, no se duplica.** El puerto, los tres modos, el adaptador TokenCredential y la factory viven en `packages/capabilities/src/aad-token.ts` (el nombre sigue siendo veraz: los tres modos emiten tokens de AAD/Entra; otra nube sería otro archivo). *Racional:* la caché/dedupe ya vive ahí; un archivo nuevo solo movería código.

**D9 — Los endpoints de nube viven en las IMPLEMENTACIONES, no en el core.** `login.microsoftonline.com` e IMDS quedan dentro de los providers de `@vergis/capabilities` (capa adaptadora — donde hoy ya vive el endpoint AAD); el Botler/core y los specs no saben de nubes. Cumple el no-objetivo del issue.

---

## ¿Cuál es el contrato exacto del puerto?

En `packages/capabilities/src/aad-token.ts` (reemplaza el contenido actual conservando caché/dedupe/margen y los `SCOPE_*`):

```ts
import type { config as MssqlConfig } from 'mssql' // import type-only: se borra al compilar

/** Token de acceso vigente. `expiresAt` = epoch ms con el margen (60 s) YA descontado. */
export interface AccessToken {
  token: string
  expiresAt: number
}

/** El objeto `authentication` del driver mssql (unión de tedious; incluye 'token-credential'). */
export type SqlAuth = NonNullable<MssqlConfig['authentication']>

/**
 * PUERTO de credencial (issue #66): una sola fuente de token, implementaciones intercambiables.
 * `getToken` sirve cualquier scope AAD (OneLake, Fabric REST, o el scope que anuncie un SQL
 * endpoint vía fedAuthInfo). `sqlAuth` entrega la config de auth del driver mssql.
 * El provider CACHEA por scope (dedupe in-flight, margen 60 s); los callers no cachean.
 */
export interface CredentialProvider {
  getToken(scope: string): Promise<AccessToken>
  sqlAuth(): SqlAuth
}

/** Vista angosta para consumidores que solo necesitan bearer (intake, jobs, engine). */
export type TokenSource = Pick<CredentialProvider, 'getToken'>

export type AuthMode = 'secret' | 'federated' | 'imds'

/** Campos de credencial de un perfil. `auth` ausente ⇒ 'secret' (compat con la config viva). */
export interface CredentialSource {
  auth?: AuthMode
  tenantId?: string
  clientId?: string
  clientSecret?: string
  /** Modo federated: ruta del archivo con el token OIDC (default: env AZURE_FEDERATED_TOKEN_FILE). */
  federatedTokenFile?: string
}

export interface CredentialProviderOpts {
  fetch?: typeof fetch
  now?: () => number
  /** Lectura del archivo federado (inyectable en tests). Default: node:fs/promises readFile utf8. */
  readFile?: (path: string) => Promise<string>
  /** Env para resolver AZURE_FEDERATED_TOKEN_FILE (inyectable). Default: process.env. */
  env?: Record<string, string | undefined>
  /** Etiqueta para mensajes de error (p. ej. "database_ref 'dwh'"). */
  label?: string
}

export function resolveAuthMode(src: CredentialSource): AuthMode // src.auth ?? 'secret'; lanza si auth es un string desconocido

export function credentialProviderFor(src: CredentialSource, opts?: CredentialProviderOpts): CredentialProvider

export const SCOPE_ONELAKE = 'https://storage.azure.com/.default' // se conserva
export const SCOPE_FABRIC = 'https://api.fabric.microsoft.com/.default' // se conserva
```

Notas de implementación vinculantes:

- **Estructura interna:** un núcleo `cachingProvider(acquire: (scope) => Promise<AccessToken>, sqlAuth: () => SqlAuth, opts)` que porta la caché por scope + `inflight` + `.finally` **tal como está hoy** (incluido el comentario de la estampida), y tres `acquire` según el modo. La validación de campos ocurre en `credentialProviderFor` ANTES de crear el provider; mensajes: `` `credencial${label ? ` (${label})` : ''}: modo '<modo>' requiere <campo>.` `` — jamás imprimir valores de secretos.
- **Modo `secret`** (default): el `fetchToken` actual (POST `client_credentials` + `client_secret`), retornando `AccessToken` en vez de string.
- **Modo `federated`:** mismo endpoint `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/token`, body `grant_type=client_credentials`, `client_id`, `scope`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, `client_assertion=<contenido del archivo, .trim()>`. El archivo se **re-lee en cada adquisición** (rota); si no existe o está vacío al adquirir → error accionable con la ruta. Timeout 15 s como hoy.
- **Modo `imds`:** `GET http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=<resource>[&client_id=<clientId>]` con header `Metadata: 'true'` y timeout 15 s. `resource` = scope sin el sufijo `.default` conservando la barra: `scope.endsWith('/.default') ? scope.slice(0, scope.length - '.default'.length) : scope` (p. ej. `https://storage.azure.com/.default` → `https://storage.azure.com/`). Respuesta `{ access_token, expires_in }` con `expires_in` posiblemente string → `Number(...)`; si no es finito, usar 3600. La URL/host NO son configurables por perfil (IMDS es fijo por contrato de la nube); `fetch` inyectable cubre los tests.
- **`sqlAuth()`:** modo secret → objeto `azure-active-directory-service-principal-secret` con los tres campos; modos federated/imds → `{ type: 'token-credential', options: { credential } }` donde `credential` es:

```ts
// Adaptador al duck-type TokenCredential de @azure/core-auth (verificado: solo exige getToken;
// tedious usa únicamente `.token` del resultado). NO se importa @azure/identity ni @azure/core-auth.
const credential = {
  getToken: async (scopes: string | string[]) => {
    const scope = Array.isArray(scopes) ? scopes[0] : scopes
    const t = await provider.getToken(scope) // ← misma caché del puerto
    return { token: t.token, expiresOnTimestamp: t.expiresAt }
  },
}
```

  La asignabilidad a `TokenCredentialAuthentication` de tedious la dictamina `npm run typecheck` (los tipos instalados la incluyen — verificado).

## ¿Cómo migran los cinco sitios (y los consumidores REST)?

### T1 — `packages/capabilities/src/aad-token.ts`: el puerto y los tres modos

Reescribir según el contrato de arriba. Retirar `SpCreds`, `TokenProvider` (string) y `createTokenProvider`. Conservar `SCOPE_ONELAKE`/`SCOPE_FABRIC` y el mecanismo de caché.

**Hecho cuando:** `npx vitest run tests/credential-provider.test.ts` verde (ver T6) y `npm run typecheck` verde en el workspace.

### T2 — Perfiles y las 3 capabilities mssql

En `execute-sql-dwh.ts`:

```ts
import { credentialProviderFor, type CredentialSource } from './aad-token'

export interface SqlConnectionProfile extends CredentialSource {
  server: string
  database: string
  port?: number
}
```

(tenantId/clientId/clientSecret pasan a opcionales vía `CredentialSource`; el shape JSON existente sigue parseando igual). En los `getPool` de `execute-sql-dwh.ts`, `master-data-publish.ts` y `master-data-store.ts`, reemplazar el bloque `authentication: { type: 'azure-active-directory-service-principal-secret', ... }` por:

```ts
const provider = credentialProviderFor(profile, { label: `database_ref '${ref}'` }) // lanza claro si el perfil no resuelve
// ...
authentication: provider.sqlAuth(),
```

El provider se crea junto al pool (una vez por ref, mismo ciclo de vida — el pool map ya cachea por ref). No cambiar nada más de esos archivos (pools, evicción, binds, planes: intactos).

**Hecho cuando:** `npm run typecheck` verde; `npx vitest run tests/execute-sql-dwh-failclosed.test.ts` verde (T6); `npx vitest run tests/master-data-publish-plan.test.ts tests/master-data.test.ts hot-reload` sigue verde.

### T3 — Consumidores REST: `intake-onelake.ts` y `fabric-engine.ts`

Cambiar la firma de los 6 factories de `tokens: TokenProvider` a `tokens: TokenSource`, y los 6 call-sites (`intake-onelake.ts:43,113,192,231`; `fabric-engine.ts:63,98`) a extraer `.token`:

```ts
const { token } = await tokens.getToken(SCOPE_FABRIC)
```

**Hecho cuando:** `npx vitest run tests/intake-onelake.test.ts tests/frescura-frente-b.test.ts` verde con los fakes actualizados (T6).

### T4 — `packages/capabilities/src/index.ts`: exports

Retirar `createTokenProvider`, `TokenProvider`, `SpCreds`. Exportar: `credentialProviderFor`, `resolveAuthMode`, y los tipos `CredentialProvider`, `TokenSource`, `AccessToken`, `AuthMode`, `CredentialSource`, `SqlAuth`. Conservar `SCOPE_ONELAKE`, `SCOPE_FABRIC`, `SqlConnectionProfile`.

**Hecho cuando:** `npm run typecheck` y `npm run build` verdes en todo el monorepo (el build detecta cualquier import huérfano en `server/` y `packages/cli`).

### T5 — `server/serve-rls.ts`: wiring y validación eager

1. Import: `credentialProviderFor` en lugar de `createTokenProvider`.
2. Línea ~813: `const tokens = credentialProviderFor(sp, { label: `database_ref '${ref}'` })` — pasa el **perfil entero** (ya es `CredentialSource`); `tokens` satisface `TokenSource` estructuralmente para `createOneLakeIntake`/`createFabricJobs`/`createFabricJobStatus`/`createOneLakeReader`/`createFabricEngineClient`.
3. En `parseConnections()` (línea ~188), tras el parseo y la validación de shape, validar TODOS los perfiles: `for (const [ref, p] of Object.entries(parsed)) credentialProviderFor(p, { label: `database_ref '${ref}'` })`. Al arranque en frío eso aborta con el error claro (fail-closed); en hot-reload, `reloadDomainGovernance` YA envuelve `parseConnections()` en try/catch y conserva los perfiles vigentes logueando el error (verificado: `serve-rls.ts:1281–1291`) — no hay que añadir manejo alguno.

**Regla dura de compatibilidad:** un `VERGIS_CONNECTIONS` actual (perfiles con `tenantId`+`clientId`+`clientSecret`, sin campo `auth`) debe arrancar EXACTAMENTE igual que hoy — mismo modo, mismo tipo de auth mssql en el wire. Cualquier cambio de comportamiento con la config vieja es un bug de esta tarea.

**Hecho cuando:** `npx vitest run tests/serve-rls.test.ts tests/deployment-check.test.ts` verde; `npm run typecheck` && `npm test` && `npm run build` verdes completos.

### T6 — Tests (vitest, provider fake — sin red)

1. **`tests/credential-provider.test.ts`** (nuevo; sustituye y absorbe `tests/aad-token.test.ts`, que se elimina):
   - *secret:* migrar los 3 casos existentes (body `client_credentials`+`client_id`+`scope`; caché por scope y refetch tras TTL; error HTTP → throw accionable con status) al retorno `AccessToken`.
   - *federated:* con `readFile` y `fetch` fakes — el body lleva `client_assertion_type=urn%3A...jwt-bearer` y `client_assertion=<token del archivo>` y NO lleva `client_secret`; el archivo se re-lee en la segunda adquisición (tras expirar el TTL, con `readFile` devolviendo otro contenido, el body cambia); archivo vacío al adquirir → throw con la ruta.
   - *imds:* con `fetch` fake — URL contiene `169.254.169.254/metadata/identity/oauth2/token`, `api-version=2018-02-01` y `resource=https%3A%2F%2Fstorage.azure.com%2F` (derivación del scope verificada); header `Metadata: 'true'`; `client_id` presente solo si el perfil lo trae; `expires_in: '3600'` (string) parsea bien.
   - *selección y fail-closed:* perfil sin `auth` y con secret → modo secret; sin `auth` y sin `clientSecret` → throw nombrando `label`, modo y campo; `auth: 'imds'` sin tenant/clientId/secret → construye OK; `auth: 'zzz'` → throw.
   - *sqlAuth:* modo secret → deep-equal con el objeto `azure-active-directory-service-principal-secret` actual; modo imds → `type === 'token-credential'` y `options.credential.getToken('https://database.windows.net/.default')` (y también con array `['...']`) resuelve `{ token, expiresOnTimestamp }` coherente con el `fetch` fake — probando que puentea a la MISMA caché (dos llamadas ⇒ un solo fetch).
2. **`tests/execute-sql-dwh-failclosed.test.ts`** (nuevo): `createExecuteSqlDwh({ ref: { server, database } })` → `execute({database_ref:'ref', sql:'SELECT 1'})` **rechaza** con mensaje que nombra el ref y el campo faltante, SIN intentar red (el throw ocurre al construir el provider, antes del `connect()`).
3. **Fakes existentes:** en `tests/intake-onelake.test.ts` y `tests/frescura-frente-b.test.ts`, `const tokens: TokenSource = { getToken: async () => ({ token: 'BEARER123', expiresAt: Number.MAX_SAFE_INTEGER }) }`.

**Hecho cuando:** `npm test` verde completo.

### T7 — Nota de release / config

Añadir al doc de despliegue que ya documente `VERGIS_CONNECTIONS` (buscar con `grep -rl "VERGIS_CONNECTIONS" docs/ README* deploy/ 2>/dev/null`; si no existe ninguno, dejar la nota como comentario del perfil en `server/serve-rls.ts:183` ampliando el existente): el campo `auth: secret|federated|imds` por perfil, defaults, campos por modo, y que la config existente no requiere migración. No crear archivos de docs nuevos.

**Hecho cuando:** el texto existe en un artefacto ya versionado y `npm run build` sigue verde.

## ¿Cuál es el territorio exacto?

| Archivo | Cambio |
|---|---|
| `packages/capabilities/src/aad-token.ts` | reescritura: puerto + 3 modos + adaptador + factory (T1) |
| `packages/capabilities/src/execute-sql-dwh.ts` | perfil `extends CredentialSource`; `sqlAuth()` (T2) |
| `packages/capabilities/src/master-data-publish.ts` | `sqlAuth()` (T2) |
| `packages/capabilities/src/master-data-store.ts` | `sqlAuth()` (T2) |
| `packages/capabilities/src/intake-onelake.ts` | `TokenSource` + `.token` ×4 (T3) |
| `packages/capabilities/src/fabric-engine.ts` | `TokenSource` + `.token` ×2 (T3) |
| `packages/capabilities/src/index.ts` | exports (T4) |
| `server/serve-rls.ts` | wiring 813 + validación en `parseConnections` (T5) |
| `tests/credential-provider.test.ts` (nuevo), `tests/execute-sql-dwh-failclosed.test.ts` (nuevo), `tests/aad-token.test.ts` (se elimina), `tests/intake-onelake.test.ts`, `tests/frescura-frente-b.test.ts` | T6 |
| Doc/comentario de despliegue (T7) | nota de release |

**Intocables:** `packages/cli/src/*` (el tipo relajado compila sin cambios; si typecheck lo exigiera, el cambio mínimo de tipo es legítimo, nada más), `server/admin.ts` (además: el cyber-safeguard corta su revisión — no abrirlo), `server/config.ts` (territorio del issue #117 en esta misma ola — NO tocar para evitar colisión), `package.json`/`package-lock.json` (CERO deps nuevas — si crees necesitar una, detente: violación de D5), la lógica de pools/binds/planes de las capabilities mssql, y todo `packages/policy`, `packages/botler`, `engines/`.

**Autoridad:** el ejecutor decide nombres internos, orden de helpers y redacción de mensajes de error (registrándolo en el commit). Consulta antes de: cambiar la forma del puerto (D1), añadir deps (D5), tocar archivos fuera del territorio. Exclusivo del humano: los gates manuales y el deploy a la VM.

## ¿Qué pasa fail-closed si no hay credencial?

- Perfil irresoluble en `VERGIS_CONNECTIONS` (p. ej. sin `clientSecret` y sin `auth`) → **el arranque aborta** con `credencial (database_ref 'X'): modo 'secret' requiere clientSecret.` — igual de ruidoso que hoy `engine=fabric` sin `VERGIS_CONNECTIONS`.
- En hot-reload, el mismo error se loguea y el swap no ocurre (la config anterior sigue viva) — un reload malo no tumba el servidor.
- En runtime, archivo federado ausente/vacío o IMDS inalcanzable → el error sube por el camino existente de cada capability (los callers ya manejan rechazos de `getToken`/`connect`); nunca hay fallback silencioso entre modos.

## ¿Cuáles son los gates manuales diferidos? (no bloquean el merge; se declaran)

Estos NO los cubre vitest y quedan para el hand-off de despliegue (runbook `mira-ops`), como verificación por-servicio que el propio issue reserva:

1. **Regresión secret real:** deploy con la config actual de la VM → smoke de PI + intake (debe ser indistinguible de hoy).
2. **IMDS desde compose:** en la VM Azure con MI habilitada, `curl -H 'Metadata: true' 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://storage.azure.com/'` **desde dentro del contenedor**.
3. **Fabric acepta la MI:** la MI agregada al workspace con permisos; query T-SQL vía el modo `imds` (ejercita el camino `fedAuthInfo` → `token-credential` en vivo) y una escritura OneLake.
4. **Federated (solo si un despliegue lo adopta):** token file montado + adquisición real.

## ¿Cuáles son los riesgos?

1. **`token-credential` vivo contra Fabric no está medido** — mitigado: confinado a los modos nuevos; el default de producción no cambia de wire (D4); gate manual 3 lo mide antes de activar `imds` en la VM.
2. **IMDS desde bridge de docker es conjetura** — si no rutea, el plan-B del issue (KV en arranque) sigue disponible sin tocar este diseño; gate manual 2 lo decide.
3. **Colisión de ola:** #117 toca la carga de config y #66 toca `parseConnections` de `serve-rls.ts` — el orquestador integra secuencialmente; este diseño NO toca `server/config.ts` justamente por eso.
4. **Ripple de la firma** (`TokenProvider`→`TokenSource`, string→`AccessToken`) — acotado y enumerado (6 call-sites + 2 fakes); el typecheck del monorepo es el detector exhaustivo.
5. **Conexiones longevas del pool no re-autentican** — el TDS session vive más que el token; es el comportamiento actual con SP-secret (tedious también adquiere por conexión) → sin cambio de exposición.
6. **Hot-reload de un perfil no rota el provider de un pool ya creado** — limitación preexistente (el pool por ref tampoco se recrea); fuera de alcance, no se empeora.

## ¿Quién dictamina?

`npm run typecheck` && `npm test` && `npm run build` verdes sobre la integración (serializados por el orquestador), con T1–T6 cumpliendo su «hecho cuando». Los gates manuales de arriba quedan como checklist del hand-off de deploy — el merge no los espera, la activación de un modo passwordless en la VM sí.

**Orden:** T1 → (T2 ∥ T3) → T4 → T5 → T6 → T7. Un solo subagente Opus; no hay paralelismo interno que justifique partirlo.
