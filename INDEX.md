# INDEX — Vergis

Índice de documentos de trabajo del proyecto. Registro cronológico de acciones en `BITACORA.md`; pendientes en `TODO.md`.

| NNN | Nombre | Fecha | Cluster | Fuentes |
|-----|--------|-------|---------|---------|
| 001 | `work/001-cluster-analisis-codigo-2026-07/` — directorio (cluster) · análisis de código completo, 6 frentes + consolidado | 2026-07-07 | 001 | docs/mejoras-diagnostico.md |
| 002 | `work/002-cluster-requests-2026-08/` — directorio (cluster) · barrido del backlog: 17 diseños Fable + registro de la sesión autónoma (release 0.14.0 y su cola) | 2026-08-06 | 002 | issues #61–#136, PRs #118–#137 |
| 003 | `work/003-cluster-solicitudes-2026-08-07/` — directorio (cluster) · solicitudes de arquitectura: contrato operativo (#139 N1), medición del arranque en frío (#138·3), diseño env recargable (#138·2, en revisión) | 2026-08-07 | 003 | issues #138, #139 |
| 004 | `work/004-cluster-disenos-backlog-2026-08-07/` — directorio (cluster) · diseño detallado de TODO el backlog: 11 diseños Fable en paralelo (delta contrato, Miranda-contrato, config recargable, publicación jobs, rúbrica convenciones, Miranda post-F1, realtime, canales, sql-local, hardening, open-core) | 2026-08-07 | 004 | issues #107, #110, #111, #113, #138, #139 |
| 005 | `work/005-cluster-ejecucion-atendibles-2026-08-08/` — directorio (cluster) · ejecución de los atendibles: plan orquestador (4 frentes, 2 olas, Opus en worktrees) + diseño del guard de pertenencia de sesiones de Miranda (5 rutas, ampliación del hallazgo de PENDINGS) | 2026-08-08 | 005 | diseños 004/01·06·08, issues #110, #113, #139 |
| 006 | `work/006-cluster-107-f2-publicacion/` — directorio (cluster) · fase 2 de #107: plan orquestador de los hitos H1-H5 (capability de autoría, plantillas, ledger, flujo admin, wiring) en 3 olas, con los deltas del hito cero (D7 canonicaliza) | 2026-08-08 | 006 | diseño 004/04, issue #107, hito cero D-09 |
| 007 | `work/007-informe-port-go-2026-08-10/` — directorio · informe de la baja del port del kernel a Go: por qué se retira de `TODO.md` sin descartar el port, el delta que ADR-002 le cambió a ADR-001 por debajo, y la corrección de la cifra de property testing (2.100 → 1.600 medidas) | 2026-08-10 | 007 | `docs/adr-001-…`, `docs/adr-002-open-core.md`, `tests/policy.test.ts` |
| 008 | `work/008-diseno-observabilidad-intake/` — directorio · diseño de la observabilidad del intake: #161 (detección y aviso al operador) + #162 (el fallo llega al usuario con la causa) | 2026-08-13 | 008 | issues #161, #162 |
| 009 | `work/009-cierre-pendientes-intake/` — directorio · cierre de pendientes del frente intake: contrato `_logs/` exigible, `watch:` por slot, control positivo en land-only | 2026-08-13 | 009 | `PENDINGS.md` §intake |
| 010 | `work/010-cluster-authz-2026-08-13/` — directorio (cluster, con INDEX propio) · el frente de autorización: columna, ancla, sujeto y mapa | 2026-08-13 | 010 | issues #163, #164 |
| 011 | `work/011-235-default-del-dato/` — directorio · diseño del default que viene del dato (`defaultField`), con los seis puntos donde el issue no calzaba con el código y la semántica cerrada en S1–S7 | 2026-08-19 | 011 | issues #235, #246 |
| 012 | `work/012-facetas-naturales-y-cadencia-manual/` — directorio · plan de los realizadores A (#285 orden natural + #286 opciones acotadas en facetas de `table`) y B (#279 «Aplicar cadencia» vigila y no programa slots manuales); integración y corte 0.26.0 por la custodia | 2026-09-03 | 012 | issues #285, #286, #279 · PI-30, PI-1 de la instancia |
| 013 | `work/013-cluster-botler-generico/` — directorio (cluster) · diseño rector (Fable, para refrendo): el Botler como runtime genérico con registro de proto-Botlets, `pis → lets`, Daftar como segundo proto-Botlet en una instancia «estudios», `botler-ops` | 2026-09-05 | 013 | terreno medido: server/*, packages/botler, deploy/rollout, soveria-host; AgencyDomains v1.1 Cap 5 |

Próximo disponible: 014

---

> Nota: la documentación canónica de producto vive en `docs/` (ADRs y docs de ingeniería), fuera de este índice de trabajo.

• *Generado con [Wingworking](https://wingworking.org)*
