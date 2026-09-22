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
`VERGIS_PI_OWNERS` · `VERGIS_NOTIFY` (+ `VERGIS_PUBLIC_URL`) · `VERGIS_MENU` · `VERGIS_STATIC`. Fail-closed y **fatal**
(issue #117): un YAML declarado que no parsea o perdió su clave raíz tumba el arranque nombrando ENV +
ruta + clave, en vez de degradar en silencio.

`VERGIS_MENU` gradúa esa dureza en su segundo nivel, y a propósito: la clave raíz ausente sigue siendo
fatal, pero una **sección o un enlace** inválidos se omiten con aviso nombrado y el nodo levanta. Un
ítem de menú mal escrito no vale el costo de dejar la plataforma sin servir.

**Y el menú se recarga en caliente** (`CAP-194`): `VERGIS_MENU` es un slice de `RELOADABLE_SLICES`, así
que el watch de config de instancia —y `SIGHUP`— lo re-parsean y **spliceean** el arreglo vivo de
secciones sin recrear el proceso. Editar el YAML cambia el menú que sirven el catálogo y `/admin`.
El splice no es estilo: el cableado de `/admin` captura esa referencia al arranque, y reasignar la
propiedad dejaría un menú distinto según la pantalla.

La regla de fallo de la recarga es la de todos los slices: **una recarga jamás tumba el nodo**. Si el
archivo no parsea, perdió su clave raíz o está a medio escribir, se **conserva lo vigente**, se avisa
por log con el motivo y `/contrato` registra la recarga como `ok:false` (el archivo de disco queda
`pending`). El arranque no cambia: ahí la clave raíz ausente sigue siendo fatal.

### El nodo sirve el contenido estático de la instancia (`VERGIS_STATIC`, `CAP-195`)

Una instancia declara **colecciones de archivos estáticos** y **el nodo las sirve**, bajo el mismo gate
que ya protege el catálogo:

```yaml
static:
  - path: ayuda            # prefijo público: /ayuda/
    dir: /static/ayuda     # directorio DENTRO del contenedor (bind de la instancia)
    label: Portal de ayuda # opcional: para el log de arranque y el contrato del nodo
  - path: datadoc
    dir: /static/datadoc
```

**¿Por qué está en el Producto y no en el borde?** Porque publicar una página no debería tocar el
borde. Antes, cada colección costaba un montaje en el compose, un bloque de proxy con su
`forward_auth` copiado, una familia en la sonda de paridad, y el riesgo de que el borde quedara
sirviendo algo que nadie declaró. El caso que lo cerró es del 2026-09-21: el portal de ayuda de una
instancia dio **404 al usuario** porque el Caddyfile se monta como bind de **archivo** y el despliegue
lo reemplazó con `mv` —que cambia el inodo—, así que el contenedor siguió sirviendo el anterior y
`caddy reload` releyó el viejo sin avisar. La lección no es «montar por directorio»: es retirarle al
borde una responsabilidad que el nodo puede tener.

**Autorización: la del catálogo, ni más ni menos.** Cualquier identidad autenticada que el gate ya
dejó entrar ve el contenido — exactamente lo que daba el `forward_auth` que esta capacidad retira, así
que no cambia quién ve qué. La **autorización por grupo es una extensión futura** y deliberadamente no
se construyó a medias: media autorización es peor que ninguna, porque invita a confiar en ella. El día
que se construya, su forma natural es un `grant:` por colección resuelto contra los mismos grupos del
gobierno, con `default-deny` y sin inferir identidad.

**`path` es un prefijo reservado, validado al cargar**: minúsculas, dígitos y guiones
(`^[a-z0-9][a-z0-9-]*$`), sin chocar con una ruta propia del nodo (`healthz`, `contrato`, `admin`,
`oauth2`, `config`, `miranda`, `impresiones`) ni repetirse. Lo que no pasa se **omite con aviso
nombrado** y el nodo levanta igual, misma graduación que el menú.

**La colisión con el slug de un Let es la peligrosa, y la gana el Let.** El dato gobernado manda: una
colección cuyo prefijo es el slug de un Let servido se omite nombrando el choque, y el PI conserva su
ruta. El desempate se resuelve contra el catálogo **vivo** en cada request —un spec entra y sale en
caliente—, no contra una lista de arranque.

**Servir es de solo lectura y sin sorpresas**: solo `GET`/`HEAD` (un `POST` es 405, no 404); la ruta se
decodifica y se resuelve contra la raíz declarada, y se verifica que el resultado siga dentro
**léxicamente** y **sobre el camino real** (`realpath`) — `..`, `%2e%2e%2f` y un symlink que escapa dan
**403**; un directorio se sirve con su `index.html` y da 404 si no lo tiene (jamás un listado);
`Content-Type` por **lista blanca** de extensión (`.html .css .js .json .svg .png .jpg .jpeg .gif
.webp .woff2 .txt .pdf .ico`) y `application/octet-stream` para todo lo demás, siempre con
`X-Content-Type-Options: nosniff`.

**Los archivos se leen por request**, sin caché en memoria ni fingerprinting: actualizar el contenido
es copiar el archivo, y ésa es justamente la propiedad que se busca. El HTML sale `cache-control:
no-cache`; `immutable` no se usa porque prometería lo que no hay.

**Se recarga en caliente** como el menú: `VERGIS_STATIC` es un slice de `RELOADABLE_SLICES`, el watch de
config de instancia y `SIGHUP` re-parsean el archivo y **spliceean** el arreglo vivo de colecciones sin
recrear el proceso. Una recarga inválida **conserva lo vigente**.

**El contrato del nodo (`GET /contrato`) las declara**, con el veredicto de disco del instante:
`path`, `dir`, `exists`, `readable` y `shadowedByLet`. Un `dir` declarado que no existe **no impide
arrancar** y **no se omite**: suele ser un bind-mount que aparece después, así que la colección queda
declarada, el arranque emite su aviso, el contrato la marca `exists:false` y servir desde ella responde
404 hasta que el directorio aparezca.

**Qué NO hace:** no **genera** contenido —eso es `CAP-197`, abajo—, no autoriza por grupo y no cachea.

### El nodo genera el catálogo del esquema: el Datadoc (`VERGIS_DATADOC`, `CAP-197`)

Un consumidor que se conecta a un Datahouse necesita saber qué hay, qué significa, de dónde viene y
cada cuánto cambia. Ese catálogo **se genera, no se escribe**: uno escrito a mano se pudre en semanas,
y la medición que lo demuestra ya se pagó una vez (seis contradicciones entre los registros de una
instancia y su catálogo vivo).

**Opt-in.** Sin `VERGIS_DATADOC`, la superficie del nodo es exactamente la de antes de la capacidad:
ninguna ruta, ningún lazo, ninguna sección de administración ni de contrato. Con la env y un motor que
no es `fabric`, el arranque **falla nombrando las dos**: la introspección es `INFORMATION_SCHEMA` +
`sys.*` de un SQL endpoint, y degradar en silencio dejaría un botón incapaz de funcionar.

#### ¿De qué se hace?

| Insumo | De quién es | Qué aporta |
|--|--|--|
| Catálogo vivo de cada conexión | Medido por el nodo | Qué existe, su forma, su gobierno, el linaje vista→base (de `sys`, no de un regex) |
| Specs de los PI | Ya lo tiene el nodo (`discover()`) | Quién **lee** cada tabla — la misma extracción del gate de gobernanza |
| Registro de fuentes (`VERGIS_SOURCES`) | Ya lo tiene el nodo | De dónde proviene la tabla y con qué cadencia |
| **Registro de escritores** (`VERGIS_WRITERS`) | Declara la instancia | Quién **escribe** cada tabla, con qué disparo. No hay forma de medirlo |
| **Diccionario semántico** (`VERGIS_SEMANTICA`) | Declara la instancia | Qué **significa** cada tabla y cada columna. El catálogo SQL no lo trae |

Los dos YAML nuevos entran en `RELOADABLE_SLICES` por la misma puerta que el menú y los estáticos:
editar el archivo y regenerar produce el catálogo nuevo **sin recrear el proceso**. Sus ejemplos
completos están en `examples/instance/`.

**La unidad de medición es la conexión, no el dominio.** El dominio es una **etiqueta declarada** que
agrupa conexiones (`domains[].connections`, ver [`gestion-de-dominio.md`](gestion-de-dominio.md)); sin
ella el catálogo sale igual, con cada conexión como **dominio técnico** rotulado por su
`database_ref`. Nada se infiere por parecido de nombre.

#### ¿Qué pasa cuando falta algo? (nunca se inventa)

Sin escritores, «escritor no declarado». Sin diccionario, «sin descripción». Una conexión que hoy no
respondió **conserva su medición anterior** y el sitio la marca «NO medida en esta corrida», con la
fecha vieja y el motivo, en la portada, en su dominio y en cada una de sus entidades — desaparecerla
afirmaría que no existe, que es más fuerte y más falso que «hoy no la pude mirar». Una conexión
declarada y jamás medida aparece igual en el sello. Un sub-error (`sys.security_policies` denegada al
Service Principal) **no invalida la conexión**: se declara, y todas sus tablas quedan con gobierno
`indeterminada`.

**La clasificación de una entidad sale de hechos medidos**: `publicado` = es una vista · `interno` =
tiene lector, escritor vigente o política · `deuda` = nada de lo anterior. Las convenciones de nombre
de una instancia (`_bak_*`, `raw_*`, prefijos de plataforma) **no entran al motor** —son su alfabeto,
no el del Producto— y se expresan con `clase:` por entidad en el diccionario semántico.

#### Los conteos de filas: solo donde la RLS no filtra

Un catálogo describe el esquema, no sirve datos — pero un `COUNT(*)` sobre una tabla gobernada **es**
información que la autorización por fila protege: cuántos registros hay del área que no me
corresponde. La regla:

| Gobierno medido de la tabla | ¿Se pide el `COUNT_BIG`? | Qué muestra la página |
|--|--|--|
| Sin política | Sí | El número |
| Política con predicado **allow-all** (forma exacta) | Sí | El número |
| Política con predicado **que filtra** | **No** | «no medidas (tabla gobernada por RLS con filtro)» |
| Política con función **no localizada** | **No** | «no medidas (gobierno indeterminado: no se pregunta)» |

La protección es **no preguntar**, no «confiar en que la respuesta venga filtrada»: si el Service
Principal del nodo estuviera exento del predicado —algo **no verificado** en Fabric—, la respuesta
llegaría completa. Que el generador mida con una identidad **sin claims** es defensa en profundidad,
no la regla. El operador puede además apagarlos del todo desde `/admin/datadoc`.

⚠ **La clasificación es por la forma COMPLETA de la definición, jamás por substring.** Está medido
contra el compilador de políticas: el literal `SELECT 1 AS vergis_allowed` se emite en **las dos**
ramas —la allow-all, sin `WHERE`, y la filtrada, con él—, así que un substring marcaría toda tabla con
RLS real como abierta y publicaría su conteo.

**Y un build rancio tampoco los publica.** El Producto **no aplica** las políticas; las aplica la
instancia, cuando quiere. O sea que una tabla puede pasar de abierta a gobernada sin que el nodo se
entere, y el build cacheado seguiría publicando un número que dejó de ser legítimo. Por eso la recarga
de gobierno marca el catálogo como **rancio** y lo vuelve a dibujar **sin conteos**, desde los modelos
ya medidos y sin tocar la red; la página lo declara y la marca se retira con la próxima generación.
Sin este eslabón, el default sería una ventana que se abre sola.

#### Read-only, y la protección es del generador

El conector del nodo **no tiene** guard de solo lectura. El generador pone el suyo: cada consulta pasa
por `guardSoloLectura` antes de tocar la red (solo `SELECT`/`WITH`, una sentencia, lista cerrada de
verbos prohibidos tras pelar comentarios y literales), todas las consultas son literales del módulo
—guardadas al **cargarlo**, así que un verbo introducido por una edición futura tumba el import y no
una corrida de producción— y el único identificador interpolado se valida por parte.

**Los esquemas entran por LISTA BLANCA** (`dbo` por defecto), no por lista negra. Medido: un warehouse
de Fabric puede traer un esquema `queryinsights` con el historial de consultas de todos los usuarios,
que un `NOT IN ('sys','INFORMATION_SCHEMA')` deja pasar y el catálogo publicaría como entidades; y el
conjunto de esquemas de plataforma que puede aparecer no se conoce de antemano.

#### ¿Cómo se sirve y cómo se dispara?

El sitio se sirve en **`/datadoc/`** por el **mismo** `resolveStatic` de `CAP-195`: misma contención de
ruta, misma lista blanca de tipos, `nosniff`, lectura por request y la misma autorización (la del
catálogo). Es una **colección propia del nodo** y no una entrada de `VERGIS_STATIC` porque el
directorio de salida es estado del Producto bajo `VERGIS_OUT`: si lo declarara la instancia, tendría
que conocer el layout interno del nodo y se rompería el día que ese layout cambie, sin que el Producto
pueda avisar. Mientras la capacidad está encendida, el prefijo `datadoc` queda **reservado** y una
colección de instancia con ese nombre se omite con aviso. Sin un solo build, la ruta responde una
página del nodo que dice **«aún no generado»** y apunta a Administración — un 404 pelado diría «esto no
existe», que es otra cosa.

La caché vive en `$VERGIS_OUT/datadoc/`: `modelo/<ref>.json` por conexión (por eso regenerar una no
obliga a re-medir las demás), `sello.json`, builds `build-<ts>/` inmutables y `current` como symlink
relativo que se mueve con `rename(2)`. Se conservan los dos últimos builds; la poda nunca toca nada
fuera de `build-*` ni el que `current` está sirviendo.

Se dispara desde **`/admin/datadoc`** (estado, «Generar» todo o una conexión, schedule y política de
conteos), con CSRF y auditoría, **una sola corrida en vuelo**, y opcionalmente por el lazo `datadoc`
(chequeo cada 5 min; la cadencia real la fija el operador). La generación escribe en `VERGIS_OUT`, que
es sustrato **compartido** entre los nodos de un anillo: **la corre el que tiene el plano de control y
nadie más** — el router rechaza con 409 toda mutación en standby, y el orquestador lo re-verifica
porque el lazo no pasa por el router. `GET /contrato` publica el build vigente, el sello por conexión,
el schedule y la marca de rancio.

**Qué NO hace:** no cambia `resolveStatic` ni las reglas de `CAP-195`; no cachea el sitio en memoria;
no agrega la entrada al menú del avatar (eso lo declara la instancia con `VERGIS_MENU`); y no admite
HTML en el diccionario semántico — todo se escapa y solo se admite el acento grave, porque un YAML de
instancia no es un canal para inyectar marcado en una página que el nodo sirve bajo su propio gate.

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
   `serving` de `degraded` con conteos por Let (`{ lets: { total, serving } }`).

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
