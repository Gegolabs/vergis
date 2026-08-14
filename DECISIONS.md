# DECISIONS — decisiones tomadas en nombre de César (modo autónomo)

Registro exigido por la skill `procesamiento-autonomo`. Toda entrada es **revocable**:
el registro existe para que revertirla sea barato.

| Campo | Contenido |
|---|---|
| Sesión | 2026-08-06 · atención de los requests abiertos (work/002) · 2026-08-07 · solicitudes #138/#139 (work/003) · 2026-08-08 · ejecución de atendibles (work/005) · 2026-08-08 · fase 2 de #107 (work/006) · 2026-08-10 · trabajo del pasivo (`/ww:work run`) |

---

## D-22 · 2026-08-13 — Los specs del canon NO se migran: se citan

- **Bifurcación**: `TODO.md` y el README declaraban pendiente «migrar los specs normativos del canon (contrato Botler, spec Mira, DSL, naming) de AgencyDomains a `docs/`». ¿Se migran, o la premisa cambió?
- **La premisa re-derivada contra el terreno**: **no existen archivos-spec sueltos que mover**. Lo normativo vive dentro del **libro publicado** *AgencyDomains · Arquitectura del Mundo Agentivo* (v1.0, agosto 2026, agencydomains.org). Buscar «contrato Botler» o «spec Mira» como documentos en ese repo no devuelve nada: la migración estaba enunciada sobre artefactos que no existen con esa forma.
- **Decidido**: **no se migran; se citan.** Dos razones, y la primera es un hecho verificable, no una preferencia:
  1. **Las licencias no mezclan.** El libro es **GNU FDL v1.3**; este repo es **AGPL-3.0-or-later**, y la FDL no es compatible con la GPL. Copiar el texto normativo acá volvería una parte del árbol no redistribuible bajo su propia licencia — un defecto que solo aparecería el día que alguien redistribuyera.
  2. **Un spec con dos casas driftea**, y la copia siempre pierde porque es la que nadie relee. Este proyecto ya pagó esa factura: la línea del port a Go en `TODO.md` era un duplicado de una decisión del ADR-001 y envejeció peor que su fuente.
- **Hecho en su lugar**: `docs/canon.md` — dónde vive el canon, qué edición se cita, por qué no se copia, qué queda en `docs/` (lo verdadero de ESTA implementación), y la regla ante desacuerdo: el canon manda sobre *qué es* un Botler/Mira/DSL, el repo manda sobre *qué hace* esta implementación. Más el camino si algún día hace falta un fragmento in-tree: relicenciamiento explícito del autor (César tiene el copyright de ambas obras) registrado en un ADR — un acto, no un copy-paste.
- **Costo de revertir**: nulo — migrar sigue siendo posible el día que exista el acto de licencia; lo que se retiró fue una promesa que el README hacía sin poder cumplir.

## D-21 · 2026-08-13 — El aislamiento del render Vega: se cierra la E/S, NO se construye el subproceso

- **Bifurcación**: el roadmap pide «aislamiento del render Vega en **subproceso sin red ni filesystem**». ¿Se construye el subproceso, o se ataca el vector por otra vía?
- **La medición que decidió** (2026-08-13, en esta máquina, Node v22.22.3 — el mismo mayor que corre en la imagen, `node:22-slim`): el **permission model de Node 22 NO cubre la red**. Con `--experimental-permission --allow-fs-read=<dir>`: lectura fuera de la lista `ERR_ACCESS_DENIED` ✓, `child_process` `ERR_ACCESS_DENIED` ✓, y **`net.connect` a un host externo CONECTÓ**. O sea el subproceso entregaría *la mitad* del enunciado, y a cambio mete un pool de procesos en el camino caliente del render.
- **Corrección de instrumento, que casi produce el hallazgo contrario**: las primeras corridas fallaban al arrancar incluso con `node -e`, y parecía que el permission model rompía todo. Era el `NODE_OPTIONS` de esta terminal inyectando un `--require`. Con `env -u NODE_OPTIONS` el modelo funciona. **El instrumento medía el entorno, no el fenómeno.**
- **Decidido**: cerrar el vector **donde está**, en dos capas dentro del proceso, y no construir el subproceso. El vector real es que Vega sabe cargar datos sola (`data.url`, por red o `file://`) y los specs de Vergis traen los datos ya resueltos: ese camino no debe usarse nunca. (1) **Gate declarativo** — un spec con `url` se rechaza antes de llegar a Vega, ruidosamente. (2) **Loader que niega** toda E/S, como red de seguridad.
- **Por qué DOS capas y no solo el loader — medido, no supuesto**: con un servidor HTTP local contando hits, el loader por defecto **hace el fetch** (`hits=1`); el loader que niega lo evita (`hits=0`) **pero Vega se traga el error y rinde un gráfico vacío**, sin excepción. Protección silenciosa = PI degradado en silencio, que esta plataforma trata como defecto en todas las demás capas.
- **Lo que queda sin cubrir, dicho**: un exploit de Vega que haga E/S **sin pasar por su loader** (p. ej. por una dependencia transitiva) no lo detiene ninguna de las dos capas. Esa es la parte que un subproceso sí cubriría, y el día que exista un driver, la fs se cierra con el permission model y **la red hay que cerrarla en la red del contenedor**, no en Node. Queda escrito en el roadmap.
- **Costo de revertir**: bajo — dos piezas locales en `render-chart.ts`; quitarlas restaura el comportamiento anterior. El subproceso sigue disponible como camino, ahora con su medición hecha.

## D-20 · 2026-08-13 — El diagnóstico de #165 NO esconde el PI: lo explica

- **Bifurcación**: `canAccess` deja ver un PI si el sujeto trae **algún** valor del claim. Con `op: eq` y un claim de dos valores, la política niega **todas** las filas: el PI aparece en el índice y se abre vacío. ¿Se corrige la visibilidad (esconderlo, que es la dirección fail-closed) o se deja como está y se agrega el diagnóstico?
- **Decidido**: **la visibilidad no se toca; se agrega la explicación**. Esconderlo cambia una falla muda por otra —el sujeto pasa de «lo abro y está vacío» a «ya no está», igual de indistinguible de «no tengo permiso»— y encima destruye la única pista que tenía el operador. El issue pide explícitamente que el fail-closed no se toque; lo que faltaba no era ocultar mejor sino **poder decir cuál de las tres cosas pasó**.
- **Dónde vive, y por qué importa**: en `packages/policy/src/diagnose.ts`, junto al evaluador de referencia, **no** en el server. La explicación de una negación es semántica del IR: en el canal de serving cada back-end tendría su propia versión de «por qué no ves nada» y divergirían en la primera corrección. Además es función de `(policy, claims)` sin tocar filas — así vale igual en push-down, donde las filas no pasan por este proceso.
- **Lo que lo hace afirmable**: `deniesAllRows` se prueba como **teorema** contra el oráculo (2000 casos: si dice que niega todo, `applyPolicy` devuelve `[]`), con un **control de que las dos ramas se ejercitaron** (≥100 de cada lado) — sin él, una función que devolviera siempre `false` habría «pasado» el teorema sin ser puesta en riesgo jamás.
- **Costo de revertir**: bajo y aislado — el módulo es aditivo y nadie depende de él para decidir; quitar la llamada en `indexReports` apaga la línea del log sin tocar enforcement.

## D-19 · 2026-08-10 — La marca queda sin tocar (gasto), y se dice qué falta

> **SUPERADA 2026-08-13 por decisión de César: no se registra nada.** Esta entrada dejó la marca
> en su mesa; él la bajó de la mesa. La decisión de fondo queda cerrada en `TODO.md`; esto se
> conserva porque registra *por qué* el agente no la tomó — el límite del mandato, que sigue vigente.

- **Bifurcación**: la marca «Vergis» (y «Custos»/«Miranda») sigue diferida por César desde el 2026-08-08, con estado registral sin verificar. Con mandato amplio: ¿levantar el memo de disponibilidad, iniciar algo, o dejarlo?
- **Decidido**: **no se ejecuta nada**, y no por criterio sino por autoridad — registrar una marca **gasta plata** y compromete a Gegolabs frente a un registro público. Es de la familia que el mandato explícitamente no cubre. Tampoco se levanta el memo de disponibilidad: su valor entero está en consultar INAPI (y equivalentes) con datos reales, y una búsqueda no autoritativa presentada como memo sería justo el tipo de artefacto que la Norma 6 prohíbe — una conjetura con cara de dato que decide por quien la lea.
- **Lo que sí queda dicho**: el riesgo es asimétrico y no cambió. El registro temprano es barato; la ausencia es **irreversible** si otro registra primero. Sigue en `TODO.md` como decisión suya.
- **Costo de revertir**: nulo — no se hizo nada.

## D-18 · 2026-08-10 — El borrador de `CONTRIBUTING.md` se redacta, pero se deja INACTIVO

- **Bifurcación**: el diseño `004/11` §D5 (aprobada) manda redactar `CONTRIBUTING.md` con DCO + cláusula de relicencia marcada como sujeta a revisión legal; `TODO.md` prohíbe publicarlo sin revisión de César o de un abogado. ¿Se escribe como `CONTRIBUTING.md` confiando en el marcador HTML, o de otro modo?
- **Decidido**: se escribe como **`CONTRIBUTING.draft.md`**. Un comentario HTML no detiene nada: GitHub muestra `CONTRIBUTING.md` a todo el que abre un issue o un PR, y en ese instante la cláusula empieza a **obligar a terceros** — que es exactamente lo que la revisión pendiente debe autorizar. Con el nombre en `.draft.md` el trabajo queda hecho y el acto de publicar se reduce a un `git mv`, que es de César.
- **Contenido**: DCO 1.1 por `Signed-off-by`, cláusula de licencia de contribución con **su porqué dicho de frente** (por qué un DCO a secas no basta para el dual licensing, y que no se pide cesión de copyright), gates del CI, presupuesto de dependencias cero en `botler`/`policy`, y canal privado de seguridad. Dos huecos marcados en el texto: la redacción legal exacta y la dirección de contacto (sin confirmar).
- **Costo de revertir**: nulo — borrar un archivo que no está activo.

## D-17 · 2026-08-10 — #111 (rúbrica de convenciones) NO se cabla: espera su disparador

- **Bifurcación**: el H1 (sembrar el catálogo en `rubric/`) ya está mergeado (#147). ¿Se cabla el H2 —montar `convenciones.md` en el prompt de Miranda— ahora que hay mandato, o se respeta el disparador «≥2 casos aplicados» que el propio diseño declaró?
- **Decidido**: **se respeta el disparador**. Cablear ahora sería construir contra un catálogo de 4 convenciones sin uso medido — exactamente el «folclore» que el diseño combatió al volver el disparador medible (`grep -c` sobre las líneas `- caso …` del ledger). El mandato delega el juicio operativo; no convierte en atendible lo que está diferido por su propia condición.
- **Costo de revertir**: nulo — cablear sigue siendo el camino previsto el día que el ledger llegue a 2 casos.

## D-16 · 2026-08-10 — #138 se cierra con mandato de César

- **Bifurcación**: las tres piezas de #138 están atendidas (la 1 subsumida por #139·N1, la 3 medida y corregida en #140, la 2 implementada en #151). El issue quedaba «pagado, esperando finiquito». ¿Cerrarlo o dejarlo a César?
- **Decidido**: **cerrarlo**, con mandato explícito de César en esta sesión. La regla dura «el issue jamás se cierra solo» protege al **tercero** que lo abrió; acá el autor es el principal y él delegó la firma. Se cierra con comentario que deja el rastro de por qué cada pieza está saldada y qué queda diferido con disparador (fases 2-3 de config recargable).
- **Costo de revertir**: nulo — reabrir un issue es un clic.

## D-15 · 2026-08-10 — Se corta 0.15.0 (CHANGELOG + version + tag)

- **Bifurcación**: 21 PRs (#140-#160) sin entrada ni tag desde el deploy 0.14.0. El corte de versión venía marcado como decisión de César (precedente D-05). Con mandato: ¿0.15.0, o 1.0.0 dado el peso del tren?
- **Decidido**: **0.15.0**. La convención declarada en el propio CHANGELOG es explícita — «Y sube con cada conjunto de capacidades nuevas del DSL/runtime; **X se reserva para el primer release estable**». Nada en este tren declara estabilidad de contrato; el fix de #142 apunta en contra (la superficie de Miranda todavía estaba encontrando huecos de autorización).
- **Costo de revertir**: bajo — el tag se re-corta; nada desplegado hasta el paso siguiente.

## D-14 · 2026-08-10 — La baja del port a Go de `TODO.md` (y el delta que la funda)

- **Bifurcación**: César pidió detalle para evaluar si dar de baja el port del kernel a Go. ¿Se descarta el port, se deja el pendiente, o se hace otra cosa?
- **Decidido** (mandato explícito de César, «baja el port a Go»): **no se descarta el port — se retira el duplicado**. La decisión ya vivía en ADR-001 §Decisión·2; la línea de `TODO.md` la repetía con menos matiz y **había quedado falsa**: ADR-002 catalogó `packages/policy` como pieza abierta prioridad 1, con lo que «Custos como producto standalone» dejó de ser driver de ingreso. El ADR gana un delta con el reencuadre, los disparadores vivos (embedding, librería/WASM — ninguno con demanda) y la contra-consideración del Motor L (#113·09), etiquetada como leída-no-medida.
- **Colateral**: la cifra «2.100 iteraciones de property testing» del ADR-001 **no se reproduce** — lo medido es 800+800 = 1.600 (2.400 aserciones). Corregida con nota visible. La conclusión del ADR no se cae; la cifra era carga y estaba mal.
- **Informe**: `work/007-informe-port-go-2026-08-10/01-informe-baja-port-go-v1.0.md` (+ PDF en `export/`).
- **Costo de revertir**: nulo — reponer una línea en `TODO.md`. El port sigue disponible con sus disparadores sellados.

## D-13 · 2026-08-10 — Se bendice el import directo a módulos-hoja de `@vergis/capabilities`

- **Bifurcación**: pendiente abierto desde el 07 (`VERGIS_VERSION` importado por ruta relativa en `server/contract.ts`): ¿re-exportar en el índice del package, o bendecir el import directo a módulos-hoja?
- **Decidido**: **bendecir el import directo**, con dos requisitos — el módulo-hoja no tiene imports propios, y el import lleva su porqué escrito al lado. Lo que inclinó la balanza: este mismo lote produjo un segundo caso con la razón idéntica (`server/pdf.ts` → `table-runtime`), y la razón es dura, no de gusto: entrar por el índice arrastra vega/mssql a tests de módulos que son puros por contrato. Dos casos con la misma causa dejan de ser excepción.
- **Costo de revertir**: bajo — añadir los re-exports al índice y cambiar 2 líneas de import.

## D-12 · 2026-08-10 — Versiones de GitHub Actions elegidas aplicando el cooldown del propio proyecto

- **Bifurcación**: el pendiente decía «subir `checkout`/`setup-node` a v5». Al medir, la vigente es **v7** y hay una v46.2.2 recién salida del action de Renovate. ¿Se sigue la letra del pendiente, se toma lo último, o se aplica el criterio del proyecto?
- **Decidido**: **aplicar el `minimumReleaseAge` de 14 días del propio `renovate.json`** como criterio de selección. `checkout@v7` (publicada 07-20) y `setup-node@v7` (07-14) lo cumplen; para el action de Renovate se eligió **v46.1.21** (07-27) descartando v46.2.2/v46.2.1/v46.2.0 por tener 1/8/13 días. El arnés que hace cumplir el cooldown no se salta el cooldown.
- **No tocadas a mano**: las `docker/*` del build — las propondrá Renovate con su changelog, que es exactamente para lo que se encendió.
- **Costo de revertir**: bajo — son líneas de `uses:`; el CI valida el cambio en el mismo push.

## D-11 · 2026-08-10 — Renovate corre SELF-HOSTED en el CI, no como GitHub App

- **Bifurcación**: `renovate.json` existe desde el 2026-06-11 pero es **inerte** sin la App instalada, e instalarla exige consentimiento OAuth del owner de la org (acción humana no automatizable). Opciones: (a) Renovate self-hosted por GitHub Actions, (b) migrar a Dependabot nativo, (c) seguir esperando la instalación, (d) nada.
- **Decidido** (César eligió A al presentarle las cuatro): **(a) self-hosted** — `.github/workflows/renovate.yml`, semanal + `workflow_dispatch`. Conserva el `renovate.json` **tal cual**, sin traducir nada: el cooldown de 14 días, `osvVulnerabilityAlerts` y el pinning por digest siguen siendo los ya razonados. Dependabot habría exigido reescribir la config y su pinning de Actions es más limitado.
- **Sub-decisión — fail-closed**: sin el secret `RENOVATE_TOKEN` el workflow **falla en rojo** en vez de saltarse el trabajo. Misma doctrina que #117: un control que no corre tiene que distinguirse de un control que corrió y no encontró nada. Un scheduled run rojo ES la señal de que el cooldown no está activo.
- **También**: `RENOVATE_REQUIRE_CONFIG=required` — sin config en el repo, aborta; los defaults de Renovate **no** traen el cooldown, que es su razón de ser acá.
- **Hand-off**: crear el PAT y guardarlo como secret. Es lo único que queda, y es de César.
- **Costo de revertir**: nulo — borrar un archivo de workflow.

## D-10 · 2026-08-08 — Deltas de arquitectura del plan 006 sobre el diseño de la fase 2 de #107

- **Bifurcación**: el hallazgo del hito cero (el motor normaliza el payload: `""→null`, re-serialización) obliga a canonicalizar antes de comparar (refinamiento de D7, sellado en #107). ¿Dónde vive la canonicalización y cómo se reparte sin romper el paralelismo de la Ola 1 (H1∥H2∥H3)?
- **Decidido** (Δ1-Δ5 del plan `work/006-cluster-107-f2-publicacion/00-plan-v1.0.md`): (Δ1) módulo `definition-canonical.ts` en territorio H2; el sha del render, del ledger y del read-back es UNO, el canónico; lo no medido (payloads no-JSON) NO se normaliza — queda byte-a-byte con conjetura etiquetada. (Δ2) `derivePublishPlan` puro sobre shas — quien canonicaliza es el flujo admin (H4); evita dependencias H3→H1/H2 dentro de la ola. (Δ3) tipos por tipado estructural, sin imports cruzados en la Ola 1. (Δ4) `index.ts` único cruce declarado; lo resuelve el orquestador. (Δ5) `VERGIS_JOB_TEMPLATES` nace solo-arranque, FUERA de `RELOADABLE_SLICES` — la recargabilidad es de las fases 2-3 de #138·2, que esperan a César.
- **Costo de revertir**: bajo — Δ1/Δ2/Δ3 son cortes de módulo (mover una función es un refactor local); Δ5 es agregar una entrada a la tabla de slices cuando César apruebe las fases siguientes.

## D-09 · 2026-08-08 — Correr la sonda del hito cero de #107 contra el tenant real (plantación)

- **Bifurcación**: el hito cero de #107 F2 exige un experimento que ESCRIBE en el tenant (crea y borra un item). ¿Correrlo contra workspace real o sandbox, y con qué credencial?
- **Decidido** (César, go operativo en sesión): workspace **real** de plantación (`1d331022…`, D12), credencial del SP del intake (D9 default), corrida DENTRO del contenedor de la VM para no extraer el secreto a local (Norma 5). Ejecutada dos veces (reproducible), cero residuo.
- **Resultado**: **el SP puede autorar** (crear 201, agendar 201, borrar 200; controles A/A2 verdes). El exit 6 fue normalización del motor (`""→null` + pretty-print), no falta de persistencia — caracterizado. Refinamiento revelado para D7 (comparar canonicalizado, no por bytes). Sellado en #107.
- **Costo de revertir**: nulo — fue una medición idempotente (crea+borra); no dejó estado en el tenant.

## D-08 · 2026-08-08 — Semántica del guard de pertenencia de Miranda (frente F1 del cluster 005)

- **Bifurcación**: al diseñar el fix de las 5 rutas sin check de dueño: (a) ¿403 honesto o 404 que oculta la existencia?; (b) ¿qué pasa con sesiones legadas sin `created_by`?; (c) ¿el gate de publish va en el handler o dentro de `publishSpec`?
- **Decidido**: (a) **403** — los ids son UUIDv4, la enumeración es impracticable y el error honesto es el patrón del producto; (b) **solo-admin (fail-closed)** — una sesión sin dueño demostrable no se abre al scope, la rescata un admin; (c) **en el handler** — la identidad vive en la frontera HTTP y `publishSpec` conserva su contrato puro de gates de estado. Además se sella intocable el invariante de 004/02: la autorización de tools sigue atada al requester, no al dueño. Diseño completo: `work/005-…/01-diseno-pertenencia-sesiones-miranda-v1.0.md`.
- **Costo de revertir**: bajo — (a) cambiar el código de respuesta es una línea; (b) relajar el caso NULL es quitar una condición; (c) mover el gate al paquete es aditivo.

## D-07 · 2026-08-07 — `/contrato` solo para admins, y la pieza 2 de #138 no se implementa sin revisión

- **Bifurcación**: (a) ¿quién puede leer el contrato operativo de #139 — cualquier identidad autenticada tras el proxy, o solo admins?; (b) ¿se implementa de una vez la pieza 2 de #138 (env → archivo recargable) o se somete el diseño primero?
- **Decidido**: (a) solo admins (gate de token + `isAdmin` del store de gobierno; sin governance → 403): el payload expone rutas del contenedor y nombres de env — superficie de operación, no de consumo. (b) La pieza 2 queda en diseño (`work/003-…/03-…`) esperando a César: cambia el contrato de despliegue de las instancias (qué viaja en env vs en archivo) y arrastra semánticas de re-siembra vs gestión in-app.
- **Costo de revertir**: (a) bajo — relajar el gate es quitar una condición; (b) nulo — implementar después es el camino previsto.

## D-01 · 2026-08-06 — Orden y paralelización del backlog en 4 olas por territorio

- **Bifurcación**: atender 15 issues — ¿secuencial puro, o paralelo por territorio?
- **Decidido**: 4 olas (A: #99/#61/#117/#66 · B: #101/#114/#62/#108 · C: #105/#63/#109/#65 · D: #100/#102/#107), paralelizando frentes de territorio disjunto e integrando secuencialmente con gates. Dependencias: #101←#99, #63←#62, #102←{#99,#101,#100}.
- **Racional**: minimiza colisiones de archivos entre frentes y respeta las dependencias declaradas en los propios issues; los de demanda dura de usuario (#61, #99) van primero.
- **Costo de revertir**: nulo — es orden de trabajo, no forma del producto.

## D-02 · 2026-08-06 — #106 (docs) queda al final, condicional al tren

- **Bifurcación**: ¿incluir #106 (documentación multi-reporte + gobierno) en el alcance «todo lo accionable»?
- **Decidido**: se atiende solo si las olas A–D cierran; los issues de código tienen demanda de usuario y el doc no bloquea a nadie hoy.
- **Costo de revertir**: nulo.

## D-06 · 2026-08-06 — Encender vm-vergis-qa para el ensayo del deploy 0.14.0

- **Bifurcación**: la VM de QA estaba deallocated; ¿ensayar (encenderla) o saltar el ensayo?
- **Decidido**: encenderla — el ensayo en QA antes de PROD es el camino documentado (BITACORA 2026-07-13) y César autorizó «avanzar con el deploy», que lo incluye. Se deja apagada (deallocated) al terminar, como estaba.
- **Costo de revertir**: `az vm deallocate` (minutos de cómputo del ensayo).

## D-05 · 2026-08-06 — Se corta el release 0.14.0 en el repo (CHANGELOG + version + tag), sin deploy

- **Bifurcación**: dejar los 15 merges sin versión, o cortar 0.14.0 repo-side siguiendo la convención del CHANGELOG (Y sube con cada conjunto de capacidades).
- **Decidido**: version bump + entrada de CHANGELOG + tag `v0.14.0`. El DEPLOY a la VM queda como hand-off (producción gated; además #117 exige verificar los YAML de instancia antes de subir).
- **Costo de revertir**: bajo — el tag se puede re-cortar; nada desplegado.

## D-04 · 2026-08-06 — notify.yaml sin clave raíz LANZA (override del contrato sellado de #100)

- **Bifurcación**: el diseño de #100 selló `parseNotifyConfig({}) ⇒ cero destinos en silencio`; #117 (mergeado después de ese diseño) estableció que la clave raíz ausente en un YAML declarado es archivo roto y tumba el arranque. El implementador reportó la tensión sin resolverla.
- **Decidido**: consistencia con #117 — `requireRootKey('destinations')`; el cero legítimo es `destinations: []`. Racional: un notify.yaml decapitado desactivaría en silencio el sistema que avisa fallos — exactamente la evaporación que #117 cierra, en el peor lugar posible.
- **Costo de revertir**: una línea + un test (commit del ajuste en PR #129).

## D-03 · 2026-08-06 — Emails de avance: cuenta claude → cesar.obach@ultrabase.net

- **Bifurcación**: César pidió informes por email al cierre de tickets/olas; ¿a qué dirección?
- **Decidido**: desde la cuenta claude (claude.amodei@gmail.com) hacia `cesar.obach@ultrabase.net`, per skill `ww:wingworking-email-sending` (tema ultraBASE/producto; «si hay duda, ultrabase.net»).
- **Costo de revertir**: nulo — se redirige el siguiente envío.
