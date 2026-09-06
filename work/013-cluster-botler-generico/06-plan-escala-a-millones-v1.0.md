---
doc_id: 013-06
cluster: 013-cluster-botler-generico
tipo: Diseño rector (Fable) — para refrendo, no para ejecución directa
version: 1.0
fecha: 2026-09-05
destinatario: César (refrendo de la tesis y de las tres decisiones de §10). Los briefs ejecutables para Opus se derivan de este documento después del refrendo.
estado: PARA REFRENDO — nada de lo aquí propuesto se ha construido; H1 es lo único ejecutable hoy
continua_a: 01-diseno-rector-botler-generico-daftar-v1.0.md (hereda su vocabulario: Botler, Let, proto-Botlet, anillo, plano de control)
fuentes:
  - vergis · packages/capabilities/src/{sqlite,control-lease,evaluaciones-store,notas-store,governance-store,master-data-store}.ts · server/{serve-rls,routes,config}.ts · packages/daftar/src/{let,proto,spec}.ts · packages/mira/src/proto.ts · packages/botler/src/gate.ts · Dockerfile · docker-compose.yml · deploy/compose.reference.yml · deploy/rollout/{README,RUNBOOK}.md · deploy/rollout/bench/{README.md,compose.bench.yml,rings/ring.args.tmpl,poller/poller-v14.mjs,CORRIDAS.md} · CHANGELOG 0.25.0–0.27.0 · DECISIONS D-67…D-75
  - estudios · daftar/instancia/{README.md,compose.yml,rings/ring.args,specs/daftar.yaml,Caddyfile}
  - Conversación con César del 2026-09-05 (tesis acordada: orquestación, no OSGi)
---

# El Botler a millones: descartable, replicado, con el estado afuera

**Doc 013-06 · v1.0 · 5 de septiembre de 2026 · para refrendo**

> **La tesis en una línea.** La disponibilidad de Vergis a escala no va a salir de hacer más robusto el proceso Node, sino de poder **tirarlo**: N nodos idénticos detrás de un balanceador, cada uno sin nada que perder, con los stores en Postgres y el plano de control en un coordinador externo. Lo que hoy es un anillo pasa a ser una réplica; lo que hoy es una promoción pasa a ser un *rolling update*. **El primer paso no es construir nada de eso: es medir cuánto aguanta UN nodo hoy**, con un arnés propio que sepa reportar su propio fallo, porque todo número de capacidad que siga se va a calcular a partir de ése.

---

## La tesis, en una página

Lo que Vergis ya tiene, medido en el cluster 013 y en las versiones 0.19.0–0.27.0, es un **Botler genérico con un plano de control único**: dos anillos calientes sobre un mismo volumen, un lease por archivo que garantiza exactamente un escritor, stores SQLite que se vuelcan completos en cada persist, y una ceremonia de promoción sin corte medida con control negativo. Es un diseño correcto **para un host** — y así lo declara: «un solo host, FS local» es límite de contrato en `deploy/rollout/README.md` §Límites y en `deploy/compose.reference.yml`.

«A millones» rompe ese contrato por tres lados a la vez, y conviene decirlo sin rodeos:

1. **El estado vive en el disco del nodo.** Cada store embebido es un archivo SQLite (sql.js en memoria) que se reescribe **entero** en cada mutación: `persistSqliteDb` hace `db.export()` → archivo temporal → `rename` (`packages/capabilities/src/sqlite.ts:139-176`), y el store `evaluaciones` llama a `persist()` tras cada `guardarIntento` (`evaluaciones-store.ts:369-370, 524`). Eso obliga a **un solo escritor**, y de esa obligación nace todo el plano de control. Con N nodos, ese archivo no puede ser el estado.
2. **El plano de control es un archivo en un volumen local.** `control.lease.json`, ordenado por `rename` atómico y por relojes del mismo kernel (`control-lease.ts:15-30, 44-52`). No cruza hosts por diseño.
3. **La fase de salud está acoplada al control.** `/healthz` responde `phase=standby` a todo nodo que no tenga el lease (`server/routes.ts:130`), y el predicado del borde exige `phase=serving`. Con N nodos y este predicado, **el balanceador solo rutearía a uno**. El predicado no está mal: dice la verdad de un mundo donde solo uno puede escribir. Cambia porque ese mundo cambia.

**La tesis acordada con César el 5-sep** resuelve los tres con una sola idea: **el Botler se vuelve descartable.** Los stores van a Postgres por la costura que ya existe (la superficie de clase de cada store y el registro `embeddedStores()`, §5.1); el lease sale del disco a un coordinador externo por la interfaz `ControlPlane` que ya existe (§5.2); y una vez que cualquier nodo puede escribir, `phase=serving` deja de significar «tengo el control» y pasa a significar «puedo atender» (§5.3). Con eso, N nodos idénticos detrás de un balanceador con ese predicado como *readiness* son una réplica cualquiera de Kubernetes o equivalente, y **los anillos son el rolling update** (§5.4): el mismo acto, con el orquestador haciendo de `botler-rollout`.

**El cuello se traslada, y eso está bien.** Con el Botler descartable, el límite de la instalación queda en el motor de datos externo: Postgres para Daftar, Fabric o ClickHouse para Mira. Ese cuello lo escala su propio producto (réplicas de lectura, particiones, capacidad Fabric) y no es este diseño. Lo que este diseño garantiza es que **el cuello no sea el Botler ni los Lets**.

**Dos familias, dos perfiles de carga**, y no se mezclan en el modelo de capacidad (§6): **Daftar** tiene estado por estudiante —intentos en el store `evaluaciones`, escrituras pequeñas y frecuentes, un `POST` cada vez que un alumno responde— y casi no lee del motor de datos; **Mira** es un *warehouse por request* —cada `GET /<slug>` ejecuta SQL contra Fabric/ClickHouse (sin caché por defecto: `VERGIS_DATA_CACHE_TTL_MS=0`, `serve-rls.ts:722-729`)— y casi no tiene estado propio.

**Y de OSGi se toma el vocabulario, no el runtime.** Se evaluó y se descartó (§9): el aislamiento en proceso que OSGi promete no existe en Node, y el cambio de código sin parar el servicio ya lo resuelven los anillos a nivel de proceso, que es donde Node lo puede garantizar. Lo que sí vale la pena tomar: **estados por Let** visibles en `/contrato` (instalado · resuelto · activo · retirado), un **manifiesto por proto** (qué exige del nodo, qué stores usa, si consume datos gobernados — hoy repartido entre `consumesData`, `capabilitiesOf` y las labels de la imagen) y el **registro de servicios** que ya es `protos` en `/contrato`.

**El hito 1 es una medición, no una construcción.** Antes de tocar una línea de Postgres se corre una prueba de carga contra un nodo, Daftar y Mira por separado, con un arnés propio en el repo. De ahí sale el número que falta en todo lo demás: *requests por segundo por nodo, con su p95, hasta dónde, y qué se rompe primero*. Sin ese número, «N nodos» es una N sin unidad.

---

## Arquitectura objetivo

```
                         Internet
                            │
                  ┌─────────▼──────────┐
                  │  Borde: TLS + SSO   │   oauth2-proxy → IdP (Keycloak)      [existe]
                  │  (X-Forwarded-Email)│
                  └─────────┬──────────┘
                            │
                  ┌─────────▼──────────┐
                  │   Balanceador L7   │   readiness = 200 ∧ phase=serving     [orquestador]
                  │ (Ingress / Service)│              ∧ lets.serving==lets.total
                  └──┬──────┬──────┬───┘
                     │      │      │
              ┌──────▼─┐ ┌──▼─────┐ ┌─▼──────┐
              │ Botler │ │ Botler │ │ Botler │   N réplicas IDÉNTICAS de la misma imagen
              │  v k   │ │  v k   │ │  v k   │   sin volumen propio · sin lease en disco
              │ mira   │ │ mira   │ │ mira   │   protos registrados: mira · daftar
              │ daftar │ │ daftar │ │ daftar │   rolling update = anillos (§5.4)
              └───┬────┘ └───┬────┘ └───┬────┘
                  │          │          │
        ┌─────────▼──────────▼──────────▼──────────┐
        │  Postgres — stores + plano de control     │   gobierno · notas · data-maestra ·
        │  · tabla control_lease (época monótona)   │   evaluaciones · control_lease ·
        │  · intent de handover como fila           │   control_handover
        └──────────────────────┬───────────────────┘
                               │ el ÚNICO que tiene el control arma los lazos de fondo
                               │ (frescura · intake · purga · reporte · re-ingesta)
        ┌──────────────────────▼───────────────────┐
        │  Motor de datos de Mira (Fabric / CH)     │   el cuello permitido: lo escala su producto
        └──────────────────────────────────────────┘

   Contenido por instancia (specs, instrumentos, mapa de identidad): ConfigMap / volumen RO
   compartido — los nodos lo releen en caliente como hoy (VERGIS_SPECS_DIR, VERGIS_INSTRUMENTOS_DIR).
```

Tres invariantes del dibujo:

- **Ninguna réplica tiene nada que perder.** Matar cualquiera no pierde un intento, una nota ni el control: el estado está en Postgres y el lease se releva desde ahí.
- **Sigue habiendo exactamente un controlador de lazos de fondo.** El lease no desaparece: cambia de sustrato. Lo que deja de estar gateado por el lease son las **mutaciones HTTP**, que pasan a ser transacciones de fila en Postgres (§5.1, decisión D1 de §10).
- **El borde no cambia.** oauth2-proxy sigue inyectando `X-Forwarded-Email` y el nodo sigue resolviendo claims como hoy (`packages/botler/src/gate.ts:35`, `server/identity.ts`).

---

## Qué cambia en el Botler y qué NO

| Pieza | Hoy (verificado) | Objetivo | ¿Cambia? |
|---|---|---|---|
| Registro de proto-Botlets, `LetInvocation`, `invoke` | `server/proto-registry.ts`, `packages/botler` (D-68, D-72) | Igual | **No** |
| Descubrimiento en caliente de specs e instrumentos | `VERGIS_SPECS_DIR`, `VERGIS_INSTRUMENTOS_DIR` releídos por request (CHANGELOG 0.27.0) | Igual; el directorio pasa a ser un montaje compartido RO | **No** |
| Identidad: cabecera → claims → alcance | `gate.ts:35` (`x-forwarded-email`), `identity-map-import.ts`, store de gobierno | Igual | **No** |
| Predicado del Let: quién puede ver qué (Daftar 403, Mira RLS) | `packages/daftar/src/let.ts`, `server/identity.ts` | Igual | **No** |
| Stores embebidos: SQLite en volumen, `persist()` = volcado completo | `sqlite.ts:139-176`; cada store importa `openSqliteDb`/`persistSqliteDb` directo (`evaluaciones-store.ts:1-8`, `notas-store.ts:3-4`, `governance-store.ts:2-3`, `master-data-store.ts:3-4`) | **Interfaz por store + implementación Postgres**; SQLite se conserva como implementación para instancias de un host | **Sí** (§5.1) |
| Registro de stores del nodo | `embeddedStores()` `serve-rls.ts:2475-2482` (`{name, reopen, status}`); gate de esquema por label `vergis.schema.stores` (`Dockerfile:71-72`) y `/contrato` | Mismo registro, con `driver: sqlite \| postgres` y esquema por migraciones versionadas | **Sí** (§5.1) |
| Plano de control | `ControlPlane` (`control-lease.ts:281-299`), dos implementaciones: `ControlLease` (archivo) y `SingleControlPlane`; selección por `VERGIS_CONTROL=lease\|single` (`control-lease.ts:216-225, 767-775`) | **Tercera implementación** sobre Postgres, `VERGIS_CONTROL=postgres`; misma interfaz, misma época monótona | **Sí** (§5.2) |
| Intent de handover | Archivo `control.handover.json` escrito por `botler-rollout` (`control-lease.ts:102-107`) | Fila en Postgres escrita por el orquestador del acto | **Sí** (§5.2) |
| Gate de mutaciones HTTP | 409 si `!hasControl` — Daftar en `let.ts:121`, Mira/gestión en `routes.ts` | 409 **solo si el store no acepta escrituras multi-nodo**; con Postgres, cualquier réplica escribe | **Sí** (D1, §10) |
| `/healthz`: `phase` | `starting → standby (¬control) → degraded → serving` (`routes.ts:130`) | `standby` deja de existir cuando los stores son multi-escritor; `control: true\|false` pasa a campo aparte | **Sí** (§5.3) |
| Lazos de fondo solo con control | `createBackgroundLoops`, se arman al adquirir (`serve-rls.ts:250-256`) | Igual: exactamente un controlador | **No** |
| Herramienta de anillos `botler-rollout` | POSIX sh sobre `docker` (`deploy/rollout/botler-rollout`) | Se conserva para instancias de un host; en Kubernetes el acto lo hace el `Deployment` con la misma semántica (§5.4) | **No se toca**; se agrega el equivalente declarativo |
| Sidecar PDF | `deploy/compose.reference.yml` §`vergis-pdf`, sin estado | Un `Deployment` aparte, N réplicas | **No** (solo empaquetado) |

**Lo que este documento NO propone**: no toca el DSL de Mira, no toca `packages/daftar` salvo la línea del 409, no construye el Botler persistente ni SSE (#113), no decide proveedor de nube ni de Kubernetes (Norma POL-01: gasto recurrente lo decide César), y no migra la instancia A.R.B.O.L.: ella adopta lo que le sirva en su siguiente promoción, con su operador.

---

## Las costuras

### Stores → Postgres

**Qué costura existe de verdad, leída del código.** No hay una capa de *drivers*: no existe una interfaz `Store` genérica con implementaciones intercambiables. Lo que existe, y es suficiente, son **cuatro superficies de clase** consumidas por sus llamadores por nombre de método (`store.guardarIntento`, `store.intentosDe`, `store.publicarInstrumento`, `exportarProgreso(store, …)` en Daftar; `governance.*`, `notasSqlite.*`, `mdSqlite.*` en el nodo), más tres piezas transversales:

1. `embeddedStores()` (`serve-rls.ts:2475`): la lista `{name, reopen, status}` que alimenta el bloque `control.store[]` de `/contrato` y el relevo (`reabrirStores`).
2. `SqliteControlOptions` (`sqlite.ts:60-85`): `{epoch, writer, mode: 'write'|'read'}` — el contrato de escritura que cada store recibe del plano de control (`storeControl()`, `serve-rls.ts:285-289`).
3. El gate de esquema: `PRAGMA user_version` + label `vergis.schema.stores` + `/contrato` (`sqlite.ts` cabecera; `Dockerfile:61-72`), que `botler-rollout promote` verifica en el pre-flight.

**Lo que se propone**, por el criterio de excelencia (`ww:wingcoding`): extraer de cada clase su **interfaz de dominio** (`EvaluacionesStore`, `NotasStore`, `GovernanceStore`, `MasterDataStore`) —métodos que ya existen, sin renombrar—, dejar la clase SQLite actual como `Sqlite<Nombre>Store implements <Nombre>Store`, y escribir `Postgres<Nombre>Store` al lado. La selección es por env (`VERGIS_STORES=sqlite|postgres`, con `VERGIS_PG_URL`), y `embeddedStores()` declara el driver en `/contrato`.

**Qué cambia de semántica, y hay que decirlo porque es lo que justifica el trabajo:**

| Propiedad | SQLite (hoy) | Postgres |
|---|---|---|
| Unidad de escritura | Volcado completo del archivo | Transacción por fila |
| Escritores concurrentes | **Exactamente uno** (fencing por huella de archivo + época) | **N**, con la época como *fencing token* en cada escritura de los lazos de fondo (`WHERE control_epoch <= $epoch`), y sin fencing en las mutaciones de usuario — un intento de Matías no necesita saber quién controla |
| Gate de esquema | `user_version` en el archivo | Tabla `schema_migrations` por store; el pre-flight lee la versión de la tabla en vez de la del archivo. **Regla que se conserva**: un binario nunca abre un esquema más nuevo que el que soporta |
| Respaldo pre-migración | `<archivo>.pre-<v>.bak` | Responsabilidad del operador de Postgres (snapshot lógico antes de migrar); el nodo lo exige declarado en `/contrato`, no lo hace |
| Costo de un `POST` de progreso | O(tamaño del archivo `evaluaciones.sqlite`) | O(1) filas |

**Orden de migración: `evaluaciones` primero** (H2). Es el store con demanda de escritura por usuario, tiene 741 líneas y un modelo cerrado (instrumento · intento · intento_seccion · respuesta · reporte), y su importador/exportador (`evaluaciones-import.ts`, round-trip 54/54 medido en 0.27.0) es **el test de paridad gratis**: la misma suite corre contra las dos implementaciones. Gobierno, notas y data-maestra van después (H6), porque su escritura es de operador, no de usuario, y hoy no limitan nada.

**Lo que no se sabe** (con esas palabras): el tamaño real de `evaluaciones.sqlite` en la instancia «estudios» y cuánto tarda hoy un `POST` con ese tamaño — es exactamente lo que H1 mide. Si el `POST` cuesta 3 ms con 54 intentos, la migración de Daftar es de escala y no de urgencia; si cuesta 300 ms, es de urgencia.

### Lease → coordinador externo

**Lo que existe**: la interfaz `ControlPlane` (`control-lease.ts:281-299`: `acquire · renew · release · releaseSync · status · hasControl · epoch`), un protocolo probado —adquisición exclusiva, renovación cada 2 s releyendo antes de escribir, relevo por *staleness* a los 10 s con confirmación por relectura, marca de release, época monótona que los stores estampan, intent de handover con vencimiento— y una ley: **ante duda, cero controladores, jamás dos** (`control-lease.ts:36-41`). Todo eso es **independiente del sustrato**; lo único atado al disco son `writeFileSync`/`renameSync`.

**Opciones concretas:**

| Opción | Cómo | A favor | En contra |
|---|---|---|---|
| **A. Tabla de lease en Postgres con época** | Una fila `control_lease(instance, holder, ring, epoch, renewed_at)`; adquirir = `UPDATE … SET holder=$me, epoch=epoch+1, renewed_at=now() WHERE holder='' OR renewed_at < now() - $stale RETURNING epoch`; renovar = `UPDATE … WHERE holder=$me`; release = `holder=''` conservando la época; el intent es otra fila con `expires_at`. Un solo reloj: el de Postgres | Es **el mismo protocolo** con otro `write`; la época sobrevive tal cual como fencing token en los stores; **no agrega dependencia** (Postgres ya está por §5.1); funciona en compose y en Kubernetes por igual; el relevo queda medible con las mismas pruebas (`tests/control-lease.test.ts` con un `now` inyectado) | El nodo depende de Postgres también para *saber si controla*: si Postgres cae, todos los nodos pierden el control (→ cero controladores, que es la ley). Las lecturas siguen |
| B. Advisory lock de Postgres (`pg_try_advisory_lock`) | El lock vive en la sesión | Trivial de escribir | **Se pierde con la conexión** (reinicio de pool, pgbouncer en modo transacción lo rompe); **no tiene época** → habría que reconstruir el fencing aparte; no hay marca de release ni intent. Reimplementa menos y garantiza menos |
| C. Kubernetes Lease API (`coordination.k8s.io/Lease`) | El lease es un objeto del clúster; renovación por `holderIdentity` + `renewTime` | Es la herramienta nativa de elección de líder; el orquestador ya la vigila | **Ata el Botler a Kubernetes**: la instancia «estudios» corre en compose y seguiría corriendo así; exige RBAC y cliente de la API dentro de la imagen; la época hay que llevarla en una anotación (frágil) |

**Recomendación: A.** Por tres razones en orden: (1) conserva **byte a byte** la semántica medida —época monótona, marca de release, intent con vencimiento, falla hacia cero—, así que los tests actuales del lease valen con un `now()` de Postgres en vez de `Date.now`; (2) no introduce dependencia nueva: la instancia que tenga Postgres para los stores lo tiene para el lease; (3) elimina el «un solo host» sin cambiar de plataforma: **la misma imagen sirve en compose de un host, en compose de tres hosts y en Kubernetes**. C queda documentada como camino si algún día el Botler solo viviera en Kubernetes; B se descarta.

**Detalles que el brief de H3 tiene que fijar y este documento deja decididos:**

- `VERGIS_CONTROL=postgres` como tercer modo de `resolveControlPlaneConfig` (`control-lease.ts:216`); `lease` (archivo) y `single` se conservan.
- `renewMs`/`staleMs` iguales (2 s / 10 s); el poll de relevo sigue en `max(500, renewMs)` (`serve-rls.ts:2621`).
- El intent lo escribe **quien ejecuta el acto**: `botler-rollout` en compose (una variante `--control postgres` que hace `INSERT` en vez de escribir el archivo) o el *hook* de pre-stop del pod en Kubernetes (§5.4).
- **La época sigue viajando a los stores** por `storeControl()` sin cambios: en Postgres se estampa en las escrituras de los lazos de fondo, no en las de usuario.

### Readiness, liveness y el desacople de `phase`

Hoy `phase` mezcla dos preguntas —«¿puedo atender?» y «¿tengo el control?»— porque en el mundo de un escritor eran la misma. Se separan:

| Campo de `/healthz` | Significado objetivo | Quién lo usa |
|---|---|---|
| `phase` | `starting` (nada evaluado) · `degraded` (algún Let no sirve) · `serving` | **Readiness** del balanceador y del orquestador: `200 ∧ phase=serving ∧ (¬lets ∨ lets.serving==lets.total)` — **el predicado no cambia de forma**, cambia lo que `serving` exige |
| `control` (nuevo) | `true` si este nodo tiene el lease; `false` si no | El operador y `botler-rollout status`. **Ningún balanceador lo mira** |
| `standby` como valor de `phase` | Se conserva **solo** cuando `VERGIS_STORES=sqlite` (un escritor): ahí un nodo sin control sigue sin poder atender escrituras y no debe recibir tráfico | Instancias de un host, sin cambios |

**Liveness** es otra pregunta y hoy no existe como endpoint: se propone `/livez` = «el proceso responde y el *event loop* no está bloqueado más de X ms» (una sonda que mide el retraso de un `setImmediate`), sin tocar stores ni motor. La razón: una réplica cuyo Postgres está caído **no está muerta** —sirve catálogo e instrumentos— y reiniciarla no arregla a Postgres; un liveness que dependa del store produce el *crash loop* que se está tratando de evitar. **Readiness** sí baja cuando el Let no puede atender (`lets.serving < total`), y ahí el balanceador saca la réplica sin matarla.

**Consecuencia para Daftar:** el 409 de `let.ts:121` (`if (escribe && !inv.hasControl)`) pasa a preguntarle al store: `if (escribe && !store.aceptaEscrituras())`. Con SQLite la respuesta sigue siendo `hasControl`; con Postgres es `true`. La `LetInvocation` conserva `hasControl` para quien lo necesite (Mira lo usa en gestión).

### Rolling update = anillos

La ceremonia de `botler-rollout promote` (`README.md` §`promote`: pre-flight → intent + flip → handover → smoke → registro) **es** un rolling update de una réplica, escrito a mano porque compose no lo sabe hacer. En Kubernetes el mapeo es uno a uno:

| Anillos (compose, un host) | Kubernetes | Nota |
|---|---|---|
| `install <v>` = pull + create + start en espera | Nuevo `ReplicaSet` con la imagen `:<v>` (nunca un tag móvil: la regla de `install` se conserva por *admission policy* o por convención de CI) | El digest sigue siendo la identidad del anillo |
| Pre-flight de esquema (`/contrato` vs label) | `initContainer` que compara `schema_migrations` con lo que soporta la imagen y **falla el pod** si el binario es más viejo que el esquema | Fail-closed, como hoy |
| Flip del borde + handover dirigido | `maxSurge=1, maxUnavailable=0` + readiness; el `preStop` del pod saliente escribe el intent nombrando **a cualquiera** del ReplicaSet nuevo y hace `release()` | El intent «ordena la fila» igual que hoy; el sucesor es el primero de la generación nueva que adquiera |
| Smoke por el borde | El mismo predicado como readiness: el pod nuevo no recibe tráfico hasta cumplirlo | Sin smoke aparte |
| `rollback` (flip al previo caliente) | `kubectl rollout undo` — el ReplicaSet previo se conserva por `revisionHistoryLimit` (`RINGS_RETAIN`) | El «previo caliente» deja de existir: el rollback arranca pods, y **la sala de espera la cubre el readiness**, no una página 503 |
| Poller con control negativo (RUNBOOK §0) | **Se conserva tal cual** — es la ley del instrumento, no una herramienta de compose | Corre fuera del clúster o como pod hermano que el rollout no toca |

**Lo que se pierde y se declara**: la promoción con **dos versiones calientes y flip instantáneo** de vuelta. En Kubernetes el rollback es un rollout más (segundos, no milisegundos). Es un costo aceptable a cambio de N réplicas; para una instancia de un host que no necesita N, `botler-rollout` sigue siendo la herramienta y no se toca.

---

## Modelo de capacidad por familia

Las variables que H1 mide; el número entre paréntesis es lo único que hoy se conoce, y de dónde.

### Daftar — estado por estudiante

| Variable | Qué es | Hoy |
|---|---|---|
| `r_get` | RPS de lectura sostenibles por nodo (`GET /<slug>/api/guides`, `/api/progress/<id>`, `/report/<id>`) con p95 < 200 ms | **Desconocido** |
| `r_post` | RPS de `POST /<slug>/api/progress/<id>` sostenibles con p95 < 200 ms y **cero 5xx** | **Desconocido**. Hipótesis (conjetura, refutador en H1): cae linealmente con el tamaño de `evaluaciones.sqlite`, porque cada `POST` reescribe el archivo entero (`sqlite.ts:139-176`) |
| `S` | Tamaño del archivo `evaluaciones.sqlite` en función de intentos acumulados | 54 intentos importados (CHANGELOG 0.27.0); tamaño en bytes **no medido** |
| `m_nodo` | Memoria de un nodo en reposo y bajo carga | ~105 MB en reposo (medido 5-sep, `estudios/daftar/instancia/README.md` §Memoria); límite de anillo 512 MB (`rings/ring.args`); bajo carga **no medido** |
| `c_pub` | Latencia de publicación de un instrumento (copia → visible) | 1 ms (medido, README de la instancia) |
| Perfil de un estudiante | ~1 `POST` por respuesta o por cambio de sección + `GET`s de catálogo y reporte | **Supuesto** desde `app.js`; H1 lo calca del frontend, no lo inventa |

**Qué se espera aprender**: si `r_post` a `S` pequeño ya es > 50 RPS por nodo, un solo nodo aguanta miles de estudiantes concurrentes en régimen normal y el problema de Daftar es solo el crecimiento de `S` (⇒ Postgres por tamaño, no por RPS). Si `r_post` < 10 RPS, el problema es el volcado completo y Postgres es el primer hito.

### Mira — warehouse por request

| Variable | Qué es | Hoy |
|---|---|---|
| `r_pi` | RPS de `GET /<slug>` por nodo con p95 < 1 s, con el motor respondiendo en tiempo constante | **Desconocido** |
| `t_motor` | Latencia del motor por consulta (ClickHouse local en el banco; Fabric en A.R.B.O.L.) | Banco: **no separada** del total; A.R.B.O.L.: no medida desde el Producto |
| `t_render` | CPU de render HTML por PI (compose + tablas + gráficos) — lo único que es del Botler | **Desconocido**; es **el número que decide si Mira escala por réplicas**: si `t_render ≪ t_motor`, agregar nodos no sirve y el trabajo está en el motor |
| `cache` | `VERGIS_DATA_CACHE_TTL_MS` | 0 por defecto (`config.ts:400`): sin caché, cada request paga el motor |
| Concurrencia de identidades | Con RLS por consumidor, una misma consulta se ejecuta una vez **por identidad** (no hay caché compartida entre consumidores por diseño) | Verificado en `serve-rls.ts:722-729` («data-cache por consumidor») |

**Qué se espera aprender**: la razón `t_render / t_motor`. H1 la separa midiendo con dos brazos: el nodo contra ClickHouse real y el nodo contra un motor *stub* que responde en tiempo constante (si existe una capability inyectable de `execute-sql` para tests — `servingCap` es un valor asignado en `serve-rls.ts:528`, así que el stub es una env de arranque; **cómo se inyecta es del brief de H1, y si no es barato, el brazo se declara sin medir**).

### Aritmética que sale de H1

Con `r_post`, `r_get`, `r_pi` y `m_nodo`, la instalación se dimensiona así, y no antes:

```
N_daftar = ceil( (E · p_post + E · p_get) / (0,6 · min(r_post, r_get)) )   E = estudiantes concurrentes pico
N_mira   = ceil( U · p_pi / (0,6 · r_pi) )                                 U = usuarios concurrentes pico
```

El 0,6 es margen de operación (nunca planificar al 100 % del medido); `p_*` son las tasas por usuario que el arnés calca del frontend. **Ningún número de esta fórmula existe hoy.**

---

## Hitos

Cada hito se entrega a un realizador Opus con brief propio, worktree propio y gate declarado (Norma 8). **H1 no espera refrendo de nada más que de sí mismo**: no construye, mide.

### H1 · Prueba de carga contra UN nodo, con arnés propio

**Qué produce.** `deploy/carga/` en el repo: un arnés Node ≥ 22 **sin dependencias** (`arnes.mjs`), dos perfiles (`daftar`, `mira`), un generador de instrumentos sintéticos, un `README.md` y un `CORRIDAS.md` con los resultados crudos y el veredicto. Más una fila `CAP-NN` en `docs/capacidades.md` si se publica en una versión.

**La ley del instrumento, heredada de `poller-v14.mjs` y `RUNBOOK.md` §0, sin relajar una regla:**

1. **Cada request es un par (t-envío, t-respuesta) con veredicto en un JSONL crudo.** El veredicto se computa del archivo, nunca de la consola.
2. **`SINMEDIR ≠ MAL`.** Timeout, socket rechazado y tope de en-vuelo alcanzado se anotan como `SINMEDIR` con motivo; un 5xx o un cuerpo que no cumple es `MAL`. Los dos se reportan por separado y **ninguno se descarta**.
3. **Predicado completo, por clase de request.** Para `/healthz`: `200 ∧ phase=serving ∧ (¬lets ∨ lets.serving==lets.total)`. Para un `GET` de Daftar: `200 ∧ JSON parseable ∧ la clave esperada`. Para un `POST` de progreso: `200 ∧ ok:true`, **y al cerrar la corrida se relee cada intento escrito y se compara con lo enviado** (cero pérdidas, como `verificar-impresiones.mjs`). Para `GET /<slug>` de Mira: `200 ∧ el HTML contiene el invariante del PI` (el banco ya verifica «contenido», `bench.sh v8`).
4. **Errores por clase**: 2xx · 4xx (por código) · 5xx (por código) · `409 standby` **contado aparte** · timeout · rechazo. Un 409 en una corrida contra el nodo activo es hallazgo, no ruido.
5. **Latencias p50/p95/p99/p100 por clase de request y por escalón de carga**, calculadas del crudo con percentil por orden (sin librerías).
6. **Control negativo obligatorio, dos brazos, antes de creer un solo número:**
   - **CN-A (el instrumento ve el fallo):** la misma corrida contra un nodo **en standby** (segundo nodo sobre el mismo `VERGIS_OUT`) tiene que producir `409` en todos los `POST` y `phase=standby` en el healthz. Si sale verde, el instrumento está ciego.
   - **CN-B (el instrumento distingue «no pude medir»):** la misma corrida contra un puerto sin nadie tiene que producir 100 % `SINMEDIR:rechazo`, **cero `MAL` y cero `OK`**.
7. **El arnés vive fuera del sujeto.** Corre en el host o en un contenedor hermano; jamás dentro del contenedor del nodo.
8. **Escalera de carga, no un solo punto.** Concurrencia fija por escalón (`--vu 1,5,10,25,50,100,200`), 60 s por escalón, con 10 s de calentamiento descartados. Se para en el primer escalón con p95 > umbral **o** con `MAL` > 0,1 % **o** con `SINMEDIR` > 0, y ese escalón se reporta como **techo**, con la causa observada (no inferida: CPU del contenedor por `docker stats`, RSS, latencia del motor si se mide aparte).
9. **La configuración se lee del sujeto vivo**: antes de cada corrida el arnés pide `/healthz` y `/contrato` (con el email admin) y guarda en el crudo la versión, el `protos`, el `control.store[]` y el driver. Una corrida sin ese preámbulo no es una corrida.

**Cómo se levanta el nodo Daftar local** (verificado contra `estudios/daftar/instancia/rings/ring.args`, `CHANGELOG 0.27.0` §Cómo se monta y `serve-rls.ts:525-560`):

```sh
# 1. Imagen del árbol actual (la misma receta del banco: bench.sh:84)
cd <repo-vergis> && docker build -t vergis:carga .

# 2. Instancia sintética en un directorio temporal
C=$(mktemp -d)/carga-daftar && mkdir -p $C/{specs,instrumentos/{guides,recursos,reports},identity,governance}
cat > $C/specs/daftar.yaml <<'EOF'
daftar_version: "1.0"
identity: { code: carga, display_name: "Daftar · carga" }
estudiantes:
  e001: { name: "Estudiante 001", grade: "" }     # el generador emite e001…eNNN
EOF
# identity/map.json: { "<email>": { "student": ["e001"] } } — un email por estudiante sintético,
# más un admin. Formato: identity-map-import.ts:16-17.
# instrumentos/guides/*.json: K guías sintéticas del generador (esquema: packages/daftar/src/tipos.ts
# y tests/fixtures/daftar/casos.json). CARGA_GUIAS_DIR=<dir real> las reemplaza por guías reales.

# 3. El nodo: SIN motor de datos (ninguna spec consume datos gobernados → arranca sin ClickHouse,
#    serve-rls.ts:525-560). VERGIS_ENGINE queda en su default; no hace falta VERGIS_DATASETS.
docker run -d --name carga-daftar --init --memory 512m -p 127.0.0.1:8080:8080 \
  -e VERGIS_SPECS_DIR=/specs -e VERGIS_INSTRUMENTOS_DIR=/instrumentos -e VERGIS_EVALUACIONES=1 \
  -e VERGIS_IDENTITY_MAP=/identity/map.json -e VERGIS_OUT=/governance \
  -e VERGIS_ADMIN_SEED=admin@carga.local -e VERGIS_CONTROL=lease \
  -v $C/specs:/specs:ro -v $C/instrumentos:/instrumentos:ro -v $C/identity:/identity:ro \
  -v $C/governance:/governance vergis:carga

# 4. El standby para CN-A: mismo VERGIS_OUT, otro puerto
docker run -d --name carga-daftar-standby ... -p 127.0.0.1:8081:8080 ... -v $C/governance:/governance vergis:carga
```

La identidad se manda por cabecera `X-Forwarded-Email` directo al nodo (`gate.ts:35`); sin `VERGIS_GATE_SECRET` no hay token que exigir (`routes.ts:136`, `serve-rls.ts:750-755`). **No se encontró verificación CSRF en `packages/daftar/src/let.ts`** (grep `csrf` vacío): si el `POST` recibe 403 por otra causa, es hallazgo del arnés, no ajuste.

**Perfil `daftar`** (calcado del frontend; el brief lo fija leyendo `packages/daftar/assets` y `let.ts:94-121`):

| Paso por «estudiante virtual» | Request | Clase |
|---|---|---|
| Entra | `GET /carga/` · `GET /carga/api/guides` | lectura |
| Abre una guía | `GET /carga/api/guides/<id>` · `GET /carga/api/progress/<id>` | lectura |
| Responde | `POST /carga/api/progress/<id>` con el cuerpo que emite `exportarProgreso` (forma en `evaluaciones-import.ts`, `progresoAIntento`) — **k veces**, una por respuesta, con el progreso creciendo | escritura |
| Cierra | `GET /carga/report/<id>` | lectura pesada (HTML) |

Cada estudiante virtual tiene **su propio email y su propio instrumento** (un intento por `(instrumento, estudiante)`, `evaluaciones-store.ts` cabecera): así los `POST` no se pisan entre sí y la corrida mide concurrencia real, no serialización sobre una fila.

**Dos series obligatorias en Daftar**, porque la hipótesis a refutar es «el costo del `POST` crece con `S`»: la escalera completa con `S₀` (store vacío) y de nuevo con `S₁` = el store tras sembrar **5.000 intentos** con el generador (vía `POST`s previos, no tocando el archivo). Si p95 de `POST` a `S₁` no es distinguible de `S₀`, la hipótesis se refuta y se dice.

**Cómo se levanta el nodo Mira local**: **el banco V-14 ya lo hace** — `sh deploy/rollout/bench/scripts/bench.sh preparar` construye la imagen, levanta ClickHouse 24.8 sembrado, y deja anillos con 9 PIs en `/bench-01…09` (`bench/README.md`, `rings/ring.args.tmpl`). El arnés apunta al anillo activo (`docker inspect` de `vergis-9-9-1` → IP en la red `benchv14`) o al conmutador `benchv14-caddy:8079` desde un contenedor hermano en esa red, como hace el poller. **Se reusa; no se duplica.**

**Perfil `mira`**: `GET /bench-0k` con `X-Forwarded-Email` de un consumidor válido del banco (`instancia/entidades.yaml`), rotando los 9 PIs; el invariante de contenido se toma de `.run/datos/pis-servidos.json`. Segundo brazo (si el stub de motor es barato, §6): el mismo perfil con el motor respondiendo en tiempo constante, para separar `t_render` de `t_motor`. Si no es barato, **se declara sin medir** y `t_render` se estima por resta con la latencia de ClickHouse medida aparte (`system.query_log`).

**Comandos del arnés** (contrato del brief):

```sh
node deploy/carga/arnes.mjs --perfil daftar --url http://127.0.0.1:8080 --slug carga \
     --vu 1,5,10,25,50,100,200 --dur 60 --warmup 10 --p95-max 200 --out .run/carga/daftar-S0.jsonl
node deploy/carga/arnes.mjs --perfil daftar --url http://127.0.0.1:8081 ... --esperar standby   # CN-A
node deploy/carga/arnes.mjs --perfil daftar --url http://127.0.0.1:8099 ... --esperar rechazo   # CN-B
node deploy/carga/veredicto.mjs .run/carga/daftar-S0.jsonl        # tabla por escalón y clase; techo
```

`--esperar standby|rechazo` es el brazo de control: el arnés **falla con rc≠0 si el resultado no es el esperado**, para que un control negativo verde no pase en silencio.

**Criterios de éxito de H1** (el hito se cierra con estos, no con «corrió»):

1. CN-A rojo (100 % `409` en `POST`, `phase=standby`) **y** CN-B 100 % `SINMEDIR:rechazo`, registrados en `CORRIDAS.md` **antes** de la primera serie.
2. Cuatro series con veredicto: Daftar `S₀`, Daftar `S₁`, Mira contra ClickHouse, Mira contra stub (o «sin medir» con la razón).
3. **Cero pérdidas verificadas** en Daftar: cada `POST` con `200` releído idéntico al cierre.
4. Por cada serie: **techo** (último escalón dentro de umbral), p50/p95/p99 por clase en el techo, errores por clase, RSS y CPU del contenedor en el techo (`docker stats --no-stream` cada 5 s al crudo).
5. `t_render/t_motor` de Mira con su método declarado.
6. Un párrafo de **veredicto** por familia con la forma de la Disciplina 7: qué aguanta un nodo, qué se rompe primero, y qué hito de esta lista sube de prioridad por eso.

**Qué número sale de ahí**: `r_post(S₀)`, `r_post(S₁)`, `r_get`, `r_pi`, `m_nodo` bajo carga. Con ellos se rellena §6 y se decide si H2 es urgente o de escala.

**Gate del brief**: `npm run typecheck` verde, `lint:shell` verde, un test unitario del cálculo de percentiles y del clasificador `OK|MAL|SINMEDIR` (con un caso por clase de error) en `tests/carga-arnes.test.ts`, y `CORRIDAS.md` con las corridas reales de esta máquina.

### H2 · Store `evaluaciones` en Postgres

Interfaz `EvaluacionesStore` extraída de la clase (§5.1) · `PostgresEvaluacionesStore` con `pg` como **única** dependencia nueva de runtime (es la primera; se declara en el CHANGELOG) · migraciones versionadas en `packages/capabilities/sql/evaluaciones/NNN.sql` · `VERGIS_STORES=postgres` + `VERGIS_PG_URL` · `embeddedStores()` declara `driver` · `let.ts:121` pregunta `store.aceptaEscrituras()` · Postgres en `docker-compose` del banco de carga. **Gate**: la suite de `evaluaciones-store.test.ts` y `evaluaciones-import.test.ts` corre **contra las dos implementaciones** sin cambiar un test (round-trip 54/54 contra Postgres); el arnés de H1 repetido con `S₁` contra Postgres; control negativo: un `POST` con el esquema de Postgres una versión adelante del binario **se niega** al arrancar.

### H3 · Plano de control en Postgres y desacople de `phase`

`PostgresControlPlane implements ControlPlane` (opción A de §5.2) · `VERGIS_CONTROL=postgres` · intent como fila · `botler-rollout --control postgres` escribe el intent por `psql`/`docker exec` · `/healthz` gana `control` y pierde `standby` cuando `VERGIS_STORES=postgres` · `/livez`. **Gate**: `tests/control-lease.test.ts` parametrizado sobre las dos implementaciones (mismo protocolo, mismo `now` inyectado) · banco: dos nodos con Postgres, `SIGKILL` al controlador → relevo < `staleMs` + poll, medido con el poller · **control negativo**: dos nodos con `VERGIS_CONTROL=single` sobre el mismo Postgres arman lazos los dos (el fenómeno que el lease evita, visible en el log de ambos).

### H4 · N nodos detrás de un balanceador, en el banco local

Extensión del banco V-14: `compose.carga.yml` con Postgres, 3 réplicas del nodo (`deploy: replicas: 3` o tres servicios), Caddy con `lb_policy round_robin` y el predicado como health check (ya está en `Caddyfile.reference`), el arnés de H1 apuntando al borde. **Gate**: la escalera de H1 contra 1, 2 y 3 réplicas; el techo tiene que crecer con N para Daftar (si no crece, el cuello es Postgres o el borde, y se dice cuál con datos); matar una réplica en medio de la escalera **sin un solo `MAL`** (readiness la saca; `SINMEDIR` acotado a los requests en vuelo hacia ella, contados).

### H5 · Manifiestos de Kubernetes de referencia

`deploy/k8s/` con `Deployment` (readiness = predicado, liveness = `/livez`, `maxSurge 1 / maxUnavailable 0`, `preStop` que escribe el intent y hace `release`), `Service`, `ConfigMap` para specs/instrumentos/mapa, `Secret` para `VERGIS_PG_URL`, `initContainer` del gate de esquema, sidecar PDF como `Deployment` propio. **No incluye** el proveedor ni Postgres gestionado (decisión de gasto, César). **Gate**: `kind` o `k3d` local: rolling update `v→v'` bajo el arnés de H1 con el poller hermano; **0 fuera de predicado** en la ventana, y el `rollout undo` medido igual; control negativo: readiness relajado a «responde» deja pasar tráfico a un pod `starting` y el poller lo ve.

### H6 · Gobierno, notas y data-maestra a Postgres

Mismo patrón de H2 para los tres stores restantes; el gate de esquema por label de imagen se reemplaza por `schema_migrations`; `botler-rollout` pre-flight lee la tabla. Después de esto un nodo con `VERGIS_STORES=postgres` **no necesita `VERGIS_OUT` persistente**: es descartable de verdad. **Gate**: las suites de los tres stores contra las dos implementaciones; una instancia Mira del banco promovida con `VERGIS_OUT` en `tmpfs`.

### H7 · Prueba de carga a N nodos contra Fabric

La única que toca un tercero: el arnés de H1 perfil `mira` contra una instancia con Fabric (el lab propio, `scripts/README-fabric-lab.md`, no A.R.B.O.L.), para medir dónde satura la capacidad Fabric antes que el Botler. **Gated por POL-01** (ventana de capacidad Fabric la decide César).

**Dependencias**: H1 → (H2 ∥ H3) → H4 → H5; H6 en cualquier momento después de H2; H7 después de H4. **Solo H1 está listo para brief hoy.**

---

## Riesgos, y lo que NO se sabe

| Riesgo o incógnita | Estado | Cómo se mide antes de creerlo resuelto |
|---|---|---|
| El costo del `POST` de Daftar crece con el tamaño del store (volcado completo) | **Conjetura** con mecanismo leído (`sqlite.ts:139-176`), **sin corrida** | H1, series `S₀` vs `S₁`. Si no se distingue, la conjetura se retira del documento |
| Un nodo Daftar bajo carga supera los 512 MB del anillo | **No se sabe**; reposo 105 MB | H1 registra RSS en el techo |
| `t_render` de Mira es despreciable frente al motor (⇒ réplicas no ayudan a Mira) | **No se sabe** | H1, dos brazos; si el stub no es barato, se estima por resta y se etiqueta |
| Con Postgres, la latencia del `POST` sube por red y transacción respecto del volcado local a `S₀` | Plausible; **no medido** | H2 repite la escalera de H1 contra Postgres; si el p95 empeora a `S₀`, se dice y se acepta o no según `S` esperado |
| Pérdida del control por caída de Postgres deja los lazos de fondo sin controlador | **Por diseño** (ley de cero controladores) | H3 lo mide: Postgres caído 60 s → cero lazos armados en todos los nodos, lecturas de catálogo siguen; al volver, un solo nodo adquiere |
| La primera dependencia nativa (`pg`) rompe el «sin binarios nativos» del `Dockerfile` (`sql.js` se eligió por eso, `sqlite.ts:7`) | `pg` es JS puro (`pg-native` es opcional) — **verificar en el brief de H2 con `npm ls`**, no asumir | Build de la imagen sin toolchain de compilación |
| El renombre semántico de `phase` (`standby` desaparece con Postgres) deja ciego a un poller viejo | Mismo modo de falla que #290 | CHANGELOG con «rompe»; `serving_ok()` de `botler-rollout` ya exige el bloque `lets`; el poller de H1 registra `control` aparte |
| Mira multi-réplica y el caché por consumidor: N réplicas = N cachés, la tasa de acierto cae con N | **Cierto por construcción** si se activa `VERGIS_DATA_CACHE_TTL_MS`; hoy está en 0 | H4 con caché activado mide la tasa; si importa, caché compartida es otro diseño (no éste) |
| Instrumentos y specs como montaje compartido RO en Kubernetes: la publicación en caliente depende de la propagación del `ConfigMap` (segundos, no 1 ms) | **No medido** | H5 mide copia → visible en los 3 pods |
| La conversación del 5-sep fijó «Kubernetes o equivalente»; el equivalente concreto (ECS, Nomad, compose multi-host con Swarm) no está decidido | **Decisión de César** (gasto y operación) | §10 |

---

## Caminos descartados, con su razón

- **OSGi como runtime del Botler.** Lo que OSGi vende —módulos con ciclo de vida propio, aislamiento por *classloader*, cambio de código en caliente dentro del proceso— **no existe en Node**: no hay aislamiento de memoria ni de dependencias entre módulos de un mismo proceso, y «descargar» un módulo no libera lo que capturó. El cambio de código sin corte **ya está resuelto a nivel de proceso** por los anillos, con medición; y un contenedor OSGi sería una dependencia de JVM en un producto Node. Se toma su vocabulario (estados por Let en `/contrato`, manifiesto por proto, registro de servicios) porque nombra bien cosas que el nodo ya tiene a medias — nada más.
- **«Cada guía es un Botlet»** (un Let por instrumento, o por estudiante). Falla las tres pruebas del Botlet (rector §B3): una guía no se ejecuta, se aplica; un evaluador por estudiante no agrega especialidad; y a escala multiplicaría los Lets por miles, con el predicado `lets.serving==lets.total` volviéndose un conteo de contenido. El contenido es catálogo; el Let es uno por instancia.
- **Anillos dentro del Let** (versionar y promover cada proto por separado dentro de un nodo vivo). Es la forma Node de pedir OSGi: sin aislamiento de proceso, un proto nuevo con una fuga afecta al otro, y el gate de esquema por imagen deja de tener sujeto. La granularidad del ciclo de vida del código es **nivel Botler** por canon (rector §1.2); la operación por Let es en caliente y ya existe (specs e instrumentos releídos).
- **Sticky sessions para no migrar el store** (fijar cada estudiante a una réplica y seguir con SQLite por nodo). Convierte cada réplica en un *single point* para sus usuarios, no resuelve el rolling update (el estado se queda en el pod que muere) y vuelve el balanceador parte del modelo de consistencia. Descartado.
- **Advisory locks y Kubernetes Lease** como sustrato del lease: ver §5.2. El primero garantiza menos que el protocolo actual; el segundo ata el Botler a una plataforma.
- **k6 / vegeta / autocannon como arnés.** Excelentes herramientas, pero ninguna sabe el predicado de este nodo, ninguna distingue `409 standby` de un error, y todas tratan «no pude medir» como un error más. El arnés propio tiene ~400 líneas y hereda la ley del instrumento del banco; una dependencia no la heredaría.

---

## Lo que se pide a César

| # | Decisión | Recomendación de este diseño |
|---|---|---|
| **D1** | **Con stores en Postgres, las mutaciones HTTP dejan de estar gateadas por el lease** (cualquier réplica escribe intentos, notas, gobierno); el lease sigue gateando **solo** los lazos de fondo. Es lo que hace posible N réplicas útiles, y es un cambio de doctrina respecto del «exactamente un escritor» de 0.19.0 | **Sí.** El «un escritor» nació del volcado completo; con filas transaccionales, el invariante que importa es «un controlador de lazos», y ése se conserva |
| **D2** | **El lease va a Postgres (opción A), no a la Lease API de Kubernetes**, para que la misma imagen sirva en compose de un host y en un clúster | **Sí**, por no atar el Botler a una plataforma y por conservar el protocolo medido |
| **D3** | **H1 se ejecuta ya**, antes de cualquier construcción, y sus números gobiernan el orden de H2–H7 | **Sí.** Es el único hito sin refrendo pendiente: no cambia una línea del Producto |
| — | Plataforma concreta de orquestación y Postgres gestionado (gasto recurrente, POL-01) | Se decide **después de H1 y H4**, con números; hasta entonces todo corre en el banco local |
| — | Fila de este plan en el canon (Cap 9: el Botler como réplica descartable) | Cambio de forma en el libro cuando H4 esté medido, no antes |

Refrendadas D1–D3, el siguiente entregable de Fable es el **brief de H1**, ejecutable en frío.

---

*Doc 013-06 · Plan de escala a millones · v1.0 · 5 de septiembre de 2026 · para refrendo*

• *Generado con Wingworking*
