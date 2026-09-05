---
doc_id: 013
cluster: 013-cluster-botler-generico
tipo: Diseño rector (Fable) — para refrendo, no para ejecución directa
version: 1.0
fecha: 2026-09-05
destinatario: César (refrendo de las bifurcaciones). Los briefs ejecutables para Opus se derivan de este documento después del refrendo.
estado: BORRADOR PARA REFRENDO — nada de lo aquí propuesto se ha construido
fuentes:
  - vergis · packages/botler/src/{botler,types}.ts · server/{serve-rls,routes,discovery,identity,contract}.ts · deploy/rollout/{vergis-rollout,README,RUNBOOK}.md · deploy/Caddyfile.reference · Dockerfile · POLICIES.md · CLAUDE.md · issues #110 #111 #113
  - estudios · daftar/app/{server.py,static/app.js} · daftar/CLAUDE.md · daftar/deploy-cloud.sh
  - AgencyDomains v1.1 · Cap 5 §2 (Botlet, tres pruebas, Botler, dos superficies) · Cap 9 (Vergis)
  - soveria-host (107.23.228.10) · medido el 2026-09-05 por ssh
relacionado: mira-ops (skill del operador de A.R.B.O.L.) · plan 040 de identidad (ultrago) · CHANGELOG de Vergis 0.21.0–0.26.0 (anillos)
---

# El Botler como runtime genérico y Daftar como segundo proto-Botlet

**Doc 013 · v1.0 · 5 de septiembre de 2026 · borrador para refrendo**

> **La tesis en una línea.** Vergis ya tiene, repartido en tres lugares, todo lo que el canon llama Botler —el runtime que hospeda Lets sin entender su dominio, el plano de control con lease, el ciclo de vida del código por anillos—, pero **cableado con la forma de Mira**: el nodo descubre specs con el parser de Mira, cuenta la salud en «PIs» y la clase `Botler` del código no se instancia en el servidor. Este diseño saca esa forma a un **registro de proto-Botlets**, deja a Mira como el primero, e incorpora **Daftar como el segundo** —de otra familia— en una segunda instancia de Vergis. La prueba de que el Botler es genérico es que hospede dos.

---

## 1 · Qué dice el canon, y qué exige de esto

Tres cosas del Cap 5 §2 de AgencyDomains v1.1 gobiernan este diseño; se citan porque son el criterio contra el que se juzga cada bifurcación:

1. **«El Botler es genérico por definición (MUST)»**: gestiona ciclo de vida, aislamiento y ejecución de *cualquier* Let **sin entender su dominio**. No existen subtipos de Botler por familia de operación. **1 Proceso = 1 Botler + N Lets.**
2. **Las dos superficies.** «Ciclo de vida del código fuente — instalar, versionar, cargar y descargar el motor — **granularidad nivel-Botler**, cadencia releases» y «Operación — especializar, manifestar, consumir y controlar cada Let — por-Let, fluida». Los anillos son la implementación de la primera fila. Por eso son del Botler y no de Mira.
3. **Las tres pruebas del Botlet** (v1.1): minion (¿se ejecuta o se aplica?), especialidad (`RISC`: una especialidad por unidad) y vida (¿ciclo de vida o solo versión?). Deciden qué es Let y qué es contenido en Daftar (§4).

## 2 · El terreno, medido hoy

Cada afirmación de esta sección se verificó el 2026-09-05 contra el código, el host o el repo. Lo que no se verificó se marca.

### 2.1 · El nodo de Vergis es el Botler de facto, con la forma de Mira

| Pieza | Dónde | Qué se midió |
|---|---|---|
| La clase `Botler` (register · invoke · capabilityCall · fallback · log) | `packages/botler/src/botler.ts` | **No se instancia en el servidor.** El servidor importa del paquete solo tipos, `AppendOnlyLog`, `withResultCache` e `identityFromHeaders`. `MiraBotlet implements Botlet` existe, pero el nodo no lo hospeda vía `Botler.register/invoke` |
| Descubrimiento de Lets | `server/discovery.ts` | Importa `parseSpec` de `@vergis/mira`: **solo sabe parsear specs de Mira**. Un YAML que no parsea como Mira se omite en silencio |
| Despacho de un Let | `server/routes.ts:210,264` | `deps.renderReport(report, headers, nav)` — una sola función de render, la de Mira |
| Predicado de salud | `/healthz`, `deploy/Caddyfile.reference`, `vergis-rollout`, poller del RUNBOOK | `200 ∧ phase=serving ∧ pis.serving == pis.total`. **«pis» es vocabulario de Mira dentro del contrato del nodo.** El contrato (`servablePis`) igual |
| Plano de control | `server/control-loops.ts`, `packages/capabilities/src/control-lease.ts`, `routes.ts:80-105` | Lease sobre el directorio compartido; standby responde 200 sin `serving` y rechaza mutaciones con 409 nombrando al activo. **Es genérico**: no sabe de PIs |
| Stores | `packages/capabilities/src/{governance,notas,master-data}-store.ts`, `sqlite.ts`; labels `vergis.schema.stores` en el Dockerfile | Patrón repetible: SQLite en volumen persistente, esquema por store, guard en `/contrato` y gate de esquema en `promote` |
| Identidad | `server/identity.ts`, `@vergis/botler identityFromHeaders` | oauth2-proxy → `X-Forwarded-Email` → claims desde directorio (archivo o store) → RLS. Fail-closed |

### 2.2 · La herramienta de anillos: qué es genérico y qué está atado a Vergis

`deploy/rollout/vergis-rollout` (1.087 líneas, POSIX sh, solo `docker` y `sed`), con `install · promote · rollback · retire · prune · status`, intent de handover, flip del borde antes del handover, vuelta atrás con presupuesto, smoke y registro `rings.json`.

| Genérico ya (por env) | Atado a Vergis (a generalizar o a asumir como contrato del nodo Botler) |
|---|---|
| Imagen (`RINGS_IMAGE`), borde, timeouts, retención, token del gate | Prefijo de contenedor `vergis-<v>` |
| Registro `rings.json`, `active.caddy`, `ring.args` | Predicado `pis.serving == pis.total` |
| Orden flip → handover → relevo dirigido → borde sano → smoke | Gate de esquema por labels `vergis.schema.stores` y `/contrato` |
| | Sonda por `docker exec <anillo> node -e fetch` (asume `node` en la imagen) |
| | Handover por `SIGUSR2` + archivo de intent |

**Lectura:** todo lo de la columna derecha, salvo el prefijo y el vocabulario `pis`, **es el contrato del nodo Botler** y está bien que lo sea. La herramienta no necesita hospedar imágenes ajenas; necesita hospedar **nodos Botler** que cumplan ese contrato. De ahí la bifurcación B1.

### 2.3 · Daftar hoy

Servidor Python stdlib de un proceso (`daftar/app/server.py`, 1.154 líneas) + frontend (`static/app.js` 2.163 líneas, `style.css`) + guías JSON (60) + progreso y reportes en archivos JSON. Modos `practice`/`exam` con portada, cronómetro, corrección al final, confianza S·C·A (desde hoy), reportes con revisión manual, impresión, y una integración con el **modo foco de ultraGO** (`ULTRAGO_FOCUS_URL`: una sonda en el Windows del estudiante recicla el WebView2 durante un examen). Estudiante por parámetro `?s=`. Estado en la nube: `/srv/daftar` en soveria-host, systemd, puerto 8090 detrás de nginx.

**Hallazgo del día, no documentado en ninguna parte:** `daftar.ultrago.io` **ya no usa basic auth**. nginx hace `auth_request` contra un `oauth2-proxy-daftar.service` que autentica contra **Keycloak**, y Keycloak corre en la misma caja (`keycloak-keycloak-1` + `keycloak-postgres-1`, arriba hace 3-4 semanas). nginx reenvía `X-Auth-Request-Email` al 8090 **y Daftar lo ignora**: sigue leyendo `?s=`. La Fase 1.5 del plan 040 de identidad está hecha en la infraestructura y no en la aplicación. `daftar/CLAUDE.md` y el store `jumpserver/aws-infra` siguen diciendo basic auth: quedan corregidos por este documento y hay que corregirlos allá.

### 2.4 · La caja

soveria-host: **2 vCPU · 3,8 GB RAM (2,6 disponibles) · 23 GB libres**. Docker 25 con Keycloak + Postgres; systemd corre nginx, `daftar`, `oauth2-proxy-daftar`, `soveria-subscribe`. **nginx es dueño del :443** (soveria.ai, id.ultrago.io, daftar.ultrago.io).

### 2.5 · El roadmap ya apunta acá

El issue paraguas **#113** nombra «Realtime — **Botler persistente** + SSE» como frente de largo plazo. Este diseño no lo construye, pero le deja el nodo con registro de Lets, que es su precondición.

## 3 · Las bifurcaciones, decididas por el criterio de excelencia

La pregunta que resuelve cada una: *si nada estuviera implementado y diseñáramos todo hoy, ¿qué haríamos?* Lo construido entra como dato de planificación, no de corrección.

### B1 · ¿Daftar como proceso externo hospedado por la herramienta de anillos, o como proto-Botlet dentro del nodo?

**Decisión: proto-Botlet dentro del nodo.** Un proceso externo con su propio puerto exigiría que Daftar implementara, en Python, el contrato del nodo: fase `standby/serving`, lease, `SIGUSR2`, intent, `/contrato`, gate de esquema. Eso es **reimplementar el plano de control del Botler** en un segundo lenguaje, y el canon dice que ese plano es del Botler. Un Botler que solo sabe hospedar Vergis no es genérico; un Botler que hospeda dos proto-Botlets de familias distintas, sí.

**Costo, dicho de frente:** reescribir el servidor Python como paquete TypeScript del nodo. El frontend (`app.js`, `style.css`) se reutiliza casi entero, embebido en el HTML como hace Mira (`render-html-piece.ts` inyecta sus `<script>` inline; el nodo no sirve estáticos). Las guías JSON **se conservan como formato**: ya son un spec.

### B2 · ¿Dónde vive el proto-Botlet Daftar: en Vergis público o en un códice privado?

**Decisión: en Vergis público, como segundo proto-Botlet de referencia** (`packages/daftar`). Razones: (a) es la única prueba ejecutable de que el Botler no tiene subtipos por familia; (b) no hay secreto de negocio en un evaluador de instrumentos; (c) **los instrumentos** —las guías de los tres hijos— son contenido de instancia y viven fuera del repo, exactamente como los specs de A.R.B.O.L. viven en `/opt/vergis/specs` y no en Vergis. **Pide refrendo**: entra a un repo AGPL y «Daftar» pasa a ser nombre propio del catálogo público, al lado de Mira.

### B3 · ¿Qué es el Let en Daftar?

Se aplican las tres pruebas a los tres candidatos:

| Candidato | Minion (¿se ejecuta?) | Especialidad | Vida | Veredicto |
|---|---|---|---|---|
| **El evaluador** (aplica, corrige, registra, reporta) | Sí, en cada request | Una: evaluar | Sí: standby/serving, 409 sin control, se retira | **Let** |
| **Una guía publicada** | No: se aplica | — | Solo estado editorial (vigente/retirada, versión) | **Contenido de catálogo** |
| **Un evaluador por estudiante** | Sí | Ninguna nueva: el estudiante es audiencia, no especialidad | — | **No**: Mira no crea un PI por viewer; la audiencia es autorización |

**Decisión:** un Let `evaluador` por instancia, declarado en un spec `daftar.yaml` con discriminador `daftar_version` (como `mira_version`); los **instrumentos** viven en un directorio propio (`VERGIS_INSTRUMENTOS_DIR`) que el Let relee en caliente, con la misma mecánica de `VERGIS_SPECS_DIR`. Publicar un instrumento es copiar un archivo; un instrumento publicado es **inmutable** (cambiarlo es publicar otro id), y se retira con un flag, no borrándolo. Los estudiantes son identidad (§B4) y su alcance es ACL en el store, como el gobierno de PIs.

### B4 · Identidad

**Decisión: el estudiante es el login, no un parámetro.** El camino ya existe y ya está en producción: Keycloak → oauth2-proxy → cabecera de email → `identityFromHeaders` → claims desde el directorio. Se agrega al directorio de la instancia el claim `student` por email (`matias.obach@gmail.com → matias`, etc.) y César como admin de plataforma (`VERGIS_ADMIN_SEED`). Desaparece `?s=`. El nodo espera `X-Forwarded-Email`; nginx hoy manda `X-Auth-Request-Email`: se alinea en nginx, una línea.

### B5 · La instancia «estudios»: dónde y con qué borde

Hechos que la deciden: nginx es dueño del :443 en la caja; Keycloak y su oauth2-proxy ya están; la memoria disponible (2,6 GB) admite dos anillos con límite de 512 MB más el conmutador, sin sidecar de PDF.

**Decisión: misma caja, y nginx sigue siendo el borde TLS y de identidad.** La instancia Vergis aporta solo lo que falta: el **conmutador de anillos** (Caddy en `:8079`, interno, con la sala de espera) y los anillos. nginx deja de apuntar al 8090 y apunta al conmutador. Es la topología de `Caddyfile.reference` con el tramo TLS+SSO resuelto por lo que ya hay, en vez de un segundo terminador TLS peleando por el puerto. **Alternativa registrada:** una VM propia (t4g.small, ~US$12/mes): más limpia, pero es obligación recurrente y por POL-01 la decide César. Se recomienda empezar en la misma caja y medir memoria antes de gastar.

### B6 · El vocabulario del contrato del nodo: `pis` → `lets`

**Decisión: se cambia ahora**, en el `/healthz`, el `/contrato`, el predicado del Caddyfile de referencia, la herramienta de anillos y el poller del RUNBOOK, todo en el mismo PR. Rompe el predicado de salud de una instancia que actualice el nodo sin actualizar su borde y su herramienta: el CHANGELOG lo declara con «rompe» y la instancia A.R.B.O.L. lo adopta en su siguiente promoción, que es exactamente el acto que la herramienta ya sabe hacer. Pre-launch, con un solo operador que es esta misma casa: la ventana barata es esta.

### B7 · `mira-ops` es, en su mayor parte, `botler-ops`

La skill del operador mezcla tres capas: **A** spec de PI (operación por Let: caliente, sin restart), **B** imagen del Producto (ciclo de vida del código: anillos), **C** infra de instancia (compose, Caddy, oauth2-proxy), **D** runner QC① y **E** terreno Fabric (A.R.B.O.L. puro). A, B y C son del Botler y de la instancia genérica; D y E son del cliente. **Decisión:** el Producto entrega `botler-ops` como skill genérica derivada de su propio `RUNBOOK.md` y `README.md` de anillos (que ya son eso), y `mira-ops` queda como la skill de la instancia A.R.B.O.L. que la importa y agrega su terreno. La instancia «estudios» usa `botler-ops` sin tocar nada de A.R.B.O.L.

### B8 · Lo que el canon todavía no dice

Dos puntos que **no se inventan acá** y suben a decisión del autor del canon:

1. **La familia de manifestación del evaluador.** El Cap 5 nombra información (deja un PI), actuación (efecto sobre el mundo) y decisión. Un instrumento aplicado deja un **registro del intento** —respuestas, confianza, tiempo, corrección—. Propuesta para el libro: es manifestación de la familia de información (un registro es un producto de información sobre el estudiante), pero la decisión es del canon, no de este diseño.
2. **El Cap 9 (Vergis) nombra a Mira como único proto-Botlet del catálogo.** Con Daftar dentro, la tabla de nombres propios gana una fila. Cambio de forma en el libro (Z) cuando B2 esté refrendada y construida, no antes.

## 4 · La arquitectura objetivo

```
Internet ──► nginx :443  (TLS · auth_request → oauth2-proxy-daftar → Keycloak)   [existe]
                │  X-Forwarded-Email
                ▼
          caddy :8079  (conmutador de anillos + sala de espera)                 [nuevo, de compose.reference]
                │  rings/active.caddy — una línea que reescribe botler-rollout
                ▼
     vergis-<v> :8080  ══ EL NODO BOTLER ══  (anillo activo; el previo en standby)
        ├─ plano de control (lease · standby/serving · 409 sin control)          [existe]
        ├─ /healthz  200 ∧ phase=serving ∧ lets.serving == lets.total            [B6]
        ├─ /contrato · stores con esquema · append-only log                      [existe + store nuevo]
        ├─ REGISTRO DE PROTO-BOTLETS                                             [H0]
        │     ├─ mira    → specs *.yaml con mira_version   → N PIs (Lets)        [existe, re-cableado]
        │     └─ daftar  → daftar.yaml (daftar_version)    → 1 evaluador (Let)   [H3]
        │                  └─ lee VERGIS_INSTRUMENTOS_DIR en caliente (guías JSON, inmutables)
        └─ identidad: email → claims (student · admin) → alcance                  [existe + directorio]

     /opt/estudios/{specs, instrumentos, governance, identity}                    [instancia; fuera del repo]
```

Un solo nodo hospeda los dos proto-Botlets. La instancia «estudios» arranca con `daftar` y queda lista para PIs de Mira sobre los datos del preu de Matías (`respuestas.csv` y los reportes de trayectoria son, literalmente, Productos de Información), sin construir nada más.

## 5 · El plan por hitos

Cada hito se entrega a un realizador Opus con brief propio, worktree propio y gate declarado; Fable escribe los briefs **después del refrendo** de este documento. Los gates se corren serializados (regla 2 de wingcoding).

| # | Hito | Repo | Qué produce | Gate (juez) | Depende de |
|---|---|---|---|---|---|
| **H0** | **Registro de proto-Botlets en el nodo.** Interfaz `ProtoBotlet { type; discriminate(specText); parse; validate; capabilitiesOf; tablesOf; invoke → output; routes? }`. `discovery.ts` despacha por discriminador; `routes.ts` invoca por tipo; Mira se registra como primero. **Cero cambio de conducta** | vergis | Nodo con registro; Mira igual que hoy | `typecheck` + suite verde + el banco de anillos (`deploy/rollout/bench`, 9 PIs) sin diferencia contra la línea base | — |
| **H1** | **`pis` → `lets`** en healthz, contrato, Caddyfile de referencia, `vergis-rollout` (que pasa a llamarse `botler-rollout`, con alias), RUNBOOK y poller. CHANGELOG con «rompe» | vergis | Contrato del nodo en vocabulario del canon | Banco de anillos e2e local: promoción sin corte medida con poller + **control negativo rojo** | H0 |
| **H2** | **Store `evaluaciones`** (SQLite, `schema.stores` `evaluaciones=1`, guard en `/contrato`): instrumento publicado · intento · respuesta (elección, confianza) · revisión · reporte. Migración desde los JSON de progreso de Daftar | vergis | Persistencia del evaluador con el patrón de la casa | Unit + importación de los 49 progresos reales de `daftar/app/progress` sin pérdida (conteo por guía) | H0 |
| **H3** | **`packages/daftar`, el proto-Botlet.** Spec `daftar.yaml`; catálogo por estudiante (home), render de instrumento (frontend actual embebido), API JSON de progreso (**POST gated por el plano de control → 409 en standby**), corrección, reportes, impresión, modo foco. Estudiante desde claims | vergis | El evaluador como Let | Unit + e2e local con dos anillos: **publicar un instrumento en caliente sin reinicio, medido**; promoción sin corte con un intento a medias que no se pierde | H0 · H2 |
| **H4** | **Migración del contenido**: las 60 guías → instrumentos (formato conservado; `student` deja de vivir en el JSON y pasa al directorio de identidad); recortes del preu; paridad funcional contra una lista cerrada de 15 conductas del Daftar actual | estudios | Instancia con su contenido | Lista de paridad 15/15 verificada a mano por César con una guía de cada hijo | H3 |
| **H5** | **Instancia «estudios»** en soveria-host: compose derivado de `compose.reference` (solo caddy conmutador + anillos + volúmenes), `ring.args`, `rings/`, directorio de identidad, nginx apuntando al conmutador y mandando `X-Forwarded-Email`. **Nada se corta hasta el flip de nginx**, que es un `reload` | infra | Daftar servido por un anillo, con login real | Smoke por el borde: `/healthz` predicado nuevo; Matías entra con su Google y ve solo lo suyo; César ve todo; **memoria medida** con dos anillos calientes | H4 (contenido) · puede aprovisionarse en paralelo desde H1 |
| **H6** | **`botler-ops`**: skill genérica extraída de `RUNBOOK.md` + `README.md` de anillos; `mira-ops` la importa y conserva D y E | protocolos | Operación uniforme para las dos instancias | Una promoción real en «estudios» siguiendo solo `botler-ops` | H1 |
| **H7** | **Canon**: B8 resuelta por César → AgencyDomains v1.2 (Cap 5 familia del evaluador · Cap 9 fila de Daftar) | agencydomains-org | Libro al día con la referencia | Build de los manifiestos ES/EN | B2 refrendada · H3 construido |

**Paralelismo:** H1 y H2 corren en paralelo después de H0 (tocan archivos distintos). H3 espera a ambos. H5 se aprovisiona desde H1 (infra) y recibe contenido en H4. H6 en cualquier momento después de H1.

**El día 1 de Matías no espera a nada de esto.** El script `deploy-cloud.sh` del 5-sep sigue siendo el escalón para la semana que viene, con su `--apply` pendiente de refrendo. Es infraestructura desechable por diseño: H5 la retira.

## 6 · Lo que este diseño NO hace

- No reescribe Mira ni toca su DSL. H0 la re-cablea sin cambiar una línea de conducta.
- No construye el Botler persistente ni SSE (#113). Los deja como siguiente paso natural sobre el registro de Lets.
- No implementa la evaluación oral ni con LLM del `ROADMAP.md` de Daftar (REQ-001/002). Un evaluador con inferencia sería un **Agentlet**, y ese es otro diseño.
- No mueve la instancia A.R.B.O.L.: adopta H1 en su siguiente promoción, por su operador, con su control de cambio.

## 7 · Riesgos, y el experimento que pone a cada uno en riesgo

| Riesgo | Cómo se mide antes de creerlo resuelto |
|---|---|
| Memoria en la caja con dos anillos + Keycloak + nginx | H5 mide `free -m` con dos anillos calientes y una promoción en curso; umbral de abandono: <300 MB disponibles → se pasa a la alternativa de B5 |
| Paridad del frontend (2.163 líneas de JS que asumen `?s=` y rutas `/api/*`) | Lista cerrada de 15 conductas (H4); una guía de cada hijo; el modo foco probado con la sonda real de ultraGO |
| El renombre `pis → lets` deja ciego al poller de alguna instancia | El banco de anillos corre el control negativo con el predicado nuevo; el CHANGELOG lo declara «rompe»; A.R.B.O.L. lo adopta con su herramienta actualizada en el mismo acto |
| Un intento a medias durante una promoción | H3 lo mide: un POST de progreso en la ventana de relevo debe recibir 409 con el activo nombrado o completarse; jamás perderse en silencio |
| Discriminador de spec ambiguo (un YAML con ambas claves) | H0 rechaza specs con más de un discriminador y lo registra en el log; test unitario |
| La conjetura de que Keycloak ya tiene a los tres hijos como usuarios | **No verificado hoy** (no se leyó el realm). H5 lo verifica antes de tocar nginx; si faltan, se crean en Keycloak, que es acto de César sobre su IdP |

## 8 · Lo que se pide a César

| # | Decisión | Recomendación de este diseño |
|---|---|---|
| B1 | Proto-Botlet dentro del nodo, no proceso externo | **Sí** |
| B2 | `packages/daftar` público en Vergis, instrumentos privados en la instancia | **Sí**; nombre propio «Daftar» al catálogo |
| B3 | Un Let `evaluador` por instancia; guías = instrumentos inmutables | **Sí**, por las tres pruebas |
| B4 | Estudiante = login (Keycloak ya está); César admin | **Sí** |
| B5 | Misma caja, nginx sigue de borde, Caddy solo como conmutador | **Sí**, medir memoria; VM propia solo si la medición lo exige |
| B6 | `pis → lets` ahora, con «rompe» en el CHANGELOG | **Sí** |
| B7 | `botler-ops` genérica; `mira-ops` queda como instancia | **Sí** |
| B8 | Familia de manifestación del evaluador; fila de Daftar en Cap 9 | **Decisión del canon**: se propone «información», se espera su palabra |
| — | `--apply` del escalón `deploy-cloud.sh` para la semana de Matías | Sigue pendiente de su sí |

Refrendadas las que correspondan, el siguiente entregable de Fable son los **briefs de H0, H1 y H2**, ejecutables en frío.

---

*Doc 013 · Diseño rector · v1.0 · 5 de septiembre de 2026 · borrador para refrendo*

• *Generado con Wingworking*
