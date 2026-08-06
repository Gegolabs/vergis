# Arquitectura multi-reporte — un despliegue, N Productos de Información

> **Documentación canónica del Producto.** Cómo una sola instancia del servidor
> (`server/serve-rls.ts`) hospeda N Productos de Información (PIs): de dónde salen los specs, cómo se
> rutea cada PI, qué comparten entre sí y qué es estrictamente por-PI. Comportamiento **genérico**,
> independiente de instancia. Complementa [`gobierno-permisos.md`](gobierno-permisos.md) (el modelo de
> autorización) y [`frescura-oferta-demanda.md`](frescura-oferta-demanda.md).

## 1 · El modelo: un nodo, N PIs, render por consumidor

Un despliegue de Vergis/Mira es **un proceso** (`server/serve-rls.ts`, elegido por la imagen con
`VERGIS_RLS=1`) que sirve **N Productos de Información** ruteados por `/<slug>`, con un **índice
per-consumidor en `/`**. Cada PI es un **spec authz-blind** (un YAML del DSL de Mira): el spec declara
el *qué* —estructura, queries, vistas— y **jamás** el *quién*. La autorización vive **atada al dato**
(policy store + RLS del motor) y en el **store de gobierno** (ACL de artefacto), nunca en el spec.

La imagen es **genérica y agnóstica de instancia**: specs, políticas, conexiones y config de gobierno
entran **por entorno**. Desplegar un PI nuevo es agregar un archivo, no construir una imagen.

## 2 · ¿Cómo se resuelve la ruta al spec?

Dos formas, excluyentes en precedencia, ambas en `specPaths()` (`server/serve-rls.ts`):

| Env | Semántica |
|-----|-----------|
| `VERGIS_SPECS_DIR` | **Directorio escaneado**: todo archivo `*.yaml`/`*.yml` no oculto (no empieza con `.`), en orden alfabético. La forma preferida: un spec nuevo copiado al directorio **entra en caliente** (ver §6). |
| `VERGIS_SPECS` (o su alias `VERGIS_SPEC`) | **Lista explícita** de rutas separadas por comas. |

Sin ninguno de los dos, el arranque **lanza** (`Falta VERGIS_SPECS_DIR o VERGIS_SPECS.`).

### ¿Qué hace el descubrimiento con cada spec?

`createDiscovery` (`server/discovery.ts`) produce el catálogo de PIs servibles. Por cada ruta:

1. **Parsea** el spec (`parseSpec` de `@vergis/mira`). Un spec que no parsea **se omite** en silencio
   del catálogo (no tumba a los demás).
2. **Filtra por servibilidad de capability**: TODAS las data-capabilities del spec deben estar en el
   **catálogo de serving del motor activo** — `execute-sql-dwh` con `VERGIS_ENGINE=fabric`,
   `execute-sql-ch` con `clickhouse` (constante `SERVING_CAPS` en `serve-rls.ts`). Un spec con una
   capability fuera del catálogo se omite con log (`no servible bajo engine=…`). Esto es hardening:
   por construcción no existe vía de servir dato no-gobernado.
3. **Extrae las tablas** que cada query toca (`analyzeSqlTables`, `server/sql-tables.ts`) — el insumo
   del gate de gobernanza. En fabric, una referencia **sin esquema** (`FROM dim_area` a secas) no es
   verificable contra el policy store → el PI se omite con instrucción de calificarla (fail-closed).
4. **Deriva la identidad de ruteo**: `code = identity.code ?? identity.id` y
   `slug = slugify(code)` (minúsculas, sin acentos, no-alfanumérico → `-`). Dos specs que colisionan
   en slug se detectan y avisan: el segundo queda inalcanzable (el router resuelve el primero).
5. **Registra las conexiones** (`database_ref`) que el PI referencia — la verificación de
   servibilidad por-PI consulta SOLO esas (issue #52).

La salida se **memoiza** (`createCachedScanner`, `server/hot-reload.ts`) y se invalida al editar
specs o al recargar gobierno (`discovery.rebuild()`, validate-before-swap).

### ¿Cómo rutea un request?

El router (`createRequestHandler`, `server/routes.ts`) despacha en este orden: `/healthz` (sin gate) →
gate `x-gate-token` (A10, opt-in por `VERGIS_GATE_SECRET`) → `/admin` → `/<slug>/config` →
`/miranda` → `/impresiones` → gate `ready` (solo arranque en frío) → rutas de notas por-PI →
**índice `/`** → `/<slug>/pdf` → **slug-lookup**: `all.find((r) => r.slug === slug)` sobre el
catálogo descubierto. El índice tiene un atajo: si la identidad ve **exactamente un** PI, `/`
renderiza ese PI directo, sin catálogo.

## 3 · ¿Qué aísla a un PI de otro?

El aislamiento **no** es de proceso ni de red — los N PIs comparten el nodo. Es de **autorización,
servibilidad y estado**, aplicado por-PI:

- **Render por consumidor.** Cada request renderiza el PI **bajo la identidad del consumidor**
  (`runPi` en `serve-rls.ts`): los claims del gate se inyectan en cada query y la RLS del motor
  filtra las filas. Dos consumidores del mismo PI ven documentos distintos.
- **Visibilidad del índice.** `/` lista solo los PIs que la identidad puede abrir: por **acceso a
  datos** (`visibleFor` en `discovery.ts`: alguna tabla del PI le devuelve algo) o, con
  `VERGIS_PI_ACL` encendido, por la **ACL de artefacto** del PI (`piManagementRole` →
  `effectiveRole`, ver [`gobierno-permisos.md`](gobierno-permisos.md) §4).
- **Servibilidad por-PI** (engine=fabric, issue #52). El veredicto de «¿cada tabla que este PI toca
  tiene su RLS nativa?» es **por slug** (`piState`, poblado por `verifyFabricServability` en
  `server/engines/fabric.ts`): un PI que no verifica responde **503 con motivo en SU ruta** y los
  demás siguen sirviendo. Un PI recién agregado nace fail-closed («pendiente de verificación») hasta
  la próxima pasada. En clickhouse la réplica es una sola y el estado es global (`ready`).
- **Gobierno por-PI.** Visibilidad (público/privado), grants (dueño/colaborador/visor) y demanda de
  frescura viven **por código de PI** en el store de gobierno (`pi_governance` / `pi_grant` /
  `pi_demanda`), editables en `/<slug>/config` (`server/pi-config.ts`, gateado por rol del PI, no
  por admin).
- **Caché nunca compartida entre consumidores.** El caché de resultados (opt-in por
  `VERGIS_DATA_CACHE_TTL_MS`, `withResultCache` de `@vergis/botler`) forma su clave con params +
  usuario + claims normalizados: un hit devuelve solo lo que **esa misma identidad** ya obtuvo del
  motor enforcing.
- **Corte as-of por-PI** (issue #108): el header de datos se deriva de las **tablas de ese PI**
  (`asOfFor(report.tables)`), no de un estado global del nodo.

## 4 · ¿Qué comparten todos los PIs del nodo?

**El motor (conector de serving).** Un único `servingCap` por nodo — la Capability de query
*enforcing* del motor activo:

- `VERGIS_ENGINE=clickhouse` (default, motor B): la fuente no tiene RLS → se replica a un store
  ClickHouse gobernado con ROW POLICY (bootstrap + ingesta, `VERGIS_DATASETS` +
  `VERGIS_CH_URL`/`_ADMIN_USER`/`_ADMIN_PASS`/`_CONSUMER_USER`/`_TARGET_ROLE`, re-ingesta por
  `VERGIS_REFRESH_MS`).
- `VERGIS_ENGINE=fabric` (motor C, push-down): la fuente ya tiene la RLS nativa (SECURITY POLICY)
  → se consulta directo por `execute-sql-dwh`, que inyecta los claims con `sp_set_session_context`.

Las **conexiones** (`VERGIS_CONNECTIONS`, JSON inline o archivo montado — preferible: secretos fuera
de `/proc`, y habilita hot-reload) son un mapa `database_ref → perfil` compartido: cada data-entry de
cada spec elige su `database_ref`. Las **inyecciones de claims** del conector son la **unión** de los
claims de todas las políticas gobernadas del nodo.

**El policy store** (`VERGIS_POLICIES`): la autorización data-anchored, común porque está atada a las
**tablas**, no a los PIs — dos PIs que leen la misma tabla quedan bajo la misma política.

**La identidad.** Una sola resolución para todo el nodo (`createIdentity`, `server/identity.ts`): el
gate (oauth2-proxy/AAD) autentica y adjunta `x-forwarded-*`; `VERGIS_GATE_CLAIMS` mapea claim →
cabecera (default `groups:x-forwarded-groups`); `VERGIS_IDENTITY_MAP` opcionalmente enriquece claims
desde un directorio (email → claims, fail-closed: email no mapeado → deny). `VERGIS_GATE_SECRET`
(A10) exige además el token del proxy en cada request salvo `/healthz`.

**El gobierno.** UN `GovernanceStore` por nodo (`VERGIS_GOVERNANCE_DB`, default
`$VERGIS_OUT/governance.sqlite`): admins, grupos de Mira, ACL/demanda por-PI, settings de plataforma,
registro de fuentes, registro de cargas y proyección de ingestión — el detalle completo en
[`gobierno-permisos.md`](gobierno-permisos.md). Las superficies compartidas que lo usan:
`/admin` (Administración), el lazo de frescura (#105), el reporte periódico (#102) y Miranda.

**La config declarativa de instancia** (`loadInstanceConfig`, `server/instance-config.ts`):
`VERGIS_MASTER_DATA` · `VERGIS_GROUPS` · `VERGIS_DOMAINS` · `VERGIS_INTAKE` · `VERGIS_SOURCES` ·
`VERGIS_PI_OWNERS` · `VERGIS_NOTIFY` (+ `VERGIS_PUBLIC_URL`). Fail-closed y **fatal** (issue #117):
un YAML declarado que no parsea o perdió su clave raíz tumba el arranque nombrando ENV + ruta +
clave, en vez de degradar en silencio.

**Servicios transversales**: el audit log append-only (`$VERGIS_OUT/admin-audit.log`), la capa de
notas (store propio `VERGIS_NOTES_DB`, no-fatal), el branding del catálogo (`VERGIS_INDEX_TITLE` /
`VERGIS_INDEX_LOGO`, con el título **editable in-app** vía el setting `index_title` — ver
[`gobierno-permisos.md`](gobierno-permisos.md)), el sidecar de PDF (`VERGIS_PDF_SERVICE_URL`) y el
secreto CSRF de las superficies de gestión (`VERGIS_CSRF_SECRET`).

### ¿Qué NO se comparte? (resumen)

| Por nodo (compartido) | Por PI (aislado) |
|---|---|
| Motor/conector enforcing + conexiones | Spec (archivo), slug y ruta |
| Policy store (atado a tablas) | Veredicto de servibilidad (fabric, 503 con motivo propio) |
| Resolución de identidad + gate | Visibilidad, grants y demanda (`/<slug>/config`) |
| `GovernanceStore` + `/admin` + audit log | Render (identidad del consumidor) y su caché |
| Config declarativa de instancia | Corte as-of (derivado de SUS tablas) |
| Lazo de frescura · reporte · notas · Miranda | Dueño-semilla (`VERGIS_PI_OWNERS[code]`) |

## 5 · ¿Cómo arranca el nodo?

1. Validación de config (`configFromEnv`) + auto-chequeo de coherencia del despliegue
   (`server/deployment-check.ts`: paths declarados y montados, store persistente; en modo strict,
   aborta).
2. Carga del policy store y creación del descubrimiento (§2).
3. Setup del conector según `VERGIS_ENGINE` (§4).
4. Config declarativa de instancia (fatal, #117) → bloque de administración (no-fatal: si su infra
   falla, queda «administración deshabilitada» y el serving sigue) → capa de notas (no-fatal) →
   Miranda (solo con `MIRANDA_ENABLED`).
5. **El server escucha de inmediato**; el bootstrap del motor corre en segundo plano con **retry
   indefinido y backoff**. `/healthz` responde 503 solo hasta superar el frío; después distingue
   `serving` de `degraded` con conteos por-PI (`{ pis: { total, serving } }`).

## 6 · ¿Qué entra en caliente y qué exige restart?

Con `VERGIS_HOT_RELOAD` (default encendido), `watchPaths` vigila y `SIGHUP` fuerza la recarga:

- **Specs**: editar o **agregar** un spec en `VERGIS_SPECS_DIR` reconstruye el catálogo
  (validate-before-swap: uno roto conserva el catálogo vigente). En fabric, el PI nuevo se
  re-verifica al vuelo — nace fail-closed y se sirve apenas verifica.
- **Políticas** (`VERGIS_POLICIES`): recarga in-place + invalidación del result-cache + re-bootstrap.
  Radio de daño por motor: en clickhouse un re-bootstrap fallido baja `ready` (fail-closed global);
  en fabric solo el PI que no verifica queda bloqueado y los sanos siguen.
- **Gobierno de dominio** (issue #50): conexiones (si son archivo), dominios y slots de ingesta se
  re-parsean con validate-before-swap **por archivo**.
- **Exige restart**: el alta de una **inyección de claim nueva** en el conector (un claim nuevo sin
  inyección queda fail-closed — deny, no fuga) y el cambio de credenciales de un pool ya conectado
  (aplica a conexiones futuras hasta reciclarse).

## 7 · Para agentes — el contrato

1. **Un PI nuevo = un spec nuevo**, no una imagen ni un deploy: cópialo a `VERGIS_SPECS_DIR` y el
   descubrimiento lo sirve (en fabric, tras verificar su RLS).
2. **El slug sale de `identity.code`.** Códigos distintos por spec: una colisión deja al segundo
   inalcanzable (queda avisada en el log, no es error fatal).
3. **El spec es authz-blind.** Nada de dueños, grupos ni políticas dentro del YAML: dueño-semilla en
   `VERGIS_PI_OWNERS`, política en el policy store, ACL en el store de gobierno.
4. **Tablas siempre calificadas** (`schema.tabla`) en los SQL de un spec para fabric: una referencia
   sin esquema hace el PI no-gobernable y se omite.
5. **La degradación es por-PI** (fabric): un 503 en `/<slug>` con motivo no implica nodo caído —
   revisa el motivo en esa ruta y `healthz` para el conteo.
