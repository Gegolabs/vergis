# Cluster 013 — el Botler genérico y Daftar como segundo proto-Botlet

| Doc | Título | Tipo | Estado |
|---|---|---|---|
| 01 | Diseño rector — el Botler como runtime genérico y Daftar como segundo proto-Botlet (v1.0) | Diseño (Fable) | Refrendado íntegro por César el 2026-09-05 |
| 02 | Brief H0 — registro de proto-Botlets en el nodo (v1.0) | Brief ejecutable | Issue #289 · **mergeado** (PR #292, `bdb147b`, 2026-09-05) |
| 03 | Brief H1 — `pis` → `lets` y `botler-rollout` (v1.0) | Brief ejecutable | Issue #290 · **mergeado** (PR #294, `042ecd2`, 2026-09-05; `serving_ok()` exige el bloque `lets`, medido con la fixture vieja: 8/23 en rojo) |
| 04 | Brief H2 — store `evaluaciones` e importador de Daftar (v1.0) | Brief ejecutable | Issue #291 · **mergeado** (PR #293, 2026-09-05; rebaseado sobre H0 por el orquestador, CHANGELOG fusionado) |

| 05 | Brief H3 — `packages/daftar`, el evaluador como Let; `invoke` en el Botler (v1.0) | Brief ejecutable | Issue #295 · **mergeado** (PR #296, `eafa39c`, 2026-09-05; e2e un nodo + standby, paridad 11/15 medida + 4 sin navegador) |
| 06 | Plan de escala a millones — el Botler descartable: stores a Postgres, lease fuera del disco, N réplicas, anillos = rolling update; H1 = prueba de carga a un nodo con arnés propio (v1.0) | Diseño (Fable) | **Para refrendo** (D1–D3 de su §10); solo H1 es ejecutable sin refrendo |
| — | H4 contenido + H5 instancia «estudios» (soveria-host) | Ejecutados por el orquestador, sin brief (fuente: `estudios/daftar/instancia/`) | **Hechos** 2026-09-05: `/estudios` sirve el anillo 0.27.0 en paralelo al Python; flip pendiente de la paridad de César (DECISIONS de estudios D-03…D-06) |
| — | H6 `botler-ops` | Skill en protocolos (`ce00b19`); `mira-ops` 1.2 la importa | **Hecho** 2026-09-05 |
| — | H7 canon (B8) | Decisión de César | Pendiente |
Decisiones tomadas en nombre de César durante la ejecución: `DECISIONS.md` D-67 a D-75.

• *Generado con Wingworking*
