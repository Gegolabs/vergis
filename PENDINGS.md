# PENDINGS — detectados por el agente

Pendientes que **detectó el agente**, no encargó el humano. TTL 15 días desde `reg`: al vencer
pasan a `PENDINGS-done.md` §vencidas. Lo que César declare o confirme como pendiente vive en `TODO.md` (sin TTL);
la promoción PENDINGS→TODO se pide, no se toma.

## Operación / despliegue

- **El delta sin desplegar creció** — `main` (`cf375a4`) lleva, además de lo del 07 (`/contrato` #141,
  paralelización fabric #140, fixes NUL/lockfile), los 4 PRs de la tanda 005 del 08: **guard de
  pertenencia de Miranda (#142 — fix de seguridad)**, delta N2 del contrato (#143), H0 de canales
  (#144) y preview RLS con roster (#145). La instancia A.R.B.O.L. corre 0.14.0. Producción es gated
  (Norma 5): requiere autorización de César; runbook = skill `mira-ops`. Dos verificaciones quedan
  esperando ese deploy: el smoke del journal N2 (siembra en el 1º, delta en el 2º — D6) y la preview
  impersonada contra motor vivo (conjetura declarada del PR #145). `reg 2026-08-07 · act 2026-08-08`
- **`CHANGELOG.md` sin cortar** — termina en 0.14.0; lo mergeado hoy no tiene entrada ni tag. El
  corte de versión es decisión de César (precedente: D-05 del 2026-08-06). `reg 2026-08-07`
- **`VERGIS_CSRF_SECRET` no definido en PROD ni en QA** — el server genera uno aleatorio al arrancar
  y lo avisa: los formularios de gestión abiertos no sobreviven un restart ni se comparten entre
  réplicas. Fijarlo en `vergis.env` de cada VM. `reg 2026-08-06`
- **QA: 403 del service principal al observar 2 items del motor** (`ingest_finanzas_saldos`,
  `ingest_personas_asistencia`) — el lazo de frescura degrada como fue diseñado (registra y sigue),
  pero el entorno QA queda sin observabilidad real de esos procesos. Permisos del SP en el
  workspace de QA. No es regresión de 0.14.0. `reg 2026-08-06`

## Espera decisión de César

- **Cluster 004: 11 diseños del backlog completo esperan sus decisiones** — cada doc de
  `work/004-cluster-disenos-backlog-2026-08-07/` marca las suyas `[propuesta — revocable por César]`.
  Las mayores: 03/#138·2 (D1 re-siembra idempotente · D2 NO crear VERGIS_TUNABLES, la vía es
  `platform_setting` · D3 fase 1 basta — **supersede las 3 preguntas del boceto 003·C**), 11/open-core
  (D1–D6: corte, Miranda abierta, AGPL+CLA-ligero ANTES del primer PR externo, marca), 04/#107·F2
  (correr la sonda del hito cero: escribe en el tenant), 08/canales (migración VERGIS_NOTIFY→CHANNELS),
  10/hardening (D8 supply-chain operacional). `reg 2026-08-07`

## Código / CI

- **`actions/checkout@v4` y `actions/setup-node@v4` avisan deprecación de Node 20** en cada corrida
  del workflow `build`. Subir a v5 cuando toque. `reg 2026-08-06`
- **Header del theme `default`: el título quedó como marca enlazada** (desviación declarada de #136 —
  ese theme no tiene logo). Es un elemento visible nuevo, no solo un wrapper; merece ojo humano.
  La instancia A.R.B.O.L. usa el theme `arbol`, así que no la afecta. `reg 2026-08-06`
- **Gramática de nombre de archivo duplicada** entre `vtCsvName` (#61) y `pdfFilename` (#65) —
  misma convención `slug--fecha[--filtrado]` implementada dos veces. Unificar. `reg 2026-08-06`
- **`import type { TableColumn }` sin uso** en `render-csv-piece.ts` (preexistente a #61, no
  introducido por él). `reg 2026-08-06`
- **Gate token comparado con `!==`, no constant-time** (`server/routes.ts:77`; el CSRF sí usa
  `constantTimeEqual`). Fix de una línea = D6 del diseño 004/10. `reg 2026-08-07`
- **`Dockerfile` omite el manifiesto de `packages/miranda`** en sus dos stages (funciona porque el
  bundle no resuelve en runtime; asimetría a corregir o documentar — diseño 004/11 §1.4). `reg 2026-08-07`

## Práctica / entorno (fuera del árbol de Vergis)

- **`~/evals-finaliza/` no está bajo control de versiones** — ahí viven la clave, los 3 reportes
  del A/B, los 2 veredictos y el reporte de bug de esta sesión. Perderlos borraría la evidencia del
  experimento. Decidir: `git init` local (sin remoto basta) o declarar en el arnés que es scratch
  desechable. `reg 2026-08-07`
- **`~/.claude/settings.json` modificado sin atribución** — aparece `M` en el repo `dotclaude` y
  **no hay evidencia en esta sesión de haberlo tocado** (podría ser de otra sesión o del propio
  `/model`, que persiste el default). No se commiteó por eso (Norma 6). Revisar el diff a mano y
  sellarlo o revertirlo. `reg 2026-08-07`
- **`VERGIS_VERSION` no está re-exportado por el índice de `@vergis/capabilities`** — `server/contract.ts`
  lo importa por ruta relativa a `packages/capabilities/src/version` (funciona y evita arrastrar
  vega/mssql a los tests unitarios, pero cruza la frontera del package). Decidir: re-export en el
  índice o bendecir el import directo a módulos-hoja. `reg 2026-08-07`
