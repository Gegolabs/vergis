# Plan — El nodo genera el Datadoc (catálogo del esquema de datos de la instancia)

| Campo | Valor |
|--|--|
| **Objetivo** | Que el nodo Vergis **genere** el Datadoc —qué existe en cada Datahouse, qué significa, quién lo escribe, quién lo lee, con qué frescura y bajo qué gobierno— desde sus propios insumos más dos declaraciones nuevas de instancia (`writers.yaml`, `semantica.yaml`), lo cachee en disco con un sello de frescura **por conexión**, lo regenere bajo demanda desde Administración (y opcionalmente por schedule) y lo sirva por la misma vía que `CAP-195` |
| **Origen** | Issue [#304](https://github.com/Gegolabs/vergis/issues/304) con su comentario de curaduría (2026-09-21): el alcance vivo es **la generación**; servir ya está resuelto por `CAP-195` / `VERGIS_STATIC` (0.31.0, #319). Referencia de lo que hoy existe: `lab/scripts/gen-datadoc.mjs` (1.158 líneas, script de instancia A.R.B.O.L.) |
| **Ejecutor** | Subagente Opus en worktree propio sobre `gegolabs/vergis` (`main` en 0.32.0). Rama → PR → CI verde → merge. Este plan es el contrato: se ejecuta **en frío**, sin la conversación que lo originó |
| **Resultado** | Capacidad `CAP-197` en 0.33.0: `VERGIS_DATADOC=1` · `VERGIS_WRITERS` · `VERGIS_SEMANTICA` · `domains[].connections` · `/datadoc/` · `/admin/datadoc` · lazo `datadoc` |
| **Versión de este plan** | 1.1 · 2026-09-21 — cierra la segunda mirada: la clasificación de gobierno era por substring y marcaba toda tabla filtrada como abierta; los esquemas pasan a lista blanca; el build rancio no publica conteos |

## ¿Cuál es la tesis, en cinco líneas?

1. **La unidad de medición es la conexión (`database_ref`), no el dominio.** El nodo ya tiene las conexiones (`VERGIS_CONNECTIONS`) y ya introspecciona `sys` por conexión; el dominio es una **etiqueta declarada** que agrupa conexiones, y sin ella el catálogo se genera igual, una sección por conexión.
2. **Tres insumos ya son del nodo y se reúsan sin copiar**: la introspección por conexión (motor Fabric), las tablas que cada PI lee (`discover()` ya las extrae con `analyzeSqlTables`) y el registro de fuentes (`VERGIS_SOURCES`). **Dos son declaraciones nuevas de instancia** con el mismo patrón que los slices recargables: `writers.yaml` y `semantica.yaml`.
3. **El generador mide por conexión y cachea el modelo medido en disco** (`$VERGIS_OUT/datadoc/modelo/<ref>.json`); el render es una función pura del conjunto de modelos. Por eso el sello de frescura es **por conexión** y regenerar una conexión no obliga a re-medir las demás.
4. **La salida se sirve por la misma vía que `CAP-195`** —el mismo `resolveStatic`, la misma contención, la misma lista blanca, la misma autorización— como una **colección propia del nodo** en `/datadoc/`, no como una colección que la instancia tenga que declarar apuntando adentro de `VERGIS_OUT`.
5. **Read-only absoluto y sin fuga**: toda consulta pasa por un guard de solo-lectura propio del generador (el conector no lo tiene), y **los conteos de filas no se piden** sobre una tabla cuyo predicado de RLS filtra — la protección no depende de que la RLS aplique al Service Principal.

## ¿Qué contexto necesita el ejecutor?

### ¿Qué es Vergis y dónde vive cada cosa?

Vergis es un motor genérico que sirve Productos de Información (PI) sobre datos con RLS nativa. Lo que este plan toca:

| Pieza | Archivo | Qué hace hoy (verificado) |
|--|--|--|
| Config declarativa de instancia y slices recargables | `server/instance-config.ts:161-199` | `InstanceSlice<T>` = `{ env, parse }`; `RELOADABLE_SLICES` = notify · piOwners · sources · menu · static. El boot (`loadInstanceConfig`, :224-230) y la recarga (`reloadInstanceSlices`, `server/serve-rls.ts:2995-3030`) consumen **la misma tabla** |
| Semántica de fallas de dos niveles | `server/static-config.ts:1-49` (cabecera) y `:90-118` | Clave raíz ausente ⇒ **fatal** al arranque (`requireRootKey`, `packages/capabilities/src/config-root.ts:18`); entrada inválida ⇒ **se omite con aviso nombrado** y el nodo levanta |
| Servir estáticos | `server/static-serve.ts:80-100` (`resolveStatic`) · `server/routes.ts:255-290` (despacho) | Solo `GET`/`HEAD`; contención léxica y por `realpath` — **la raíz también se resuelve con `realpathSync` (:82)**, así que una raíz que es symlink funciona; `Content-Type` por lista blanca; `nosniff`; HTML `no-cache`; lectura por request |
| Desempate colección ↔ Let | `server/static-config.ts:129-143` (`omitirPorLets`) | Gana el Let; la misma función la usan el despacho, el contrato y el aviso de recarga |
| Conexiones | `server/serve-rls.ts:494-509` | `VERGIS_CONNECTIONS` = `{ database_ref: perfil }`, referencia viva, JSON inline o archivo |
| Conector Fabric | `packages/capabilities/src/execute-sql-dwh.ts` · creado en `server/serve-rls.ts:686-703` | `createExecuteSqlDwh(connections, { injections })`: enforcing por `sp_set_session_context`; claim ausente ⇒ `''` ⇒ el guard `<> ''` de la policy niega. **No tiene guard de solo-lectura** (verificado: `grep -n "readOnly\|guard" execute-sql-dwh.ts` no devuelve nada) |
| Handle directo vs caché | `server/serve-rls.ts:748-756` | La caché de resultados envuelve `servingCap` solo con `VERGIS_DATA_CACHE_TTL_MS>0`; «el bootstrap NO pasa por acá (usa su handle directo)» — el generador tampoco |
| Introspección por conexión que ya existe | `server/engines/fabric.ts:33-35` (`SYS_SECURITY_POLICIES_SQL`), `:46-53` (`SYS_VIEW_LINEAGE_SQL` sobre `sys.sql_expression_dependencies`), `:207-260` (`createFabricSourceStateOf`) | Se corre por `database_ref` con `execute({ database_ref, sql })`. El linaje vista→base sale de `sys`, no de un regex sobre la definición |
| Tablas que lee cada PI | `server/discovery.ts:21-36` (`Report.tables`, `Report.databaseRefs`) · `:161-188` · `server/sql-tables.ts` (`analyzeSqlTables`) | `discover()` ya devuelve, por PI, las tablas `schema.tabla` normalizadas y las conexiones que usa |
| Dominios | `packages/capabilities/src/domain.ts:16-30` (`DomainDecl`) · `:43-83` (`parseDomainsConfig`) | `{ id, label, description?, stewards? }`. **No declara conexiones** — ese mapeo hoy vive solo en el `writers.yaml` del lab (`vergis-instance/terreno/writers.yaml:14-52`, bloque `dominios:`) |
| Lazos de fondo | `server/control-loops.ts` (`LoopSpec`, `register/arm/disarm`) · `server/serve-rls.ts:1365, 1886, 1926, 1958` (registros) · `:2552` (`loops.arm()` solo con control) | Un lazo se declara al boot y se arma solo si el nodo tiene el plano de control |
| Gate de mutación | `server/routes.ts:118-131` (`mutacionSinControl`) · `:203-208` | Todo `POST` a `/admin/…` en un nodo standby responde **409 nombrando al activo**, antes de tocar el handler |
| Administración | `server/admin.ts:254` (`AdminDeps`) · `:346` (`audit`) · `:425` (scope `config`) · `:571` (`GET /admin/plataforma`) · `:622-636` (settings de plataforma con audit `platform-setting`) · `:850` (`requireCsrf`) · `:1010-1020` (sidebar de Configuración) | Escrituras por `POST` con CSRF, auditadas |
| Schedule con hora y zona | `server/report.ts:118-160` (`dueFor`, `lastDueAt`, `periodKeyOf`) | Cálculo puro de «¿ya venció el próximo disparo?» con `every`/`at`/`timezone` |
| Una sola en vuelo | `packages/capabilities/src/single-flight.ts:18` (`singleFlight`) | Envoltura que devuelve la promesa en vuelo en vez de arrancar otra |
| Contrato del nodo | `server/contract.ts:158` (`static` en la vista) · `:234-262` | `GET /contrato` publica el estado de disco de las colecciones |
| Literal allow-all | `packages/policy/src/fabric.ts:699, 742` | `SELECT 1 AS vergis_allowed` — el artefacto que compila `grant: all` |
| Identidad de una ejecución | `packages/botler/src/types.ts:14-20` (`IdentityContext`) | `{ agent, user?, claims? }` |
| Catálogo de capacidades | `docs/capacidades.md:332-333` | Última fila `CAP-196`; la nueva es **`CAP-197`** |

### ¿Qué hace hoy el script de instancia, insumo por insumo? (anatomía verificada)

`lab/scripts/gen-datadoc.mjs` — el ejecutor lo lee entero; esto es el mapa con líneas:

| Insumo / fase | Líneas | Qué hace | ¿De quién debe ser? |
|--|--|--|--|
| Guard read-only | `77-86` | Rechaza no-`SELECT`/`WITH`, `;`, y una lista de verbos prohibidos, tras pelar comentarios y literales | **Producto** — se porta tal cual |
| Dominios y endpoints | `89-98` | Lista cableada `{ id, nombre, env: local/ids-*.env, refs }` | **Producto**: conexiones de `VERGIS_CONNECTIONS`; **instancia**: la etiqueta de dominio y sus conexiones (`domains.yaml`) |
| PIs por dominio | `104-115` | Lee `specs/*.yaml`, `data.*.params.database_ref` | **Producto**: `discover()` ya lo tiene (`Report.databaseRefs`) |
| Escritores | `117-123` | `writers.yaml` → mapa tabla→escritores | **Instancia** declara (`VERGIS_WRITERS`), **Producto** lee |
| Oferta y procesos | `125-131` | `sources.yaml` → fuente por tabla, proceso por tabla | **Producto**: ya lo lee (`VERGIS_SOURCES`) y lo siembra en el store |
| Lectores | `133-142` | Ejecuta `derive-deps.mjs --json` (regex sobre el SQL de las specs) | **Producto**: `discover()` + `analyzeSqlTables` (la extracción del gate de gobernanza, más robusta que el regex del lab) |
| Diccionario semántico `SEM` | `147-274` | Objeto embebido con `intro`, `joins`, `tablas.{d, c}`, `vistas` por dominio, con HTML crudo | **Instancia** declara (`VERGIS_SEMANTICA`), **Producto** lee y **escapa** |
| Consultas de catálogo | `277-280` | `INFORMATION_SCHEMA.TABLES/COLUMNS` (solo `dbo`), `sys.sql_modules`, `sys.security_policies` + `sys.security_predicates` | **Producto** |
| `catalogar(dom)` | `282-324` | Abre pool `mssql` con SP, corre las 4 consultas + `COUNT_BIG(*)` por tabla base (identificador validado), tolera sub-errores, mide `ms` | **Producto** — reemplazando el pool propio por el conector del nodo |
| Clasificación | `329-341` | `VIEW`⇒publicado · `_bak*`⇒deuda · `_migrations`, `raw_*`, `md_*` en `mira_md`⇒interno · con lectores⇒interno · si no⇒deuda | Los prefijos son **convención de la instancia**; el Producto clasifica por **hechos medidos** (lector, escritor, política) y la instancia puede sobreescribir por entidad en `semantica.yaml` |
| Base de una vista | `370-376` | Regex `FROM dbo.X` sobre la definición | **Producto**: `SYS_VIEW_LINEAGE_SQL` (real, de `sys`) |
| Lectores efectivos | `378-387` | Directos + propagados de la vista a su base | **Producto**, con el linaje de `sys` |
| Escritor / oferta / gobierno (HTML) | `389-422` | Escritor vigente → proceso de sources → «sin escritor declarado»; predicado allow-all detectado con `/select\s+1\s+as\s+vergis_allowed/i` | **Producto** (misma lógica, mismo literal) |
| Modelo de entidades | `424-499` | Una fila por objeto con todo lo que las páginas usan | **Producto** (`modelo/<ref>.json`) |
| Sello de frescura | `501-509` | Por dominio: consultado/no, `ms`, sub-errores | **Producto**, por conexión, **persistido** |
| Números de seguridad | `511-532` | Cuenta funciones allow-all vs con filtro, secpol sobre `_bak` | **Producto** (sin el juicio `_bak`) |
| CSS, índice de búsqueda, cáscara | `546-694` | Hoja compartida, `search-index.js` como variable (funciona por `file://`), `pagina()` con nav/migas/buscador | **Producto** — se porta casi tal cual, sin literales de A.R.B.O.L. |
| Portada, seguridad, todas, dominio, entidad, marco | `697-1117` | Páginas; la de seguridad tiene texto **de instancia** (R-007, `secpol-fct_asistencia_dia.sql`); el marco de tres paneles es genérico | **Producto** para la estructura; el texto de portada/seguridad propio de la instancia va a `semantica.yaml` |
| Limpieza y escritura | `1122-1154` | Borra solo lo propio, escribe N archivos | **Producto** — reemplazado por builds inmutables + puntero atómico |

### ¿Qué restricciones no se negocian?

1. **No se rediseña cómo se sirve ni su autorización.** `CAP-195` está verificada; el Datadoc entra por `resolveStatic` sin tocar sus reglas. La autorización es la del catálogo: quien el gate dejó entrar ve el Datadoc (issue #304 lo pide así; `docs/arquitectura-multi-reporte.md §El nodo sirve el contenido estático`).
2. **Read-only absoluto sobre los Datahouses.** Toda consulta que emita el generador pasa por `guardSoloLectura`; todos los SQL son literales del módulo; los identificadores interpolados se validan con `/^[A-Za-z0-9_]+$/`. El conector no protege (verificado): la protección es del generador.
3. **Nunca se inventa.** Sin `writers.yaml`: «escritor no declarado». Sin `semantica.yaml`: «sin descripción». Una conexión que no responde: «NO medida», con el último sello bueno si lo hay y la razón del fallo.
4. **Nada específico de A.R.B.O.L. en el motor.** Ni prefijos `_bak`/`raw_`/`md_`, ni «R-007», ni «PowerBI», ni «César», ni el nombre del proyecto: eso es texto de instancia (`semantica.yaml`) o convención de instancia (sobreescritura de clase por entidad).
5. **La generación escribe en `VERGIS_OUT`, que es sustrato compartido entre nodos**: por eso corre **solo en el nodo con el plano de control** (misma regla que todo lazo de fondo, `server/control-loops.ts` cabecera) y el `POST` de regeneración pasa por `mutacionSinControl` (ya lo hace todo `/admin/…`, `routes.ts:203-208`).
6. **Fail-closed en la config de instancia, con la graduación de `static`**: clave raíz ausente ⇒ fatal; entrada inválida ⇒ omitida con aviso nombrado.
7. **Sin la env `VERGIS_DATADOC`, la superficie del nodo es byte a byte la de 0.32.0**: ninguna ruta nueva, ningún lazo, ningún prefijo reservado. Es el precedente de `MIRANDA_ENABLED` (`CAP-167`) y `VERGIS_EVALUACIONES=1` (`server/serve-rls.ts:1371`).
8. **Motor Fabric solamente** en esta entrega: la introspección es `INFORMATION_SCHEMA` + `sys.*` de un SQL endpoint. Con `VERGIS_ENGINE=clickhouse`, `VERGIS_DATADOC=1` es config rota y el arranque lo dice (fatal, nombrando la env), no degrada en silencio.
9. **Toda afirmación de mecanismo en el código y en las docs se etiqueta**: medida (con el test que la mide) o «se asume» / «no verificado».

## ¿Qué decisiones de diseño quedan tomadas?

### D1 — La unidad es la conexión; el dominio es una etiqueta declarada en `domains.yaml`

**Qué.** El generador itera sobre `Object.keys(connections)` (`VERGIS_CONNECTIONS`). Cada conexión produce un modelo. El dominio agrupa conexiones mediante un campo nuevo y opcional en `domains.yaml`:

```yaml
domains:
  - id: finanzas
    label: Finanzas
    connections: [finanzas]        # database_ref(s) de VERGIS_CONNECTIONS que realizan este dominio
```

- `parseDomainsConfig` (`packages/capabilities/src/domain.ts:43-83`) admite `connections?: string[]`, cada entrada `[A-Za-z0-9_-]+`, sin repetirse **entre dominios** (una conexión pertenece a lo sumo a un dominio; dos dominios que reclaman la misma ⇒ error del archivo, fatal, como un `id` duplicado).
- **Sin mapeo** (conexión no reclamada por ningún dominio, o sin `VERGIS_DOMAINS`): la conexión se presenta como **dominio técnico** rotulado por su `database_ref` y su `database` medida, con la nota «conexión sin dominio declarado». Nada se inventa; el catálogo sale igual.
- Los PIs se atribuyen a un dominio por `Report.databaseRefs` → dominio. Un PI que lee dos conexiones aparece en los dos dominios.

**Por qué en `domains.yaml` y no en `writers.yaml`.** «El dominio X se realiza en los Datahouses Y» es un hecho del **dominio**, no del escritor ni del catálogo: `domains.yaml` existe para «lo que no se infiere» (`lab/vergis-instance/domains.yaml:3-5`), y ese mapeo es exactamente eso. Ponerlo en `writers.yaml` —donde el lab lo tiene hoy, `writers.yaml:14-52`— haría que un dominio sin escritores declarados no tuviera dónde decir qué conexiones son suyas. **Costo:** un campo opcional en un parser existente y su test; `VERGIS_DOMAINS` ya se recarga en caliente por el watch de gobierno de dominio (`serve-rls.ts:2875`, `reloadLiveList(domainsCfg, …)`).

**Descartado:** derivar el dominio de `sources.yaml` (`sources[].domain` + `tableSources`): mapea **tablas** a dominios, no conexiones, y solo las tablas con fuente registrada — una conexión con veinte tablas y una sola fuente registrada quedaría atribuida por una y huérfana en diecinueve.

### D2 — Dos slices nuevos: `VERGIS_WRITERS` y `VERGIS_SEMANTICA`

Entran en `RELOADABLE_SLICES` (`server/instance-config.ts:183-199`) por la misma puerta que `static`: parser puro, valor puro, consumidor que lee el arreglo vivo. **El consumidor es el generador en el instante de generar**, así que la recarga en caliente significa: editar el YAML y regenerar produce el catálogo nuevo, sin restart.

#### `writers.yaml` — quién escribe cada tabla

```yaml
writers:
  - id: sjd-ingest-finanzas-saldos      # obligatorio, único (case-insensitive)
    conexion: finanzas                   # obligatorio: database_ref de VERGIS_CONNECTIONS donde escribe
    tipo: sjd                            # obligatorio, texto corto (sjd · script-manual · producto · notebook …)
    estado: vigente                      # obligatorio: vigente | fallback | retirado
    disparo: intake land-and-trigger (slot saldos_cartera)   # obligatorio, texto libre de una línea
    tablas:                              # obligatorio, ≥1, cada una `schema.tabla`
      - dbo.dim_socios
      - dbo.fact_saldos
    proceso: ingest_finanzas_saldos      # opcional: id de `processes[]` de sources.yaml (enlaza a Frescura)
    lee: [dbo.md_empresas_relacionadas__replica]   # opcional, `schema.tabla`
    notas: reemplaza al legado 07/10     # opcional
```

Reglas del parser (`server/writers-config.ts`, molde `static-config.ts`):
- Clave raíz `writers:` ausente ⇒ fatal; `writers: []` ⇒ cero, legítimo.
- Entrada sin `id`, sin `conexion`, sin `tipo`, con `estado` fuera del vocabulario, sin `disparo`, o con `tablas` vacía ⇒ **la entrada se omite** con aviso nombrado.
- Una tabla **sin esquema** (`fact_saldos`) ⇒ **esa tabla se omite** de la entrada con aviso (el escritor se conserva con las demás). Motivo: el nodo indexa por `schema.tabla` (policy store y `analyzeSqlTables`, `server/sql-tables.ts:14-17`); una referencia de una parte no es cruzable. Se normaliza a minúsculas sin corchetes.
- Claves desconocidas se **ignoran** (el lab conserva `code`, `fabric_id`, `dinamico` para su drift-check; el archivo puede ser el mismo).
- La existencia de la `conexion` **no** se valida en el parser (puro, sin acceso a `connections`); el generador marca «conexión desconocida» en el aviso de la corrida.
- `proceso` que no existe en el registro de fuentes ⇒ el enlace no se dibuja y el aviso lo dice; no se inventa la relación.

#### `semantica.yaml` — qué significa cada cosa

```yaml
semantica:
  portada: >-                            # opcional: texto de la instancia en la portada
    Catálogo del esquema de datos de la plataforma para quien quiere consumir el dato…
  seguridad: >-                          # opcional: texto de la instancia en la página de seguridad
    Hoy toda persona autenticada ve todo, a propósito: es el `grant: all` explícito…
  conexiones:                            # obligatorio (puede ser [])
    - conexion: finanzas                 # obligatorio: database_ref
      intro: >-                          # opcional: intro del dominio/conexión
        Antigüedad de saldos. Grano del hecho: documento con saldo, por semana de carga…
      joins:                             # opcional
        - fact_saldos × dim_empresas por `Codigo_Empresa`
      entidades:                         # opcional: mapa `schema.tabla` → { descripcion, columnas, clase }
        dbo.fact_saldos:
          descripcion: El hecho: un documento con saldo, en una semana de carga…
          columnas:                      # opcional: mapa columna (case-insensitive) → texto
            fecha_carga: Semana de la carga (llave del snapshot; filtrar siempre por una)
        dbo._migrations:
          descripcion: Control de migraciones del terreno.
          clase: interno                 # opcional: sobreescribe la clase derivada (publicado | interno | deuda)
```

Reglas (`server/semantica-config.ts`):
- Clave raíz `semantica:` ausente ⇒ fatal. Dentro, `conexiones` ausente ⇒ fatal (es la lista); `conexiones: []` ⇒ cero.
- Una entrada sin `conexion` ⇒ omitida con aviso. Una entidad con clave sin esquema ⇒ omitida con aviso. `clase` fuera del vocabulario ⇒ se ignora esa clave con aviso.
- **Texto plano**: todo se escapa al renderizar (`escapeHtml`); se admite **solo** el acento grave `` `x` `` → `<code>x</code>`. El diccionario del lab (`gen-datadoc.mjs:147-270`) usa `<b>`/`<code>` crudos: **se migra**, no se admite HTML — un YAML de instancia no es un canal para inyectar marcado en una página que sirve el nodo. Si `packages/capabilities/src/markdown.ts` ofrece un render **inline** que escape por defecto, se reúsa; si no (no verificado), se implementa el reemplazo de acentos graves y nada más.
- Semántica de columnas de una **vista**: si la vista no tiene entrada propia, hereda la de su tabla base según el linaje de `sys` (regla vigente del lab, `gen-datadoc.mjs:492-495`).

### D3 — Se sirve como colección propia del nodo, en `/datadoc/`, por el mismo `resolveStatic`

**Bifurcación.** (A) El generador escribe a un directorio y **la instancia** lo declara en `VERGIS_STATIC` (`static: [{ path: datadoc, dir: /governance/datadoc/current }]`). (B) **El nodo** sirve el directorio de salida como una colección propia, sin declaración de la instancia.

**Decisión: (B).** Razones, en orden:

1. **El directorio de salida es estado del Producto bajo `VERGIS_OUT`.** Con (A) la instancia tendría que conocer el layout interno del nodo (`/governance/datadoc/current`) y declararlo en su YAML; el día que ese layout cambie, la instancia se rompe sin que el Producto pueda avisar. Con (B) el puntero lo tiene quien lo escribe.
2. **Herencia real, no nominal.** Las tres propiedades que `CAP-195` verifica —contención (`static-serve.test.ts:113-160`), `Content-Type` por lista blanca y lectura por request— se heredan **en ambas** opciones porque las dos pasan por `resolveStatic`. Lo que (B) agrega es que el nodo puede **decir en `/contrato` y en `/admin/datadoc` qué build sirve y desde cuándo**, cosa que en (A) sería una colección más con `exists: true`.
3. **El swap atómico del build lo hace quien genera.** El generador escribe `build-<ts>/` y mueve el symlink `current`; en (A) la instancia apuntaría a `…/current` y funcionaría igual (la raíz se resuelve con `realpathSync`, `static-serve.ts:82`), pero la garantía de que `current` sea siempre un build completo es del generador — tenerla en la misma pieza de código que la sirve evita que una instancia apunte a `build-<ts>` directo y sirva un build a medias.
4. **Sin la env no hay superficie.** (B) con opt-in es idéntico a 0.32.0 cuando `VERGIS_DATADOC` no está; (A) obligaría a la instancia a declarar una colección para algo que el nodo produce.

**Mecánica.** `routes.ts` recibe una dep nueva `getDatadocCollection?: () => StaticCollection | null` (o el generador la aporta al mismo arreglo que `getStaticCollections`, anteponiéndola). La colección es `{ path: 'datadoc', dir: '<VERGIS_OUT>/datadoc/current', label: 'Datadoc (generado por el nodo)' }`. Cuando `current` no existe todavía, `resolveStatic` responde 404 (directorio inexistente) — y el índice `/datadoc/` sin build se responde con una página mínima del nodo «Datadoc aún no generado — Administración › Datadoc › Generar» (**decisión**: mejor que un 404 pelado en la única URL que el menú de la instancia enlaza).

**Reserva del prefijo.** Con `VERGIS_DATADOC=1`, `datadoc` se suma a los prefijos que una colección de instancia no puede reclamar. `RUTAS_DEL_NODO` (`static-config.ts:84`) es una constante usada por el parser **puro**, que no conoce la env: no se toca. Se agrega una función pura hermana de `omitirPorLets`:

```ts
// server/static-config.ts
export function omitirPorNodo(collections, prefijosDelNodo: ReadonlySet<string>): { collections, warnings }
// aviso: "colección 'datadoc' omitida: choca con la ruta '/datadoc' que el nodo sirve por sí mismo (VERGIS_DATADOC)."
```

y se llama en los **tres** lugares donde hoy se llama `omitirPorLets` (despacho `routes.ts:272`, contrato, recarga `serve-rls.ts:3022`). Sin la env, el set está vacío y nada cambia.

**Descartado:** un prefijo configurable. Un solo nombre, `/datadoc`, es lo que el menú de la instancia ya enlaza (`compose.yml:46`); parametrizarlo agrega una perilla sin caso que la pida.

### D4 — Caché en disco: modelo medido por conexión + builds inmutables + puntero atómico

Layout bajo `$VERGIS_OUT/datadoc/`:

```
datadoc/
├── modelo/<ref>.json        # la medición de UNA conexión: catálogo, columnas, secpol, predicados, linaje,
│                            # conteos, sub-errores, medidoEn, ms · se sobreescribe por conexión
├── sello.json               # por conexión: { ref, database, server, ok, medidoEn, ms, objetos, error? }
│                            # + { generadoEn, build } del último render
├── build-2026-09-21T15-04-05Z/   # un render completo e inmutable (index.html, marco.html, …)
├── build-2026-09-21T09-00-00Z/   # se conservan los DOS últimos; el resto se borra tras el swap
└── current -> build-2026-09-21T15-04-05Z   # symlink relativo; es la raíz de la colección servida
```

- **Medir y renderizar son fases separadas.** `medirConexion(ref)` escribe `modelo/<ref>.json`; `renderizar()` lee **todos** los `modelo/*.json` presentes y escribe un build. Regenerar «todo» = medir todas + renderizar; regenerar «una conexión» = medir una + renderizar. Una conexión que **falla** hoy conserva su `modelo/<ref>.json` anterior: el render la incluye con su sello viejo y la marca «NO medida en esta corrida: se muestra la medición del <fecha>; motivo: <error>» en la portada, en su página de dominio y en cada página de entidad de esa conexión. Es la **degradación honesta** que el issue pide y lo que vuelve útil al sello por conexión.
- **Swap atómico.** Se escribe `current.tmp-<pid>` como symlink al build nuevo y se hace `rename('current.tmp-<pid>', 'current')`. Se asume (POSIX) que `rename(2)` reemplaza un symlink existente de forma atómica; el test de la fase 4 lo mide en el runner (crea, swapea, verifica que en ningún instante `current` falte).
- **Retención**: tras el swap se borran los builds que no sean los dos más recientes. Nunca se borra nada fuera de `datadoc/build-*` y jamás con recursión sobre un directorio que no matchee el patrón (regla del lab `gen-datadoc.mjs:1122-1139`, trasladada).
- **Por qué disco y no memoria**: el nodo se reinicia con cada promoción de anillo y el catálogo tarda lo que tardan ocho conexiones (medido en el lab: la corrida completa consulta 8 Datahouses en paralelo; el tiempo por dominio se estampa en el sello). Un catálogo que desaparece con el proceso obligaría a re-medir en cada arranque, contra almacenes de terceros. `VERGIS_OUT` ya es el volumen persistente del nodo (`deployment-check.ts:110-124` avisa cuando es efímero).

### D5 — Disparo: bajo demanda desde Administración; schedule opcional desde la misma pantalla

**Superficie** (scope `config`, admin de plataforma; entra en el sidebar tras «Mapa de identidad», `admin.ts:1010-1020`):

| Ruta | Método | Qué hace |
|--|--|--|
| `/admin/datadoc` | `GET` | Estado: build servido (fecha, enlace a `/datadoc/`), tabla por conexión (dominio, `database`, medida en, ms, objetos, ok/error), «en curso» si hay generación en vuelo, avisos de la última corrida (conexión desconocida en `writers`, entidad sin esquema, etc.), schedule vigente, ajuste de conteos |
| `/admin/datadoc/generar` | `POST` (CSRF) | Dispara la generación completa; con `conexion=<ref>` solo esa. Responde `303` a `/admin/datadoc`. Si ya hay una en vuelo, no arranca otra (`singleFlight`) y la página lo dice |
| `/admin/datadoc/ajustes` | `POST` (CSRF) | Guarda `datadoc_schedule` y `datadoc_conteos` en el store de settings de plataforma (mismo mecanismo que `index_title`/`notas`, `admin.ts:622-636`), audit `platform-setting` |

- **Audit**: `{ type: 'datadoc-generate', scope: 'all' | ref, by }` al disparar; `{ type: 'datadoc-done', ok, conexiones: n, fallidas: [...], ms, build }` al terminar (el fin lo escribe el generador, no el request, porque el request ya respondió).
- **Sin control ⇒ 409** lo pone el router (`routes.ts:203-208`); el handler además comprueba `hasControl()` antes de arrancar por si llega por el lazo.
- **Schedule**: setting `datadoc_schedule` con forma `off` | `daily@HH:MM` | `weekly:<weekday>@HH:MM`, zona `datadoc_timezone` (IANA; default la del host, como el reporte). El lazo `datadoc` se **declara** al boot (`loops.register`, cadencia de chequeo 5 min, `firstDelayMs` 30 s) y se arma solo con control; su `tick` lee el setting, calcula con `lastDueAt`/`periodKeyOf` (`server/report.ts:137-160`) si venció un período que no se generó (el `periodKey` del último disparo por schedule se persiste en `sello.json`) y, si venció, dispara la misma función que el `POST`. Reusar el cálculo del reporte evita una segunda aritmética de zonas horarias.
- **Conteos**: setting `datadoc_conteos` = `abiertas` (default) | `off` — ver D6.

**Por qué settings y no un `datadoc.yaml`.** Schedule y conteos son perillas del **operador de la plataforma**, no declaraciones de la instancia: se cambian desde la pantalla, sin tocar archivos ni volumen, y sobreviven a restarts en el GovernanceStore. Es el precedente de `index_title` y de la retención de notas. Lo que sí es declaración (quién escribe, qué significa) va en YAML.

### D6 — Conteos de filas: solo donde la RLS no filtra, y nunca como dato

**El catálogo describe el esquema, no sirve datos**, pero un `COUNT(*)` es un agregado de filas y sobre una tabla gobernada **es** información que la RLS protege (cuántos registros hay del área que no me corresponde). Regla:

1. Para cada tabla base se determina su gobierno con `sys.security_policies` + `sys.security_predicates` + la definición de la función de predicado en `sys.sql_modules` (consultas literales del generador; el motor ya corre una variante en `SYS_SECURITY_POLICIES_SQL`):
   - **sin política** ⇒ `no gobernada`;
   - **con política cuya definición, pelada de comentarios y espacios, ES EXACTAMENTE** `SELECT 1 AS vergis_allowed` **y no trae `WHERE`** ⇒ `abierta` (allow-all explícito);
   - **cualquier otra definición localizada** ⇒ `filtrada`;

   ⚠️ **El literal NO discrimina, y creer que sí es el defecto que esta versión corrige.** Medido el
   2026-09-21 contra el compilador: `packages/policy/src/fabric.ts` emite `SELECT 1 AS vergis_allowed`
   en **las dos** ramas — la allow-all sin `WHERE` (línea 700) y la **filtrada** con `WHERE <predicado>`
   (línea 744, fijada por `tests/policy.test.ts:235`). El regex que el generador del lab usa hoy
   (`/select\s+1\s+as\s+vergis_allowed/i`, `gen-datadoc.mjs:305`) matchea ambas, así que **portarlo
   clasificaría toda tabla con RLS real como `abierta` y le publicaría el `COUNT`**. No ha explotado
   allá porque las 31 funciones de esa instancia son hoy allow-all y ninguna tiene filtro: el primer PI
   con RLS real lo destapa. La clasificación es por **forma completa de la definición**, jamás por
   substring, y su test obligatorio usa el fixture de `tests/policy.test.ts:235` y **falla** si sale
   `abierta`.
   - **con política y función no localizada** ⇒ `indeterminada`.
2. **Se pide `COUNT_BIG(*)` solo a `no gobernada` y `abierta`.** A `filtrada` e `indeterminada` **no se les emite la consulta**: la página dice «filas: no medidas (tabla gobernada por RLS con filtro)». La protección **no depende** de que la RLS aplique al Service Principal del nodo (si un dueño del warehouse está exento del predicado es algo **no verificado** en Fabric) — por eso la decisión es no preguntar, no confiar en que la respuesta venga filtrada.
3. Con `datadoc_conteos = off` no se emite ningún `COUNT`: para instancias que no quieran exponer cardinalidades ni de tablas abiertas.
4. La identidad con que corre el generador es `{ agent: 'datadoc' }` **sin `claims`** por el conector enforcing (`createExecuteSqlDwh` con `injections`): si por error se colara un `COUNT` sobre una tabla filtrada, el prelude inyecta `''` y la policy niega (`execute-sql-dwh.ts:48-56`). Es defensa en profundidad, no la regla.
5. Vistas: «= base» cuando la base tiene conteo; si no, lo mismo que la base.
6. **La clasificación se recalcula en cada generación, y eso NO alcanza solo.** El Producto **no
   aplica** las policies —las aplica la instancia con sus `scripts/apply-*-rls.mjs`—, así que el nodo
   no se entera cuando una tabla pasa de abierta a gobernada, y el build cacheado sigue publicando su
   conteo hasta la próxima regeneración. **Condición de diseño:** `reloadGovernance('watch:policies')`
   (`serve-rls.ts`) marca el build como **rancio** y la página lo declara; con `datadoc_conteos =
   abiertas` sin schedule, un build rancio **no publica conteos**. Sin este eslabón, el default
   `abiertas` es una ventana que se abre sola.

### D7 — Read-only: guard del generador, consultas literales, identificadores validados

`server/datadoc-introspect.ts` exporta `guardSoloLectura(sql)` portado de `gen-datadoc.mjs:77-86` (pelar comentarios y literales; exigir `SELECT`/`WITH`; una sola sentencia; lista de verbos prohibidos) y **todas** las consultas son constantes del módulo pasadas por el guard al cargar. El único identificador interpolado es el `[schema].[tabla]` del `COUNT_BIG`, validado por parte con `/^[A-Za-z0-9_]+$/`. El ejecutor que se use es el `dwh` **directo** (no `servingCap` envuelto en caché, `serve-rls.ts:748-756`), con `IdentityContext = { agent: 'datadoc' }`.

Consultas (todas contra una conexión, en paralelo, con `Promise.allSettled` por consulta y por conexión):

| Nombre | Fuente | Para qué |
|--|--|--|
| `Q_TABLAS` | `INFORMATION_SCHEMA.TABLES` con **lista blanca de esquemas**: `dbo` por defecto, ampliable por la instancia | Objetos y tipo (BASE TABLE / VIEW). **Lista blanca y no lista negra**, medido el 2026-09-21: `wh_finanzas` trae un esquema `queryinsights` con 6 vistas —el historial de consultas de Fabric, con el texto SQL de todos los usuarios— que un `NOT IN ('sys','INFORMATION_SCHEMA')` deja pasar y el catálogo publicaría como entidades «publicado» con sus columnas. No es fuga de datos, es un contrato falso en la página; y el conjunto de esquemas de plataforma que puede aparecer no se conoce de antemano (un lakehouse puede traer otros), así que enumerar lo que entra es lo único que cierra |
| `Q_COLUMNAS` | `INFORMATION_SCHEMA.COLUMNS`, mismo filtro | Nombre, posición, tipo, largo/precisión/escala, nulabilidad |
| `Q_MODULOS` | `sys.sql_modules ⋈ sys.objects` | Definición de vistas (para mostrar) y de funciones de predicado (para clasificar allow-all) |
| `Q_SECPOL` | `sys.security_policies ⋈ sys.security_predicates ⋈ sys.objects` | Política, habilitada, objetivo, definición del predicado |
| `SYS_VIEW_LINEAGE_SQL` | reusada de `server/engines/fabric.ts:46-53` | Linaje vista→base |
| `Q_COUNT(schema, tabla)` | `SELECT COUNT_BIG(*) AS n FROM [s].[t]` | Solo bajo D6 |

Un sub-error (p. ej. `sys.security_policies` denegada) **no** invalida la conexión: queda en `errores[]` del modelo y la página lo declara, como hoy (`gen-datadoc.mjs:305-313`).

### D8 — Clasificación por hechos medidos; la instancia sobreescribe por entidad

| Clase | Regla del Producto |
|--|--|
| **publicado** | `TABLE_TYPE = 'VIEW'` |
| **interno** | tabla base con ≥1 lector (directo o vía vista, por linaje de `sys`) **o** con escritor `vigente` declarado **o** con política de RLS en la fuente |
| **deuda** | tabla base sin lector, sin escritor declarado y sin política |

Motivo de deuda (texto): «sin consumidor: ningún PI la lee, ningún escritor la declara, ninguna política la gobierna». Las convenciones del lab (`_bak*`, `raw_*`, `md_*`, `_migrations`; `gen-datadoc.mjs:329-341`) **no entran al motor**: la instancia las expresa con `clase:` en `semantica.yaml` cuando el hecho medido no baste. El centinela del Producto `vergis_unmask_probe` (`fabric.ts:60`) se lista como `interno` con la nota «centinela de desenmascarado del Producto (#238)» — es un hecho del nodo, no una convención de instancia.

### D9 — Render: el emisor del lab, portado como función pura y sin literales de instancia

`server/datadoc-render.ts` exporta `renderDatadoc(entrada): Archivo[]` (`{ rel, contenido }`), sin tocar disco, donde `entrada` = `{ modelos, sello, dominios, pis, writers, semantica, sources, brand: { title }, conteos }`. Se porta de `gen-datadoc.mjs`:

- CSS (`546-615`), `search-index.js` como variable (`616-625` — se conserva la propiedad «funciona por `file://`», que permite descargar el build y mandarlo), cáscara `pagina()` (`631-694`), portada (`697-757`), seguridad (`760-769`), todas las entidades (`771-781`), dominio (`784-825`), entidad (`828-839`), marco de tres paneles (`855-1117`).
- **Se retira** todo literal de instancia: «A.R.B.O.L.», «Grupo Hijuelas», «PowerBI» (la sección «¿Cómo me conecto?» se reescribe genérica: «cada conexión expone un SQL endpoint; host y base aparecen en la página del dominio»), «R-007», `secpol-fct_asistencia_dia.sql`, «Borrador interno pendiente de revisión de César», `work/213`, `node scripts/gen-datadoc.mjs`. La portada y la seguridad reciben `semantica.portada` / `semantica.seguridad` si existen; si no, solo el texto genérico y los números medidos.
- El título es `brand.title` (el `index_title` vigente, mismo que el catálogo) + «· Datadoc».
- El pie dice: «Generado por el nodo el <fecha> · fuentes: catálogo vivo (N/M conexiones medidas) + specs de PI + writers.yaml + sources.yaml + semantica.yaml», y **por conexión** la fecha de su medición cuando difiere de la del render.
- Cada página de entidad conserva URL estable `entidades/<ref>--<schema>.<tabla>.html` (el lab usa `<dominio>--<tabla>`; la clave pasa a ser la **conexión** porque el dominio es una etiqueta que puede reagrupar conexiones sin que la entidad cambie).

## ¿Qué ítems se implementan? (con severidad, Dónde / Problema / Fix)

Severidades: **B** bloqueante para el cierre · **M** mayor · **m** menor.

| # | Sev | Dónde | Problema | Fix |
|--|--|--|--|--|
| 1 | B | `packages/capabilities/src/domain.ts:16-30, 43-83` | `DomainDecl` no sabe qué conexiones realizan el dominio | Campo opcional `connections?: string[]`; validación de forma y unicidad entre dominios; test en `tests/domain.test.ts` |
| 2 | B | `server/writers-config.ts` (nuevo) | No existe el modelo de escritores en el Producto | `parseWritersConfig(doc): { writers, warnings }` según D2; export `escritoresDe(tabla, ref)`; tests `tests/writers-config.test.ts` (archivo válido · `writers: []` · entrada omitida por cada campo · tabla sin esquema omitida con el escritor conservado · claves desconocidas ignoradas) |
| 3 | B | `server/semantica-config.ts` (nuevo) | No existe el diccionario semántico en el Producto | `parseSemanticaConfig(doc): { portada?, seguridad?, conexiones, warnings }` según D2; `textoInline(s)` que escapa y solo admite acentos graves; tests `tests/semantica-config.test.ts` (incluido **el control positivo de escape**: un `<script>` en una descripción sale como texto) |
| 4 | B | `server/instance-config.ts:161-199, 224-258` | Los dos slices nuevos no están en `RELOADABLE_SLICES` ni en `InstanceConfig` | `env: 'VERGIS_WRITERS' \| 'VERGIS_SEMANTICA'` en la unión; entradas `writers`, `semantica` en la tabla; campos `writers`, `writersWarnings`, `semantica`, `semanticaWarnings` en `InstanceConfig` (**arreglo/objeto vivo, swap por splice/`Object.assign` in-place**, mismo contrato que `staticCollections`, cabecera :95-107); línea de conteo en `summary` |
| 5 | B | `server/serve-rls.ts:2995-3030, 3200-3232` | La recarga y el watch no conocen los slices nuevos | Dos bloques calcados del de `static` en `reloadInstanceSlices` (validate-before-swap, `contract.record`, avisos re-emitidos); `WRITERS_PATH`/`SEMANTICA_PATH` en `instanceTargets` y en `envs`; texto de `reloads` ampliado |
| 6 | B | `server/datadoc-introspect.ts` (nuevo) | El nodo no tiene la medición de una conexión | `guardSoloLectura`, las consultas de D7, `medirConexion(execute, ref): ModeloConexion` puro respecto del disco (recibe `execute`, devuelve el modelo); clasificación de gobierno (`no gobernada` / `abierta` / `filtrada` / `indeterminada`); conteos condicionados por D6; tests con un `execute` falso que responde por consulta (**y un caso donde una sub-consulta rechaza**: el modelo sale con `errores[]`, no lanza) |
| 7 | B | `server/datadoc-modelo.ts` (nuevo) | Falta el cruce de insumos | `ensamblar({ modelos, reports, writers, semantica, sources, domains })` → entidades con clase (D8), lectores efectivos (directos + vía linaje), escritor (vigente → proceso de `sources` → declarado no vigente → «no declarado»), oferta (tabla→fuente→`oferta`), gobierno, semántica (con herencia vista←base), dominio (D1 con dominio técnico de fallback); tests `tests/datadoc-modelo.test.ts` con los cuatro casos de degradación (sin writers · sin semántica · sin domains · conexión fallida con modelo previo) |
| 8 | B | `server/datadoc-render.ts` (nuevo) | El emisor vive en el lab con literales de instancia | Port de D9 como función pura `renderDatadoc(entrada): Archivo[]`; tests: el índice, una página de dominio y una de entidad **no contienen** ninguna cadena de la lista de literales retirados (`A.R.B.O.L.`, `PowerBI`, `R-007`, `César`, `gen-datadoc.mjs`); una entidad `filtrada` muestra «no medidas» y **no** un número; el `search-index.js` es JS válido (se evalúa con `vm`) |
| 9 | B | `server/datadoc-store.ts` (nuevo) | Falta la caché en disco con swap atómico | `leerModelos(dir)`, `escribirModelo(dir, ref, modelo)`, `escribirBuild(dir, archivos): buildDir`, `publicar(dir, buildDir)` (symlink temporal + `rename`), `podar(dir, conservar=2)`, `leerSello(dir)`/`escribirSello`; guardas del lab trasladadas (jamás borrar fuera de `build-*`); tests en `tmpdir` con el **experimento del swap**: un lector en bucle sobre `realpathSync(current)` durante 200 swaps nunca ve `ENOENT` |
| 10 | B | `server/datadoc.ts` (nuevo) | Falta el orquestador | `createDatadoc(deps)` con `generar(alcance: 'all' \| ref)` envuelto en `singleFlight`; `estado()` para `/admin` y `/contrato`; `tickSchedule(now)` para el lazo; registra `datadoc-done` en audit; **no** arranca sin `hasControl()` |
| 11 | B | `server/routes.ts:53, 255-290` · `server/static-config.ts:129-143` | El nodo no sirve la colección propia ni reserva el prefijo | `omitirPorNodo` (D3) llamada junto a `omitirPorLets` en los tres sitios; dep `getDatadocCollection`; la colección propia se antepone a las de instancia; página mínima «aún no generado» cuando `current` no existe; tests en `tests/static-serve.test.ts` (la colección propia sirve un `index.html` real; la de instancia con el mismo prefijo se omite con el aviso; **sin la dep la superficie es exactamente la de antes**, como el test :266) |
| 12 | B | `server/admin.ts:254-350, 425, 571, 1010-1020` | No existe la superficie de administración | `AdminDeps.datadoc?: DatadocOps` (`estado`, `generar`, `ajustes`); rutas de D5 con CSRF y audit; sidebar; tests `tests/admin-datadoc.test.ts` con el molde de `tests/admin-handler.test.ts` (GET renderiza el sello por conexión; POST sin CSRF ⇒ 403; POST válido llama `generar('all')` y redirige; POST con `conexion=x` llama `generar('x')`) |
| 13 | B | `server/serve-rls.ts` (cableado, cerca de :1213 y de los `loops.register`) | Nada conecta las piezas | Con `VERGIS_DATADOC=1` **y** `VERGIS_ENGINE=fabric` **y** `connections`: crear `createDatadoc` con el `dwh` directo, `discover`, `INSTANCE_CFG` (writers/semantica/domains), `govStore` (sources, settings), `audit`; `loops.register({ name: 'datadoc', everyMs: 5*60_000, firstDelayMs: 30_000, tick })`; `getDatadocCollection` a `routes`; `datadoc` a `createAdmin`; vista en `/contrato`. Con `VERGIS_DATADOC=1` y motor ≠ fabric ⇒ **fatal** nombrando la env (restricción 8). Sin la env ⇒ nada |
| 14 | M | `server/contract.ts:158, 234-262, 371` | El contrato no declara el Datadoc | Sección `datadoc?: { enabled, current: { build, generadoEn } \| null, conexiones: [{ ref, ok, medidoEn, error? }], enCurso, schedule }`; test en `tests/contract.test.ts` |
| 15 | M | `docs/capacidades.md:333` | Falta la fila | `CAP-197` con el formato de las filas vecinas; `npm run capacidades:cotejo` verde |
| 16 | M | `docs/arquitectura-multi-reporte.md` (tras «El nodo sirve el contenido estático…») · `docs/gestion-de-dominio.md` (`connections`) | Sin documentación | Sección «El nodo genera el catálogo del esquema (`VERGIS_DATADOC`, `CAP-197`)» con D1–D9 en prosa, los dos YAML de ejemplo, la tabla de conteos de D6 y **qué NO hace**; en `docs/gestion-de-dominio.md`, el campo `connections` |
| 17 | M | `CHANGELOG.md` | Sin entrada | Sección `## Sin publicar` (encabezado exacto que reconoce `server/novedades.ts:197-232`) con la capacidad, las envs nuevas y la frontera con `CAP-195`; al cortar, `0.33.0` |
| 18 | m | `deploy/compose.reference.yml` · `examples/` | Sin ejemplo | Un `writers.yaml` y un `semantica.yaml` mínimos en `examples/instance/`, y las tres envs comentadas en el compose de referencia |

## ¿En qué orden se implementa y por qué?

1. **Ítems 1–5 (declaraciones y su carga).** Son puros, testeables sin motor y los consume todo lo demás. Terminar acá deja un nodo que **acepta** los YAML nuevos y los recarga, sin generar nada — verificable con `npm test` y con `SIGHUP` sobre un archivo montado.
2. **Ítems 6–7 (medir y ensamblar).** Puros respecto del disco y de la red: `medirConexion` recibe `execute`; `ensamblar` recibe datos. Acá se prueban D6 (no se emite `COUNT` a una filtrada) y D8 con `execute` falsos. Es el corazón, y tiene que quedar medido antes de dibujar nada.
3. **Ítem 8 (render).** Función pura sobre el modelo ensamblado. Se porta el emisor con un fixture de modelo y se compara **a ojo** contra el sitio del lab en `lab/work/217-datadoc/` una vez (la paridad visual no la mide un test; sí mide un test que no queden literales de instancia).
4. **Ítem 9 (store en disco).** Aislado en `tmpdir`; el experimento del swap se corre acá.
5. **Ítems 10–13 (orquestador, servir, admin, cableado).** Recién ahora se conecta al proceso. El cableado va **último** porque `serve-rls.ts` no es importable en tests (`tests/instance-reload.test.ts:1-8` lo explica) y todo lo anterior tiene que estar verificado por su cuenta.
6. **Ítems 14–18 (contrato, docs, changelog, ejemplos).** Con la conducta cerrada, se declara.

**Gate de integración**: antes del PR, la corrida del §Protocolo de validación completa, incluida la de arranque con un `VERGIS_CONNECTIONS` falso que apunta a un puerto cerrado (ver abajo): el nodo levanta, `/datadoc/` responde «aún no generado», `POST /admin/datadoc/generar` produce un build cuyo sello marca la conexión como **NO medida** con el error de conexión, y la página se sirve igual.

## ¿Qué NO hacer?

- **No cambiar `resolveStatic`, `parseStaticConfig` ni `RUTAS_DEL_NODO`.** La reserva del prefijo va por `omitirPorNodo`, aparte y pura.
- **No cachear en memoria el sitio generado.** Se sirve del disco por request, como toda colección (`static-serve.ts` regla 4).
- **No emitir `COUNT` sobre tablas `filtrada`/`indeterminada`** «para tener el número»: la regla D6 no es un default, es la protección.
- **No usar `servingCap` envuelto en caché** ni la identidad de un usuario: `{ agent: 'datadoc' }` sin claims, por el handle directo.
- **No inferir el dominio** de una conexión por parecido de nombre (`wh_finanzas` ≈ `finanzas`): sin `connections` declarado, es dominio técnico.
- **No admitir HTML en `semantica.yaml`.** Escape total + acentos graves.
- **No traer al motor los prefijos `_bak`/`raw_`/`md_`** ni ningún texto de A.R.B.O.L.
- **No generar en un nodo sin control** aunque el `POST` llegue (el router lo rechaza; el orquestador lo re-verifica).
- **No borrar nada fuera de `datadoc/build-*`** y jamás `rm -rf` sobre una ruta calculada.
- **No añadir la entrada al menú del avatar desde el Producto**: la instancia la declara con `VERGIS_MENU` (`CAP-190`), como hoy (`compose.yml:46`).
- **No tocar el lab** (`gen-datadoc.mjs`, `writers.yaml`, compose, Caddyfile): la migración de la instancia es otro plan (`work/017` fase 2 + uno propio para adoptar `CAP-197`).
- **No mergear sin CI verde** ni sin `npm run typecheck` tras tocar cualquier `.ts` (`vitest` no typechequea — `lab/CLAUDE.md` regla 15).

## ¿Cómo se valida? (protocolo reproducible)

Todo desde el clon del Producto (`/Users/cesar/wworkspace/productos/vergis`, en el worktree del ejecutor), Node 22.

### ¿Sin ningún almacén real?

```bash
npm ci
npm run typecheck
npm test                     # incluye los tests nuevos de los ítems 1-12 y 14
npm run capacidades:cotejo   # CAP-197 citada; numeración sin huecos
```

Tests que **tienen** que existir y qué corrida los refutaría:

| Afirmación del diseño | Test | Qué saldría distinto si estuviera mal |
|--|--|--|
| Una tabla `filtrada` no recibe `COUNT` | `datadoc-introspect.test.ts`: `execute` falso que **registra** cada SQL; tras `medirConexion`, ningún SQL registrado contiene `COUNT_BIG` con el nombre de la tabla filtrada; la abierta sí | Un `COUNT` sobre la filtrada aparecería en el registro |
| Detección allow-all por literal | mismo archivo: función con `SELECT 1 AS vergis_allowed` ⇒ `abierta`; con `WHERE` ⇒ `filtrada`; predicado que apunta a función ausente en `sys.sql_modules` ⇒ `indeterminada` | Clase equivocada |
| Sub-error no invalida la conexión | `execute` que rechaza solo `Q_SECPOL` ⇒ modelo con `errores: ['…']`, tablas presentes, gobierno `indeterminada` para todas | Un `throw` global |
| Sin writers / sin semántica / sin domains | `datadoc-modelo.test.ts`: cuatro fixtures; los textos «escritor no declarado», «sin descripción», dominio técnico `= ref` | Un texto inventado o un `undefined` en la página |
| Conexión fallida conserva el modelo previo y lo marca | `datadoc-modelo.test.ts` + `datadoc-store.test.ts`: `modelo/x.json` viejo + sello `ok:false` ⇒ entidades presentes con la marca «NO medida en esta corrida» y la fecha vieja | Entidades ausentes, o presentes sin la marca |
| Escape de la semántica | `semantica-config.test.ts`: `descripcion: "<script>alert(1)</script> y `col`"` ⇒ `&lt;script&gt;… <code>col</code>` | El `<script>` crudo en el HTML |
| Sin literales de instancia | `datadoc-render.test.ts`: lista cerrada de cadenas prohibidas, ninguna en ningún archivo emitido | Una cadena presente |
| Swap atómico | `datadoc-store.test.ts`: lector en bucle (`realpathSync('current')`) durante 200 `publicar()` consecutivos: cero `ENOENT`; tras cada swap, `current/index.html` es el del build nuevo | Un `ENOENT` o un índice viejo tras el swap |
| Poda | tras 5 builds quedan 2; ningún archivo fuera de `datadoc/` tocado (se planta un centinela hermano y se verifica que sigue) | Centinela borrado o >2 builds |
| Prefijo reservado | `static-serve.test.ts`: con `getDatadocCollection` y una colección de instancia `datadoc`, `/datadoc/` sirve el `index.html` **del nodo** y la recarga emite el aviso de `omitirPorNodo`; **sin** la dep, la de instancia se sirve como hoy | El contenido de instancia servido con la dep presente, o la superficie cambiada sin ella |
| Slices recargables | `instance-reload.test.ts` (extender): `loadSlice(env, RELOADABLE_SLICES.writers)` sobre un tmp; reescribir el archivo ⇒ el arreglo vivo cambia por splice; archivo roto ⇒ se conserva lo vigente y `contract.record` marca `ok:false` | Lo vigente reemplazado por un valor roto |
| Standby | `admin-datadoc.test.ts` + el gate del router (`tests/static-serve.test.ts` molde): `POST /admin/datadoc/generar` con `hasControl: () => false` ⇒ 409 nombrando al activo, `generar` **no** llamado | `generar` llamado |
| Schedule | `datadoc.test.ts`: `tickSchedule` con `daily@09:00` y reloj falso: a las 08:59 no dispara; a las 09:01 dispara una vez; a las 09:30 del mismo día **no** vuelve a disparar (periodKey persistido); al día siguiente sí | Doble disparo o ninguno |

### ¿Con el nodo levantado pero sin almacén (arnés de arranque)?

```bash
# Un VERGIS_CONNECTIONS que apunta a un puerto cerrado: mide «no responde» sin tocar ningún Datahouse.
cat > /tmp/dd-conn.json <<'EOF'
{ "demo": { "server": "127.0.0.1", "port": 9, "database": "demo", "tenantId": "t", "clientId": "c", "clientSecret": "s" } }
EOF
printf 'writers: []\n' > /tmp/dd-writers.yaml
printf 'semantica:\n  conexiones: []\n' > /tmp/dd-semantica.yaml
mkdir -p /tmp/dd-out
VERGIS_ENGINE=fabric VERGIS_CONNECTIONS=/tmp/dd-conn.json VERGIS_SPECS_DIR=examples \
VERGIS_POLICIES=examples/rls-areas.yaml VERGIS_OUT=/tmp/dd-out VERGIS_ADMIN_SEED=admin@x.cl \
VERGIS_DATADOC=1 VERGIS_WRITERS=/tmp/dd-writers.yaml VERGIS_SEMANTICA=/tmp/dd-semantica.yaml \
PORT=8099 node --import tsx server/serve-rls.ts &
sleep 3
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-forwarded-email: admin@x.cl' http://127.0.0.1:8099/datadoc/     # 200: «aún no generado»
curl -s -H 'x-forwarded-email: admin@x.cl' http://127.0.0.1:8099/contrato | jq .datadoc                        # enabled:true, current:null
# Disparar (el token CSRF se toma del GET de /admin/datadoc):
TOKEN=$(curl -s -H 'x-forwarded-email: admin@x.cl' http://127.0.0.1:8099/admin/datadoc | grep -o 'name="_csrf" value="[^"]*"' | cut -d'"' -f4)
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'x-forwarded-email: admin@x.cl' --data "_csrf=$TOKEN" http://127.0.0.1:8099/admin/datadoc/generar   # 303
sleep 5
ls -la /tmp/dd-out/datadoc/          # modelo/ (vacío o con demo.json ok:false), sello.json, build-*, current -> build-*
curl -s -H 'x-forwarded-email: admin@x.cl' http://127.0.0.1:8099/datadoc/ | grep -c 'NO medida'   # ≥1: la conexión demo aparece como no medida, con su error
curl -s -H 'x-forwarded-email: admin@x.cl' http://127.0.0.1:8099/datadoc/../contrato -o /dev/null -w '%{http_code}\n'   # 403 o 404 según normalice curl; NUNCA el contrato
```

`examples/` tiene specs sueltas en su raíz y `rls-areas.yaml` (verificado con `ls examples`); si ese YAML no es un policy store válido, el ejecutor elige otro. El nombre de la env del gate/CSRF lo confirma el ejecutor en `server/config.ts` y `deploy/compose.reference.yml` antes de correr; los de arriba son la forma, no una promesa (no verificado en este plan).

### ¿Contra un Datahouse real? (corrobora; no es la medición que falta)

Solo el operador de la instancia, en QA (`lab/deploy/mira-vm-qa`), con la imagen `sha-<commit>` del PR y `VERGIS_DATADOC=1`: una generación completa, y se compara **entidad por entidad** el `todas-las-entidades.html` del nodo contra el del lab (`lab/work/217-datadoc/`): mismas entidades por conexión; las clases pueden diferir donde el lab aplica prefijos (`_bak`, `raw_`) — esas diferencias se listan y se cierran con `clase:` en la `semantica.yaml` de la instancia, no tocando el motor. Esto **corrobora** lo ya medido por los tests; no lo reemplaza (Norma 7).

## ¿Cuáles son los criterios de aceptación?

- [ ] `VERGIS_DATADOC` ausente ⇒ `npm test` y la sonda de superficie de `tests/static-serve.test.ts:266` demuestran que nada cambió: sin ruta `/datadoc`, sin lazo `datadoc` en `/contrato`, sin sección en `/admin`.
- [ ] `VERGIS_DATADOC=1` con `VERGIS_ENGINE=clickhouse` ⇒ el arranque falla nombrando la env y el motor.
- [ ] `writers.yaml` y `semantica.yaml` cargan por `RELOADABLE_SLICES`, se recargan por watch y `SIGHUP`, y un archivo roto conserva lo vigente con `ok:false` en `/contrato`.
- [ ] `domains[].connections` se parsea; una conexión reclamada por dos dominios es error fatal del archivo.
- [ ] Sin `writers`/`semantica`/`domains`, el catálogo se genera y los textos son exactamente «escritor no declarado» / «sin descripción» / dominio técnico por `database_ref`.
- [ ] Ninguna consulta emitida por el generador contiene un verbo fuera de `SELECT`/`WITH` (el guard lo garantiza y un test lo mide con un SQL prohibido inyectado en la lista de consultas: lanza al cargar el módulo).
- [ ] Ningún `COUNT_BIG` se emite sobre una tabla `filtrada` o `indeterminada`; con `datadoc_conteos=off`, ninguno en absoluto.
- [ ] Una conexión que no responde deja el build con su modelo anterior marcado «NO medida» y la razón; sin modelo anterior, aparece en el sello como no medida y sin entidades.
- [ ] `current` nunca apunta a un build incompleto (test del swap) y se conservan dos builds.
- [ ] `/datadoc/` hereda contención, lista blanca y `nosniff`: la batería de traversal de `static-serve.test.ts:113-160` corre **también** sobre la colección propia.
- [ ] `POST /admin/datadoc/generar` exige CSRF, audita, es single-flight y responde 409 sin control.
- [ ] El schedule dispara una vez por período y persiste el `periodKey`.
- [ ] `/contrato` declara `datadoc` con build vigente, sello por conexión y estado en curso.
- [ ] El HTML emitido no contiene ninguna cadena de la lista de literales de instancia.
- [ ] `docs/capacidades.md` tiene `CAP-197`; `capacidades:cotejo` verde; `CHANGELOG.md` §Sin publicar la describe; `docs/arquitectura-multi-reporte.md` la explica con los dos YAML.
- [ ] CI verde; `npm run typecheck` verde.

## ¿Qué riesgos hay y cómo se revierte?

| Riesgo | Señal | Mitigación / reversión |
|--|--|--|
| **El Service Principal está exento de la RLS y un `COUNT` filtraría igual** (no verificado en Fabric) | — | No aplica: D6 no emite el `COUNT` sobre `filtrada`/`indeterminada`. La regla no depende de la respuesta del motor |
| **`sys.sql_modules` o `sys.security_predicates` denegados al SP en algún warehouse** | `errores[]` del modelo; gobierno `indeterminada` ⇒ sin conteos | Es la conducta diseñada: se declara, no se adivina. El operador da el permiso de lectura de metadatos o acepta el hueco |
| **`rename` sobre symlink no atómico en el FS del volumen** (se asume POSIX) | El test del swap ve `ENOENT` | Alternativa lista: `current` como **archivo** `current.txt` con el nombre del build, escrito por `write-tmp + rename` de archivo regular (atómico en cualquier FS local), y `getDatadocCollection` lo lee por request. Cambia una función del store, nada más |
| **Generación larga bloquea el event loop** | Latencia del nodo durante la corrida | La medición es I/O de red por conexión en paralelo; el render es CPU sobre cientos de entidades (el lab: 79 en ~ms). Si el render superara ~200 ms medidos, se parte por conexión con `setImmediate` entre páginas. Se mide en el arnés, no se asume |
| **Dos nodos con `VERGIS_OUT` compartido generan a la vez** | Builds cruzados | Solo el nodo con control genera (lazo desarmado en standby; `POST` ⇒ 409). Ventana residual durante el traspaso: `disarm()` espera el tick en vuelo (`control-loops.ts` garantía 1); el `POST` re-verifica `hasControl()` antes de escribir |
| **Instancia GH sirve hoy `/datadoc` por su propia colección/contenedor** | Tras activar `VERGIS_DATADOC=1`, la colección de instancia se omite con aviso y el nodo sirve el suyo | Es el cut-over deseado; reversión: quitar `VERGIS_DATADOC` (cambio de env ⇒ recreate ⇒ **ventana**, regla 17 bis del lab) o, sin corte, no generar nunca y dejar el «aún no generado»… que sí tapa la vieja. Por eso la activación en GH **se planifica con su ventana** y no se improvisa |
| **`semantica.yaml` grande y editado a mano rompe** | `ok:false` en `/contrato`, lo vigente se conserva | Contrato de recarga de todos los slices |
| **Rehacer lo ya hecho en el lab** (1.158 líneas) | — | El costo es de planificación, no de diseño: el emisor se porta, la medición se reimplementa sobre el conector del nodo (menos código que el pool propio del lab), y el lab conserva su script hasta adoptar `CAP-197` |

**Reversión del Producto**: la capacidad es opt-in por env; retirar `VERGIS_DATADOC` deja el nodo como 0.32.0 sin desinstalar nada. Los archivos bajo `$VERGIS_OUT/datadoc/` son inertes sin la env y se pueden borrar a mano.

## ¿Qué queda pendiente de decisión humana?

Las cuatro bifurcaciones de criterio que la v1.0 dejaba abiertas **se cerraron con una segunda mirada**
(juez independiente, 2026-09-21) y ya no esperan a nadie:

1. ~~**Conteos por defecto**~~ → **`abiertas`, con las dos correcciones de arriba**: la clasificación
   por forma completa (no por substring) y el build rancio que no publica conteos. El juez **objetó**
   el default tal como estaba escrito, no por el default sino porque su discriminante estaba roto.
2. ~~**Prefijo `datadoc`**~~ → **fijo**. Reversible, lo reserva la env; nadie tiene hoy una razón para moverlo.
3. ~~**`domains[].connections`**~~ → **en `domains.yaml`**, como propone D1: es un hecho del dominio.
4. ~~**Alcance de esquemas**~~ → **lista blanca `dbo`, ampliable por la instancia** (ver `Q_TABLAS`).

5. **Activación en la instancia GH — AUTORIZADA por César el 2026-09-21** («podemos activar en GH»).
   Lo que esa autorización cubre y lo que no: cubre **que se active**, y no exime de la **ventana de
   mantenimiento** (regla dura 17 bis del lab), porque `VERGIS_DATADOC` es cambio de env y recrea el
   contenedor. Tampoco adelanta nada por sí sola: **el generador no está construido** — este documento
   es el diseño. El orden es construir (PR, CI verde, imagen), coordinar con `work/017` fase 2 (retiro
   del contenedor `mira-datadoc-1` y del bloque del Caddyfile) y recién ahí pedir la ventana. Se deja
   dicho para que nadie lea «autorizado» como «se puede ejecutar hoy».

---

• *Generado con Wingworking*
