# Diseño · El ciclo de vida de un Let: `activate`, `deactivate` y `retire`

| Campo | Valor |
|--|--|
| Prindex | 020 · 001 |
| Versión | v1.0 |
| Fecha | 2026-09-30 |
| Origen | Issue [#392](https://github.com/Gegolabs/vergis/issues/392), trabajo 5 del diseño aprobado `roble/lab/work/288-diseno-plugins-vergis-custos-mira-v1.1.md` (tabla de `mira:status`, criterio 3). Parte de #387 |
| Estado | **Propuesta.** Pendiente del juicio de un modelo distinto del autor (Norma 8) y de las cuatro decisiones de César de §9. Lo marcado **(decidido)** no lo reabre el ejecutor; lo marcado 🙋 queda sin implementar hasta que César decida |
| De | 🤖 Simón Alero, agente de César Obach · **modelo del autor: Claude Opus 5.5** |
| Ejecutor | Un subagente con este documento como único contexto, en un worktree propio sobre `main` (≥ 0.41.0). No necesita la conversación que lo originó |
| Versión del Producto | Capacidad nueva ⇒ sube la Y en el próximo corte. Las filas de `docs/capacidades.md` toman el próximo `CAP-NN` libre al momento del PR (no se reserva acá) |

---

## ¿Qué decide este documento?

Qué significan `activate`, `deactivate` y `retire` —y con ellos `status`— para un Let hospedado por el nodo de Vergis: el Botlet de un Producto de Información (PI) servido por Mira, y por construcción cualquier otro Let (hoy también los de Daftar). Fija:

- una **máquina de estados** con sus transiciones prohibidas;
- qué ve el consumidor en cada estado, qué pasa con el gobierno, los permisos, las notas y el registro;
- **dónde vive** el estado y por qué ahí;
- la **clase del acto** de cada verbo y su gate;
- cómo lo consume `mira:status` y qué verbos nuevos necesita `vergis-ops`;
- un plan de implementación verificable paso a paso.

La tesis en una línea: **el ciclo de vida es del Botler, no de Mira ni del archivo del spec.** El spec dice *qué es* el Let (`specialize`); el estado de ciclo de vida dice *si está en servicio*, lo cambia un acto con actor y motivo, y queda en el log append-only. Hoy el Producto solo tiene un sustituto implícito —que el archivo esté o no esté en el directorio—, que no distingue «suspendido» de «retirado» de «se perdió el archivo», y no deja rastro de quién lo hizo.

## ¿Qué premisas se verificaron?

Medidas el 2026-09-30 contra `origin/main` en `ee31be9` (0.41.0) y contra el manifiesto unificado de la trilogía (AgencyDomains v1.2).

| # | Premisa | Estado | Evidencia |
|--|--|--|--|
| P1 | El Producto no implementa `activate`, `deactivate` ni `retire` para un Let | ✅ | `git grep -n -i -w -E "activate\|deactivate\|retire\|retired" -- server packages`: ningún resultado se refiere a un Let. Los únicos son del retiro de un archivo de carga (siguiente fila) |
| P2 | El comando de verificación del encargo (`git grep -i -E "\b(activate\|deactivate\|retire)"`) prueba la ausencia | ❌ **instrumento ciego** | En esta máquina (`git 2.50.1 Apple Git-155`) `\b` no funciona en el ERE de `git grep -E`: `git grep -c -i -E "\bretire" -- server` devuelve **0**, y `git grep -c -i -w "retire" -- server` devuelve **4 archivos** (`admin-cargas.ts:2`, `admin.ts:3`, `cargar.ts:2`, `serve-rls.ts:2`). La conclusión de P1 se sostiene, pero por la búsqueda con `-w`, no por la del encargo |
| P3 | La palabra `retire` ya tiene dos acepciones en el Producto | ✅ | (a) Retirar un archivo de una casilla de carga: `server/admin.ts:2210-2214` (audit `intake-retire`), `server/admin-cargas.ts:115`, `server/cargar.ts:836-842`. (b) Retirar un anillo: `deploy/rollout/botler-rollout` y `CAP-141` en `docs/capacidades.md:279`; en el CLI, `vergis-ops exec rollout retire` (`plugins/vergis/lib/rollout.mjs`). Ninguna es el ciclo de vida de un Let |
| P4 | El canon nombra los verbos pero no define su semántica | ✅ | Manifiesto unificado, líneas 1391 y 1395 (citadas en §«¿Qué dice el canon?»). `grep -n -i -E "activate\|deactivate\|retire"` sobre el manifiesto entero devuelve solo esas dos líneas |
| P5 | El nodo descubre los Lets releyendo el directorio de specs; un spec que aparece se sirve y uno que desaparece deja de existir (404) | ✅ | `server/serve-rls.ts:456-458` (`specPaths()` lee `*.yaml` del nivel superior de `VERGIS_SPECS_DIR`); `server/discovery.ts:104-190`; `server/routes.ts:426` (slug desconocido → 404 «Producto de Información no encontrado») |
| P6 | El hot-reload de specs existe y lo declara el contrato | ✅ | `server/serve-rls.ts:3588-3603` (`contract.watch` con `reloads: 'specs: rebuild del descubrimiento + re-verificación por-PI (fabric)'`) |
| P7 | La desaparición de un spec no deja rastro en el log append-only de gobierno | ✅ | El `watch:specs` solo llama `contract.record({ reason: 'watch:specs', …, servableLets })` (`serve-rls.ts:3594-3597`): un conteo en `/contrato`, sin identidad ni código de Let. `git grep -n -E "type: '(spec\|pi\|let)[-a-z]*'" -- server packages` devuelve solo los `pi-governance-write` de `server/pi-config.ts` |
| P8 | `/healthz` cuenta como `lets.total` a todo Let descubierto, y el predicado canónico exige `lets.serving == lets.total` | ✅ | `serve-rls.ts:1409-1422` (`total: all.length`); `server/routes.ts:168-187`; `CAP-177` en `docs/capacidades.md:335` |
| P9 | El gobierno por PI vive en `governance.sqlite`, indexado por `pi_code`, y ya tiene un precedente de estado por PI editable en caliente y auditado | ✅ | Tablas `pi_governance`, `pi_grant`, `pi_demanda`, `pi_display_name` en `packages/capabilities/src/governance-store.ts:777-809`. El renombre (#207) escribe `pi_display_name`, avisa al serving y audita `pi-governance-write`: `server/pi-config.ts:120-130`, `serve-rls.ts:465-471, 1668-1680` |
| P10 | Existe un log append-only encadenado por hash y el nodo lo usa para los actos de gobierno | ✅ | `packages/botler/src/log.ts:25-50`; `serve-rls.ts:1697-1698` (`${OUT}/admin-audit.log`, `retain: false`); `CAP-159` |
| P11 | La clase `Botler` del paquete no se instancia en el servidor | ✅ | `git grep -n -E "new Botler\b" -- server packages`: 0 resultados. El servidor usa `AppendOnlyLog` directo (`serve-rls.ts:1697`, `server/consola.ts:99`). Coincide con `work/013-cluster-botler-generico/01-…-v1.0.md:21` |
| P12 | El menú de la instancia (`VERGIS_MENU`, el `menu.yaml` de CLI) **no** lista PIs: sus enlaces los declara la instancia | ✅ | `server/menu-config.ts:1-12` («La instancia AGREGA, no reemplaza»; el «Catálogo de PIs» es ítem propio del Producto, o sea el índice `/`) |
| P13 | `pi-owners.yaml` (`VERGIS_PI_OWNERS`) solo siembra el gobierno de un PI la primera vez | ✅ | `server/instance-config.ts:226`; `serve-rls.ts:1200-1218` (`bootstrapPi` si no hay `pi_governance`), `:1689` |
| P14 | Los comentarios se anclan a la entidad gobernada (cruzan PIs) y las impresiones al slug del PI | ✅ | `docs/capa-de-notas.md:24-29, 64`; `packages/capabilities/src/notas-store.ts:253-255` (`impresion.pi_slug`) |
| P15 | El vocabulario de clases de acto es cerrado, y un gate sin declarar vale `approval` | ✅ | `plugins/vergis/lib/classify.mjs:11-15` (`read · content · version · boot · service · service-interrupting · destructive`) y `gateFor` en el mismo archivo |
| P16 | `vergis-ops` habla con el nodo desde dentro del anillo, forjando la identidad | ✅ | `plugins/vergis/lib/smoke.mjs:5-7, 31-33`; `contract.mjs:24-25`; `health.mjs:17` |
| P17 | Un nodo en espera rechaza toda mutación con 409 | ✅ | `CAP-178` (`docs/capacidades.md:336`); `serve-rls.ts:1428-1431` |
| P18 | El store de gobierno es compartido entre anillos (un anillo viejo lee el mismo archivo) | ✅ | `serve-rls.ts:1571` (`${OUT}/governance.sqlite`); `deploy/rollout/README.md:176` (el intent de handover vive en `${VERGIS_OUT}` y lo leen los dos anillos) |
| P19 | Los Lets de otras familias (Daftar) pasan por el mismo router y los mismos gates | ✅ | `server/routes.ts:417-437` («DESPACHO POR LET») |
| P20 | Hay entregas programadas por PI que habría que suspender | ❌ | `grep -n -i -E "slug\|piCode" server/notify.ts`: sus enlaces son de casillas y procesos (`:399, :535, :689`), no de PIs. Lo único por PI que corre en segundo plano es la **demanda de frescura** (`serve-rls.ts:2058-2068`) |
| P21 | El plugin `mira` (donde vivirá `mira:status`) existe | ❌ | `ls plugins/`: solo `vergis`. `mira:status` es trabajo del diseño 288, no de este |
| P22 | El nodo expone hoy un servidor MCP para que la Cognición lo opere | ❌ | `git grep -l -i "mcp" -- server packages`: 0 resultados. La API de operación se diseña HTTP, con el MCP como transporte posterior |
| P23 | `discover()` tiene muchos consumidores que hoy no distinguen estados | ✅ | `git grep -n "discover()" -- server`: 33 líneas; §«¿Cómo se implementa?», paso 3, las clasifica |

## ¿Qué dice el canon?

Fuente: el manifiesto unificado de la trilogía, parte AgencyDomains v1.2 (`agencydomains-org/twin/src/trilogia/_dist/Trilogia-MundoAgentivo-agentes-es.md`). Se cita por línea.

**Los verbos, sin definición** (línea 1391):

> «**Configurar el spec es operar**: para un platafórmico el spec es el input operacional. El agente evoluciona el spec **operando** (verbo `specialize`); la **cristalización** a registro versionado **sigue, no precede**; la proveniencia la da el append-log. **Verbos del API de operación**: `specialize` · `invoke`/`schedule` (discreta) · `read`/`subscribe` (continua) · `status`/`activate`/`deactivate`/`retire`.»

**Los estados que el canon enumera** (línea 1395, la prueba de vida):

> «**vida** — ¿tiene ciclo de vida que gestionar (activo · caído · degradado · retirado; `status`/`activate`/`deactivate`/`retire`; madurez) o solo una versión? Un `PI` pasa las tres → Botlet; Mira es el proto-Botlet (el motor)…»

**De quién es el ciclo de vida** (línea 1096):

> «**El Botler es genérico por definición (MUST)**: gestiona ciclo de vida, aislamiento y ejecución de *cualquier* Botlet **sin entender su dominio**.»

**Dónde se valida** (línea 1098):

> «Invoca el punto de validación que el tipo (o su proto-Botlet en G1) provee, le entrega el **contexto genérico** que controla (catálogo de Capabilities, identidad, políticas del AgencyDomain) y actúa sobre el veredicto — acepta, rechaza, registra en el append-only log.»

**Las dos superficies** (tabla de las líneas 1388-1389): el ciclo de vida del **código fuente** es «nivel-Botler», cadencia «Releases (Producto)»; la **operación** —«especializar/manifestar/consumir/controlar cada Botlet»— es «por-Botlet», cadencia «fluida (Instancia)».

**Las propiedades de la Capa 4** (líneas 1117-1119): «**No-repudio** — toda acción registrada con identidad, contexto y resultado» · «**Reversibilidad cuando aplica**» · «**Política antes de ejecución**».

**El log** (líneas 1716-1718): «Registro inmutable, encadenado criptográficamente, de toda acción… **Contenido mínimo de cada trace**: identidad del agente, capability invocada, tool ejecutado, **hash de parámetros y resultado**…, timestamp, contexto, y `previous_log_hash`». Y (línea 1365): «el append-only log **MUST** registrar el proto-Botlet de origen de cada Botlet instanciado».

**Una analogía, no una norma sobre Lets** (líneas 1287-1294): el ciclo de vida del **agente** tiene seis fases, y la sexta dice: «**Decommissioning** — … "decommissioned" ≠ "olvidado": el registro permite reconstruir auditablemente que el agente existió, qué hizo y por qué dejó de existir.» Es del agente, no del Let; se usa aquí solo como criterio para `retire`.

**Lo que el canon no dice** (buscado con `grep` sobre el manifiesto entero): no define el efecto de ninguno de los cuatro verbos, no da una máquina de estados del Let, no nombra un estado «inactivo» ni «especializado», y no dice si `retire` es reversible. La lista de la línea 1395 **mezcla dos ejes**: `activo` y `retirado` son estados que alguien **declara**; `caído` y `degradado` son estados que el nodo **observa**. Este diseño los separa (§«¿Qué significa cada verbo?») y los compone en `status`.

## ¿Qué significa cada verbo?

### ¿Cuáles son los dos ejes del estado de un Let?

| Eje | ¿Quién lo fija? | Valores | ¿Dónde se ve? |
|--|--|--|--|
| **Ciclo de vida** (declarado) | Un acto con actor y motivo: `activate` · `deactivate` · `retire`, más el alta implícita al descubrir un spec nuevo | `especializado` · `activo` · `inactivo` · `retirado` | `status`, `/contrato`, la configuración del PI |
| **Salud** (observada) | El nodo, en cada verificación | `sirviendo` · `bloqueado` (con motivo: `piBlocked`, `serve-rls.ts:1399-1408`) · `sin-spec` (el archivo no está o no parsea) · `pendiente` | `status`, `/contrato`, `/healthz` (solo conteos) |

`status` devuelve **los dos**. El `caído` y el `degradado` del canon son un `activo` cuya salud no es `sirviendo`. **(decidido)**

La identidad del Let es su `identity.code` (el mismo `pi_code` que ya indexa todo el gobierno, P9). El slug se deriva de él y no cambia (`discovery.ts:230`).

### ¿Cuál es la máquina de estados?

```
                  spec nuevo descubierto
                          │  (alta implícita; queda en el log)
                          ▼
                   ┌──────────────┐   retire    ┌────────────┐
                   │ especializado├────────────►│            │
                   └──────┬───────┘             │            │
                 activate │                     │            │
                          ▼                     │            │
                   ┌──────────────┐   retire    │ retirado   │
          ┌───────►│    activo    ├────────────►│ (terminal) │
          │        └──────┬───────┘             │            │
 activate │    deactivate │                     │            │
          │               ▼                     │            │
          │        ┌──────────────┐   retire    │            │
          └────────┤   inactivo   ├────────────►│            │
                   └──────────────┘             └────────────┘
```

| Desde \ verbo | `activate` | `deactivate` | `retire` |
|--|--|--|--|
| `especializado` | → `activo`, **si** el punto de validación acepta | ❌ 409 «no está activo: nada que desactivar» | → `retirado` |
| `activo` | idempotente: 200 «ya estaba activo», **sin** entrada en el log | → `inactivo` | → `retirado` |
| `inactivo` | → `activo`, **si** el punto de validación acepta | idempotente: 200, sin entrada | → `retirado` |
| `retirado` | ❌ 409 «retirado es terminal» | ❌ 409 | idempotente: 200, sin entrada |

**El punto de validación de `activate`** (canon, línea 1098): el nodo exige que el Let tenga spec, que parsee bajo su proto, que su familia esté registrada y que pase el gate de servibilidad del descubrimiento (`discovery.ts:147-177`). Si no, 409 con el motivo, y **una** entrada `let-lifecycle-rejected` en el log. Un Let activado nace, en `fabric`, en salud `pendiente` hasta su verificación por PI —el fail-closed que ya existe (`serve-rls.ts:1399-1407`)—. `activate` no espera la verificación: la dispara. **(decidido)**

**Transiciones que no pasan por un verbo**, y cómo se tratan **(decidido)**:

| Hecho | Efecto |
|--|--|
| Aparece un spec con un código que el nodo nunca vio | Alta en `especializado` (🙋 P-1: o en `activo`), con entrada `let-lifecycle` `from: null` en el log |
| Desaparece el spec de un Let `activo` | El estado **no cambia**; la salud pasa a `sin-spec`; `/healthz` lo cuenta como no servido (🙋 P-4) |
| Desaparece el spec de un Let `inactivo` o `retirado` | Nada que avisar: la salud `sin-spec` se ve en `status`, sin degradar el nodo |
| Aparece un spec cuyo código está `retirado` | **No se sirve.** Aviso nombrado en el log de arranque/recarga y en `/contrato`: «el código X está retirado desde F; usar otro `identity.code`». Miranda se niega a publicar ese código |
| Un spec cambia su `identity.code` | Para el nodo son dos Lets: el código viejo queda `sin-spec` en su estado, el nuevo nace `especializado`. `status` lo hace visible |

### ¿Qué ve el consumidor en cada estado?

«Consumidor» es quien pasaría `canOpenPi` para ese PI; quien no lo pasaría recibe lo mismo que hoy (403 o ausencia en el índice). «Gestor» es el dueño o colaborador del PI (`canCollaborate`) o un admin de plataforma.

| | `especializado` | `activo` | `inactivo` | `retirado` |
|--|--|--|--|--|
| Índice `/` (catálogo) | No aparece | Aparece (como hoy) | No aparece | No aparece |
| Enlace profundo `/<slug>[/…]` del consumidor | **404** idéntico al de un slug inexistente | Como hoy | **503** con página propia: «**Suspendido** desde ‹fecha›. ‹motivo›. Responde: ‹dueño›» | **410 Gone** con página propia: «**Retirado** el ‹fecha›. ‹motivo›.» y, si se declaró, «Lo reemplaza: ‹enlace al sucesor›» |
| Enlace profundo del gestor | Se sirve con una franja «Especializado — no visible para consumidores» (vista previa) | Como hoy | Se sirve con una franja «Suspendido — no visible para consumidores» | 410 como el consumidor; la configuración del PI sigue legible |
| `/<slug>/pdf` | Mismo gate que la página | Como hoy | Mismo gate que la página | 410 |
| Enlaces del `menu.yaml` que apunten al slug | El `menu.yaml` no se toca (es de la instancia, P12); el enlace lleva a la respuesta de la fila de arriba. `status` avisa de todo enlace del menú que apunte a un Let no `activo` | | | |

Por qué así **(decidido)**:

- `especializado` responde **404** al consumidor porque para él el Let todavía no existe; decir «existe pero no está listo» filtraría trabajo en curso.
- `inactivo` responde **503** porque es exactamente «no disponible ahora, volverá», y la página dice por qué y a quién preguntar. Esconderlo tras un 404 repetiría la falla muda que `discovery.ts:80-86` ya rechaza por escrito.
- `retirado` responde **410** porque es permanente, y la página es el «decommissioned ≠ olvidado» del canon: el enlace viejo explica qué pasó en vez de romperse.
- El gestor ve la vista previa de `especializado` e `inactivo` porque es quien tiene que verificar antes de activar o reparar antes de reactivar. `mira:status` la usa (§«¿Cómo lo usa `mira:status`?»).

### ¿Qué pasa con los datos, los permisos y las notas?

| Recurso | `especializado` | `activo` | `inactivo` | `retirado` |
|--|--|--|--|--|
| **Dato del PI** | Mira no tiene dato propio: lee la fuente con RLS. Ningún estado borra nada en la fuente | | | |
| **Gobierno del PI** (`pi_governance`, `pi_grant`, `pi_demanda`, `pi_display_name`) | Se siembra al descubrirlo (como hoy) y es editable | Editable | Editable | **Se conserva, congelado**: toda escritura en `/<slug>/config` responde 409 «retirado» |
| **Permisos del dato (Custos, `@vergis/policy`)** | Sin cambio: la RLS se ancla a la tabla, no al PI (`CAP-85`). El ciclo de vida del Let **no** toca políticas ni grants de la fuente | | | |
| **Comentarios** (anclados a la entidad, P14) | No se pueden escribir desde este PI (no hay vista de consumidor) | Como hoy | `POST /<slug>/comentarios` → 503 | → 410. **Los hilos no se borran**: siguen visibles desde cualquier otro PI que muestre la misma entidad |
| **Impresiones** (`impresion.pi_slug`) | — | Como hoy | Las existentes siguen en «Mis impresiones»; no se imprimen nuevas | Las existentes se conservan hasta su retención (`CAP-82`); no se imprimen nuevas |
| **Demanda de frescura** (`serve-rls.ts:2058-2068`) | No demanda | Demanda | **No demanda** | No demanda |
| **Datadoc** («quién lee cada tabla») | No figura | Figura | Figura, marcado «suspendido» | No figura |
| **Miranda** | Lista y edita el spec | Como hoy | Lista y edita el spec | No lo lista; se niega a publicar el código |
| **`/healthz`** | Fuera de `lets.total` | Dentro | Fuera | Fuera |

### ¿Qué queda en el log?

Cada transición efectiva escribe **una** entrada en `${VERGIS_OUT}/admin-audit.log` (el mismo `AppendOnlyLog` encadenado de P10) **(decidido)**:

```json
{ "type": "let-lifecycle", "let": "PI-12", "proto": "mira", "from": "activo", "to": "retirado",
  "by": "ops@instancia", "reason": "Reemplazado por PI-40", "replacedBy": "PI-40",
  "specSha256": "…", "via": "vergis-ops" }
```

- `proto` cumple el MUST de la línea 1365 del canon.
- `specSha256` fija **qué spec** estaba activo o se retiró, sin copiar su contenido (el canon pide hashes, línea 1718).
- Las transiciones implícitas (alta al descubrir) llevan `from: null`, `by: "nodo"`, `via: "descubrimiento"`.
- Un `activate` rechazado escribe `let-lifecycle-rejected` con el motivo.
- Los actos idempotentes **no** escriben: una entrada es un cambio.

## ¿Dónde vive el estado?

### ¿Qué alternativas hay?

| | Alternativa | A favor | En contra |
|--|--|--|--|
| **A** | Un campo del spec (`lifecycle: inactive`) | Viaja con el spec; visible en el repo del operador | **Mezcla `specialize` con operar el ciclo de vida**: el canon los nombra como verbos distintos. Obliga a cada proto a parsear el campo, y el Botler tendría que entender el spec de cada familia (contra la línea 1096). La siguiente publicación del spec desde el repo del operador (`parity --family specs`) reactivaría en silencio. `retire` exigiría conservar el archivo para siempre. Sin actor en el registro |
| **B** | La presencia del archivo en el directorio (lo que hay hoy) | Cero cambio | Solo dos estados. Borrar confunde «suspendido», «retirado» y «se perdió el archivo». Sin actor, sin motivo, sin página para el enlace viejo, gobierno huérfano. Rompe la paridad repo↔VM cada vez que se suspende algo |
| **C** | Un archivo de gobierno de la instalación (`lets.yaml`, recargado en caliente como `VERGIS_PI_OWNERS`) | Declarativo; revisable en el repo del operador; se publica con `vergis:publish` | El actor es «quien publicó», no quien decidió. El nodo **no puede** hacer cumplir «retirado es terminal» sin memoria propia: si el archivo vuelve a decir `activo`, o lo obedece (rompe la regla) o lo ignora (y entonces el archivo no es la verdad). Una API de operación que la Cognición invoque mañana por MCP necesita un verbo imperativo, no editar un YAML |
| **D** | **Una tabla del store de gobierno** (`let_lifecycle` en `governance.sqlite`), escrita solo por una API de operación del nodo, con la máquina de estados en `packages/botler` | Es exactamente la forma del canon: verbo imperativo, por-Let, fluido, con proveniencia en el append-log. Actor y motivo por construcción. El nodo hace cumplir las transiciones prohibidas. Sigue el precedente vivo del renombre (#207, P9) y de la pausa de procesos (`ingestion_process.paused_at`). El spec no se toca: la paridad repo↔VM sigue siendo verdad | El estado no está en el repo del operador (se mitiga: `/contrato` y `vergis-ops let status --json` lo exportan, y `governance.sqlite` ya se respalda con `VERGIS_OUT`). Un anillo de una versión anterior no conoce la tabla (se mitiga en el paso 7) |

### ¿Cuál se recomienda, y por qué?

**D (decidido).** El criterio de excelencia pide el camino ideal y no el que menos cambia, y el ideal lo describe el canon casi literalmente: el Botler genérico gestiona el ciclo de vida de cualquier Let sin entender su dominio, por un API de operación, y la proveniencia la da el append-log. A y B lo contradicen de frente; C lo parece, pero no puede sostener la única regla dura (la terminalidad de `retire`) sin convertirse en D con un archivo delante.

La forma concreta:

- **La máquina de estados es código del Botler**: `packages/botler/src/lifecycle.ts`, pura, sin I/O: estados, verbos, tabla de transiciones y `transition(from, verb)`. Así Daftar y cualquier familia futura la heredan sin una línea propia, y el día que la clase `Botler` se instancie en el servidor (P11) el ciclo de vida ya es suyo.
- **La persistencia es del nodo**: la tabla `let_lifecycle` en el store de gobierno, detrás de un puerto (`LetLifecycleStore`) que `packages/botler` declara y `packages/capabilities` implementa.
- **El nombre de la tabla es genérico** (`let_…`, no `pi_…`) porque el sujeto es el Let; la llave es el `identity.code`, que para un PI coincide con el `pi_code` del resto del gobierno.

Lo que se descarta, con su razón, queda en la tabla de arriba: A por mezclar dos verbos del canon y romper la genericidad; B por muda; C por no poder hacer cumplir la terminalidad.

## ¿Qué clase de acto es cada verbo y qué gate le toca?

Vocabulario cerrado del contrato (`classify.mjs:11`, P15). La clase la fija el verbo, no un archivo: estos actos no publican nada, así que `classifyPath` no aplica, igual que `service.mjs` fija la suya **(decidido)**.

| Verbo | Clase | Gate en la instalación (`governance.gates`) | Por qué |
|--|--|--|--|
| `status` | `read` | `free` típico | No cambia nada |
| `activate` | `content` | el de `content` (en CLI, `operator`) | En caliente, sin corte, reversible con un acto (`deactivate`). Es el mismo riesgo que publicar un spec, que ya es `content` |
| `deactivate` | `content` | el de `content` | En caliente y reversible con un acto. **No** es `service-interrupting`: esa clase nombra un corte **colateral** de rutas por recargar un servicio, que exige poller y ventana para el nodo entero; aquí el corte de **un** Let es el objeto mismo del acto, no toca el nodo ni el predicado de salud (sale de `lets.total`). El CLI declara el impacto antes de actuar (cuántos grants y qué visibilidad pierden acceso) |
| `retire` | `destructive` | el de `destructive` (en CLI, `approval`) | Irreversible por diseño: el código no vuelve a servirse. Es lo que la clase `destructive` existe para gatear |

Una clase sin gate declarado pide `approval` (`gateFor`), así que una instalación que no declare nada queda del lado seguro.

## ¿Cómo lo usa `mira:status`?

`mira:status` (diseño 288, fila de la tabla de verbos) deja de responder «no disponible» y usa cuatro verbos nuevos del CLI, genéricos del Botler —por eso bajo el sustantivo `let`, no `mira`—:

| Verbo de `vergis-ops` | Qué hace | Contra qué |
|--|--|--|
| `let status [<slug>] [--json]` | Tabla por Let: código, familia, estado declarado (con fecha, actor y motivo), salud observada, y los avisos (enlace del menú a un Let no activo, código retirado con spec presente, `activo` sin spec) | `GET /contrato` → bloque `lets` |
| `let activate <slug> [--reason <t>]` | Transición a `activo` | `POST /admin/api/lets/<code>/activate` |
| `let deactivate <slug> --reason <t>` | Transición a `inactivo`; el motivo es obligatorio porque lo lee el consumidor | `POST /admin/api/lets/<code>/deactivate` |
| `let retire <slug> --reason <t> [--replaced-by <slug>]` | Transición a `retirado` | `POST /admin/api/lets/<code>/retire` |

Cómo corren, siguiendo lo que el CLI ya hace (P16):

- Desde dentro del anillo activo, con la identidad de **operador** que declara la instalación (campo nuevo en `vergis-ops.json`, que el nodo exige que sea admin de plataforma) y el `x-gate-token` si la instalación lo usa.
- El endpoint es JSON y exige `content-type: application/json` más un encabezado propio (`x-vergis-op: 1`): una petición que un navegador no puede enviar entre sitios sin preflight. Así no hace falta el CSRF de formulario, que el CLI no puede calcular.
- Aplican el gate de su clase antes de llamar, y leen `status` después: el acto se da por hecho solo si `/contrato` muestra el estado nuevo.
- En un nodo en espera responden lo que responde el nodo: 409 nombrando al activo (P17).

El resto de `mira:status` no cambia: `smoke` y `marks` miden solo los Lets `activo` (el inventario se reconcilia con `lets.total`, que ahora cuenta solo esos) y, para verificar un `especializado` antes de activarlo, piden la vista previa con una identidad gestora de `probe_identities`.

La misma API la usa la superficie web: una sección «Ciclo de vida» en `/<slug>/config` y una lista en `/admin/lets`.

**Quién puede cada verbo** (🙋 P-3, con la recomendación como default de implementación): `activate` y `deactivate`, el dueño del PI o un admin de plataforma; `retire`, solo un admin de plataforma.

## ¿Cómo se implementa?

Diez pasos en orden. Los gates del repo (`npm run typecheck`, `npm test`, `npm run build`) corren verdes al final de **cada** paso. Donde dice «control negativo», el test tiene que **fallar** con el cambio revertido; el ejecutor lo comprueba una vez revirtiendo la línea clave y lo declara en el PR.

| # | Paso | ¿Cuándo quedó? | Prueba |
|--|--|--|--|
| 1 | `packages/botler/src/lifecycle.ts`: tipos `LetState`, `LetVerb`, la tabla de transiciones de §«¿Cuál es la máquina de estados?» y `transition(from, verb) → { to } \| { noop } \| { error, motivo }`. Exportado desde `index.ts`. Sin I/O | La tabla del documento y la del código coinciden celda por celda | Test tabular que recorre las 12 celdas. **Control negativo**: `transition('retirado', 'activate')` devuelve `error`; si se cambia a `to: 'activo'` el test falla |
| 2 | Tabla `let_lifecycle(let_code PK, proto, state, since, by, reason, replaced_by, spec_sha256)` en `governance-store.ts`, con `getLet`, `listLets` y `setLetState(code, expectedFrom, to, meta)` **con compare-and-set** sobre `expectedFrom`. Puerto `LetLifecycleStore` declarado en `packages/botler` | Dos escrituras concurrentes desde el mismo estado: una gana y la otra recibe `GovernanceConflict` | Test del store: CAS. **Control negativo**: sin la condición `WHERE state = ?` el segundo escritor gana y el test falla |
| 3 | El descubrimiento anota cada `Report` con su `lifecycle` y su salud, y expone el inventario `lets()` = unión de los specs descubiertos y las filas de `let_lifecycle` (así un Let sin spec sigue existiendo). `discover()` conserva su forma y agrega un `served()` = solo `activo`. Se clasifican los 33 usos de `discover()` (P23) con esta regla, y la tabla resultante va al PR: **servir y contar** (router, índice, `healthSummary`, PDF, notas) → `served()`; **gestionar y previsualizar** (`/<slug>/config`, `resolvePi` de notas para el gestor) → todo menos `retirado`; **frescura** (`:2062`) → `served()`; **datadoc** → `activo` + `inactivo`; **Miranda** `listSpecs` → todo menos `retirado`; **colisión de estáticos** (`:306`, `:3418`) → todos los códigos, incluidos los retirados (el slug sigue reservado) | Ningún uso de `discover()` queda sin clasificar en la tabla del PR | Tests de `discovery.ts` con un store falso: un `inactivo` sale de `served()` y sigue en `lets()`; un `retirado` con spec presente no se sirve y emite el aviso nombrado |
| 4 | Router (`server/routes.ts`): después de «existencia» y antes de `piBlocked`, el gate de ciclo de vida con las respuestas de §«¿Qué ve el consumidor?» (404 · franja · 503 con página · 410 con página), aplicado igual a `/<slug>`, `/<slug>/…` (Daftar incluido), `/<slug>/pdf`, `/<slug>/comentarios`, `/<slug>/imprimir`, `/<slug>/notas`. Escrituras en `/<slug>/config` de un `retirado` → 409 | Matriz estado × rol respondida como el documento | Test por celda de la matriz. **Control negativo**: un consumidor pide `/<slug>` de un `inactivo` y el test verifica con un espía que la Capability de serving **no se invocó** (0 llamadas); sin el gate, la llamada ocurre y el test falla |
| 5 | `/healthz`: `lets.total` y `lets.serving` cuentan solo `activo`; se agregan `lets.inactive`, `lets.specialized` y `lets.retired` **solo cuando son > 0** (el patrón de `stores.degraded`, `routes.ts:181-190`). `/contrato` gana el bloque `lets[]` `{ code, proto, state, since, by, reason, replacedBy, health, healthReason }` | Con un Let desactivado de N, el predicado `HTTP 200 ∧ phase=serving ∧ lets.serving == lets.total` sigue verdadero | Test de `routes`. **Control negativo**: si `total` sigue contando todos los descubiertos, el predicado da falso con un Let desactivado y el test falla. Segundo test: un `activo` sin spec **sí** degrada (`phase=degraded`) — 🙋 P-4 |
| 6 | API de operación: `POST /admin/api/lets/<code>/{activate,deactivate,retire}` (JSON, `x-vergis-op: 1`), permisos de §«¿Cómo lo usa `mira:status`?», punto de validación en `activate`, motivo obligatorio en `deactivate` y `retire`, `replacedBy` debe ser un código `activo`. Cada transición efectiva escribe `let-lifecycle` en `admin-audit.log`; un rechazo escribe `let-lifecycle-rejected`; los idempotentes no escriben. En standby, 409 (P17). El descubrimiento escribe el alta implícita (`from: null`) | Las entradas del log tienen los campos de §«¿Qué queda en el log?» y la cadena verifica | Test de integración sobre el servidor de prueba: transición, cadena verificada (`verifyChainLines`), idempotencia sin entrada. **Control negativo**: un no-admin intenta `retire` → 403 y **ninguna** entrada nueva en el log |
| 7 | Migración y guarda de vuelta atrás. (a) Siembra: al primer arranque de la versión nueva, todo código descubierto sin fila entra `activo` con `via: "siembra"`, y se marca `platform_setting.lets_lifecycle_seeded_at`; desde entonces los códigos nuevos nacen según 🙋 P-1. (b) Guarda: `vergis-ops exec rollout rollback` y `promote` a una versión anterior a la que trae este diseño **se niegan** si hay Lets en `especializado`, `inactivo` o `retirado`, nombrándolos, salvo `--acepto-reexponer`: un anillo viejo no conoce la tabla (P18) y los volvería a servir | Una instancia existente arranca la versión nueva sirviendo exactamente los mismos PIs que antes | Test de arranque con un directorio de specs y un store vacío: mismos slugs en el índice antes y después. Test del CLI en el banco (`deploy/rollout/bench`): el rollback se niega con un Let inactivo. **Control negativo**: sin la guarda, el rollback procede y el test falla |
| 8 | CLI: `vergis-ops let status\|activate\|deactivate\|retire` (§«¿Cómo lo usa `mira:status`?»), con su clase fija, el gate de la instalación, la identidad de operador nueva en `vergis-ops.schema.json` (y en `check`), y la verificación posterior contra `/contrato` | `let retire` con gate `approval` y sin OK no llama al nodo | Test en `plugin-e2e.sh` del banco: `let deactivate` + `let status` muestra `inactivo`; `let activate` lo devuelve. **Control negativo**: `let retire` con gate `approval` sin OK sale con el código «no corrí» y el nodo no registra nada |
| 9 | Superficie web: sección «Ciclo de vida» en `/<slug>/config` (estado, fecha, actor, motivo y los botones que el rol permite) y lista `/admin/lets` con los dos ejes. Las páginas de 503 y 410 del consumidor | Un dueño suspende y reactiva desde la web; un admin retira | Tests de `pi-config` y `admin` con CSRF. **Control negativo**: un colaborador no ve el botón «Retirar» y su POST forjado responde 403 |
| 10 | Documentación y versión: filas nuevas en `docs/capacidades.md` (ciclo de vida del Let; API de operación; `lets[]` en `/contrato`; conteos nuevos de `/healthz`; verbos `let` del CLI), `docs/superficie-de-estado.md`, el `RUNBOOK` de anillos (la guarda del paso 7) y la entrada del CHANGELOG con **qué exige**: los PIs nuevos nacen según P-1; quitar el spec de un Let activo degrada el nodo (P-4); la vuelta atrás a una versión anterior con Lets no activos está guardada; el campo de identidad de operador en `vergis-ops.json` | El CHANGELOG nombra los tres cambios de conducta visibles para un operador | Revisión del PR contra esta lista |

Lo que **no** entra, y por qué: el servidor MCP del nodo (no existe, P22; la API HTTP es su base), la instanciación de la clase `Botler` en el servidor (trabajo del cluster 013), y el plugin `mira` (trabajo del diseño 288, P21).

## ¿Qué decide César?

**P-1 · ¿Un PI nuevo nace `especializado` o `activo`?**
Hoy publicar un spec lo sirve en el acto (`CAP-162`). Con `especializado`, publicar deja de exponer: hace falta `activate`, y `mira:specialize` gana un paso.
*Recomendación: `especializado`.* Es la separación que el canon hace entre `specialize` y `activate`, y da una vista previa real para verificar antes de exponer. Los PIs existentes no cambian: la siembra del paso 7 los deja `activo`.

**P-2 · ¿`retire` es terminal, o sea, el código nunca vuelve a servirse?**
*Recomendación: terminal.* Un enlace retirado responde siempre lo mismo, y el log no tiene que explicar resurrecciones. Para volver a publicar el mismo contenido se usa un código nuevo con `--replaced-by`. Si se equivoca, el costo es cambiar el código de un PI.

**P-3 · ¿Quién puede cada verbo?**
*Recomendación:* `activate` y `deactivate`, el dueño del PI o un admin de plataforma, porque es la misma autoridad que ya decide su visibilidad. `retire`, solo un admin de plataforma, además del gate `destructive` de la instalación.

**P-4 · ¿Quitar el spec de un PI `activo` degrada el nodo?**
Hoy borrar el archivo es la forma de dar de baja un PI, y el nodo sigue `serving`. Con esta propuesta el nodo pasa a `degraded` hasta que alguien lo desactive o lo retire, y la promoción de anillos se frena (su predicado exige `serving`).
*Recomendación: sí, que degrade.* La baja pasa a ser un acto con actor, motivo y página para el enlace viejo, y un archivo perdido por accidente deja de ser una baja silenciosa. Cambia la práctica de CLI, y el CHANGELOG lo avisa.

---

• *Generado con Wingworking*
