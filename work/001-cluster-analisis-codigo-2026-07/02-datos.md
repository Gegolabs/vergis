# Frente 02 · Capabilities de datos

**Ámbito:** `packages/capabilities/src/` — clickhouse-store, governance-store, master-data(-store/-publish), annotation-store, sqlite, execute-sql-ch/dwh, fabric-engine, aad-token, intake(-onelake), freshness, ingestion-observability, domain, pi-authz, static-data, admin-roles, index.

---

## Tanda Opus 4.8 — concluida

### Severidad ALTA

**1. [ALTA] · robustez — `execute-sql-dwh.ts:87-89` (y `master-data-store.ts:143-145`, `master-data-publish.ts:49-59`)**
Caché de pool envenenada: `getPool` guarda en el `Map` la *promesa* de `new sql.ConnectionPool(cfg).connect()` sin `.catch` que la retire si rechaza. Un fallo transitorio en la primera conexión (blip de red/AAD) deja la promesa rechazada cacheada para siempre: **toda query posterior a ese `database_ref` falla hasta reiniciar el proceso**. Verificado: ninguno de los tres módulos limpia la entrada en fallo.
*Mejora:* `created.catch(() => pools.delete(ref))` antes de cachear (o cachear el pool, no la promesa). Esfuerzo **S** (idéntico en los 3 archivos).

**2. [ALTA] · robustez — `sqlite.ts:37-41` (afecta governance-store, admin-roles, master-data-store; duplicado en `annotation-store.ts:70-74`)**
`persistSqliteDb` hace `writeFileSync(file, db.export())` directo sobre el archivo destino, y se invoca en **cada** escritura. Un crash/OOM/disco-lleno a mitad de write deja el archivo truncado; en el próximo arranque `new SQL.Database(bytes)` lanza y el store de gobierno (admins, ACLs de PI, grupos) queda irrecuperable — no hay WAL ni respaldo. Es exactamente el archivo que gobierna el acceso de toda la plataforma.
*Mejora:* escribir a `${file}.tmp` + `renameSync` (atómico en el mismo FS); opcionalmente conservar un `.bak` de la versión previa. Esfuerzo **S**.

### Severidad MEDIA

**3. [MEDIA] · corrección — `governance-store.ts:476-478` vs `freshness.ts:20-23`**
`setDemanda` valida con un regex propio que **acepta `'PT'`** (verificado: el regex matchea y solo se excluye `'P'`), pero `durationToSeconds('PT')` lanza. Un colaborador que guarda `PT` deja un valor almacenado que revienta después en `deriveEntityFreshness`/`deriveIngestionMap` → la vista de Frescura da 500 hasta editar a mano. Además los dos validadores driftean (`setDemanda` rechaza `P1W2D` que `durationToSeconds` acepta; ambos aceptan `P0D`).
*Mejora:* eliminar el regex de `setDemanda` y validar con `durationToSeconds` (exigiendo `> 0`), como ya hace `upsertSource`. Esfuerzo **S**.

**4. [MEDIA] · seguridad — `governance-store.ts:319-324`**
`deleteGroup` borra `mira_group_member` y `mira_group` pero **no** los `pi_grant` con `principal_type='group'` de ese grupo. Los grants quedan colgando y, si un admin recrea un grupo con el mismo id, sus nuevos miembros **heredan silenciosamente los accesos del grupo anterior**. Análogo menor: `deleteSource` (510) deja filas huérfanas en `table_source`.
*Mejora:* en `deleteGroup`, `DELETE FROM pi_grant WHERE principal_type='group' AND principal=?`; limpiar `table_source` en `deleteSource`. Esfuerzo **S**.

**5. [MEDIA] · seguridad — `clickhouse-store.ts:93-96`**
El usuario data-plane se crea `IDENTIFIED WITH no_password`. Los claims `vergis_claim_*` son settings normales que el propio usuario puede fijar por query; por tanto **cualquiera con alcance de red al puerto HTTP de ClickHouse puede conectarse como `botler` sin credencial y auto-asignarse claims → bypass total de la RLS**. *Supuesto de despliegue:* ClickHouse solo alcanzable por la red interna de compose — la seguridad descansa 100% en esa aislación. Secundario: `CREATE USER IF NOT EXISTS` congela los `SETTINGS` de la primera creación.
*Mejora:* `IDENTIFIED BY` con password desde env (ya existe `password?` en `ClickHouseProfile`), y `ALTER USER ... SETTINGS` en el re-bootstrap. Esfuerzo **M**.

**6. [MEDIA] · corrección — `intake-onelake.ts:25-39` + `intake.ts:124-137`**
El filename viaja al URL DFS con `encodeURI`, que **no escapa `#` ni `?`**, y `validateUpload` solo rechaza `/` y `\`. Verificado: `reporte #3.xlsx` produce path truncado con fragmento; con `?` en el nombre se inyectan query params arbitrarios en una request autenticada con el token del SP.
*Mejora:* `encodeURIComponent(filename)` (y por segmento en `target.path`), más rechazo de `#?%` en `validateUpload`. Esfuerzo **S**.

**7. [MEDIA] · corrección — `master-data-store.ts:172-180`**
El contrato dice «Inserta una fila. Falla si la PK ya existe» y la impl. SQLite lo cumple, pero `createDwhMasterDataStore.insert` no chequea existencia. *Inferido:* Fabric Warehouse declara PKs `NOT ENFORCED`, así que el INSERT duplicado **no falla → filas duplicadas en la fuente única**. `update` tampoco distingue "no existe": dos impls de la misma interfaz con semánticas distintas.
*Mejora:* en la impl. DWH, `SELECT 1 ... WHERE pk=@pk` antes del INSERT/UPDATE y lanzar `MasterDataConflict`. Esfuerzo **S**.

**8. [MEDIA] · robustez — `master-data-publish.ts:69-89`**
`publish` es DROP → CREATE → INSERT fila-a-fila → recrear policy, **sin transacción ni staging**: durante la publicación los consumidores ven la réplica ausente/parcial, y si un INSERT falla a mitad la réplica queda **destruida hasta la próxima publicación exitosa**. Además usa `VarChar` mientras la autoría bindea `NVarChar` (posible pérdida de caracteres no-Latin).
*Mejora:* publicar a `md_<id>__replica_new` y swap; `NVARCHAR(400)` y validar longitud en `coerceValue`. Esfuerzo **M**.

**9. [MEDIA] · robustez — `aad-token.ts:48`, `intake-onelake.ts:44-56/81/120`, `fabric-engine.ts:62/103`, `clickhouse-store.ts:31`**
Ninguna de estas llamadas `fetch` tiene timeout ni `AbortSignal`. Un cuelgue de AAD/OneLake/Fabric deja la request del admin colgada indefinidamente; el token provider tampoco deduplica llamadas concurrentes al mismo scope.
*Mejora:* `AbortSignal.timeout(30_000)` en cada fetch y cachear la promesa in-flight en `getToken`. Esfuerzo **S/M**.

**10. [MEDIA] · corrección — `governance-store.ts:241-277`**
La semilla se re-aplica en cada `open()`: los miembros de grupos semilla borrados con `removeMember` **reaparecen en el próximo restart** (`ON CONFLICT DO NOTHING` re-inserta al ausente), y `label`/`oferta` de fuentes editadas se sobreescriben con config. Para admins la tensión está resuelta (flag `seed`); para grupos/fuentes la reversión es silenciosa.
*Mejora:* marcar miembros semilla como no-removibles, o insertarlos solo al crear el grupo por primera vez. Documentar precedencia. Esfuerzo **M**.

### Severidad BAJA

**11. [BAJA] · corrección — `execute-sql-dwh.ts:113-117`** — Bind params numéricos van siempre como `sql.BigInt`; un valor no entero (motor B admite `Float64`) fallaría/truncaría. `Number.isInteger(v) ? sql.BigInt : sql.Float`. **S**

**12. [BAJA] · corrección — `governance-store.ts:406-410`** — `setVisibility` es un UPDATE que no verifica que el PI exista: no-op silencioso sobre PI no bootstrapeado. Verificar filas afectadas o `getPiGovernance` previo. **S**

**13. [BAJA] · seguridad — `clickhouse-store.ts:41` + `:124-128`** — El error de `chExec` incluye `SQL: ${sql.slice(0,200)}`; en la ingesta el SQL contiene el NDJSON de las filas → filtra registros (potencial PII) al log. Además identificadores interpolados al DDL sin validación (a diferencia de `master-data.ts` con `IDENT_RE`). Omitir el SQL en errores de INSERT; validar identificadores. **S**

**14. [BAJA] · robustez — `clickhouse-store.ts:124-128`** — Full-replace `TRUNCATE`→`INSERT` no atómico: ventana de 0 filas, y si el INSERT falla el store queda vacío. Ingerir a `_staging` + `EXCHANGE TABLES`. **M**

**15. [BAJA] · estructura — `annotation-store.ts:31-74` vs `sqlite.ts`** — Duplica `openSqliteDb`/`persistSqliteDb` y tipos que ya viven en `sqlite.ts` (con cast `as unknown as {...}` en :79). Importar de `./sqlite`. **S**

**16. [BAJA] · estructura — `execute-sql-dwh.ts:64-90`, `master-data-store.ts:126-146`, `master-data-publish.ts:44-60`** — Fábrica de pools mssql copiada tres veces con drift visible (`requestTimeout` 60s vs 120s). Extraer `createMssqlPoolFactory(profiles)`. **S/M**

**17. [BAJA] · rendimiento — `governance-store.ts:527-535` y `ingestion-observability.ts:86-88`** — `ofertasForTables` prepara el mismo statement dentro del loop; `freshnessAlerts` llama `classifyProcess` dos veces por proceso. Limpieza. **S**

**18. [BAJA] · corrección — `intake-onelake.ts:126-134`** — `listInstances` no pagina; con `startTimeUtc` ausente ordena con `Date.parse('')=NaN`. *Supuesto:* la API devuelve más-reciente-primero (lo mitiga hoy). **S**

### Evaluación general (Opus)

Subsistema en buen estado: arquitectura de costuras consistente, parametrización SQL disciplinada en las tres bases, authz genuinamente fail-closed. Lo que queda se concentra en **crash-consistency y resiliencia de I/O** (hallazgos 1, 2, 9 — baratos y de alto retorno) y **contratos que driftean entre implementaciones gemelas** (validadores de duración, semántica de insert, tres copias de la fábrica de pools). Ningún hallazgo invalida el diseño; casi todos esfuerzo S. Riesgo residual: los hallazgos 5 y 7 dependen de supuestos de despliegue (aislación de red de ClickHouse; PKs `NOT ENFORCED` en Fabric) que conviene confirmar contra el ambiente real.

---

## Segunda corrida — Opus 4.8 (el override a Fable no surtió efecto)

> El parámetro `model: "fable"` **no fue honrado** por el harness: este segundo pase corrió otra vez en Opus 4.8 (confirmado porque el agente hermano de admin/multipart volvió a chocar con el *safeguard de ciberseguridad de Opus*). No es contraste de motor Fable vs Opus, sino una **segunda opinión independiente en el mismo motor** — útil para ver qué hallazgos son estables entre corridas y cuáles aparecen solo en una.

He leído completos los 20 archivos del ámbito y verifiqué los puntos de uso en `server/admin.ts` y `server/serve-rls.ts`. Estos son los hallazgos que realmente quedan, verificados contra el código.

---

# Revisión senior — capabilities de datos y stores (`packages/capabilities/src/`)

**Supuestos de despliegue marcados honestamente:**
- (S1) El servidor corre como **proceso único** contra los archivos SQLite (así lo hace `server/serve-rls.ts:663`); los hallazgos multi-proceso están calibrados con eso.
- (S2) La autoría de master-data en producción vive en **Fabric Warehouse**, donde las PRIMARY KEY son `NOT ENFORCED` (el perfil dice "Fabric SQL endpoint o Azure SQL"; en Azure SQL puro el riesgo de duplicados baja).

---

## Severidad ALTA

**1. [ALTA] · Crash-consistency · `sqlite.ts:37-41` (y `annotation-store.ts:70-74`) · Escritura NO atómica del store de gobierno**
`persistSqliteDb` hace `writeFileSync(file, Buffer.from(db.export()))` directo sobre el archivo vigente. Un crash del proceso / OOM-kill / corte de energía a mitad de la escritura deja `governance.sqlite` **truncado o corrupto** — y ese archivo es el único registro de admins, ACLs de PI, grupos y demanda (el propio doc lo llama "el store ÚNICO del estado de gobierno"). No hay copia previa ni journal: el siguiente `openSqliteDb` cargará bytes corruptos. Como cada mutación (`add`, `setGrant`, `upsertSource`…) dispara un volcado completo, la ventana se abre en cada escritura.
**Mejora:** escribir a `${file}.tmp` + `renameSync` (rename es atómico en POSIX sobre el mismo filesystem); opcionalmente conservar `.bak` de la versión previa. Aplicarlo en `persistSqliteDb` cubre governance, admin y master-data; replicar en el `persist()` duplicado de `annotation-store.ts`. **Esfuerzo: S.**

**2. [ALTA] · Robustez · `execute-sql-dwh.ts:87-89`, `master-data-store.ts:143-145`, `master-data-publish.ts:49-59` · Caché de pool envenenada por fallo transitorio**
Las tres fábricas cachean la **Promise** de `new sql.ConnectionPool(cfg).connect()`. Si ese primer `connect()` rechaza (blip de red, AAD lento, DNS), la promesa **rechazada queda en el Map para siempre**: toda query futura a ese `database_ref` hace `await getPool(ref)` sobre la misma promesa muerta → outage permanente de esa capability hasta reiniciar el proceso. Es exactamente el patrón "cache the promise, forget the failure".
**Mejora:** `created.catch(() => pools.delete(ref))` justo después de `pools.set(ref, created)` (en las tres copias — o mejor, en la fábrica única del hallazgo 16). Considerar lo mismo si el pool emite `error` post-conexión. **Esfuerzo: S.**

**3. [ALTA] · Validación de input · `intake-onelake.ts:38` + `intake.ts:124-137` · Encoding del filename roto para `?`, `#` y sin bloqueo de `..`**
El write-path construye la URL DFS con `encodeURI(joinPath(target, filename))` — y `encodeURI` **no escapa `?`, `#`, `&`, `=`**. `validateUpload` solo rechaza `/` y `\` (intake.ts:127). Confirmado end-to-end: `server/admin.ts:387-398` pasa `u.filename` del multipart directo a `intake.put`. Consecuencias con nombres perfectamente subibles desde un browser:
- `informe #3.xlsx` → todo tras `#` se pierde y `?resource=file` deja de ser query → request DFS mal formada o archivo con nombre truncado.
- `saldos?recursive=true.xlsx` → **inyección de query-params en la API DFS** (el `?resource=file` del código queda detrás del `?` del filename).
- `..` como filename pasa la validación y `Files/intake/saldos/..` apunta al directorio padre.

**Mejora:** en `joinPath`/`put`, codificar con `encodeURIComponent` **por segmento** (path del target por segmentos + filename); en `validateUpload`, rechazar además `?`, `#`, `%`, caracteres de control, y los nombres `.`/`..`. **Esfuerzo: S.**

**4. [ALTA] · Contrato entre gemelas · `master-data-store.ts:72-81` vs `172-199` · La impl. DWH no honra el contrato de insert/update**
El contrato dice: `insert` "Falla si la PK ya existe" y `update` opera sobre una fila existente. La impl. SQLite lo cumple (`MasterDataConflict` en 75 y 85). La impl. DWH **no chequea nada**:
- `insert` confía en el constraint del motor — pero en Fabric Warehouse las PK son `NOT ENFORCED` (supuesto S2) → **duplicados silenciosos** en la fuente única de data maestra, que luego se replican a todos los targets.
- `update` de una PK inexistente es un **no-op silencioso** (0 filas afectadas, sin error), donde SQLite lanza `MasterDataConflict`. La UI de Administración desarrollada contra la gemela local asume el error.

**Mejora:** en la impl. DWH, `insert` con guard (`IF NOT EXISTS (SELECT 1 … WHERE pk=@pk) INSERT … ELSE THROW` o chequear `SELECT` previo y lanzar `MasterDataConflict`); `update` verificando `result.rowsAffected[0] === 0` → `MasterDataConflict`. **Esfuerzo: M.**

---

## Severidad MEDIA

**5. [MEDIA] · Validadores duplicados divergentes · `governance-store.ts:476` vs `freshness.ts:20-34` · `setDemanda` acepta `'PT'`, que revienta `durationToSeconds` después**
`setDemanda` valida con una regex propia en vez del `durationToSeconds` que el mismo archivo ya importa (línea 19) y usa para ofertas (línea 491). Divergencias verificadas:
- `'PT'` **pasa** la regex de `setDemanda` (todo el bloque tras `T` es opcional; solo `age === 'P'` está excluido) y se persiste — pero `durationToSeconds('PT')` **lanza** explícitamente (freshness.ts:23). Resultado: una demanda "válida" almacenada hace crashear `isDemandaWithinCeiling` / `deriveIngestionMap` / `deriveEntityFreshness` cuando procesan ese PI.
- `'P1W1D'` es válido para `durationToSeconds` pero la regex de `setDemanda` lo rechaza (la rama `\d+W` no admite combinaciones).
- `'P0D'` pasa ambas → demanda de 0 segundos permitida.

**Mejora:** eliminar la regex y validar con `durationToSeconds(age)` exigiendo resultado `> 0` (igual que `upsertSource`). **Esfuerzo: S.**

**6. [MEDIA] · Autorización / integridad referencial · `governance-store.ts:319-324, 510-513` · Borrar un grupo no limpia sus grants; borrar una fuente deja huérfanos**
`deleteGroup` borra `mira_group_member` y `mira_group` pero **no toca `pi_grant`**: los grants `principal_type='group'` del grupo eliminado quedan latentes. Si más adelante alguien crea un grupo nuevo con el mismo id (los ids son slugs cortos: `analistas`, etc.), sus miembros **heredan silenciosamente todos los accesos del grupo viejo** — escalada de acceso accidental. Análogo: `deleteSource` no limpia `table_source` ni los `ingestion_process.source_id` que la referencian (tablas que ya no aportan oferta → el techo de demanda desaparece sin aviso).
**Mejora:** en `deleteGroup`, `DELETE FROM pi_grant WHERE principal_type='group' AND principal=?`; en `deleteSource`, limpiar `table_source` (o rechazar el borrado si hay referencias, que es más honesto para gobierno). **Esfuerzo: S.**

**7. [MEDIA] · Autorización · `governance-store.ts:432-440` · `setGrant` puede degradar al último dueño (el anti-lockout solo vive en `removeGrant`)**
`removeGrant` protege al último owner (447-449), pero `setGrant(pi, 'user', <último-owner>, 'viewer')` hace el upsert sin ningún chequeo → PI sin ningún owner, ingobernable salvo por admin override. Es el mismo lockout que ya decidieron impedir, por la otra puerta.
**Mejora:** en `setGrant`, si el principal ya tiene rol `owner` y el nuevo rol es menor, aplicar el mismo guard de "último dueño". **Esfuerzo: S.**

**8. [MEDIA] · Robustez · `aad-token.ts:48`, `clickhouse-store.ts:31`, `intake-onelake.ts` (todos los fetch), `fabric-engine.ts:62,103` · Cero timeouts en llamadas de red**
Ninguno de estos `fetch` lleva `AbortSignal.timeout(...)` ni acepta señal del llamador (solo `execute-sql-ch`/`-dwh` honran el signal del Botler, y mssql tiene sus propios timeouts). Un peer colgado (AAD, ClickHouse, OneLake DFS, Fabric REST) bloquea indefinidamente: un upload de intake queda pegado en `flush`, el bootstrap de ClickHouse cuelga el arranque, un `getToken` colgado detiene todo lo que dependa del SP.
**Mejora:** default `signal: AbortSignal.timeout(N)` (p.ej. 15 s AAD, 30 s DFS/Fabric, 60 s ClickHouse), sobrescribible por opciones. **Esfuerzo: M** (repartido).

**9. [MEDIA] · Errores parciales · `master-data-publish.ts:69-89` · `publish` destructivo sin swap: un fallo a mitad deja la réplica rota para todos los PIs**
La secuencia es DROP POLICY → DROP FUNCTION → **DROP TABLE** → CREATE → INSERT fila a fila → CREATE POLICY. Cualquier fallo entre el DROP TABLE y el final (blip de red, timeout, una fila inválida) deja el target **sin réplica o con réplica parcial y sin policy** — y como `publish-on-write` corre tras cada edición, un fallo transitorio tumba el JOIN de todos los PIs consumidores hasta la próxima edición exitosa. No hay reintento ni rollback.
**Mejora:** construir en `md_<id>__replica_new`, poblar, crear policy, y hacer swap (`sp_rename` dentro de transacción, o `DROP`+`sp_rename` al final, ventana de milisegundos); o al menos envolver en transacción donde el motor lo permita. **Esfuerzo: M.**

**10. [MEDIA] · Errores parciales · `clickhouse-store.ts:124-128` · `TRUNCATE + INSERT`: un INSERT fallido deja el store servido en 0 filas, silenciosamente**
La ingesta full-replace trunca primero. Si el INSERT falla (o el proceso muere entre ambos), los consumidores ven **0 filas sin ninguna señal de error** — para un dashboard, indistinguible de "no hay datos". Además cada refresh tiene una ventana de vacío para lectores concurrentes. "Caché desechable" justifica perder el dato, no servir vacío como si fuera verdad.
**Mejora:** ingestar a una tabla staging y `EXCHANGE TABLES` (atómico en ClickHouse), que elimina ambas ventanas. **Esfuerzo: M.**

**11. [MEDIA] · Concurrencia entre procesos · `sqlite.ts:29-41` · El modelo load-at-open + full-file-write es last-writer-wins**
Cada instancia carga el archivo a memoria al abrir y vuelca su copia completa en cada persist. Dos procesos sobre el mismo archivo (el server + un script CLI tipo `scripts/admin-smoke.ts`, o dos réplicas del server sobre el mismo volumen) se **pisan escrituras completas** sin error. Bajo el supuesto S1 (proceso único) hoy no muerde, pero nada lo impide ni lo detecta.
**Mejora:** lockfile (`${file}.lock` con `wx`) al abrir con `file != null`, y fallar ruidoso si ya está tomado; documentar la restricción en el doc-comment del seam. **Esfuerzo: S.**

**12. [MEDIA] · Tokens AAD · `aad-token.ts:63-71` · Sin dedupe de adquisiciones concurrentes ni retry**
Al expirar el token, N requests simultáneas ven el miss y disparan N POSTs al endpoint OAuth (estampida; AAD aplica throttling por SP). Además un 429/5xx transitorio se propaga tal cual sin un solo reintento. El caché en sí está bien (no cachea fallos).
**Mejora:** cachear la **promesa** en vuelo por scope (`inflight: Map<string, Promise<CacheEntry>>`, limpiándola en `finally` — con cuidado de no reintroducir el hallazgo 2) + un retry con backoff para 429/5xx. **Esfuerzo: S.**

---

## Severidad BAJA

**13. [BAJA] · Corrección · `governance-store.ts:380-392, 442-452` · check-then-act con `await` intercalable**
`bootstrapPi` (`await getPiGovernance` → INSERT) y `removeGrant` (listGrants → DELETE) pueden intercalarse entre dos requests concurrentes del mismo proceso: dos `bootstrapPi` simultáneos → el segundo INSERT viola la PK y lanza (rompe la idempotencia prometida). **Mejora:** `INSERT OR IGNORE` en el INSERT de `pi_governance`; para el anti-lockout, un DELETE condicional (`DELETE ... WHERE NOT (role='owner' AND (SELECT COUNT(*) ...)=1)`). **Esfuerzo: S.**

**14. [BAJA] · Contrato · `governance-store.ts:406-410` vs `474-485` · `setVisibility` de un PI sin gobierno es no-op silencioso; `setDemanda` inserta sin gobierno**
UPDATE que afecta 0 filas no avisa; en cambio la demanda se puede fijar para un `pi_code` que no existe en `pi_governance`. Contratos inconsistentes entre operaciones hermanas. **Mejora:** en `setVisibility`, lanzar si no existía; en `setDemanda`, opcionalmente exigir gobierno previo. **Esfuerzo: S.**

**15. [BAJA] · Validación · `governance-store.ts:387-390, 432-438` · Grants a grupos inexistentes**
Ni `setGrant(…,'group',…)` ni los `defaultCollaboratorGroups` de `bootstrapPi` verifican `groupExists`. Un typo crea un grant inerte; combinado con el hallazgo 6, un grupo creado después con ese id lo hereda. **Mejora:** validar `groupExists(gid)` en ambos. **Esfuerzo: S.**

**16. [BAJA] · Estructura · `execute-sql-dwh.ts:64-90` ≈ `master-data-store.ts:126-146` ≈ `master-data-publish.ts:44-60` · Fábrica de pools mssql copiada 3 veces**
Misma config (SP secret, encrypt, puertos, timeouts) con variaciones mínimas (requestTimeout 60s vs 120s). Tres lugares que parchar para los hallazgos 2 y cualquier cambio de auth. **Mejora:** extraer `createMssqlPoolFactory(profiles, { requestTimeout })` (con el fix del hallazgo 2 incorporado una sola vez) y el `close()` común. **Esfuerzo: M.**

**17. [BAJA] · Estructura · `annotation-store.ts:31-36, 58-74, 116-122` · Reimplementa `sqlite.ts` completo**
Duplica `openSqliteDb`, `persist` y los tipos `SqlDb`/`SqlStmt` locales en vez de importar de `./sqlite` (que existe precisamente como base común y exporta lo mismo desde `index.ts:25-26`). Cualquier fix de persistencia (hallazgo 1) hay que hacerlo dos veces. **Mejora:** migrar a los helpers de `./sqlite`. **Esfuerzo: S.**

**18. [BAJA] · Rendimiento · `governance-store.ts:527-536` · `ofertasForTables` prepara el statement dentro del loop (N+1)**
Un `prepare` por tabla. **Mejora:** preparar una vez y `reset`+`bind` por iteración, o una sola query con `IN (…)` de placeholders. **Esfuerzo: S.** (Mismo patrón menor: `master-data-publish` inserta la réplica fila a fila con un round-trip por fila — aceptable para catálogos, pero `sql.Table`/bulk lo haría de un viaje.)

**19. [BAJA] · Corrección · `fabric-engine.ts:35` · `Math.round` puede agrandar el intervalo por encima de la cadencia requerida**
`secondsToIntervalMinutes(90) = 2 min > 90 s`: el schedule queda **menos frecuente** que lo requerido. El comentario declara el supuesto ("los redondeos coarse ya son múltiplos de 60"), pero la función es pública y el invariante correcto es redondear hacia abajo: `Math.max(1, Math.floor(seconds / 60))`. **Esfuerzo: S.**

**20. [BAJA] · Robustez · `clickhouse-store.ts:80-105` · Identificadores interpolados sin validar + regex frágil del nombre de policy**
`schema.database/table`, `role` y `user` se interpolan directo al DDL (vienen de config de deploy — confiable hoy, pero sin cinturón); y `rowPolicySQL.match(/CREATE ROW POLICY (\w+)/)` no matchea nombres con backticks/comillas → el DROP se salta y la policy vieja sobrevive un cambio de spec (el CREATE posterior puede fallar con "already exists" o, peor, convivir dos policies). **Mejora:** validar identificadores con `^[A-Za-z_][A-Za-z0-9_]*$` al entrar, y que `ClickHouseEnforcement` traiga el `policyName` estructurado en lugar de re-parsearlo del SQL. **Esfuerzo: S.**

**21. [BAJA] · Fuga de datos a logs · `clickhouse-store.ts:41` · El error de `chExec` incluye 200 chars del SQL — que en la ingesta son filas de datos**
Para el INSERT NDJSON, `SQL: ${sql.slice(0, 200)}` mete registros de negocio (Buk: datos de personas) en el mensaje de error → logs. **Mejora:** truncar antes del payload (`sql.split('\n')[0]`) o excluir el body en errores de INSERT. **Esfuerzo: S.**

**22. [BAJA] · Corrección de borde · `execute-sql-dwh.ts:113-117` · Params numéricos siempre `sql.BigInt`**
Un valor no entero del drill-through (`typeof v === 'number'` con 3.14) falla en la validación de mssql con un error críptico o se trunca según versión. **Mejora:** `Number.isInteger(v) ? sql.BigInt : sql.Float`. **Esfuerzo: S.**

**23. [BAJA] · Mantenibilidad · misceláneos**
`clickhouse-store.ts:128`: `chExec({ ...writer }, …)` — spread sin propósito. `execute-sql-dwh.ts:149`: cast `as Capability & { close(): Promise<void> }` — si el contrato `Capability` ya contempla `close` opcional en otros sitios, tiparlo en la interfaz y quitar el cast. `governance-store.ts:34` duplica el helper `now()` de `admin-roles.ts:37`. **Esfuerzo: S.**

---

## Evaluación general

El código está en buen estado para tres rondas de revisión: la historia de seguridad SQL es consistente y correcta en las tres bases (valores siempre bindeados en mssql y sql.js; claims como settings request-scoped en ClickHouse y `sp_set_session_context` parametrizado con reinyección completa en Fabric — el problema clásico de fuga por pool está bien neutralizado), el fail-closed de `pi-authz`/`admin-roles` es real (default-deny sin identidad, sin gobierno, o sin claim), los anti-lockout de admin están bien pensados, y la separación lógica-pura / costura-de-motor (freshness, ingestion-observability vs fabric-engine) es limpia y testeable.

Lo que queda se concentra en tres frentes que las rondas anteriores no cerraron: **(a) durabilidad y atomicidad** — la escritura no atómica del único archivo de gobierno (hallazgo 1) es el riesgo unitario más alto del paquete, con fix de una línea; los caminos destructivos sin swap (9, 10) son su eco en los stores servidos; **(b) resiliencia a fallos transitorios** — el pool envenenado (2) convierte un blip de red en un outage que requiere reinicio, y la ausencia general de timeouts (8) convierte un peer colgado en un cuelgue del flujo; **(c) deriva de contratos** — la gemela DWH de master-data (4) y el validador duplicado de demanda (5) son exactamente la clase de divergencia que muerde meses después con datos "válidos" que crashean o duplican. El hallazgo 3 (encoding del filename de intake) es el único con sabor a input hostil directo y conviene cerrarlo ya, porque el fix es trivial y el vector es un nombre de archivo cualquiera.

Con los hallazgos 1–5 resueltos (todos S/M de esfuerzo), el paquete queda honestamente sólido para producción bajo los supuestos S1/S2 declarados.

---

• *Generado con [Wingworking](https://wingworking.org)*
