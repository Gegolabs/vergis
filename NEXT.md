# NEXT — Vergis

## MANDATO VIGENTE (César, 2026-09-05 21:40): ejecución autónoma en orden — 1. Vergis · 2. canon · 3. parapreu

El paquete completo vive en el `NEXT.md` de **estudios** (`/Users/cesar/wworkspace/estudios/NEXT.md`); acá lo de Vergis:

- **1.1 · Promover A.R.B.O.L. a 0.27.0 — LUZ VERDE, ventana de 36 h hasta el 7-sep ~09:40.** Sombrero de operador (`mira-ops` + `botler-ops`, desde el repo del lab de A.R.B.O.L., sesión `az` en el tenant GH). 0.27.0 **rompe**: herramienta `botler-rollout`, healthcheck del compose (`b.lets`) y poller del lab **en el mismo acto, antes** de `install` + `promote`; CN-1 obligatorio; fila en `cortes-de-servicio.md`; `paridad-vm.sh` exit 0; `/contrato` con `protos: ["mira","daftar"]` y sin store `evaluaciones`. Rollback: `rollback` al 0.26.0 caliente.
- **1.2 · Plan de escala a millones** (diseño Fable, doc 06 del cluster 013, para refrendo). Tesis acordada: orquestación con réplicas, Botler descartable (stores a Postgres, lease fuera del disco), predicado de salud como readiness; primer hito una prueba de carga contra un nodo; el cuello externo no importa mientras no sea el Botler ni los Lets.
- **1.3 · Residuos:** `undefined/` (investigar y borrar con DECISIONS), PRs de Renovate en `pass`, y lo que es de César (CODE_OF_CONDUCT, correo de seguridad) no se toca.
- **Canon (2):** «Captura» refrendada como cuarta familia; Daftar es Captura; v1.2 directa. Detalle en el NEXT de estudios §2.

## Frente Botler genérico (2026-09-05): H0–H3 MERGEADOS y **0.27.0 PUBLICADA**; sigue H4/H5

**0.27.0** (tag `v0.27.0`, `7adfd3c`) trae los cuatro hitos: registro de proto-Botlets (#289), `pis → lets` + `botler-rollout` (#290, **rompe**), store `evaluaciones` (#291) y **Daftar como segundo proto-Botlet** con `invoke` genérico (#295). Suite 2715 tests. Briefs en `work/013-cluster-botler-generico/02-05`; decisiones D-67…D-75. **La instancia A.R.B.O.L. sigue en 0.26.0**: adoptar 0.27.0 exige herramienta + healthcheck + poller en el mismo acto («Qué exige esta versión» de #290) y es acto del operador (esta misma casa, con ventana).

**H4, H5 y H6 HECHOS el 5-sep (noche)** — la instancia «estudios» sirve `https://daftar.ultrago.io/estudios` con el anillo 0.27.0 en paralelo al Python; runbook en `estudios/daftar/instancia/README.md`; `botler-ops` en protocolos. Lo que queda es de César (emails de `matias`/`vicky` en Keycloak; paridad en navegador; B8 del canon) y el flip final (ver el NEXT de estudios). Lo que sigue abajo es el detalle que se planificó y sirve como referencia de lo construido:
- **H4** (repo estudios): las 60 guías → `instrumentos/guides/`, `static/preu` → `instrumentos/recursos/preu/`, reportes → `instrumentos/reports/`; el campo `student` **sigue en el JSON** en 0.27.0 (el Let filtra por él); moverlo al directorio de identidad es un cambio del Let (H4b) que puede esperar. Mapa de identidad: `matias.obach@gmail.com → student:[matias]`, César `student:[*]`; los correos de Sebas y Vicky hay que pedírselos a César. Lista de paridad 15/15 verificada **a mano por César** con una guía de cada hijo (doc 013 §5).
- **H5** (infra, soveria-host): compose derivado de `compose.reference` (solo caddy conmutador `:8079` + anillos + volúmenes), `ring.args` con `VERGIS_SPECS_DIR`/`VERGIS_INSTRUMENTOS_DIR`/`VERGIS_EVALUACIONES=1`/`VERGIS_IDENTITY_MAP`/`VERGIS_OUT`/`VERGIS_ADMIN_SEED`, sin motor de datos (medido en H3: arranca así); nginx deja de apuntar al 8090 y apunta al conmutador mandando `X-Forwarded-Email` (hoy manda `X-Auth-Request-Email`). **Verificar antes que Keycloak tenga a los tres hijos** (conjetura no medida del doc 013 §7). Memoria medida con dos anillos; umbral <300 MB → VM propia (POL-01: obligación recurrente, decisión de César). Importar los 55 progresos con `scripts/evaluaciones-importar.ts` al store de la instancia. **Nada se corta hasta el flip de nginx**, que es un `reload`; el escalón `deploy-cloud.sh` sigue vivo hasta entonces.
- Después: H6 (`botler-ops` en protocolos), H7 (canon v1.2, B8 es decisión de César).

**Pendiente de diseño (César, 2026-09-05, noche): el plan para dotar a Vergis de la capacidad de escalar a millones de usuarios, si hiciera falta.** Tesis acordada en conversación: la disponibilidad viene de la capa de orquestación (réplicas sobre Kubernetes o equivalente), no de un contenedor OSGi dentro del proceso; el Botler tiene que volverse descartable — stores a Postgres por la costura que ya existe, lease del plano de control fuera del disco, N nodos idénticos detrás de un balanceador con el predicado de salud como readiness. **No importa que el cuello quede en el motor de datos externo mientras no sea el Botler ni los Lets.** Primer hito medible: prueba de carga contra un nodo hoy, y luego la migración de stores. Va como documento del cluster 013 cuando César lo pida.

**Sin medir en 0.27.0, dicho en el CHANGELOG:** promoción de dos anillos con un intento de Daftar a medias (se mide en H5 con el banco y un mutador de progreso); modo foco; filas 3, 4 y 8 de paridad en navegador.

**Residuo del árbol:** `undefined/` sin trackear en la raíz (pi02-render, 3-sep) — nadie lo reclamó; no se tocó.

---

**0.26.0 es la versión publicada** (tag `v0.26.0`, 2026-09-03, commit `d8f9a80`), verificada contra el registry (2 plataformas): facetas con orden natural y acotadas (#285, #286) y «Aplicar cadencia» que vigila los slots manuales (#279), sobre 0.25.1 (#282) y 0.25.0 (#280). Anteriormente 0.24.0 (`fad4b4c`) trajo Trae los **filtros de número** en columnas numéricas (#277/#278, decisión de César tras el caso de PI-01) sobre 0.23.1 (segunda mitad de #266). **Issue abierto hoy: #279** — «Aplicar cadencia» programa corridas también en slots de carga manual.

**La instancia A.R.B.O.L. corre 0.26.0 desde el 2026-09-03 (23:10Z)**, promovida por anillos sin corte (segunda promoción; previo 0.25.1). Antes: 0.23.0 desde el 2026-09-02 (noche) — desplegada por el frente arbol
con corte medido de 7.314 ms, smoke 25/25 y paridad `compose` en 0. **Subir a 0.24.0 no exige nada** (ni env ni base) y es un solo recreate con ventana — pendiente de César. El gap de versiones que este
archivo arrastraba (0.18.0 → …) **ya no existe**, y el aviso al operador dejó de tener destinatario:
el operador era esta misma casa.

**Todos los issues de producto están cerrados** (#279, #285 y #286 cerrados el 2026-09-03 con 0.26.0). Quedan abiertos a propósito **#110, #111, #113**
(paraguas de roadmap: no son defectos, y cerrarlos borraría el mapa) y **#169** (dashboard de Renovate).

## Lo que espera, y de quién es

| Partida | ¿De quién? | Estado |
|---|---|---|
| **PRs de Renovate #261, #260, #251, #201, #175** | Nadie, todavía | `renovate/stability-days` sigue en `pending` para los cinco (cooldown de 14 días, ADR-001). #175 y #201 tienen más de 14 días y el status no se re-emitió: **conjetura no medida** — tildar `rebase-branch` en #169 debería refrescarlo. Se mergean cuando el check pase, con CI verde |
| ~~Renombrar `CONTRIBUTING.draft.md` → `CONTRIBUTING.md`~~ **Publicado el 2026-09-03 por refrendo de César** («Confirmo … el renombre»). Quedan `CODE_OF_CONDUCT.md` y la confirmación del correo de seguridad | **César** | El acto de publicación ya ocurrió; el correo `security@gegolabs.com` sigue sin confirmar |
| **#265 · medir contra un gateway real** | Instancia, cuando llegue Foundry (1-2 semanas desde 2026-09-02) | El cable existe (`MIRANDA_API_BASE_URL`); lo medido es que llega al transporte. El primer request real es la medición |
| **`VERGIS_MASTER_DATA` fuera del hot-reload** (hallazgo vecino de #262) | Esta casa | Sin issue propio. Cambiar `entidades.yaml` exige reiniciar el nodo (corte). Abrir issue cuando alguien lo necesite en caliente |
| **`Publisher.count()` contra un warehouse real** y la **réplica inexistente** en un destino nuevo | Instancia | La página de `empresas_relacionadas` en A.R.B.O.L. es el primer caso real: mirarla es la medición |
| **E4 de #238** — ¿la aptitud vale toda la vida de la conexión? | Esta casa | Sin medir; por la vía del `GRANT` es viable y cabe en una ventana propia |
| **`format: date` sin rama propia en `vtFormat`** aunque `catalogo-elementos.md` lo documenta como formateador | Esta casa | Discrepancia doc↔código destapada por #264; la fila del catálogo lo dice con precisión |

## Lo que cambió el 2026-09-02 (custodia por mandato)

César entregó la custodia de este repo por mandato explícito («asume el rol del mantenedor… cierra todos
los issues de producto y déjalos publicados»). Con eso, las bifurcaciones que estaban «de César» las
decidió esta casa y quedaron en `DECISIONS.md` **D-59…D-64**, revocables:

- **#250 → salida (A)**: aviso en la nav conservando el 200 (verificado con captura).
- **#232 → cerrado sin la propiedad completa**: el intent no entra en `acquire()` (frontera de confianza).
- **#186 → cerrado**: sus dos criterios abiertos estaban cumplidos u obsoletos.
- **#266 → fatal vs degradable explícito** en `config.ts`; #265 en el mismo PR.
- **#262 → las cuatro piezas**, con «no se pudo leer» como única respuesta honesta a un conteo ilegible.
- **#264 → `docs/capacidades.md`** con cotejo derivado del schema y sin gate de CI sobre el CHANGELOG.

**Cuatro realizadores Opus construyeron #262, #266/#265, #250 y #264 en paralelo**, cada uno con brief
propio, worktree propio y contraste medido; la custodia verificó composición, rebaseó los CHANGELOG
(todos chocaban en «Sin publicar») y mergeó en orden. El corte siguió «Antes de cortar» al pie:
`corte:cotejo` **atrapó una brecha real** (#259 sin citar), `fab:proof` corrió antes del tag
(2 min 31 s, US$0,015, `Paused` al cerrar).

**Gotcha del CI, para no redescubrirlo:** `build.yml` no dispara en PRs cuya base no es `main`, y
tampoco arrancó en dos PRs recién abiertos hasta que un `update-branch`/push los despertó.

## Orden de lectura para retomar

`CLAUDE.md` (§El aterrizaje · §La custodia) → este archivo → `DECISIONS.md` (D-59…D-64) →
`CHANGELOG.md` §0.23.0 «Qué exige esta versión» (los cuatro no-medidos, y cuáles corroboró ya la instancia).

<!-- /ww:go (paso 6, en disco) · 2026-09-02 · HEAD 58cf988+ · custodia por mandato -->
