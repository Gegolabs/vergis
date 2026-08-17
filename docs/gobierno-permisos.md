# Gobierno, Estado y Permisos — cómo funciona Mira

> **Documentación canónica del Producto.** Define el modelo de gobierno de Mira/Vergis — para humanos
> que lo operan y para **agentes** que usan este Botlet. Comportamiento **genérico**, independiente de
> instancia. Complementa [`data-maestra-y-publicacion.md`](data-maestra-y-publicacion.md) y
> [`frescura-oferta-demanda.md`](frescura-oferta-demanda.md).

## 1 · Modelo de tres estados

Todo lo que el sistema persiste se ordena por **naturaleza** en tres clases, y cada una vive donde su
naturaleza manda:

| Estado | Qué es | Dónde vive | Quién lo lee |
|--------|--------|------------|--------------|
| **Datos + data maestra** | hechos, dimensiones, catálogos | el **data engine** (Fabric, ClickHouse, …) | el **motor de query** del PI |
| **Definición del PI** (spec) | el "qué": estructura, queries, vistas | **archivos de instancia**, versionados, **authz-blind** | el renderer (Mira) |
| **Estado de gobierno** | el "quién/cuándo/cuánto": admins, ACL/ownership de PI, oferta/demanda, **autoría de data maestra**, auditoría | **store del runtime** (`GovernanceStore`), agnóstico del motor | el Botler/PEP, en cada request |

**Por qué el gobierno NO vive en el data engine ni en los specs:** (a) ningún PI lo cruza por join — lo
lee el runtime para autorizar; (b) la ACL se chequea **por request** → necesita un store OLTP de baja
latencia, no un motor analítico; (c) **portabilidad**: atarlo a un motor acoplaría la autorización al
data engine, lo contrario a la agnosticidad de motor; (d) radio de explosión: el dato más sensible,
fuera del warehouse que tocan muchos consumidores.

## 2 · El `GovernanceStore`

Un store **único** del estado de gobierno, **detrás de un seam** (interfaz), backend **SQLite en un
volumen persistente** (Postgres es un swap de una impl. sin tocar el resto). Consolida en un db:
admins, grupos de Mira, ACL/ownership de PI, demanda por PI, registro de fuentes y observabilidad de
ingestión.

Se nutre de **dos fuentes**: **semilla declarativa** en config de instancia (env/yaml versionado:
`VERGIS_ADMIN_SEED`, grupos, fuentes) + **estado vivo mutable** editado in-app. Toda mutación se
**audita** en el log append-only hash-encadenado.

> **Persistencia:** `VERGIS_OUT` debe apuntar a un **volumen persistente**; si no, el estado vivo
> (admins agregados, ACLs, auditoría) vuelve a la semilla al reiniciar el contenedor.

### ¿Qué vive en el store?

El inventario completo, por familia (DDL e interfaces en
`packages/capabilities/src/governance-store.ts`; apertura y siembra en `SqliteGovernanceStore.open`):

| Familia | Tablas | Qué es |
|---|---|---|
| Admins de plataforma | `admin` · `admin_seed_removed` | Rol admin (§5): semilla `VERGIS_ADMIN_SEED` + gestión in-app. El tombstone da precedencia al runtime sobre la semilla. |
| Grupos de Mira | `mira_group` · `mira_group_member` · `mira_group_seed_removed` | Grupos para compartir PIs (§4) — NO grupos AAD. El tombstone da precedencia al runtime sobre la semilla. |
| Gobierno de PI | `pi_governance` · `pi_grant` · `pi_demanda` | Visibilidad, ACL (owner/collaborator/viewer) y demanda de frescura, por código de PI (§4). |
| Settings de plataforma | `platform_setting` | Clave→valor editable in-app + memoria durable de los lazos (abajo). |
| Registro de fuentes | `source` · `table_source` · `ingestion_process` · `process_output` · `source_registry_removed` | Fuentes (oferta + dominio), mapeos tabla→fuente, procesos de ingestión (con `engine_ref` al item del motor y su `logs:`), salidas por proceso. Gestionable in-app con precedencia runtime-sobre-semilla (abajo). |
| Registro de cargas | `intake_upload` · `intake_backfill` | Las cargas del intake (issue #62): quién subió qué, cuándo, con qué resultado — y el dedup por contenido (abajo). |
| Registro de reversiones | `intake_revert` | Las reversiones ejecutadas (issue #63): quién revirtió qué carga y con qué resultado por clave (abajo). |
| Proyección de ingestión | `ingestion_run` · `ingestion_process_state` | Lo último conocido del motor por proceso (issue #105): corridas, schedule, errores de observación (abajo). |
| Miranda | `miranda_session` · `miranda_message` · `miranda_artifact` · `miranda_seq` | Sesiones del agente que autora specs (cluster 077): conversación, artefactos versionados append-only y la secuencia de códigos PI (semilla 101). |

### `platform_setting` — settings de plataforma

Clave→valor con autoría (`updated_by`/`updated_at`). Dos naturalezas conviven:

- **Settings editables in-app** (sección Plataforma de Administración, solo admin, auditados):
  - `index_title` — **el título del catálogo, editable**: el caso de uso canónico. Lo escribe el
    formulario de Plataforma (`server/admin.ts`, evento de audit `platform-setting`) y lo lee el
    render del índice (`renderIndexPage` en `server/serve-rls.ts`) con fallback al env
    `VERGIS_INDEX_TITLE`. La instancia cambia su branding sin tocar el despliegue.
  - `notas_retencion_impresiones` (default `P12M`) · `notas_max_schedules_usuario` (default `10`) ·
    `notas_anti_cementerio` (default `on`) — retención y límites de la capa de notas
    (`server/notas-settings.ts`; los defaults viven en código, el setting solo el override).
- **Memoria durable de los lazos** (escrita por el producto, no por humanos):
  - `freshness.alert_state` — el estado de alertas del lazo de frescura (dedup por transición,
    issue #104/P-31): **sobrevive al reinicio** — sin él, cada restart re-alertaría todo lo ya
    alertado (`server/freshness-loop.ts`).
  - `report.last_sent` — el registro de último envío del reporte periódico (issue #102): el catch-up
    tras un restart no re-envía lo ya enviado (`server/report.ts`).

### Precedencia runtime-sobre-semilla — gestión in-app del registro (issue #107)

El registro de fuentes/procesos se **siembra** de `VERGIS_SOURCES` (declarativo, re-sembrado en cada
arranque) y además se **gestiona in-app** (sección Fuentes, por rol). Las dos fuentes conviven con
una regla: **el runtime gana**. El mecanismo (en `SqliteGovernanceStore.open` y
`upsertSource`/`upsertProcess`):

- Una escritura in-app **sella `managed_at`** en la fila (`source.managed_at`,
  `ingestion_process.managed_at`); el re-sembrado de arranque **no pisa** las filas selladas
  (`ON CONFLICT … WHERE managed_at IS NULL`) y jamás toca `managed_at`.
- Una **baja** in-app deja **tombstone** en `source_registry_removed` (`kind` + `id`): el
  re-sembrado **no resucita** el id. Un **alta** in-app posterior del mismo id limpia el tombstone
  (readmitir = revocar el tombstone). Los grupos de Mira y el rol admin usan el mismo patrón con su
  tabla propia (`mira_group_seed_removed`, `admin_seed_removed`) — tres registros, tres ciclos de vida.
- Para una instancia que solo gestiona por yaml, la conducta es la declarativa pura.

La **pausa de un proceso** (`ingestion_process.paused_at`/`paused_by`, `setProcessPaused`) también es
estado de gobierno: pausado, el lazo no alerta ni reconcilia. El orden importa y está en el wiring
(`pauseProcess` en `server/serve-rls.ts`): **pausar deshabilita el schedule en el motor PRIMERO** —
si el motor no acepta, nada se registra (jamás un «pausado» en el producto con el motor corriendo);
reanudar limpia el flag primero y el lazo converge. «Aplicar cadencia» a un proceso pausado **se
rehúsa** (lo re-habilitaría).

### Registro de cargas del intake — `intake_upload` · `intake_backfill` (issue #62)

Cada carga (o su **rechazo**: `ok=0` con `error` — el timeline la muestra igual) es una fila:
`slot_id`, `filename`, `sha256`, `bytes`, `uploaded_by`, `uploaded_at`, `triggered`, `origen`,
`dup_of`. La **identidad del contenido es el `sha256`** de los bytes — el nombre NO participa (las
copias llegan «… (1) (1).xlsx»). Sobre eso se montan:

- **Dedup por contenido**: antes de aceptar, el admin consulta `findUploadBySha` (la carga original =
  la fila más antigua con `ok=1` y ese sha en el slot); un contenido idéntico queda marcado
  (`dup_of` → el id de la original) y la consola lo advierte («re-procesarlo no cambia el dato»).
- **`id` como ancla**: es la referencia estable que «Revertir esta carga» (#63) usa.
- **Indexado retroactivo** (`intake_backfill`, una vez por slot, lazy y en background): lo ya
  procesado en `_processed/` antes de existir el registro se indexa como `origen='retro'` —
  participa del dedup, no de la Actividad. Además, una migración one-shot importa los eventos
  `type:'intake'` del audit log (condición: tabla vacía → idempotente entre reinicios).

El reparto de responsabilidades no cambia: el **audit log** hash-encadenado sigue siendo la
**evidencia**; el registro es el **índice consultable** (y el dedup) — por eso vive acá, indexado
por `(slot_id, sha256)` y `(slot_id, uploaded_at)`.

### Registro de reversiones — `intake_revert` (issue #63)

Una reversión ejecutada es un **hecho de Vergis** — quién revirtió qué, cuándo y con qué resultado
por clave —, no del convertidor: el mapeo carga→claves sigue viviendo en `_processed/` (el layout ES
el ledger; el plan de compensación se **deriva** de él, sellado por hash, en
`packages/capabilities/src/intake-revert.ts`). La fila guarda `slot_id`, `upload_id` (ancla a
`intake_upload.id`; ausente si la carga es pre-#62), `filename`, `by_user`, `at`, `resumen` (el plan
**ejecutado** como JSON, incluido lo reportado-sin-tocar: pisada / no-compensable / sin-clave) y
`landing_retirado`. Se registra **al completar**: una ejecución caída a medias converge en la
re-entrada y recién ahí queda escrita (el audit ya recibió el intento). Guard de carrera: con una
conversión en curso, revertir se rehúsa.

### Proyección de ingestión — `ingestion_run` · `ingestion_process_state` (issue #105)

**La memoria del producto sobre el motor.** El lazo de frescura observa el motor cada tick y escribe
la observación por lote (`recordObservations`): corridas (`ingestion_run`, PK `(process_id,
started_at)` — el motor no entrega id de instancia — con poda a `INGESTION_RUN_RETENTION = 60` filas
por proceso) + estado por proceso (`ingestion_process_state`: `schedule_seconds`, `observed_at`,
`last_error`/`last_error_at`). Una observación **fallida registra solo el error** — lo último
conocido queda intacto, y las vistas lo sirven marcado con su edad.

La regla que esto compra: **el request path jamás pega al motor**. Frescura, la vista de Fuentes y el
reporte periódico leen SOLO la proyección (`listRunSnapshots`); con el motor caído siguen sirviendo
lo último conocido. `observed_at = null` es proyección fría (nunca se observó) y no se afirma nada.

## 3 · Dos capas de autorización, ortogonales

El sistema exige **AND** de dos autorizaciones independientes:

1. **Acceso al artefacto** (este doc): ¿puede esta identidad **abrir/configurar** este PI? — por rol +
   visibilidad.
2. **RLS de datos** (Custos): dentro del PI, ¿qué **filas** ve? — data-anchored, push-down nativo.

> **Regla bedrock — sin bypass nunca.** Ser dueño/colaborador da acceso **al artefacto y su config**,
> **jamás eleva** el acceso a datos por encima del grant propio. "Config compartida full; datos siempre
> por RLS." Un PI **público** lo abre cualquiera autenticado, pero **la RLS sigue filtrando filas** —
> público es del artefacto, no del dato.

## 4 · Permisos de PI

### Roles (anidados)

**Visor ⊂ Colaborador ⊂ Dueño.**

| Acción | Visor | Colaborador | Dueño |
|--------|:--:|:--:|:--:|
| Abrir el PI y ver salidas (datos por **su propia RLS**) | ✓ | ✓ | ✓ |
| Ver la config completa (incl. lista de compartido) | ✓ | ✓ | ✓ |
| Editar contenido / **la demanda** de frescura | – | ✓ | ✓ |
| Configurar **visibilidad** (público/privado) | – | – | ✓ |
| Modificar la **lista de compartido** | – | – | ✓ |
| **Otorgar/transferir ownership** | – | – | ✓ |

- **Colaborador = mismos privilegios de gestión que el dueño**, salvo las tres palancas de gobierno.
  (En la práctica, los colaboradores son quienes "hacen la pega" del PI.)
- **Multi-dueño:** el creador es dueño y no lo pierde al nombrar a otro. **Anti-lockout:** no se puede
  quitar al último dueño.

### Visibilidad

- **Privado:** solo dueño + principals de la lista de compartido **abren** el PI.
- **Público:** cualquiera autenticado lo abre — **pero la RLS sigue filtrando filas** (no es bypass).

### Grupos — gestionados por Mira, NO grupos AAD

La **identidad/autenticación** (quién eres, tu correo) viene del **gate** (oauth2-proxy/AAD). Pero los
**grupos y el compartir** se gestionan **in-app, en Mira** — *no* se delega al IdP. Racional: nadie va a
pedirle al **CISO** que habilite el reporte X a los usuarios K y Q; lo gestiona el dueño del PI. Un PI
se comparte con **grupos de Mira** (listas de correos, sembradas de config, editables en Administración)
y/o correos individuales.

### Identidad de desarrollo — `VERGIS_DEV_IDENTITY` (solo dev, fail-safe)

En un despliegue de **desarrollo sin gate** (sin oauth2-proxy delante) ninguna request trae los headers
`x-forwarded-*`, así que la identidad es vacía y toda superficie con scope responde 403 — imposible de
manejar desde el navegador local. `VERGIS_DEV_IDENTITY` inyecta una identidad fija para **manejar Mira y
los PIs desde el browser** sin forjar headers por curl. Formato: `email` o `email:grupo1,grupo2` (los
grupos pueblan el claim `groups`, como lo haría `x-forwarded-groups` en producción).

**Es imposible de activar donde hay gate real** — el requisito de seguridad #1:

| Condición | Comportamiento |
|--|--|
| Env **ausente** | Idéntico a hoy: sin identidad de dev, 403 preservado aguas abajo. |
| Env seteado **∧ SIN** gate real | Se inyecta a las requests **sin** header de gate. Una request **con** header de gate → el header MANDA (permite probar 403/otras identidades por curl). Log de arranque: `⚠ DEV IDENTITY ACTIVA (<email>) — NO USAR EN PRODUCCIÓN`. |
| Env seteado **∧ CON** gate real | **Se ignora** (nunca inyecta). Señal de gate real: `VERGIS_GATE_SECRET` presente (el secreto que comparte oauth2-proxy). Log: `VERGIS_DEV_IDENTITY ignorado: hay gate real`. |

La decisión de activación es pura y testeada (`decideDevIdentity` en `server/config.ts`); la presencia
de `VERGIS_GATE_SECRET` gana **siempre**. Como defensa en profundidad, con `VERGIS_GATE_SECRET` definido
el gate A10 además rechaza (403) toda request sin `x-gate-token` antes de resolver identidad alguna.

### Bandera `--fresh` — store de gobierno limpio (solo el arnés de dev)

El store SQLite de gobierno persiste entre corridas y en desarrollo arrastra sesiones de prueba de
Miranda. `server/serve-rls.ts` acepta `--fresh`: borra el store (`VERGIS_GOVERNANCE_DB`, o
`$VERGIS_OUT/governance.sqlite`) antes de abrirlo, de modo que el arranque lo recrea vacío. **Sin la
bandera, el comportamiento es el de hoy** (el store se conserva — `--keep` implícito, aceptado y sin
efecto).

**Borrar un store de producción es imposible por construcción**: el borrado exige exactamente la misma
señal de «esto es dev» que gobierna `VERGIS_DEV_IDENTITY`.

| Condición | Comportamiento |
|--|--|
| Sin `--fresh` | El store no se toca. |
| `--fresh` ∧ **CON** gate real (`VERGIS_GATE_SECRET`) | **Se rehúsa.** Log: `--fresh IGNORADO: hay gate real…`. |
| `--fresh` ∧ **sin** identidad de dev activa (`VERGIS_DEV_IDENTITY`) | **Se rehúsa.** Log: `--fresh IGNORADO: no hay identidad de dev activa…`. |
| `--fresh` ∧ dev-identity activa ∧ sin gate real | Borra el store y lo recrea. Log: `⚠ --fresh (DEV): store de gobierno BORRADO…`. |

La decisión es pura y testeada (`decideFreshStore` en `server/config.ts`). Ambas negativas son
fail-safe: ante duda, se conserva el store.

### Bootstrap del ownership

El **dueño inicial** de un PI se siembra de config de instancia (hoy: el dueño del ticket de gestión
externo; a futuro, la creación nativa en Mira hace dueño al creador). El dueño **no va en el spec** (el
spec es authz-blind). Un PI sin dueño-semilla queda **default-deny** (solo admins lo gestionan hasta
asignarlo) — nunca "huérfano abierto".

## 5 · Rol admin de plataforma

Distinto del ownership de un PI: el **admin** opera el ambiente de Administración (data maestra, grupos,
fuentes). Se siembra de `VERGIS_ADMIN_SEED` (rompe el bootstrap) y se gestiona in-app (sección Usuarios y
Roles). Es autz de **acción**, no de fila. El admin es **override** de gestión sobre cualquier PI (para
poder asignar dueños), pero su acceso a **datos** sigue gobernado por RLS.

**La autoridad se otorga y se quita, y ninguna de las dos exige reiniciar** (issue #182). Un admin
**sembrado** se da de baja in-app como cualquier otro: la baja deja **tombstone** en
`admin_seed_removed` y el re-sembrado del arranque siguiente **no lo resucita**, aunque el email siga
declarado en `VERGIS_ADMIN_SEED`; un alta posterior limpia el tombstone (es la misma precedencia
runtime-sobre-semilla de los grupos y del registro de fuentes, abajo). El **único** lockout es
quedarse sin administradores: quitar al último se rechaza con `AdminLockout` → HTTP 409. La UI
advierte el **drift** cuando la identidad revocada sigue en el env — la baja no depende de editar la
config, pero el operador tiene que enterarse de que estado y config dicen cosas distintas.

## 6 · Aplicación de la RLS (cómo se gobierna una tabla servida)

El **gate fail-closed**: un PI **no se sirve** a menos que **cada tabla que toca** tenga su artefacto de
autorización nativo. En push-down (Fabric) eso es una **`SECURITY POLICY`** habilitada; sin artefacto,
una tabla devolvería todas sus filas → fuga. "Sin artefacto" = bug, no "público".

- **Tabla gobernada por RLS:** `SECURITY POLICY` con predicado-filtro por la clave de gobierno
  (data-anchored).
- **Tabla pública gobernada** (`grant: all`): artefacto **allow-all** — función `RETURNS TABLE ... SELECT
  1` sin `WHERE`, `STATE=ON`. La fila siempre pasa, pero la tabla **queda declarada** (el gate la ve).
  Patrón en `deploy/fabric-pushdown/secpol-*.sql`, aplicado por `scripts/apply-*-rls.mjs`.

> **El gate verifica `sys.security_policies` por conexión (`database_ref`).** Una tabla servida por un PI
> debe tener su policy **en el endpoint que la conexión consulta**. Si el PI lee de varias DBs, cada una
> necesita su artefacto y, si es otra DB, su propia conexión registrada. (Verificar la topología real —
> qué store/motor lee cada PI — antes de tocar; es dato de instancia, no asumible.)

## 6·bis · Control por COLUMNA — dos mecanismos, y el orden que hay que respetar

La RLS de §6 esconde **filas**. Cuando el terreno ancho trae una columna que no todos pueden ver
(un RUT, una remuneración), el control es por **columna**, y el compilador emite **dos artefactos
que no son redundantes** — cada uno cubre lo que el otro no:

| Artefacto | Discrimina por | Cubre |
|---|---|---|
| **DDM** (`ADD MASKED WITH`) — vive en la columna | el permiso **`UNMASK` del principal** | el **rodeo**: quien esquive la vista y consulte la tabla directa |
| **Vista de máscara** (`vw_mask_<tabla>`) — `CASE` por request | el **claim del sujeto**, vía `SESSION_CONTEXT` | que la columna se sirva **a quien corresponde**, no a un principal entero |

Que el consumidor consulte la vista y no la tabla es decisión de **arquitectura de instancia** (qué
objeto nombra el spec), no del emisor: el compilador la emite y la declara.

> ⚠ **Medido contra Fabric el 2026-08-16: la vista de máscara NO SIRVE en Fabric Warehouse.** El
> `CREATE VIEW` se acepta y `sys` la lista, pero **todo `SELECT` sobre ella falla** con
> `Unsupported data type error` — la causa, aislada con tres controles, es `SESSION_CONTEXT()`
> **dentro de un `CASE`** sobre un scan de tabla. Todo lo que esta sección dice del artefacto
> «vista de máscara» describe su **diseño**, y ese diseño **está abierto**: ver **#197**. Lo que
> sigue vigente sin reservas es el DDM y todo lo de `SCHEMABINDING`.
>
> Corolario que la sección no tenía: **que el motor acepte el DDL no significa que el artefacto
> sirva.** La verificación de un artefacto lo **consulta**; mirar `sys` no alcanza.

### La dependencia que decide si la capacidad sirve

**La rama «en claro» de la vista de máscara lee la columna base**, y esa columna tiene DDM. Medido:

- Si el principal de serving **no tiene `UNMASK`**, esa rama recibe el default del DDM ⇒ **ni el
  sujeto con el claim ve el valor**. La capacidad queda degradada a «esta columna no se sirve a
  nadie»: es seguro, pero no es lo que se pidió.
- Si **lo tiene**, la vista discrimina por claim como se diseñó — y el DDM queda **inerte para ese
  principal**, que es lo esperable: su papel es cubrir a los demás.

**En Fabric hoy no ocurre ninguna de las dos**, porque la vista no se puede consultar (#197). La
disyuntiva de arriba describe la semántica T-SQL, que es donde se midió.

**Qué decide `UNMASK` en Fabric, medido el 2026-08-16:** el **rol del workspace** del principal.
Con rol `Member` el service principal lee el valor **real** de la tabla; con rol `Viewer` lee la
máscara. Dos advertencias que van con el dato: vale para **ese SKU y ese rol** —un positivo de
Fabric no se generaliza a otra instancia—, y **revocar un rol no toma efecto de inmediato** (se
sondeó 6,5 min tras bajar de `Member` a `Viewer` y el principal seguía viendo el valor real; qué
destraba la revocación **no está medido**).

**Control obligatorio al verificarlo en una instancia**, en la misma sesión: una consulta a la tabla
**sin** la vista. Sin él, un negativo no distingue «al principal le falta el permiso» de «la vista no
se aplicó».

### El orden importa: `SCHEMABINDING` inmoviliza la columna (medido)

Un objeto `SCHEMABINDING` que referencia la columna la deja **inmutable**: ni `ADD MASKED` ni
`DROP MASKED` pasan mientras exista. Es el caso de las **vistas-contrato**.

**No es incompatibilidad — es orden**, y esa salida está corrida, no supuesta:

1. la máscara sobre una columna libre se acepta;
2. la vista-contrato se crea **después**, sobre la columna ya enmascarada, y también se acepta;
3. lo imposible es alterar la columna con el objeto ya atado.

Por eso el setup emite un **preflight** que diagnostica antes de intentarlo, **nombra** los objetos
que atan la columna y falla ruidoso (`RAISERROR` 16). Falla a propósito y no avisa: el plano de
**fila** ya quedó instalado —va antes en el setup—, así que lo que corta es exactamente el plano de
columna. Un install parcial y silencioso es lo que produjo el defecto que esto corrige.

> **Cómo se mide todo lo anterior sin Fabric:** `npm run lab:up && npm run lab:proof` levanta un motor
> T-SQL real en contenedor y aplica **el DDL que emite el compilador**. Ver
> [`scripts/README-tsql-lab.md`](../scripts/README-tsql-lab.md), incluida la asimetría al citar sus
> resultados: un **negativo** refuta también para Fabric; un **positivo no garantiza** el SKU.

## 7 · Para agentes — el contrato

1. **Tres estados, tres lugares.** Datos→engine · spec→archivos authz-blind · gobierno→`GovernanceStore`.
   No metas gobierno en el spec ni en el data engine.
2·bis. **El control por columna son DOS artefactos y un orden.** DDM cubre el rodeo, la vista de
   máscara honra al sujeto, y sin `UNMASK` en el principal de serving la columna no se sirve a nadie.
   Un objeto `SCHEMABINDING` inmoviliza la columna: la máscara va **antes** que él (§6·bis).
2. **AND de dos autorizaciones, sin bypass.** Acceso-al-artefacto Y RLS-de-filas. Jamás abras una vía que
   eleve datos por colaboración/ownership. "Público" no abre datos: la RLS sigue.
3. **Grupos en Mira, no en AAD.** Para compartir, usa grupos de Mira / correos; no asumas que la
   membresía vive en el IdP.
4. **Default-deny.** PI sin gobierno declarado → no se sirve (solo admins). Tabla sin policy → no se
   sirve. La ausencia de autorización **es** falta de autorización.
5. **Verifica topología antes de desplegar.** Hoy un PI puede leer un lakehouse o un **warehouse**, en un
   workspace propio; el shortcut/cross-db es Fabric-only. Confirma contra la config real (`VERGIS_CONNECTIONS`)
   dónde lee cada PI antes de aplicar policies o reconvertir specs.

## 8 · Estado de implementación

| Pieza | Estado |
|-------|--------|
| `GovernanceStore` (admins + grupos + ACL/ownership + demanda + fuentes) | ✅ construido |
| `pi-authz` (roles, `effectiveRole` componiendo visibilidad+grants) | ✅ |
| Gate de artefacto en el server (flag `VERGIS_PI_ACL`, bootstrap lazy) | ✅ (lógica unit-tested) |
| UI Administración (data maestra, roles, grupos) + config por-PI | ✅ |
| Aplicación de RLS allow-all (secpol + apply-*-rls) | ✅ patrón vivo |
| `platform_setting` (título editable, settings de notas, estado de lazos) | ✅ |
| Registro de cargas + dedup por contenido + indexado retroactivo (#62) | ✅ |
| Registro de reversiones + «Revertir esta carga» (#63) | ✅ |
| Proyección de ingestión (corridas + schedule, lazo de frescura) (#105) | ✅ |
| Gestión in-app del registro de fuentes (`managed_at`, tombstones, pausa) (#107) | ✅ |

> Instancia de referencia (beta): Grupo Hijuelas — `arbol-lab/work/038`. Diseño detallado allí; esta es
> la spec canónica genérica.
