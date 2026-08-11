# PENDINGS — detectados por el agente

Pendientes que **detectó el agente**, no encargó el humano. TTL 15 días desde `reg`: al vencer
pasan a `PENDINGS-done.md` §vencidas. Lo que César declare o confirme como pendiente vive en `TODO.md` (sin TTL);
la promoción PENDINGS→TODO se pide, no se toma.

## Operación / despliegue

- **El delta sin desplegar creció otra vez** — `main` va en `8ae8acf`: **82 commits / ~17 PRs desde
  el deploy 0.14.0 del 2026-08-06**. Además de lo del 07 (`/contrato` #141, paralelización fabric
  #140) y la tanda 005 del 08 (**guard de pertenencia de Miranda #142 — fix de seguridad**, delta
  N2 #143, H0 de canales #144, preview RLS con roster #145, ADR-002 #146, rúbrica #147,
  supply-chain D8 #148, Dockerfile-miranda #149, audit fix #150, **fase 1 de config recargable de
  #138·2 #151**), lleva la **fase 2 completa de #107** (#152-#158: autoría de items, plantillas de
  job, publicación, admin, wiring) y el lote mecánico del 10 (gate constant-time, gramática de
  nombre unificada, desambiguación del watcher, actions v7, Renovate self-hosted). La instancia
  A.R.B.O.L. corre 0.14.0. **Cuatro verificaciones esperan ese deploy** —son conjeturas declaradas,
  no hechos—: el smoke del journal N2 (siembra en el 1º deploy, delta en el 2º — D6), la preview
  impersonada contra motor vivo (#145), el eslabón `serve-rls → runSpec` con identidad del roster
  (#145), y la entrega HTTP real por sink recargado (la línea del fan-out, #151).
  `reg 2026-08-07 · act 2026-08-10`
- **PROD sigue en 0.14.0: el deploy de 0.15.0 quedó como hand-off** — QA está en **0.15.0**
  (ensayo 2026-08-10 21:10, 6/6 PIs en 200, `healthz ok:true phase:serving`). PROD **no** se subió:
  al llegar al repo de la instancia (`clientes/ratio/hijuelas/arbol/lab`) el árbol tenía 5 archivos
  modificados y 2 sin trackear **de otra sesión** —incluido `RESOURCES.md`, fuente de verdad del
  runbook— y su `git log` mostraba **dos cierres del mismo día sobre esa misma VM**, con `P-22`/
  `P-174a` vivas (la VM sirve un respaldo del mapa de identidad). Es la compuerta de `/ww:work run`:
  árbol ajeno sin sellar ⇒ se reporta antes de escribir encima. **Ocurrencia 8 de W-01, registrada.**
  Rollback listo si se retoma: digest previo `sha256:ba001f0e…` + `compose.yml.bak-1786409546`.
  `reg 2026-08-10`
- **`VERGIS_CSRF_SECRET` no definido en QA** — *actualizado 2026-08-10*: en **PROD ya está aplicado**
  (sesión de A.R.B.O.L. del 2026-08-10 tarde, KV `arbol-secrets/vergis-csrf-secret`, corte medido
  6.597 ms). En **QA sigue sin definir** — verificado hoy: `vergis.env` de QA no declara ninguno de
  `VERGIS_NOTIFY|PI_OWNERS|SOURCES|POLICIES` ni el CSRF. Consecuencia observable: `/contrato` reporta
  `watches: []` en QA, que **no es defecto** sino ausencia de archivos que vigilar.
  `reg 2026-08-06 · act 2026-08-10`
- **QA: 403 del service principal al observar 2 items del motor** (`ingest_finanzas_saldos`,
  `ingest_personas_asistencia`) — el lazo de frescura degrada como fue diseñado (registra y sigue),
  pero el entorno QA queda sin observabilidad real de esos procesos. Permisos del SP en el
  workspace de QA. No es regresión de 0.14.0. `reg 2026-08-06`

## Espera decisión de César

*(vacío — las decisiones del cluster 004 se resolvieron el 2026-08-08: 13 aprobadas, 1 diferida
a `TODO.md` (marca). Quedan diferidas POR DISEÑO con disparador propio, no esperando a César:
multi-tenancy (004/11 E5) y re-evaluación de licencia del kernel (004/11 E4).)*

## Código / CI

- **Header del theme `default`: el título quedó como marca enlazada** (desviación declarada de #136 —
  ese theme no tiene logo). Es un elemento visible nuevo, no solo un wrapper; merece ojo humano.
  La instancia A.R.B.O.L. usa el theme `arbol`, así que no la afecta. `reg 2026-08-06`
## Práctica / entorno (fuera del árbol de Vergis)

- **`~/evals-finaliza/` no está bajo control de versiones** — ahí viven la clave, los 3 reportes
  del A/B, los 2 veredictos y el reporte de bug de esta sesión. Perderlos borraría la evidencia del
  experimento. Decidir: `git init` local (sin remoto basta) o declarar en el arnés que es scratch
  desechable. `reg 2026-08-07`
- **`dotclaude` con cambios sin sellar de otras sesiones** — *revisado el 2026-08-10, y el diff es
  SANO*: `settings.json` gana un hook `Stop` que llama `hooks/sync-cmux-title.sh` (el script existe,
  ejecutable, del 08-08) y reubica la clave `model` sin cambiar su valor (el `/model` reescribe el
  archivo); `WATCH.md`+`WATCH-logs.md` traen la **ocurrencia 7 de W-01** completa (rebase ajeno en
  el worktree de Cibeles, hoy); `commands/label.md` borrado; `personas/alida-…` de la sesión nuncio.
  **NO se selló a propósito**: son cambios de sesiones que pueden seguir vivas, y commitear el
  estado parcial de otro actor es exactamente el fenómeno W-01 que el propio diff está registrando.
  Lo que queda es que cada sesión selle lo suyo. `reg 2026-08-07 · act 2026-08-10`
