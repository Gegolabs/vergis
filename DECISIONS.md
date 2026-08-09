# DECISIONS — decisiones tomadas en nombre de César (modo autónomo)

Registro exigido por la skill `procesamiento-autonomo`. Toda entrada es **revocable**:
el registro existe para que revertirla sea barato.

| Campo | Contenido |
|---|---|
| Sesión | 2026-08-06 · atención de los requests abiertos (work/002) · 2026-08-07 · solicitudes #138/#139 (work/003) · 2026-08-08 · ejecución de atendibles (work/005) · 2026-08-08 · fase 2 de #107 (work/006) |

---

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
