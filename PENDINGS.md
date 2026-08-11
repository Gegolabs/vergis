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
- **`~/.claude/settings.json` modificado sin atribución** — aparece `M` en el repo `dotclaude` y
  **no hay evidencia en esta sesión de haberlo tocado** (podría ser de otra sesión o del propio
  `/model`, que persiste el default). No se commiteó por eso (Norma 6). Revisar el diff a mano y
  sellarlo o revertirlo. `reg 2026-08-07`
